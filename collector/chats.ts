// The chat watcher: a background service on a machine whose config names
// people's Slack (`slack`) or Teams (`teams`) in machine.json. It stays
// connected, so a message reaches Projects within seconds. Slack arrives over
// Socket Mode, an outbound WebSocket; Teams is read from a signed-in Chrome
// profile over the DevTools protocol (collector/teams-chrome.ts). Tokens and
// profiles come from the machine through the service (collector/service.ts)
// and stay in memory. Each person's read goes to the Worker with this
// machine's collector token. What waits is kept in owner-only files beside
// the config, so a restart loses nothing; logs carry counts, never names or
// text.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { configSchema } from "./config";
import { siteHeaders } from "./upload";
import { startTeams } from "./teams-chrome";
import { chatItemSchema, type ChatItem, type ChatRead } from "../src/chat-model";
import {
  applyEdit,
  applyMessage,
  mentioned,
  plainText,
  prune,
  signedOut,
  slackApi,
  slackRead,
  SlackError,
  type Conversation,
  type Message,
  type SlackPerson,
} from "./slack";

// Every read is posted at least this often, so its age shows in Projects.
const TICK_MS = 120_000;
// Who is in which conversation is read again this often.
const MEMBERS_MS = 30 * 60_000;
const SETTLE_MS = 3_000;
type Person = SlackPerson & {
  token: string;
  teamId: string;
  conversations: Set<string>;
  membersAt: number;
  items: Map<string, ChatItem>;
  state: ChatRead["state"];
  problem?: string;
};
type Channel = {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_ext_shared?: boolean;
  user?: string;
  shared_team_ids?: string[];
  context_team_id?: string;
  unread_count_display?: number;
};
type Event = {
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  message?: { user?: string; text?: string; ts?: string; thread_ts?: string };
};
const savedSchema = z.object({
  people: z.record(z.string(), z.array(chatItemSchema)).default({}),
  names: z.record(z.string(), z.string()).default({}),
});
const tokensSchema = z.record(z.email(), z.string().regex(/^xoxp-[\w-]+$/));
const log = (event: string, fields: Record<string, string | number> = {}) =>
  console.log(JSON.stringify({ event, at: Date.now(), ...fields }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: chats.mjs machine.json");
  const config = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const site = await siteHeaders(config);
  // Teams runs its own browser-backed loop per person, beside Slack, with a
  // Chrome for each of their profiles (one per Teams organisation).
  const teamsPeople = new Map<string, { account: string; profileDirs: string[] }>();
  for (const t of config.teams) {
    const person = teamsPeople.get(t.account.toLowerCase()) ?? { account: t.account, profileDirs: [] };
    person.profileDirs.push(t.profileDir);
    teamsPeople.set(t.account.toLowerCase(), person);
  }
  const stopTeams = [...teamsPeople.values()].map((person) => startTeams({ ...person, site, stateDir: path.dirname(file) }));
  const stateFile = path.join(path.dirname(file), "chats-slack.json");
  const saved = savedSchema.safeParse(JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}")));
  const kept = saved.success ? saved.data : { people: {}, names: {} };
  const tokens = tokensSchema.safeParse(JSON.parse(process.env.SLACK_USER_TOKENS || "{}"));
  const token = (email: string) =>
    tokens.success ? (Object.entries(tokens.data).find(([key]) => key.toLowerCase() === email)?.[1] ?? "") : "";
  const people: Person[] = config.slack.map((address) => {
    const email = address.toLowerCase();
    return {
      email, token: token(email), userId: "", teamId: "", url: "",
      conversations: new Set(), membersAt: 0, state: "ok",
      items: new Map((kept.people[email] ?? []).map((item) => [item.id, item])),
    };
  });
  const names = new Map(Object.entries(kept.names));
  const channels = new Map<string, Channel>();
  const described = new Map<string, Conversation>();
  const teams = new Map<string, string>();
  const seen: string[] = [];
  // Whether Slack's events are reaching the watcher, and why not.
  let open = false,
    offline = "Not connected to Slack yet";

  async function nameOf(user: string, viewer: Person) {
    const known = names.get(user);
    if (known) return known;
    try {
      const { user: found } = await slackApi<{ user: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(viewer.token, "users.info", { user });
      const name = found.profile?.display_name || found.profile?.real_name || found.real_name || found.name || "Someone";
      names.set(user, name);
      return name;
    } catch {
      return "Someone";
    }
  }
  async function members(person: Person) {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await slackApi<{ channels: Channel[]; response_metadata?: { next_cursor?: string } }>(person.token, "users.conversations", {
        types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: 200, cursor,
      });
      for (const channel of page.channels) {
        ids.add(channel.id);
        channels.set(channel.id, { ...channels.get(channel.id), ...channel });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    person.conversations = ids;
    person.membersAt = Date.now();
  }
  async function signIn(person: Person) {
    if (!person.token) return trouble(person, "signed-out", "No Slack sign-in on this machine");
    try {
      const me = await slackApi<{ user_id: string; team_id: string; url: string }>(person.token, "auth.test");
      Object.assign(person, { userId: me.user_id, teamId: me.team_id, url: me.url, state: "ok", problem: undefined });
      await members(person);
    } catch (error) {
      trouble(person, signedOut(error) ? "signed-out" : "unavailable", signedOut(error) ? "Slack sign-in expired or was revoked" : "Slack couldn't be reached");
    }
  }
  function trouble(person: Person, state: ChatRead["state"], problem: string) {
    if (person.state === state && person.problem === problem) return;
    Object.assign(person, { state, problem });
    changed(person);
  }
  // A conversation as one person sees it: a direct or group message is named
  // after the others in it.
  async function describe(id: string, viewer: Person): Promise<Conversation | null> {
    const key = `${viewer.email} ${id}`;
    const known = described.get(key);
    if (known) return known;
    let channel = channels.get(id);
    if (!channel?.is_im && !channel?.is_mpim && !channel?.shared_team_ids)
      try {
        channel = { ...channel, ...(await slackApi<{ channel: Channel }>(viewer.token, "conversations.info", { channel: id })).channel };
        channels.set(id, channel);
      } catch {
        if (!channel) return null;
      }
    let convo: Conversation;
    if (channel.is_im) convo = { id, kind: "im", name: await nameOf(channel.user ?? "", viewer) };
    else if (channel.is_mpim) {
      const list = await slackApi<{ members: string[] }>(viewer.token, "conversations.members", { channel: id, limit: 20 }).then((r) => r.members, () => []);
      const others = await Promise.all(list.filter((user) => user !== viewer.userId).map((user) => nameOf(user, viewer)));
      convo = { id, kind: "mpim", name: others.join(", ") || "Group message" };
    } else {
      const team = channel.is_ext_shared
        ? [channel.context_team_id, ...(channel.shared_team_ids ?? [])].find((t) => t && t !== viewer.teamId)
        : undefined;
      let org = team ? teams.get(team) : undefined;
      if (team && !org)
        org = await slackApi<{ team: { name: string } }>(viewer.token, "team.info", { team }).then((r) => r.team.name, () => undefined);
      if (team && org) teams.set(team, org);
      convo = { id, kind: "channel", name: channel.name ?? "channel", ...(channel.is_ext_shared ? { shared: true, ...(org ? { org } : {}) } : {}) };
    }
    described.set(key, convo);
    return convo;
  }
  async function render(text: string, viewer: Person) {
    for (const user of mentioned(text)) await nameOf(user, viewer);
    return plainText(text, (user) => names.get(user));
  }
  async function onEvent(payload: { event_id?: string; event?: Event }) {
    const event = payload.event;
    if (payload.event_id) {
      if (seen.includes(payload.event_id)) return;
      seen.push(payload.event_id);
      if (seen.length > 500) seen.shift();
    }
    if (event?.type !== "message" || !event.channel) return;
    const edit = event.subtype === "message_changed" ? event.message : undefined;
    if (event.subtype && !edit && !["thread_broadcast", "file_share", "me_message"].includes(event.subtype)) return;
    const raw = edit ?? event;
    if (!raw.ts || !raw.user || event.bot_id) return;
    const message: Message = { user: raw.user, ts: raw.ts, thread_ts: raw.thread_ts, text: raw.text ?? "" };
    for (const person of people) {
      if (person.state !== "ok" || !person.userId) continue;
      if (!person.conversations.has(event.channel) && Date.now() - person.membersAt > 60_000)
        await members(person).catch(() => undefined);
      if (!person.conversations.has(event.channel)) continue;
      const convo = await describe(event.channel, person);
      if (!convo) continue;
      const text = await render(message.text, person);
      const moved = edit
        ? applyEdit(person.items, convo, message, text)
        : applyMessage(person.items, person, convo, message, await nameOf(message.user, person), text);
      if (moved) changed(person);
    }
  }
  // Slack says whether a direct message is still unread; it says nothing of
  // channels.
  async function unread(person: Person) {
    for (const item of person.items.values())
      if (item.place.kind === "direct" && item.unread) {
        const info = await slackApi<{ channel: Channel }>(person.token, "conversations.info", { channel: item.id }).catch(() => null);
        if (info?.channel.unread_count_display === 0) {
          item.unread = false;
          changed(person);
        }
      }
  }
  const pending = new Map<string, NodeJS.Timeout>();
  let saving: NodeJS.Timeout | undefined;
  function changed(person: Person) {
    clearTimeout(pending.get(person.email));
    pending.set(person.email, setTimeout(() => void post(person), SETTLE_MS));
    clearTimeout(saving);
    saving = setTimeout(() => void save(), SETTLE_MS);
  }
  // A failed save keeps what waits in memory; the next change tries again.
  async function save() {
    const data = { people: Object.fromEntries(people.map((p) => [p.email, [...p.items.values()]])), names: Object.fromEntries(names) };
    const temporary = `${stateFile}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, stateFile);
    } catch {
      log("chat_state_unsaved", { source: "slack" });
    }
  }
  async function post(person: Person) {
    const now = Date.now();
    if (prune(person.items, now)) void save();
    // Signed in is not enough: without the connection no message arrives.
    const down = person.state === "ok" && !open;
    const read = slackRead(person.email, person.items, now, down ? "unavailable" : person.state, down ? offline : person.problem);
    read.items = read.items.filter((item) => chatItemSchema.safeParse(item).success);
    try {
      const response = await fetch(new URL("/api/chats/read", site.endpoint), {
        method: "POST", headers: site.headers, body: JSON.stringify(read), redirect: "error", signal: AbortSignal.timeout(20_000),
      });
      log("chat_read_published", { source: "slack", status: response.status, items: read.items.length });
    } catch {
      log("chat_read_failed", { source: "slack" });
    }
  }
  // Socket Mode: open a connection, acknowledge every envelope at once, and
  // open another when Slack asks for a refresh or the connection drops.
  async function listen(appToken: string) {
    let wait = 1000;
    for (;;) {
      try {
        const { url } = await slackApi<{ url: string }>(appToken, "apps.connections.open");
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(url);
          socket.addEventListener("open", () => {
            wait = 1000;
            open = true;
            log("chat_socket_open", { source: "slack" });
            for (const person of people) changed(person);
          });
          socket.addEventListener("message", (message) => {
            let data: { type?: string; envelope_id?: string; payload?: { event_id?: string; event?: Event } };
            try {
              data = JSON.parse(String(message.data));
            } catch {
              return;
            }
            if (data.envelope_id) socket.send(JSON.stringify({ envelope_id: data.envelope_id }));
            if (data.type === "events_api" && data.payload)
              void onEvent(data.payload).catch(() => log("chat_event_failed", { source: "slack" }));
            if (data.type === "disconnect") socket.close();
          });
          socket.addEventListener("close", () => {
            open = false;
            offline = "Not connected to Slack right now";
            for (const person of people) changed(person);
            resolve();
          });
          socket.addEventListener("error", () => socket.close());
        });
      } catch (error) {
        const bad = error instanceof SlackError && ["invalid_auth", "not_authed", "token_revoked"].includes(error.code);
        const reason = bad ? "The Slack app's token is missing or invalid" : "Slack couldn't be reached";
        if (reason !== offline) {
          offline = reason;
          for (const person of people) changed(person);
        }
        if (error instanceof SlackError && error.retryAfter) wait = Math.max(wait, error.retryAfter * 1000);
      }
      await sleep(wait);
      wait = Math.min(wait * 2, 300_000);
    }
  }

  // Without the app's token nothing can be read, whoever has signed in.
  const appToken = process.env.SLACK_APP_TOKEN ?? "";
  const connectable = /^xapp-[\w-]+$/.test(appToken);
  log("chat_watcher_started", { people: people.length });
  for (const person of people)
    if (connectable) await signIn(person);
    else trouble(person, "unavailable", "The Slack app's token is missing or invalid");
  setInterval(() => {
    for (const person of people)
      void (async () => {
        if (!connectable) return post(person);
        if (person.state !== "ok") await signIn(person);
        else {
          if (Date.now() - person.membersAt > MEMBERS_MS) await members(person).catch(() => undefined);
          await unread(person);
        }
        await post(person);
      })();
  }, TICK_MS);
  process.on("SIGTERM", () => {
    void Promise.allSettled([save(), ...stopTeams.map((stop) => stop())]).finally(() => process.exit(0));
  });
  if (connectable) await listen(appToken);
}
main().catch(() => {
  console.error("The chat watcher stopped. Check machine.json and the Doppler config's Slack tokens.");
  process.exitCode = 1;
});

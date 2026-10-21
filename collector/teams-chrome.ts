// Drives the Teams web app in a dedicated Chrome profile on this machine and
// reads its chat list. It launches the system Chrome once, keeps it open,
// connects to it over the DevTools protocol (a WebSocket, like the Slack
// watcher's), and every poll evaluates a small script in the page that reads
// the list — never opening a chat, so never sending a read receipt. The
// profile is signed in to Teams once by the machine's owner; this process
// never signs in or types to anyone. The reading, parsing and item logic are
// in collector/teams.ts, which is tested; this file is the browser plumbing.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { chatItemSchema, type ChatItem, type ChatRead } from "../src/chat-model";
import { postChatRead, type Site } from "./upload";
import { applyTeams, prune, teamsRead, type TeamsRow } from "./teams";

const TICK_MS = 60_000;
const SETTLE_MS = 3_000;
// Where the system Chrome lives on macOS.
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TEAMS_URL = "https://teams.cloud.microsoft/";

const log = (event: string, fields: Record<string, string | number> = {}) =>
  console.log(JSON.stringify({ event, at: Date.now(), ...fields }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The script evaluated in the Teams page. Teams' left pane is one tree: folder
// headings (Quick views, Favorites, Chats, Teams and channels) at level 1 and
// conversations under them, each carrying its thread id ("19:…@thread.tacv2"
// for a channel or team, "@thread.v2" for a group chat, "@unq.gbl.spaces" for
// a 1:1) in its test id or tree value. A bold title is Teams' unread mark.
// Teams reopens a conversation whenever it loads, so the script moves the page
// to the Drafts quick view, which opens none; otherwise it only expands a
// collapsed Chats heading. It never clicks a conversation, so it never opens
// one, sends a read receipt or marks anything read. A sign-in page is reported
// only when it asks for something; Teams' own sign-in hops pass through as
// "not listed yet".
export const EXTRACT = `(() => {
  try {
    const login = /(^|\\.)login\\.(microsoftonline|live|microsoft)\\.com$/.test(location.host);
    const prompt = document.querySelector('input[type=password], input[type=email], #tilesHolder, [data-test-id="list-item"]');
    if (login || prompt) return { signedIn: !prompt, listed: false, rows: [] };
    const tree = document.querySelector('[role="tree"][data-tid="simple-collab-dnd-rail"]') || document.querySelector('[role="tree"]');
    if (!tree) return { signedIn: /(^|\\.)teams\\.(cloud\\.)?microsoft(\\.com)?$/.test(location.host), listed: false, rows: [] };
    const items = [...tree.querySelectorAll('[role="treeitem"]')];
    const type = (el) => el.getAttribute('data-item-type') || '';
    const open = items.find((el) => /LeftRailSelectedItem/.test(el.getAttribute('data-tabster') || '') || el.getAttribute('aria-selected') === 'true');
    const drafts = tree.querySelector('[data-testid="slice-list-item-slice-drafts"]');
    if (open && type(open) !== 'slice' && drafts) drafts.click();
    for (const el of items) if (type(el) === 'chats' && el.getAttribute('aria-expanded') === 'false') el.click();
    // An element of this row itself, not of a row nested under it.
    const own = (el, sel) => [...el.querySelectorAll(sel)].filter((e) => e.closest('[role="treeitem"]') === el);
    const rows = [], seen = new Set();
    for (const el of items) {
      if (el.getAttribute('aria-level') === '1' || el.hasAttribute('data-conversation-folder') || type(el) === 'slice') continue;
      // A team row stands for its channels only while they are folded away.
      if (type(el) === 'team' && el.getAttribute('aria-expanded') !== 'false') continue;
      const ids = [el.getAttribute('data-testid'), el.getAttribute('data-fui-tree-item-value'), ...own(el, '[id],[data-testid]').map((e) => e.id + ' ' + (e.getAttribute('data-testid') || ''))].join(' ');
      const m = ids.match(/19:[^\\s|]+?@(thread\\.(tacv2|skype|v2)|unq\\.gbl\\.spaces)/);
      if (!m || seen.has(m[0])) continue;
      seen.add(m[0]);
      const title = own(el, '[id^="title-"]')[0] || own(el, 'span,div').find((t) => [...t.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()));
      // An avatar's initials are decoration (aria-hidden), not the preview.
      const hidden = new Set(own(el, '[aria-hidden="true"],[role="img"]').map((e) => (e.innerText || '').trim()));
      const lines = [...el.children].filter((c) => c.getAttribute('role') !== 'group').map((c) => c.innerText || '').join('\\n').split('\\n').map((t) => t.trim()).filter((t) => t && !hidden.has(t));
      const name = ((title && title.innerText) || lines[0] || '').trim();
      const folder = el.parentElement && el.parentElement.closest('[role="treeitem"]');
      const marks = own(el, '[aria-label],[title],[data-tid]').map((b) => [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-tid')].join(' ')).join(' ');
      rows.push({
        id: m[0],
        name: name.slice(0, 300),
        detail: lines.filter((t) => t !== name).join(' \\u00b7 ').slice(0, 1500),
        favorite: /^favorite-/.test(el.getAttribute('data-testid') || '') || /~Favorites$/.test((folder && folder.getAttribute('data-fui-tree-item-value')) || ''),
        unread: Number(getComputedStyle(title || el).fontWeight) >= 600 || /\\bunread\\b/i.test(marks),
        mention: /mention/i.test(marks),
      });
    }
    return { signedIn: true, listed: true, rows };
  } catch (e) {
    return { signedIn: true, listed: false, rows: [], error: String((e && e.message) || e) };
  }
})()`;

// What EXTRACT returns, before teams.ts turns it into items.
export const rawSchema = z.object({
  signedIn: z.boolean(),
  listed: z.boolean().default(false),
  rows: z
    .array(
      z.object({
        id: z.string().regex(/^19:/).max(400),
        name: z.string().max(300),
        detail: z.string().max(1500).default(""),
        favorite: z.boolean().default(false),
        unread: z.boolean(),
        mention: z.boolean(),
      }),
    )
    .max(400)
    .default([]),
});
export type RawRow = z.infer<typeof rawSchema>["rows"][number];
// A trailing time Teams prints after a chat's preview ("9:42 AM", "Yesterday",
// "Mon", "20/10").
const TIME = /\s*·?\s*(\d{1,2}:\d{2}(\s?[AP]M)?|Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i;
// One tree row as a chat row. The kind comes from the thread id. A chat's
// detail line is its preview, "Sender: message" in a group or "You: …" when
// the person wrote last; a channel shows no preview in the list, so its text is
// empty and "Open in Teams" shows the posts.
export function parseRow(raw: RawRow): TeamsRow | null {
  const name = raw.name.trim();
  if (!name) return null;
  const kind: TeamsRow["kind"] = raw.id.includes("@unq.gbl.spaces") ? "direct" : raw.id.includes("@thread.v2") ? "group" : "channel";
  let from = kind === "channel" ? "New posts" : name,
    preview = "";
  if (kind !== "channel") {
    const detail = raw.detail.replace(TIME, "").trim();
    const said = /^([^:·]{1,80}):\s+(.+)$/.exec(detail);
    if (said) {
      from = said[1].trim();
      preview = said[2].trim();
    } else preview = detail;
  }
  return {
    key: raw.id,
    name,
    kind,
    url: TEAMS_URL,
    from,
    preview,
    unread: raw.unread,
    mention: raw.mention,
    favorite: raw.favorite,
  };
}

type Options = {
  account: string;
  profileDir: string;
  site: Site;
  stateDir: string;
  chrome?: string;
};
// A tiny DevTools-protocol client over one page's WebSocket: send a command,
// await its reply by id, ignore the events.
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      let data: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        data = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (typeof data.id !== "number") return;
      const waiting = this.pending.get(data.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      if (data.error) waiting.reject(new Error(data.error.message ?? "cdp error"));
      else waiting.resolve(data.result);
    });
  }
  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 20_000);
    });
  }
}
async function pageSocketUrl(port: number): Promise<string | null> {
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json()) as {
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }[];
    const page =
      targets.find((t) => t.type === "page" && /teams\.(cloud\.)?microsoft|login\.microsoft/.test(t.url)) ??
      targets.find((t) => t.type === "page");
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

// Launch Chrome with the dedicated profile and read the debugging port it
// writes into the profile. Port 0 lets Chrome choose, which avoids a clash.
async function launch(chrome: string, profileDir: string): Promise<{ child: ChildProcess; port: number } | null> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      // The DevTools endpoint stays bound to 127.0.0.1; the Node client sends
      // no Origin, so no --remote-allow-origins is needed (it would only widen
      // which web origins may drive this signed-in session).
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      TEAMS_URL,
    ],
    { stdio: "ignore", detached: false },
  );
  const portFile = path.join(profileDir, "DevToolsActivePort");
  for (let waited = 0; waited < 30_000; waited += 500) {
    await sleep(500);
    if (child.exitCode !== null) return null;
    const port = Number((await readFile(portFile, "utf8").catch(() => "")).split("\n")[0]);
    if (port) return { child, port };
  }
  child.kill();
  return null;
}

const savedSchema = z.object({ items: z.array(chatItemSchema).default([]) });
// Read Teams for one person until stopped: keep Chrome open, poll the list,
// and post a read each poll so its age shows. Returns a stop function.
export function startTeams(options: Options): () => Promise<void> {
  const { account, profileDir, site, stateDir } = options;
  const chrome = options.chrome ?? CHROME;
  const stateFile = path.join(stateDir, "chats-teams.json");
  const items = new Map<string, ChatItem>();
  let stopped = false;
  let child: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  let ws: WebSocket | null = null;
  let state: ChatRead["state"] = "unavailable";
  let problem: string | undefined = "Teams is not open yet";
  let saveTimer: NodeJS.Timeout | undefined;

  async function load() {
    const parsed = savedSchema.safeParse(JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}")));
    if (parsed.success) for (const item of parsed.data.items) items.set(item.id, item);
  }
  async function save() {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ items: [...items.values()] }), { mode: 0o600 });
      await rename(temporary, stateFile);
    } catch {
      log("chat_state_unsaved", { source: "teams" });
    }
  }
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SETTLE_MS);
  }
  async function connect(): Promise<boolean> {
    if (ws) return true;
    let fresh = false;
    if (!child || child.exitCode !== null) {
      const launched = await launch(chrome, profileDir);
      if (!launched) {
        state = "unavailable";
        problem = "Teams' browser could not be started on this machine";
        return false;
      }
      child = launched.child;
      child.once("exit", () => {
        if (child && !stopped) log("teams_chrome_exited", {});
        ws = null;
        cdp = null;
        child = null;
      });
      fresh = true;
      await sleep(5_000);
    }
    const port = Number((await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0]);
    const url = port ? await pageSocketUrl(port) : null;
    if (!url) {
      state = "unavailable";
      problem = "Teams' browser could not be reached on this machine";
      return false;
    }
    try {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws error")));
        setTimeout(() => reject(new Error("ws open timeout")), 10_000);
      });
      socket.addEventListener("close", () => {
        if (ws === socket) {
          ws = null;
          cdp = null;
        }
      });
      ws = socket;
      cdp = new Cdp(socket);
      await cdp.send("Runtime.enable");
      // Teams signs itself in, reopens a conversation and draws its list. Look
      // every two seconds: the first look that finds the list also leaves the
      // conversation (EXTRACT). Then let the list fill in.
      if (fresh) {
        for (let waited = 0; waited < 40_000; waited += 2_000) {
          const look = await cdp
            .send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: EXTRACT, returnByValue: true })
            .catch(() => null);
          if (rawSchema.safeParse(look?.result?.value).data?.listed) break;
          await sleep(2_000);
        }
        await sleep(5_000);
      }
      return true;
    } catch {
      ws = null;
      cdp = null;
      state = "unavailable";
      problem = "Teams' browser could not be reached on this machine";
      return false;
    }
  }
  async function pollOnce() {
    if (!(await connect()) || !cdp) return;
    let result: { result?: { value?: unknown }; exceptionDetails?: unknown };
    try {
      result = await cdp.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true, awaitPromise: true });
    } catch {
      state = "unavailable";
      problem = "Teams could not be read on this machine";
      return;
    }
    const parsed = rawSchema.safeParse(result?.result?.value);
    if (!parsed.success) {
      state = "unavailable";
      problem = "Teams' chat list could not be read";
      return;
    }
    if (!parsed.data.signedIn) {
      state = "signed-out";
      problem = "Teams needs you to sign in again on this machine";
      return;
    }
    state = "ok";
    problem = undefined;
    // Signed in but the list is not in the page yet (still loading): keep what
    // we had rather than clearing on a half-loaded page.
    if (!parsed.data.listed) return;
    const rows = parsed.data.rows.map(parseRow).filter((r): r is TeamsRow => r !== null);
    const next = applyTeams(items, rows, Date.now());
    items.clear();
    for (const [key, item] of next) items.set(key, item);
    prune(items, Date.now());
    queueSave();
  }
  async function post() {
    const status = await postChatRead(site, teamsRead(account, items, Date.now(), state, problem));
    log("chat_read_published", { source: "teams", status: status ?? 0, items: items.size, state });
  }

  void (async () => {
    await load();
    log("teams_watcher_started", { account: account.split("@")[1] ?? "" });
    while (!stopped) {
      await pollOnce();
      await post();
      await sleep(TICK_MS);
    }
  })();

  return async () => {
    stopped = true;
    clearTimeout(saveTimer);
    await save();
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    child?.kill();
  };
}

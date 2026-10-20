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
const TEAMS_URL = "https://teams.microsoft.com/";

const log = (event: string, fields: Record<string, string | number> = {}) =>
  console.log(JSON.stringify({ event, at: Date.now(), ...fields }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The script evaluated in the Teams page. It returns whether the person is
// signed in and one normalised row per chat, read from the list only. Teams
// web markup shifts, so it reads accessible names and links defensively; the
// exact shape is confirmed against the real page on first sign-in.
const EXTRACT = `(() => {
  try {
    const host = location.host || "";
    if (/login\\.microsoftonline\\.com|login\\.live\\.com|\\/_#\\/login/.test(location.href) || document.querySelector('input[type=password]'))
      return { signedIn: false, listed: false, rows: [] };
    const list = document.querySelector('[data-tid="chat-list"], [role="tree"][aria-label], [role="list"][aria-label]');
    const nodes = [...document.querySelectorAll('[data-tid="chat-list-item"], [role="treeitem"], [role="listitem"]')];
    // "listed" means the chat list was found: only then is an empty result a
    // real "no chats", not a page still loading. Without it the reader keeps
    // what it had rather than clearing on a half-loaded page.
    if (!nodes.length) return { signedIn: !!list || /teams\\.microsoft/.test(host), listed: !!list, rows: [] };
    const rows = [];
    for (const el of nodes.slice(0, 200)) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!label) continue;
      const link = el.querySelector('a[href]');
      const href = link ? link.href : (el.getAttribute('data-tid') ? null : null);
      const id = el.getAttribute('data-item-key') || el.getAttribute('data-tid') || el.id || (href || label);
      const unread = /\\bunread\\b/i.test(label) || !!el.querySelector('[data-tid="unread"], [aria-label*="unread" i]');
      const mention = /@|mention/i.test(label) || !!el.querySelector('[data-tid*="mention" i], [aria-label*="mention" i]');
      const channel = !!el.closest('[data-tid="team-channel-list"], [aria-label*="Teams and channels" i]');
      const group = !channel && (el.querySelectorAll('img, [data-tid="avatar"]').length > 1 || /\bgroup\b/i.test(label));
      rows.push({ id: String(id), label, href: href || undefined, unread, mention, channel, group });
    }
    return { signedIn: true, listed: true, rows };
  } catch (e) {
    return { signedIn: false, listed: false, rows: [], error: String(e && e.message || e) };
  }
})()`;

// What EXTRACT returns, before teams.ts turns it into items.
const rawSchema = z.object({
  signedIn: z.boolean(),
  listed: z.boolean().default(false),
  rows: z
    .array(
      z.object({
        id: z.string().min(1).max(400),
        label: z.string().max(2000),
        href: z.string().max(2000).optional(),
        unread: z.boolean(),
        mention: z.boolean(),
        channel: z.boolean(),
        group: z.boolean().default(false),
      }),
    )
    .max(400)
    .default([]),
});
// Turn a raw row's accessible name into a chat row. The name leads with the
// chat or channel, then the latest message as "Sender: message" (or
// "You: message"); a trailing time and an "unread" word are dropped. Tuned
// against the real page on first sign-in.
export function parseRow(raw: z.infer<typeof rawSchema>["rows"][number]): TeamsRow | null {
  const parts = raw.label.split(/,\s+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const name = parts[0];
  if (!name) return null;
  const said = parts.find((p) => /: /.test(p));
  let from = name,
    preview = "";
  if (said) {
    const at = said.indexOf(": ");
    from = said.slice(0, at).trim() || name;
    preview = said.slice(at + 2).trim();
  }
  // A text blob can't tell a 1:1 from a group reliably, so the kind comes
  // from the row's own signals (its location and avatars), not from the name.
  const kind: TeamsRow["kind"] = raw.channel ? "channel" : raw.group ? "group" : "direct";
  return { key: raw.id, name, kind, url: raw.href, from, preview, unread: raw.unread, mention: raw.mention };
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
      targets.find((t) => t.type === "page" && /teams\.microsoft|login\.microsoft/.test(t.url)) ??
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
      await sleep(3000); // let the first page target appear
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

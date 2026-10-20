// Each person's chat, as a machine read it with that person's own sign-in:
// the newest read per source and person, its items served to that person
// without text, one item's text at a time, and what they did with an item
// here. Nobody lists anyone else's items, and nothing is ever posted, marked
// read or changed in Slack or Teams.
import { readJson } from "./auth";
import { clip } from "../src/run-text";
import {
  CHAT_PREVIEW_LIMIT,
  chatActionSchema,
  chatReadSchema,
  chatState,
  type ChatAction,
  type ChatItem,
  type ChatList,
  type ChatMark,
  type ChatRead,
  type ChatView,
} from "../src/chat-model";
import { trace } from "./telemetry";
import type { MachineCaller } from "./machines";
import type { Portfolio } from "./index";

const SKEW_MS = 10 * 60_000;
// Marks outlive their items a while, so a gap in reads keeps what was done.
const KEEP_MARKS_MS = 30 * 86400_000;
type Stored = Omit<ChatRead, "items"> & { host: string; items: (ChatItem & { key: string })[] };
type MarkRow = { key: string; holder: string | null; handed_by: string | null; handed_at: number | null; done_at: number | null };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// An opaque key, so links and requests carry no names or IDs from the source.
async function itemKey(source: string, owner: string, id: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${source}\n${owner}\n${id}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export class Chats {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS chat_reads (source TEXT NOT NULL, owner TEXT NOT NULL, observed INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (source, owner))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS chat_marks (key TEXT PRIMARY KEY, holder TEXT, handed_by TEXT, handed_at INTEGER, done_at INTEGER, updated INTEGER NOT NULL)",
    );
  }
  // The newest read per source and person wins; an older one changes nothing.
  async publish(read: ChatRead, host: string) {
    const owner = read.owner.toLowerCase();
    const items = await Promise.all(
      read.items.map(async (item) => ({ ...item, key: await itemKey(read.source, owner, item.id) })),
    );
    const stored: Stored = { ...read, owner, host, items };
    const accepted = this.storage.sql
      .exec(
        "INSERT INTO chat_reads(source,owner,observed,payload) VALUES(?,?,?,?) ON CONFLICT(source,owner) DO UPDATE SET observed=excluded.observed,payload=excluded.payload WHERE excluded.observed > chat_reads.observed RETURNING owner",
        read.source, owner, read.observedAt, JSON.stringify(stored),
      )
      .toArray().length === 1;
    this.storage.sql.exec("DELETE FROM chat_marks WHERE updated<?", Date.now() - KEEP_MARKS_MS);
    return { accepted };
  }
  private reads(): Stored[] {
    return this.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM chat_reads ORDER BY source,owner")
      .toArray()
      .map((row) => JSON.parse(row.payload) as Stored);
  }
  private marks() {
    return new Map(
      this.storage.sql
        .exec<MarkRow>("SELECT key,holder,handed_by,handed_at,done_at FROM chat_marks")
        .toArray()
        .map((r): [string, ChatMark] => [r.key, { holder: r.holder, handedBy: r.handed_by, handedAt: r.handed_at, doneAt: r.done_at }]),
    );
  }
  // The viewer's own items and any handed to them, previews only, with the
  // state of the viewer's own reads.
  list(viewer: string): ChatList {
    const marks = this.marks(),
      reads = this.reads(),
      items: ChatView[] = [];
    for (const read of reads)
      for (const { text, ...item } of read.items) {
        const mark = marks.get(item.key);
        const state = chatState(item, read.owner, viewer, mark);
        if (!state) continue;
        items.push({
          ...item,
          source: read.source,
          owner: read.owner,
          state,
          preview: clip(text.replace(/\s+/g, " ").trim(), CHAT_PREVIEW_LIMIT),
          ...(state === "handed" && mark?.holder ? { handedTo: mark.holder } : {}),
          ...(!same(read.owner, viewer) && mark?.handedBy ? { handedBy: mark.handedBy } : {}),
        });
      }
    return {
      reads: reads
        .filter((read) => same(read.owner, viewer))
        .map(({ source, observedAt, state, problem, host }) => ({ source, observedAt, state, host, ...(problem ? { problem } : {}) })),
      items: items.sort((a, b) => b.at - a.at),
    };
  }
  private find(key: string, viewer: string) {
    const marks = this.marks();
    for (const read of this.reads()) {
      const item = read.items.find((i) => i.key === key);
      if (!item) continue;
      const mark = marks.get(key);
      const state = chatState(item, read.owner, viewer, mark);
      return state ? { read, item, mark, state } : null;
    }
    return null;
  }
  // One item's latest message, for a person who can see the item.
  text(key: string, viewer: string) {
    const found = this.find(key, viewer);
    return found ? { text: found.item.text } : null;
  }
  // Done and Reopen by whoever holds the item; Hand over to another person,
  // or back to its owner, which ends the hand over. Each holds until a newer
  // message arrives.
  act(key: string, viewer: string, action: ChatAction["action"], to?: string) {
    const found = this.find(key, viewer);
    if (!found || (found.state === "handed" && !(action === "hand" && to && same(to, found.read.owner)))) return null;
    const { item, read, mark } = found;
    const cleared: ChatMark = { holder: null, handedBy: null, handedAt: null, doneAt: null };
    let next = mark ?? cleared;
    if (action === "hand") {
      if (!to) return null;
      if (same(to, read.owner)) next = cleared;
      else if (same(to, viewer)) return null;
      else next = { holder: to.toLowerCase(), handedBy: viewer.toLowerCase(), handedAt: item.at, doneAt: null };
    } else next = { ...next, doneAt: action === "done" ? item.at : null };
    this.storage.sql.exec(
      "INSERT INTO chat_marks(key,holder,handed_by,handed_at,done_at,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,handed_by=excluded.handed_by,handed_at=excluded.handed_at,done_at=excluded.done_at,updated=excluded.updated",
      key, next.holder, next.handedBy, next.handedAt, next.doneAt, Date.now(),
    );
    return this.list(viewer);
  }
}
type Store = Pick<DurableObjectStub<Portfolio>, "publishChats" | "chatList" | "chatText" | "actOnChat" | "rate">;
// A machine's collector posts each person's read; a signed-in person lists
// their own items, reads one item's text and acts on it. Only a collector's
// token reaches the read route in production; the local emulator posts as its
// one person, and only that person's own read. A conversation browser's
// sign-in never reaches these (browserMay).
export async function chatRoutes(
  request: Request,
  store: Store,
  caller: string | MachineCaller,
  isAllowed: (email: string) => boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/chats/read" && request.method === "POST") {
    let read;
    try {
      read = chatReadSchema.parse(await readJson(request, 1_000_000));
    } catch {
      return Response.json({ error: "Invalid chat read" }, { status: 400 });
    }
    if (!isAllowed(read.owner.toLowerCase()) || (typeof caller === "string" && !same(caller, read.owner)))
      return Response.json({ error: "A read belongs to a person who signs in here" }, { status: 400 });
    if (Math.abs(Date.now() - read.observedAt) > SKEW_MS)
      return Response.json({ error: "Read timestamp outside allowed window" }, { status: 400 });
    const host = typeof caller === "string" ? "signed-in" : caller.machine;
    const result = await trace("chat.publish", {}, () => store.publishChats(read, host));
    return Response.json(result, { status: result.accepted ? 200 : 409 });
  }
  if (typeof caller !== "string") return null;
  if (url.pathname === "/api/chats" && request.method === "GET")
    return Response.json(await trace("chat.list", {}, () => store.chatList(caller)), {
      headers: { "Cache-Control": "no-store" },
    });
  if (url.pathname === "/api/chats/act" && request.method === "POST") {
    let input;
    try {
      input = chatActionSchema.parse(await readJson(request, 512));
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    if (input.action === "hand" && !(input.to && isAllowed(input.to.toLowerCase())))
      return Response.json({ error: "Choose someone who signs in to Projects." }, { status: 400 });
    if (!(await store.rate(`chats:${caller}`, 120, 60_000)))
      return Response.json({ error: "Try again shortly." }, { status: 429 });
    const list = await trace("chat.action", {}, () => store.actOnChat(input.key, caller, input.action, input.to));
    return Response.json(list ?? { error: "This message isn't yours to change here any more." }, { status: list ? 200 : 404 });
  }
  const item = /^\/api\/chats\/([a-f0-9]{64})$/.exec(url.pathname);
  if (item && request.method === "GET") {
    const found = await trace("chat.read", {}, () => store.chatText(item[1], caller));
    return Response.json(found ?? { error: "This message is no longer here." }, {
      status: found ? 200 : 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}

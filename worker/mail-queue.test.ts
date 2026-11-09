import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { start, options } from "./miniflare-fixtures";
import { digest, token } from "./auth";
import type { ChatList, ChatRead } from "../src/chat-model";
import type { Portfolio } from "./index";

test("urgent mail is private, duty-only, deduplicated across copies, and links to the email queue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-mail-"));
  const script = path.join(dir, "worker.mjs"), origin = "https://example.com";
  const owner = "owner@example.com", colleague = "colleague@example.com";
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const mf = await start(await options(script, dir, { OWNER_EMAIL: owner, ALLOWED_EMAILS: `${owner},${colleague}` }));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const signIn = async (email: string) => {
      const salt = token(), value = token();
      await db.issue(email, salt, digest(`${salt}:123456`));
      assert.equal(await db.verify(email, "123456", digest(value)), true);
      return { Cookie: `__Host-projects=${value}`, Origin: origin };
    };
    const person = await signIn(owner), other = await signIn(colleague);
    const primary = (await db.addMachine("Studio"))!, fallback = (await db.addMachine("Laptop"))!;
    const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });
    const post = (route: string, body: object, headers: Record<string, string>) =>
      mf.dispatchFetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const get = async <T,>(route: string, headers: Record<string, string>): Promise<T> =>
      await (await mf.dispatchFetch(origin + route, { headers })).json() as T;
    const auth = bearer(primary.tokens.collector), next = bearer(fallback.tokens.collector);
    const at = Date.now() - 500;
    const snapshot = { version: 1, host: primary.id, collectedAt: at, projects: [], unassignedSessions: [] };
    assert.equal((await post("/api/ingest", snapshot, auth)).status, 200);
    const item = {
      id: "case", place: { name: "A private support request", kind: "thread" as const }, from: "Person",
      at, count: 1, unread: true, mention: true, text: "Private message text",
      mail: { account: "help@example.com", thread: "aaaaaaaaaa01", messageKey: "a".repeat(64), urgent: true },
    };
    const read: ChatRead = { source: "support", owner, observedAt: at, state: "ok", emailQueue: true, items: [item] };
    assert.equal((await post("/api/chats/read", read, next)).status, 409);
    assert.equal((await post("/api/chats/read", read, person)).status, 401);
    assert.equal((await post("/api/chats/read", read, auth)).status, 200);
    const copy = { ...item, id: "copy", mail: { ...item.mail, account: owner, thread: "aaaaaaaaaa02" } };
    assert.equal((await post("/api/chats/read", { ...read, items: [copy], observedAt: at + 1 }, auth)).status, 200);
    const events = await get<{ events: { title: string; url: string }[] }>("/api/push/events", person);
    assert.deepEqual(events.events.map(e => [e.title, e.url]), [["Urgent email", "/?view=inbox&source=email"]]);
    assert.deepEqual((await get<{ events: unknown[] }>("/api/push/events", other)).events, []);
    assert.deepEqual((await get<ChatList>("/api/chats", other)).items, []);
    const queue = await get<ChatList>("/api/chats", person);
    assert.equal(queue.reads[0].emailQueue, true);
    assert.equal(queue.items[0].mail?.urgent, true);
    assert.equal((await post("/api/chats/act", { key: queue.items[0].key, action: "hand", to: colleague }, person)).status, 404);
    const aged = { ...item, at: at - 11 * 60_000, mail: { ...item.mail, messageKey: "b".repeat(64) } };
    assert.equal((await post("/api/chats/read", { ...read, items: [aged], observedAt: at + 2 }, auth)).status, 200);
    assert.equal((await get<{ events: unknown[] }>("/api/push/events", person)).events.length, 1);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

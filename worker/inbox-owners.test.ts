// Each inbox is its owner's (worker/inbox.ts): message text and requests go
// to the owner; everyone else sees what counts the inbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import type { Inbox } from "../src/inbox-model";
import { start, options } from "./miniflare-fixtures";
import type { Miniflare } from "miniflare";
import { inboxSnapshot, peopleInboxSnapshot } from "./snapshot-fixtures";

test("inboxes are each their owner's: message text and requests to the owner, counts and links to everyone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-people-inbox-"));
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: path.join(dir, "worker.mjs") });
  const bearer = `Bearer ${"x".repeat(64)}`;
  const env = { ALLOWED_EMAILS: "owner@example.com,matt@example.com", OWNER_EMAIL: "owner@example.com", COLLECTOR_TOKEN: "x".repeat(64) };
  let mf: Miniflare = await start(await options(path.join(dir, "worker.mjs"), dir, env));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const origin = "https://example.com";
    const signIn = async (email: string) => {
      const salt = token(), value = token();
      await store.issue(email, salt, digest(`${salt}:123456`));
      await store.verify(email, "123456", digest(value));
      return { Cookie: `__Host-projects=${value}`, Origin: origin };
    };
    const owner = await signIn("owner@example.com"), matt = await signIn("matt@example.com");
    const ingest = (snapshot: object) => mf.dispatchFetch(`${origin}/api/ingest`, { method: "POST", headers: { Authorization: bearer, "Content-Type": "application/json" }, body: JSON.stringify(snapshot) });
    type Seen = { snapshots: { inboxes?: Inbox[]; inbox?: Inbox }[]; inboxActions: { threadId: string; account?: string; state: string }[] };
    const overview = async (as: Record<string, string>) => (await (await mf.dispatchFetch(`${origin}/api/overview`, { headers: as })).json()) as Seen;
    const act = (as: Record<string, string>, body: object) =>
      mf.dispatchFetch(`${origin}/api/inbox/act`, { method: "POST", headers: { "Content-Type": "application/json", ...as }, body: JSON.stringify(body) });
    const read = (as: Record<string, string>, thread: string) => mf.dispatchFetch(`${origin}/api/inbox/threads/${thread}`, { headers: as });
    const at = Date.now();
    const placeholders = { names: ["Ada", "Sam", "Lee"], observedAt: at };
    assert.equal((await ingest({ ...peopleInboxSnapshot(at), inboxPlaceholders: placeholders })).status, 200);
    assert.deepEqual((await store.overview())[0].inboxPlaceholders, placeholders);
    // Everyone sees every inbox: their own threads without message text,
    // everyone else's with nothing of the email but what counts it.
    const byOwner = await overview(owner);
    assert.deepEqual((byOwner.snapshots[0] as { inboxPlaceholders?: unknown }).inboxPlaceholders, placeholders);
    const inboxes = byOwner.snapshots[0].inboxes!;
    assert.deepEqual(inboxes.map((i) => i.account), ["owner@example.com", "matt@example.com"]);
    assert.deepEqual(inboxes[0].threads.map((t) => [t.subject, t.body]), [["Weekly news", undefined], ["Contract", undefined]]);
    assert.deepEqual(inboxes[1].threads.map((t) => [t.id, t.subject, t.from, t.body, t.unsubscribe, t.inInbox, t.latestMessageId]), [["cccccccccc01", "", "", undefined, undefined, true, "cccccccccc02"]]);
    assert.doesNotMatch(JSON.stringify(byOwner), /Invoice|Supplier|MATT-BODY-MARKER|PRIVATE-BODY-MARKER/);
    const byMatt = await overview(matt);
    assert.deepEqual(byMatt.snapshots[0].inboxes!.map((i) => i.threads.map((t) => t.subject)), [["", ""], ["Invoice"]]);
    assert.doesNotMatch(JSON.stringify(byMatt), /Weekly news|Contract|news@news|MATT-BODY-MARKER/);
    // Message text goes to the inbox's owner alone.
    assert.equal(((await (await read(matt, "cccccccccc01")).json()) as { thread: { body: string } }).thread.body, "Pay by Friday: MATT-BODY-MARKER");
    assert.equal((await read(owner, "cccccccccc01")).status, 404);
    assert.equal((await read(matt, "aaaaaaaaaa01")).status, 404);
    assert.equal(((await (await read(owner, "aaaaaaaaaa01")).json()) as { thread: { body: string } }).thread.body, "This week: PRIVATE-BODY-MARKER");
    // Only the inbox's owner queues a request against it, and it names the inbox.
    assert.equal((await act(matt, { threadId: "aaaaaaaaaa01", action: "archive" })).status, 404);
    assert.equal((await act(matt, { threadId: "aaaaaaaaaa01", action: "link", issue: 7 })).status, 404);
    assert.equal((await act(owner, { threadId: "aaaaaaaaaa01", action: "archive" })).status, 200);
    assert.equal((await act(matt, { threadId: "cccccccccc01", action: "archive" })).status, 200);
    const pending = ((await (await mf.dispatchFetch(`${origin}/api/inbox/actions`, { headers: { Authorization: bearer } })).json()) as { actions: { threadId: string; account: string; requestedAt: number; action: string }[] }).actions;
    assert.deepEqual(pending.map((a) => [a.threadId, a.account]), [["aaaaaaaaaa01", "owner@example.com"], ["cccccccccc01", "matt@example.com"]]);
    const sql = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", { name: "test" });
    assert.deepEqual(await sql.exec("SELECT thread,account,requester FROM inbox_actions ORDER BY thread"), [
      { thread: "aaaaaaaaaa01", account: "owner@example.com", requester: "owner@example.com" },
      { thread: "cccccccccc01", account: "matt@example.com", requester: "matt@example.com" },
    ]);
    // Everyone's requests are in the overview, each naming its inbox; only the owner withdraws theirs.
    assert.deepEqual((await overview(owner)).inboxActions.map((a) => [a.threadId, a.account, a.state]), [["aaaaaaaaaa01", "owner@example.com", "queued"], ["cccccccccc01", "matt@example.com", "queued"]]);
    assert.equal((await act(owner, { threadId: "cccccccccc01", action: "archive", cancel: true })).status, 200);
    assert.equal((await store.pendingInboxActions()).length, 2, "another person's withdrawal changes nothing");
    assert.equal((await act(matt, { threadId: "cccccccccc01", action: "archive", cancel: true })).status, 200);
    assert.deepEqual((await store.pendingInboxActions()).map((a) => a.threadId), ["aaaaaaaaaa01"]);
    // The machine on duty reports the request as it was given, account included.
    const report = await mf.dispatchFetch(`${origin}/api/inbox/actions`, { method: "POST", headers: { Authorization: bearer, "Content-Type": "application/json" }, body: JSON.stringify({ ...pending[0], state: "done", message: null }) });
    assert.deepEqual(await report.json(), { updated: true });
    // A collector from before accounts were listed publishes one inbox: its owner's.
    assert.equal((await ingest(inboxSnapshot(at + 1000))).status, 200);
    assert.equal((await read(owner, "aaaaaaaaaa01")).status, 200);
    assert.equal((await read(matt, "aaaaaaaaaa01")).status, 404);
    assert.equal((await act(matt, { threadId: "bbbbbbbbbb01", action: "archive" })).status, 404);
    const legacy = await overview(matt);
    assert.equal(legacy.snapshots[0].inbox, undefined, "served under inboxes, whatever the collector sent");
    assert.deepEqual(legacy.snapshots[0].inboxes!.map((i) => [i.account, i.threads.map((t) => t.subject)]), [["owner@example.com", ["", ""]]]);
    // A request from before accounts were recorded is attributed to the
    // deployment owner when the Worker next starts, not guessed on each read.
    await sql.exec("INSERT INTO inbox_actions(thread,action,requested,state,message,updated) VALUES('bbbbbbbbbb01','archive',1,'queued',NULL,1)");
    await mf.dispose();
    mf = await start(await options(path.join(dir, "worker.mjs"), dir, env));
    const restarted = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", { name: "test" });
    assert.deepEqual(await restarted.exec("SELECT thread,account FROM inbox_actions WHERE thread='bbbbbbbbbb01'"), [{ thread: "bbbbbbbbbb01", account: "owner@example.com" }]);
    const ns2 = await mf.getDurableObjectNamespace("PORTFOLIOS");
    assert.deepEqual((await (ns2.get(ns2.idFromName("test")) as unknown as Portfolio).pendingInboxActions()).map((a) => [a.threadId, a.account]), [["bbbbbbbbbb01", "owner@example.com"]], "the earlier request was reported done");
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

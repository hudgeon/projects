import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { applyInboxAction, applyInboxActions } from "../collector/inbox-actions";
import type { Inbox } from "../src/inbox-model";
import { issue } from "../tests/work-fixtures";
import { randomUUID } from "node:crypto";
import { snapshotSchema } from "../src/model";
import { start, options } from "./miniflare-fixtures";
import { closeSnapshot, inboxSnapshot, archiveSnapshot } from "./snapshot-fixtures";

test("inbox archive and unsubscribe requests need a session, name an observed thread and stay queued for the Studio", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-inbox-"));
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: path.join(dir, "worker.mjs") });
  const bearer = `Bearer ${"x".repeat(64)}`;
  const mf = await start(await options(path.join(dir, "worker.mjs"), dir, { ALLOWED_EMAILS: "owner@example.com", COLLECTOR_TOKEN: "x".repeat(64) }));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const salt = token(), value = token();
    await store.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await store.verify("owner@example.com", "123456", digest(value));
    const origin = "https://example.com";
    const signed = { Cookie: `__Host-projects=${value}`, Origin: origin };
    assert.equal((await mf.dispatchFetch(`${origin}/api/ingest`, { method: "POST", headers: { Authorization: bearer, "Content-Type": "application/json" }, body: JSON.stringify(inboxSnapshot()) })).status, 200);
    const act = (body: object, headers: Record<string, string> = signed) =>
      mf.dispatchFetch(`${origin}/api/inbox/act`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await act({ threadId: "aaaaaaaaaa01", action: "archive" }, { Cookie: signed.Cookie })).status, 403, "same-origin only");
    assert.equal((await act({ threadId: "aaaaaaaaaa01", action: "archive" }, { Authorization: bearer, Origin: origin })).status, 401, "the collector cannot request mailbox changes");
    assert.equal((await act({ threadId: "aaaaaaaaaa01", action: "delete" })).status, 400);
    assert.equal((await act({ threadId: "cccccccccc01", action: "archive" })).status, 404, "only a thread in the latest inbox read");
    // The 30-second overview never carries message text; one thread is read on demand.
    const view = await (await mf.dispatchFetch(`${origin}/api/overview`, { headers: signed })).text();
    assert.doesNotMatch(view, /PRIVATE-BODY-MARKER/);
    const read = await mf.dispatchFetch(`${origin}/api/inbox/threads/aaaaaaaaaa01`, { headers: signed });
    assert.equal(read.headers.get("Cache-Control"), "no-store");
    assert.equal(((await read.json()) as { thread: { body: string } }).thread.body, "This week: PRIVATE-BODY-MARKER");
    assert.equal((await mf.dispatchFetch(`${origin}/api/inbox/threads/aaaaaaaaaa01`, { headers: { Authorization: bearer } })).status, 401, "the collector token cannot read mail back");
    assert.equal((await mf.dispatchFetch(`${origin}/api/inbox/threads/cccccccccc01`, { headers: signed })).status, 404);
    assert.equal((await act({threadId: "aaaaaaaaaa01", action: "link"})).status, 400);
    assert.equal((await act({threadId: "aaaaaaaaaa01", action: "link", issue: 999})).status, 404);
    const linkedResponse = await act({threadId: "aaaaaaaaaa01", action: "link", issue: 7});
    assert.equal(linkedResponse.status, 200);
    const linkPending = (await store.pendingInboxActions())[0];
    assert.equal(linkPending.issue, 7);
    assert.equal((await act({threadId: "aaaaaaaaaa01", action: "archive"})).status, 404, "queued linking must finish or be withdrawn");
    const linkReport = async (issue: number) => (await mf.dispatchFetch(`${origin}/api/inbox/actions`, {method: "POST", headers: {Authorization: bearer, "Content-Type": "application/json"}, body: JSON.stringify({...linkPending, issue, state: "done", message: null})})).json();
    assert.deepEqual(await linkReport(8), {updated: false});
    assert.deepEqual(await linkReport(7), {updated: true});
    assert.equal((await act({threadId: "aaaaaaaaaa01", action: "unsubscribe"})).status, 200);
    await act({threadId: "aaaaaaaaaa01", action: "unsubscribe", cancel: true});
    // Queue, withdraw and queue again; one request per thread.
    type Actions = { actions: { threadId: string; state: string; action: string; requestedAt: number }[] };
    let actions = ((await (await act({ threadId: "aaaaaaaaaa01", action: "unsubscribe" })).json()) as Actions).actions;
    assert.deepEqual(actions.map((a) => [a.threadId, a.action, a.state]), [["aaaaaaaaaa01", "unsubscribe", "queued"]]);
    actions = ((await (await act({ threadId: "aaaaaaaaaa01", action: "unsubscribe", cancel: true })).json()) as Actions).actions;
    assert.deepEqual(actions, []);
    await act({ threadId: "aaaaaaaaaa01", action: "archive" });
    await act({ threadId: "bbbbbbbbbb01", action: "archive" });
    // Sessions cannot use the Studio's exchange; the Studio sees only queued thread IDs.
    assert.equal((await mf.dispatchFetch(`${origin}/api/inbox/actions`, { headers: { Cookie: signed.Cookie } })).status, 401);
    const pending = ((await (await mf.dispatchFetch(`${origin}/api/inbox/actions`, { headers: { Authorization: bearer } })).json()) as { actions: { threadId: string; action: string; requestedAt: number }[] }).actions;
    assert.deepEqual(pending.map((a) => [a.threadId, a.action]), [["aaaaaaaaaa01", "archive"], ["bbbbbbbbbb01", "archive"]]);
    const report = (body: object) => mf.dispatchFetch(`${origin}/api/inbox/actions`, { method: "POST", headers: { Authorization: bearer, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const done = { ...pending[0], state: "done", message: null };
    assert.equal((await report({ ...done, extra: 1 })).status, 400);
    assert.deepEqual(await (await report({ ...done, requestedAt: 1 })).json(), { updated: false });
    assert.deepEqual(await (await report(done)).json(), { updated: true });
    assert.deepEqual(await (await report(done)).json(), { updated: false }, "a report applies once");
    const overview = (await (await mf.dispatchFetch(`${origin}/api/overview`, { headers: signed })).json()) as { inboxActions: { threadId: string; state: string }[] };
    assert.deepEqual(overview.inboxActions.map((a) => [a.threadId, a.state]), [["aaaaaaaaaa01", "done"], ["bbbbbbbbbb01", "queued"]]);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("the Studio applies archive and one-click unsubscribe from its own fresh read and reports each", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-studio-inbox-"));
  const script = path.join(dir, "local.mjs");
  await build({ entryPoints: ["worker/local.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const mf = await start(await options(script, dir, { COLLECTOR_TOKEN: "x".repeat(64) }));
  try {
    const endpoint = (await mf.ready).href;
    const call = (route: string, init: RequestInit = {}) => fetch(new URL(route, endpoint), init);
    const snapshot = inboxSnapshot();
    assert.equal((await call("/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) })).status, 200);
    const request = (threadId: string, action: string) => call("/api/inbox/act", { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(endpoint).origin }, body: JSON.stringify({ threadId, action }) });
    assert.equal((await request("aaaaaaaaaa01", "unsubscribe")).status, 200);
    assert.equal((await request("bbbbbbbbbb01", "archive")).status, 200);
    const calls: string[][] = [], clicked: string[] = [];
    const gws = async (args: string[]) => {
      calls.push(args);
      if (args.includes("get"))
        return JSON.stringify({ payload: { headers: [
          { name: "List-Unsubscribe", value: "<https://news.example.com/oneclick/unsubscribe/fresh>" },
          { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        ] } });
      return "{}";
    };
    // A Gmail outage leaves both requests queued without touching the mailbox.
    await applyInboxActions(endpoint, {}, undefined, gws, async () => true);
    assert.equal(calls.length, 0);
    await applyInboxActions(endpoint, {}, snapshot.inbox as Inbox, gws, async (url) => { clicked.push(url); return true; });
    assert.deepEqual(clicked, ["https://news.example.com/oneclick/unsubscribe/fresh"], "the link comes from Gmail, not the request");
    const modified = calls.filter((args) => args.includes("modify")).map((args) => JSON.parse(args[args.indexOf("--params") + 1]).id);
    assert.deepEqual(modified.sort(), ["aaaaaaaaaa01", "bbbbbbbbbb01"]);
    assert.ok(calls.filter((args) => args.includes("modify")).every((args) => args.at(-1) === JSON.stringify({ removeLabelIds: ["INBOX"] })));
    const view = (await (await call("/api/overview")).json()) as { inboxActions: { threadId: string; state: string; message: string | null }[] };
    assert.deepEqual(view.inboxActions.map((a) => [a.threadId, a.state]), [["aaaaaaaaaa01", "done"], ["bbbbbbbbbb01", "done"]]);
    assert.deepEqual(await (await call("/api/inbox/actions")).json(), { actions: [] });
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Done on an activity never queues a mailbox archive, including after the next scan", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-activity-source-"));
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: path.join(dir, "worker.mjs")});
  const mf = await start(await options(path.join(dir, "worker.mjs"), dir, {COLLECTOR_TOKEN: "x".repeat(64)}));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const at = Date.now();
    await store.publish(snapshotSchema.parse(inboxSnapshot(at)));
    const activity = await store.createRun({requestId: randomUUID(), text: "Investigate source", projectId: null, agent: "auto", workIssue: 7, emailThread: "bbbbbbbbbb01"}, "owner@example.com");
    await store.archiveRun(activity.id, true);
    assert.deepEqual(await store.pendingInboxActions(), []);
    await store.publish(snapshotSchema.parse(inboxSnapshot(at + 1000)));
    assert.deepEqual(await store.pendingInboxActions(), []);
    await store.requestInboxAction("bbbbbbbbbb01", "archive");
    await store.archiveRun(activity.id, false);
    assert.equal((await store.pendingInboxActions()).length, 1, "reopening an activity does not undo an explicit Archive");
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});
test("the machine on duty keeps its last inbox read through a scan that could not learn it was on duty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-kept-inbox-"));
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: path.join(dir, "worker.mjs") });
  const studio = { Authorization: `Bearer ${"x".repeat(64)}` }, laptop = { Authorization: `Bearer ${"y".repeat(64)}` };
  const mf = await start(await options(path.join(dir, "worker.mjs"), dir, { COLLECTOR_TOKEN: "x".repeat(64), LAPTOP_COLLECTOR_TOKEN: "y".repeat(64) }));
  const ingest = (snapshot: object, headers: Record<string, string>) => mf.dispatchFetch("https://example.com/api/ingest", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(snapshot) });
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const inboxOf = async (host: string) => (await store.overview()).find((s) => s.host === host)?.inbox;
    const at = Date.now();
    assert.equal((await ingest(inboxSnapshot(at), studio)).status, 200);
    assert.equal((await ingest(closeSnapshot(at + 1000), studio)).status, 200);
    assert.equal((await inboxOf("studio"))?.observedAt, at, "the last read stays, with its own time");
    const old = inboxSnapshot(at + 2000);
    old.inbox.observedAt = at - 16 * 60_000;
    assert.equal((await ingest(old, studio)).status, 200);
    assert.equal((await ingest(closeSnapshot(at + 3000), studio)).status, 200);
    assert.equal(await inboxOf("studio"), undefined, "a read older than a few missed scans lapses");
    assert.equal((await ingest({ ...archiveSnapshot("laptop", at), inbox: inboxSnapshot(at).inbox }, laptop)).status, 200);
    assert.equal((await ingest(archiveSnapshot("laptop", at + 1000), laptop)).status, 200);
    assert.equal(await inboxOf("laptop"), undefined, "a machine not on duty keeps nothing");
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("the Studio leaves a thread in the inbox when someone wrote after the archive request", async () => {
  const inbox = inboxSnapshot().inbox as Inbox;
  const thread = inbox.threads[1];
  const calls: string[][] = [];
  const gws = async (args: string[]) => {
    calls.push(args);
    return "{}";
  };
  const request = { threadId: thread.id, action: "archive" as const, requestedAt: thread.updatedAt - 1 };
  assert.equal((await applyInboxAction(request, inbox, gws)).state, "failed");
  assert.equal(calls.length, 0);
  const mine = { ...inbox, threads: [{ ...thread, lastSentByMe: true }] };
  assert.equal((await applyInboxAction(request, mine, gws)).state, "done", "the user's own later reply still archives");
  assert.equal(calls.length, 1);
  // A read that missed the thread says where it is only when it is complete.
  const later = { ...request, requestedAt: thread.updatedAt + 1 };
  const missed = { ...inbox, threads: inbox.threads.filter((t) => t.id !== thread.id) };
  assert.equal((await applyInboxAction(later, { ...missed, state: "incomplete" }, gws)).state, "queued");
  assert.deepEqual(await applyInboxAction(later, missed, gws), { ...later, state: "done", message: "Already out of the inbox." });
  assert.equal(calls.length, 1, "neither touches Gmail");
});

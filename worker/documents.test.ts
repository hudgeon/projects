import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import { start, options } from "./miniflare-fixtures";
import { archiveSnapshot } from "./snapshot-fixtures";

test("HTML documents open only for the signed-in owner, come from one runner that can fetch them and are served isolated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-documents-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const collector = "c".repeat(64), runner = "r".repeat(64), laptop = "l".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", COLLECTOR_TOKEN: collector, RUNNER_TOKEN: runner, LAPTOP_RUNNER_TOKEN: laptop});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const call = (route: string, body: unknown, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const url = `https://github.com/acme/fixture/blob/${sha}/mockups/screens.html`;
  type Status = {document: {state: string; reason: string | null; bytes: number | null; content: string | null}};
  try {
    const db = await store();
    const salt = token(), value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = {Cookie: `__Host-projects=${value}`, Origin: origin};
    await db.publish(archiveSnapshot("studio"));
    const ask = (body: unknown, headers: Record<string, string> = browser) => call("/api/documents", body, headers);
    for (const headers of [{Origin: origin}, {Origin: origin, Authorization: `Bearer ${collector}`}, {Origin: origin, Authorization: `Bearer ${runner}`}] as Record<string, string>[])
      assert.equal((await ask({url}, headers)).status, 401);
    assert.equal((await ask({url}, {Cookie: browser.Cookie})).status, 403, "writes must come from the page");
    assert.equal((await mf.dispatchFetch(`${origin}/api/documents?url=${encodeURIComponent(url)}`, {headers: browser})).status, 405, "no repository or file name in a URL");
    assert.equal((await ask({url: url.replace(sha, "main")})).status, 400);
    assert.equal((await ask({url, extra: true})).status, 400);
    assert.equal((await ask({url: url.replace("acme/fixture", "acme/elsewhere")})).status, 404, "only repositories a machine reports");
    const pending = await (await ask({url})).json() as Status;
    assert.deepEqual(pending.document, {state: "pending", reason: null, bytes: null, fetchedAt: null, content: null});
    // An older runner, or one already fetching two, is never given one.
    const claim = (token: string, runnerId: string, documents?: boolean) =>
      call("/api/runner/claim", {runnerId, activeRunIds: [], lanes: ["standard", "quick"], ...(documents === undefined ? {} : {documents})}, {Authorization: `Bearer ${token}`});
    const studio = randomUUID(), other = randomUUID();
    for (const documents of [undefined, false])
      assert.equal(((await (await claim(runner, studio, documents)).json()) as {document?: unknown}).document, undefined);
    const job = ((await (await claim(runner, studio, true)).json()) as {document: {id: string; lease: string; repo: string; commit: string; path: string}}).document;
    assert.deepEqual({...job, id: undefined, lease: undefined}, {id: undefined, lease: undefined, repo: "acme/fixture", commit: sha, path: "mockups/screens.html"});
    assert.equal(((await (await claim(laptop, other, true)).json()) as {document?: unknown}).document, undefined, "one runner per request");
    const hostile = "<!doctype html><script>parent.document.title='taken';fetch('/api/overview');top.location='https://example.net'</script><p>Mockup</p>";
    const deliver = (token: string, runnerId: string, body: object) => call("/api/runner/document", {runnerId, id: job.id, lease: job.lease, ...body}, {Authorization: `Bearer ${token}`});
    const content = Buffer.from(hostile).toString("base64");
    assert.equal((await deliver(laptop, other, {content})).status, 409, "another machine cannot deliver it");
    assert.equal((await deliver(runner, other, {content})).status, 409, "nor another runner of the same machine");
    assert.equal((await call("/api/runner/document", {runnerId: studio, id: job.id, lease: job.lease, content}, {Authorization: `Bearer ${collector}`})).status, 401, "a collector token is not a runner token");
    assert.equal((await deliver(runner, studio, {content, lease: randomUUID()})).status, 409, "only this lease");
    assert.equal((await deliver(runner, studio, {content, failure: "not_found"})).status, 400);
    assert.equal((await deliver(runner, studio, {content})).status, 200);
    assert.equal((await deliver(runner, studio, {content})).status, 409, "delivered once");
    const ready = await (await ask({url})).json() as Status;
    assert.equal(ready.document.state, "ready");
    assert.equal(ready.document.bytes, Buffer.byteLength(hostile));
    assert.equal(ready.document.content, `/api/documents/${job.id}`);
    const page = await mf.dispatchFetch(origin + ready.document.content, {headers: {Cookie: browser.Cookie}});
    assert.equal(page.status, 200);
    assert.equal(await page.text(), hostile, "served as committed, never rewritten");
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
    assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-forms/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(page.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(page.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(page.headers.get("X-Frame-Options"), "SAMEORIGIN");
    for (const headers of [{}, {Authorization: `Bearer ${runner}`}, {Authorization: `Bearer ${collector}`}] as Record<string, string>[]) {
      const denied = await mf.dispatchFetch(origin + ready.document.content, {headers});
      assert.equal(denied.status, 401);
      assert.match(denied.headers.get("Content-Security-Policy") ?? "", /^sandbox /);
    }
    assert.equal((await mf.dispatchFetch(`${origin}/api/documents/${"f".repeat(64)}`, {headers: {Cookie: browser.Cookie}})).status, 404);
    const app = await mf.dispatchFetch(origin + "/api/overview", {headers: browser});
    assert.match(app.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/, "the app keeps its own policy");
    // Kept through a restart; a failure is reported plainly and can be retried.
    await mf.dispose();
    mf = await start(config);
    const deck = url.replace("mockups/screens.html", "slides/deck.html");
    assert.equal(((await (await ask({url})).json()) as Status).document.state, "ready");
    await ask({url: deck});
    // A runner with every slot busy asks without claiming.
    type Job = {document?: {id: string; lease: string}};
    const second = ((await (await call("/api/runner/document", {runnerId: studio}, {Authorization: `Bearer ${runner}`})).json()) as Job).document!;
    assert.deepEqual(await (await call("/api/runner/document", {runnerId: studio}, {Authorization: `Bearer ${runner}`})).json(), {}, "nothing else waiting");
    assert.equal((await call("/api/runner/document", {runnerId: studio, id: second.id, lease: second.lease, failure: "not_found"}, {Authorization: `Bearer ${runner}`})).status, 200);
    assert.deepEqual(((await (await ask({url: deck})).json()) as Status).document.reason, "not_found");
    assert.equal(((await (await ask({url: deck})).json()) as Status).document.state, "failed", "asking again without retry keeps the answer");
    assert.equal(((await (await ask({url: deck, retry: true})).json()) as Status).document.state, "pending");
    // Nobody takes it, or the taker never delivers: it fails instead of waiting.
    const sql = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"});
    await sql.exec("UPDATE documents SET requested=requested-61000 WHERE id=?", second.id);
    assert.equal(((await (await ask({url: deck})).json()) as Status).document.reason, "no_machine");
    await ask({url: deck, retry: true});
    const stale = ((await (await claim(runner, studio, true)).json()) as Job).document!;
    await sql.exec("UPDATE documents SET leased=leased-61000 WHERE id=?", second.id);
    const late = (body: object) => call("/api/runner/document", {runnerId: studio, id: second.id, ...body}, {Authorization: `Bearer ${runner}`});
    assert.equal((await late({lease: stale.lease, content})).status, 409, "a delivery after its lease expired is refused");
    assert.equal(((await (await ask({url: deck})).json()) as Status).document.reason, "unavailable");
    // The same runner takes the retry: its earlier lease cannot answer for it.
    await ask({url: deck, retry: true});
    const fresh = ((await (await claim(runner, studio, true)).json()) as Job).document!;
    assert.notEqual(fresh.lease, stale.lease);
    assert.equal((await late({lease: stale.lease, failure: "unavailable"})).status, 409);
    assert.equal((await late({lease: fresh.lease, content})).status, 200);
    assert.equal(((await (await ask({url: deck})).json()) as Status).document.state, "ready");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

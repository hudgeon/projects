import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Response as MockResponse } from "miniflare";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";

test("a signed-in device is woken, without content, when a conversation becomes the user's move", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-push-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const { privateKey } = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
  const runner = "r".repeat(64), collector = "c".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: collector, VAPID_PRIVATE_KEY: JSON.stringify({kty, crv, x, y, d})});
  const pushes: {host: string; auth: string; body: string}[] = [];
  let status = 201;
  config.workers![0].dev = {outboundService: {type: "fetcher", handler: async (request) => {
    pushes.push({host: new URL(request.url).hostname, auth: request.headers.get("Authorization") ?? "", body: await request.text()});
    return new MockResponse(null, {status});
  }}};
  const mf = await start(config);
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 60 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(check());
  };
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const salt = token(), value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const session = {Cookie: `__Host-projects=${value}`, Origin: origin};
    const call = (route: string, body?: object, headers: Record<string, string> = session) =>
      mf.dispatchFetch(origin + route, body ? {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)} : {headers});
    const events = async () => ((await (await call("/api/push/events")).json()) as {events: {title: string; body: string; url: string}[]}).events;
    assert.equal((await call("/api/push/key", undefined, {})).status, 401);
    assert.equal((await call("/api/push/key", undefined, {Authorization: `Bearer ${collector}`})).status, 401, "the collector cannot reach notifications");
    const {key} = (await (await call("/api/push/key")).json()) as {key: string};
    assert.match(key, /^B[A-Za-z0-9_-]{86}$/);
    assert.equal((await call("/api/push/subscribe", {endpoint: "https://evil.example/push"})).status, 400, "only browser push services");
    assert.equal((await call("/api/push/subscribe", {endpoint: "https://web.push.apple.com/QGc2V0LXRva2Vu"}, {Cookie: session.Cookie})).status, 403, "same-origin only");
    const endpoint = "https://web.push.apple.com/QGc2V0LXRva2Vu";
    assert.equal((await call("/api/push/subscribe", {endpoint})).status, 200);
    await waitFor(() => pushes.length === 1);
    assert.deepEqual([pushes[0].host, pushes[0].body], ["web.push.apple.com", ""], "the push carries nothing");
    assert.match(pushes[0].auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);
    assert.deepEqual((await events()).map((e) => [e.title, e.url]), [["Notifications are on", "/"]]);
    assert.equal((await call("/api/push/subscribe", {endpoint})).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pushes.length, 1, "opening Projects again sends no second test");
    const finish = async (text: string) => {
      await db.createRun({requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null});
      const owner = randomUUID();
      const run = (await db.claimRun(owner, [], undefined, "studio"))!;
      const report = (progress: Progress) => mf.dispatchFetch(origin + "/api/runner/report", {
        method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"},
        body: JSON.stringify({runnerId: owner, id: run.id, generation: run.generation, progress}),
      });
      const running: Progress = {seq: 1, state: "running", title: "Reply to Rob about training", summary: "Asked Codex to draft it.", children: [], masterSessionId: null};
      assert.equal((await report(running)).status, 200);
      assert.equal((await report({...running, seq: 2, state: "completed", reviewedMessageIds: [run.id], summary: "Drafted the reply to Rob. **Your move:** send it."})).status, 200);
      return run.id;
    };
    const id = await finish("Reply to Rob");
    await waitFor(() => pushes.length === 2);
    assert.deepEqual((await events())[0], {...(await events())[0], title: "Ready: Reply to Rob about training", body: "Drafted the reply to Rob.", url: `/?run=${id}`});
    // A subscription the browser dropped is forgotten after one attempt.
    status = 410;
    await finish("Reply to Ben");
    await waitFor(() => pushes.length === 3);
    status = 201;
    await finish("Reply to Phil");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pushes.length, 3);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

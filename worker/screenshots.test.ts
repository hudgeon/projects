import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Run, RunInput } from "../src/run-model";
import { decodeScreenshots, SCREENSHOT_BYTES } from "../src/screenshot-model";
import { start, options } from "./miniflare-fixtures";
import { archiveSnapshot } from "./snapshot-fixtures";

const screenshotPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";

test("screenshots remain private, immutable and durable across retries and feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-screenshots-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), collector = "c".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: collector});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  try {
    let db = await store();
    const salt = token(), value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = {Cookie: `__Host-projects=${value}`, Origin: origin};
    for (const headers of [{}, browser, {Authorization: `Bearer ${collector}`}])
      assert.equal((await mf.dispatchFetch(origin + '/api/runner/readiness', {headers})).status, 401);
    const readiness = await mf.dispatchFetch(origin + '/api/runner/readiness', {headers: {Authorization: `Bearer ${runner}`}});
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), {ready: true, worker: 'local', portfolio: 'local', conversation: 'local'});
    assert.equal((await db.listRuns()).length, 0, 'the readiness probe cannot create a conversation');
    await db.publish(archiveSnapshot("studio"));
    const image = {id: randomUUID(), mime: "image/png" as const, data: screenshotPng};
    const input: RunInput = {requestId: randomUUID(), text: "Inspect the screenshot", projectId: null, agent: "auto", workIssue: null, screenshots: [image]};
    const post = (route: string, body: unknown, headers: Record<string, string> = browser) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
    assert.equal((await post("/api/runs", input, {Cookie: browser.Cookie})).status, 403);
    const malformed = {...input, requestId: randomUUID(), screenshots: [{...image, data: Buffer.from("<svg onload='bad'>").toString("base64")}]};
    assert.equal((await post("/api/runs", malformed)).status, 409);
    const response = await post("/api/runs", input);
    assert.equal(response.status, 200, "an invalid upload cannot poison the durable creation queue");
    const {run} = await response.json() as {run: Run};
    assert.equal(run.messages[0].screenshots?.[0].width, 1);
    assert.doesNotMatch(JSON.stringify(run), /iVBOR|"data"/);
    assert.deepEqual(await (await post("/api/runs", input)).json(), {run});
    const imageRoute = `/api/runs/${run.id}/screenshots/${image.id}`;
    for (const headers of [{}, {Authorization: `Bearer ${runner}`}, {Authorization: `Bearer ${collector}`}])
      assert.equal((await mf.dispatchFetch(origin + imageRoute, {headers})).status, 401);
    let saved = await mf.dispatchFetch(origin + imageRoute, {headers: browser});
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("Cache-Control"), "no-store");
    assert.equal(saved.headers.get("Content-Type"), "image/png");
    assert.equal(Buffer.from(await saved.arrayBuffer()).toString("base64"), image.data);
    const owner = randomUUID();
    const runnerHeaders = {Authorization: `Bearer ${runner}`};
    const request = {runnerId: owner, id: run.id, generation: 1, screenshotId: image.id};
    assert.equal((await post("/api/runner/screenshot", request, runnerHeaders)).status, 404);
    await db.claimRun(owner, [], undefined, "studio");
    assert.equal((await post("/api/runner/screenshot", {...request, runnerId: randomUUID()}, runnerHeaders)).status, 404);
    assert.equal((await post("/api/runner/screenshot", {...request, generation: 2}, runnerHeaders)).status, 404);
    assert.equal((await post("/api/runner/screenshot", request, browser)).status, 401);
    assert.deepEqual(await (await post("/api/runner/screenshot", request, runnerHeaders)).json(), {screenshot: image});
    const follow = {requestId: randomUUID(), text: "Also inspect this", screenshots: [{...image, id: randomUUID()}]};
    assert.equal((await post(`/api/runs/${run.id}/message`, follow)).status, 200);
    assert.equal((await post(`/api/runs/${run.id}/message`, follow)).status, 200);
    const before = await db.getRun(run.id);
    assert.equal(before?.messages.length, 2);
    assert.equal(before?.generation, 1);
    assert.equal((await post(`/api/runs/${run.id}/message`, {...follow, requestId: randomUUID()})).status, 409, "another message cannot overwrite a bound image ID");
    assert.equal((await db.getRun(run.id))?.messages.length, 2, "image and message writes roll back together");
    assert.doesNotMatch(JSON.stringify(await db.overview()), /iVBOR|screenshots|sha256/);
    await mf.dispose(); mf = await start(config); db = await store();
    saved = await mf.dispatchFetch(origin + imageRoute, {headers: browser});
    assert.equal(Buffer.from(await saved.arrayBuffer()).toString("base64"), image.data);
    assert.equal((await db.getRun(run.id))?.messages.length, 2);
    await db.reportRun(owner, run.id, 1, {seq: 1, state: "completed", summary: "Verified", children: [], masterSessionId: randomUUID(), reviewedMessageIds: [input.requestId, follow.requestId]}, "studio");
    assert.equal((await post("/api/runner/screenshot", request, runnerHeaders)).status, 404, "a completed claim cannot keep fetching images");
    assert.equal((await mf.dispatchFetch(origin + imageRoute, {headers: browser})).status, 200);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("screenshot validation bounds formats, bytes, dimensions and duplicate IDs", async () => {
  const image = {id: randomUUID(), mime: "image/png" as const, data: screenshotPng};
  const [decoded] = await decodeScreenshots([image]);
  assert.equal(decoded.metadata.bytes, Buffer.from(screenshotPng, "base64").length);
  await assert.rejects(decodeScreenshots([image, image]));
  await assert.rejects(decodeScreenshots([{...image, mime: "image/jpeg"}]));
  await assert.rejects(decodeScreenshots([{...image, data: Buffer.alloc(SCREENSHOT_BYTES + 1).toString("base64")}]));
  const huge = Buffer.from(screenshotPng, "base64"); huge.writeUInt32BE(99999, 16);
  await assert.rejects(decodeScreenshots([{...image, data: huge.toString("base64")}]), /valid PNG or JPEG/);
});

test("a mixed object rollout rejects image writes before queueing or changing a conversation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'projects-runtime-'));
  const script = path.join(dir, 'worker.mjs');
  await build({stdin: {contents: `import worker, {Portfolio as BasePortfolio} from './worker/index.ts'; export {Conversation} from './worker/index.ts'; export default worker; export class Portfolio extends BasePortfolio { async runtimeVersions() { return {portfolio: 'old', conversation: 'old'}; } }`, resolveDir: process.cwd(), loader: 'ts'}, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'], outfile: script});
  const runner = 'r'.repeat(64), origin = 'https://example.com';
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: 'owner@example.com', RUNNER_TOKEN: runner}));
  try {
    const ns = await mf.getDurableObjectNamespace('PORTFOLIOS');
    const db = ns.get(ns.idFromName('test')) as unknown as Portfolio;
    const salt = token(), value = token();
    await db.issue('owner@example.com', salt, digest(`${salt}:123456`));
    await db.verify('owner@example.com', '123456', digest(value));
    await db.publish(archiveSnapshot('studio'));
    const input = {requestId: randomUUID(), text: 'Inspect screenshot', projectId: null, agent: 'auto', workIssue: null, screenshots: [{id: randomUUID(), mime: 'image/png', data: screenshotPng}]};
    const post = (route: string, body: unknown) => mf.dispatchFetch(origin + route, {method: 'POST', headers: {Cookie: `__Host-projects=${value}`, Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const rejected = await post('/api/runs', input);
    assert.equal(rejected.status, 503);
    assert.match(await rejected.text(), /still in the draft/);
    assert.equal(await db.getRun(input.requestId), null);
    assert.equal((await post('/api/runs', {...input, screenshots: []})).status, 200);
    assert.equal((await post(`/api/runs/${input.requestId}/message`, {requestId: randomUUID(), text: 'Feedback', screenshots: input.screenshots})).status, 503);
    assert.equal((await db.getRun(input.requestId))?.messages.length, 1);
    assert.equal((await mf.dispatchFetch(origin + '/api/runner/readiness', {headers: {Authorization: `Bearer ${runner}`}})).status, 503);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

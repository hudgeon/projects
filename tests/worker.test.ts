import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  Miniflare,
  Response as MockResponse,
  type MiniflareOptions,
} from "miniflare";
import { digest, token } from "../worker/auth";
import type { Portfolio, Conversation } from "../worker";
import type { Close } from "../src/work-model";
import { applyCloses } from "../collector/close";
import { applyInboxAction, applyInboxActions } from "../collector/inbox-actions";
import type { Inbox } from "../src/inbox-model";
import { issue } from "./work-fixtures";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Progress, type Run, type RunInput } from "../src/run-model";
import type { TelemetryFields } from "../src/telemetry";
import { snapshotSchema, type Snapshot, type PortfolioView } from "../src/model";
import { sessionArchived } from "../src/archive-model";
import { decodeScreenshots, SCREENSHOT_BYTES } from "../src/screenshot-model";

const screenshotPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";

test("conversation browsers isolate claims, preserve WebSockets and clean up paid sessions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-browser-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/browser-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), collector = "c".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {RUNNER_TOKEN: runner, COLLECTOR_TOKEN: collector, ALLOWED_EMAILS: "owner@example.com"});
  let mf = await start(config);
  type BrowserTest = Conversation & {
    inspectProvider(): Promise<{acquisitions: number; closed: number; closeAttempts: number; options: BrowserRunAcquireOptions; view: BrowserRunLiveViewOptions}>;
    failProvider(operation: string, enabled?: boolean): Promise<void>;
    expireBrowser(): Promise<void>;
    retryCleanup(): Promise<void>;
    triggerAlarm(): Promise<void>;
  };
  const getStore = async () => {const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio;};
  const getConversation = async (id: string) => {const ns = await mf.getDurableObjectNamespace("CONVERSATIONS"); return ns.get(ns.idFromName(JSON.stringify(["test", id]))) as unknown as BrowserTest;};
  try {
    let db = await getStore();
    const salt = token(), cookie = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(cookie));
    const user = {Cookie: `__Host-projects=${cookie}`, Origin: origin};
    const post = (route: string, body: unknown, headers: Record<string, string> = {Authorization: `Bearer ${runner}`}) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
    const run = await db.createRun({requestId: randomUUID(), text: "Check the page", projectId: null, agent: "auto", workIssue: null});
    const runId = run.id;
    const owner = randomUUID(), claim = {runnerId: owner, id: runId, generation: 1};
    let conversation = await getConversation(runId);
    for (const headers of [{}, user, {Authorization: `Bearer ${collector}`}] as Record<string, string>[])
      assert.equal((await post("/api/runner/browser", claim, headers)).status, 401);
    assert.equal((await post("/api/runner/browser", claim)).status, 409);
    await db.claimRun(owner, [], undefined, "studio");
    assert.equal((await post("/api/runner/browser", {...claim, runnerId: randomUUID()})).status, 409);
    assert.equal((await post("/api/runner/browser", {...claim, generation: 2})).status, 409);
    const grant = await (await post("/api/runner/browser", claim)).json() as {capability: string};
    assert.ok(grant.capability);
    assert.equal((await conversation.inspectProvider()).acquisitions, null, "granting access does not buy a browser");
    const connect = (id = runId, bearer = grant.capability) => mf.dispatchFetch(`${origin}/api/browser/${id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${bearer}`}});
    for (const bearer of ["", runner, collector, `${grant.capability}tampered`]) assert.equal((await connect(runId, bearer)).status, 403);
    assert.equal((await connect(randomUUID())).status, 403, "capability cannot cross conversations");
    const responses = await Promise.all([connect(), connect()]);
    for (const response of responses) {
      assert.equal(response.status, 101);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.ok(response.headers.get("X-Projects-Request-Id"));
      const socket = response.webSocket!; socket.accept();
      const echoed = new Promise<string>(resolve => socket.addEventListener("message", e => resolve(String(e.data)), {once: true}));
      socket.send("CDP passthrough"); assert.equal(await echoed, "CDP passthrough"); socket.close();
    }
    let provider = await conversation.inspectProvider();
    assert.equal(provider.acquisitions, 1, "concurrent connections use one paid session");
    assert.deepEqual(provider.options, {keepAlive: 300000, recording: false, guardrails: {allowedDomains: ["projects.example.com", "mockups.example.net"]}});
    const browserRoute = `/api/runs/${runId}/browser`;
    for (const headers of [{}, {Authorization: `Bearer ${runner}`}, {Authorization: `Bearer ${collector}`}])
      assert.equal((await mf.dispatchFetch(origin + browserRoute, {headers})).status, 401);
    assert.equal((await post(browserRoute + "/view", {readonly: true}, {Cookie: user.Cookie})).status, 403);
    assert.equal((await post(browserRoute + "/view", {readonly: true}, user)).status, 200);
    provider = await conversation.inspectProvider(); assert.deepEqual(provider.view.guardrails, {mode: "readonly"});
    await db.reportRun(owner, runId, 1, {seq: 1, state: "blocked", summary: "Sign in", children: [], masterSessionId: null, reviewedMessageIds: [runId]}, "studio");
    assert.equal((await connect()).status, 403);
    assert.equal((await post(browserRoute + "/view", {readonly: false}, user)).status, 200, "normal sign-in is available during a bounded pause");
    await mf.dispose(); mf = await start(config); db = await getStore(); conversation = await getConversation(runId);
    assert.equal((await conversation.browserStatus()).state, "ready", "ownership survives an eviction");
    await db.messageRun(runId, {requestId: randomUUID(), text: "Signed in"}); await db.claimRun(owner, [], undefined, "studio");
    assert.equal((await connect()).status, 403, "old generation is revoked");
    const nextGrant = await (await post("/api/runner/browser", {...claim, generation: 2})).json() as {capability: string};
    const resumed = await connect(runId, nextGrant.capability); assert.equal(resumed.status, 101); resumed.webSocket!.accept(); resumed.webSocket!.close();
    assert.equal((await conversation.inspectProvider()).acquisitions, 1, "sign-in browser is reused only by the same conversation");
    await conversation.failProvider("failClose");
    await db.cancelRun(runId);
    assert.equal((await connect(runId, nextGrant.capability)).status, 403);
    await assert.doesNotReject(conversation.triggerAlarm(), "failed browser cleanup cannot stop progress/health alarms");
    assert.equal((await conversation.inspectProvider()).acquisitions, 1);
    const attempts = (await conversation.inspectProvider()).closeAttempts;
    await conversation.triggerAlarm();
    assert.equal((await conversation.browserStatus()).state, "closing");
    assert.equal((await conversation.inspectProvider()).closeAttempts, attempts, "polls and alarms respect the persisted cleanup backoff");
    await conversation.failProvider("failClose", false);
    await conversation.retryCleanup();
    await conversation.triggerAlarm();
    assert.equal((await conversation.inspectProvider()).closed, 1, "a failed close remains retryable after the claim ends");
    assert.equal((await conversation.browserStatus()).state, "idle");
    const second = await db.createRun({requestId: randomUUID(), text: "Another browser", projectId: null, agent: "auto", workIssue: null});
    const secondOwner = randomUUID(); await db.claimRun(secondOwner, [], undefined, "studio");
    const secondConversation = await getConversation(second.id);
    await secondConversation.failProvider("failAcquire");
    const secondGrant = await (await post("/api/runner/browser", {runnerId: secondOwner, id: second.id, generation: 1})).json() as {capability: string};
    assert.equal((await connect(second.id, secondGrant.capability)).status, 503);
    assert.equal((await connect(second.id, secondGrant.capability)).status, 503);
    assert.equal((await secondConversation.inspectProvider()).acquisitions, 1, "unknown launches cannot accumulate paid orphan browsers");
    await secondConversation.expireBrowser(); await secondConversation.triggerAlarm();
    const replacement = await connect(second.id, secondGrant.capability); assert.equal(replacement.status, 101); replacement.webSocket!.accept(); replacement.webSocket!.close();
    assert.equal((await secondConversation.inspectProvider()).acquisitions, 2);
    await secondConversation.expireBrowser(); await secondConversation.triggerAlarm();
    assert.equal((await secondConversation.inspectProvider()).closed, 1, "hard deadline closes even an active conversation's browser");
    const expired = await connect(second.id, secondGrant.capability); assert.equal(expired.status, 101); expired.webSocket!.accept(); expired.webSocket!.close();
    await secondConversation.failProvider("failLookup");
    assert.equal((await mf.dispatchFetch(origin + `/api/runs/${second.id}/browser`, {headers: user})).status, 503, "authorization errors must not be mistaken for an expired browser");
    await secondConversation.failProvider("failLookup", false);
    await secondConversation.failProvider("missingSession");
    assert.equal((await secondConversation.browserStatus()).state, "idle", "the live provider's exact expired-session 404 is an absent browser");
    await secondConversation.failProvider("missingSession", false);
    const cleanup = await connect(second.id, secondGrant.capability); assert.equal(cleanup.status, 101); cleanup.webSocket!.accept(); cleanup.webSocket!.close();
    await secondConversation.failProvider("missingSession");
    await secondConversation.expireBrowser();
    await secondConversation.triggerAlarm();
    assert.equal((await secondConversation.browserStatus()).state, "idle", "expired paid sessions clear on cleanup without an endless retry");
    assert.equal((await secondConversation.inspectProvider()).closed, 1, "already absent sessions need no provider close");
    assert.doesNotMatch(JSON.stringify(await db.getRun(second.id)), /capability|provider-|private-view-token/);
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});

test("a machine the deployment signs in gets each conversation browser signed in, within limits, until it ends", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-browser-sign-in-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/browser-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), laptop = "l".repeat(64), origin = "https://projects.example.com";
  const values = {RUNNER_TOKEN: runner, LAPTOP_RUNNER_TOKEN: laptop, ALLOWED_EMAILS: "owner@example.com", OWNER_EMAIL: "Owner@Example.com", SITE_URL: origin, BROWSER_SIGN_IN: "studio"};
  let config = await options(script, dir, values);
  let mf = await start(config);
  type SignIn = {session: string; cookies: {name: string; value: string; url: string; path: string; secure: boolean; httpOnly: boolean; sameSite: string; expires: number}[]};
  type BrowserTest = Conversation & {
    inspectProvider(): Promise<{acquisitions: number; signIns: SignIn[] | null}>;
    failProvider(operation: string, enabled?: boolean): Promise<void>;
    expireBrowser(): Promise<void>;
    triggerAlarm(): Promise<void>;
  };
  const getStore = async () => {const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio;};
  const getConversation = async (id: string) => {const ns = await mf.getDurableObjectNamespace("CONVERSATIONS"); return ns.get(ns.idFromName(JSON.stringify(["test", id]))) as unknown as BrowserTest;};
  const post = (route: string, body: unknown, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", Origin: origin, ...headers}, body: JSON.stringify(body)});
  const as = (value: string) => ({Cookie: `__Host-projects=${value}`});
  const overview = async (value: string) => (await mf.dispatchFetch(origin + "/api/overview", {headers: as(value)})).status;
  // Claims a new conversation on a machine and opens its browser, as a runner does.
  const open = async (bearer: string, runnerId = randomUUID()) => {
    const db = await getStore();
    const run = await db.createRun({requestId: randomUUID(), text: "Check the page", projectId: null, agent: "auto", workIssue: null});
    assert.ok((await (await post("/api/runner/claim", {runnerId, activeRunIds: []}, {Authorization: `Bearer ${bearer}`})).json() as {run: Run | null}).run);
    const grant = await (await post("/api/runner/browser", {runnerId, id: run.id, generation: 1}, {Authorization: `Bearer ${bearer}`})).json() as {capability: string};
    const connection = await mf.dispatchFetch(`${origin}/api/browser/${run.id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${grant.capability}`}});
    assert.equal(connection.status, 101);
    connection.webSocket!.accept(); connection.webSocket!.close();
    // Values only: RPC results are stubs a restart poisons.
    return {id: run.id, grant: {capability: grant.capability}, conversation: await getConversation(run.id)};
  };
  const cookieOf = async (conversation: BrowserTest) => (await conversation.inspectProvider()).signIns?.at(-1)?.cookies[0];
  try {
    // Another machine's browsers still sign in by hand. (It claims first: new
    // work goes to the first machine in order that has called recently.)
    const other = await open(laptop);
    assert.equal((await other.conversation.inspectProvider()).signIns, null);
    const before = Date.now();
    const first = await open(runner);
    const cookie = (await cookieOf(first.conversation))!;
    assert.deepEqual({...cookie, value: "", expires: 0}, {name: "__Host-projects", value: "", url: origin, path: "/", secure: true, httpOnly: true, sameSite: "Strict", expires: 0}, "a host-only cookie like the site's own");
    assert.match(cookie.value, /^[a-f0-9]{64}$/);
    assert.ok(cookie.expires * 1000 <= before + 30 * 60_000 + 1000, "it ends with the browser");
    assert.doesNotMatch(JSON.stringify([first.grant, await (await getStore()).getRun(first.id)]), new RegExp(cookie.value), "the runner never receives it");
    assert.equal(await overview(cookie.value), 200, "the browser sees Projects as the owner");
    const machines = await (await mf.dispatchFetch(origin + "/api/machines", {headers: as(cookie.value)})).json() as {machines: {id: string; browserSignIn?: boolean}[]};
    assert.deepEqual(machines.machines.map((m) => [m.id, m.browserSignIn]), [["studio", true], ["laptop", false]]);
    // What outlives the browser or reaches beyond it stays with the owner's own sign-in.
    for (const [route, body] of [["/api/machines", {name: "Spare"}], ["/api/machines/laptop/tokens", {}], ["/api/machines/laptop/remove", {}], ["/api/execution-settings", {fast: true}], [`/api/runs/${first.id}/browser/view`, {readonly: false}], ["/api/inbox/act", {}], ["/api/push/subscribe", {endpoint: "https://fcm.googleapis.com/x"}]] as const)
      assert.equal((await post(route, body, as(cookie.value))).status, 403, route);
    assert.equal((await mf.dispatchFetch(origin + "/api/inbox/threads/abcdef1234", {headers: as(cookie.value)})).status, 403, "email text never reaches it");
    // A runner restart or eviction keeps the same browser and its sign-in.
    await mf.dispose(); mf = await start(config);
    assert.equal(await overview(cookie.value), 200);
    // A replacement browser gets a fresh sign-in; the old one ends with its browser.
    const conversation = await getConversation(first.id);
    await conversation.expireBrowser(); await conversation.triggerAlarm();
    assert.equal(await overview(cookie.value), 401, "a closed browser's sign-in is revoked");
    const again = await mf.dispatchFetch(`${origin}/api/browser/${first.id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${first.grant.capability}`}});
    assert.equal(again.status, 101); again.webSocket!.accept(); again.webSocket!.close();
    const renewed = (await cookieOf(conversation))!;
    assert.notEqual(renewed.value, cookie.value);
    assert.equal(await overview(renewed.value), 200);
    // The claim ending closes the browser and signs it out.
    await (await getStore()).cancelRun(first.id); await conversation.triggerAlarm();
    assert.equal(await overview(renewed.value), 401);
    // A refused cookie leaves the browser usable and signed out.
    const refusedRun = await (await getStore()).createRun({requestId: randomUUID(), text: "Refused", projectId: null, agent: "auto", workIssue: null});
    const refusedConversation = await getConversation(refusedRun.id);
    await refusedConversation.failProvider("failSignIn");
    const refusedOwner = randomUUID();
    await post("/api/runner/claim", {runnerId: refusedOwner, activeRunIds: []}, {Authorization: `Bearer ${runner}`});
    const refusedGrant = await (await post("/api/runner/browser", {runnerId: refusedOwner, id: refusedRun.id, generation: 1}, {Authorization: `Bearer ${runner}`})).json() as {capability: string};
    const refused = await mf.dispatchFetch(`${origin}/api/browser/${refusedRun.id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${refusedGrant.capability}`}});
    assert.equal(refused.status, 101); refused.webSocket!.accept(); refused.webSocket!.close();
    assert.equal(await overview((await cookieOf(refusedConversation))!.value), 401);
    // A browser the provider ended on its own is signed out at the next check.
    const idle = await open(runner), ended = (await cookieOf(idle.conversation))!;
    assert.equal(await overview(ended.value), 200);
    await (idle.conversation as unknown as {endProviderSession(): Promise<void>}).endProviderSession();
    await idle.conversation.triggerAlarm();
    assert.equal(await overview(ended.value), 401, "no sign-in outlives its browser");
    await (await getStore()).cancelRun(idle.id); await idle.conversation.triggerAlarm();
    // Continuing the conversation on another machine keeps the browser, not its sign-in.
    const moving = await open(runner), moved = (await cookieOf(moving.conversation))!;
    assert.equal(await overview(moved.value), 200);
    await (moving.conversation as unknown as {move(id: string, from: string): Promise<unknown>}).move(moving.id, "studio");
    await moving.conversation.triggerAlarm();
    assert.equal(await overview(moved.value), 401, "another machine never inherits it");
    assert.equal((await moving.conversation.browserStatus()).state, "ready");
    await (await getStore()).cancelRun(moving.id); await moving.conversation.triggerAlarm();
    // Sign out ends it at once.
    const signedOut = (await cookieOf((await open(runner)).conversation))!;
    assert.equal((await post("/api/auth/logout", {}, as(signedOut.value))).status, 200);
    assert.equal(await overview(signedOut.value), 401);
    // Leaving the deployment's list, or removing the machine, fails closed.
    const listed = (await cookieOf((await open(runner)).conversation))!;
    assert.equal(await overview(listed.value), 200);
    await mf.dispose(); config = await options(script, dir, {...values, BROWSER_SIGN_IN: ""}); mf = await start(config);
    await mf.dispose(); config = await options(script, dir, values); mf = await start(config);
    assert.equal(await overview(listed.value), 401, "a deployment that stops signing a machine in revokes its browsers for good");
    const kept = (await cookieOf((await open(runner)).conversation))!;
    const salt = token(), owner = token(), db = await getStore();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(owner));
    assert.equal((await post("/api/machines/studio/remove", {}, as(owner))).status, 200);
    assert.equal(await overview(kept.value), 401, "a removed machine's browsers are signed out");
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});

test("a conversation browser signs in only as an allowed owner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-browser-owner-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/browser-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), origin = "https://projects.example.com";
  const mf = await start(await options(script, dir, {RUNNER_TOKEN: runner, ALLOWED_EMAILS: "owner@example.com", OWNER_EMAIL: "former@example.com", SITE_URL: origin, BROWSER_SIGN_IN: "studio"}));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"), db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const run = await db.createRun({requestId: randomUUID(), text: "Check the page", projectId: null, agent: "auto", workIssue: null});
    const runnerId = randomUUID(), bearer = {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"};
    await mf.dispatchFetch(origin + "/api/runner/claim", {method: "POST", headers: bearer, body: JSON.stringify({runnerId, activeRunIds: []})});
    const grant = await (await mf.dispatchFetch(origin + "/api/runner/browser", {method: "POST", headers: bearer, body: JSON.stringify({runnerId, id: run.id, generation: 1})})).json() as {capability: string};
    const connection = await mf.dispatchFetch(`${origin}/api/browser/${run.id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${grant.capability}`}});
    assert.equal(connection.status, 101); connection.webSocket!.accept(); connection.webSocket!.close();
    const cns = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const conversation = cns.get(cns.idFromName(JSON.stringify(["test", run.id]))) as unknown as {inspectProvider(): Promise<{signIns: unknown}>};
    assert.equal((await conversation.inspectProvider()).signIns, null, "no cookie for an owner the allowlist no longer names");
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});

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

test("OTP consumption is atomic, capped, persisted and logout revokes access", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-login-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir, {
    ALLOWED_EMAILS: "owner@example.com",
    COLLECTOR_TOKEN: "x".repeat(64),
  });
  let mf = await start(config);
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const email = "owner@example.com",
      salt = token(),
      code = "123456";
    assert.equal(
      await store.issue(email, salt, digest(`${salt}:${code}`)),
      true,
    );
    assert.equal(await store.issue(email, token(), "replacement"), false);
    const verify = () =>
      mf.dispatchFetch("https://example.com/api/auth/verify", {
        method: "POST",
        headers: {
          Origin: "https://example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, code }),
      });
    const results = await Promise.all([verify(), verify()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    const signed = results
      .find((r) => r.status === 200)!
      .headers.get("Set-Cookie")!;
    assert.match(signed, /__Host-projects=.*Secure; HttpOnly; SameSite=Strict/);
    const session = signed.split(";")[0];
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: session },
        })
      ).status,
      200,
    );
    // A browser session cannot publish snapshots.
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/ingest", {
          method: "POST",
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
    await mf.dispose();
    mf = await start(config);
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: session },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/auth/logout", {
          method: "POST",
          headers: { Cookie: session, Origin: "https://example.com" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
    const ns2 = await mf.getDurableObjectNamespace("PORTFOLIOS"),
      store2 = ns2.get(ns2.idFromName("test")) as unknown as Portfolio;
    await store2.issue(email, salt, digest(`${salt}:${code}`));
    for (let i = 0; i < 5; i++)
      assert.equal(await store2.verify(email, "000000", token()), false);
    assert.equal(await store2.verify(email, code, token()), false);
    assert.equal(await store2.rate("test-rate", 1, 60000), true);
    assert.equal(await store2.rate("test-rate", 1, 60000), false);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Portfolio",
      { name: "test" },
    );
    await storage.exec("UPDATE codes SET expires=?,attempts=0", Date.now() - 1);
    assert.equal(await store2.verify(email, code, token()), false);
    const expired = token();
    await storage.exec(
      "INSERT INTO sessions(hash,email,expires) VALUES(?,?,?)",
      digest(expired),
      email,
      Date.now() - 1,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: `__Host-projects=${expired}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/auth/request", {
          method: "POST",
          headers: {
            Origin: "https://example.com",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: "outsider@example.com" }),
        })
      ).status,
      200,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// Machines a test connects with known tokens, registered as the site would:
// the first on duty, its runner IDs its conversations' owners.
type TestMachine = { id: string; collector?: string; runner?: string; plainOwner: boolean };
const connecting = new WeakMap<MiniflareOptions, TestMachine[]>();
async function start(config: MiniflareOptions): Promise<Miniflare> {
  const mf = new Miniflare(config);
  const machines = connecting.get(config) ?? [];
  if (machines.length) {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    await (ns.get(ns.idFromName("test")) as unknown as Portfolio).runnable();
    const sql = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", { name: "test" });
    for (const [position, m] of machines.entries())
      await sql.exec(
        "INSERT INTO machines(id,name,position,collector_hash,runner_hash,plain_owner,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        m.id, m.id[0].toUpperCase() + m.id.slice(1), position,
        m.collector ? digest(m.collector) : null, m.runner ? digest(m.runner) : null,
        m.plainOwner ? 1 : 0, Date.now(),
      );
  }
  return mf;
}
async function options(
  script: string,
  dir: string,
  all: Record<string, string> = {},
): Promise<MiniflareOptions> {
  const { COLLECTOR_TOKEN, RUNNER_TOKEN, LAPTOP_COLLECTOR_TOKEN, LAPTOP_RUNNER_TOKEN, ...values } = all;
  const machines: TestMachine[] = [
    ...(COLLECTOR_TOKEN || RUNNER_TOKEN ? [{ id: "studio", collector: COLLECTOR_TOKEN, runner: RUNNER_TOKEN, plainOwner: true }] : []),
    ...(LAPTOP_COLLECTOR_TOKEN || LAPTOP_RUNNER_TOKEN ? [{ id: "laptop", collector: LAPTOP_COLLECTOR_TOKEN, runner: LAPTOP_RUNNER_TOKEN, plainOwner: false }] : []),
  ];
  const config: MiniflareOptions = {
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: path.join(dir, "state"),
    workers: [
      {
        config: {
          name: "test",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: await readFile(script, "utf8"),
              },
            },
          },
          env: {
            PORTFOLIO_ID: { type: "text", value: "test" },
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                key,
                { type: "text" as const, value },
              ]),
            ),
            CONVERSATIONS: {
              type: "durable-object",
              worker: "test",
              exportName: "Conversation",
            },
            PORTFOLIOS: {
              type: "durable-object",
              worker: "test",
              exportName: "Portfolio",
            },
          },
          exports: {
            Portfolio: { type: "durable-object", storage: "sqlite" },
            Conversation: { type: "durable-object", storage: "sqlite" },
          },
        },
      },
    ],
  };
  connecting.set(config, machines);
  return config;
}

test("machines join from the site; each token acts only as its machine, in the owner's order, until replaced or removed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-machines-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const origin = "https://example.com";
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com"}));
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const bearer = (value: string) => ({Authorization: `Bearer ${value}`});
  const post = (route: string, body: unknown, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  const get = (route: string, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {headers});
  type Added = {machine: string; tokens: {collector: string; runner: string}; machines: {id: string; name: string; duties: boolean}[]};
  const snapshot = (host: string, at = Date.now()) => ({version: 1, host, collectedAt: at, projects: [], unassignedSessions: []});
  const claim = async (token: string, runnerId: string) => {
    const response = await post("/api/runner/claim", {runnerId, activeRunIds: []}, bearer(token));
    assert.equal(response.status, 200);
    return (await response.json() as {run: Run | null}).run;
  };
  try {
    const salt = token(), cookie = token();
    await (await store()).issue("owner@example.com", salt, digest(`${salt}:123456`));
    await (await store()).verify("owner@example.com", "123456", digest(cookie));
    const owner = {Cookie: `__Host-projects=${cookie}`, Origin: origin};
    assert.deepEqual(((await (await get("/api/machines", owner)).json()) as {machines: unknown[]}).machines, []);
    assert.equal((await post("/api/runs", {requestId: randomUUID(), text: "Too early", projectId: null, agent: "auto", workIssue: null}, owner)).status, 503, "conversations wait for a machine");
    const studio = (await (await post("/api/machines", {name: "Studio"}, owner)).json()) as Added;
    const laptop = (await (await post("/api/machines", {name: "Laptop"}, owner)).json()) as Added;
    assert.deepEqual([studio.machine, laptop.machine], ["studio", "laptop"]);
    assert.deepEqual(laptop.machines.map((m) => m.name), ["Studio", "Laptop"]);
    assert.equal(((await (await post("/api/machines", {name: "Studio"}, owner)).json()) as Added).machine, "studio-2", "names repeat; ids stay unique");
    assert.equal((await post("/api/machines/studio-2/remove", {}, owner)).status, 200);
    // A machine publishes only its own snapshot, and its tokens reach no session route.
    assert.equal((await post("/api/ingest", snapshot("studio"), bearer(studio.tokens.collector))).status, 200);
    assert.equal((await post("/api/ingest", snapshot("laptop"), bearer(studio.tokens.collector))).status, 403);
    assert.equal((await post("/api/ingest", snapshot("studio", Date.now() + 1), bearer(studio.tokens.runner))).status, 401, "a runner token is not a collector token");
    assert.equal((await get("/api/overview", bearer(studio.tokens.collector))).status, 401);
    assert.equal((await post("/api/ingest", snapshot("laptop"), bearer(laptop.tokens.collector))).status, 200);
    const duties = async (value: string) => ((await (await get("/api/collector/duties", bearer(value))).json()) as {duties: boolean}).duties;
    assert.deepEqual([await duties(studio.tokens.collector), await duties(laptop.tokens.collector)], [true, false], "the first machine in order is on duty");
    // New conversations go to the first machine present; a claim stays with its machine.
    const studioRunner = randomUUID();
    assert.equal(await claim(studio.tokens.runner, studioRunner), null);
    const created = (await (await post("/api/runs", {requestId: randomUUID(), text: "Inspect", projectId: null, agent: "auto", workIssue: null}, owner)).json()) as {run: Run};
    assert.equal(await claim(laptop.tokens.runner, studioRunner), null, "the laptop waits while the studio is present, even reusing its runner ID");
    const taken = (await claim(studio.tokens.runner, studioRunner))!;
    assert.deepEqual([taken.id, taken.host], [created.run.id, "studio"]);
    assert.equal((await post("/api/runner/heartbeat", {runnerId: studioRunner, id: taken.id, generation: 1}, bearer(laptop.tokens.runner))).status, 409, "another machine cannot act on its claim");
    // The owner's order decides duties.
    assert.equal((await post("/api/machines/laptop", {position: 0}, owner)).status, 200);
    assert.deepEqual([await duties(studio.tokens.collector), await duties(laptop.tokens.collector)], [false, true]);
    const view = (await (await get("/api/overview", {Cookie: owner.Cookie})).json()) as PortfolioView;
    assert.deepEqual(view.machines?.map((m) => [m.id, m.name, m.duties]), [["laptop", "Laptop", true], ["studio", "Studio", false]]);
    // Replaced tokens stop at once; a removed machine's tokens and snapshot go too.
    const replaced = (await (await post("/api/machines/studio/tokens", {}, owner)).json()) as Added;
    assert.equal((await post("/api/ingest", snapshot("studio", Date.now() + 2), bearer(studio.tokens.collector))).status, 401);
    assert.equal((await post("/api/ingest", snapshot("studio", Date.now() + 3), bearer(replaced.tokens.collector))).status, 200);
    assert.equal((await post("/api/machines/laptop", {name: "Old laptop"}, owner)).status, 200);
    assert.equal((await post("/api/machines/laptop/remove", {}, owner)).status, 200);
    assert.equal((await get("/api/collector/duties", bearer(laptop.tokens.collector))).status, 401);
    const after = (await (await get("/api/overview", {Cookie: owner.Cookie})).json()) as PortfolioView;
    assert.deepEqual([after.machines?.map((m) => m.id), after.snapshots.map((s) => s.host)], [["studio"], ["studio"]]);
    assert.equal((await post("/api/machines", {name: "   "}, owner)).status, 400);
    assert.equal((await post("/api/machines", {name: "Laptop"}, {Cookie: owner.Cookie, Origin: "https://elsewhere.example"})).status, 403, "only this page can add a machine");
  } finally {
    await mf.dispose();
    await rm(dir, {recursive: true, force: true});
  }
});

test("real Durable Object rejects older snapshots and keeps host state through restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-test-"));
  const script = path.join(dir, "local.mjs");
  await build({
    entryPoints: ["worker/local.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir, { COLLECTOR_TOKEN: "x".repeat(64), LAPTOP_COLLECTOR_TOKEN: "y".repeat(64) });
  let mf = await start(config);
  const now = Date.now();
  const post = (host: string, at: number, extra = {}) =>
    mf.dispatchFetch("http://127.0.0.1/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        host,
        collectedAt: at,
        projects: [],
        unassignedSessions: [],
        ...extra,
      }),
    });
  try {
    assert.equal((await post("studio", now)).status, 200);
    assert.equal((await post("studio", now - 1)).status, 409);
    assert.equal((await post("laptop", now)).status, 200);
    assert.equal((await post("unknown", now)).status, 400);
    assert.equal((await post("studio", now + 7200_000)).status, 400);
    assert.equal(
      (await post("studio", now + 1, { unexpected: "private data" })).status,
      400,
    );
    await mf.dispose();
    mf = await start(config);
    const data = (await (
      await mf.dispatchFetch("http://127.0.0.1/api/overview")
    ).json()) as { snapshots: { host: string; collectedAt: number }[] };
    assert.deepEqual(
      data.snapshots.map((s) => s.host),
      ["laptop", "studio"],
    );
    assert.equal(data.snapshots[1].collectedAt, now);
    assert.equal(
      (
        await mf.dispatchFetch("http://127.0.0.1/api/delete", {
          method: "POST",
        })
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("production rejects unauthenticated reads and writes, including spoofed headers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-auth-"));
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: path.join(dir, "worker.mjs"),
  });
  const mf = await start(
    await options(path.join(dir, "worker.mjs"), dir, {
      ALLOWED_EMAILS: "owner@example.com",
      COLLECTOR_TOKEN: "x".repeat(64),
    }),
  );
  try {
    for (const route of ["/api/overview", "/api/ingest"]) {
      const r = await mf.dispatchFetch(`https://example.com${route}`, {
        headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
      });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("Cache-Control"), "no-store");
    }
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Authorization: `Bearer ${"x".repeat(64)}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/auth/request", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
const closeSnapshot = (at = Date.now()) => ({
  version: 1,
  host: "studio",
  collectedAt: at,
  projects: [],
  unassignedSessions: [],
  work: {
    issues: [issue(7), issue(8, { open: false })],
    associations: [],
    associationsState: "ok",
  },
});
test("Mark done needs a same-origin session; the upload token only exchanges close requests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-close-"));
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: path.join(dir, "worker.mjs"),
  });
  const bearer = `Bearer ${"x".repeat(64)}`;
  const mf = await start(
    await options(path.join(dir, "worker.mjs"), dir, {
      ALLOWED_EMAILS: "owner@example.com",
      COLLECTOR_TOKEN: "x".repeat(64),
    }),
  );
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const salt = token(),
      value = token();
    await store.issue("owner@example.com", salt, digest(`${salt}:123456`));
    assert.equal(
      await store.verify("owner@example.com", "123456", digest(value)),
      true,
    );
    const session = `__Host-projects=${value}`;
    const origin = "https://example.com";
    await store.publish(
      closeSnapshot() as unknown as Parameters<Portfolio["publish"]>[0],
    );
    const close = (number: unknown, headers: Record<string, string> = {}) =>
      mf.dispatchFetch(`${origin}/api/work/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ issue: number }),
      });
    assert.equal((await close(7, { Cookie: session })).status, 403);
    assert.equal(
      (await close(7, { Cookie: session, Origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (await close(7, { Authorization: bearer, Origin: origin })).status,
      401,
    );
    const signed = { Cookie: session, Origin: origin };
    assert.equal((await close("7", signed)).status, 400);
    assert.equal((await close(999, signed)).status, 404);
    assert.equal((await close(8, signed)).status, 409);
    const first = await close(7, signed);
    assert.equal(first.status, 200);
    const queued = ((await first.json()) as { close: Close }).close;
    assert.equal(queued.state, "queued");
    const repeat = (
      (await (await close(7, signed)).json()) as {
        close: Close;
      }
    ).close;
    assert.equal(repeat.requestedAt, queued.requestedAt);
    // Sessions cannot use the collector's close exchange, and vice versa.
    assert.equal(
      (
        await mf.dispatchFetch(`${origin}/api/closes`, {
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await mf.dispatchFetch(`${origin}/api/overview`, {
          headers: { Authorization: bearer },
        })
      ).status,
      401,
    );
    const pending = (await (
      await mf.dispatchFetch(`${origin}/api/closes`, {
        headers: { Authorization: bearer },
      })
    ).json()) as { closes: object[] };
    assert.deepEqual(pending.closes, [
      { issue: 7, requestedAt: queued.requestedAt },
    ]);
    const report = (body: object) =>
      mf.dispatchFetch(`${origin}/api/closes`, {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const done = {
      issue: 7,
      requestedAt: queued.requestedAt,
      state: "done",
      message: null,
    };
    assert.equal((await report({ ...done, extra: 1 })).status, 400);
    assert.deepEqual(await (await report({ ...done, requestedAt: 1 })).json(), {
      updated: false,
    });
    assert.deepEqual(await (await report(done)).json(), { updated: true });
    assert.deepEqual(await (await report(done)).json(), { updated: false });
    const view = (await (
      await mf.dispatchFetch(`${origin}/api/overview`, {
        headers: { Cookie: session },
      })
    ).json()) as { closes: Close[] };
    assert.equal(view.closes[0].state, "done");
    // Closed here and not yet seen closed by a scan: no second request.
    assert.equal((await close(7, signed)).status, 409);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
const inboxSnapshot = (at = Date.now()) => ({
  ...closeSnapshot(at),
  inbox: {
    account: "owner@example.com",
    observedAt: at,
    state: "ok",
    threads: [
      { id: "aaaaaaaaaa01", subject: "Weekly news", from: "Weekly <news@news.example.com>", latestMessageId: "aaaaaaaaaa02", updatedAt: at - 60_000, inInbox: true, lastSentByMe: false, unread: true, messages: 1, body: "This week: PRIVATE-BODY-MARKER", unsubscribe: { oneClick: true, url: "https://news.example.com/oneclick/unsubscribe/token", mailto: null } },
      { id: "bbbbbbbbbb01", subject: "Contract", from: "Client", latestMessageId: "bbbbbbbbbb02", updatedAt: at - 60_000, inInbox: true, lastSentByMe: false, unread: false, messages: 3, body: "Please sign.", unsubscribe: null },
    ],
  },
});
test("the Laptop's collector publishes for itself and takes the Studio's duties only while the Studio is away", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-laptop-collector-"));
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: path.join(dir, "worker.mjs") });
  const studio = {Authorization: `Bearer ${"x".repeat(64)}`}, laptop = {Authorization: `Bearer ${"y".repeat(64)}`};
  const mf = await start(await options(path.join(dir, "worker.mjs"), dir, { ALLOWED_EMAILS: "owner@example.com", COLLECTOR_TOKEN: "x".repeat(64), LAPTOP_COLLECTOR_TOKEN: "y".repeat(64) }));
  const origin = "https://example.com";
  const get = async (route: string, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {headers});
  const ingest = (snapshot: object, headers: Record<string, string>) => mf.dispatchFetch(`${origin}/api/ingest`, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(snapshot)});
  const duties = async () => ((await (await get("/api/collector/duties", laptop)).json()) as {duties: boolean}).duties;
  const closes = async (headers: Record<string, string>) => ((await (await get("/api/closes", headers)).json()) as {closes: {issue: number}[]}).closes.map((c) => c.issue);
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const salt = token(), value = token();
    await store.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await store.verify("owner@example.com", "123456", digest(value));
    const signed = {Cookie: `__Host-projects=${value}`, Origin: origin, "Content-Type": "application/json"};
    assert.equal((await ingest(inboxSnapshot(), studio)).status, 200);
    assert.equal((await mf.dispatchFetch(`${origin}/api/work/close`, {method: "POST", headers: signed, body: JSON.stringify({issue: 7})})).status, 200);
    assert.equal(await duties(), false, "the Studio is present");
    assert.deepEqual(await closes(laptop), [], "requests go to the machine on duty");
    assert.deepEqual(await closes(studio), [7]);
    assert.equal((await ingest(closeSnapshot(), laptop)).status, 403, "the Laptop cannot publish the Studio's snapshot");
    assert.equal((await ingest({...archiveSnapshot("laptop"), work: closeSnapshot().work}, laptop)).status, 200);
    assert.equal((await ingest(archiveSnapshot("laptop", Date.now() + 1000), studio)).status, 403, "a machine publishes only its own snapshot");
    assert.equal((await mf.dispatchFetch(`${origin}/api/review`, {method: "POST", headers: {...laptop, "Content-Type": "application/json"}, body: "{}"})).status, 410, "daily publication is retired for every machine regardless of duty");
    assert.equal((await get("/api/overview", laptop)).status, 401, "the Laptop's bearer reads nothing");
    // Five minutes without a publish from the Studio's collector.
    await (await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"})).exec("UPDATE collector_contact SET at=? WHERE host='studio'", Date.now() - 5 * 60_000);
    assert.equal(await duties(), true);
    assert.deepEqual(await closes(laptop), [7]);
    const inbox = {...inboxSnapshot().inbox, observedAt: Date.now() + 1000};
    assert.equal((await ingest({...archiveSnapshot("laptop", Date.now() + 1000), work: closeSnapshot().work, inbox}, laptop)).status, 200);
    const view = (await (await get("/api/overview", {Cookie: signed.Cookie})).json()) as PortfolioView;
    assert.equal(view.snapshots.find((s) => s.inbox?.observedAt === inbox.observedAt)?.host, "laptop", "the Laptop's inbox read is the newest");
    assert.equal((await ingest(closeSnapshot(Date.now() + 2000), studio)).status, 200);
    assert.equal(await duties(), false, "the Studio takes its duties back as soon as it publishes");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});
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
    const activity = await store.createRun({requestId: randomUUID(), text: "Investigate source", projectId: null, agent: "auto", workIssue: 7, emailThread: "bbbbbbbbbb01"});
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
test("the Studio closes a queued issue and reports it; without GitHub it stays queued", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-studio-"));
  const script = path.join(dir, "local.mjs");
  await build({
    entryPoints: ["worker/local.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(await options(script, dir, { COLLECTOR_TOKEN: "x".repeat(64) }));
  try {
    const endpoint = (await mf.ready).href;
    const call = async (route: string, init: RequestInit = {}) =>
      fetch(new URL(route, endpoint), init);
    assert.equal(
      (
        await call("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(closeSnapshot()),
        })
      ).status,
      200,
    );
    const closed: string[] = [];
    const gh = async (args: string[]) => {
      closed.push(args[2]);
      return "";
    };
    // Nothing queued: nothing touches GitHub.
    await applyCloses(endpoint, {}, [issue(7)], "acme/work", gh);
    assert.deepEqual(closed, []);
    assert.equal(
      (
        await call("/api/work/close", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(endpoint).origin,
          },
          body: JSON.stringify({ issue: 7 }),
        })
      ).status,
      200,
    );
    const state = async () =>
      ((await (await call("/api/overview")).json()) as { closes: Close[] })
        .closes[0];
    await applyCloses(endpoint, {}, null, "acme/work", gh);
    await applyCloses(endpoint, {}, [issue(7)], "acme/work", async () => {
      throw Error("offline");
    });
    assert.equal((await state()).state, "queued");
    assert.match((await state()).message ?? "", /retrying/);
    assert.deepEqual(closed, []);
    await applyCloses(endpoint, {}, [issue(7)], "acme/work", gh);
    assert.deepEqual(closed, ["7"]);
    assert.equal((await state()).state, "done");
    assert.equal((await state()).message, null);
    assert.deepEqual(await (await call("/api/closes")).json(), { closes: [] });
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retired daily publication cannot email or expose old editions, while OTP email still works", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-retired-brief-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/email-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", OWNER_EMAIL: "owner@example.com", EMAIL_FROM: "projects@notify.example.com", SITE_URL: "https://projects.example.com", COLLECTOR_TOKEN: "x".repeat(64)});
  type EmailTest = Portfolio & {sentEmails(): Promise<{text: string}[]>; seedBriefHistory(): Promise<void>; briefHistory(): Promise<string[]>};
  let mf = await start(config);
  const store = async () => {const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as EmailTest;};
  const headers = {"Content-Type": "application/json", Authorization: `Bearer ${"x".repeat(64)}`};
  try {
    await (await store()).seedBriefHistory();
    for (const body of ['{"review":{},"sendDaily":true}', '{malformed legacy payload']) {
      const res = await mf.dispatchFetch("https://example.com/api/review", {method: "POST", headers, body});
      assert.equal(res.status, 410);
      assert.match(await res.text(), /retired/);
    }
    assert.deepEqual(await (await store()).sentEmails(), []);
    assert.deepEqual(await (await store()).briefHistory(), ["historical edition"]);
    await mf.dispose(); mf = await start(config);
    assert.deepEqual(await (await store()).briefHistory(), ["historical edition"], "retirement preserves stored history across restart");
    assert.equal((await mf.dispatchFetch("https://example.com/api/overview", {headers})).status, 401);
    const otp = await mf.dispatchFetch("https://example.com/api/auth/request", {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://example.com"}, body: JSON.stringify({email: "owner@example.com"})});
    assert.equal(otp.status, 200);
    const sent = await (await store()).sentEmails();
    assert.equal(sent.length, 1, "the sign-in email binding remains functional");
    const code = sent[0].text.match(/\b[0-9]{6}\b/)![0];
    const signed = await mf.dispatchFetch("https://example.com/api/auth/verify", {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://example.com"}, body: JSON.stringify({email: "owner@example.com", code})});
    assert.equal(signed.status, 200);
    const overview = await mf.dispatchFetch("https://example.com/api/overview", {headers: {Cookie: signed.headers.get("Set-Cookie")!.split(";")[0]}});
    assert.equal(overview.status, 200);
    const overviewBody = (await overview.json()) as object;
    assert.equal("review" in overviewBody, false);
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});

test("one Studio recovers concurrent conversation claims without sharing resume state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-concurrent-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), owner = randomUUID();
  const config = await options(script, dir, {RUNNER_TOKEN: runner});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const claim = async (activeRunIds: string[] = []) => {
    const response = await mf.dispatchFetch("https://example.com/api/runner/claim", {method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"}, body: JSON.stringify({runnerId: owner, activeRunIds})});
    assert.equal(response.status, 200);
    return (await response.json() as {run: Run | null}).run;
  };
  try {
    let db = await store();
    const runs: Run[] = [];
    for (let i = 0; i < 3; i++) runs.push(JSON.parse(JSON.stringify(await db.createRun({requestId: randomUUID(), text: `Independent conversation ${i}`, projectId: null, agent: "auto", workIssue: null}))));
    const active: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = (await claim(active))!;
      assert.ok(!active.includes(next.id));
      assert.equal((await claim(active))!.id, next.id, "a lost claim reply retries its reservation");
      active.push(next.id);
    }
    assert.equal(await claim(active), null);
    assert.equal(await db.claimRun(randomUUID(), [], undefined, "studio"), null, "another owner cannot steal active work");
    const receipts = runs.map(run => ({seq: 1, state: "running" as const, summary: "Inspecting independently", masterSessionId: randomUUID(), children: [], reviewedMessageIds: [run.messages[0].id]}));
    for (let i = 0; i < runs.length; i++) assert.equal(await db.reportRun(owner, runs[i].id, 1, receipts[i], "studio"), true);
    await db.cancelRun(runs[0].id);
    assert.equal((await db.heartbeatRun(owner, runs[0].id, 1, "studio"))!.cancel, true);
    assert.equal((await db.heartbeatRun(owner, runs[1].id, 1, "studio"))!.cancel, false);
    await mf.dispose(); mf = await start(config); db = await store();
    const recovered: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = (await claim(recovered))!;
      assert.ok(!recovered.includes(next.id));
      const index = runs.findIndex(run => run.id === next.id);
      assert.equal(next.progress!.masterSessionId, receipts[index].masterSessionId);
      recovered.push(next.id);
    }
    assert.deepEqual(new Set(recovered), new Set(active));
    await db.reportRun(owner, runs[1].id, 1, {...receipts[1], seq: 2, state: "completed"}, "studio");
    await db.messageRun(runs[1].id, {requestId: randomUUID(), text: "Resume only this conversation"});
    const follow = (await claim([runs[0].id, runs[2].id]))!;
    assert.equal(follow.id, runs[1].id);
    assert.equal(follow.generation, 2);
    assert.equal(follow.progress!.masterSessionId, receipts[1].masterSessionId);
    assert.equal((await db.getRun(runs[2].id))!.generation, 1);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("the Laptop starts conversations only while the Studio is away, and each stays on its machine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-fallback-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const studio = "m".repeat(64), laptop = "a".repeat(64), origin = "https://example.com";
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: studio, LAPTOP_RUNNER_TOKEN: laptop}));
  const miniId = randomUUID(), airId = randomUUID();
  const post = (route: string, body: unknown, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  const claim = async (bearer: string, runnerId: string, activeRunIds: string[] = []) => {
    const response = await post("/api/runner/claim", {runnerId, activeRunIds}, {Authorization: `Bearer ${bearer}`});
    assert.equal(response.status, 200);
    return (await response.json() as {run: Run | null}).run;
  };
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const create = async (text: string) => JSON.parse(JSON.stringify(await (await store()).createRun({requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null}))) as Run;
  const finish = async (bearer: string, runnerId: string, run: Run) => {
    const progress = {seq: 1, state: "completed" as const, summary: "Done", masterSessionId: randomUUID(), children: [], reviewedMessageIds: [run.messages[0].id]};
    const response = await post("/api/runner/report", {runnerId, id: run.id, generation: run.generation, progress}, {Authorization: `Bearer ${bearer}`});
    assert.equal(response.status, 200);
  };
  // Two minutes without a claim, heartbeat or report from the Studio.
  const miniGoesQuiet = async () => (await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"})).exec("UPDATE runner_contact SET at=? WHERE host='studio'", Date.now() - 120_000);
  try {
    assert.equal((await post("/api/runner/claim", {runnerId: airId}, {Authorization: `Bearer ${"x".repeat(64)}`})).status, 401);
    assert.equal((await mf.dispatchFetch(origin + "/api/overview", {headers: {Authorization: `Bearer ${laptop}`}})).status, 401, "the Laptop's bearer reads nothing");
    const early = await create("Started before the Studio has checked in");
    const taken = (await claim(laptop, airId))!;
    assert.equal(taken.id, early.id);
    assert.equal(taken.host, "laptop");
    assert.equal(await claim(studio, miniId), null, "the Studio cannot take the Laptop's running conversation");
    const present = await create("Started while the Studio is present");
    assert.equal(await claim(laptop, airId, [early.id]), null, "the Studio goes first while it is present");
    assert.equal((await claim(studio, miniId))!.host, "studio");
    const beat = {runnerId: miniId, id: present.id, generation: 1};
    assert.equal((await post("/api/runner/heartbeat", beat, {Authorization: `Bearer ${laptop}`})).status, 409, "the Laptop's bearer cannot act as the Studio, even with its runner ID");
    assert.equal((await post("/api/runner/heartbeat", beat, {Authorization: `Bearer ${studio}`})).status, 200);
    await finish(laptop, airId, taken);
    await (await store()).messageRun(early.id, {requestId: randomUUID(), text: "Follow up on the Laptop's work"});
    assert.equal(await claim(studio, miniId, [present.id]), null, "a follow-up never moves to another machine");
    const followUp = (await claim(laptop, airId))!;
    assert.deepEqual([followUp.id, followUp.generation, followUp.host], [early.id, 2, "laptop"]);
    await miniGoesQuiet();
    const away = await create("Started after the Studio went quiet");
    assert.equal((await claim(laptop, airId, [early.id]))!.id, away.id);
    const minis = (await (await store()).getRun(present.id))!;
    await finish(studio, miniId, minis);
    await (await store()).messageRun(present.id, {requestId: randomUUID(), text: "Follow up on the Studio's work"});
    await miniGoesQuiet();
    assert.equal(await claim(laptop, airId, [early.id, away.id]), null, "the Studio's conversation waits for the Studio");
    assert.deepEqual([(await claim(studio, miniId))!.id, (await (await store()).getRun(present.id))!.host], [present.id, "studio"]);
    assert.equal((await (await store()).listRuns()).find((r) => r.id === away.id)?.host, "laptop", "lists name the machine");
    // An old Studio inventory no longer blocks new work; an unknown project still does.
    const db = await store(), salt = token(), cookie = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(cookie));
    await db.publish(archiveSnapshot("studio", Date.now() - 6 * 3600_000));
    const browser = {Cookie: `__Host-projects=${cookie}`, Origin: origin};
    const input: RunInput = {requestId: randomUUID(), text: "Start while the Studio is away", projectId: "acme/fixture", agent: "auto", workIssue: null};
    assert.equal((await post("/api/runs", input, browser)).status, 200);
    assert.equal((await post("/api/runs", {...input, requestId: randomUUID(), projectId: "acme/unknown"}, browser)).status, 400);
    // The user may choose a Claude master; Codex coordinates otherwise.
    const claude = (await (await post("/api/runs", {...input, requestId: randomUUID(), masterAgent: "claude"}, browser)).json()) as {run: Run};
    assert.equal(claude.run.masterAgent, "claude");
    assert.equal((await (await store()).getRun(input.requestId))!.masterAgent, undefined);
    assert.equal((await post("/api/runs", {...input, requestId: randomUUID(), masterAgent: "gpt"}, browser)).status, 400);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});
test("the owner continues a conversation on another machine only while its machine is away, and the away machine's claim is never replayed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-move-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const studio = "m".repeat(64), laptop = "a".repeat(64), origin = "https://example.com";
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: studio, LAPTOP_RUNNER_TOKEN: laptop}));
  const miniId = randomUUID(), airId = randomUUID();
  const post = (route: string, body: unknown, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  const claim = async (bearer: string, runnerId: string, activeRunIds: string[] = []) => ((await (await post("/api/runner/claim", {runnerId, activeRunIds}, {Authorization: `Bearer ${bearer}`})).json()) as {run: Run | null}).run;
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const miniGoesQuiet = async () => (await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"})).exec("UPDATE runner_contact SET at=? WHERE host='studio'", Date.now() - 120_000);
  try {
    const db = await store(), salt = token(), cookie = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(cookie));
    const signed = {Cookie: `__Host-projects=${cookie}`, Origin: origin};
    const working = JSON.parse(JSON.stringify(await db.createRun({requestId: randomUUID(), text: "Ship the change", projectId: null, agent: "auto", workIssue: null}))) as Run;
    assert.equal((await claim(studio, miniId))!.host, "studio");
    assert.equal((await post(`/api/runs/${working.id}/move`, {}, signed)).status, 409, "the Studio is present");
    assert.equal((await post(`/api/runs/${working.id}/move`, {}, {Cookie: signed.Cookie})).status, 403, "same-origin only");
    assert.equal((await post(`/api/runs/${working.id}/move`, {}, {Authorization: `Bearer ${laptop}`, Origin: origin})).status, 401, "a runner cannot move conversations");
    await miniGoesQuiet();
    const read = (await (await mf.dispatchFetch(`${origin}/api/runs/${working.id}`, {headers: signed})).json()) as {runners: {studio: number; laptop: number | null}};
    assert.ok(Date.now() - read.runners.studio >= 120_000, "the page sees the Studio is away");
    const moved = ((await (await post(`/api/runs/${working.id}/move`, {}, signed)).json()) as {run: Run}).run;
    assert.deepEqual([moved.state, moved.generation, moved.movedFrom, moved.host], ["queued", 2, "studio", undefined]);
    const resumed = (await claim(laptop, airId))!;
    assert.deepEqual([resumed.id, resumed.generation, resumed.host, resumed.movedFrom], [working.id, 2, "laptop", "studio"]);
    // A Studio that comes back finds its abandoned step fenced off.
    assert.equal((await post("/api/runner/heartbeat", {runnerId: miniId, id: working.id, generation: 1}, {Authorization: `Bearer ${studio}`})).status, 409);
    // A finished conversation: the follow-up goes to the Laptop instead of waiting.
    const done = JSON.parse(JSON.stringify(await db.createRun({requestId: randomUUID(), text: "Draft the summary", projectId: null, agent: "auto", workIssue: null}))) as Run;
    assert.equal((await claim(studio, miniId))!.id, done.id);
    const receipt = {seq: 1, state: "completed" as const, summary: "Drafted", masterSessionId: randomUUID(), children: [], reviewedMessageIds: [done.messages[0].id]};
    assert.equal((await post("/api/runner/report", {runnerId: miniId, id: done.id, generation: 1, progress: receipt}, {Authorization: `Bearer ${studio}`})).status, 200);
    await miniGoesQuiet();
    const idle = ((await (await post(`/api/runs/${done.id}/move`, {}, signed)).json()) as {run: Run}).run;
    assert.deepEqual([idle.state, idle.generation, idle.movedFrom], ["completed", 1, "studio"], "a finished conversation is not restarted");
    await db.messageRun(done.id, {requestId: randomUUID(), text: "Make it shorter"});
    const followUp = (await claim(laptop, airId, [working.id]))!;
    assert.deepEqual([followUp.id, followUp.generation, followUp.host], [done.id, 2, "laptop"]);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});
test("conversations isolate credentials and persist idempotent ownership, cancellation and follow-ups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-runs-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const collector = "c".repeat(64),
    runner = "r".repeat(64),
    origin = "https://example.com";
  const config = await options(script, dir, {
    ALLOWED_EMAILS: "owner@example.com",
    COLLECTOR_TOKEN: collector,
    RUNNER_TOKEN: runner,
  });
  let mf = await start(config);
  const store = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  const post = (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(origin + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    let db = await store();
    const salt = token(),
      value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = { Cookie: `__Host-projects=${value}`, Origin: origin },
      bearer = { Authorization: `Bearer ${runner}` };
    const input: RunInput = {
      requestId: randomUUID(),
      text: "Verify the project",
      projectId: null,
      agent: "auto",
      workIssue: null,
    };
    assert.equal(
      (await post("/api/runs", input, { Cookie: browser.Cookie })).status,
      403,
    );
    assert.equal(
      (
        await post("/api/runs", input, {
          Authorization: `Bearer ${collector}`,
          Origin: origin,
        })
      ).status,
      401,
    );
    assert.equal(
      (await post("/api/runner/claim", { runnerId: randomUUID() }, browser))
        .status,
      401,
    );
    assert.equal(
      (
        await post(
          "/api/runner/claim",
          { runnerId: randomUUID() },
          { Authorization: `Bearer ${collector}` },
        )
      ).status,
      401,
    );
    assert.equal(
      (await mf.dispatchFetch(origin + "/api/overview", { headers: bearer }))
        .status,
      401,
    );
    assert.equal(
      (await post("/api/ingest", closeSnapshot(), bearer)).status,
      401,
    );
    assert.equal((await post("/api/runs", input, browser)).status, 409); // missing inventory is not clean
    await db.publish(
      closeSnapshot() as unknown as Parameters<Portfolio["publish"]>[0],
    );
    const starts = await Promise.all([
      post("/api/runs", input, browser),
      post("/api/runs", input, browser),
    ]);
    assert.deepEqual(
      starts.map((r) => r.status),
      [200, 200],
    );
    assert.equal((await db.listRuns()).length, 1);
    assert.equal((await db.listRuns())[0].title, input.text);
    const owner = randomUUID(),
      other = randomUUID();
    const claim = async (id = owner) =>
      (await (
        await post("/api/runner/claim", { runnerId: id }, bearer)
      ).json()) as { run: Run | null; activity: unknown[] };
    const first = await claim();
    assert.equal(first.run?.id, input.requestId);
    assert.equal(first.activity.length, 1);
    assert.equal((await claim()).run?.id, input.requestId);
    assert.equal((await claim(other)).run, null);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Portfolio",
      { name: "test" },
    );
    await storage.exec(
      "UPDATE conversation_index SET payload=json_set(payload,'$.heartbeatAt',0)",
    );
    assert.equal((await claim(other)).run, null); // expiration never creates a replacement executor
    await mf.dispose();
    mf = await start(config);
    db = await store();
    assert.equal((await claim()).run?.id, input.requestId);
    const receipt: Progress = {
      seq: 1,
      state: "running",
      summary: "Reviewing",
      children: [],
      masterSessionId: randomUUID(),
    };
    const report = (progress: Progress, generation = 1, runnerId = owner) =>
      post(
        "/api/runner/report",
        { runnerId, id: input.requestId, generation, progress },
        bearer,
      );
    assert.equal((await report(receipt, 1, other)).status, 409);
    assert.equal(
      (await report({ ...receipt, unexpected: "raw output" } as Progress))
        .status,
      400,
    );
    assert.equal((await report(receipt)).status, 200);
    assert.equal((await report(receipt)).status, 200);
    assert.equal(
      (await post(`/api/runs/${input.requestId}/cancel`, {}, browser)).status,
      200,
    );
    const heartbeat = await post(
      "/api/runner/heartbeat",
      { runnerId: owner, id: input.requestId, generation: 1 },
      bearer,
    );
    assert.equal(
      ((await heartbeat.json()) as { cancel: boolean }).cancel,
      true,
    );
    assert.equal(
      (
        await report({
          ...receipt,
          seq: 2,
          state: "completed",
          summary: "Late completion",
        })
      ).status,
      200,
    );
    let run = (await db.getRun(input.requestId))!;
    assert.equal(run.state, "cancelled");
    assert.equal(run.progress?.state, "cancelled");
    assert.equal(run.messages.length, 2);
    assert.match(run.messages[1].text, /Stopped/);
    assert.equal(
      (await report({ ...receipt, seq: 2, state: "completed" })).status,
      200,
    ); // final receipt retry
    assert.equal((await db.getRun(input.requestId))?.messages.length, 2);
    const follow = {
      requestId: randomUUID(),
      text: "Continue with the clarification",
    };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await post(`/api/runs/${input.requestId}/message`, follow, browser))
          .status,
        200,
      );
    run = (await db.getRun(input.requestId))!;
    assert.equal(run.generation, 2);
    assert.equal(run.messages.length, 3);
    assert.equal(run.state, "queued");
    assert.equal(
      (await report({ ...receipt, seq: 999, state: "completed" })).status,
      409,
    ); // old turn cannot overwrite new one
    assert.equal((await claim()).run?.generation, 2);
    assert.equal(
      (
        await report(
          { ...receipt, seq: 1, state: "blocked", summary: "Needs a decision" },
          2,
        )
      ).status,
      200,
    );
    const queued = await db.createRun({ ...input, requestId: randomUUID() });
    await db.cancelRun(queued.id);
    assert.equal((await claim()).run, null); // queued cancellation never reaches a native process
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("active conversation cap includes old runs outside the history page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-runs-cap-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(await options(script, dir));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"),
      db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const input = () => ({
      requestId: randomUUID(),
      text: "Inspect",
      projectId: null,
      agent: "auto" as const,
      workIssue: null,
    });
    const old = await db.createRun(input());
    for (let n = 0; n < 55; n++) {
      const r = await db.createRun(input());
      await db.cancelRun(r.id);
    }
    for (let n = 0; n < 9; n++) await db.createRun(input());
    assert.ok((await db.listRuns()).some((r) => r.id === old.id));
    await assert.rejects(async () => db.createRun(input()));
    const cancelled = (await db.listRuns()).find(
      (r) => r.state === "cancelled",
    )!;
    await assert.rejects(async () =>
      db.messageRun(cancelled.id, {
        requestId: randomUUID(),
        text: "Continue",
      }),
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback given to the agent at work is marked so and still reviewed by the master", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-steer-")),
    script = path.join(dir, "worker.mjs");
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const mf = await start(await options(script, dir, { ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: "r".repeat(64) })),
    owner = randomUUID();
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const input: RunInput = { requestId: randomUUID(), text: "Change the button", projectId: null, agent: "auto", workIssue: null };
    await db.createRun(input);
    await db.claimRun(owner, [], undefined, "studio");
    const steer = { requestId: randomUUID(), text: "Use the blue button" };
    await db.messageRun(input.requestId, steer);
    const receipt: Progress = { seq: 1, state: "running", summary: "Changing", masterSessionId: randomUUID(), children: [], reviewedMessageIds: [input.requestId] };
    assert.equal(await db.reportRun(owner, input.requestId, 1, { ...receipt, steeredMessageIds: [randomUUID()] }, "studio"), false, "only this conversation's messages");
    assert.equal(await db.reportRun(owner, input.requestId, 1, { ...receipt, steeredMessageIds: [steer.requestId], live: { actor: "claude", childId: randomUUID(), at: Date.now(), plan: [{ step: "Change the button", status: "active" }], changes: { files: [{ path: "src/button.tsx", added: 3, removed: 1 }], total: { files: 1, added: 3, removed: 1 }, at: Date.now() } } }, "studio"), true);
    const steered = (await db.getRun(input.requestId))!;
    assert.equal(steered.messages.find((m) => m.id === steer.requestId)?.delivery, "steered");
    assert.equal(steered.progress?.live?.changes?.total.added, 3);
    // The master's next decision reviews it; completion does not wait on it.
    assert.equal(await db.reportRun(owner, input.requestId, 1, { ...receipt, seq: 2, state: "completed", summary: "Done", steeredMessageIds: [steer.requestId], reviewedMessageIds: [input.requestId, steer.requestId] }, "studio"), true);
    const done = (await db.getRun(input.requestId))!;
    assert.equal(done.messages.find((m) => m.id === steer.requestId)?.delivery, "reviewed");
    assert.equal(done.state, "completed");
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("active feedback is durable, idempotent and cannot be lost at completion or replayed by another runner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-feedback-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir, {
      ALLOWED_EMAILS: "owner@example.com",
      RUNNER_TOKEN: "r".repeat(64),
    }),
    owner = randomUUID(),
    other = randomUUID();
  let mf = await start(config);
  const store = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  try {
    let db = await store();
    const input: RunInput = {
      requestId: randomUUID(),
      text: "Inspect",
      projectId: null,
      agent: "auto",
      workIssue: null,
    };
    const run = { id: input.requestId };
    await db.createRun(input);
    const queued = { requestId: randomUUID(), text: "Check the README too" };
    await db.messageRun(run.id, queued);
    assert.equal((await db.claimRun(owner, [], undefined, "studio"))?.generation, 1);
    const feedback = { requestId: randomUUID(), text: "Explain the result" };
    await db.messageRun(run.id, feedback);
    await db.messageRun(run.id, feedback);
    assert.equal((await db.getRun(run.id))?.messages.length, 3);
    assert.equal((await db.getRun(run.id))?.generation, 1);
    assert.equal(
      (await db.heartbeatRun(owner, run.id, 1, "studio"))?.messages.at(-1)?.delivery,
      "queued",
    );
    const receipt: Progress = {
      seq: 1,
      state: "running",
      summary: "Reviewing feedback",
      masterSessionId: randomUUID(),
      children: [],
      reviewedMessageIds: [
        input.requestId,
        queued.requestId,
        feedback.requestId,
      ],
    };
    assert.equal(await db.reportRun(other, run.id, 1, receipt, "studio"), false);
    assert.equal(await db.reportRun(owner, run.id, 1, receipt, "studio"), true);
    assert.equal(
      (await db.getRun(run.id))?.messages.at(-1)?.delivery,
      "reviewed",
    );
    const late = { requestId: randomUUID(), text: "Add a concise summary" };
    await db.messageRun(run.id, late);
    const final = {
      ...receipt,
      seq: 2,
      state: "completed" as const,
      summary: "Completed the original request",
    };
    assert.equal(await db.reportRun(owner, run.id, 1, final, "studio"), true);
    assert.equal(await db.reportRun(owner, run.id, 1, final, "studio"), true); // lost response retry
    assert.equal((await db.getRun(run.id))?.state, "queued");
    assert.equal((await db.getRun(run.id))?.generation, 1); // retain receipt identity until next claim
    assert.equal(await db.claimRun(other, [], undefined, "studio"), null);
    await mf.dispose();
    mf = await start(config);
    db = await store();
    const follow = await db.claimRun(owner, [], undefined, "studio");
    assert.equal(follow?.generation, 2);
    assert.equal(follow?.progress?.masterSessionId, receipt.masterSessionId);
    assert.equal(
      follow?.messages.find((m) => m.id === late.requestId)?.delivery,
      "queued",
    );
    assert.equal(await db.reportRun(owner, run.id, 1, final, "studio"), false);
    assert.equal(
      await db.reportRun(owner, run.id, 2, {
        ...final,
        seq: 1,
        reviewedMessageIds: [...receipt.reviewedMessageIds!, late.requestId],
      }, "studio"),
      true,
    );
    assert.equal((await db.getRun(run.id))?.state, "completed");
    assert.equal(
      (await db.getRun(run.id))?.messages.find((m) => m.id === late.requestId)
        ?.delivery,
      "reviewed",
    );
    const cancelled = await db.createRun({ ...input, requestId: randomUUID() });
    await db.claimRun(owner, [], undefined, "studio");
    await db.messageRun(cancelled.id, {
      requestId: randomUUID(),
      text: "Pending feedback",
    });
    await db.cancelRun(cancelled.id);
    // Test the public error response: Miniflare cannot propagate synchronous
    // RPC throws with their original message through its Node proxy.
    const salt = token(),
      session = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(session));
    const rejected = await mf.dispatchFetch(
      `https://example.com/api/runs/${cancelled.id}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          Cookie: `__Host-projects=${session}`,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          text: "Too late",
        }),
      },
    );
    assert.equal(rejected.status, 409);
    assert.match(await rejected.text(), /current turn to stop/);
    await db.reportRun(owner, cancelled.id, 1, {
      ...final,
      reviewedMessageIds: [],
    }, "studio");
    assert.equal((await db.getRun(cancelled.id))?.state, "cancelled");
    assert.equal(await db.claimRun(owner, [], undefined, "studio"), null);
    const legacy = await db.createRun({ ...input, requestId: randomUUID() });
    await db.claimRun(owner, [], undefined, "studio");
    await db.messageRun(legacy.id, {
      requestId: randomUUID(),
      text: "New feedback to an old runner",
    });
    await db.reportRun(owner, legacy.id, 1, {
      ...final,
      reviewedMessageIds: undefined,
    }, "studio");
    assert.equal((await db.getRun(legacy.id))?.state, "blocked");
    assert.equal(await db.claimRun(owner, [], undefined, "studio"), null);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy conversations migrate exactly once into isolated objects, preserving native claims and feedback through restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-migrate-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir);
  let mf = await start(config);
  const db = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  const owner = randomUUID(),
    id = randomUUID();
  const old: Run = {
    id,
    projectId: null,
    agent: "auto",
    workIssue: 1112,
    generation: 2,
    state: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatAt: Date.now(),
    messages: [
      {
        id: randomUUID(),
        role: "user",
        text: "Original request",
        at: Date.now(),
      },
      {
        id: randomUUID(),
        role: "user",
        text: "Continue",
        at: Date.now(),
        delivery: "queued",
      },
    ],
    progress: {
      seq: 4,
      state: "running",
      summary: "Working",
      children: [],
      masterSessionId: randomUUID(),
    },
  };
  try {
    await (await db()).listRuns();
    const source = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {
      name: "test",
    });
    await source.exec(
      "INSERT INTO agent_runs(id,payload,owner,updated) VALUES(?,?,?,?)",
      id,
      JSON.stringify(old),
      owner,
      old.updatedAt,
    );
    await mf.dispose();
    mf = await start(config);
    let store = await db();
    assert.equal((await store.getRun(id))?.id, old.id);
    const destination = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name: JSON.stringify(["test", id]) },
    );
    assert.deepEqual(
      JSON.parse(
        (
          await destination.exec<{ payload: string }>(
            "SELECT payload FROM agent_runs",
          )
        )[0].payload,
      ),
      old,
    );
    assert.equal((await store.claimRun(owner, [], undefined, "studio"))?.id, id);
    assert.equal(await store.claimRun(randomUUID(), [], undefined, "studio"), null);
    const ns = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const conversation = ns.get(
      ns.idFromName(JSON.stringify(["test", id])),
    ) as unknown as Conversation;
    // Repeating migration with an obsolete snapshot must not overwrite newer state.
    const feedback = {
      requestId: randomUUID(),
      text: "Keep the native session",
    };
    await store.messageRun(id, feedback);
    await conversation.initialize(old, owner);
    assert.equal(
      (await conversation.record())?.run.messages.at(-1)?.id,
      feedback.requestId,
    );
    const other = await store.createRun({
      requestId: randomUUID(),
      text: "Independent",
      projectId: null,
      agent: "auto",
      workIssue: null,
    });
    const isolated = ns.get(
      ns.idFromName(JSON.stringify(["test", other.id])),
    ) as unknown as Conversation;
    assert.equal((await isolated.record())?.run.messages.length, 1);
    assert.equal((await conversation.record())?.run.messages.length, 3);
    const migrated = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Portfolio",
      { name: "test" },
    );
    assert.equal((await migrated.exec("SELECT * FROM agent_runs")).length, 0);
    await mf.dispose();
    mf = await start(config);
    store = await db();
    assert.equal(
      (await store.getRun(id))?.progress?.masterSessionId,
      old.progress!.masterSessionId,
    );
    assert.equal((await store.getRun(id))?.messages.at(-1)?.delivery, "queued");
    assert.equal((await store.claimRun(owner, [], undefined, "studio"))?.id, id);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conversation alarm detects disconnection without replacing its claim and repairs a lost index update", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-alarm-")),
    script = path.join(dir, "worker.mjs");
  await build({
    stdin: {
      contents: `export {default,Portfolio} from './worker/index'; import {Conversation as Base} from './worker/runs'; export class Conversation extends Base { triggerAlarm() { return super.alarm(); } }`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(await options(script, dir));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"),
      store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const owner = randomUUID(),
      run = await store.createRun({
        requestId: randomUUID(),
        text: "Inspect",
        projectId: null,
        agent: "auto",
        workIssue: null,
      });
    await store.claimRun(owner, [], undefined, "studio");
    const name = JSON.stringify(["test", run.id]);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name },
    );
    await storage.exec(
      "UPDATE agent_runs SET payload=json_set(payload,'$.heartbeatAt',0)",
    );
    // Invoke the actual handler through a test-only subclass; alarm is reserved
    // over RPC and the production class exposes no manual alarm endpoint.
    const conversations = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const object = conversations.get(
      conversations.idFromName(name),
    ) as unknown as Conversation & { triggerAlarm(): Promise<void> };
    await object.triggerAlarm();
    assert.equal((await store.getRun(run.id))?.connection, "disconnected");
    assert.equal(await store.claimRun(randomUUID(), [], undefined, "studio"), null);
    await store.heartbeatRun(owner, run.id, 1, "studio");
    assert.equal((await store.getRun(run.id))?.connection, "connected");
    await store.reportRun(owner, run.id, 1, {
      seq: 1,
      state: "completed",
      summary: "Done",
      children: [],
      masterSessionId: null,
      reviewedMessageIds: [run.id],
    }, "studio");
    // Bypass the directory to model a committed message whose RPC reply was lost.
    await object.message(run.id, { requestId: randomUUID(), text: "Continue" });
    await object.triggerAlarm();
    assert.equal((await store.claimRun(owner, [], undefined, "studio"))?.generation, 2);
    assert.equal(
      (await store.getRun(run.id))?.messages.at(-1)?.delivery,
      "queued",
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Worker spans retain safe request diagnostics and receipts log lifecycle timings once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-telemetry-"));
  const script = path.join(dir, "worker.mjs");
  // Test-only log sink and alarm trigger; no diagnostic/auth endpoint is added
  // to the production Worker. The real tracing API runs in workerd here.
  await build({
    stdin: {
      contents: `import worker, { Portfolio, Conversation as BaseConversation } from "./worker/index";
        import { observeRequest } from "./worker/telemetry";
        export { Portfolio };
        export class Conversation extends BaseConversation { triggerAlarm() { return super.alarm(); } }
        const logs = [];
        for (const level of ["info", "warn", "error"]) console[level] = (line) => logs.push({ level, ...JSON.parse(line) });
        export default { fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path === "/__test_logs") return Response.json(logs);
          if (path === "/__test_failure") return observeRequest(request, () => { throw Error("private-error-content"); });
          return worker.fetch(request, env);
        } };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const token = "sensitive-runner-token".repeat(3);
  const mf = await start(await options(script, dir, { RUNNER_TOKEN: token }));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const runId = randomUUID(),
      runnerId = randomUUID(),
      messageId = randomUUID();
    await store.createRun({
      requestId: runId,
      text: "sensitive-prompt",
      projectId: null,
      agent: "auto",
      workIssue: null,
    });
    const post = (route: string, body: unknown) =>
      mf.dispatchFetch("https://example.com" + route, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post("/api/runner/claim", { runnerId })).status, 200);
    await store.messageRun(runId, {
      requestId: messageId,
      text: "sensitive-feedback",
    });
    await store.messageRun(runId, {
      requestId: messageId,
      text: "sensitive-feedback",
    });
    const eventId = randomUUID(),
      turnId = randomUUID();
    const progress: Progress = {
      seq: 1,
      state: "running",
      summary: "sensitive-receipt",
      children: [],
      masterSessionId: "sensitive-session",
      notes: [{
        id: randomUUID(), at: Date.now(), actor: "master", childId: null,
        done: ["sensitive-progress-note"], remaining: ["sensitive-plan"],
        blocker: "sensitive-blocker",
      }],
      reviewedMessageIds: [runId, messageId],
      telemetry: [
        {
          id: eventId,
          at: Date.now(),
          event: "native_finished",
          actor: "master",
          turnId,
          durationMs: 123456,
          outcome: "completed",
        },
      ],
    };
    const report = (value: unknown) =>
      post("/api/runner/report", {
        runnerId,
        id: runId,
        generation: 1,
        progress: value,
      });
    assert.equal(
      (
        await report({
          ...progress,
          telemetry: [
            { ...progress.telemetry![0], prompt: "sensitive-illegal-field" },
          ],
        })
      ).status,
      400,
    );
    assert.equal((await report(progress)).status, 200);
    assert.equal((await report(progress)).status, 200);
    assert.equal((await report({ ...progress, seq: 2 })).status, 200);
    assert.equal(
      (
        await post("/api/runner/heartbeat", {
          runnerId: randomUUID(),
          id: runId,
          generation: 1,
        })
      ).status,
      409,
    );
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name: JSON.stringify(["test", runId]) },
    );
    await storage.exec(
      "UPDATE agent_runs SET payload=json_set(payload,'$.heartbeatAt',?)",
      Date.now() - 60000,
    );
    const conversations = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const conversation = conversations.get(
      conversations.idFromName(JSON.stringify(["test", runId])),
    ) as unknown as { triggerAlarm(): Promise<void> };
    await conversation.triggerAlarm();
    assert.equal(
      (
        await post("/api/runner/heartbeat", {
          runnerId,
          id: runId,
          generation: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (await report({ ...progress, seq: 3, state: "completed" })).status,
      200,
    );
    assert.equal(
      (await report({ ...progress, seq: 3, state: "completed" })).status,
      200,
    );
    const denied = await mf.dispatchFetch(
      "https://example.com/api/private-sensitive-path?token=sensitive-query",
      { headers: { Cookie: "sensitive-cookie" } },
    );
    assert.equal(denied.status, 401);
    const failed = await mf.dispatchFetch("https://example.com/__test_failure");
    assert.equal(failed.status, 503);
    assert.match(
      failed.headers.get("X-Projects-Request-Id")!,
      /^[a-f0-9-]{36}$/,
    );
    const logs = (await (
      await mf.dispatchFetch("https://example.com/__test_logs")
    ).json()) as (TelemetryFields & { event: string; level: string })[];
    for (const event of [
      "conversation_created",
      "conversation_claimed",
      "feedback_queued",
      "feedback_reviewed",
      "native_finished",
      "runner_disconnected",
      "runner_reconnected",
      "alarm_reconciled",
      "progress_summary_saved",
      "conversation_state_changed",
    ])
      assert.equal(
        logs.filter((line) => line.event === event && line.runId === runId)
          .length,
        1,
        event,
      );
    const native = logs.find((line) => line.event === "native_finished")!;
    assert.equal(native.durationMs, 123456);
    assert.equal(native.turnId, turnId);
    assert.equal(native.eventId, eventId);
    assert.equal(
      logs.find((line) => line.event === "runner_disconnected")!
        .heartbeatAgeMs! >= 60000,
      true,
    );
    assert.ok(
      logs.some(
        (line) =>
          line.event === "request_finished" &&
          line.route === "/api/runner/report" &&
          line.status === 400,
      ),
    );
    assert.ok(
      logs.some(
        (line) =>
          line.status === 503 &&
          line.level === "error" &&
          line.requestId === failed.headers.get("X-Projects-Request-Id"),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(logs),
      /sensitive|private-error-content/,
    );
    assert.equal((await store.getRun(runId))?.state, "completed");
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

function archiveSnapshot(host: "studio" | "laptop", at = Date.now()): Snapshot {
  const source = {state: "ok" as const, message: "Observed", observedAt: at};
  const session = {id: "shared-session", title: "Review this project", app: "Codex" as const, cwd: "/fixture/project", updatedAt: at, state: "idle" as const, evidence: "Native turn completed"};
  return {version: 1, host, collectedAt: at, unassignedSessions: [], projects: [{
    id: "acme/fixture", name: "Fixture", repo: "acme/fixture", description: "", latestMerge: null,
    progress: {summary: "", next: [], completed: 0, total: 0, source: "", updatedAt: null},
    worktrees: [], pulls: [], sessions: [session, {...session, app: "Claude"}],
    sources: {git: source, github: source, codex: source, claude: source},
  }]};
}

test("archive choices require browser authorization and survive snapshot replacement, machine changes and restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-archive-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const collector = "c".repeat(64), runner = "r".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", COLLECTOR_TOKEN: collector, RUNNER_TOKEN: runner});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const post = (body: unknown, headers: Record<string, string> = {}) => mf.dispatchFetch(origin + "/api/archive", {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  try {
    let db = await store();
    const salt = token(), value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = {Cookie: `__Host-projects=${value}`, Origin: origin};
    const snapshot = archiveSnapshot("studio");
    await db.publish(snapshot);
    await db.publish(archiveSnapshot("laptop"));
    const session = {kind: "session", host: "studio", app: "Codex", sessionId: "shared-session"} as const;
    const project = {kind: "project", projectId: "acme/fixture"} as const;
    const input = {target: session, archived: true};
    const unauthorized: Record<string, string>[] = [{}, {Authorization: `Bearer ${collector}`}, {Authorization: `Bearer ${runner}`}];
    for (const headers of unauthorized)
      assert.equal((await post(input, {Origin: origin, ...headers})).status, 401);
    assert.equal((await post(input, {Cookie: browser.Cookie})).status, 403);
    assert.equal((await post(input, {...browser, Origin: "https://elsewhere.example"})).status, 403);
    assert.equal((await post({...input, arbitrary: "no"}, browser)).status, 400);
    assert.equal((await post({target: {...project, projectId: "unknown/project"}, archived: true}, browser)).status, 404);
    assert.equal((await post(input, browser)).status, 200);
    const first = await db.archives();
    assert.equal((await post(input, browser)).status, 200);
    assert.deepEqual(await db.archives(), first, "retries keep the original archive receipt");
    assert.equal(sessionArchived(first, "studio", "Codex", "shared-session"), true);
    assert.equal(sessionArchived(first, "laptop", "Codex", "shared-session"), false);
    assert.equal(sessionArchived(first, "studio", "Claude", "shared-session"), false);
    assert.equal((await post({target: project, archived: true}, browser)).status, 200);
    assert.deepEqual((await db.overview()).find((s) => s.host === "studio"), snapshot, "archive does not rewrite collector evidence");
    const refreshed = archiveSnapshot("studio", snapshot.collectedAt + 100);
    refreshed.projects[0].name = "Renamed fixture";
    refreshed.projects[0].sessions[0].cwd = "/moved/project";
    await db.publish(refreshed);
    const saved = await db.archives();
    await mf.dispose();
    mf = await start(config);
    db = await store();
    const view = await (await mf.dispatchFetch(origin + "/api/overview", {headers: browser})).json() as PortfolioView;
    assert.deepEqual(view.archives, saved);
    assert.equal(view.snapshots.find((s) => s.host === "studio")!.projects[0].name, "Renamed fixture");
    await db.publish({...refreshed, collectedAt: refreshed.collectedAt + 100, projects: []});
    assert.equal((await post({target: session, archived: false}, browser)).status, 200, "restore remains possible after an item disappears from inventory");
    assert.equal((await post({target: project, archived: false}, browser)).status, 200);
    assert.deepEqual(await db.archives(), []);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("conversation archives preserve active claims, receipts and history, with project filtering and legacy-index recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-conversation-archive-"));
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
    const run: Run = JSON.parse(JSON.stringify(await db.createRun({requestId: randomUUID(), text: "Inspect and keep history", projectId: null, agent: "auto", workIssue: null})));
    const owner = randomUUID();
    const claimed: Run = JSON.parse(JSON.stringify(await db.claimRun(owner, [], undefined, "studio")));
    const child = {id: randomUUID(), projectId: "acme/chosen", agent: "codex" as const, mode: "read" as const, cwd: "/fixture", branch: "main", sessionId: randomUUID(), state: "running" as const, result: null, evidence: []};
    const progress: Progress = {seq: 1, state: "running", summary: "Inspecting", children: [child], masterSessionId: randomUUID()};
    const route = origin + `/api/runs/${run.id}/archive`;
    const archive = (archived: boolean, headers: Record<string, string> = browser) => mf.dispatchFetch(route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify({archived})});
    const unauthorized: Record<string, string>[] = [{}, {Authorization: `Bearer ${runner}`}, {Authorization: `Bearer ${collector}`}];
    for (const headers of unauthorized)
      assert.equal((await archive(true, {Origin: origin, ...headers})).status, 401);
    assert.equal((await archive(true, {Cookie: browser.Cookie})).status, 403);
    const [archived, reported] = await Promise.all([archive(true), db.reportRun(owner, run.id, run.generation, progress, "studio")]);
    assert.equal(archived.status, 200);
    assert.equal(reported, true);
    const kept = (await db.getRun(run.id))!;
    assert.ok(kept.archivedAt);
    assert.equal(kept.state, "running");
    assert.equal(kept.generation, claimed.generation);
    assert.deepEqual(kept.messages, claimed.messages);
    assert.deepEqual(kept.progress, progress);
    assert.deepEqual(await db.listRuns(), []);
    assert.deepEqual((await db.listRuns({archived: true, projectId: child.projectId})).map((r) => r.id), [run.id]);
    assert.equal((await db.claimRun(owner, [], undefined, "studio"))!.id, run.id);
    assert.equal(await db.claimRun(randomUUID(), [], undefined, "studio"), null);
    assert.deepEqual((await db.getRun(run.id))!.messages, claimed.messages);
    assert.equal(await db.reportRun(owner, run.id, run.generation, {...progress, seq: 2, state: "completed", children: [{...child, state: "completed"}]}, "studio"), true);
    assert.ok((await db.getRun(run.id))!.archivedAt, "a later receipt cannot unarchive the conversation");
    // Existing pre-feature directory summaries do not contain selected child projects.
    const storage = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"});
    // ...nor the list title and status line added later.
    await storage.exec("UPDATE conversation_index SET payload=json_set(json_remove(payload,'$.projectIds','$.status'),'$.title',?) WHERE id=?", "x".repeat(160), run.id);
    await mf.dispose();
    mf = await start(config);
    db = await store();
    assert.deepEqual((await db.listRuns({archived: true, projectId: child.projectId})).map((r) => [r.projectIds, r.title, r.status]), [[[child.projectId], "Inspect and keep history", "Inspecting"]]);
    assert.equal((await db.getRun(run.id))!.messages.length, 2, "history survives archive and restart");
    assert.equal((await archive(false)).status, 200);
    const restored = (await db.getRun(run.id))!;
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.generation, claimed.generation);
    for (let i = 0; i < 51; i++) {
      const newer = await db.createRun({requestId: randomUUID(), text: `Other conversation ${i}`, projectId: "acme/other", agent: "auto", workIssue: null});
      await db.cancelRun(newer.id);
    }
    assert.equal((await db.listRuns()).length, 50);
    const filtered = await (await mf.dispatchFetch(origin + `/api/runs?projectId=${encodeURIComponent(child.projectId)}`, {headers: browser})).json() as {runs: {id: string}[]; nextOffset: number | null};
    assert.deepEqual(filtered.runs.map((r) => r.id), [run.id], "project filtering happens before the history limit");
    assert.equal(filtered.nextOffset, null);
    assert.equal((await db.listRuns({offset: 50})).length, 2);
    assert.equal((await mf.dispatchFetch(origin + "/api/runs?offset=-1", {headers: browser})).status, 400);
    // Done is a visibility choice: the user's own follow-up brings it back, once.
    assert.equal((await archive(true)).status, 200);
    const followUp = {requestId: randomUUID(), text: "Continue after Done"};
    const sent = async () => mf.dispatchFetch(origin + `/api/runs/${run.id}/message`, {
      method: "POST", headers: {...browser, "Content-Type": "application/json"},
      body: JSON.stringify(followUp),
    });
    assert.equal((await sent()).status, 200);
    assert.equal((await sent()).status, 200, "a retried follow-up is idempotent");
    const followed = (await db.getRun(run.id))!;
    assert.equal(followed.archivedAt, null);
    assert.equal(followed.generation, run.generation + 1);
    assert.equal(followed.state, "queued");
    assert.equal(followed.messages.filter((m) => m.id === followUp.requestId).length, 1);
    assert.deepEqual((await db.listRuns()).map((r) => r.id).includes(run.id), true);
    assert.equal((await archive(true)).status, 200);
    assert.equal((await db.claimRun(owner, [], undefined, "studio"))!.id, run.id, "archiving queued work does not silently cancel it");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("conversation lists lead with a short title, the current step and the email being handled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-summary-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), origin = "https://example.com";
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: "c".repeat(64)}));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const thread = "1a1324eccd4e4489";
    const input: RunInput = {requestId: randomUUID(), text: "Reply to Rob about “Re: November plan”\n\nSay Thursday works.\n\nEmail: [Re: November plan](https://mail.google.com/mail/u/#all/1a1324eccd4e4489) from Rob.", projectId: null, agent: "auto", workIssue: 942, emailThread: thread};
    assert.equal(runInputSchema.safeParse({...input, emailThread: "not-a-thread"}).success, false);
    const run: Run = JSON.parse(JSON.stringify(await db.createRun(input)));
    let [listed] = await db.listRuns();
    assert.deepEqual(
      {title: listed.title, status: listed.status, emailThread: listed.emailThread, workIssue: listed.workIssue, remaining: listed.remaining},
      {title: "Reply to Rob about “Re: November plan”", status: "Waiting for a free slot", emailThread: thread, workIssue: 942, remaining: null},
    );
    const owner = randomUUID();
    await db.claimRun(owner, [], undefined, "studio");
    const report = (progress: Progress) => mf.dispatchFetch(origin + "/api/runner/report", {
      method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"},
      body: JSON.stringify({runnerId: owner, id: run.id, generation: run.generation, progress}),
    });
    const note = {id: randomUUID(), at: Date.now(), actor: "codex" as const, childId: null, done: ["Read the thread"], remaining: ["Draft the reply", "Save it in Gmail"], blocker: null};
    const running: Progress = {seq: 1, state: "running", title: "Reply to Rob about training", summary: "Asked Codex to draft it.\n\nwork: #942", children: [], masterSessionId: null, notes: [note]};
    assert.equal((await report({...running, title: "x".repeat(81)})).status, 400, "titles stay short");
    assert.equal((await report(running)).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.title, listed.status, listed.remaining, listed.needsYou], ["Reply to Rob about training", "Draft the reply", 2, false]);
    // Only steps the user must take put a running conversation in their move.
    assert.equal((await report({...running, seq: 2, notes: [{...note, id: randomUUID(), at: Date.now() + 1, yourMove: "Sign in to Gmail on the Studio"}]})).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.state, listed.status, listed.needsYou], ["running", "Sign in to Gmail on the Studio", true]);
    assert.equal((await report({...running, seq: 3, state: "completed", notes: [], reviewedMessageIds: [run.id], summary: "Drafted the [reply to Rob](https://mail.google.com/mail/u/#all/1a13ab). **Your move:** send it.\n\nwork: #942"})).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.state, listed.title, listed.status, listed.remaining], ["completed", "Reply to Rob about training", "Drafted the reply to Rob.", null]);
    assert.equal((await db.getRun(run.id))!.emailThread, thread);
    // The inbox joins every email conversation, including Done ones, in one read.
    await db.createRun({requestId: randomUUID(), text: "Not from email", projectId: null, agent: "auto", workIssue: null});
    await db.archiveRun(run.id, true);
    assert.deepEqual((await db.listRuns()).map((r) => r.emailThread ?? null), [null]);
    const email = await db.listRuns({email: true});
    assert.deepEqual(email.map((r) => [r.id, r.emailThread, !!r.archivedAt]), [[run.id, thread, true]]);
    const browser = await (await mf.dispatchFetch(origin + "/api/runs?email=true")).status;
    assert.equal(browser, 401, "the email join still needs the signed-in owner");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

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

test("quick work is claimed only into a free quick slot and has its own capacity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-lanes-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: "r".repeat(64)}));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const create = (text: string, lane?: "quick") => db.createRun({requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null, ...(lane ? {lane} : {})});
    const big = await create("Refactor the importer");
    const reply = await create("Reply to Rob", "quick");
    const runner = randomUUID();
    assert.equal((await db.claimRun(runner, [], ["quick"], "studio"))!.id, reply.id, "a full standard pool still takes quick work");
    assert.equal(await db.claimRun(runner, [reply.id], ["quick"], "studio"), null, "standard work waits for a standard slot");
    assert.equal((await db.claimRun(runner, [reply.id], ["standard", "quick"], "studio"))!.id, big.id);
    assert.equal((await db.listRuns()).find((r) => r.id === reply.id)!.lane, "quick");
    // Ten standard conversations fill their bound; quick work can still start.
    for (let i = 0; i < 9; i++) await create(`Standard ${i}`);
    await assert.rejects(create("One too many"));
    for (let i = 0; i < 5; i++) await create(`Reply ${i}`, "quick");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("five-minute summaries survive alarms, duplicate receipts, restart and disconnection without replaying work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-progress-")),
    script = path.join(dir, "worker.mjs");
  await build({
    stdin: {
      contents: `export {default,Portfolio} from './worker/index'; import {Conversation as Base} from './worker/runs'; export class Conversation extends Base { triggerAlarm() { return super.alarm(); } }`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir);
  let mf = await start(config);
  const owner = randomUUID(),
    runId = randomUUID();
  const name = JSON.stringify(["test", runId]);
  const store = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  const object = async () => {
    const ns = await mf.getDurableObjectNamespace("CONVERSATIONS");
    return ns.get(ns.idFromName(name)) as unknown as Conversation & {
      triggerAlarm(): Promise<void>;
    };
  };
  const makeDue = async (disconnected = false, duration = 300_000) => {
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name },
    );
    await storage.exec(
      "UPDATE progress_window SET payload=json_set(payload,'$.from',?)",
      Date.now() - duration,
    );
    await storage.exec(
      "UPDATE agent_runs SET payload=json_set(payload,'$.nextUpdateAt',?,'$.heartbeatAt',?)",
      Date.now() - 1,
      disconnected ? 0 : Date.now(),
    );
  };
  try {
    let portfolio = await store();
    await portfolio.createRun({
      requestId: runId,
      text: "Inspect progress",
      projectId: null,
      agent: "auto",
      workIssue: null,
    });
    assert.equal((await portfolio.getRun(runId))?.nextUpdateAt, undefined);
    const claim = await portfolio.claimRun(owner, [], undefined, "studio");
    assert.ok(claim?.nextUpdateAt && claim.nextUpdateAt > Date.now() + 290_000);
    const note = {
      id: randomUUID(),
      at: Date.now(),
      actor: "codex" as const,
      childId: null,
      done: ["Checked the implementation"],
      remaining: ["Run tests", "Verify deployment"],
      blocker: null,
    };
    const receipt: Progress = {
      seq: 1,
      state: "running",
      summary: "Checking",
      children: [],
      masterSessionId: null,
      activity: [
        {
          id: randomUUID(),
          at: Date.now(),
          actor: "codex",
          childId: null,
          kind: "command",
          state: "finished",
        },
      ],
      notes: [note],
    };
    await portfolio.reportRun(owner, runId, 1, receipt, "studio");
    await portfolio.reportRun(owner, runId, 1, receipt, "studio");
    await portfolio.reportRun(owner, runId, 1, { ...receipt, seq: 2 }, "studio");
    await portfolio.heartbeatRun(owner, runId, 1, "studio");
    assert.equal(
      (await portfolio.getRun(runId))?.nextUpdateAt, claim!.nextUpdateAt,
    );
    await (await object()).triggerAlarm();
    assert.equal((await portfolio.getRun(runId))?.updates?.length ?? 0, 0);
    await makeDue();
    await (await object()).triggerAlarm();
    let run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, 1);
    assert.deepEqual(run.updates[0].done, note.done);
    assert.deepEqual(run.updates[0].operations, { command: 1 });
    assert.deepEqual(run.updates[0].note?.remaining, note.remaining);
    assert.equal(run.updates[0].disconnected, false);
    assert.equal(run.generation, 1);
    await mf.dispose();
    mf = await start(config);
    portfolio = await store();
    await (await object()).triggerAlarm();
    assert.equal((await portfolio.getRun(runId))?.updates?.length, 1);
    await portfolio.archiveRun(runId, true);
    await makeDue(true);
    await (await object()).triggerAlarm();
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, 2);
    assert.deepEqual(run.updates[1].done, []);
    assert.deepEqual(run.updates[1].operations, {});
    assert.equal(run.updates[1].note?.at, note.at);
    assert.equal(run.updates[1].disconnected, true);
    assert.ok(run.nextUpdateAt && run.nextUpdateAt > Date.now());
    assert.equal(await portfolio.claimRun(randomUUID(), [], undefined, "studio"), null);
    await portfolio.heartbeatRun(owner, runId, 1, "studio");
    await portfolio.reportRun(owner, runId, 1, {
      ...receipt,
      seq: 3,
      state: "completed",
      reviewedMessageIds: [runId],
    }, "studio");
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.state, "completed");
    assert.equal(run.nextUpdateAt, null);
    assert.equal(run.updates?.at(-1)?.state, "completed");
    const count = run.updates!.length;
    await (await object()).triggerAlarm();
    assert.equal((await portfolio.getRun(runId))?.updates?.length, count);
    await portfolio.archiveRun(runId, false);
    await portfolio.messageRun(runId, {
      requestId: randomUUID(),
      text: "Continue",
    });
    const follow = await portfolio.claimRun(owner, [], undefined, "studio");
    assert.equal(follow?.generation, 2);
    await makeDue();
    await (await object()).triggerAlarm();
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.at(-1)?.note, null);
    assert.deepEqual(run.updates?.at(-1)?.done, []);
    assert.equal(run.updates?.at(-1)?.generation, 2);
    assert.equal(run.updates?.length, count + 1);
    await makeDue(false, 20 * 60_000);
    await (await object()).triggerAlarm();
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, count + 2, "delays create one honest interval, not invented backfill");
    const delayed = run.updates!.at(-1)!;
    assert.ok(delayed.to - delayed.from >= 20 * 60_000);
    for (let i = 0; i < 26; i++) {
      await makeDue();
      await (await object()).triggerAlarm();
    }
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, 24);
    assert.equal(new Set(run.updates!.map(update => update.id)).size, 24);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex speed is owner-only, durable, shared with runners and metrics are deduplicated", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"projects-speed-")), script=path.join(dir,"worker.mjs");
  await build({entryPoints:["worker/index.ts"],bundle:true,format:"esm",platform:"browser",external:["cloudflare:workers","node:*"],outfile:script});
  const runner="r".repeat(64), collector="c".repeat(64), secondRunner="s".repeat(64), origin="https://example.com";
  const config=await options(script,dir,{RUNNER_TOKEN:runner,COLLECTOR_TOKEN:collector,LAPTOP_RUNNER_TOKEN:secondRunner,ALLOWED_EMAILS:"owner@example.com"});
  let mf=await start(config);
  const getStore=async()=>{const ns=await mf.getDurableObjectNamespace("PORTFOLIOS");return ns.get(ns.idFromName("test")) as unknown as Portfolio;};
  try {
    let db=await getStore(); const salt=token(), cookie=token();
    await db.issue("owner@example.com",salt,digest(`${salt}:123456`)); await db.verify("owner@example.com","123456",digest(cookie));
    const user={Cookie:`__Host-projects=${cookie}`,Origin:origin};
    const post=(route:string,body:unknown,headers:Record<string,string>=user)=>mf.dispatchFetch(origin+route,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
    for(const headers of [{},{Authorization:`Bearer ${runner}`},{Authorization:`Bearer ${collector}`}] as Record<string,string>[]) {
      assert.equal((await mf.dispatchFetch(origin+"/api/execution-settings",{headers})).status,401);
      assert.equal((await post("/api/execution-settings",{codexFast:true},{Origin:origin,...headers})).status,401);
    }
    assert.equal((await db.executionSettings()).codexFast,false);
    assert.equal((await post("/api/execution-settings",{codexFast:true},{Cookie:user.Cookie})).status,403);
    assert.equal((await post("/api/execution-settings",{codexFast:true,extra:1})).status,400);
    assert.equal((await post("/api/execution-settings",{codexFast:true})).status,200);
    for(const credential of [runner,secondRunner]) {
      const claim=await (await post("/api/runner/claim",{runnerId:randomUUID(),activeRunIds:[]},{Authorization:`Bearer ${credential}`})).json() as {settings:{codexFast:boolean}};
      assert.equal(claim.settings.codexFast,true);
    }
    const run=await db.createRun({requestId:randomUUID(),text:"Inspect",projectId:null,agent:"auto",workIssue:null});
    const runId=run.id;
    const owner=randomUUID(); await db.claimRun(owner,[],undefined,"studio");
    const event={id:randomUUID(),at:Date.now(),event:"native_finished" as const,actor:"master" as const,agent:"codex" as const,codexFast:true,model:"model-a",effort:"high",mode:"read" as const,resumed:false,attempts:1,tokenUsageObserved:true,durationMs:1000,freshTokens:200,cachedTokens:0,outputTokens:100,outcome:"completed" as const};
    const report:Progress={seq:1,state:"running",summary:"Progress",children:[],masterSessionId:null,telemetry:[event]};
    assert.equal(await db.reportRun(randomUUID(),run.id,1,report,"studio"),false);
    assert.equal((await db.executionSettingsView()).metrics.retained,0);
    assert.equal(await db.reportRun(owner,run.id,1,report,"studio"),true);
    assert.equal(await db.reportRun(owner,run.id,1,report,"studio"),true);
    assert.equal(await db.reportRun(owner,run.id,1,{...report,seq:2},"studio"),true);
    assert.equal(await db.reportRun(owner,run.id,1,{...report,telemetry:[{...event,id:randomUUID()}]},"studio"),true);
    assert.equal((await db.executionSettingsView()).metrics.fast,1);
    await mf.dispose(); mf=await start(config); db=await getStore();
    assert.equal((await db.executionSettings()).codexFast,true);
    assert.equal((await db.executionSettingsView()).metrics.fast,1);
    await post("/api/execution-settings",{codexFast:false});
    const heartbeat=await (await post("/api/runner/heartbeat",{runnerId:owner,id:runId,generation:1},{Authorization:`Bearer ${runner}`})).json() as {settings:{codexFast:boolean}};
    assert.equal(heartbeat.settings.codexFast,false,"existing claimed conversations receive the new preference");
  } finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});

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

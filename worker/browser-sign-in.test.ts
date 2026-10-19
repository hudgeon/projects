import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio, Conversation } from "./index";
import { emailLinks } from "../src/work-model";
import { issue } from "../tests/work-fixtures";
import { randomUUID } from "node:crypto";
import type { Run } from "../src/run-model";
import type { Person } from "../src/people-model";
import { snapshotSchema, type PortfolioView } from "../src/model";
import { start, options } from "./miniflare-fixtures";
import { inboxSnapshot } from "./snapshot-fixtures";

test("a machine the deployment signs in gets each conversation browser signed in, within limits, until it ends", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-browser-sign-in-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/browser-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), laptop = "l".repeat(64), origin = "https://projects.example.com";
  const values = {RUNNER_TOKEN: runner, LAPTOP_RUNNER_TOKEN: laptop, ALLOWED_EMAILS: "owner@example.com, matt.smith@example.com", OWNER_EMAIL: "Owner@Example.com", SITE_URL: origin, BROWSER_SIGN_IN: "studio"};
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
  const open = async (bearer: string, runnerId = randomUUID(), owner = "owner@example.com") => {
    const db = await getStore();
    const run = await db.createRun({requestId: randomUUID(), text: "Check the page", projectId: null, agent: "auto", workIssue: null}, owner);
    const claimed = await (await post("/api/runner/claim", {runnerId, activeRunIds: []}, {Authorization: `Bearer ${bearer}`})).json() as {run: Run | null; browserSignIn?: string};
    assert.ok(claimed.run);
    const grant = await (await post("/api/runner/browser", {runnerId, id: run.id, generation: 1}, {Authorization: `Bearer ${bearer}`})).json() as {capability: string};
    const connection = await mf.dispatchFetch(`${origin}/api/browser/${run.id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${grant.capability}`}});
    assert.equal(connection.status, 101);
    connection.webSocket!.accept(); connection.webSocket!.close();
    // Values only: RPC results are stubs a restart poisons.
    return {id: run.id, grant: {capability: grant.capability}, conversation: await getConversation(run.id), browserSignIn: claimed.browserSignIn};
  };
  const cookieOf = async (conversation: BrowserTest) => (await conversation.inspectProvider()).signIns?.at(-1)?.cookies[0];
  try {
    // Another machine's browsers still sign in by hand. (It claims first: new
    // work goes to the first machine in order that has called recently.)
    const other = await open(laptop);
    assert.equal((await other.conversation.inspectProvider()).signIns, null);
    assert.equal(other.browserSignIn, "manual");
    const before = Date.now();
    const first = await open(runner);
    assert.equal(first.browserSignIn, "owner", "the claim says the browser starts as the conversation's owner");
    const cookie = (await cookieOf(first.conversation))!;
    assert.deepEqual({...cookie, value: "", expires: 0}, {name: "__Host-projects", value: "", url: origin, path: "/", secure: true, httpOnly: true, sameSite: "Strict", expires: 0}, "a host-only cookie like the site's own");
    assert.match(cookie.value, /^[a-f0-9]{64}$/);
    assert.ok(cookie.expires * 1000 <= before + 30 * 60_000 + 1000, "it ends with the browser");
    assert.doesNotMatch(JSON.stringify([first.grant, await (await getStore()).getRun(first.id)]), new RegExp(cookie.value), "the runner never receives it");
    assert.equal(await overview(cookie.value), 200, "the browser sees Projects as the owner");
    assert.deepEqual(await (await mf.dispatchFetch(origin + "/api/me", {headers: as(cookie.value)})).json(), {email: "owner@example.com", name: "Owner"});
    // Another person's conversation gets a browser signed in as them.
    const matts = await open(runner, randomUUID(), "matt.smith@example.com");
    assert.deepEqual(await (await mf.dispatchFetch(origin + "/api/me", {headers: as((await cookieOf(matts.conversation))!.value)})).json(), {email: "matt.smith@example.com", name: "Matt Smith"});
    const machines = await (await mf.dispatchFetch(origin + "/api/machines", {headers: as(cookie.value)})).json() as {machines: {id: string; browserSignIn?: boolean}[]};
    assert.deepEqual(machines.machines.map((m) => [m.id, m.browserSignIn]), [["studio", true], ["laptop", false]]);
    // What outlives the browser or reaches beyond it stays with the owner's own sign-in.
    for (const [route, body] of [["/api/machines", {name: "Spare"}], ["/api/machines/laptop/tokens", {}], ["/api/machines/laptop/remove", {}], ["/api/execution-settings", {fast: true}], [`/api/runs/${first.id}/browser/view`, {readonly: false}], ["/api/inbox/act", {}], ["/api/push/subscribe", {endpoint: "https://fcm.googleapis.com/x"}]] as const)
      assert.equal((await post(route, body, as(cookie.value))).status, 403, route);
    assert.equal((await mf.dispatchFetch(origin + "/api/inbox/threads/abcdef1234", {headers: as(cookie.value)})).status, 403, "email text never reaches it");
    // Nor do the inbox's subjects, senders or queued actions, a work item's
    // email threads, or a conversation started from an email.
    const linked = "## Email threads\n- [Contract](https://mail.google.com/mail/u/0/#inbox/bbbbbbbbbb01) · context: signing";
    const mailed = inboxSnapshot();
    mailed.work.issues = [issue(7, {body: "## Current position\nStatus: open.", emailLinks: emailLinks(linked)})];
    await (await getStore()).publish(snapshotSchema.parse(mailed));
    await (await getStore()).requestInboxAction("bbbbbbbbbb01", "archive");
    const fromEmail = await (await getStore()).createRun({requestId: randomUUID(), text: "Email: [Contract](https://mail.google.com/mail/u/0/#inbox/bbbbbbbbbb01)", projectId: null, agent: "auto", workIssue: null, emailThread: "bbbbbbbbbb01"}, "owner@example.com");
    await (await getStore()).cancelRun(fromEmail.id);
    assert.ok((await (await getStore()).listRuns({})).some((run) => run.id === fromEmail.id));
    const seen = await (await mf.dispatchFetch(origin + "/api/overview", {headers: as(cookie.value)})).json() as PortfolioView;
    assert.equal(seen.emailHidden, true);
    assert.deepEqual(seen.inboxActions, []);
    assert.ok(seen.snapshots.length && seen.snapshots.every((s) => !s.inbox));
    assert.match(JSON.stringify(seen), /Status: open\./, "the rest of the work item stays");
    assert.doesNotMatch(JSON.stringify(seen), /Weekly news|news@news|Contract|mail\.google|bbbbbbbbbb01|owner@example\.com/);
    const listing = async (query: string) => (await (await mf.dispatchFetch(`${origin}/api/runs${query}`, {headers: as(cookie.value)})).json() as {runs: {id: string}[]}).runs.map((run) => run.id);
    assert.ok((await listing("")).includes(first.id));
    assert.ok(!(await listing("")).includes(fromEmail.id));
    assert.deepEqual(await listing("?email=true"), []);
    assert.equal((await mf.dispatchFetch(`${origin}/api/runs/${fromEmail.id}`, {headers: as(cookie.value)})).status, 404);
    for (const [action, body] of [["archive", {archived: true}], ["message", {requestId: randomUUID(), text: "Reply"}], ["cancel", {}], ["move", {}]] as const)
      assert.equal((await post(`/api/runs/${fromEmail.id}/${action}`, body, as(cookie.value))).status, 404, action);
    assert.equal((await mf.dispatchFetch(`${origin}/api/runs/${fromEmail.id}/screenshots/${randomUUID()}`, {headers: as(cookie.value)})).status, 404);
    assert.equal((await mf.dispatchFetch(`${origin}/api/runs/${fromEmail.id}/browser`, {headers: as(cookie.value)})).status, 404);
    const retried = await post("/api/runs", {requestId: fromEmail.id, text: "Check the page", projectId: null, agent: "auto", workIssue: null}, as(cookie.value));
    assert.equal(retried.status, 409);
    assert.doesNotMatch(await retried.text(), /Contract|mail\.google/, "a retry never returns it");
    assert.equal((await post("/api/runs", {requestId: randomUUID(), text: "Reply", projectId: null, agent: "auto", workIssue: null, emailThread: "bbbbbbbbbb01"}, as(cookie.value))).status, 403);
    assert.equal((await mf.dispatchFetch(`${origin}/api/runs/${first.id}`, {headers: as(cookie.value)})).status, 200);
    // The owner's own sign-in still sees all of it.
    const ownerSalt = token(), ownerValue = token();
    await (await getStore()).issue("owner@example.com", ownerSalt, digest(`${ownerSalt}:123456`));
    await (await getStore()).verify("owner@example.com", "123456", digest(ownerValue));
    const full = await (await mf.dispatchFetch(origin + "/api/overview", {headers: as(ownerValue)})).json() as PortfolioView;
    assert.equal(full.emailHidden, undefined);
    assert.equal(full.inboxActions?.length, 1);
    assert.match(JSON.stringify(full), /Weekly news[\s\S]*bbbbbbbbbb01/);
    assert.ok((await (await mf.dispatchFetch(`${origin}/api/runs?email=true`, {headers: as(ownerValue)})).json() as {runs: {id: string}[]}).runs.some((run) => run.id === fromEmail.id));
    assert.equal((await mf.dispatchFetch(`${origin}/api/runs/${fromEmail.id}`, {headers: as(ownerValue)})).status, 200);
    assert.equal((await mf.dispatchFetch(`${origin}/api/runs/${fromEmail.id}/browser`, {headers: as(ownerValue)})).status, 200);
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
    const refusedRun = await (await getStore()).createRun({requestId: randomUUID(), text: "Refused", projectId: null, agent: "auto", workIssue: null}, "owner@example.com");
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

test("a conversation browser signs in only as an owner the allowlist names, and the claim says so", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-browser-owner-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/browser-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), origin = "https://projects.example.com";
  const config = await options(script, dir, {RUNNER_TOKEN: runner, ALLOWED_EMAILS: "owner@example.com", OWNER_EMAIL: "former@example.com", SITE_URL: origin, BROWSER_SIGN_IN: "studio"});
  let mf = await start(config);
  const bearer = {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"};
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  // Claims a conversation and opens its browser: the claim's word on sign-in, and the cookie set, if any.
  const open = async (owner: string, legacy = false) => {
    // A value, not the RPC result: a restart poisons its stub.
    const id = (await (await store()).createRun({requestId: randomUUID(), text: "Check the page", projectId: null, agent: "auto", workIssue: null}, owner)).id;
    if (legacy) {
      const storage = await mf.unsafeGetDurableObjectStorage("test", "Conversation", {name: JSON.stringify(["test", id])});
      await storage.exec("UPDATE agent_runs SET payload=json_remove(payload,'$.owner')");
      await mf.dispose(); mf = await start(config);
    }
    const runnerId = randomUUID();
    const claimed = await (await mf.dispatchFetch(origin + "/api/runner/claim", {method: "POST", headers: bearer, body: JSON.stringify({runnerId, activeRunIds: []})})).json() as {run: Run | null; person: Person | null; browserSignIn: string};
    assert.equal(claimed.run?.id, id);
    const grant = await (await mf.dispatchFetch(origin + "/api/runner/browser", {method: "POST", headers: bearer, body: JSON.stringify({runnerId, id, generation: 1})})).json() as {capability: string};
    const connection = await mf.dispatchFetch(`${origin}/api/browser/${id}/cdp`, {headers: {Upgrade: "websocket", Authorization: `Bearer ${grant.capability}`}});
    assert.equal(connection.status, 101); connection.webSocket!.accept(); connection.webSocket!.close();
    const cns = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const conversation = cns.get(cns.idFromName(JSON.stringify(["test", id]))) as unknown as {inspectProvider(): Promise<{signIns: {cookies: {value: string}[]}[] | null}>};
    return {person: claimed.person, browserSignIn: claimed.browserSignIn, cookie: (await conversation.inspectProvider()).signIns?.at(-1)?.cookies[0]?.value ?? null};
  };
  try {
    const gone = await open("gone@example.com");
    assert.deepEqual([gone.person, gone.browserSignIn, gone.cookie], [{email: "gone@example.com", name: "Gone"}, "not_allowed", null], "an owner the allowlist does not name gets no cookie, and the claim says so");
    const legacy = await open("owner@example.com", true);
    assert.deepEqual([legacy.person, legacy.browserSignIn, legacy.cookie], [{email: "former@example.com", name: "Former"}, "not_allowed", null], "nor does the deployment owner of a conversation from before profiles, once no longer allowed");
    const owners = await open("owner@example.com");
    assert.deepEqual([owners.person, owners.browserSignIn], [{email: "owner@example.com", name: "Owner"}, "owner"]);
    assert.equal((await mf.dispatchFetch(origin + "/api/overview", {headers: {Cookie: `__Host-projects=${owners.cookie}`}})).status, 200, "an allowed owner's browser is signed in as them");
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});

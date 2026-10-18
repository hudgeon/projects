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
import { start, options } from "./miniflare-fixtures";
import { archiveSnapshot } from "./snapshot-fixtures";

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

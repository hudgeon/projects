import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runChecks } from "./run-checks";
import { JEV_MODEL, type Selector } from "./context";
import type { Child, ProgressNote } from "../src/run-model";
import { fixture, waitFor } from "./run-fixtures";

const reply = (body: {questions: Record<string, unknown>}, p = 0.8) =>
  Response.json({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, {type: "noul", noul: p}])), usage: {input_tokens: 120, output_tokens: 0}});
const helper = (summary: string): Child => ({
  id: randomUUID(), projectId: "acme/test", agent: "claude", mode: "change", cwd: "/private/worktree", branch: "projects/x",
  sessionId: "private-session", state: "completed", result: {outcome: "completed", summary, checks: ["Tests passed"], links: []},
  evidence: ["Observed HEAD: private-sha"], host: "studio",
});
const receipts = async (dir: string) => {
  const files = (await readdir(path.join(dir, "run-checks")).catch(() => [])).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, "run-checks", f), "utf8"))));
};

test("before a dispatch, Jev judges each finished report against the brief, seeing only the brief and the reports", async () => {
  const dir = await fixture(), bodies: any[] = [], urls: string[] = [], metadata: any[] = [];
  const selector: Selector = {mode: "select", key: async () => "fixture-key", gateway: {accountId: "a".repeat(32), gatewayId: "projects"}, fetch: async (url, init) => {
    urls.push(String(url)); metadata.push(JSON.parse((init!.headers as Record<string, string>)["cf-aig-metadata"]));
    const body = JSON.parse(init!.body as string); bodies.push(body); return reply(body);
  }};
  try {
    const checks = runChecks({selector, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal});
    const done = helper("Merged the refresh fix and installed it on both machines."), running = {...helper("x"), state: "running" as const, result: null};
    const next = {...running, id: randomUUID()};
    checks.dispatch("Check the refresh fix is merged and installed on both machines", next, [done, running, next]);
    await waitFor(async () => (await receipts(dir)).length === 1, 5000);
    const [receipt] = await receipts(dir);
    assert.equal(receipt.kind, "repeat");
    assert.equal(receipt.child, next.id, "the receipt names the dispatched helper");
    assert.deepEqual(receipt.judged, {[done.id]: 0.8});
    assert.deepEqual(receipt.parts, {[done.id]: {covers: 0.8, beyond: 0.8}}, "both judgments are kept for policy in code");
    assert.equal(receipt.omittedReports, undefined);
    assert.deepEqual(Object.keys(bodies[0].state), ["brief", "reports"]);
    assert.deepEqual(bodies[0].state.reports, [{id: done.id, state: "completed", summary: done.result!.summary, checks: ["Tests passed"]}]);
    assert.equal(Object.keys(bodies[0].questions).length, 2, "one report, two questions");
    assert.match(bodies[0].questions.keep_0.instructions, /already show as done or verified something/);
    assert.match(bodies[0].questions.keep_1.instructions, /ask for something that the report/);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /private-/, "no paths, sessions or evidence");
    assert.match(urls[0], /custom-typesafe\/v1\/systemone$/);
    assert.deepEqual([metadata[0].process, metadata[0].trigger], ["run-checks", "dispatch-check"]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a dispatch check with more reports than the request can hold drops the oldest and counts them, instead of failing", async () => {
  const dir = await fixture(), bodies: any[] = [];
  const selector: Selector = {mode: "select", key: async () => "fixture-key", fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); bodies.push(body); return reply(body);
  }};
  try {
    const checks = runChecks({selector, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal});
    const done = Array.from({length: 8}, (_, i) => ({...helper(`Report ${i} ${"finished detail ".repeat(200)}`), result: {outcome: "completed" as const, summary: `Report ${i} ${"finished detail ".repeat(200)}`, checks: Array.from({length: 8}, (_, j) => `Check ${j} ${"evidence ".repeat(30)}`), links: []}}));
    const next = {...helper("x"), id: randomUUID(), state: "running" as const, result: null};
    checks.dispatch(`Verify delivery ${"of every part ".repeat(400)}`, next, [...done, next]);
    await waitFor(async () => (await receipts(dir)).length === 1, 5000);
    const [receipt] = await receipts(dir);
    assert.equal(bodies.length, 1, "judged in one request that fits");
    assert.ok(Buffer.byteLength(JSON.stringify(bodies[0].state)) <= 30_000);
    const kept = bodies[0].state.reports.map((r: {id: string}) => r.id);
    assert.ok(kept.length < 8 && kept.length >= 1);
    assert.deepEqual(kept, done.slice(-kept.length).map((c) => c.id), "the newest reports stay");
    assert.equal(receipt.omittedReports, 8 - kept.length);
    assert.equal(receipt.inputs.reports.length, kept.length, "the receipt holds what Jev saw");
    assert.equal(Object.keys(receipt.judged).length, kept.length);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("at a progress note, Jev rates that helper's recent notes on four signs; nothing runs when off or with nothing to judge, and a failure is only recorded", async () => {
  const dir = await fixture(), bodies: any[] = [];
  const ok: Selector = {mode: "shadow", key: async () => "fixture-key", fetch: async (_url, init) => { const body = JSON.parse(init!.body as string); bodies.push(body); return reply(body, 0.3); }};
  const a = randomUUID(), b = randomUUID();
  const note = (childId: string, done: string[], at: number): ProgressNote => ({id: randomUUID(), at, actor: "claude", childId, done, remaining: ["Wait for the review"], yourMove: null});
  const notes = [note(a, ["Read the code"], 1), note(b, ["Other helper's step"], 2), note(a, [], 3)];
  try {
    runChecks({selector: ok, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal}).progress(a, notes);
    await waitFor(async () => (await receipts(dir)).length === 1, 5000);
    const [receipt] = await receipts(dir);
    assert.deepEqual(receipt.judged, {progressing: 0.3, repeating: 0.3, waiting: 0.3, blocked: 0.3});
    assert.equal(receipt.child, a);
    assert.deepEqual(bodies[0].state.notes.map((n: {done: string[]}) => n.done), [["Read the code"], []], "only this helper's notes, oldest first");
    assert.equal(Object.keys(bodies[0].questions).length, 4);

    const calls: unknown[] = [];
    const off = runChecks({selector: {...ok, mode: "off", fetch: async () => { calls.push(1); return Response.json({}); }}, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal});
    off.progress(a, notes); off.dispatch("Brief", helper("Next"), [helper("Done")]);
    const on = runChecks({selector: ok, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal});
    const resumed = helper("Its own earlier report");
    on.dispatch("Brief", helper("Next"), [{...helper("x"), result: null}]);
    on.dispatch("Continue", resumed, [resumed]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls.length, 0);
    assert.equal((await receipts(dir)).length, 1);

    const failing: Selector = {mode: "select", key: async () => "fixture-key", fetch: async () => { throw new TypeError("private host", {cause: {code: "ENOTFOUND"}}); }};
    runChecks({selector: failing, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal, keep: 1}).progress(a, notes);
    await waitFor(async () => (await receipts(dir)).length === 1 && (await receipts(dir))[0].reason === "service_failed", 5000);
    const [failed] = await receipts(dir);
    assert.equal(failed.failure.kind, "dns");
    assert.equal(failed.judged, undefined);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("Jev labels a long command from its redacted text, only when one category is likely enough, and never sees a credential-like one", async () => {
  const dir = await fixture(), bodies: any[] = [];
  let ratings: number[] = [];
  const selector: Selector = {mode: "select", key: async () => "fixture-key", fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); bodies.push(body);
    return Response.json({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, {type: "noul", noul: ratings[i] ?? 0.1}])), usage: {input_tokens: 80, output_tokens: 0}});
  }};
  try {
    const checks = runChecks({selector, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal});
    const child = randomUUID();
    ratings = [0.1, 0.2, 0.1, 0.1, 0.9, 0.1, 0.1, 0.3, 0.7];
    assert.equal(await checks.label(child, "DEPLOY_TOKEN=dp.st.prd.abcdefghijklmnopqrstuvwxyz ./scripts/release.sh"), "deploy");
    assert.deepEqual(bodies[0].state, {command: "DEPLOY_TOKEN=[redacted] ./scripts/release.sh"});
    assert.equal(Object.keys(bodies[0].questions).length, 9);
    const [receipt] = await receipts(dir);
    assert.deepEqual([receipt.kind, receipt.child, receipt.judged.deploy, receipt.judged.waitsForInput], ["wait", child, 0.9, 0.7]);
    ratings = [0.4, 0.45];
    assert.equal(await checks.label(child, "./scripts/custom.sh"), undefined, "no category likely enough");
    assert.equal(await checks.label(child, `echo 'password: "my long pass phrase"'`), undefined);
    assert.equal(bodies.length, 2, "a command still credential-like is never sent");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

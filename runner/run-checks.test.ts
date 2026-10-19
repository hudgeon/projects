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
    checks.dispatch("Check the refresh fix is merged and installed on both machines", [done, running]);
    await waitFor(async () => (await receipts(dir)).length === 1, 5000);
    const [receipt] = await receipts(dir);
    assert.equal(receipt.kind, "repeat");
    assert.deepEqual(receipt.judged, {[done.id]: 0.8});
    assert.deepEqual(Object.keys(bodies[0].state), ["brief", "reports"]);
    assert.deepEqual(bodies[0].state.reports, [{id: done.id, state: "completed", summary: done.result!.summary, checks: ["Tests passed"]}]);
    assert.equal(Object.keys(bodies[0].questions).length, 1);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /private-/, "no paths, sessions or evidence");
    assert.match(urls[0], /custom-typesafe\/v1\/systemone$/);
    assert.deepEqual([metadata[0].process, metadata[0].trigger], ["run-checks", "dispatch-check"]);
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
    assert.deepEqual(bodies[0].state.notes.map((n: {done: string[]}) => n.done), [["Read the code"], []], "only this helper's notes, oldest first");
    assert.equal(Object.keys(bodies[0].questions).length, 4);

    const calls: unknown[] = [];
    const off = runChecks({selector: {...ok, mode: "off", fetch: async () => { calls.push(1); return Response.json({}); }}, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal});
    off.progress(a, notes); off.dispatch("Brief", [helper("Done")]);
    runChecks({selector: ok, stateDir: dir, runId: randomUUID(), signal: new AbortController().signal}).dispatch("Brief", [{...helper("x"), result: null}]);
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

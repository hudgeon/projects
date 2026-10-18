import { test } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "./pool";
import { makeRun, deferred, waitFor } from "./run-fixtures";

test("the pool overlaps conversations, bounds capacity and isolates cancellation", {timeout: 5000}, async () => {
  const runs = [makeRun(), makeRun(), makeRun()];
  const queue = [...runs];
  const shutdown = new AbortController();
  const started: string[] = [], claims: string[][] = [], errors: unknown[] = [];
  const controls = new Map<string, AbortController>();
  const entered = runs.map(() => deferred());
  const pool = runPool({
    concurrency: 2, signal: shutdown.signal, pollMs: 1,
    claim: async active => {
      claims.push(active);
      const run = queue.shift();
      return run ? {run, activity: []} : null;
    },
    execute: async ({run}, control) => {
      controls.set(run.id, control);
      started.push(run.id);
      entered[runs.findIndex(r => r.id === run.id)].resolve();
      await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), {once: true}));
    },
    onError: error => errors.push(error),
  });
  try {
    await Promise.all([entered[0].promise, entered[1].promise]);
    assert.deepEqual(started, runs.slice(0, 2).map(r => r.id));
    assert.deepEqual(claims, [[], [runs[0].id]], "the second claim acknowledges only its executing sibling");
    controls.get(runs[0].id)!.abort("cancelled");
    await entered[2].promise;
    assert.equal(controls.get(runs[1].id)!.signal.aborted, false, "cancelling one conversation leaves the other running");
    assert.deepEqual(claims[2], [runs[1].id]);
    shutdown.abort();
    await pool;
    assert.equal(controls.get(runs[1].id)!.signal.reason, "shutdown");
    assert.equal(controls.get(runs[2].id)!.signal.reason, "shutdown");
    assert.deepEqual(errors, []);
  } finally { shutdown.abort(); await pool; }
});

test("quick work has its own slots and never waits behind standard work", {timeout: 5000}, async () => {
  const standard = [makeRun(), makeRun()], quick = {...makeRun(), lane: "quick" as const};
  const queue = [...standard, quick];
  const shutdown = new AbortController();
  const asked: string[][] = [];
  const controls = new Map<string, AbortController>();
  const started = new Map<string, ReturnType<typeof deferred>>(queue.map(run => [run.id, deferred()]));
  const pool = runPool({
    concurrency: 1, quickConcurrency: 1, signal: shutdown.signal, pollMs: 1,
    claim: async (_active, lanes) => {
      asked.push(lanes);
      const index = queue.findIndex(run => lanes.includes(run.lane ?? "standard"));
      return index < 0 ? null : {run: queue.splice(index, 1)[0], activity: []};
    },
    execute: async ({run}, control) => {
      controls.set(run.id, control);
      started.get(run.id)!.resolve();
      await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), {once: true}));
    },
    onError: assert.ifError,
  });
  try {
    await Promise.all([started.get(standard[0].id)!.promise, started.get(quick.id)!.promise]);
    assert.deepEqual(asked.slice(0, 2), [["standard", "quick"], ["quick"]], "a busy standard slot leaves the quick slot open");
    assert.equal(controls.has(standard[1].id), false, "the second standard task waits for a standard slot");
    controls.get(standard[0].id)!.abort("cancelled");
    await started.get(standard[1].id)!.promise;
  } finally { shutdown.abort(); await pool; }
  await assert.rejects(runPool({concurrency: 1, quickConcurrency: 6, signal: shutdown.signal, claim: async () => null, execute: async () => {}, onError: () => {}}));
});

test("a claim returned during shutdown stays unexecuted for recovery", {timeout: 5000}, async () => {
  const shutdown = new AbortController();
  let executed = 0;
  await runPool({
    concurrency: 3, signal: shutdown.signal,
    claim: async () => { shutdown.abort(); return {run: makeRun(), activity: []}; },
    execute: async () => { executed++; },
    onError: assert.ifError,
  });
  assert.equal(executed, 0);
});

test("draining stops new claims and lets running conversations reach a pause", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), drain = new AbortController(), release = deferred();
  let claims = 0, finished = 0;
  const pool = runPool({
    concurrency: 3, signal: shutdown.signal, drain: drain.signal, pollMs: 10,
    claim: async () => (++claims === 1 ? {run: makeRun(), activity: []} : null),
    execute: async () => { await release.promise; finished++; },
    onError: assert.ifError,
  });
  while (claims < 2) await new Promise((r) => setTimeout(r, 5));
  drain.abort();
  const seen = claims;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(claims, seen, "no work is claimed after an update asks for a restart");
  release.resolve();
  await pool;
  assert.deepEqual([finished, shutdown.signal.aborted], [1, false], "running work finished instead of being stopped");
});

test("executions a previous runner left running hold their slots until they finish", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), earlier = deferred();
  const asked: [string[], string[]][] = [];
  let started = 0;
  const pool = runPool({
    concurrency: 1, quickConcurrency: 0, signal: shutdown.signal, pollMs: 5,
    adopted: [{id: "earlier", lane: "standard", done: earlier.promise}],
    claim: async (active, lanes) => { asked.push([active, lanes]); return started ? null : {run: makeRun(), activity: []}; },
    execute: async () => { started++; },
    onError: assert.ifError,
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([started, asked.length], [0, 0], "a full runner claims nothing");
    earlier.resolve();
    await waitFor(() => started === 1);
    assert.deepEqual(asked[0], [[], ["standard", "quick"]]);
  } finally { shutdown.abort(); await pool; }
});

test("an updating runner leaves executions running and returns even when full", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), drain = new AbortController(), release = deferred();
  let finished = 0;
  const pool = runPool({
    concurrency: 1, quickConcurrency: 0, signal: shutdown.signal, drain: drain.signal, leave: true, pollMs: 5,
    claim: async (active) => (active.length ? null : {run: makeRun(), activity: []}),
    execute: async () => { await release.promise; finished++; },
    onError: assert.ifError,
  });
  await new Promise((r) => setTimeout(r, 30));
  drain.abort();
  await pool;
  assert.equal(finished, 0, "the execution was left running");
  release.resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finished, 1);
});

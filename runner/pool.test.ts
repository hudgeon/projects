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
    claim: async (active, lanes) => {
      // Empty lanes are a check-in while the shared pool is full.
      if (!lanes.includes("standard")) return null;
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

test("every lane uses the same capacity, with no reserved or extra slots", {timeout: 5000}, async () => {
  const runs = [makeRun(), makeRun(), {...makeRun(), lane: "quick" as const}, {...makeRun(), lane: "upkeep" as const}];
  const queue = [...runs], shutdown = new AbortController();
  const controls = new Map<string, AbortController>();
  const pool = runPool({
    concurrency: 2, signal: shutdown.signal, pollMs: 1,
    claim: async (_active, lanes) => {
      assert.ok(!lanes.length || JSON.stringify(lanes) === JSON.stringify(["standard", "quick", "upkeep"]));
      const run = lanes.length ? queue.shift() : undefined;
      return run ? {run, activity: []} : null;
    },
    execute: async ({run}, control) => {
      controls.set(run.id, control);
      await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), {once: true}));
    },
    onError: assert.ifError,
  });
  try {
    await waitFor(() => controls.size === 2);
    assert.deepEqual([...controls.keys()], runs.slice(0, 2).map(r => r.id), "standard work can fill the entire pool");
    await new Promise(r => setTimeout(r, 20));
    assert.equal(controls.size, 2, "quick and upkeep cannot exceed the shared ceiling");
    controls.get(runs[0].id)!.abort();
    await waitFor(() => controls.size === 3);
    controls.get(runs[1].id)!.abort();
    await waitFor(() => controls.size === 4);
  } finally { shutdown.abort(); await pool; }
  await assert.rejects(runPool({concurrency: 12, signal: shutdown.signal, claim: async () => null, execute: async () => {}, onError: () => {}}));
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
    concurrency: 1, signal: shutdown.signal, pollMs: 5,
    adopted: [{id: "earlier", lane: "standard", done: earlier.promise}],
    // A full shared pool checks in without accepting any lane.
    claim: async (active, lanes) => { asked.push([active, lanes]); return started || !lanes.includes("standard") ? null : {run: makeRun(), activity: []}; },
    execute: async () => { started++; },
    onError: assert.ifError,
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(started, 0, "a full runner claims no standard work");
    assert.ok(asked.length && asked.every(([, lanes]) => lanes.length === 0), "no lane bypasses an adopted executor");
    earlier.resolve();
    await waitFor(() => started === 1);
    assert.deepEqual(asked.find(([, lanes]) => lanes.includes("standard")), [[], ["standard", "quick", "upkeep"]]);
  } finally { shutdown.abort(); await pool; }
});

test("an updating runner leaves executions running and returns even when full", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), drain = new AbortController(), release = deferred();
  let finished = 0;
  const pool = runPool({
    concurrency: 1, signal: shutdown.signal, drain: drain.signal, leave: true, pollMs: 5,
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

test("pressure pauses every lane, preserves running work and resumes without replay", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), queue = [makeRun(), {...makeRun(), lane: "upkeep" as const}];
  let admitted = true, polledPaused = 0;
  const controls = new Map<string, AbortController>();
  const pool = runPool({
    concurrency: 2, signal: shutdown.signal, pollMs: 1, admit: async () => admitted,
    claim: async (_active, lanes) => {
      if (!lanes.length) {polledPaused++; return null;}
      const run = queue.shift();
      admitted = false;
      return run ? {run, activity: []} : null;
    },
    execute: async ({run}, control) => {
      controls.set(run.id, control);
      await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), {once: true}));
    },
    onError: assert.ifError,
  });
  try {
    await waitFor(() => polledPaused > 0);
    assert.equal(controls.size, 1);
    assert.equal([...controls.values()][0].signal.aborted, false);
    admitted = true;
    await waitFor(() => controls.size === 2);
    assert.equal(queue.length, 0);
  } finally {shutdown.abort(); await pool;}
});

test("a paused check-in cannot start an older server's recovery reply", async () => {
  let executed = 0;
  await runPool({concurrency: 9, signal: new AbortController().signal, once: true,
    admit: async () => false, claim: async (_active, lanes) => {
      assert.deepEqual(lanes, []); return {run: makeRun(), activity: []};
    }, execute: async () => {executed++;}, onError: assert.ifError});
  assert.equal(executed, 0);
});

test("nine standard sessions can fill the former combined ceiling", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), queue = Array.from({length: 10}, () => makeRun());
  let started = 0, checkedFull = false;
  const pool = runPool({concurrency: 9, signal: shutdown.signal, pollMs: 1,
    claim: async (_active, lanes) => {
      if (!lanes.length) {checkedFull = true; return null;}
      const run = queue.shift();
      return run ? {run, activity: []} : null;
    }, execute: async (_claim, control) => {
      started++;
      await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), {once: true}));
    }, onError: assert.ifError});
  try {
    await waitFor(() => checkedFull);
    assert.equal(started, 9);
    assert.equal(queue.length, 1);
  } finally {shutdown.abort(); await pool;}
});

test("a restart with more adopted executions than the new ceiling waits without stopping them", {timeout: 5000}, async () => {
  const shutdown = new AbortController(), earlier = [deferred(), deferred()];
  let offered = false;
  const pool = runPool({concurrency: 1, signal: shutdown.signal, pollMs: 1,
    adopted: earlier.map((d, i) => ({id: `prior-${i}`, lane: i ? "upkeep" : "quick", done: d.promise})),
    claim: async (_active, lanes) => {if (lanes.length) offered = true; return null;},
    execute: async () => {}, onError: assert.ifError});
  try {
    await new Promise(r => setTimeout(r, 10));
    assert.equal(offered, false);
    earlier[0].resolve();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(offered, false, "the remaining execution still fills the ceiling");
    earlier[1].resolve();
    await waitFor(() => offered);
  } finally {earlier.forEach(d => d.resolve()); shutdown.abort(); await pool;}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { NativeOptions } from "./native";
import { executeRun } from "./engine";
import type { Progress } from "../src/run-model";
import { result, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("a helper past its time limit is asked to wrap up, and one that keeps going is stopped, inspected and handed to the master", async () => {
  for (const complies of [true, false]) {
    const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [], steered: string[] = [];
    let last: Progress | undefined, masters = 0;
    const session = randomUUID();
    o.limits = {helperMs: 40, graceMs: 1000, checkMs: 10};
    o.processStopped = () => true;
    o.report = async (p) => { last = structuredClone(p); };
    o.turn = async (opts) => {
      calls.push(opts);
      if (opts.agent === "codex") { await opts.onSession(randomUUID()); return ++masters === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change"}} : complete; }
      if (opts.readOnly) return {...result, outcome: "blocked", summary: "Saved the branch; checks still to run."};
      await opts.onSession(session);
      return new Promise((resolve, reject) => {
        opts.onSteer?.(async (input) => { steered.push(input.text); if (complies) resolve({...result, summary: "Wrapped up as asked."}); });
        const stop = () => reject(Error("Native turn stopped."));
        if (opts.signal.aborted) stop();
        opts.signal.addEventListener("abort", stop, {once: true});
      });
    };
    try {
      await executeRun(o);
      assert.equal(last?.state, "completed", `complies=${complies}`);
      assert.match(steered[0], /past its limit\. Finish now: save your work on your branch/);
      const events = last!.telemetry!;
      assert.equal(events.find((e) => e.event === "turn_limit_reached")?.reason, "time_limit");
      if (complies) {
        assert.equal(last!.children[0].result?.summary, "Wrapped up as asked.");
        assert.ok(!events.some((e) => e.event === "execution_handed_back"));
      } else {
        assert.equal(events.find((e) => e.event === "execution_handed_back")?.reason, "time_limit");
        assert.equal(calls.filter((c) => c.agent === "claude" && c.readOnly && c.sessionId === session).length, 1, "the same session was inspected");
        assert.match(calls.filter((c) => c.agent === "codex")[1].prompt, /ran past its time limit and was stopped/);
      }
    } finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test("a helper past its token limit is asked to wrap up", async () => {
  const dir = await fixture(), o = engineOptions(dir), steered: string[] = [];
  let last: Progress | undefined, masters = 0;
  o.limits = {helperTokens: 1000, checkMs: 10};
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? dispatch() : complete;
    opts.onUsage?.({fresh: 100, cached: 2000, output: 10, context: 2000});
    return new Promise((resolve) => opts.onSteer?.(async (input) => { steered.push(input.text); resolve(result); }));
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "completed");
    assert.match(steered[0], /used 2\.1k tokens, past its limit/);
    assert.equal(last!.telemetry!.find((e) => e.event === "turn_limit_reached")?.reason, "token_limit");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a coordinator turn past its time limit is stopped and runs again, and each decision sees the turn's elapsed time and tokens", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined;
  o.limits = {masterMs: 40, checkMs: 10};
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    if (calls.length === 1)
      return new Promise((_, reject) => {
        const stop = () => reject(Error("Native turn stopped."));
        if (opts.signal.aborted) stop();
        opts.signal.addEventListener("abort", stop, {once: true});
      });
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "completed");
    assert.equal(last!.telemetry!.find((e) => e.event === "execution_handed_back")?.reason, "time_limit");
    assert.match(calls[1].prompt, /took too long to decide, so it was stopped/);
    assert.match(calls[1].prompt, /This turn so far: \d+ minutes, 0 helper turns\./);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a wrap-up request waits for the turn to take input instead of being lost", async () => {
  const dir = await fixture(), o = engineOptions(dir), steered: string[] = [];
  let last: Progress | undefined, masters = 0;
  o.limits = {helperMs: 10, graceMs: 5000, checkMs: 5};
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? dispatch() : complete;
    // The turn opens its input only after the limit has passed.
    await new Promise((r) => setTimeout(r, 80));
    return new Promise((resolve) => opts.onSteer?.(async (input) => { steered.push(input.text); resolve(result); }));
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "completed");
    assert.equal(steered.length, 1);
    assert.match(steered[0], /past its limit/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

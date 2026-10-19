import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { executeRun } from "./engine";
import type { Progress } from "../src/run-model";
import { result, fixture, complete, dispatch, engineOptions, waitFor } from "./run-fixtures";

test("a helper's quiet wait is shown, reported as possibly stuck, and the helper is told once", async () => {
  const dir = await fixture(), o = engineOptions(dir), steered: string[] = [], reports: Progress[] = [];
  let masters = 0;
  o.limits = {showMs: 20, quietMs: 40, idleMs: 80, silentMs: 60_000, sampleMs: 10};
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? dispatch() : complete;
    // A process with no commands of its own: nothing it runs uses CPU.
    await opts.onProcess?.(process.pid);
    opts.onSteer?.(async (input) => { steered.push(input.text); });
    opts.onActivity?.({kind: "command", state: "started"}, "codex exec --sandbox read-only review < /dev/null");
    await waitFor(() => reports.some((p) => p.live?.watch?.stuck === "idle"), 10_000);
    return result;
  };
  try {
    await executeRun(o);
    const watch = reports.find((p) => p.live?.watch?.stuck)!.live!.watch!;
    assert.deepEqual([watch.on, watch.label, watch.stuck], ["command", "review", "idle"]);
    assert.equal(steered.filter((text) => /what you are waiting on has used no CPU/.test(text)).length, 1);
    const last = reports.at(-1)!, helper = last.children[0].id;
    assert.equal(last.telemetry!.filter((e) => e.event === "turn_stuck" && e.childId === helper).map((e) => e.reason).join(), "commands_idle");
    assert.equal(last.live, undefined, "the wait ends with the turn");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

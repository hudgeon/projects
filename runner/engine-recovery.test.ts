import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeStopError, type NativeOptions } from "./native";
import { executeRun, savePrivate } from "./engine";
import type { Progress, Child } from "../src/run-model";
import { result, progress, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("cancellation and failed native results never become completed", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    controller = new AbortController();
  let last: Progress | undefined;
  o.signal = controller.signal;
  o.report = async (p) => {
    last = p;
  };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    controller.abort("cancelled");
    throw Error("Native turn stopped.");
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "cancelled");
    const j = JSON.parse(
      await readFile(path.join(dir, "runs", o.run.id + ".json"), "utf8"),
    );
    assert.equal(j.phase, "uncertain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unconfirmed process stop remains blocked even after cancellation", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    controller = new AbortController();
  let last: Progress | undefined;
  o.signal = controller.signal;
  o.report = async (p) => {
    last = p;
  };
  o.turn = async () => {
    controller.abort("cancelled");
    throw new NativeStopError("The native process did not confirm it stopped.");
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "blocked");
    assert.match(last!.summary, /did not confirm/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a follow-up after a queued cancellation can start when no native turn ever ran", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let calls = 0,
    last: Progress | undefined;
  o.run.generation = 2;
  o.turn = async () => {
    calls++;
    return complete;
  };
  o.report = async (p) => {
    last = p;
  };
  try {
    await executeRun(o);
    assert.equal(calls, 1);
    assert.equal(last?.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery inspects the same stopped child read-only before resuming the master and queued feedback", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    calls: NativeOptions[] = [];
  const child: Child = {
    id: randomUUID(),
    projectId: o.projects[0].id,
    agent: "claude",
    mode: "change",
    cwd: dir,
    branch: "owned",
    sessionId: randomUUID(),
    state: "unknown",
    result: null,
    evidence: [],
  };
  const master = randomUUID();
  o.run.generation = 2;
  o.run.messages.push({
    id: randomUUID(),
    role: "user",
    text: "Continue and report the verified outcome",
    at: Date.now(),
    delivery: "queued",
  });
  o.processStopped = () => true;
  let prepared = false,
    last: Progress | undefined;
  o.prepare = async (_project, task) => {
    assert.equal(task.workspace, child.id);
    prepared = true;
    return { cwd: dir, branch: "owned", sessionId: child.sessionId };
  };
  o.report = async (value) => {
    last = structuredClone(value);
  };
  o.turn = async (opts) => {
    calls.push(opts);
    assert.equal(opts.readOnly, true);
    if (calls.length === 1) {
      assert.ok(prepared);
      assert.equal(opts.sessionId, child.sessionId);
      assert.match(opts.prompt, /RECOVERY INSPECTION ONLY/);
      assert.match(opts.prompt, /Do not repeat/);
      return {
        ...result,
        outcome: "blocked",
        summary: "Prior issue edits verified; one item remains.",
      };
    }
    assert.equal(opts.sessionId, master);
    assert.match(opts.prompt, /Prior issue edits verified/);
    assert.match(opts.prompt, /Continue and report/);
    return complete;
  };
  try {
    await savePrivate(path.join(dir, "runs", o.run.id + ".json"), {
      generation: 1,
      phase: "uncertain",
      pid: 1234,
      progress: { ...progress(), masterSessionId: master, children: [child] },
    });
    await executeRun(o);
    assert.equal(calls.length, 2);
    assert.equal(last?.state, "completed");
    assert.ok(last?.reviewedMessageIds?.includes(o.run.messages[1].id));
    assert.equal(last?.children[0].state, "blocked");
    assert.equal(
      last?.telemetry?.filter((e) => e.event === "recovery_started").length,
      1,
    );
    assert.equal(
      last?.telemetry?.filter((e) => e.event === "recovery_finished").length,
      1,
    );
    assert.ok(
      last?.telemetry
        ?.filter((e) => e.event === "native_finished")
        .every((e) => e.resumed && e.mode === "read"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery never overlaps a live process or resumes a moved workspace", async () => {
  for (const stopped of [false, true]) {
    const dir = await fixture(),
      o = engineOptions(dir);
    let calls = 0,
      last: Progress | undefined;
    o.processStopped = () => stopped;
    o.turn = async () => {
      calls++;
      return complete;
    };
    o.prepare = async () => {
      throw Error("Workspace ownership changed");
    };
    o.report = async (value) => {
      last = value;
    };
    try {
      await savePrivate(path.join(dir, "runs", o.run.id + ".json"), {
        generation: 1,
        phase: "child",
        pid: 1234,
        progress: {
          ...progress(),
          children: [
            {
              id: randomUUID(),
              projectId: o.projects[0].id,
              agent: "codex",
              mode: "change",
              cwd: dir,
              branch: "owned",
              sessionId: randomUUID(),
              state: "running",
              result: null,
              evidence: [],
            },
          ],
        },
      });
      await executeRun(o);
      assert.equal(calls, 0);
      assert.equal(last?.state, "blocked");
      assert.match(
        last!.summary,
        stopped ? /ownership changed/ : /may still be running/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("an update pauses a conversation between turns and the next runner continues without recovery", async () => {
  const dir = await fixture(), o = engineOptions(dir), drain = new AbortController(), reports: Progress[] = [];
  let masters = 0, children = 0;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") {
      if (++masters === 1) drain.abort();
      return masters === 1 ? dispatch() : complete;
    }
    children++;
    return result;
  };
  o.drain = drain.signal;
  const journal = async () => JSON.parse(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"));
  try {
    await executeRun(o);
    assert.deepEqual([masters, children], [1, 0], "the decided dispatch waits for the restart");
    assert.deepEqual([(await journal()).phase, (await journal()).checkpoint.kind], ["ready", "master"]);
    assert.match(reports.at(-1)!.summary, /Projects is updating/);
    await executeRun({...o, drain: undefined});
    assert.deepEqual([masters, children], [2, 1], "the saved decision runs without a new master turn");
    const after = await journal();
    assert.equal(after.progress.state, "completed");
    assert.ok(!after.progress.telemetry.some((e: {event: string}) => e.event === "recovery_started"));
    const idle = engineOptions(dir);
    idle.drain = AbortSignal.abort();
    idle.turn = async () => { throw Error("no turn may start while draining"); };
    await executeRun(idle);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("recovery after a context reset inspects the same helper before briefing a fresh master", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const child: Child = {id: randomUUID(), projectId: o.projects[0].id, agent: "claude", mode: "change", cwd: dir, branch: "owned", sessionId: randomUUID(), state: "unknown", result: null, evidence: []};
  o.processStopped = () => true;
  o.prepare = async () => ({cwd: dir, branch: "owned", sessionId: child.sessionId});
  o.turn = async (opts) => {
    calls.push(opts);
    assert.equal(opts.readOnly, true);
    if (opts.agent === "claude") {
      assert.equal(opts.sessionId, child.sessionId);
      assert.match(opts.prompt, /RECOVERY INSPECTION ONLY/);
      return {...result, summary: "Recovered saved branch; no writes replayed."};
    }
    assert.equal(opts.sessionId, undefined);
    assert.match(opts.prompt, /You are the user's Projects master/);
    assert.match(opts.prompt, /Recovered saved branch/);
    assert.match(opts.prompt, /Complete the requested work/);
    await opts.onSession(randomUUID());
    return complete;
  };
  try {
    await savePrivate(path.join(dir, "runs", `${o.run.id}.json`), {generation: 1, phase: "uncertain", pid: 1234, progress: {...progress(), masterSessionId: null, children: [child]}});
    await executeRun(o);
    assert.equal(calls.length, 2);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

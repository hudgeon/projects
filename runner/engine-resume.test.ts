import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NativeOptions } from "./native";
import { executeRun, savePrivate } from "./engine";
import type { Progress } from "../src/run-model";
import { result, makeRun, progress, deferred, fixture, delivery, complete, dispatch, engineOptions } from "./run-fixtures";

test("concurrent native masters retain separate journals and resume identities", {timeout: 10000}, async () => {
  const dir = await fixture(), runs = [makeRun(), makeRun()];
  const masterIds = runs.map(() => randomUUID());
  const entered = runs.map(() => deferred());
  const release = deferred();
  const reports = new Map<string, Progress>();
  const calls: NativeOptions[][] = [[], []];
  const options = runs.map((run, index) => ({
    ...engineOptions(dir, run),
    report: async (p: Progress) => { reports.set(run.id, structuredClone(p)); },
    turn: async (o: NativeOptions) => {
      calls[index].push(o);
      await o.onSession(masterIds[index]);
      entered[index].resolve();
      await release.promise;
      return complete;
    },
  }));
  try {
    const work = Promise.all(options.map(o => executeRun(o)));
    await Promise.all(entered.map(e => e.promise));
    release.resolve(); await work;
    await Promise.all(options.map((o, index) => executeRun({...o, run: {...runs[index], generation: 2, progress: reports.get(o.run.id)!}})));
    for (const [index, run] of runs.entries()) {
      assert.equal(calls[index][1].sessionId, masterIds[index]);
      const journal = JSON.parse(await readFile(path.join(dir, "runs", `${run.id}.json`), "utf8"));
      assert.equal(journal.progress.masterSessionId, masterIds[index]);
      assert.equal(journal.progress.state, "completed");
    }
  } finally { release.resolve(); await rm(dir, {recursive: true, force: true}); }
});
test("master resumes after child results and follow-ups retain the native master identity", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    reports: Progress[] = [],
    calls: NativeOptions[] = [];
  const masterId = randomUUID(),
    childId = randomUUID();
  let masterCount = 0;
  let grants = 0;
  o.browser = async () => ({endpoint: "wss://example.com/browser", capability: `turn-capability-${++grants}`, outputDir: path.join(dir, "browser")});
  o.report = async (p) => {
    reports.push(structuredClone(p));
  };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.agent === "codex" ? masterId : childId);
    await opts.onProcess?.(1234);
    if (opts.agent === "codex")
      return ++masterCount === 1 ? dispatch() : complete;
    return result;
  };
  try {
    await executeRun(o);
    assert.deepEqual(
      calls.map((c) => c.agent),
      ["codex", "claude", "codex"],
    );
    assert.equal(calls[2].sessionId, masterId);
    assert.deepEqual(calls.map(c => c.browser?.capability), ["turn-capability-1", "turn-capability-2", "turn-capability-3"], "each native turn refreshes its scoped grant");
    assert.match(calls[2].prompt, /Fixture check passed/);
    assert.equal(reports.at(-1)?.state, "completed");
    assert.equal(reports.at(-1)?.title, "Inspect the test project", "the master's plain label survives a later decision without one");
    assert.match(calls[0].prompt, /title: a plain label of at most eight words/);
    assert.match(calls[1].prompt, /\*\*Your move:\*\*/);
    const events = reports.at(-1)!.telemetry!;
    const turns = events.filter((e) => e.event === "native_finished");
    assert.deepEqual(
      turns.map((e) => e.actor),
      ["master", "claude", "master"],
    );
    assert.ok(
      turns.every((e) => e.durationMs! >= 0 && e.outcome === "completed"),
    );
    assert.ok(
      turns.every((e) =>
        events.some(
          (start) =>
            start.event === "native_started" && start.turnId === e.turnId,
        ),
      ),
    );
    assert.equal(
      events.filter((e) => e.event === "workspace_prepared").length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /Inspect this project|Complete the requested work|Verified completion|Observed fixture HEAD/,
    );
    assert.equal(reports.at(-1)?.children[0].sessionId, childId);
    assert.deepEqual(reports.at(-1)?.children[0].evidence, [
      "Observed fixture HEAD",
    ]);
    const file = path.join(dir, "runs", o.run.id + ".json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(file, "utf8"), /turn-capability|wss:\/\//, "browser credentials never enter the recovery journal");
    const count = calls.length;
    await executeRun(o);
    assert.equal(calls.length, count); // receipt replay must not dispatch twice
    const follow = { ...o.run, generation: 2, progress: reports.at(-1)! };
    await executeRun({ ...o, run: follow });
    assert.equal(calls.at(-1)?.sessionId, masterId);
    assert.ok((reports.at(-1)?.seq ?? 0) < (reports.at(-2)?.seq ?? 0) + 3); // new generation starts its own sequence
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lost completion acknowledgment replays only the saved receipt", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let calls = 0;
  o.turn = async () => {
    calls++;
    return complete;
  };
  o.report = async (p) => {
    if (p.state === "completed")
      throw Error("connection lost after server accepted");
  };
  try {
    // Simulate a process loss at the receipt boundary instead of letting it retry.
    const file = path.join(dir, "runs", o.run.id + ".json");
    const receipt = {
      ...progress(),
      seq: 8,
      state: "completed" as const,
      summary: "Delivered",
    };
    await savePrivate(file, {
      generation: 1,
      phase: "finished",
      pid: null,
      progress: receipt,
    });
    await assert.rejects(executeRun(o), /connection lost/);
    let last: Progress | undefined;
    await executeRun({
      ...o,
      report: async (p) => {
        last = p;
      },
    });
    assert.equal(calls, 0);
    assert.deepEqual(last, receipt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupted journals without native identity and missing journals never cause automatic replay", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let calls = 0,
    last: Progress | undefined;
  o.turn = async () => {
    calls++;
    return complete;
  };
  o.report = async (p) => {
    last = p;
  };
  try {
    const file = path.join(dir, "runs", o.run.id + ".json");
    await savePrivate(file, {
      generation: 1,
      phase: "child",
      pid: 1234,
      progress: { ...progress(), masterSessionId: null },
    });
    await executeRun(o);
    assert.equal(calls, 0);
    assert.equal(last?.state, "blocked");
    assert.match(
      last!.summary,
      /left no session|may still be running/,
    );
    await executeRun({ ...o, run: { ...o.run, generation: 2 } });
    assert.equal(calls, 0);
    await rm(file);
    await assert.rejects(
      executeRun({ ...o, run: { ...o.run, progress: progress() } }),
      /saved state is missing/,
    );
    await writeFile(file, "bad journal");
    await assert.rejects(executeRun(o), /saved state on its machine could not be read/);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a saved native child result survives failed report delivery without another child turn", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let masters = 0,
    children = 0,
    loseConnection = true;
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") {
      children++;
      opts.onActivity?.({ kind: "turn", state: "finished" });
      return result;
    }
    return ++masters === 1 ? dispatch() : complete;
  };
  // Allow dispatch, then fail the final activity flush after the native receipt.
  o.report = async (p) => {
    if (loseConnection && children > 0) throw Error("offline");
  };
  try {
    await assert.rejects(executeRun(o), /offline/);
    const j = JSON.parse(
      await readFile(path.join(dir, "runs", o.run.id + ".json"), "utf8"),
    );
    assert.equal(j.checkpoint.kind, "child");
    loseConnection = false;
    await executeRun(o);
    assert.equal(children, 1);
    assert.equal(masters, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown retains an active claim for recovery and confirmed master checkpoints do not repeat decisions", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    control = new AbortController();
  let last: Progress | undefined;
  o.signal = control.signal;
  o.report = async (p) => {
    last = p;
  };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    await opts.onProcess?.(1234);
    control.abort("shutdown");
    throw Error("stopped");
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "running");
    assert.match(last!.summary, /restarting/);
    const file = path.join(dir, "runs", o.run.id + ".json");
    const j = JSON.parse(await readFile(file, "utf8"));
    assert.equal(j.phase, "uncertain");
    assert.equal(j.pid, 1234);
    await savePrivate(file, {
      ...j,
      checkpoint: {
        kind: "master",
        // Saved by a runner from before master titles: it must still replay.
        value: { action: "complete", summary: "Verified completion", task: null },
        inputIds: o.run.messages.map((m) => m.id),
      },
    });
    o.signal = new AbortController().signal;
    o.turn = async () => {
      throw Error("must not call the native agent again");
    };
    await executeRun(o);
    assert.equal(last?.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a native result reaches disk while an earlier activity report is still offline", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let reconnect!: () => void,
    offline = false,
    masters = 0;
  const delivery = new Promise<void>((resolve) => {
    reconnect = resolve;
  });
  o.report = async (p) => {
    if (p.activity?.length && !offline) {
      offline = true;
      await delivery;
    }
  };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? dispatch() : complete;
    opts.onActivity?.({ kind: "tool", state: "finished" });
    await new Promise((resolve) => setTimeout(resolve, 3200));
    return result;
  };
  const execution = executeRun(o);
  try {
    let checkpoint: unknown;
    for (let attempt = 0; attempt < 70; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        checkpoint = JSON.parse(
          await readFile(path.join(dir, "runs", o.run.id + ".json"), "utf8"),
        ).checkpoint;
      } catch {
        /* first write */
      }
      if ((checkpoint as { kind?: string } | undefined)?.kind === "child")
        break;
    }
    assert.ok(offline);
    assert.deepEqual(checkpoint, {
      kind: "child",
      childId: JSON.parse(
        await readFile(path.join(dir, "runs", o.run.id + ".json"), "utf8"),
      ).progress.children[0].id,
      value: result,
    });
  } finally {
    reconnect();
    await execution;
    await rm(dir, { recursive: true, force: true });
  }
});

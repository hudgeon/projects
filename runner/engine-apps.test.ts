import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Failure, type NativeOptions } from "./native";
import { executeRun, savePrivate } from "./engine";
import type { Progress } from "../src/run-model";
import { result, makeRun, progress, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("a machine signed in to Claude only never starts Codex", async () => {
  const dir = await fixture(), calls: NativeOptions[] = [], reports: Progress[] = [];
  const o = engineOptions(dir);
  o.agents = ["claude"];
  o.report = async (p) => { reports.push(structuredClone(p)); };
  const codexTask = dispatch();
  codexTask.task = {...codexTask.task!, agent: "codex"};
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    return [codexTask, dispatch(), result, complete][calls.length - 1];
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.agent), ["claude", "claude", "claude", "claude"], "the Codex default master and a Codex child both stay on Claude");
    assert.match(calls[0].prompt, /child agent: claude\./);
    assert.match(calls[1].prompt, /Codex is not signed in on this machine\. Your proposed action has NOT been executed/);
    assert.equal(reports.at(-1)?.masterAgent, "claude");
    assert.equal(reports.at(-1)?.state, "completed");
    // A request that names an app this machine lacks starts nothing.
    const named = engineOptions(dir, {...makeRun(), agent: "codex"}), started: NativeOptions[] = [];
    let last: Progress | undefined;
    named.agents = ["claude"];
    named.report = async (p) => { last = structuredClone(p); };
    named.turn = async (opts) => { started.push(opts); return complete; };
    await executeRun(named);
    assert.equal(started.length, 0);
    assert.equal(last?.state, "blocked");
    assert.match(last?.summary ?? "", /Codex is not signed in on this machine[\s\S]*\*\*Your move:\*\* Send this again with Claude/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conversation's master runs in the app the user chose, and a session stays with its app", async () => {
  const dir = await fixture(), calls: NativeOptions[] = [], reports: Progress[] = [];
  const o = engineOptions(dir, {...makeRun(), masterAgent: "claude"});
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    return calls.length === 1 ? dispatch() : calls.length === 2 ? result : complete;
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => [c.agent, c.readOnly, c.cwd === dir]), [["claude", true, true], ["claude", true, true], ["claude", true, true]]);
    const last = reports.at(-1)!;
    assert.equal(last.masterAgent, "claude");
    assert.equal(last.telemetry?.find((e) => e.event === "native_started" && e.actor === "master")?.agent, "claude");
    // A follow-up resumes the same Claude master session.
    const resumed: NativeOptions[] = [];
    await executeRun({...o, run: {...o.run, generation: 2, progress: last}, turn: async (opts) => { resumed.push(opts); return complete; }});
    assert.deepEqual([resumed[0].agent, resumed[0].sessionId], ["claude", last.masterSessionId]);
    // Codex stays the default and is recorded by omission, as before.
    const codex = engineOptions(dir), seen: NativeOptions[] = [];
    let latest: Progress | undefined;
    codex.report = async (p) => { latest = structuredClone(p); };
    codex.turn = async (opts) => { seen.push(opts); await opts.onSession(randomUUID()); return complete; };
    await executeRun(codex);
    assert.equal(seen[0].agent, "codex");
    assert.equal(latest?.masterAgent, undefined);
    // A Codex session is never handed to Claude: a changed master starts fresh.
    const switched: NativeOptions[] = [];
    await executeRun({...codex, run: {...codex.run, masterAgent: "claude", generation: 2, progress: latest!}, turn: async (opts) => { switched.push(opts); await opts.onSession(randomUUID()); return complete; }});
    assert.deepEqual([switched[0].agent, switched[0].sessionId], ["claude", undefined]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser checks go to Claude: only Codex children hear their sandbox cannot start a local one", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    calls: NativeOptions[] = [];
  const decisions = [{...dispatch(), task: {...dispatch().task!, agent: "codex" as const}}, dispatch(), complete];
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    // Masters and children alternate: master, Codex child, master, Claude child, master.
    return calls.length % 2 ? decisions.shift() : result;
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.agent), ["codex", "codex", "codex", "claude", "codex"]);
    assert.match(calls[0].prompt, /Codex children cannot start a local browser/);
    assert.match(calls[0].prompt, /needs a local browser to a Claude change child/);
    assert.match(calls[1].prompt, /This sandbox cannot start a local browser/);
    assert.match(calls[1].prompt, /not run in checks; that alone is not blocked/);
    assert.doesNotMatch(calls[3].prompt, /cannot start a local browser/, "a Claude child can run the browser check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("when the coordinator's app declines or keeps failing, the other app takes over for the rest of the conversation", async () => {
  for (const [failures, reason, recorded] of [[["policy_refused"], "policy_refused", "policy_refused"], [["turn_failed", "turn_failed"], "turn_failed", "repeated_failure"]] as const) {
    const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
    let last: Progress | undefined, failing = true;
    o.report = async (p) => { last = structuredClone(p); };
    o.turn = async (opts) => {
      calls.push(opts);
      await opts.onSession(opts.sessionId ?? randomUUID());
      if (failing && calls.length <= failures.length) throw new Failure(failures[calls.length - 1], "Codex could not decide.");
      return complete;
    };
    try {
      await executeRun(o);
      assert.equal(last?.state, "completed", reason);
      assert.deepEqual(calls.map((c) => c.agent), [...failures.map(() => "codex"), "claude"]);
      const takeover = calls.at(-1)!;
      assert.equal(takeover.sessionId, undefined);
      assert.match(takeover.prompt, /You are the user's Projects master/);
      assert.match(takeover.prompt, new RegExp(`You are taking over as this conversation's coordinator: Codex ${recorded === "policy_refused" ? "declined this conversation under its usage policy" : "failed twice in a row"}`));
      assert.equal(last!.masterAgent, "claude");
      assert.deepEqual([last!.masterFallback?.from, last!.masterFallback?.reason], ["codex", recorded]);
      // The next turn stays with the app that took over.
      calls.length = 0;
      failing = false;
      await executeRun({...o, run: {...o.run, generation: 2, progress: last!}});
      assert.deepEqual(calls.map((c) => c.agent), ["claude"]);
    } finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test("a coordinator that cannot go on stops plainly when no other app can take over, and never switches back", async () => {
  for (const scenario of ["alone", "already"] as const) {
    const dir = await fixture(), o = engineOptions(dir);
    let last: Progress | undefined, calls = 0;
    if (scenario === "alone") o.agents = ["codex"];
    else {
      o.run = {...o.run, generation: 2, progress: {...progress(), masterAgent: "claude", masterFallback: {from: "codex", reason: "policy_refused", at: Date.now()}}};
      await savePrivate(path.join(dir, "runs", `${o.run.id}.json`), {generation: 1, phase: "finished", pid: null, progress: o.run.progress});
    }
    o.report = async (p) => { last = structuredClone(p); };
    o.turn = async (opts) => {
      calls++;
      assert.equal(opts.agent, scenario === "alone" ? "codex" : "claude");
      throw new Failure("usage_limit", "Your usage limit is reached. Send a follow-up after it resets.");
    };
    try {
      await executeRun(o);
      assert.equal(calls, 1, scenario);
      assert.equal(last?.state, "blocked");
      assert.match(last!.summary, /usage limit is reached/);
    } finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test("every Codex coordinator and helper reads speed at the turn boundary", async () => {
  const dir = await fixture(), o = engineOptions(dir), speeds: (boolean|undefined)[] = [];
  let setting = true, calls = 0;
  o.codexFast = async () => setting;
  o.turn = async opts => {
    speeds.push(opts.codexFast); calls++;
    await opts.onSession(randomUUID());
    opts.onTiming?.({model:"model-a",effort:"high",attempts:1,firstOutputMs:12});
    opts.onUsage?.({fresh:200,cached:0,output:30,context:200});
    if(calls===1) { const d=dispatch(); return {...d,task:{...d.task!,agent:"codex"}}; }
    if(calls===2) { setting=false; return result; }
    return complete;
  };
  try {
    await executeRun(o);
    assert.deepEqual(speeds,[true,true,false]);
    const journal=JSON.parse(await readFile(path.join(dir,"runs",`${o.run.id}.json`),"utf8"));
    const events=journal.progress.telemetry.filter((e:{event:string})=>e.event==="native_finished");
    assert.deepEqual(events.map((e:{codexFast:boolean})=>e.codexFast),[true,true,false]);
    assert.ok(events.every((e:{model:string;tokenUsageObserved:boolean})=>e.model==="model-a"&&e.tokenUsageObserved));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

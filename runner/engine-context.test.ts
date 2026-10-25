import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeScreenshots } from "../src/screenshot-model";
import type { NativeOptions } from "./native";
import { contextConversation, executeRun, savePrivate, MASTER_CONTEXT_LIMIT } from "./engine";
import type { Progress, Child, RunMessage } from "../src/run-model";
import { result, progress, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("the master sees new screenshots and delegated sessions receive the conversation images", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const image = {id: randomUUID(), mime: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="};
  o.run.messages[0].screenshots = [(await decodeScreenshots([image]))[0].metadata];
  let loaded = 0, master = 0;
  o.screenshot = async metadata => { assert.equal(metadata.id, image.id); loaded++; return image; };
  o.turn = async opts => {
    calls.push(opts); await opts.onSession(randomUUID());
    return opts.agent === "codex" ? (++master === 1 ? dispatch() : complete) : result;
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map(call => call.screenshots), [[image], [image], []]);
    assert.equal(loaded, 1);
    assert.doesNotMatch(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"), /iVBOR/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("fresh coordinators receive earlier screenshots after deliberate and size-based resets", async () => {
  for (const reason of ["deliberate", "size"] as const) {
    const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
    const image = {id: randomUUID(), mime: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="};
    o.run.messages[0].screenshots = [(await decodeScreenshots([image]))[0].metadata];
    o.screenshot = async () => image;
    let masters = 0;
    o.turn = async (opts) => {
      calls.push(opts); await opts.onSession(opts.sessionId ?? randomUUID());
      if (opts.agent === "claude") return result;
      masters++;
      opts.onUsage?.({fresh: 1, cached: 1, output: 1, context: reason === "size" && masters === 1 ? MASTER_CONTEXT_LIMIT + 1 : 1000});
      return masters === 1 ? {...dispatch(), resetContext: reason === "deliberate"} : complete;
    };
    try {
      await executeRun(o);
      const coordinators = calls.filter((c) => c.agent === "codex");
      assert.equal(coordinators[1].sessionId, undefined, reason);
      assert.deepEqual(coordinators.map((c) => c.screenshots), [[image], [image]], reason);
      assert.doesNotMatch(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"), /iVBOR/);
    } finally {await rm(dir, {recursive: true, force: true});}
  }
});

test("an image fetch failure before native startup remains safely retryable", async () => {
  const dir = await fixture(), o = engineOptions(dir);
  const image = {id: randomUUID(), mime: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='};
  o.run.messages[0].screenshots = [(await decodeScreenshots([image]))[0].metadata];
  let turns = 0;
  o.turn = async opts => { turns++; await opts.onSession(randomUUID()); return complete; };
  o.screenshot = async () => { throw Error('Image temporarily unavailable'); };
  try {
    await executeRun(o);
    const journal = JSON.parse(await readFile(path.join(dir, 'runs', `${o.run.id}.json`), 'utf8'));
    assert.equal(turns, 0);
    assert.equal(journal.phase, 'finished');
    assert.equal(journal.progress.state, 'blocked');
    o.run.generation++;
    o.screenshot = async () => image;
    await executeRun(o);
    assert.equal(turns, 1, 'the next generation starts once, without uncertain-process recovery');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'runs', `${o.run.id}.json`), 'utf8')).progress.state, 'completed');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a fresh session in an existing worktree starts from the earlier report, and the master hears it was fresh", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined;
  const made: Child = {id: randomUUID(), projectId: "acme/test", agent: "claude", mode: "change", cwd: dir, branch: "projects/a", sessionId: randomUUID(), state: "completed", result: {...result, summary: "Built the statement export; PR open."}, evidence: ["Observed HEAD: abc"]};
  o.run = {...o.run, generation: 2, progress: {...progress(), children: [made]}};
  await savePrivate(path.join(dir, "runs", `${o.run.id}.json`), {generation: 1, phase: "finished", pid: null, progress: {...progress(), state: "completed", children: [made]}});
  o.prepare = async () => ({cwd: dir, branch: "projects/a", sessionId: null});
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") return result;
    return calls.length === 1 ? dispatch(made.id) : complete;
  };
  try {
    await executeRun(o);
    assert.match(calls[1].prompt, /You are a fresh session, so their memory is not available/);
    assert.match(calls[1].prompt, /Built the statement export; PR open\./);
    assert.equal(calls[1].sessionId, undefined);
    assert.ok(last!.children[1].evidence.includes("Observed: a fresh session continued this worktree"));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a resumed coordinator gets only what is new to it; a follow-up skips the unchanged brief", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined, masters = 0;
  const master = randomUUID();
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.agent === "codex" ? master : randomUUID());
    if (opts.agent === "claude") return {...result, summary: "FIRST-CHILD-REPORT"};
    return ++masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    const [first, second] = calls.filter((c) => c.agent === "codex").map((c) => c.prompt);
    assert.match(first, /You are the user's Projects master/);
    assert.match(first, /Current user conversation \(including any queued feedback\)/);
    assert.match(second, /Nothing new in the conversation since your last decision\./);
    assert.doesNotMatch(second, /Current user conversation|You are the user's Projects master/);
    assert.doesNotMatch(second, /Active work \(check the timestamps/, "the same immutable snapshot is not resent");
    assert.match(second, /FIRST-CHILD-REPORT/, "the returned child comes in full");
    // A follow-up: the same session hears the new message only.
    const followUp: RunMessage = {id: randomUUID(), role: "user", text: "NEW-FOLLOW-UP", at: Date.now(), delivery: "queued"};
    calls.length = 0;
    await executeRun({...o, run: {...o.run, generation: 2, progress: last!, messages: [...o.run.messages, followUp]}});
    const next = calls.filter((c) => c.agent === "codex")[0];
    assert.equal(next.sessionId, master);
    assert.match(next.prompt, /A follow-up turn in this conversation; your instructions and the registered projects are unchanged\./);
    assert.doesNotMatch(next.prompt, /You are the user's Projects master/);
    assert.match(next.prompt, /New in the conversation since your last decision[^\n]*NEW-FOLLOW-UP/);
    assert.doesNotMatch(next.prompt, /Complete the requested work/, "the first message is already in its session");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("fresh context retains user authority and corrections without replaying earlier agent errors", () => {
  const message = (role: RunMessage["role"], text: string): RunMessage => ({id: randomUUID(), role, text, at: Date.now()});
  const goal = message("user", "Create a draft; never send it."), wrong = message("master", "OLD-INCORRECT-ASSUMPTION"),
    correction = message("user", "Use the corrected total 42; approval still covers drafting only."), latest = message("master", "Draft saved; submission unverified.");
  const handoff = contextConversation([goal, wrong, correction, latest]);
  assert.deepEqual(handoff.userInstructions, [goal, correction]);
  assert.deepEqual(handoff.latestReportedPosition, latest);
  assert.doesNotMatch(JSON.stringify(handoff), /OLD-INCORRECT-ASSUMPTION/);
});

test("a deliberate coordinator reset keeps child execution and evidence, then starts its next decision fresh", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let masters = 0, last: Progress | undefined;
  o.run.messages.push({id: randomUUID(), role: "master", text: "SUPERSEDED-REPLY", at: Date.now()},
    {id: randomUUID(), role: "master", text: "Latest reported position.", at: Date.now()},
    {id: randomUUID(), role: "user", text: "CORRECTION: verify the current source before continuing.", at: Date.now()});
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") return {...result, summary: "CURRENT-CHILD-EVIDENCE"};
    return ++masters === 1 ? {...dispatch(), resetContext: true} : complete;
  };
  try {
    await executeRun(o);
    const decisions = calls.filter((c) => c.agent === "codex");
    assert.equal(calls.filter((c) => c.agent === "claude").length, 1, "the dispatched work is not replayed");
    assert.equal(decisions[1].sessionId, undefined);
    assert.match(decisions[1].prompt, /You are the user's Projects master/);
    assert.match(decisions[1].prompt, /CORRECTION: verify the current source/);
    assert.match(decisions[1].prompt, /Complete the requested work/);
    assert.match(decisions[1].prompt, /CURRENT-CHILD-EVIDENCE/);
    assert.doesNotMatch(decisions[1].prompt, /SUPERSEDED-REPLY/);
    const source = path.join(dir, "runs", `${o.run.id}.context.json`);
    assert.ok(decisions[1].prompt.includes(source), "the original exchanges are available on demand");
    assert.match(decisions[1].prompt, /Never infer the scope of a short approval from a handoff/);
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), o.run.messages);
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.equal(last?.state, "completed");
    assert.equal(last?.children.length, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a reset on a completed decision survives restart and gives the follow-up a full brief", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined;
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => { calls.push(opts); await opts.onSession(randomUUID()); return {...complete, resetContext: true}; };
  try {
    await executeRun(o);
    assert.equal(last?.masterSessionId, null);
    const saved = JSON.parse(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"));
    assert.equal(saved.progress.masterSessionId, null);
    await executeRun({...o, run: {...o.run, generation: 2, progress: last!}});
    assert.equal(calls[1].sessionId, undefined);
    assert.match(calls[1].prompt, /You are the user's Projects master/);
    assert.match(calls[1].prompt, /Complete the requested work/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a coordinator whose session grew large hands over to a fresh one with the full brief", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let masters = 0;
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") return result;
    opts.onUsage?.({fresh: 10, cached: 10, output: 1, context: ++masters === 1 ? MASTER_CONTEXT_LIMIT + 1 : 1000});
    return masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    const masterCalls = calls.filter((c) => c.agent === "codex");
    assert.equal(masterCalls[1].sessionId, undefined, "a fresh coordinator session");
    assert.match(masterCalls[1].prompt, /the previous coordinator's session grew large, so Projects started a fresh one/);
    assert.match(masterCalls[1].prompt, /You are the user's Projects master/);
    assert.match(masterCalls[1].prompt, /Current user conversation/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

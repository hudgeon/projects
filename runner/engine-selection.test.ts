import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executeRun, savePrivate, type EngineOptions } from "./engine";
import { git } from "./workspaces";
import { JEV_MODEL } from "./context";
import { reviewsDir } from "./project-turn";
import type { Progress, Child } from "../src/run-model";
import { result, progress, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("fresh coordinators consume selected evidence once; changed feedback discards stale selections", async () => {
  for (const changeFeedback of [false, true]) {
    const dir = await fixture(), o = engineOptions(dir);
    let calls = 0, turns = 0, last: Progress | undefined;
    let messages = structuredClone(o.run.messages);
    const children: Child[] = Array.from({length: 3}, (_, i) => ({
      id: randomUUID(), projectId: o.projects[0].id, agent: "claude", mode: "read", cwd: dir,
      branch: "owned", sessionId: randomUUID(), state: "completed", evidence: ["Synthetic observed version"],
      result: {...result, summary: `Report ${i}: ${"historical detail ".repeat(30)} END-${i}`},
    }));
    o.latestMessages = () => messages;
    o.contextSelector = {mode: "select", key: async () => "test-key", fetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(init!.body as string);
      if (changeFeedback) messages.push({id: randomUUID(), role: "user", text: "NEW CORRECTION: keep the draft pending", at: Date.now()});
      return Response.json({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(request.questions).map(k => [k, {type: "noul", noul: 0}])), usage: {input_tokens: 100, output_tokens: 20}});
    }};
    o.report = async p => { last = structuredClone(p); };
    o.turn = async opts => {
      turns++;
      assert.equal(opts.readOnly, true);
      await opts.onSession(opts.sessionId ?? "context-master");
      assert.match(opts.prompt, /complete source index/);
      if (changeFeedback) assert.match(opts.prompt, /NEW CORRECTION/);
      else assert.doesNotMatch(opts.prompt, /END-0/);
      return complete;
    };
    try {
      await savePrivate(path.join(dir, "runs", o.run.id + ".json"), {generation: 1, phase: "ready", pid: null, progress: {...progress(), masterSessionId: null, children}});
      await executeRun(o);
      const view = JSON.parse(await readFile(path.join(dir, "runs", o.run.id + ".context.json.view.json"), "utf8"));
      assert.equal(view.reason, changeFeedback ? "evidence_changed" : "selected");
      assert.equal(calls, 1);
      assert.equal(last!.children.length, 3, "selection cannot replay or remove executions");
      if (changeFeedback) assert.ok(last!.reviewedMessageIds!.includes(messages.at(-1)!.id));
      assert.ok(((await stat(path.join(dir, "runs", o.run.id + ".context.json.index.json"))).mode & 0o077) === 0);
      const followup = {id: randomUUID(), role: "user" as const, text: "Continue within scope", at: Date.now()};
      o.latestMessages = () => [...messages, followup];
      o.turn = async opts => { turns++; assert.equal(opts.sessionId, "context-master"); return complete; };
      await executeRun({...o, run: {...o.run, generation: 2, progress: last!, messages: [...messages, followup]}});
      assert.equal(calls, 1, "ordinary continuation does not call Jev");
      assert.equal(turns, 2);
    } finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test("conversation selection failures persist the same safe diagnostic that the runner logs", async (t) => {
  const dir = await fixture(), o = engineOptions(dir), lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  const children: Child[] = Array.from({length: 3}, () => ({id: randomUUID(), projectId: o.projects[0].id, agent: "claude", mode: "read", cwd: dir, branch: "owned", sessionId: randomUUID(), state: "completed", evidence: [], result}));
  o.contextSelector = {mode: "select", key: async () => "private-key", fetch: async () => {throw new DOMException("private timeout", "TimeoutError");}};
  o.turn = async opts => {await opts.onSession(randomUUID()); return complete;};
  try {
    await savePrivate(path.join(dir, "runs", o.run.id + ".json"), {generation: 1, phase: "ready", pid: null, progress: {...progress(), masterSessionId: null, children}});
    await executeRun(o);
    const file = path.join(dir, "runs", o.run.id + ".context.json.view.json");
    const receipt = JSON.parse(await readFile(file, "utf8"));
    const failure = lines.map(line => JSON.parse(line)).find(x => x.contextTrigger === "coordinator-rotation");
    assert.equal(receipt.strategy, "baseline");
    assert.equal(receipt.failure.kind, "timeout");
    assert.equal(failure.runId, o.run.id);
    assert.deepEqual(failure.contextFailure, receipt.failure);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.doesNotMatch(JSON.stringify(failure), /private timeout|private-key/);
  } finally {await rm(dir, {recursive: true, force: true});}
});

// A run's coordinator reviews, oldest first.
async function masterReviews(o: EngineOptions) {
  const dir = reviewsDir(o.stateDir);
  return (await readdir(dir)).filter(name => name.endsWith(`-${o.run.id.slice(0, 8)}-master.json`)).sort().map(name => path.join(dir, name));
}
async function projectReviewFixture() {
  const dir = await fixture();
  await writeFile(path.join(dir, ".gitignore"), ".state/\n");
  await writeFile(path.join(dir, "AGENTS.md"), "Draft only; publishing requires approval.\n");
  await writeFile(path.join(dir, "README.md"), "The invoice fixture uses the pipe delimiter.\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "."]);
  await git(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "Fixture"]);
  const o = engineOptions(dir);
  o.stateDir = path.join(dir, ".state");
  return {dir, o};
}
function projectResponder(callback?: (body: any) => void): NonNullable<EngineOptions["contextSelector"]> {
  return {mode: "select", key: async () => "fixture-key", fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); callback?.(body);
    return Response.json({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, {type: "noul", noul: 0.9}])), usage: {input_tokens: 100, output_tokens: 10}});
  }};
}

test("Jev project failure receipts and logs correlate while baseline evidence still reaches native execution", async (t) => {
  const {dir, o} = await projectReviewFixture();
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  let natives = 0;
  o.contextSelector = {mode: "select", key: async () => "private-key", fetch: async () => {throw new TypeError("private host", {cause: {code: "ENOTFOUND"}});}};
  o.turn = async opts => {
    natives++;
    assert.match(opts.prompt, /invoice fixture uses the pipe delimiter/);
    assert.match(opts.prompt, /Draft only/);
    assert.doesNotMatch(opts.prompt, /ENOTFOUND|private host/);
    await opts.onSession(randomUUID()); return complete;
  };
  try {
    await executeRun(o);
    const [file] = await masterReviews(o);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    const failures = lines.map(line => JSON.parse(line)).filter(x => x.event === "jev_selection_failed");
    assert.equal(natives, 1);
    assert.equal(receipt.reason, "service_failed");
    assert.equal(receipt.failure.kind, "dns");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].runId, o.run.id);
    assert.equal(failures[0].contextTrigger, "project-turn");
    assert.deepEqual(failures[0].contextFailure, receipt.failure);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.doesNotMatch(JSON.stringify(failures), /private|pipe delimiter|Draft only/);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("project review precedes the first native turn and a resumed unchanged view is not reinserted", async () => {
  const {dir, o} = await projectReviewFixture();
  let apiCalls = 0, natives = 0, last: Progress | undefined;
  o.contextSelector = projectResponder(() => {apiCalls++;});
  o.report = async p => {last = structuredClone(p);};
  o.turn = async opts => {
    assert.equal(apiCalls, 1, "project Jev call happened before any native execution");
    natives++;
    if (natives === 1) {assert.match(opts.prompt, /invoice fixture uses the pipe delimiter/); assert.match(opts.prompt, /Draft only/);}
    else {assert.match(opts.prompt, /Project context is unchanged/); assert.doesNotMatch(opts.prompt, /invoice fixture uses the pipe delimiter/);}
    opts.onFile?.({path: path.join(dir, "README.md"), lines: [1, 3]});
    opts.onFile?.({path: path.join(path.dirname(dir), "elsewhere.md")});
    await opts.onSession("project-master"); return complete;
  };
  try {
    await executeRun(o);
    const [receiptFile] = await masterReviews(o);
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    assert.equal(receipt.strategy, "select");
    assert.equal(receipt.cached, false);
    assert.equal((await stat(receiptFile)).mode & 0o077, 0);
    // The receipt holds what the review read and, after the turn, the files
    // the turn used: paths and line ranges, nothing else.
    assert.equal(receipt.input.task, "Coordinate the current user request in this project; verify returned work before deciding what remains.");
    assert.equal(receipt.input.query, "");
    assert.deepEqual(receipt.input.instructions, o.run.messages.filter(m => m.role === "user").map(m => m.text));
    assert.equal(receipt.head, await git(dir, ["rev-parse", "HEAD"]));
    assert.deepEqual(receipt.usage.files, [{path: "README.md", read: true, lines: [[1, 3]]}]);
    assert.equal(receipt.usage.outside, 1);
    await executeRun({...o, run: {...o.run, generation: 2, progress: last!}});
    const reviews = await masterReviews(o);
    assert.equal(reviews.length, 2, "every review keeps its own receipt");
    const cached = JSON.parse(await readFile(reviews[1], "utf8"));
    assert.equal(cached.cached, true); assert.equal(cached.reusedInSession, true);
    assert.equal(natives, 2); assert.equal(apiCalls, 1);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("feedback during child project review prevents the stale dispatch while retaining its workspace", async () => {
  const {dir, o} = await projectReviewFixture();
  const messages = structuredClone(o.run.messages);
  let masters = 0, helpers = 0, changed = false;
  o.latestMessages = () => messages;
  o.contextSelector = projectResponder(body => {
    if (body.state.task?.startsWith("read:") && !changed) {
      changed = true; messages.push({id: randomUUID(), role: "user", at: Date.now(), text: "CORRECTION: stop the inspection and report only."});
    }
  });
  o.turn = async opts => {
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") {helpers++; return result;}
    masters++;
    if (masters === 1) return dispatch();
    assert.match(opts.prompt, /CORRECTION/); assert.match(opts.prompt, /No helper turn started/);
    return complete;
  };
  try {
    await executeRun(o);
    const journal = JSON.parse(await readFile(path.join(o.stateDir, "runs", o.run.id + ".json"), "utf8"));
    assert.equal(helpers, 0); assert.equal(masters, 2);
    assert.equal(journal.progress.children.length, 1);
    assert.equal(journal.progress.children[0].cwd, dir);
    assert.equal(journal.progress.children[0].state, "cancelled");
    assert.equal(journal.progress.children[0].result, null);
    assert.equal(journal.checkpoint, undefined);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("an update during child review resumes its prepared workspace once without repeating the coordinator", async () => {
  const {dir, o} = await projectReviewFixture(), drain = new AbortController();
  let masters = 0, helpers = 0, prepares = 0;
  const workspaces: string[] = [];
  o.drain = drain.signal;
  o.prepare = async (_project, task) => {prepares++; workspaces.push(task.workspace); return {cwd: dir, branch: "main", sessionId: null};};
  o.contextSelector = projectResponder(body => {if (body.state.task?.startsWith("read:")) drain.abort("drain");});
  o.turn = async opts => {
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") {helpers++; assert.match(opts.prompt, /pipe delimiter/); return result;}
    masters++; return masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    const file = path.join(o.stateDir, "runs", o.run.id + ".json");
    const paused = JSON.parse(await readFile(file, "utf8"));
    assert.equal(paused.phase, "ready"); assert.equal(paused.checkpoint.kind, "master");
    assert.equal(paused.checkpoint.value.task.workspace, paused.progress.children[0].id);
    assert.equal(helpers, 0); assert.equal(masters, 1);
    o.drain = new AbortController().signal;
    await executeRun(o);
    assert.equal(prepares, 2); assert.deepEqual(workspaces, ["new", paused.progress.children[0].id]);
    assert.equal(helpers, 1); assert.equal(masters, 2);
    assert.equal(JSON.parse(await readFile(file, "utf8")).progress.state, "completed");
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("cancelling during child review starts no native helper and leaves no replay checkpoint", async () => {
  const {dir, o} = await projectReviewFixture(), control = new AbortController();
  let helpers = 0;
  o.signal = control.signal;
  o.contextSelector = projectResponder(body => {if (body.state.task?.startsWith("read:")) control.abort("cancelled");});
  o.turn = async opts => {
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") {helpers++; return result;}
    return dispatch();
  };
  try {
    await executeRun(o);
    const journal = JSON.parse(await readFile(path.join(o.stateDir, "runs", o.run.id + ".json"), "utf8"));
    assert.equal(helpers, 0); assert.equal(journal.phase, "finished");
    assert.equal(journal.progress.state, "cancelled"); assert.equal(journal.checkpoint, undefined);
    assert.equal(journal.progress.children[0].state, "cancelled");
    assert.equal(journal.progress.children[0].result, null);
  } finally {await rm(dir, {recursive: true, force: true});}
});

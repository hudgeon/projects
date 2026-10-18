import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NativeOptions } from "./native";
import { activityBrief, completionProblem, workInstructions, executeRun, outputSchema } from "./engine";
import { masterDecisionSchema, type Progress } from "../src/run-model";
import { result, fixture, delivery, complete, dispatch, engineOptions } from "./run-fixtures";

test("work-record completion gate returns to the coordinator without replaying a child", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  o.workRepo = "acme/work";
  let masters = 0;
  const record = {status: "unchanged" as const, evidence: "Read-only question; no supported work facts changed."};
  o.turn = async opts => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") return result;
    masters++;
    if (masters === 1) return dispatch();
    if (masters === 2) return complete;
    if (masters === 3) return {...complete, workRecord: {status: "pending", evidence: "Readback remains"}};
    return {...complete, workRecord: record};
  };
  try {
    await executeRun(o);
    assert.equal(calls.filter(c => c.agent === "claude").length, 1);
    assert.equal(masters, 4);
    assert.match(calls[0].prompt, /Bigger work is recorded.*acme\/work/);
    assert.match(calls.find(c => c.agent === "claude")!.prompt, /User corrections take precedence/);
    assert.match(calls.at(-1)!.prompt, /Account for the current work/);
    const journal = JSON.parse(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"));
    assert.equal(journal.progress.state, "completed");
    assert.deepEqual(journal.workRecord, record);
    // Re-publishing a settled journal must not execute another native turn.
    await executeRun({...o, turn: async () => { throw Error("unexpected replay"); }});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("work updates preserve read-only scope and distinguish restructure from delivery", () => {
  const instructions = workInstructions("acme/work", 7);
  assert.match(instructions, /Read-only requests remain read-only/);
  assert.match(instructions, /superseded, never delivered/);
  assert.match(instructions, /preserve concurrent changes/);
  assert.match(instructions, /if it has several/);
  assert.match(instructions, /read back every affected issue/);
  assert.equal(workInstructions(), "");
  assert.equal(completionProblem({...complete, workRecord: {status: "updated", evidence: "Verified canonical issue readback"}}, [], true), null);
  assert.equal(completionProblem({...complete, action: "blocked", workRecord: {status: "pending", evidence: "GitHub unavailable"}}, [], true), null);
  assert.equal(masterDecisionSchema.safeParse({...complete, workRecord: {status: "updated", evidence: " "}}).success, false);
});

test("implementation goes straight to a change child, and the master reads a compact view of active work", async () => {
  const dir = await fixture(), o = engineOptions(dir), prompts: string[] = [];
  const now = Date.now(), ok = {state: "ok" as const, message: "Fine", observedAt: now};
  const sources = {git: ok, github: ok, codex: {...ok, state: "unsupported" as const, message: "Not used here"}, claude: ok};
  const worktree = {path: dir, branch: "main", changed: 0, conflicts: 0, ahead: 0, behind: 0, isPrimary: true, error: null};
  const session = {id: "s", title: "Live work", app: "Codex" as const, cwd: dir, updatedAt: now - 60_000, state: "running" as const, evidence: ""};
  // A removed folder is evidence only while its commit holds unpushed work.
  const removed = {...worktree, path: `${dir}/done`, branch: "done", ahead: null, behind: null, unpushed: 0, isPrimary: false, prunable: true as const};
  o.activity = [{host: "laptop", observedAt: now, unassignedSessions: [{...session, title: "UNRELATED-MARKER"}], projects: [
    {id: "acme/test", sessions: [session, {...session, title: "OLD-MARKER", state: "open", updatedAt: now - 3 * 86400_000}], worktrees: [worktree, {...worktree, path: `${dir}/wt`, branch: "dirty-branch", changed: 2, isPrimary: false}, {...removed, path: `${dir}/gone`, branch: "kept", unpushed: 1}], pulls: [], sources: {...sources, github: {...ok, state: "unavailable", message: "GitHub could not be checked"}}},
    {id: "acme/quiet", sessions: [], worktrees: [{...worktree, path: `${dir}/q`}, removed], pulls: [], sources},
  ]}];
  const brief = activityBrief(o.activity, null, now) as {projects: {id: string; sessions: unknown[]; checkouts: {branch: string; folderRemoved?: true}[]; gaps?: string[]}[]}[];
  assert.deepEqual(brief[0].projects.map((p) => p.id), ["acme/test"], "a quiet project adds nothing");
  assert.deepEqual(brief[0].projects[0].checkouts.map((c) => [c.branch, c.folderRemoved]), [["dirty-branch", undefined], ["kept", true]]);
  assert.deepEqual(brief[0].projects[0].gaps, ["github: GitHub could not be checked"]);
  assert.deepEqual((activityBrief(o.activity, "acme/quiet", now) as typeof brief)[0].projects.map((p) => p.id), ["acme/quiet"], "a selected project is always shown");
  o.turn = async (opts) => { prompts.push(opts.prompt); await opts.onSession(randomUUID()); return complete; };
  try {
    await executeRun(o);
    assert.match(prompts[0], /Send implementation straight to one change child/);
    assert.match(prompts[0], /never dispatch an inspection first for the same scope/);
    assert.match(prompts[0], /pull request with its checks/);
    assert.match(prompts[0], /Live work/);
    assert.doesNotMatch(prompts[0], /OLD-MARKER|UNRELATED-MARKER/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project scope is enforced before preparing a workspace or launching a child", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let prepared = false,
    last: Progress | undefined;
  o.turn = async () => ({
    ...dispatch(),
    task: { ...dispatch().task!, projectId: "outside/project" },
  });
  o.prepare = async () => {
    prepared = true;
    throw Error("must not prepare");
  };
  o.report = async (p) => {
    last = p;
  };
  try {
    await executeRun(o);
    assert.equal(prepared, false);
    assert.equal(last?.state, "blocked");
    assert.match(last!.summary, /outside this request/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decisions the runner cannot carry out go back to the master before anything runs", async () => {
  const dir = await fixture(), o = engineOptions(dir), prompts: string[] = [];
  let last: Progress | undefined, prepared = false;
  o.report = async (p) => { last = structuredClone(p); };
  o.prepare = async () => { prepared = true; return {cwd: dir, branch: "main", sessionId: null}; };
  o.turn = async (opts) => {
    prompts.push(opts.prompt);
    await opts.onSession(randomUUID());
    if (prompts.length === 1) return {...dispatch(), task: {...dispatch().task!, projectId: "outside/project"}};
    if (prompts.length === 2) return {...complete, task: dispatch().task};
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(prepared, false);
    assert.equal(last?.state, "completed");
    assert.match(prompts[1], /Your decision was not carried out: that project is outside this request/);
    assert.match(prompts[2], /a finished or blocked decision cannot carry a task/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("the last step asks the master for a report, and a dispatch there becomes the owner's next move", async () => {
  const dir = await fixture(), o = engineOptions(dir), prompts: string[] = [];
  let last: Progress | undefined;
  o.maxSteps = 2;
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") return result;
    prompts.push(opts.prompt);
    return {...dispatch(), summary: "Next I would verify the deployment."};
  };
  try {
    await executeRun(o);
    assert.doesNotMatch(prompts[0], /last step of this turn/);
    assert.match(prompts[1], /This is the last step of this turn: do not dispatch/);
    assert.equal(last?.state, "blocked");
    assert.match(last!.summary, /^Next I would verify the deployment\.\n\nThis turn used its last step before that could start\.\n\n\*\*Your move:\*\* Send a follow-up to continue\.$/);
    assert.equal(last!.children.length, 1, "the last decision started nothing");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("native context controls are required and nullable while old decisions remain readable", () => {
  const schema = outputSchema(masterDecisionSchema);
  const properties = schema.properties as Record<string, {type?: unknown; anyOf?: unknown[]}>;
  assert.ok((schema.required as string[]).includes("resetContext"));
  assert.deepEqual(properties.resetContext.type, ["boolean", "null"]);
  const task = properties.task.anyOf![0] as {required: string[]; properties: Record<string, {type: unknown}>};
  assert.ok(task.required.includes("freshSession"));
  assert.deepEqual(task.properties.freshSession.type, ["boolean", "null"]);
  assert.doesNotThrow(() => masterDecisionSchema.parse(dispatch()));
  assert.doesNotThrow(() => masterDecisionSchema.parse({...dispatch(), resetContext: null, task: {...dispatch().task!, freshSession: null}}));
});

test("change completion returns to the master until every applicable delivery gate is accounted for", async () => {
  for (const gate of ["missing", "checks", "review", "merge", "deployment", "visual", "sync"]) {
    const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [], reports: Progress[] = [];
    let masters = 0;
    o.report = async report => {reports.push(structuredClone(report));};
    o.turn = async opts => {
      calls.push(opts);
      await opts.onSession(randomUUID());
      if (!opts.readOnly) return result;
      masters++;
      if (masters === 1) return {...dispatch(), task: {...dispatch().task!, mode: "change"}};
      if (masters === 2) return {...complete, delivery: gate === "missing" ? null : {...delivery, [gate]: {status: "pending", evidence: "Required work remains"}}};
      assert.match(opts.prompt, /Your decision was not carried out/);
      assert.match(opts.prompt, gate === "missing" ? /needs a delivery record/ : new RegExp(gate));
      assert.equal(reports.at(-1)?.state, "running", "an incomplete decision never publishes completion");
      // A draft-only request can legitimately omit release steps with reasons.
      return complete;
    };
    try {
      await executeRun(o);
      assert.equal(masters, 3, gate);
      assert.equal(calls.filter(call => !call.readOnly).length, 1, "rejecting completion never replays a child");
      assert.equal(reports.at(-1)?.state, "completed");
      const saved = JSON.parse(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"));
      assert.deepEqual(saved.delivery, delivery);
      assert.ok(reports.every(report => !("delivery" in report)), "the assessment stays out of progress/snapshots");
      // The new journal remains readable and finishing the same generation is idempotent.
      await executeRun(o);
      assert.equal(calls.length, 4);
    } finally {await rm(dir, {recursive: true, force: true});}
  }
});

test("read-only answers and legacy decisions still parse; gate evidence cannot be blank or silently omitted", () => {
  assert.equal(completionProblem({...complete, delivery: undefined}, []), null);
  assert.equal(completionProblem({...complete, action: "blocked", delivery: {...delivery, sync: {status: "pending", evidence: "Machine unavailable"}}}, []), null);
  assert.match(completionProblem({...complete, delivery: {...delivery, visual: {status: "pending", evidence: "Screen unobserved"}}}, [])!, /visual/);
  assert.doesNotThrow(() => masterDecisionSchema.parse({...complete, delivery: undefined}));
  const {sync, ...missing} = delivery;
  assert.equal(masterDecisionSchema.safeParse({...complete, delivery: missing}).success, false);
  assert.equal(masterDecisionSchema.safeParse({...complete, delivery: {...delivery, merge: {status: "not_required", evidence: " "}}}).success, false);
  const schema = outputSchema(masterDecisionSchema) as {required: string[]};
  assert.ok(schema.required.includes("delivery"));
});

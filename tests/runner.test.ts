import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeScreenshots } from "../src/screenshot-model";
import {
  nativeTurn,
  nativeEnv,
  browserTools,
  hiddenBrowserTools,
  NativeBusyError,
  Failure,
  NativeStopError,
  parseProgressNote,
  type NativeOptions,
} from "../runner/native";
import {
  activityBrief,
  contextConversation,
  executeRun,
  savePrivate,
  outputSchema,
  HANDBACK_LIMIT,
  MASTER_CONTEXT_LIMIT,
  type EngineOptions,
} from "../runner/engine";
import { continuesSession, git, liveChanges, prepareWorkspace, privateOrigin, pruneSaved, saveWorkspace, savedRef, savedRuns, SESSION_CONTEXT_LIMIT, UnsavedWorkspace, workspaceEvidence } from "../runner/workspaces";
import { claudeRules, codexConfig, parseMcpList } from "../runner/connectors";
import { runPool } from "../runner/pool";
import {
  childResultSchema,
  masterDecisionSchema,
  type Progress,
  type Run,
  type MasterDecision,
  type Child,
  type NativeActivity,
  type RunMessage,
  type ProgressNoteInput,
  type LivePlanStep,
} from "../src/run-model";

const result = {
  outcome: "completed" as const,
  summary: "Verified",
  checks: ["Fixture check passed"],
  links: [],
};
const makeRun = (): Run => ({
  id: randomUUID(),
  projectId: "acme/test",
  agent: "auto",
  workIssue: 1112,
  generation: 1,
  state: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  heartbeatAt: Date.now(),
  messages: [
    {
      id: randomUUID(),
      role: "user",
      text: "Complete the requested work",
      at: Date.now(),
    },
  ],
  progress: null,
});
const progress = (): Progress => ({
  seq: 1,
  state: "running",
  summary: "Inspecting",
  children: [],
  masterSessionId: randomUUID(),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

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
async function fixture() {
  return mkdtemp(path.join(tmpdir(), "projects-runner-"));
}

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
const complete: MasterDecision = {
  action: "complete",
  title: null,
  summary: "Verified completion",
  task: null,
};
const dispatch = (workspace = "new"): MasterDecision => ({
  action: "dispatch",
  title: "Inspect the **test** project",
  summary: "Delegating inspection",
  task: {
    projectId: "acme/test",
    agent: "claude",
    mode: "read",
    workspace,
    prompt: "Inspect this project",
  },
});
function engineOptions(dir: string, run = makeRun()): EngineOptions {
  return {
    run,
    host: "studio",
    projects: [{ id: "acme/test", name: "Test", cwd: dir, plan: null }],
    stateDir: dir,
    masterCwd: dir,
    worktreeRoot: path.join(dir, "worktrees"),
    activity: [],
    signal: new AbortController().signal,
    report: async () => {},
    evidence: async () => ["Observed fixture HEAD"],
    prepare: async () => ({ cwd: dir, branch: "main", sessionId: null }),
    save: async () => null,
    prune: async () => {},
    connectors: async () => ({ claude: null, codex: null }),
  };
}

test("quick work gives the master a light prompt without the repository activity dump", async () => {
  const dir = await fixture(),
    o = engineOptions(dir, {...makeRun(), lane: "quick"});
  o.inboxAccount = "owner@example.com";
  o.workRepo = "acme/work";
  o.activity = [{host: "studio", projects: [{id: "acme/test", sessions: ["ACTIVITY-MARKER"]}]}];
  const prompts: string[] = [];
  o.turn = async (opts) => {
    prompts.push(opts.prompt);
    await opts.onSession(randomUUID());
    return complete;
  };
  try {
    await executeRun(o);
    assert.match(prompts[0], /email lane/);
    assert.match(prompts[0], /owner@example\.com/);
    assert.match(prompts[0], /change child in the acme\/work repository/);
    assert.match(prompts[0], /never draft with the connector/);
    assert.match(prompts[0], /draft helper \(--create, never send\)/);
    assert.doesNotMatch(prompts[0], /ACTIVITY-MARKER|Activity observations/);
    const standard = engineOptions(dir);
    standard.activity = o.activity;
    standard.turn = o.turn;
    await executeRun(standard);
    assert.match(prompts[1], /ACTIVITY-MARKER/, "standard work keeps the activity check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("a child's evidence names commits not yet pushed and its pull request", async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin"), primary = path.join(dir, "primary");
    await git(dir, ["init", "--bare", origin]);
    await git(dir, ["clone", origin, primary]);
    await git(primary, ["config", "user.email", "test@example.invalid"]);
    await git(primary, ["config", "user.name", "Test"]);
    await git(primary, ["checkout", "-b", "main"]);
    await writeFile(path.join(primary, "README.md"), "Initial\n");
    await git(primary, ["add", "README.md"]);
    await git(primary, ["commit", "-m", "Initial"]);
    await git(primary, ["push", "-u", "origin", "main"]);
    assert.deepEqual((await workspaceEvidence(primary)).slice(3), ["Observed unpushed commits: 0"], "main has no pull request to look up");
    await git(primary, ["checkout", "-b", "projects/work"]);
    await writeFile(path.join(primary, "README.md"), "Changed\n");
    await git(primary, ["commit", "-am", "Change"]);
    const evidence = await workspaceEvidence(primary);
    assert.equal(evidence[3], "Observed unpushed commits: 1");
    // This origin is not on GitHub, so the lookup is reported, never guessed.
    assert.equal(evidence[4], "Observed pull request: not checked; GitHub was unavailable");
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

test("a conversation moved from the Studio starts a new coordinator here and never resumes the Studio's sessions", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const reports: Progress[] = [];
  const miniChild: Child = {id: randomUUID(), projectId: "acme/test", agent: "codex", mode: "change", cwd: "/studio/worktree", branch: "work", sessionId: "studio-child-session", state: "running", result: null, evidence: []};
  o.host = "laptop";
  o.run = {...o.run, generation: 2, movedFrom: "studio", progress: {seq: 4, state: "running", title: "Ship the change", summary: "Working", children: [miniChild], masterSessionId: "studio-master-session", reviewedMessageIds: [o.run.messages[0].id]}};
  o.report = async (p) => { reports.push(structuredClone(p)); };
  // The Studio never saved this workspace, so the master is asked for a new one.
  o.prepare = async (_project, task, _previous, _run, _child, _root, host) => {
    assert.equal(host, "laptop");
    if (task.workspace === miniChild.id) throw new UnsavedWorkspace("never saved");
    return {cwd: dir, branch: "main", sessionId: null};
  };
  const decisions = [dispatch(miniChild.id), dispatch(), complete];
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    return opts.agent === "codex" ? decisions.shift() : result;
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.agent), ["codex", "codex", "claude", "codex"]);
    assert.equal(calls[0].sessionId, undefined, "a new coordinator, not the Studio's");
    assert.match(calls[0].prompt, /moved this conversation here because the machine where it ran so far is unreachable/);
    assert.match(calls[1].prompt, /no copy on GitHub to continue from/);
    assert.ok(calls.every((c) => c.sessionId !== "studio-child-session" && c.sessionId !== "studio-master-session"));
    const children = reports.at(-1)!.children;
    assert.deepEqual(children.map((c) => [c.id === miniChild.id ? "studio" : "new", c.host, c.state]), [["studio", "studio", "unknown"], ["new", "laptop", "completed"]]);
    assert.equal(reports.at(-1)!.state, "completed");
    assert.doesNotMatch(calls[0].prompt, /at most five minutes/, "saves can fail, so no gap is promised");
    assert.match(calls[0].prompt, /told how recent the copy is/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("after a move, a failed turn on the Laptop recovers only the Laptop's own work and never the Studio's step", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [], reports: Progress[] = [];
  const miniChild: Child = {id: randomUUID(), projectId: "acme/test", agent: "codex", mode: "change", cwd: "/studio/worktree", branch: "projects/studio/work", sessionId: "studio-child-session", state: "running", result: null, evidence: []};
  o.host = "laptop";
  // Only Codex here, so no other app takes over its coordinating.
  o.agents = ["codex"];
  o.processStopped = () => true;
  o.run = {...o.run, generation: 2, movedFrom: "studio", progress: {seq: 4, state: "running", summary: "Working", children: [miniChild], masterSessionId: "studio-master-session", reviewedMessageIds: [o.run.messages[0].id]}};
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.prepare = async () => { throw Error("The Studio's workspace is never prepared for recovery here."); };
  // The Laptop's coordinator meets its usage limit on its first turn and on two follow-ups.
  let limited = 3;
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession("laptop-master-session");
    await opts.onProcess?.(4321);
    if (limited-- > 0) throw new Failure("usage_limit", "Your Codex usage limit is reached. Send a follow-up after it resets.");
    return complete;
  };
  try {
    await executeRun(o);
    assert.match(reports.at(-1)!.summary, /usage limit/);
    for (const generation of [3, 4, 5]) {
      await executeRun({...o, run: {...o.run, generation, progress: reports.at(-1)!}});
      assert.doesNotMatch(reports.at(-1)!.summary, /another machine/, `follow-up ${generation}`);
    }
    assert.equal(reports.at(-1)!.state, "completed");
    assert.deepEqual(calls.map((c) => c.sessionId), [undefined, "laptop-master-session", "laptop-master-session", "laptop-master-session"], "each follow-up resumes the Laptop's own coordinator");
    assert.ok(calls.every((c) => c.readOnly && c.agent === "codex"));
    const studio = reports.at(-1)!.children.find((c) => c.id === miniChild.id)!;
    assert.deepEqual([studio.host, studio.state], ["studio", "unknown"], "the Studio's step stays unknown: never inspected or resumed here");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("a recreated worktree's new session and the master hear when its copy was saved", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [], reports: Progress[] = [];
  const savedAt = Date.parse("2026-10-14T01:23:45.000Z");
  const miniChild: Child = {id: randomUUID(), projectId: "acme/test", agent: "codex", mode: "change", cwd: "/studio/worktree", branch: "projects/studio/work", sessionId: "studio-child-session", state: "running", result: null, evidence: [], host: "studio"};
  o.host = "laptop";
  o.run = {...o.run, generation: 2, movedFrom: "studio", progress: {seq: 4, state: "running", summary: "Working", children: [miniChild], masterSessionId: "studio-master-session", reviewedMessageIds: [o.run.messages[0].id]}};
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.prepare = async (_project, task) => {
    assert.equal(task.workspace, miniChild.id);
    return {cwd: dir, branch: miniChild.branch, sessionId: null, restored: true, savedAt};
  };
  const decisions = [{...dispatch(miniChild.id), task: {...dispatch(miniChild.id).task!, mode: "change" as const}}, complete];
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    return opts.agent === "codex" ? decisions.shift() : result;
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.agent), ["codex", "claude", "codex"]);
    assert.match(calls[1].prompt, /recreated on this machine.*2026-10-14T01:23:45\.000Z/s);
    assert.match(calls[2].prompt, /2026-10-14T01:23:45\.000Z/, "the master reads the copy's time in the returned evidence");
    assert.equal(reports.at(-1)!.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("worktrees start at current origin/main and reuse only an owned unchanged branch", async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin"),
      primary = path.join(dir, "primary");
    await git(dir, ["init", "--bare", origin]);
    await git(dir, ["clone", origin, primary]);
    await git(primary, ["config", "user.email", "test@example.invalid"]);
    await git(primary, ["config", "user.name", "Test"]);
    await git(primary, ["checkout", "-b", "main"]);
    await writeFile(path.join(primary, "README.md"), "Initial\n");
    await git(primary, ["add", "README.md"]);
    await git(primary, ["commit", "-m", "Initial"]);
    await git(primary, ["push", "-u", "origin", "main"]);
    const project = {
      id: "acme/test",
      name: "Test",
      cwd: primary,
      plan: null,
    };
    const id = randomUUID(),
      runId = randomUUID();
    const task = { ...dispatch().task!, mode: "change" as const };
    const ws = await prepareWorkspace(
      project,
      task,
      [],
      runId,
      id,
      path.join(dir, "owned"), "studio",
    );
    assert.notEqual(ws.cwd, primary);
    assert.match(ws.branch, /^projects\//);
    assert.equal(
      await git(ws.cwd, ["rev-parse", "HEAD"]),
      await git(primary, ["rev-parse", "origin/main"]),
    );
    const peers = await Promise.all(Array.from({length: 3}, () => prepareWorkspace(
      project, task, [], randomUUID(), randomUUID(), path.join(dir, "owned"), "studio",
    )));
    assert.equal(new Set(peers.map(peer => peer.cwd)).size, 3);
    assert.equal(new Set(peers.map(peer => peer.branch)).size, 3);
    for (const peer of peers) assert.equal(await git(peer.cwd, ["rev-parse", "HEAD"]), await git(primary, ["rev-parse", "origin/main"]));
    const recovery = await Promise.allSettled([
      prepareWorkspace(project, task, [], runId, id, path.join(dir, "owned"), "studio"),
      prepareWorkspace(project, task, [], randomUUID(), randomUUID(), path.join(dir, "owned"), "studio"),
    ]);
    assert.equal(recovery[0].status, "rejected", "an existing branch is never overwritten");
    assert.equal(recovery[1].status, "fulfilled", "a failed setup must release the next conversation's setup");
    const child: Child = {
      ...ws,
      id,
      projectId: project.id,
      agent: "claude",
      mode: "change",
      state: "completed",
      sessionId: randomUUID(),
      result,
      evidence: [],
    };
    const resume = await prepareWorkspace(
      project,
      { ...task, workspace: id },
      [child],
      runId,
      randomUUID(),
      dir, "studio",
    );
    assert.equal(resume.sessionId, child.sessionId);
    assert.equal(resume.cwd, ws.cwd);
    await assert.rejects(
      prepareWorkspace(
        project,
        { ...task, workspace: "not-owned" },
        [child],
        runId,
        randomUUID(),
        dir, "studio",
      ),
      /does not belong/,
    );
    await assert.rejects(
      prepareWorkspace(
        project,
        { ...task, workspace: id },
        [{ ...child, mode: "read", cwd: primary, branch: "main" }],
        runId,
        randomUUID(),
        dir, "studio",
      ),
      /primary checkout/,
    );
    // A child's second branch in its own runner worktree is still its own.
    await git(ws.cwd, ["checkout", "-b", "projects/second-pull-request"]);
    const second = await prepareWorkspace(project, { ...task, workspace: id }, [child], runId, randomUUID(), path.join(dir, "owned"), "studio");
    assert.deepEqual([second.cwd, second.branch], [ws.cwd, "projects/second-pull-request"]);
    // So is the detached checkout a child leaves once its pull request merged.
    await git(ws.cwd, ["checkout", "--detach"]);
    const detached = await prepareWorkspace(project, { ...task, workspace: id }, [child], runId, randomUUID(), path.join(dir, "owned"), "studio");
    assert.deepEqual([detached.cwd, detached.branch, detached.sessionId], [ws.cwd, child.branch, child.sessionId]);
    // A session that cannot continue leaves its worktree to a fresh one.
    const fresh = await prepareWorkspace(project, { ...task, workspace: id }, [{ ...child, resumable: false }], runId, randomUUID(), path.join(dir, "owned"), "studio");
    assert.deepEqual([fresh.cwd, fresh.sessionId], [ws.cwd, null]);
    await git(ws.cwd, ["checkout", "projects/second-pull-request"]);
    // Outside the runner's own worktrees, a different branch means another owner.
    await assert.rejects(
      prepareWorkspace(
        project,
        { ...task, workspace: id },
        [child],
        runId,
        randomUUID(),
        path.join(dir, "elsewhere"), "studio",
      ),
      /did not start, so another session may own it/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fakeBinary(dir: string, agent: string, mode: string) {
  const file = path.join(dir, `${agent}-${mode}.mjs`);
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const mode=${JSON.stringify(mode)};
const note='PROJECTS_PROGRESS '+JSON.stringify({done:['Inspected the project'],remaining:['Run checks'],blocker:null});
if(process.env.RUNNER_TOKEN || process.env.DOPPLER_TOKEN || process.env.OPENAI_API_KEY)process.exit(8);
if(${JSON.stringify(agent)}==='codex') {
  let turns=0;
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);if(!m.method)return;
    if(m.method==='initialize')send({id:m.id,result:{}});
    if(m.method==='thread/resume'&&mode==='refuseResume'){send({id:m.id,error:{code:-32600,message:'refused'}});return;}
    if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'test-session',status:{type:'idle'}}}});
    if(m.method==='thread/unarchive')send({id:m.id,error:{code:-32600,message:'no archived rollout found'}});
    if(m.method==='thread/archive')send({id:m.id,result:{}});
    if(m.method==='turn/steer'){
      if(m.params.expectedTurnId!=='turn'){send({id:m.id,error:{code:-32600,message:'no active turn'}});return;}
      send({id:m.id,result:{turnId:'turn'}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({summary:'Connected '+m.params.input[0].text})}}});
      send({method:'turn/completed',params:{threadId:'test-session',turn:{status:'completed'}}});
      return;
    }
    if(m.method==='turn/start'&&mode==='steer'){
      send({id:m.id,result:{turn:{id:'turn'}}});
      send({method:'turn/started',params:{threadId:'test-session',turn:{id:'turn'}}});
      send({method:'turn/plan/updated',params:{threadId:'test-session',turnId:'turn',explanation:null,plan:[{step:'Read the code',status:'completed'},{step:'Make the change',status:'inProgress'},{step:'Run checks',status:'pending'}]}});
      return;
    }
    if(m.method==='turn/start'){
      send({id:m.id,result:{turn:{id:'turn'}}});
      turns++;
      if((mode==='busy'&&turns===1)||mode==='busyActed'||mode==='usage'||mode==='unauthorized'||mode==='contextWindowExceeded'||mode==='sandboxError'||mode==='novel'){
        if(mode==='busyActed')send({method:'item/started',params:{threadId:'test-session',item:{type:'commandExecution'}}});
        send({method:'turn/completed',params:{threadId:'test-session',turn:{status:'failed',error:{message:'x',codexErrorInfo:mode==='usage'?'usageLimitExceeded':mode==='novel'?'somethingNew':mode.startsWith('busy')?'serverOverloaded':mode}}}});
        return;
      }
      if(mode==='exit')process.exit(0);if(mode==='hang')return;
      send({method:'turn/started',params:{threadId:'test-session',turn:{id:'turn'}}});
      send({method:'item/started',params:{threadId:'foreign-session',item:{type:'fileChange'}}});
      send({method:'item/started',params:{threadId:'test-session',item:{type:'reasoning',content:['private-reasoning']}}});
      send({method:'item/completed',params:{threadId:'foreign-session',item:{type:'agentMessage',phase:'commentary',text:note}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'reasoning',text:note}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'commentary',text:'ordinary private commentary'}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'commentary',text:note}}});
      send({method:'item/started',params:{threadId:'test-session',item:{type:'commandExecution',command:'secret-command',arguments:{token:'private-token'}}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'commandExecution',status:'completed',aggregatedOutput:'private-output'}}});
      if(mode==='approval')send({id:101,method:'item/commandExecution/requestApproval',params:{}});
      const breakdown=(input,cached,output)=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:0});
      send({method:'thread/tokenUsage/updated',params:{threadId:'foreign-session',turnId:'turn',tokenUsage:{total:breakdown(99999,0,99999),last:breakdown(99999,0,99999),modelContextWindow:1}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'test-session',turnId:'turn',tokenUsage:{total:breakdown(5000,3000,200),last:breakdown(2000,1000,100),modelContextWindow:475000}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'test-session',turnId:'turn',tokenUsage:{total:breakdown(9000,6000,300),last:breakdown(4000,3000,100),modelContextWindow:475000}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({summary:'Connected'})}}});
      send({method:'turn/completed',params:{threadId:'test-session',turn:{status:mode==='failed'?'failed':'completed'}}});
    }
  });
} else {
  let lines=0;
  const finish=extra=>send({type:'result',subtype:mode==='maxTurns'?'error_max_turns':mode==='execution'?'error_during_execution':'success',is_error:mode==='execution',structured_output:mode==='maxTurns'||mode==='execution'?undefined:{summary:'Connected'+extra},permission_denials:mode==='approval'?[{tool_name:'Bash'}]:[],num_turns:2,usage:{input_tokens:15,cache_creation_input_tokens:1200,cache_read_input_tokens:1000,output_tokens:95},modelUsage:{'model-a':{inputTokens:9015,cacheCreationInputTokens:91200,cacheReadInputTokens:801000,outputTokens:7095,contextWindow:1000000}}});
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);
    if(++lines>1){if(mode==='steer')finish(' '+m.message.content[0].text);return;}
    if(mode==='exit')process.exit(0);if(mode==='hang'){setInterval(()=>{},1000);return;}
    // A resumed session can first report a turn that never ran, with the
    // whole session's per-model totals.
    if(mode==='stale')send({type:'result',subtype:'success',is_error:false,num_turns:0,usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0},modelUsage:{'model-a':{inputTokens:5000,cacheCreationInputTokens:90000,cacheReadInputTokens:800000,outputTokens:7000}}});
    send({type:'system',subtype:'init',session_id:'test-session'});
    send({type:'assistant',message:{id:'msg-1',usage:{input_tokens:10,cache_creation_input_tokens:1000,cache_read_input_tokens:0,output_tokens:50},content:[{type:'thinking',thinking:'private-reasoning'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'secret-command'}}]}});
    send({type:'assistant',message:{id:'msg-2',usage:{input_tokens:5,cache_creation_input_tokens:200,cache_read_input_tokens:1000,output_tokens:30},content:[{type:'thinking',thinking:note},{type:'text',text:'ordinary private commentary'},{type:'text',text:note}]}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'private-output'}]}});
    if(mode==='steer'){send({type:'assistant',message:{content:[{type:'tool_use',id:'todo-1',name:'TodoWrite',input:{todos:[{content:'Read the code',status:'completed',activeForm:'Reading'},{content:'Make the change',status:'in_progress',activeForm:'Changing'},{content:'Run checks',status:'pending',activeForm:'Checking'}]}}]}});return;}
    finish('');
  });
}

`,
    { mode: 0o700 },
  );
  return file;
}

test("feedback reaches a running Codex or Claude turn, and each reports its own plan", async () => {
  const dir = await fixture();
  try {
    for (const agent of ["codex", "claude"] as const) {
      const binary = await fakeBinary(dir, agent, "steer");
      const plans: LivePlanStep[][] = [];
      const value = await nativeTurn({
        agent, cwd: dir, prompt: "Change it", schema: {type: "object"}, readOnly: false,
        signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {},
        onPlan: (steps) => plans.push(steps),
        onSteer: (steer) => { setTimeout(() => void steer({text: "Use the blue button"}), 50); },
      });
      assert.deepEqual(value, {summary: "Connected Use the blue button"}, agent);
      assert.deepEqual(plans.at(-1), [{step: "Read the code", status: "done"}, {step: "Make the change", status: "active"}, {step: "Run checks", status: "pending"}], agent);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("the user's feedback reaches the agent working now, the live view follows it, and the master still reviews it", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [];
  const later: RunMessage = {id: randomUUID(), role: "user", text: "Use the blue button", at: Date.now(), delivery: "queued"};
  let current = [...o.run.messages], masters = 0;
  const delivered: string[] = [];
  o.latestMessages = () => current;
  o.messages = async () => current;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.changes = async () => ({files: [{path: "src/button.tsx", added: 3, removed: 1}], total: {files: 1, added: 3, removed: 1}, at: Date.now()});
  o.liveChangesMs = 20;
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change" as const}} : complete;
    opts.onPlan?.([{step: "Make the change", status: "active"}]);
    // Let a progress report carry the live view before the user writes.
    for (let i = 0; i < 100 && !reports.some((r) => r.live?.changes); i++) await new Promise((r) => setTimeout(r, 50));
    return new Promise((resolve) => {
      opts.onSteer?.(async (input) => { delivered.push(input.text); resolve(result); });
      current = [...current, later];
    });
  };
  try {
    await executeRun(o);
    assert.match(delivered[0], /Use the blue button/);
    assert.ok(reports.some((r) => r.steeredMessageIds?.includes(later.id)), "the Worker hears it reached the agent");
    assert.ok(reports.some((r) => r.live?.actor === "claude" && r.live.plan?.[0]?.step === "Make the change" && r.live.changes?.total.files === 1), "the live view shows the plan and changes");
    const last = reports.at(-1)!;
    assert.ok(last.reviewedMessageIds?.includes(later.id), "the master reviewed it at its next decision");
    assert.equal(last.live, undefined, "no live view once work stops");
    assert.equal(masters, 2);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("feedback that reaches the master mid-decision is part of that decision", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir);
  const later: RunMessage = {id: randomUUID(), role: "user", text: "Make it short", at: Date.now(), delivery: "queued"};
  let current = [...o.run.messages], masters = 0, latest: Progress | undefined;
  o.latestMessages = () => current;
  o.messages = async () => current;
  o.report = async (p) => { latest = structuredClone(p); };
  o.turn = async (opts) => {
    masters++;
    await opts.onSession(randomUUID());
    return new Promise((resolve) => {
      opts.onSteer?.(async () => resolve(complete));
      current = [...current, later];
    });
  };
  try {
    await executeRun(o);
    assert.equal(masters, 1, "no second decision just to reread it");
    assert.ok(latest?.reviewedMessageIds?.includes(later.id));
    assert.equal(latest?.state, "completed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("live changes count the branch's committed, uncommitted and new files", async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin"), work = path.join(dir, "work");
    await git(dir, ["init", "--bare", origin]);
    await git(dir, ["clone", origin, work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "Test"]);
    await git(work, ["checkout", "-b", "main"]);
    await writeFile(path.join(work, "a.txt"), "one\ntwo\n");
    await git(work, ["add", "a.txt"]);
    await git(work, ["commit", "-m", "Initial"]);
    await git(work, ["push", "-u", "origin", "main"]);
    await git(work, ["checkout", "-b", "projects/work"]);
    await writeFile(path.join(work, "a.txt"), "one\nthree\n");
    await git(work, ["commit", "-am", "Committed change"]);
    await writeFile(path.join(work, "a.txt"), "one\nthree\nfour\n");
    await writeFile(path.join(work, "new.txt"), "x\ny\nz\n");
    const changes = await liveChanges(work);
    assert.deepEqual(changes.files, [{path: "a.txt", added: 2, removed: 1}, {path: "new.txt", added: 3, removed: 0}]);
    assert.deepEqual(changes.total, {files: 2, added: 5, removed: 1});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a change worktree saved on one machine is recreated on the other with its uncommitted work", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin.git");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    const clone = async (name: string) => {
      const cwd = path.join(dir, name, "repo");
      await git(dir, ["clone", origin, cwd]);
      await git(cwd, ["config", "user.email", "test@example.invalid"]);
      await git(cwd, ["config", "user.name", "Test"]);
      return {id: "acme/test", name: "Test", cwd, plan: null};
    };
    const seed = await clone("seed");
    await git(seed.cwd, ["checkout", "-b", "main"]);
    await writeFile(path.join(seed.cwd, "a.txt"), "one\n");
    await writeFile(path.join(seed.cwd, "b.txt"), "keep\n");
    await git(seed.cwd, ["add", "."]);
    await git(seed.cwd, ["commit", "-m", "Initial"]);
    await git(seed.cwd, ["push", "-u", "origin", "main"]);
    const studio = await clone("studio"), laptop = await clone("laptop");
    const runId = randomUUID(), childId = randomUUID();
    const task = {...dispatch().task!, mode: "change" as const};
    const ws = await prepareWorkspace(studio, task, [], runId, childId, path.join(dir, "studio-runs"), "studio");
    await writeFile(path.join(ws.cwd, "a.txt"), "one\ntwo\n");
    await git(ws.cwd, ["commit", "-am", "Committed, not pushed"]);
    await writeFile(path.join(ws.cwd, "a.txt"), "one\ntwo\nthree\n");
    await rm(path.join(ws.cwd, "b.txt"));
    await writeFile(path.join(ws.cwd, "new.txt"), "fresh\n");
    const saved = await saveWorkspace(ws.cwd, runId, childId, {isPrivate: async () => true});
    assert.ok(saved);
    assert.match(await git(studio.cwd, ["ls-remote", "origin", savedRef(runId, childId)]), new RegExp(saved!.commit));
    const child: Child = {...ws, id: childId, projectId: studio.id, agent: "codex", mode: "change", state: "unknown", sessionId: "studio-session", result: null, evidence: [], host: "studio"};
    const restored = await prepareWorkspace(laptop, {...task, workspace: childId}, [child], runId, randomUUID(), path.join(dir, "laptop-runs"), "laptop");
    assert.equal(restored.restored, true);
    assert.equal(restored.sessionId, null, "a new session here; the old one stays on the Studio");
    assert.equal(restored.branch, ws.branch);
    assert.equal(await readFile(path.join(restored.cwd, "a.txt"), "utf8"), "one\ntwo\nthree\n");
    assert.equal(await readFile(path.join(restored.cwd, "new.txt"), "utf8"), "fresh\n");
    assert.deepEqual((await git(restored.cwd, ["status", "--porcelain"])).split("\n").map((line) => line.trim()).sort(), ["?? new.txt", "D b.txt", "M a.txt"]);
    assert.equal(await git(restored.cwd, ["log", "-1", "--format=%s"]), "Committed, not pushed");
    // Asking again reuses the copy already made here.
    const again = await prepareWorkspace(laptop, {...task, workspace: childId}, [child], runId, randomUUID(), path.join(dir, "laptop-runs"), "laptop");
    assert.deepEqual([again.cwd, again.restored], [restored.cwd, undefined]);
    // A branch pushed after the save supersedes it.
    await git(ws.cwd, ["add", "-A"]);
    await git(ws.cwd, ["commit", "-m", "Finished"]);
    await git(ws.cwd, ["push", "origin", `HEAD:refs/heads/${ws.branch}`]);
    const third = await clone("third");
    const newer = await prepareWorkspace(third, {...task, workspace: childId}, [child], runId, randomUUID(), path.join(dir, "third-runs"), "laptop");
    assert.equal(await git(newer.cwd, ["log", "-1", "--format=%s"]), "Finished");
    assert.equal(await git(newer.cwd, ["status", "--porcelain"]), "");
    // Once everything is on GitHub, the saved copy is removed.
    assert.equal(await saveWorkspace(ws.cwd, runId, childId, {isPrivate: async () => true}), null);
    assert.equal(await git(studio.cwd, ["ls-remote", "origin", savedRef(runId, childId)]), "");
    // A workspace never saved or pushed cannot move.
    const lost = {...child, id: randomUUID(), branch: "projects/never/saved"};
    await assert.rejects(prepareWorkspace(third, {...task, workspace: lost.id}, [lost], runId, randomUUID(), path.join(dir, "third-runs"), "laptop"), UnsavedWorkspace);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("the other machine continues a worktree from the newest copy any of its children saved", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin.git");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    const clone = async (name: string) => {
      const cwd = path.join(dir, name, "repo");
      await git(dir, ["clone", origin, cwd]);
      await git(cwd, ["config", "user.email", "test@example.invalid"]);
      await git(cwd, ["config", "user.name", "Test"]);
      return {id: "acme/test", name: "Test", cwd, plan: null};
    };
    const seed = await clone("seed");
    await git(seed.cwd, ["checkout", "-b", "main"]);
    await writeFile(path.join(seed.cwd, "a.txt"), "one\n");
    await git(seed.cwd, ["add", "."]);
    await git(seed.cwd, ["commit", "-m", "Initial"]);
    await git(seed.cwd, ["push", "-u", "origin", "main"]);
    const studio = await clone("studio"), laptop = await clone("laptop");
    const runId = randomUUID(), first = randomUUID(), second = randomUUID();
    const task = {...dispatch().task!, mode: "change" as const};
    const miniRuns = path.join(dir, "studio-runs"), airRuns = path.join(dir, "laptop-runs");
    const ws = await prepareWorkspace(studio, task, [], runId, first, miniRuns, "studio");
    const firstChild: Child = {...ws, id: first, projectId: studio.id, agent: "codex", mode: "change", state: "completed", sessionId: "first-session", result, evidence: [], host: "studio"};
    await writeFile(path.join(ws.cwd, "a.txt"), "first turn\n");
    assert.ok(await saveWorkspace(ws.cwd, runId, first, {isPrivate: async () => true}));
    // A follow-up works on in the same worktree and saves newer work under its own ID.
    const reused = await prepareWorkspace(studio, {...task, workspace: first}, [firstChild], runId, second, miniRuns, "studio");
    assert.equal(reused.cwd, ws.cwd);
    const secondChild: Child = {...firstChild, ...reused, id: second, sessionId: "second-session", state: "unknown"};
    await writeFile(path.join(ws.cwd, "a.txt"), "second turn\n");
    const newest = await saveWorkspace(ws.cwd, runId, second, {isPrivate: async () => true});
    assert.ok(newest);
    const children = [firstChild, secondChild];
    // The master names the worktree's first child: the second child's newer copy comes back.
    const restored = await prepareWorkspace(laptop, {...task, workspace: first}, children, runId, randomUUID(), airRuns, "laptop");
    assert.equal(restored.restored, true);
    assert.equal(await readFile(path.join(restored.cwd, "a.txt"), "utf8"), "second turn\n");
    assert.equal(restored.savedAt, Number(await git(studio.cwd, ["log", "-1", "--format=%ct", newest!.commit])) * 1000, "the copy's own time, not an assumed interval");
    // Naming the later child reuses that copy instead of making a second one.
    const again = await prepareWorkspace(laptop, {...task, workspace: second}, children, runId, randomUUID(), airRuns, "laptop");
    assert.deepEqual([again.cwd, again.restored], [restored.cwd, undefined]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("work in progress is saved only to a private origin, through its hooks and without credentials", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin.git"), cwd = path.join(dir, "work"), hooks = path.join(dir, "hooks");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    await git(dir, ["clone", origin, cwd]);
    await git(cwd, ["config", "user.email", "test@example.invalid"]);
    await git(cwd, ["config", "user.name", "Test"]);
    await git(cwd, ["checkout", "-b", "main"]);
    await writeFile(path.join(cwd, "a.txt"), "one\n");
    await writeFile(path.join(cwd, "deploy-token.txt"), "placeholder\n");
    await writeFile(path.join(cwd, "settings.example"), "KEY=example\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "Initial"]);
    await git(cwd, ["push", "-u", "origin", "main"]);
    await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
    await writeFile(path.join(cwd, "deploy-token.txt"), "real-value\n");
    await rename(path.join(cwd, "settings.example"), path.join(cwd, ".env.production"));
    await writeFile(path.join(cwd, ".dev.vars"), "API_KEY=real\n");
    const runId = randomUUID(), childId = randomUUID(), ref = savedRef(runId, childId);
    assert.equal(await privateOrigin(cwd), false, "a remote off GitHub is not known to be private");
    assert.equal(await saveWorkspace(cwd, runId, childId), null);
    assert.equal(await saveWorkspace(cwd, runId, childId, {isPrivate: async () => false}), null, "a public repository gets nothing");
    assert.equal(await git(cwd, ["ls-remote", "origin", ref]), "");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-push"), `#!/bin/sh\ntouch "${path.join(dir, "hook-ran")}"\n`, {mode: 0o755});
    await git(cwd, ["config", "core.hooksPath", hooks]);
    const saved = await saveWorkspace(cwd, runId, childId, {isPrivate: async () => true});
    assert.ok(saved);
    assert.ok(await stat(path.join(dir, "hook-ran")), "the repository's own push hook ran");
    assert.match(await git(cwd, ["ls-remote", "origin", ref]), new RegExp(saved!.commit));
    assert.deepEqual((await git(cwd, ["ls-tree", "-r", "--name-only", saved!.commit])).split("\n"), ["a.txt", "deploy-token.txt"], "a renamed or new credential-like file stays local");
    assert.equal(await git(cwd, ["show", `${saved!.commit}:deploy-token.txt`]), "placeholder", "a changed credential-like file keeps its committed version");
    assert.equal(await git(cwd, ["show", `${saved!.commit}:a.txt`]), "one\ntwo");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a change child's work is saved while it runs and its saved time is reported", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [];
  let saves = 0, masters = 0;
  o.save = async () => ({commit: "abc", at: Date.now() - 1000 * ++saves});
  o.saveMs = 20;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change" as const}} : complete;
    for (let i = 0; i < 100 && !reports.some((r) => r.live?.savedAt); i++) await new Promise((r) => setTimeout(r, 50));
    return result;
  };
  try {
    await executeRun(o);
    assert.ok(saves >= 2, "saved during the turn and once more at its end");
    assert.ok(reports.some((r) => r.live?.savedAt));
    assert.match(reports.at(-1)!.children[0].evidence.at(-1)!, /^Observed saved copy on GitHub: /);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// A bare origin with main, and a clone of it for each machine.
async function originFixture(dir: string) {
  const origin = path.join(dir, "origin.git");
  await git(dir, ["init", "--bare", "-b", "main", origin]);
  const clone = async (name: string) => {
    const cwd = path.join(dir, name, "repo");
    await git(dir, ["clone", origin, cwd]);
    await git(cwd, ["config", "user.email", "test@example.invalid"]);
    await git(cwd, ["config", "user.name", "Test"]);
    return {id: "acme/test", name: "Test", cwd, plan: null};
  };
  const seed = await clone("seed");
  await git(seed.cwd, ["checkout", "-b", "main"]);
  await writeFile(path.join(seed.cwd, "a.txt"), "one\n");
  await git(seed.cwd, ["add", "."]);
  await git(seed.cwd, ["commit", "-m", "Initial"]);
  await git(seed.cwd, ["push", "-u", "origin", "main"]);
  return clone;
}
// The children whose copies of this conversation are on the origin.
const savedIds = async (cwd: string, runId: string) =>
  (await git(cwd, ["ls-remote", "origin", savedRef(runId, "*")])).split("\n").filter(Boolean).map((line) => line.split("/").at(-1)!).sort();
const changeChild = (id: string, place: {cwd: string; branch: string}, host: "studio" | "laptop"): Child =>
  ({...place, id, projectId: "acme/test", agent: "codex", mode: "change", state: "completed", sessionId: null, result, evidence: [], host});

test("a worktree keeps one copy on GitHub, and GitHub, not the runner's memory, decides when it goes", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const studio = await (await originFixture(dir))("studio");
    const runId = randomUUID(), first = randomUUID(), second = randomUUID(), third = randomUUID();
    const ws = await prepareWorkspace(studio, {...dispatch().task!, mode: "change" as const}, [], runId, first, path.join(dir, "runs"), "studio");
    const merged = new Set<string>();
    const save = (child: string, older: string[] = []) =>
      saveWorkspace(ws.cwd, runId, child, {older, isPrivate: async () => true, landed: async (_cwd, commit) => merged.has(commit)});
    // The first turn ends with work only this machine has; the runner restarts.
    await writeFile(path.join(ws.cwd, "a.txt"), "first turn\n");
    assert.ok(await save(first));
    assert.deepEqual(await savedIds(studio.cwd, runId), [first]);
    // A follow-up in the same worktree commits and pushes before saving anything.
    await git(ws.cwd, ["commit", "-am", "Second turn"]);
    await git(ws.cwd, ["push", "-u", "origin", ws.branch]);
    assert.equal(await save(second, [first]), null);
    assert.deepEqual(await savedIds(studio.cwd, runId), [], "the first turn's copy goes once GitHub has the work");
    // Each save replaces the copies earlier children made in this worktree.
    await writeFile(path.join(ws.cwd, "a.txt"), "second turn, more\n");
    assert.ok(await save(second, [first]));
    await writeFile(path.join(ws.cwd, "a.txt"), "third turn\n");
    const newest = await save(third, [first, second]);
    assert.deepEqual(await savedIds(studio.cwd, runId), [third]);
    assert.equal(await git(studio.cwd, ["show", `${newest!.commit}:a.txt`]), "third turn");
    // Once its branch has landed, leftover changes are not kept.
    merged.add(await git(ws.cwd, ["rev-parse", "HEAD"]));
    assert.equal(await save(third, [first, second]), null);
    assert.deepEqual(await savedIds(studio.cwd, runId), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("after a turn the Studio keeps only the newest copy of a worktree that alone holds its work", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const studio = await (await originFixture(dir))("studio");
    const runId = randomUUID(), root = path.join(dir, "runs");
    const [a1, a2, b, c, stranger] = Array.from({length: 5}, () => randomUUID());
    const task = {...dispatch().task!, mode: "change" as const};
    const keep = {isPrivate: async () => true, landed: async () => false};
    // a1 and a2 worked in one worktree that still holds unsaved work; an
    // earlier runner left a1's copy behind.
    const w1 = await prepareWorkspace(studio, task, [], runId, a1, root, "studio");
    await writeFile(path.join(w1.cwd, "a.txt"), "unsaved\n");
    await saveWorkspace(w1.cwd, runId, a1, keep);
    await saveWorkspace(w1.cwd, runId, a2, keep);
    // b's work reached its branch after its last save.
    const w2 = await prepareWorkspace(studio, task, [], runId, b, root, "studio");
    await writeFile(path.join(w2.cwd, "b.txt"), "done\n");
    await saveWorkspace(w2.cwd, runId, b, keep);
    await git(w2.cwd, ["add", "."]);
    await git(w2.cwd, ["commit", "-m", "Done"]);
    await git(w2.cwd, ["push", "-u", "origin", w2.branch]);
    // c's worktree is gone; only its copy holds the work.
    const w3 = await prepareWorkspace(studio, task, [], runId, c, root, "studio");
    await writeFile(path.join(w3.cwd, "a.txt"), "committed\n");
    await git(w3.cwd, ["commit", "-am", "Branch work"]);
    await writeFile(path.join(w3.cwd, "a.txt"), "only in the copy\n");
    await saveWorkspace(w3.cwd, runId, c, keep);
    const base = await git(w3.cwd, ["rev-parse", "HEAD"]);
    await rm(w3.cwd, {recursive: true, force: true});
    // A copy of no recorded child, and one fetched here earlier.
    await git(studio.cwd, ["push", "origin", `HEAD:${savedRef(runId, stranger)}`]);
    await git(studio.cwd, ["update-ref", savedRef(runId, a1), "HEAD"]);
    assert.deepEqual(await savedRuns(studio.cwd), [runId]);
    const children = [changeChild(a1, w1, "studio"), changeChild(a2, w1, "studio"), changeChild(b, w2, "studio"), changeChild(c, w3, "studio")];
    const merged = new Set<string>();
    const prune = () => pruneSaved(studio, runId, children, root, "studio", async (_cwd, commit) => merged.has(commit));
    await prune();
    assert.deepEqual(await savedIds(studio.cwd, runId), [a2, c, stranger].sort());
    assert.equal(await git(studio.cwd, ["for-each-ref", "refs/projects/wip"]), "", "no fetched copy stays here");
    // A worktree still at main's commit has not landed, whatever merged there.
    merged.add(base).add(await git(w1.cwd, ["rev-parse", "HEAD"]));
    await prune();
    assert.deepEqual(await savedIds(studio.cwd, runId), [a2, stranger].sort(), "a copy goes once its branch has landed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a machine removes another's copies once it recreates their worktree or their branch lands, and keeps its own while they hold unlanded work", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const clone = await originFixture(dir);
    const studio = await clone("studio"), laptop = await clone("laptop");
    const runId = randomUUID(), miniRuns = path.join(dir, "studio-runs"), airRuns = path.join(dir, "laptop-runs");
    const [a1, a2, d, here, own] = Array.from({length: 5}, () => randomUUID());
    const task = {...dispatch().task!, mode: "change" as const};
    const keep = {isPrivate: async () => true, landed: async () => false};
    const w1 = await prepareWorkspace(studio, task, [], runId, a1, miniRuns, "studio");
    await writeFile(path.join(w1.cwd, "a.txt"), "first\n");
    await saveWorkspace(w1.cwd, runId, a1, keep);
    await writeFile(path.join(w1.cwd, "a.txt"), "second\n");
    await saveWorkspace(w1.cwd, runId, a2, keep);
    const w4 = await prepareWorkspace(studio, task, [], runId, d, miniRuns, "studio");
    await writeFile(path.join(w4.cwd, "a.txt"), "committed\n");
    await git(w4.cwd, ["commit", "-am", "Branch work"]);
    await writeFile(path.join(w4.cwd, "a.txt"), "never continued\n");
    await saveWorkspace(w4.cwd, runId, d, keep);
    const base = await git(w4.cwd, ["rev-parse", "HEAD"]);
    // A copy an earlier runner here saved of its own worktree, since removed.
    await writeFile(path.join(laptop.cwd, "own.txt"), "own work\n");
    await git(laptop.cwd, ["add", "own.txt"]);
    await git(laptop.cwd, ["commit", "-qm", "Own work"]);
    const ownBase = await git(laptop.cwd, ["rev-parse", "HEAD"]);
    await git(laptop.cwd, ["push", "origin", `HEAD:${savedRef(runId, own)}`]);
    await git(laptop.cwd, ["reset", "-q", "--hard", "HEAD~1"]);
    const minis = [changeChild(a1, w1, "studio"), changeChild(a2, w1, "studio"), changeChild(d, w4, "studio")];
    const restored = await prepareWorkspace(laptop, {...task, workspace: a2}, minis, runId, here, airRuns, "laptop");
    assert.equal(await readFile(path.join(restored.cwd, "a.txt"), "utf8"), "second\n");
    const children = [...minis, changeChild(here, restored, "laptop"), changeChild(own, {cwd: path.join(airRuns, "gone"), branch: "projects/gone"}, "laptop")];
    const merged = new Set<string>();
    const prune = () => pruneSaved(laptop, runId, children, airRuns, "laptop", async (_cwd, commit) => merged.has(commit));
    await prune();
    assert.deepEqual(await savedIds(laptop.cwd, runId), [d, own].sort(), "work nobody has continued stays, and so does this machine's own copy");
    assert.equal(await git(laptop.cwd, ["for-each-ref", "refs/projects/wip"]), "", "the copy fetched to recreate the worktree is removed");
    merged.add(base).add(ownBase);
    await prune();
    assert.deepEqual(await savedIds(laptop.cwd, runId), [], "each copy goes once its branch has landed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("every machine saves; a follow-up's save replaces its worktree's earlier copies; a finished turn prunes", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [];
  const saves: [string, string[]][] = [], prunes: [string, string[], string][] = [];
  o.save = async (_cwd, _run, childId, options) => { saves.push([childId, options?.older ?? []]); return null; };
  o.prune = async (project, _run, children, _root, host) => { prunes.push([project.id, children.map((c) => c.id), host]); };
  o.report = async (p) => { reports.push(structuredClone(p)); };
  const change = (workspace = "new"): MasterDecision => ({...dispatch(workspace), task: {...dispatch(workspace).task!, mode: "change"}});
  let decisions = [change(), complete];
  o.turn = async (opts) => { await opts.onSession(randomUUID()); return opts.agent === "codex" ? decisions.shift() : result; };
  try {
    await executeRun(o);
    const first = reports.at(-1)!.children[0].id;
    decisions = [change(first), complete];
    await executeRun({...o, run: {...o.run, generation: 2, progress: reports.at(-1)!}});
    const second = reports.at(-1)!.children[1].id;
    assert.deepEqual(saves, [[first, []], [second, [first]]]);
    assert.deepEqual(prunes, [["acme/test", [first], "studio"], ["acme/test", [first, second], "studio"]]);
    saves.length = prunes.length = 0;
    decisions = [change(), complete];
    await executeRun({...o, host: "laptop", run: makeRun()});
    assert.equal(saves.length, 1, "any machine's conversation can move, so each saves");
    assert.deepEqual(prunes.map(([, , host]) => host), ["laptop"]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a failed save is recorded once per failing stretch with a safe reason, and the work continues", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [];
  let saves = 0, masters = 0;
  o.save = async () => {
    saves++;
    await git(dir, ["not-a-git-command"]);
    throw Error("unreachable");
  };
  o.saveMs = 20;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change" as const}} : complete;
    while (saves < 3) await new Promise((r) => setTimeout(r, 10));
    return result;
  };
  try {
    await executeRun(o);
    const last = reports.at(-1)!;
    assert.equal(last.state, "completed");
    const failed = last.telemetry!.filter((e) => e.event === "workspace_save_failed");
    assert.deepEqual(failed.map((e) => [e.reason, e.childId, e.actor]), [["git_failed", last.children[0].id, "claude"]]);
    assert.doesNotMatch(JSON.stringify(last.telemetry), /Inspect the repository/, "no error text leaves the runner");
    assert.ok(!last.children[0].evidence.some((line) => /saved copy/.test(line)), "no saved copy is claimed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("every native and runner failure carries a precise cause, and the master hears it first", {timeout: 30000}, async () => {
  const dir = await fixture();
  try {
    const cases: [("codex" | "claude"), string, string, RegExp][] = [
      ["codex", "unauthorized", "signed_out", /signed out on this machine/],
      ["codex", "contextWindowExceeded", "context_exceeded", /ran out of room/],
      ["codex", "sandboxError", "sandbox_error", /sandbox could not run a command/],
      ["codex", "novel", "turn_failed", /what it finished is unconfirmed/],
      ["claude", "maxTurns", "turn_limit", /turn limit/],
      ["claude", "execution", "turn_failed", /what it finished is unconfirmed/],
      ["claude", "exit", "native_exited", /exited before confirming/],
    ];
    for (const [agent, mode, reason, message] of cases) {
      const binary = await fakeBinary(dir, agent, mode);
      await assert.rejects(
        nativeTurn({agent, cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: false, signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {}}),
        (error: unknown) => error instanceof Failure && error.reason === reason && message.test(error.message) && !/inspect/i.test(error.message),
        `${agent} ${mode}`,
      );
    }
    // The runner's own refusals are named by their type, not their text, and
    // go back to the master, which chooses again before the owner hears.
    const gitFails = async () => { await git(dir, ["not-a-git-command"]); throw Error("unreachable"); };
    for (const [workspace, prepare, reason, failure] of [
      [randomUUID(), prepareWorkspace, "workspace_changed", /could not use that workspace: The requested workspace does not belong to this conversation/],
      ["new", gitFails, "git_failed", /could not use that workspace: Git could not verify or prepare this workspace/],
    ] as const) {
      const o = engineOptions(dir), reports: Progress[] = [], prompts: string[] = [];
      o.report = async (p) => { reports.push(structuredClone(p)); };
      o.prepare = prepare;
      o.turn = async (opts) => { prompts.push(opts.prompt); await opts.onSession(randomUUID()); return prompts.length === 1 ? dispatch(workspace) : complete; };
      await executeRun(o);
      assert.equal(reports.at(-1)!.state, "completed", "the master chose again");
      assert.equal(reports.at(-1)!.telemetry?.find((e) => e.event === "execution_handed_back")?.reason, reason);
      assert.match(prompts[1], failure, "the master reads the plain cause");
      assert.match(prompts[1], /has NOT been executed/);
    }
    // A master that keeps choosing what cannot run stops the turn, and the
    // owner reads the last cause and what to do.
    {
      const o = engineOptions(dir), reports: Progress[] = [];
      o.report = async (p) => { reports.push(structuredClone(p)); };
      o.prepare = prepareWorkspace;
      o.turn = async (opts) => { await opts.onSession(randomUUID()); return dispatch(randomUUID()); };
      await executeRun(o);
      const last = reports.at(-1)!;
      assert.equal(last.state, "blocked");
      assert.equal(last.telemetry?.filter((e) => e.event === "execution_handed_back").length, HANDBACK_LIMIT + 1);
      assert.equal(last.telemetry?.find((e) => e.event === "execution_interrupted")?.reason, "recovery_limit");
      assert.match(last.summary, /problems in a row, so Projects paused it\. The last one: The requested workspace does not belong/);
      assert.match(last.summary, /\*\*Your move:\*\* Send a follow-up/);
    }
    // A stop the runner made names the interruption, not the failure it caused.
    for (const [stop, reason] of [["claim-lost", "claim_lost"], ["cancelled", "cancelled"]] as const) {
      const o = engineOptions(dir), reports: Progress[] = [], control = new AbortController();
      o.signal = control.signal;
      o.report = async (p) => { reports.push(structuredClone(p)); };
      o.prepare = async () => { control.abort(stop); throw new Failure("report_failed", "Runner request failed (409)."); };
      o.turn = async (opts) => { await opts.onSession(randomUUID()); return dispatch(); };
      await executeRun(o);
      assert.equal(reports.at(-1)!.telemetry?.find((e) => e.event === "execution_interrupted")?.reason, reason);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("helpers get the user's connectors read and write, but never email sending, unapproved local servers or account administration", async () => {
  const list = parseMcpList([
    "Checking MCP server health…",
    "",
    "claude.ai Example Docs: https://docs.example.com/mcp - ✔ Connected",
    "claude.ai Example Books: https://books.example.com/mcp - ✔ Connected",
    "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected",
    "plugin:viewer:files: npx -y example-viewer --stdio - ✔ Connected",
    "example-db: /usr/local/bin/example-db mcp start - ✔ Connected",
    "notes: /usr/local/bin/node /x/index.js - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed",
  ].join("\n"));
  assert.deepEqual(list.connectors, ["claude_ai_Example_Docs", "claude_ai_Example_Books", "claude_ai_Gmail"]);
  assert.deepEqual(list.local, ["plugin_viewer_files", "example-db", "notes"]);
  const policy = {localServers: ["example-db"], deniedTools: ["mcp__example-db__drop_database"]};
  const claude = claudeRules(list, policy)!;
  assert.deepEqual(claude.allow, ["mcp__claude_ai_Example_Docs", "mcp__claude_ai_Example_Books", "mcp__claude_ai_Gmail", "mcp__example-db"]);
  assert.deepEqual(claude.deny.slice(0, 2), ["mcp__plugin_viewer_files", "mcp__notes"], "unapproved local servers stay hidden");
  assert.ok(claude.deny.includes("mcp__example-db__drop_database"), "the machine's denied tools stay hidden");
  assert.ok(!claude.deny.includes("mcp__example-db__query"), "the approved server's other tools are allowed");
  assert.deepEqual(claudeRules(list)!.allow.filter((rule) => !rule.startsWith("mcp__claude_ai_")), [], "without a policy no local server is approved");
  for (const tool of ["send_message", "reply", "forward", "send_email", "forward_email"])
    assert.ok(claude.deny.includes(`mcp__claude_ai_Gmail__${tool}`), tool);
  assert.ok(!claude.deny.some((rule) => rule.startsWith("mcp__claude_ai_Example_Books__")), "other connectors keep every tool");
  // Any mail connector, not just Gmail, loses sending.
  assert.ok(claudeRules({connectors: ["claude_ai_Outlook_Mail"], local: []})!.deny.includes("mcp__claude_ai_Outlook_Mail__send_email"));
  assert.ok(codexConfig([{id: "connector_outlook", runtimeName: "Outlook Email"}]).includes("apps.connector_outlook.tools.send_email.enabled=false"));
  assert.equal(claudeRules({connectors: [], local: ["example-db"]}, policy), null, "no connectors listed: keep the browser-only setup");
  const codex = codexConfig([{id: "connector_gmail1", runtimeName: "Gmail"}, {id: "connector_drive", runtimeName: "Google Drive"}]);
  const values = codex.filter((_, i) => i % 2);
  assert.ok(codex.every((arg, i) => i % 2 || arg === "-c"));
  assert.ok(values.includes('apps._default.default_tools_approval_mode="approve"'));
  assert.ok(values.includes("apps.connector_openai_safety_settings.enabled=false"));
  assert.ok(values.includes("apps.connector_openai_plugin_management.enabled=false"));
  for (const tool of ["send_email", "send_draft", "forward_emails", "delete_emails"])
    assert.ok(values.includes(`apps.connector_gmail1.tools.${tool}.enabled=false`), tool);
  assert.ok(!values.some((value) => value.includes("connector_drive")), "other connectors keep every tool");
  assert.ok(!values.some((value) => value.startsWith("mcp_servers.")), "Codex MCP servers keep Codex's own defaults");
  // The native launches carry exactly those rules; without them Claude stays browser-only.
  const dir = await fixture();
  try {
    for (const agent of ["claude", "codex"] as const) for (const granted of [true, false]) {
      const binary = await fakeBinary(dir, agent, "success");
      const capture = path.join(dir, "launch.json");
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("import readline", `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\nimport readline`));
      await nativeTurn({agent, cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: false, signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {}, connectors: granted ? {claude, codex} : undefined});
      const args: string[] = JSON.parse(await readFile(capture, "utf8"));
      if (agent === "claude") {
        assert.equal(args.includes("--strict-mcp-config"), !granted);
        assert.equal(args[args.indexOf("--allowedTools") + 1].includes("mcp__claude_ai_Gmail"), granted);
        if (granted) {
          const denied = args[args.indexOf("--disallowedTools") + 1];
          assert.match(denied, /mcp__claude_ai_Gmail__send_message/);
          assert.match(denied, /mcp__example-db__drop_database/);
          assert.match(denied, /mcp__notes/);
        }
      } else assert.equal(args.includes('apps._default.default_tools_approval_mode="approve"'), granted);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("only helpers get connectors: never the master", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const access = {claude: {allow: ["mcp__claude_ai_Example_Books"], deny: []}, codex: ["-c", "apps._default.enabled=true"]};
  o.connectors = async () => access;
  o.turn = async (opts) => { calls.push(opts); await opts.onSession(randomUUID()); return calls.length === 1 ? dispatch() : calls.length === 2 ? result : complete; };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.connectors === access), [false, true, false]);
    assert.match(calls[1].prompt, /sending, replying and forwarding are switched off/);
    assert.doesNotMatch(calls[0].prompt, /connected accounts/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("native browser credentials travel through environment and read sessions cannot interact", async () => {
  const dir = await fixture();
  const browser = {endpoint: "wss://projects.example.com/api/browser/test/cdp", capability: "fixture-scoped-browser-capability", outputDir: path.join(dir, "artifacts")};
  try {
    for (const agent of ["codex", "claude"] as const) for (const readOnly of [true, false]) {
      const binary = await fakeBinary(dir, agent, "success");
      const capture = path.join(dir, "launch.json");
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("import readline", `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2), endpoint:process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT, header:process.env.PLAYWRIGHT_MCP_CDP_HEADERS}));\nimport readline`));
      await nativeTurn({agent, cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly, browser, signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {}});
      const launch = JSON.parse(await readFile(capture, "utf8"));
      assert.equal(launch.endpoint, browser.endpoint);
      assert.equal(launch.header, `Authorization: Bearer ${browser.capability}`);
      assert.doesNotMatch(JSON.stringify(launch.args), /fixture-scoped-browser-capability|Authorization/);
      const toolConfiguration = agent === "claude" ? launch.args[launch.args.indexOf("--allowedTools") + 1]
        : launch.args.find((arg: string) => arg.startsWith("mcp_servers.projects_browser.enabled_tools="));
      assert.match(toolConfiguration, /browser_navigate/);
      assert.equal(toolConfiguration.includes("browser_snapshot"), !readOnly);
      assert.equal(toolConfiguration.includes("browser_take_screenshot"), !readOnly);
      assert.equal(toolConfiguration.includes("browser_click"), !readOnly);
      assert.doesNotMatch(toolConfiguration, /browser_evaluate|browser_run_code|browser_cookie|browser_file_upload/);
      if (agent === "codex") {
        const approvals = launch.args.filter((arg: string) => arg.includes(".approval_mode="));
        assert.deepEqual(approvals, browserTools(readOnly).map(tool => `mcp_servers.projects_browser.tools.${tool}.approval_mode="approve"`));
        assert.ok(!launch.args.some((arg: string) => arg.includes("default_tools_approval_mode")));
      } else {
        const denied = launch.args[launch.args.indexOf("--disallowedTools") + 1].split(",");
        const upstream = [...(await readFile("node_modules/@playwright/mcp/README.md", "utf8")).matchAll(/^- \*\*(browser_[a-z_]+)\*\*/gm)].map(match => match[1]);
        assert.ok(upstream.length > 50);
        for (const tool of upstream) assert.equal(denied.includes(`mcp__projects_browser__${tool}`), !browserTools(readOnly).includes(tool), `pinned tool visibility: ${tool}`);
        assert.deepEqual(hiddenBrowserTools(readOnly).map(tool => `mcp__projects_browser__${tool}`), denied);
      }
      assert.match(JSON.stringify(launch.args), /@playwright\/mcp@0.0.83/);
      // Every Claude session, change helpers included, gets only this browser:
      // The user's own connectors would be refused unattended and fail the turn.
      if (agent === "claude") {
        assert.ok(launch.args.includes("--strict-mcp-config"), `strict MCP when readOnly=${readOnly}`);
        assert.deepEqual(Object.keys(JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]).mcpServers), ["projects_browser"]);
      }
    }
    assert.equal(nativeEnv(browser).RUNNER_TOKEN, undefined);
    assert.equal(nativeEnv(browser).DOPPLER_TOKEN, undefined);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("native adapters require confirmed results, refuse approvals and stop on cancellation", async () => {
  const dir = await fixture();
  try {
    for (const agent of ["codex", "claude"] as const) {
      for (const mode of ["success", "exit", "approval", "hang"]) {
        const binary = await fakeBinary(dir, agent, mode);
        let session = "";
        const activity: NativeActivity[] = [];
        const notes: ProgressNoteInput[] = [];
        const o: NativeOptions = {
          agent,
          cwd: dir,
          prompt: "No tools",
          schema: { type: "object" },
          readOnly: true,
          signal: AbortSignal.timeout(mode === "hang" ? 200 : 5000),
          binaries: { [agent]: binary },
          onSession: async (id) => {
            session = id;
          },
          onActivity: (event) => {
            activity.push(event);
          },
          onProgress: (note) => notes.push(note),
        };
        if (mode === "success") {
          assert.deepEqual(await nativeTurn(o), { summary: "Connected" });
          assert.ok(session);
          assert.deepEqual(notes, [
            {
              done: ["Inspected the project"],
              remaining: ["Run checks"],
              blocker: null,
            },
          ]);
          assert.deepEqual(
            activity.filter((e) => e.kind !== "response"),
            [
              { kind: "turn", state: "started" },
              { kind: "command", state: "started" },
              { kind: "command", state: "finished" },
              { kind: "turn", state: "finished" },
            ],
          );
          assert.doesNotMatch(
            JSON.stringify(activity),
            /private-|secret-|foreign/,
          );
        } else if (mode === "approval") {
          // The runner refuses what was not granted and keeps the turn's
          // result; only the kind of request is reported.
          const refused: string[][] = [];
          assert.deepEqual(
            await nativeTurn({ ...o, onRefused: (kinds) => refused.push(kinds) }),
            { summary: "Connected" },
          );
          assert.deepEqual(refused, [["command"]], agent);
        } else await assert.rejects(nativeTurn(o));
      }
    }
    // The child environment is intentionally a small allowlist, not a copy of
    // the service's environment or its Worker credential.
    assert.equal(nativeEnv().RUNNER_TOKEN, undefined);
    assert.equal(nativeEnv().DOPPLER_TOKEN, undefined);
    assert.equal(nativeEnv().OPENAI_API_KEY, undefined);
    assert.equal(nativeEnv().UV_CACHE_DIR, path.join(tmpdir(), "projects-uv-cache"), "uv can cache inside a change sandbox");
    assert.equal(
      JSON.stringify(outputSchema(childResultSchema)).includes(
        '"format":"uri"',
      ),
      false,
    );
    assert.equal(
      childResultSchema.safeParse({
        ...result,
        links: ["https://evil.example/result"],
      }).success,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex archives only verified threads and restores one before resuming", async () => {
  const dir = await fixture();
  try {
    const requests = async (mode: string, sessionId?: string) => {
      const binary = await fakeBinary(dir, "codex", mode);
      const log = path.join(dir, `${mode}-${sessionId ?? "new"}.log`);
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("const m=JSON.parse(line);", `const m=JSON.parse(line);if(m.id!==undefined&&m.method)appendFileSync(${JSON.stringify(log)},m.method+'\\n');`).replace("import readline", "import {appendFileSync} from 'node:fs';\nimport readline"));
      const turn = nativeTurn({agent: "codex", cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly: true, sessionId, signal: AbortSignal.timeout(5000), binaries: {codex: binary}, onSession: async () => {}});
      if (mode === "success" || mode === "approval") assert.deepEqual(await turn, {summary: "Connected"});
      else await assert.rejects(turn);
      return (await readFile(log, "utf8")).trim().split("\n");
    };
    assert.deepEqual(await requests("success"), ["initialize", "thread/start", "turn/start", "thread/archive"]);
    // Codex rejects unarchiving a thread that was never archived; resume proceeds.
    assert.deepEqual(await requests("success", "test-session"), ["initialize", "thread/unarchive", "thread/resume", "turn/start", "thread/archive"]);
    assert.deepEqual(await requests("failed", "test-session"), ["initialize", "thread/unarchive", "thread/resume", "turn/start"]);
    // A turn that reported after a refused request is verified too.
    assert.deepEqual(await requests("approval", "test-session"), ["initialize", "thread/unarchive", "thread/resume", "turn/start", "thread/archive"]);
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

test("feedback during a child is reviewed by the same master before completion", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    reports: Progress[] = [];
  let messages = [...o.run.messages],
    masterCount = 0;
  const feedback: RunMessage = {
    id: randomUUID(),
    role: "user",
    text: "Also explain the rollback",
    at: Date.now(),
    delivery: "queued",
  };
  o.messages = async () => structuredClone(messages);
  o.report = async (p) => {
    reports.push(structuredClone(p));
  };
  o.turn = async (opts) => {
    await opts.onSession("master-session");
    if (opts.agent === "claude") {
      messages.push(feedback);
      return result;
    }
    if (++masterCount === 1) return dispatch();
    assert.match(opts.prompt, /Also explain the rollback/);
    assert.equal(opts.sessionId, "master-session");
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(masterCount, 2);
    assert.equal(reports.at(-1)?.state, "completed");
    assert.ok(reports.at(-1)?.reviewedMessageIds?.includes(feedback.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback arriving during a master decision prevents that obsolete dispatch", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let messages = [...o.run.messages],
    calls = 0,
    prepared = false;
  o.messages = async () => structuredClone(messages);
  o.prepare = async () => {
    prepared = true;
    throw Error("obsolete action must not run");
  };
  o.turn = async (opts) => {
    if (++calls === 1) {
      messages.push({
        id: randomUUID(),
        role: "user",
        text: "Just give me the explanation",
        at: Date.now(),
        delivery: "queued",
      });
      return dispatch();
    }
    assert.match(opts.prompt, /NOT been executed/);
    assert.match(opts.prompt, /Just give me the explanation/);
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(calls, 2);
    assert.equal(prepared, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("activity is bounded, published during native work, and ordered with the final receipt", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    reports: Progress[] = [];
  let activityDelivered!: () => void;
  let activityFailed!: (error: Error) => void;
  const activityPublished = new Promise<void>((resolve, reject) => {
    activityDelivered = resolve;
    activityFailed = reject;
  });
  o.report = async (p) => {
    await new Promise((r) => setTimeout(r, 10));
    reports.push(structuredClone(p));
    if (p.state === "running" && p.activity?.length === 40) activityDelivered();
  };
  o.turn = async (opts) => {
    assert.match(opts.prompt, /PROJECTS_PROGRESS/);
    for (let i = 0; i < 15; i++)
      opts.onProgress?.({
        done: [`Step ${i}`],
        remaining: ["Verify"],
        blocker: null,
      });
    for (let i = 0; i < 65; i++)
      opts.onActivity?.({ kind: "tool", state: "started" });
    // Wait for delivery, not a fixed margin after the runner's flush interval:
    // a busy CI host can finish the fsync/upload after that margin has elapsed.
    const timeout = setTimeout(
      () =>
        activityFailed(
          Error("Activity was not delivered during the native turn"),
        ),
      15_000,
    );
    try {
      await activityPublished;
    } finally {
      clearTimeout(timeout);
    }
    assert.ok(
      reports.some((p) => p.state === "running" && p.activity?.length === 40),
    );
    opts.onActivity?.({ kind: "tool", state: "finished" });
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(reports.at(-1)?.state, "completed");
    assert.equal(reports.at(-1)?.activity?.length, 40);
    assert.equal(reports.at(-1)?.activity?.at(-1)?.state, "finished");
    assert.equal(reports.at(-1)?.activity?.at(-1)?.actor, "master");
    assert.equal(reports.at(-1)?.notes?.length, 12);
    assert.ok(
      reports.some((p) => p.state === "running" && p.notes?.length === 12),
    );
    assert.equal(reports.at(-1)?.notes?.at(-1)?.actor, "master");
    assert.ok(reports.every((p, i) => i === 0 || p.seq > reports[i - 1].seq));
    const j = JSON.parse(
      await readFile(path.join(dir, "runs", o.run.id + ".json"), "utf8"),
    );
    assert.deepEqual(j.progress, reports.at(-1));
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

test("only bounded explicit progress notes are accepted, never embedded source text", () => {
  const value = {
    done: ["Read the plan"],
    remaining: ["Verify the change"],
    yourMove: "Use Open browser / sign in in this conversation",
  };
  const text = `PROJECTS_PROGRESS ${JSON.stringify(value)}`;
  assert.deepEqual(parseProgressNote(text), value);
  // Notes from sessions started before yourMove still parse.
  const legacy = { done: [], remaining: ["Verify the change"], blocker: null };
  assert.deepEqual(parseProgressNote(`PROJECTS_PROGRESS ${JSON.stringify(legacy)}`), legacy);
  for (const invalid of [
    null,
    `Quoted output: ${text}`,
    `\`\`\`\n${text}\n\`\`\``,
    `${text}\nprivate extra text`,
    "PROJECTS_PROGRESS {broken}",
    `PROJECTS_PROGRESS ${JSON.stringify({ ...value, token: "secret" })}`,
    `PROJECTS_PROGRESS ${JSON.stringify({ ...value, done: ["x".repeat(241)] })}`,
  ])
    assert.equal(parseProgressNote(invalid), null);
});

test("a busy model's turn runs again only when it had not acted yet", async () => {
  const dir = await fixture();
  try {
    const turn = async (mode: string, sessionId?: string) =>
      nativeTurn({agent: "codex", cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly: true, sessionId, retryDelayMs: 5, signal: AbortSignal.timeout(5000), binaries: {codex: await fakeBinary(dir, "codex", mode)}, onSession: async () => {}});
    assert.deepEqual(await turn("busy"), {summary: "Connected"}, "nothing ran, so the same turn ran again");
    await assert.rejects(turn("busyActed"), (e: unknown) => e instanceof NativeBusyError && e.acted, "a turn that already ran a command is not repeated");
    await assert.rejects(turn("usage"), /usage limit is reached/);
    await assert.rejects(turn("refuseResume", "test-session"), /could not open the session/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
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

test("a helper that fails is inspected read-only in its own session, and the master decides without the owner", async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [], calls: NativeOptions[] = [];
  const session = randomUUID();
  o.processStopped = () => true;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.turn = async (opts) => {
    calls.push(opts);
    if (opts.agent === "codex") {
      await opts.onSession(randomUUID());
      return calls.filter((c) => c.agent === "codex").length === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change"}} : complete;
    }
    if (!opts.sessionId) {
      await opts.onSession(session);
      throw new Failure("turn_failed", "Claude's turn failed before it reported; what it finished is unconfirmed.");
    }
    assert.equal(opts.sessionId, session, "the same session is inspected");
    assert.equal(opts.readOnly, true);
    assert.match(opts.prompt, /RECOVERY INSPECTION ONLY/);
    return {...result, outcome: "blocked", summary: "Pushed the branch; its checks have not run."};
  };
  try {
    await executeRun(o);
    const last = reports.at(-1)!;
    assert.equal(last.state, "completed", "the owner never saw the failure");
    const master = calls.filter((c) => c.agent === "codex")[1];
    assert.match(master.prompt, /Claude's turn ended before it reported: Claude's turn failed/);
    assert.match(master.prompt, /inspected its session read-only/);
    assert.match(master.prompt, /Pushed the branch/);
    assert.equal(last.children[0].state, "blocked");
    assert.deepEqual(last.telemetry?.filter((e) => e.event === "execution_handed_back").map((e) => [e.reason, e.actor]), [["turn_failed", "claude"]]);
    assert.ok(!last.telemetry?.some((e) => e.event === "execution_interrupted"));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a helper whose session cannot continue is not inspected; its worktree goes on in a fresh session", async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [], calls: NativeOptions[] = [];
  o.processStopped = () => true;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.evidence = async () => ["Observed HEAD: abc", "Observed changed paths: 2"];
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") throw new Failure("context_exceeded", "This Claude session ran out of room.");
    return calls.length === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change"}} : complete;
  };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.agent), ["codex", "claude", "codex"], "no inspection turn ran");
    const child = reports.at(-1)!.children[0];
    assert.equal(child.resumable, false);
    assert.equal(child.state, "blocked");
    assert.match(child.result!.summary, /stopped before reporting: This Claude session ran out of room/);
    assert.deepEqual(child.evidence, ["Observed HEAD: abc", "Observed changed paths: 2"]);
    assert.match(calls[2].prompt, /could not be inspected, so only the observed worktree is known/);
    assert.match(calls[2].prompt, /a fresh session starts there/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a refused request keeps the helper's result and becomes evidence for the master", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined;
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") { opts.onRefused?.(["command", "connector tool", "command"]); return result; }
    return calls.length === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    assert.equal(last?.state, "completed");
    assert.ok(last!.children[0].evidence.includes("Observed refused requests, which the agent carried on without: command ×2, connector tool"));
    assert.match(calls[2].prompt, /refused requests/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a failed coordinator turn runs again, in a fresh session when its own cannot continue", async () => {
  for (const [reason, fresh] of [["turn_failed", false], ["context_exceeded", true]] as const) {
    const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
    let last: Progress | undefined;
    const first = randomUUID();
    o.report = async (p) => { last = structuredClone(p); };
    o.turn = async (opts) => {
      calls.push(opts);
      if (calls.length === 1) { await opts.onSession(first); throw new Failure(reason, "The coordinator stopped."); }
      await opts.onSession(opts.sessionId ?? randomUUID());
      return complete;
    };
    try {
      await executeRun(o);
      assert.equal(last?.state, "completed", reason);
      assert.equal(calls[1].sessionId, fresh ? undefined : first, reason);
      assert.match(calls[1].prompt, /did not finish \(The coordinator stopped\.\); nothing from it was carried out/);
      assert.equal(/You are a new coordinator/.test(calls[1].prompt), fresh, reason);
      assert.equal(calls[1].prompt.includes("You are the user's Projects master"), true, "the brief is in the retried prompt");
      assert.deepEqual(last!.telemetry?.filter((e) => e.event === "execution_handed_back").map((e) => [e.actor, e.reason]), [["master", reason]]);
    } finally { await rm(dir, {recursive: true, force: true}); }
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

test("native turns report their tokens as each app counts them", async () => {
  const dir = await fixture();
  try {
    for (const [agent, sessionId, expected] of [
      // Codex reports running thread totals: this turn is their growth.
      ["codex", "test-session", {fresh: 2000, cached: 4000, output: 200, context: 4000}],
      // Claude's result counts this turn; its per-model totals span the
      // session and are not used. Context is the last request's.
      ["claude", undefined, {fresh: 1215, cached: 1000, output: 95, context: 1205}],
    ] as const) {
      const reports: unknown[] = [];
      await nativeTurn({agent, cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: true, sessionId, signal: AbortSignal.timeout(5000), binaries: {[agent]: await fakeBinary(dir, agent, "success")}, onSession: async () => {}, onUsage: (usage) => reports.push(usage)});
      assert.deepEqual(reports.at(-1), expected, agent);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a conversation totals its coordinator's and each helper's tokens, and telemetry keeps the counts", async () => {
  const dir = await fixture(), o = engineOptions(dir);
  let last: Progress | undefined, masters = 0;
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") {
      opts.onUsage?.({fresh: 100, cached: 900, output: 10, context: 500});
      opts.onUsage?.({fresh: 200, cached: 1800, output: 20, context: 900});
      return result;
    }
    opts.onUsage?.({fresh: 50, cached: 0, output: 5, context: 50});
    return ++masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    assert.deepEqual(last!.masterUsage, {fresh: 100, cached: 0, output: 10, turns: 2, context: 50});
    assert.deepEqual(last!.children[0].usage, {fresh: 200, cached: 1800, output: 20, turns: 1, context: 900});
    const finished = last!.telemetry!.filter((e) => e.event === "native_finished");
    assert.deepEqual(finished.map((e) => [e.actor, e.freshTokens, e.cachedTokens, e.outputTokens]), [["master", 50, 0, 5], ["claude", 200, 1800, 20], ["master", 50, 0, 5]]);
    // A follow-up's turns add to the same totals.
    await executeRun({...o, run: {...o.run, generation: 2, progress: last!}});
    assert.deepEqual(last!.masterUsage, {fresh: 150, cached: 0, output: 15, turns: 3, context: 50});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 20000) {
  for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 50))) {
    if (await check()) return;
    if (Date.now() > until) throw Error("Timed out waiting");
  }
}

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

test("an update restarts the runner at once, and the new runner adopts the conversation still executing", {timeout: 90000}, async () => {
  const dir = await fixture();
  const root = path.join(dir, "root"), stateDir = path.join(dir, "state");
  await mkdir(root, {recursive: true});
  const token = "fixture-runner-token-".padEnd(48, "x"), tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, token, {mode: 0o600});
  const run = makeRun();
  // Its turn already finished here: the executor only delivers the receipt.
  await savePrivate(path.join(stateDir, "runs", `${run.id}.json`), {generation: 1, phase: "finished", pid: null, progress: {...progress(), state: "completed", summary: "Done"}});
  const hold = deferred(), held = deferred();
  const claims: string[][] = [], reports: Progress[] = [], auth = new Set<string>();
  let claimed = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}");
    auth.add(req.headers.authorization ?? "");
    const reply = (value: unknown) => { res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(value)); };
    if (req.url === "/api/runner/claim") {
      claims.push(input.activeRunIds ?? []);
      if (!claimed) { claimed = true; return reply({run, activity: []}); }
      return reply({});
    }
    if (req.url === "/api/runner/heartbeat") { held.resolve(); await hold.promise; return reply({cancel: false, messages: run.messages}); }
    if (req.url === "/api/runner/report") { reports.push(input.progress); return reply({}); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(dir, "machine.json");
  await writeFile(config, JSON.stringify({host: "studio", root, home: dir, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile, stateDir, worktreeRoot: path.join(dir, "worktrees"), masterCwd: root, agents: ["claude"]}));
  const start = () => spawn(process.execPath, ["--import", "tsx", "runner/main.ts", config], {stdio: "ignore"});
  const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const file = path.join(stateDir, "executors", `${run.id}.json`);
  const running: ChildProcess[] = [];
  try {
    const first = start();
    running.push(first);
    await held.promise;
    const executor: number = JSON.parse(await readFile(file, "utf8")).pid;
    assert.notEqual(executor, first.pid, "the conversation runs in its own process");
    const firstExit = exited(first);
    first.kill("SIGUSR2");
    assert.equal(await firstExit, 0, "the runner exits at once for the update");
    assert.doesNotThrow(() => process.kill(executor, 0), "its executor keeps running");
    const before = claims.length;
    const second = start();
    running.push(second);
    await waitFor(() => claims.slice(before).some((active) => active.includes(run.id)));
    assert.equal(JSON.parse(await readFile(file, "utf8")).pid, executor, "no second executor started");
    hold.resolve();
    await waitFor(async () => !(await stat(file).catch(() => null)));
    assert.equal(reports.at(-1)?.state, "completed", "the adopted executor delivered its receipt");
    assert.deepEqual([...auth], [`Bearer ${token}`], "the executor got the runner token through its pipe");
    const seen = claims.length;
    await waitFor(() => claims.length > seen + 1 && !claims.at(-1)!.includes(run.id), 15000);
    const secondExit = exited(second);
    second.kill("SIGTERM");
    assert.equal(await secondExit, 0);
  } finally {
    hold.resolve();
    for (const child of running) child.kill("SIGTERM");
    server.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test("a worktree's session continues only for a same-app follow-up while it is small; reviews and large sessions start fresh", () => {
  const usage = (context: number) => ({fresh: 1, cached: 1, output: 1, turns: 1, context});
  const made: Child = {id: randomUUID(), projectId: "acme/test", agent: "claude", mode: "change", cwd: "/w", branch: "projects/a", sessionId: "s1", state: "completed", result, evidence: [], usage: usage(80_000)};
  const followUp = {...dispatch(made.id).task!, mode: "change" as const};
  assert.equal(continuesSession(made, followUp, [made]), true);
  assert.equal(continuesSession(made, {...followUp, freshSession: true}, [made]), false, "an explicit context reset keeps the workspace but drops its transcript");
  assert.equal(continuesSession(made, {...followUp, mode: "read"}, [made]), false, "a review of a change is independent");
  assert.equal(continuesSession(made, {...followUp, agent: "codex"}, [made]), false);
  assert.equal(continuesSession({...made, resumable: false}, followUp, [made]), false);
  // The session's latest turn decides, even when a later follow-up made it.
  const later: Child = {...made, id: randomUUID(), usage: usage(SESSION_CONTEXT_LIMIT)};
  assert.equal(continuesSession(made, followUp, [made, later]), false);
  assert.equal(continuesSession({...made, sessionId: null}, followUp, [made]), false);
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

test("a resumed Claude session's stale zero-turn result is neither the turn's result nor its tokens", async () => {
  const dir = await fixture();
  try {
    const reports: unknown[] = [];
    let steerable = false;
    const value = await nativeTurn({agent: "claude", cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: true, sessionId: "test-session", signal: AbortSignal.timeout(5000), binaries: {claude: await fakeBinary(dir, "claude", "stale")}, onSession: async () => {}, onUsage: (usage) => reports.push(usage), onSteer: () => { steerable = true; }});
    assert.deepEqual(value, {summary: "Connected"}, "the prompt's own turn decides the result");
    assert.ok(steerable);
    assert.ok(reports.every((usage) => (usage as {cached: number}).cached <= 1000), "the session's earlier turns are never counted");
    assert.deepEqual(reports.at(-1), {fresh: 1215, cached: 1000, output: 95, context: 1205});
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

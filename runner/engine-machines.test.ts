import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Failure, type NativeOptions } from "./native";
import { executeRun } from "./engine";
import { git, UnsavedWorkspace } from "./workspaces";
import type { Progress, MasterDecision, Child } from "../src/run-model";
import { result, makeRun, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

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

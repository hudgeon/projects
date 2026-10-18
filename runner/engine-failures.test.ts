import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { nativeTurn, Failure, type NativeOptions } from "./native";
import { executeRun, HANDBACK_LIMIT } from "./engine";
import { git, prepareWorkspace } from "./workspaces";
import type { Progress } from "../src/run-model";
import { result, fixture, complete, dispatch, engineOptions } from "./run-fixtures";
import { fakeBinary } from "./native-fixtures";

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

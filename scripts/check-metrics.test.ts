import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JEV_MODEL, type Selector } from "../runner/context";
import { followUp, formatChecks, parseCheck, replayChecks, scoreChecks, storedChecks, type Check } from "./check-metrics";

const repeat = (id: string, judged: Record<string, number>, extra: Partial<Check> = {}): Check => ({
  ...parseCheck({ kind: "repeat", at: 1_000, runId: "run", inputs: { brief: "Check the fix is live", reports: Object.keys(judged).map((report) => ({ id: report, state: "completed", summary: `Report ${report}`, checks: [] })) }, judged, parts: Object.fromEntries(Object.entries(judged).map(([report, covers]) => [report, { covers, beyond: 0.3 }])), inputTokens: 300, durationMs: 400 }, id, "history"),
  ...extra,
});
const progress = (id: string, judged: Record<string, number>, extra: Partial<Check> = {}): Check => ({
  ...parseCheck({ kind: "progress", at: 2_000, runId: "run", inputs: { notes: [{ at: new Date(1_500).toISOString(), done: ["Read the plan"], remaining: ["Wait for CI"], yourMove: null }] }, judged, inputTokens: 200, durationMs: 300 }, id, "history"),
  ...extra,
});

test("thresholds act on every judged check, and precision and recall count the labelled ones; a dispatch repeats when any report it was judged against did", () => {
  const checks = [
    repeat("a", { r1: 0.9, r2: 0.2 }),
    repeat("b", { r3: 0.6 }),
    repeat("c", { r4: 0.95 }),
    repeat("d", { r5: 0.1, r6: 0.4 }),
    progress("p1", { progressing: 0.8, repeating: 0.1, waiting: 0.7, blocked: 0.05 }),
    progress("p2", { progressing: 0.2, repeating: 0.9, waiting: 0.1, blocked: 0.05 }),
    { ...progress("failed", {}), judged: undefined, reason: "service_failed", inputTokens: undefined, durationMs: undefined },
  ];
  const report = scoreChecks(checks, {
    a: { r1: 1, r2: 0 },
    b: { r3: 0 },
    c: { r4: 1 },
    d: { r5: 0 },
    p1: { progressing: 1, repeating: 0, waiting: 1, blocked: 0 },
    p2: { progressing: 0, repeating: 1 },
  });
  const reports = report.questions["repeat, each report"];
  assert.deepEqual([reports.judged, reports.labelled, reports.held], [6, 5, 2], "r6 is unlabelled");
  const half = reports.thresholds.find((t) => t.threshold === 0.5)!;
  assert.deepEqual([half.flagged, half.tp, half.fp, half.fn, half.precision, half.recall], [3, 2, 1, 0, 2 / 3, 1]);
  assert.equal(reports.thresholds.find((t) => t.threshold === 0.9)!.precision, 1);
  assert.equal(reports.auc, 1, "every report that held outranks every one that did not");
  const dispatches = report.questions["repeat, each dispatch (its highest report)"];
  assert.deepEqual([dispatches.judged, dispatches.labelled, dispatches.held], [4, 3, 2], "d keeps an unlabelled report, so its dispatch is unknown");
  const full = report.questions["repeat, fully covered (covers and not beyond; unlabelled)"];
  assert.deepEqual([full.judged, full.labelled, full.thresholds.find((t) => t.threshold === 0.6)!.flagged], [6, 0, 3], "min(covers, 1 - beyond): 0.9, 0.6 and 0.95 clear 0.6 against beyond 0.3");
  assert.deepEqual([report.questions.repeating.held, report.questions.waiting.labelled, report.questions.blocked.labelled], [1, 1, 1]);
  assert.deepEqual(report.labelled, { repeat: 4, progress: 2 });
  assert.deepEqual(report.notJudged, { service_failed: 1 });
  assert.equal(report.conversations, 1);
  assert.equal(report.jev.inputTokens.total, 4 * 300 + 2 * 200);
  assert.ok(Math.abs(report.jev.costUsd - 1_600 * 0.000000042) < 1e-12);
  assert.equal(reports.spread, null, "receipts as recorded have no replay to compare");
  const text = formatChecks(report, "Run checks");
  assert.match(text, /0\.50 \| 3\/6 \(50%\) \| 67% \(2\/3\) \| 100% \(2\/2\)/);
  assert.doesNotMatch(text, /Check the fix|Read the plan|Report r1/, "reports carry no brief, report or note text");
});

test("stored checks prefer the labelled copy, skip unreadable receipts and run oldest first", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "check-metrics-"));
  try {
    const stateDir = path.join(home, "runner"), evaluation = path.join(home, "runner", "jev-evaluation");
    await mkdir(path.join(stateDir, "run-checks"), { recursive: true });
    await mkdir(path.join(evaluation, "checks"), { recursive: true });
    const receipt = (at: number, judged: Record<string, number>) => JSON.stringify({ kind: "progress", at, runId: "run", inputs: { notes: [] }, judged });
    await writeFile(path.join(stateDir, "run-checks", "b.json"), receipt(2, { blocked: 0.1 }));
    await writeFile(path.join(stateDir, "run-checks", "a.json"), receipt(3, { blocked: 0.2 }));
    await writeFile(path.join(stateDir, "run-checks", "broken.json"), "{");
    await writeFile(path.join(evaluation, "checks", "a.json"), receipt(3, { blocked: 0.9 }));
    const checks = await storedChecks(stateDir, evaluation);
    assert.deepEqual(checks.map((c) => [c.id, c.source, c.judged!.blocked]), [["b", "history", 0.1], ["a", "gold", 0.9]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a replay asks the current questions as a check replay and keeps the recorded ratings beside its own", async () => {
  const sent: { body: { questions: Record<string, unknown> }; metadata: { process: string; trigger: string } }[] = [];
  const selector: Selector = {
    mode: "select",
    key: async () => "fixture-key",
    gateway: { accountId: "a".repeat(32), gatewayId: "projects" },
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      sent.push({ body, metadata: JSON.parse((init!.headers as Record<string, string>)["cf-aig-metadata"]) });
      return Response.json({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.45 }])), usage: { input_tokens: 90, output_tokens: 0 } });
    },
  };
  const results = await replayChecks([repeat("a", { r1: 0.55, r2: 0.2 }), progress("p", { progressing: 0.5, repeating: 0.5, waiting: 0.5, blocked: 0.5 })], selector);
  assert.deepEqual(sent.map((s) => Object.keys(s.body.questions).length), [4, 4], "two questions per report");
  assert.deepEqual(sent.map((s) => [s.metadata.process, s.metadata.trigger]), [["run-checks", "check-replay"], ["run-checks", "check-replay"]]);
  assert.deepEqual(results[0].recorded, { r1: 0.55, r2: 0.2 });
  assert.deepEqual(results[0].judged, { r1: 0.45, r2: 0.45 });
  assert.equal(results[0].inputTokens, 90);
  const reports = scoreChecks(results, {}).questions["repeat, each report"];
  assert.equal(reports.spread!.compared, 2);
  assert.ok(Math.abs(reports.spread!.max - 0.25) < 1e-9);
  assert.deepEqual(reports.thresholds.filter((t) => t.flips).map((t) => [t.threshold, t.flips]), [[0.3, 1], [0.4, 1], [0.5, 1]]);
});

test("the journal shows what the named helper did next; older receipts find it from the dispatch's start or the note's time", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "check-follow-"));
  try {
    await mkdir(path.join(stateDir, "runs"));
    const note = (at: number, childId: string, done: string[]) => ({ id: `n${at}`, at, actor: "claude", childId, done, remaining: [], yourMove: null });
    await writeFile(
      path.join(stateDir, "runs", "run.json"),
      JSON.stringify({
        progress: {
          title: "Refresh fix",
          state: "completed",
          children: [{ id: "h1", state: "completed", result: { summary: "Confirmed what h0 reported", checks: ["Same commit live"] } }],
          notes: [note(1_500, "h1", ["Read the plan"]), note(1_600, "other", ["Elsewhere"]), note(2_500, "h1", ["Checked CI"])],
          telemetry: [{ id: "t", at: 1_050, event: "native_started", actor: "claude", childId: "h1" }],
        },
      }),
    );
    const named = await followUp(stateDir, repeat("a", { r1: 0.9 }, { child: "h1" }));
    assert.equal(named!.title, "Refresh fix");
    assert.deepEqual(named!.helper, { id: "h1", state: "completed", summary: "Confirmed what h0 reported", checks: ["Same commit live"] });
    assert.equal((await followUp(stateDir, repeat("a", { r1: 0.9 })))!.helper!.id, "h1", "from the helper started after the check");
    const older = await followUp(stateDir, progress("p", { blocked: 0.1 }));
    assert.equal(older!.helper!.id, "h1", "from the note the check judged");
    assert.deepEqual(older!.later.map((n) => n.done), [["Checked CI"]], "only that helper's later notes");
    assert.equal(await followUp(stateDir, repeat("x", { r1: 0.1 }, { runId: "gone" })), null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

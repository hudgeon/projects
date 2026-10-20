import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { changesStatus, compareChange, recordForm } from "./upkeep-changes";
import { standingReview, upkeepEvidence, upkeepInstructions } from "./upkeep-instructions";
import { cacheIssues } from "../collector/work";
import { emptyCounts, type FrictionApp, type FrictionCounts } from "../src/friction-model";
import type { UpkeepChange } from "../src/upkeep-model";

// Monday 9 November 2026, 06:00 UTC: the last 7 days are 3 to 9 November.
const now = Date.UTC(2026, 10, 9, 6);
const day = (date: string, sessions: number, over: Partial<FrictionCounts>, app: FrictionApp = "Claude") => ({
  date,
  app,
  sessions,
  counts: { ...emptyCounts(), ...over },
});
const machine = (host: string, days: ReturnType<typeof day>[], state: "ok" | "unavailable" = "ok") => ({
  host,
  observedAt: now - 60_000,
  friction: { observedAt: now - 60_000, versions: {}, days, state, message: "" },
});
// The change landed on 2 November, measured over the 7 days to that day.
const change = (over: Partial<UpkeepChange> = {}): UpkeepChange => ({
  date: "2026-11-02",
  change: "Run the formatter before committing ([#140](https://github.com/acme/projects/pull/140))",
  measure: { category: "commandFailed", app: "Claude", machine: null },
  before: { count: 14, sessions: 9, days: 7, to: "2026-11-02" },
  after: null,
  guard: "runner/instructions.test.ts",
  state: "watching",
  ...over,
});
const after = (count: number, sessions: number, host = "studio") => [
  machine(host, [day("2026-11-04", sessions - 1, { commandFailed: count }), day("2026-11-09", 1, {}), day("2026-11-02", 8, { commandFailed: 30 })]),
];

test("a watching change moved when its count per session fell by a quarter and by three below what the before rate predicts", () => {
  const moved = compareChange(change(), after(4, 11), now);
  assert.equal(moved.verdict, "moved");
  assert.deepEqual(moved.after, { count: 4, sessions: 11, days: 7, to: "2026-11-09" });
  assert.equal(
    moved.text,
    'moved. Before 14 in 9 sessions, 7 days to 2026-11-02 (1.56 a session); after 4 in 11 sessions, 7 days to 2026-11-09 (0.36 a session), counted on studio: 76% lower a session, 13.1 fewer than the before rate predicts for 11 sessions. Set its After to "4 in 11 sessions, 7 days to 2026-11-09" and its State to kept.',
  );
  // The day the change landed, and the days before it, are outside the window.
  // Exactly a quarter lower and three fewer moves it; a session more of friction does not.
  const edge = change({ before: { count: 12, sessions: 4, days: 7, to: "2026-11-02" } });
  assert.equal(compareChange(edge, after(9, 4), now).verdict, "moved");
  assert.equal(compareChange(edge, after(10, 4), now).verdict, "did not move");
  // Lower by a quarter, but under three fewer: noise, not a move.
  const small = change({ before: { count: 4, sessions: 4, days: 7, to: "2026-11-02" } });
  assert.match(compareChange(small, after(2, 4), now).text, /^did not move\. .*50% lower a session, 2 fewer than the before rate predicts for 4 sessions\. Set its After to "2 in 4 sessions, 7 days to 2026-11-09"; revise it once or revert it\.$/);
  const rose = compareChange(change(), after(40, 11), now);
  assert.equal(rose.verdict, "rose");
  assert.match(rose.text, /^did not move, it rose\. .*: 133% higher a session, 22\.9 more than the before rate predicts for 11 sessions\./);
});

test("a change is not yet measurable while its window holds the day it landed, lacks sessions or lacks a machine's totals, never not moved", () => {
  const early = compareChange(change({ date: "2026-11-04" }), after(0, 11), now);
  assert.equal(early.verdict, "not yet measurable");
  assert.equal(
    early.text,
    "not yet measurable: the 7 days to 2026-11-09 still hold 2026-11-04, the day it landed; the first comparable window is the 7 days to 2026-11-11. It stays watching, its After not yet.",
  );
  // Too few sessions for the before rate to predict three: 14 in 9 needs 2, and never fewer than 3.
  assert.match(compareChange(change(), after(0, 2), now).text, /^not yet measurable: the 7 days to 2026-11-09 had 2 Claude sessions on studio, and the comparison needs at least 3\./);
  const rare = change({ before: { count: 3, sessions: 30, days: 7, to: "2026-11-02" } });
  assert.match(compareChange(rare, after(0, 20), now).text, /had 20 Claude sessions on studio, and the comparison needs at least 30\./);
  // Another app's sessions do not count.
  const codex = [machine("studio", [day("2026-11-05", 20, { commandFailed: 1 }, "Codex")])];
  assert.equal(compareChange(change(), codex, now).verdict, "not yet measurable");
  // A named machine without totals; all machines, counting the ones with totals and naming the rest.
  const named = change({ measure: { category: "commandFailed", app: "Claude", machine: "laptop" } });
  const laptop = machine("laptop", [], "unavailable");
  assert.match(compareChange(named, [...after(4, 11), laptop], now).text, /^not yet measurable: laptop has no friction totals in this cycle's snapshots\./);
  assert.match(compareChange(named, after(4, 11), now).text, /laptop has no friction totals/);
  assert.match(compareChange(change(), [laptop], now).text, /^not yet measurable: no machine has friction totals in this cycle's snapshots\./);
  assert.match(compareChange(change(), [...after(4, 11), laptop], now).text, /counted on studio; laptop had no totals and is not counted: 76% lower/);
  // Two machines add up.
  const both = [...after(2, 6), ...after(2, 5, "laptop")];
  assert.match(compareChange(change(), both, now).text, /after 4 in 11 sessions, 7 days to 2026-11-09 \(0\.36 a session\), counted on studio, laptop: /);
  // A window as long as the before measure's: fourteen days take in 2 November too.
  const fortnight = change({ date: "2026-10-25", before: { count: 28, sessions: 18, days: 14, to: "2026-10-25" } });
  assert.match(compareChange(fortnight, after(4, 11), now).text, /after 34 in 19 sessions, 14 days to 2026-11-09/);
});

test("a guard measure is checked by a read child, not counted", () => {
  const guarded = compareChange(change({ measure: "guard", before: "none" }), after(4, 11), now);
  assert.equal(guarded.verdict, "by its guard");
  assert.match(guarded.text, /^measured by its guard: a read child confirms the guard is in place and passing on the default branch\. Then set its After to "passes" and its State to kept, or its After to "fails" and revise it once or revert it\.$/);
});

test("the closing-the-loop status compares what is waiting or watching, names the kept guards, and says when the record cannot be read", () => {
  const rows = [
    change(),
    change({ state: "waiting", change: "Shorter notes ([#12](https://github.com/acme/config/pull/12))", measure: { category: "denied", app: "Claude", machine: "laptop" }, guard: "the configuration repository's check" }),
    change({ state: "kept", date: "2026-10-19", guard: "runner/native.test.ts", measure: "guard", before: "none", after: "passes" }),
    change({ state: "reverted", guard: "hooks check" }),
  ];
  const text = changesStatus(after(4, 11), { changes: rows }, now);
  const lines = text.split("\n");
  assert.equal(lines[0], "Each recorded change still waiting or watching, compared over a window of as many days as its before measure, ending today (2026-11-09) like the evidence:");
  assert.match(lines[1], /^- "Run the formatter before committing \(\[#140\]\(https:\/\/github\.com\/acme\/projects\/pull\/140\)\)" \(watching since 2026-11-02; measure failed commands, Claude, all machines; guard runner\/instructions\.test\.ts\): moved\. /);
  assert.equal(lines[2], '- "Shorter notes ([#12](https://github.com/acme/config/pull/12))" (waiting since 2026-11-02; measure denied tool uses, Claude, laptop; guard the configuration repository\'s check): a read child checks whether its pull request has merged; once it has, set its State to watching and its Date to the day it merged.');
  assert.equal(lines[3], "Kept changes, whose guards stay in place: runner/native.test.ts (2026-10-19, guard).");
  assert.ok(text.endsWith(recordForm(now)));
  assert.doesNotMatch(text, /hooks check/, "a settled change is history, not compared");
  assert.match(changesStatus([], { changes: [] }, now), /^No change is recorded yet\.\n/);
  assert.match(changesStatus([], { changes: [rows[3]] }, now), /^No recorded change is waiting or watching\.\n/);
  assert.match(changesStatus([], { changes: null }, now), /^The record of changes under "## Upkeep" in the standing issue is not in the fixed form below, so no change is compared this cycle: the change child that records the cycle restores the form first, keeping every row's facts\./);
  assert.match(changesStatus([], {}, now), /^The standing issue's record of changes is not in this machine's work item cache yet, so no change is compared this cycle\./);
  assert.match(changesStatus([], null, now), /^The record of changes could not be read from this machine's work item cache, so no change is compared this cycle\./);
  const form = recordForm(now);
  for (const phrase of [
    '| Date | Change | Measure | Before | After | Guard | State |\n| --- | --- | --- | --- | --- | --- | --- |',
    "Date: YYYY-MM-DD, the day the change landed, or while it is waiting the day it was recorded.",
    'Measure: "<friction category>, <Claude or Codex>, <machine or all machines>"',
    'or "guard" when the guard itself is the measure.',
    'a before measure from the evidence\'s last 7 days reads "7 days to 2026-11-09"',
    'a guard measure\'s Before is "none" and its After "passes" or "fails".',
    "State: waiting, watching, kept, revised or reverted.",
  ])
    assert.ok(form.includes(phrase), phrase);
});

test("the evidence adds the machines' totals together, so an all-machines before measure is read off one line", () => {
  const two = [...after(2, 6), ...after(3, 5, "laptop"), { host: "older", observedAt: now, projects: [] }];
  assert.equal(
    upkeepEvidence(two, now).split("\n")[3],
    "- all machines (studio, laptop): Last 7 days: Claude: 11 sessions, 0 prompts, 0 tool calls: 5 failed commands. The 7 days before: Claude: 16 sessions, 0 prompts, 0 tool calls: 60 failed commands.",
  );
  assert.equal(upkeepEvidence(after(2, 6), now).split("\n").length, 1, "one machine's totals are already its own line");
});

test("the brief carries the standing issue's record, read from this machine's work item cache", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "upkeep-changes-"));
  const issue = { number: 1280, title: "Agent upkeep", body: "", url: "https://github.com/acme/work/issues/1280", open: true, kind: null, initiative: null, customers: [], repos: [], updatedAt: 1, upkeep: true };
  try {
    await cacheIssues(home, [{ ...issue, changes: [change()] }, { ...issue, number: 7, changes: null }]);
    assert.deepEqual((await standingReview(home, 1280))?.changes, [change()]);
    assert.equal((await standingReview(home, 7))?.changes, null);
    assert.equal((await standingReview(home, 99))?.changes, undefined, "an issue the cache does not hold");
    assert.deepEqual((await standingReview(home, null))?.changes, [], "no standing issue, no record");
    const reviewed = await standingReview(home, 1280);
    const text = upkeepInstructions({ activity: after(4, 11), host: "studio", stateDir: "/state", projects: [], run: { workIssue: 1280 }, reviewed, now });
    assert.ok(text.includes(`\n\nClosing the loop. ${changesStatus(after(4, 11), reviewed, now)}\n\n`));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

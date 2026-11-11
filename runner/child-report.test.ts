import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Child } from "../src/run-model";
import { childSchema } from "../src/run-model";
import { activityNews, activitySeen } from "./activity-brief";
import { childContext, childLine, childReport, REPORT_CHARS } from "./child-report";

const child = (extra: Partial<Child> = {}): Child => ({
  id: randomUUID(), projectId: "acme/test", agent: "codex", mode: "change", cwd: "/work/tree", branch: "projects/a", sessionId: randomUUID(), state: "completed",
  result: { outcome: "completed", summary: "Fixed the importer. The pipe delimiter is kept.", checks: ["Tests passed at abc123"], links: ["https://github.com/acme/test/pull/3"] },
  evidence: ["Observed HEAD: abcdef0123456789", "Observed branch: projects/a"],
  usage: { fresh: 1, cached: 2, output: 3, turns: 1, context: 4 },
  ...extra,
});

test("a helper's report keeps every word within its bound, and the largest one a helper may write stays near 2,000 tokens", () => {
  const short = child();
  const { sessionId: _, usage: __, ...rest } = short;
  assert.deepEqual(childReport(short), rest, "whole, without the session and token counts the coordinator has no use for");
  // The limits a helper's result and the runner's observations may reach.
  const largest = childSchema.parse(child({
    result: { outcome: "blocked", summary: `FIRST ${"s".repeat(5_988)} LAST`, checks: Array.from({ length: 12 }, (_, i) => `CHECK-${i} ${"c".repeat(590)}`), links: Array.from({ length: 12 }, (_, i) => `https://github.com/acme/test/pull/${i}`) },
    evidence: Array.from({ length: 8 }, (_, i) => `Observed ${i}: ${"e".repeat(980)}`),
  }));
  const report = childReport(largest, "/state/runs/journal.json");
  assert.ok(JSON.stringify(largest).length > 20_000);
  assert.ok(JSON.stringify(report).length <= REPORT_CHARS + 600, `${JSON.stringify(report).length} characters`);
  assert.match(report.result!.summary, /^FIRST s+…$/);
  assert.equal(report.result!.checks.length, 12);
  assert.ok(report.result!.checks.every((check, i) => check.startsWith(`CHECK-${i} `)));
  assert.deepEqual(report.result!.links, largest.result!.links, "pointers are never cut");
  assert.equal(report.evidence.length, 8);
  assert.equal(report.shortened, "Shortened here; the whole report is in /state/runs/journal.json");
  // A report as long as nine in ten are, long checks and all, is whole.
  const usual = child({ result: { ...short.result!, summary: "s".repeat(1_450), checks: Array.from({ length: 12 }, () => "c".repeat(340)) } });
  assert.deepEqual([childReport(usual).result, childReport(usual).shortened], [usual.result, undefined]);
  // Past the bound, long checks give way before a usual summary does.
  const checked = childReport(child({ result: { ...largest.result!, summary: short.result!.summary }, evidence: largest.evidence }));
  assert.equal(checked.result!.summary, short.result!.summary);
  assert.ok(checked.shortened && checked.result!.checks.every((check) => check.length <= 250));
  assert.deepEqual(childReport(child({ result: null, state: "unknown" })).state, "unknown");
});

test("every helper is one line: who, where, its state, the pull request or commit observed and its report's first sentence", () => {
  const first = child();
  assert.equal(childLine(first), `${first.id} · acme/test · codex change · completed · projects/a · HEAD abcdef012345 · Fixed the importer.`);
  const pulled = child({ host: "studio", evidence: [...first.evidence, "Observed pull request: https://github.com/acme/test/pull/3 · open · checks failing"] });
  assert.equal(childLine(pulled), `${pulled.id} · acme/test · codex change · completed · projects/a · on studio · https://github.com/acme/test/pull/3 · open · checks failing · Fixed the importer.`);
  const silent = child({ state: "unknown", result: null, evidence: ["Observed pull request: none for this branch"] });
  assert.equal(childLine(silent), `${silent.id} · acme/test · codex change · unknown · projects/a · no report`);
  assert.equal(childContext([]), "none");
  const listed = JSON.parse(childContext([first, pulled, silent]));
  assert.deepEqual(listed, { index: [first, pulled, silent].map(childLine), latest: [] });
  assert.deepEqual(JSON.parse(childContext([first, pulled, silent], 2)).latest.map((c: Child) => c.id), [pulled.id, silent.id]);
  assert.deepEqual(JSON.parse(childContext([first, pulled, silent], [first])).retained.map((c: Child) => c.id), [first.id]);
});

test("active work is news only where an entry changed; when it was observed is not a change", () => {
  const brief = (observedAt: number, state: string) => [{ host: "laptop", observedAt, projects: [
    { id: "a/one", sessions: [{ app: "Codex", title: "One", state: "running", updatedAt: observedAt - 5, cwd: "/a" }], checkouts: [], pulls: [] },
    { id: "a/two", sessions: [{ app: "Claude", title: "Two", state, updatedAt: observedAt - 9, cwd: "/b" }], checkouts: [], pulls: [] },
  ] }];
  const seen = activitySeen(brief(1_000, "running"));
  assert.deepEqual(Object.keys(seen), ["laptop/a/one", "laptop/a/two"]);
  assert.deepEqual(activityNews(brief(9_000, "running"), seen), { changed: [], gone: [] });
  const news = activityNews(brief(9_000, "waiting"), seen);
  assert.deepEqual(news.changed, [{ ...brief(9_000, "waiting")[0], projects: [brief(9_000, "waiting")[0].projects[1]] }], "the changed entry alone, with its current times");
  assert.deepEqual(activityNews([{ ...brief(9_000, "running")[0], projects: [] }], seen).gone, ["laptop/a/one", "laptop/a/two"]);
  // A brief the runner could not read into entries is news as a whole, once.
  const odd = { unexpected: "shape", observedAt: 1 };
  assert.deepEqual(activityNews(odd, seen), { changed: [odd], gone: ["laptop/a/one", "laptop/a/two"] });
  assert.deepEqual(activityNews({ ...odd, observedAt: 2 }, activitySeen(odd)), { changed: [], gone: [] });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { atCutoff, format, formatPositions, key, positions, score, usageProxy, type Result, type Unit } from "./project-metrics";

const unit = (path: string, start: number, length: number, noul: number | null, kept = false, extra: Partial<Unit> = {}): Unit => ({
  path,
  startChar: start,
  endChar: start + length,
  text: `private text of ${path}`,
  noul,
  kept,
  ...extra,
});
const result = (id: string, considered: Unit[], extra: Partial<Result> = {}): Result => ({
  id,
  reason: "selected",
  judgeMs: 400,
  inputTokens: 10_000,
  considered,
  ...extra,
});

test("the cutoff keeps the best units Jev rates at or above it within the evidence budget", () => {
  const units = [unit("a.md", 0, 3_000, 0.6), unit("b.md", 0, 2_000, 0.9), unit("c.md", 0, 1_500, 0.7), unit("d.md", 0, 500, 0.3), unit("e.md", 0, 100, null)];
  assert.deepEqual(atCutoff(units, 0.5).map((u) => u.path), ["b.md", "c.md"]);
  assert.deepEqual(atCutoff(units, 0.3).map((u) => u.path), ["b.md", "c.md", "d.md"]);
  assert.deepEqual(atCutoff(units, 0.95), []);
});

test("precision and recall count labelled units only, and report what still needs labels", () => {
  const first = [unit("plan.md", 0, 1_000, 0.9, true), unit("code.ts", 0, 1_000, 0.6, true), unit("other.md", 0, 1_000, 0.4), unit("new.md", 0, 1_000, 0.8, true)];
  const second = [unit("x.md", 0, 500, 0.2), unit("y.md", 0, 500, 0.7, true)];
  const labels = {
    one: { units: { [key(first[0])]: 2, [key(first[1])]: 1, [key(first[2])]: 2, "gone.md:0-10": 2 } },
    two: { units: { [key(second[0])]: 0, [key(second[1])]: 0 } },
  };
  const report = score(
    [result("one", first), result("two", second), result("failed", [], { reason: "service_failed", judgeMs: null, inputTokens: null })],
    labels,
  );
  const half = report.cutoffs.find((c) => c.cutoff === 0.5)!;
  assert.equal(half.turns, 2);
  assert.equal(half.kept, 4);
  assert.equal(half.labelled, 3, "the unlabelled new.md is reported, not counted");
  assert.equal(half.unlabelled, 1);
  assert.equal(half.strict, 1);
  assert.equal(half.lenient, 2);
  assert.equal(half.strictPrecision, 1 / 3);
  assert.equal(half.strictRecall, 1 / 2);
  assert.equal(half.lenientRecall, 2 / 3);
  assert.equal(half.relevantCharsPerTurn, 1_000);
  assert.deepEqual(report.notJudged, { service_failed: 1 });
  assert.equal(report.labels.unlabelledUnits, 1);
  assert.equal(report.labels.relevant, 4);
  assert.equal(report.labels.relevantInShortlist, 3, "a labelled unit the shortlist lost is a retrieval miss");
  assert.equal(report.labels.auc.lenient, 4 / 6);
  assert.equal(report.supplied.unitsPerTurn, 4 / 3);
  assert.equal(report.jev.judgeMs.median, 400);
  assert.equal(report.jev.inputTokens.total, 20_000);
  assert.ok(Math.abs(report.jev.costUsd - 20_000 * 0.000000042) < 1e-12);
  const text = format(report, "fixture");
  assert.match(text, /^0\.50 \| 2 \| 0 \| 33% \(1\/3\) \| 67% \(2\/3\) \| 50% \(1\/2\) \| 67% \(2\/3\)/m);
  assert.doesNotMatch(text + JSON.stringify(report), /private text/);
});

test("usage proxies compare a selection with the project files its turn read or changed", () => {
  const usage = {
    at: 1,
    files: [
      { path: "src/a.ts", read: true as const, lines: [[10, 20]] as [number, number][] },
      { path: "src/b.ts", changed: true as const },
      { path: "README.md", read: true as const },
      { path: "AGENTS.md", read: true as const },
      { path: "logo.png", read: true as const },
    ],
    outside: 2,
    more: 0,
  };
  const supplied = [
    { path: "src/a.ts", startChar: 0, endChar: 100, lines: [1, 5] as [number, number] },
    { path: "src/a.ts", startChar: 200, endChar: 400, lines: [15, 30] as [number, number] },
    { path: "src/b.ts", startChar: 0, endChar: 50, lines: [1, 2] as [number, number] },
    { path: "docs/plan.md", startChar: 0, endChar: 80 },
    { path: "https://github.com/example/project/issues/1", startChar: 0, endChar: 80 },
  ];
  const shortlist = [...supplied, { path: "README.md", startChar: 0, endChar: 10 }];
  assert.deepEqual(usageProxy(usage, supplied, shortlist), {
    supplied: 4,
    suppliedInUsedFiles: 3,
    suppliedRead: 2,
    usedFiles: 3,
    usedFilesSupplied: 2,
    usedFilesShortlisted: 3,
  });
  const report = score(
    [
      result("turn", [unit("src/a.ts", 200, 200, 0.9, true, { lines: [15, 30] }), unit("README.md", 0, 10, 0.2)], {
        usage,
        recorded: { units: shortlist, supplied: [0, 3] },
      }),
    ],
    {},
  );
  assert.equal(report.usage.replayed.precision, 1);
  assert.equal(report.usage.replayed.recall, 1 / 3);
  assert.equal(report.usage.replayed.shortlistRecall, 2 / 3);
  assert.equal(report.usage.recorded.precision, 1 / 2);
  assert.equal(report.usage.recorded.unitPrecision, 0);
});

test("ratings group by retrieval rank band, so a reversed replay shows whether the slot moved them", () => {
  const units = Array.from({ length: 20 }, (_, i) => unit("doc.md", i * 100, 100, i < 8 ? 0.8 : 0.2));
  const labels = { r: { units: Object.fromEntries(units.map((u, i) => [key(u), i % 2 ? 2 : 0])) } };
  const bands = positions([result("r", units)], labels);
  assert.deepEqual(bands.map((b) => `${b.from}-${b.to}`), ["0-7", "8-15", "16-23", "24-39"]);
  assert.equal(bands[0].onSubject.n, 4);
  assert.equal(bands[0].onSubject.mean, 0.8);
  assert.equal(bands[0].onSubject.kept, 1);
  assert.equal(bands[1].onSubject.kept, 0);
  assert.equal(bands[1].offTopic.n, 4);
  assert.equal(bands[0].auc.strict, 0.5, "same rating for both labels within the band");
  assert.equal(bands[3].onSubject.n, 0);
  assert.equal(bands[3].onSubject.mean, null);
  assert.match(formatPositions(bands, "Replay x (code, sent reversed)"), /^Replay x[^\n]*\n[^\n]*rank \| on-subject n/);
});

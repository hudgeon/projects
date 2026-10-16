import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  codexComparison,
  METRIC_WINDOW_MS,
  type CodexSample,
} from "../src/codex-metrics";

const now = Date.now();
const sample = (
  fast: boolean,
  durationMs: number,
  extra: Partial<CodexSample> = {},
): CodexSample => ({
  id: randomUUID(),
  at: now,
  event: "native_finished",
  actor: "master",
  agent: "codex",
  host: "studio",
  codexFast: fast,
  model: "model-a",
  effort: "high",
  mode: "read",
  resumed: false,
  attempts: 1,
  tokenUsageObserved: true,
  durationMs,
  freshTokens: 200,
  cachedTokens: 0,
  outputTokens: 100,
  outcome: "completed",
  ...extra,
});

test("speed comparison uses medians and only matched completed cohorts", () => {
  const rows = [
    sample(false, 1000),
    sample(false, 2000),
    sample(false, 90000),
    sample(true, 500),
    sample(true, 1000),
    sample(true, 50000),
  ];
  let result = codexComparison(rows, now);
  assert.equal(result.cohorts[0].standard.medianMs, 2000);
  assert.equal(result.cohorts[0].fast.medianMs, 1000);
  assert.equal(result.cohorts[0].fasterPercent, 50);
  assert.equal(result.cohorts[0].fast.firstOutputMs, null);
  result = codexComparison(rows.slice(1), now);
  assert.equal(
    result.cohorts[0].fasterPercent,
    null,
    "insufficient baseline is not a speed claim",
  );
  const slower = codexComparison(
    [...rows.slice(0, 3), ...[3000, 4000, 5000].map((n) => sample(true, n))],
    now,
  );
  assert.equal(
    slower.cohorts[0].fasterPercent,
    -100,
    "slower mode must not be shown as faster",
  );
});

test("workload, environment and missing observations cannot contaminate a baseline", () => {
  const differences: Partial<CodexSample>[] = [
    { model: "model-b" },
    { effort: "low" },
    { actor: "codex", agent: undefined },
    { mode: "change" },
    { resumed: true },
    { host: "laptop" },
    { freshTokens: 3000 },
    { outputTokens: 2000 },
    { cachedTokens: 500 },
  ];
  const rows = [
    sample(false, 1000),
    ...differences.map((d) => sample(true, 500, d)),
  ];
  const result = codexComparison(rows, now);
  assert.equal(result.cohorts.length, 10);
  assert.ok(result.cohorts.every((c) => c.fasterPercent === null));
  const excluded = codexComparison(
    [
      sample(true, 100, { attempts: 2 }),
      sample(true, 100, { model: undefined }),
      sample(true, 100, { tokenUsageObserved: false }),
      sample(true, 100, { outcome: "failed" }),
      sample(true, 100, { outcome: "cancelled" }),
      sample(true, 100, { codexFast: undefined }),
      sample(true, 100, { at: now - METRIC_WINDOW_MS - 1 }),
      sample(true, 100, { at: now + 1 }),
    ],
    now,
  );
  assert.equal(excluded.fast, 5);
  assert.equal(excluded.failed, 2);
  assert.equal(excluded.excluded, 3);
  assert.equal(excluded.cohorts.length, 0);
});

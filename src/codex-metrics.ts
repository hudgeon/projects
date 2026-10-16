import { z } from "zod";
import type { ExecutionEvent } from "./telemetry";

export const executionSettingsSchema = z
  .object({ codexFast: z.boolean() })
  .strict();
export type ExecutionSettings = z.infer<typeof executionSettingsSchema>;
export const METRIC_WINDOW_MS = 30 * 86400_000;
export const METRIC_LIMIT = 10_000;
export type CodexSample = ExecutionEvent & { host: string };
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const band = (n: number, thresholds: number[]) => {
  let lower = 0;
  for (const upper of thresholds) {
    if (n < upper) return `${lower}–${upper - 1}`;
    lower = upper;
  }
  return `${lower}+`;
};
// Compare only recorded, completed single-attempt turns with the same context.
// Token bands reduce workload differences; these observations are not a trial.
export function codexComparison(samples: CodexSample[], now = Date.now()) {
  const groups = new Map<
    string,
    { label: string; standard: CodexSample[]; fast: CodexSample[] }
  >();
  const counts = { standard: 0, fast: 0, failed: 0, excluded: 0 };
  const retained = samples.filter(
    (s) => s.at >= now - METRIC_WINDOW_MS && s.at <= now,
  );
  for (const s of retained) {
    if (
      s.event !== "native_finished" ||
      (s.agent ?? s.actor) !== "codex" ||
      s.codexFast === undefined
    )
      continue;
    counts[s.codexFast ? "fast" : "standard"]++;
    if (s.outcome !== "completed") {
      counts.failed++;
      continue;
    }
    if (
      !s.model ||
      !s.effort ||
      !s.mode ||
      s.resumed === undefined ||
      s.attempts !== 1 ||
      !s.durationMs ||
      !s.tokenUsageObserved ||
      s.freshTokens === undefined ||
      s.cachedTokens === undefined ||
      s.outputTokens === undefined
    ) {
      counts.excluded++;
      continue;
    }
    const input = band(s.freshTokens + s.cachedTokens, [2000, 16000, 64000]);
    const output = band(s.outputTokens, [1000, 8000]);
    const cache =
      s.cachedTokens / Math.max(1, s.freshTokens + s.cachedTokens) >= 0.5
        ? "mostly cached"
        : "mostly fresh";
    const role = s.actor === "master" ? "coordinator" : "helper";
    const label = `${s.model} · ${s.effort} · ${role} · ${s.mode} · ${s.resumed ? "continued" : "new"} · ${s.host} · input ${input}, output ${output} tokens · ${cache}`;
    const group = groups.get(label) ?? { label, standard: [], fast: [] };
    group[s.codexFast ? "fast" : "standard"].push(s);
    groups.set(label, group);
  }
  const stats = (rows: CodexSample[]) => ({
    count: rows.length,
    medianMs: median(rows.map((s) => s.durationMs!)),
    firstOutputMs: median(
      rows.flatMap((s) =>
        s.firstOutputMs === undefined ? [] : [s.firstOutputMs],
      ),
    ),
    firstOutputCount: rows.filter((s) => s.firstOutputMs !== undefined).length,
  });
  return {
    since: now - METRIC_WINDOW_MS,
    retained: retained.length,
    ...counts,
    cohorts: [...groups.values()]
      .map((g) => {
        const standard = stats(g.standard),
          fast = stats(g.fast);
        return {
          label: g.label,
          standard,
          fast,
          fasterPercent:
            standard.count >= 3 && fast.count >= 3 && standard.medianMs! > 0
              ? (100 * (standard.medianMs! - fast.medianMs!)) /
                standard.medianMs!
              : null,
        };
      })
      .sort(
        (a, b) =>
          Number(b.fasterPercent !== null) - Number(a.fasterPercent !== null) ||
          b.fast.count + b.standard.count - a.fast.count - a.standard.count ||
          a.label.localeCompare(b.label),
      ),
  };
}
export type CodexComparison = ReturnType<typeof codexComparison>;
export type ExecutionSettingsView = ExecutionSettings & {
  metrics: CodexComparison;
};

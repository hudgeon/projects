// The runner's shadow run checks (runner/run-checks.ts), replayed and scored
// against this machine's hand labels: whether a dispatch repeated work a
// finished helper had reported, and which signs held at a helper's progress
// note. Reports carry counts and probabilities only; briefs, reports and
// notes stay in the private receipts and replays.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JEV_INPUT_COST_PER_TOKEN, type Selector } from "../runner/context";
import { judgeCheck, PROGRESS_SIGNS } from "../runner/run-checks";

export const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const reportSchema = z.object({ id: z.string(), state: z.string(), summary: z.string(), checks: z.array(z.string()) });
const noteSchema = z.object({ at: z.string(), done: z.array(z.string()), remaining: z.array(z.string()), yourMove: z.string().nullable() });
const checkSchema = z.object({
  kind: z.enum(["repeat", "progress"]),
  at: z.number(),
  runId: z.string(),
  // The helper dispatched or noted; receipts before it was recorded omit it.
  child: z.string().optional(),
  inputs: z.union([z.object({ brief: z.string(), reports: z.array(reportSchema) }), z.object({ notes: z.array(noteSchema) })]),
  judged: z.record(z.string(), z.number()).optional(),
  // A repeat check's two judgments per report: the report shows part of the
  // brief done (judged), and the brief asks for something beyond it.
  parts: z.record(z.string(), z.object({ covers: z.number(), beyond: z.number() })).optional(),
  omittedReports: z.number().int().optional(),
  // A replay keeps the receipt's own probabilities beside its new ones.
  recorded: z.record(z.string(), z.number()).optional(),
  inputTokens: z.number().optional(),
  durationMs: z.number().optional(),
  reason: z.string().optional(),
});
export type Check = z.infer<typeof checkSchema> & { id: string; source: "history" | "gold" };
// By receipt id, then by what Jev judged (a report's helper id or a progress
// sign): 1 when it held, 0 when it did not.
export type CheckLabels = Record<string, Record<string, number>>;
export const checkDirs = (stateDir: string, evaluationDir: string) => ({
  history: path.join(stateDir, "run-checks"),
  gold: path.join(evaluationDir, "checks"),
});
export const parseCheck = (value: unknown, id: string, source: Check["source"]): Check => ({
  ...checkSchema.parse(value),
  id,
  source,
});
async function read(dir: string, source: Check["source"]) {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  const checks: Check[] = [];
  for (const name of names)
    try {
      checks.push(parseCheck(JSON.parse(await readFile(path.join(dir, name), "utf8")), name.slice(0, -5), source));
    } catch {}
  return checks;
}
// Labelled copies first, then the runner's receipts, each once, oldest first.
export async function storedChecks(stateDir: string, evaluationDir: string) {
  const dirs = checkDirs(stateDir, evaluationDir);
  const seen = new Set<string>();
  return [...(await read(dirs.gold, "gold")), ...(await read(dirs.history, "history"))]
    .filter((c) => !seen.has(c.id) && !!seen.add(c.id))
    .sort((a, b) => a.at - b.at);
}
// What Jev judged, in the order it was asked.
export const judgedNames = (c: Check) =>
  "reports" in c.inputs ? c.inputs.reports.map((r) => r.id) : PROGRESS_SIGNS;

// Each stored check judged again with the current questions.
export async function replayChecks(checks: Check[], selector: Selector) {
  const results: Check[] = [];
  for (const check of checks) {
    const judgment = await judgeCheck({ inputs: check.inputs, selector, signal: AbortSignal.timeout(60_000), trigger: "check-replay" });
    const replayed =
      "judged" in judgment
        ? { judged: judgment.judged, parts: judgment.parts, inputTokens: judgment.inputTokens, durationMs: judgment.durationMs, reason: undefined }
        : { judged: undefined, parts: undefined, inputTokens: undefined, durationMs: undefined, reason: judgment.reason };
    results.push({ ...check, inputs: judgment.inputs as Check["inputs"], omittedReports: judgment.omittedReports, recorded: check.judged, ...replayed });
  }
  return results;
}

// What the conversation's journal shows after a check: its title, the helper
// it named (found from the dispatch's start or the note's time for older
// receipts), that helper's later notes and its latest result.
export async function followUp(stateDir: string, check: Check) {
  const journal = await readFile(path.join(stateDir, "runs", `${check.runId}.json`), "utf8").then(JSON.parse, () => null);
  const progress = journal?.progress;
  if (!progress) return null;
  const notes: { at: number; childId: string | null; done: string[]; remaining: string[]; yourMove?: string | null }[] = progress.notes ?? [];
  const from = "notes" in check.inputs ? Date.parse(check.inputs.notes.at(-1)!.at) : check.at;
  const child =
    check.child ??
    ("notes" in check.inputs
      ? notes.find((n) => n.at === from)?.childId
      : (progress.telemetry ?? []).find((e: { event: string; childId?: string; at: number }) => e.event === "native_started" && e.childId && e.at >= check.at && e.at - check.at < 120_000)?.childId);
  const helper = (progress.children ?? []).find((c: { id: string }) => c.id === child);
  return {
    title: progress.title as string | undefined,
    state: progress.state as string,
    helper: helper ? { id: helper.id as string, state: helper.state as string, summary: helper.result?.summary as string | undefined, checks: (helper.result?.checks ?? []) as string[] } : null,
    later: notes.filter((n) => child && n.childId === child && n.at > from),
  };
}

type Item = { p: number; label?: number; was?: number };
const ratio = (n: number, d: number) => (d ? n / d : null);
const quantile = (values: number[], q: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
};
// How often Jev rates a sign that held above one that did not.
function auc(items: Item[]) {
  const positive = items.filter((i) => i.label === 1).map((i) => i.p),
    negative = items.filter((i) => i.label === 0).map((i) => i.p);
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return ratio(wins, positive.length * negative.length);
}
// A threshold acts on every judged item; precision and recall count the
// labelled ones. Flips: items a replay moved across the threshold.
function question(items: Item[]) {
  const labelled = items.filter((i) => i.label !== undefined),
    held = labelled.filter((i) => i.label === 1).length,
    compared = items.filter((i) => i.was !== undefined);
  const gaps = compared.map((i) => Math.abs(i.p - i.was!));
  return {
    judged: items.length,
    labelled: labelled.length,
    held,
    auc: auc(labelled),
    spread: gaps.length ? { compared: gaps.length, mean: gaps.reduce((n, g) => n + g, 0) / gaps.length, max: Math.max(...gaps) } : null,
    thresholds: THRESHOLDS.map((threshold) => {
      const tp = labelled.filter((i) => i.p >= threshold && i.label === 1).length,
        fp = labelled.filter((i) => i.p >= threshold && i.label === 0).length;
      return {
        threshold,
        flagged: items.filter((i) => i.p >= threshold).length,
        tp,
        fp,
        fn: held - tp,
        precision: ratio(tp, tp + fp),
        recall: ratio(tp, held),
        flips: compared.length ? compared.filter((i) => i.p >= threshold !== i.was! >= threshold).length : null,
      };
    }),
  };
}

export function scoreChecks(checks: Check[], labels: CheckLabels) {
  const judged = checks.filter((c) => c.judged);
  const questions: Record<string, Item[]> = { "repeat, each report": [], "repeat, each dispatch (its highest report)": [], "repeat, fully covered (covers and not beyond; unlabelled)": [], ...Object.fromEntries(PROGRESS_SIGNS.map((s) => [s, []])) };
  for (const c of judged) {
    const known = labels[c.id] ?? {};
    const item = (name: string): Item => ({ p: c.judged![name], label: known[name], was: c.recorded?.[name] });
    if (c.kind === "progress") {
      for (const sign of PROGRESS_SIGNS) if (c.judged![sign] !== undefined) questions[sign].push(item(sign));
      continue;
    }
    const reports = judgedNames(c).filter((name) => c.judged![name] !== undefined).map(item);
    questions["repeat, each report"].push(...reports);
    // A pure repeat: the report covers the brief and nothing lies beyond it.
    for (const part of Object.values(c.parts ?? {})) questions["repeat, fully covered (covers and not beyond; unlabelled)"].push({ p: Math.min(part.covers, 1 - part.beyond) });
    if (!reports.length) continue;
    const top = (values: (number | undefined)[]) => (values.some((v) => v === undefined) ? undefined : Math.max(...(values as number[])));
    questions["repeat, each dispatch (its highest report)"].push({
      p: Math.max(...reports.map((r) => r.p)),
      label: reports.some((r) => r.label === 1) ? 1 : reports.every((r) => r.label === 0) ? 0 : undefined,
      was: top(reports.map((r) => r.was)),
    });
  }
  const ms = judged.flatMap((c) => (c.durationMs === undefined ? [] : [c.durationMs])),
    tokens = judged.flatMap((c) => (c.inputTokens === undefined ? [] : [c.inputTokens])),
    total = tokens.reduce((n, t) => n + t, 0),
    days = checks.length ? Math.max(1, (checks.at(-1)!.at - checks[0].at) / 86_400_000) : null;
  const count = (kind: Check["kind"]) => checks.filter((c) => c.kind === kind).length;
  const labelledChecks = (kind: Check["kind"]) => judged.filter((c) => c.kind === kind && judgedNames(c).some((n) => labels[c.id]?.[n] !== undefined)).length;
  return {
    checks: checks.length,
    from: checks[0]?.at ?? null,
    to: checks.at(-1)?.at ?? null,
    days,
    conversations: new Set(checks.map((c) => c.runId)).size,
    repeat: count("repeat"),
    progress: count("progress"),
    notJudged: checks.filter((c) => !c.judged).reduce<Record<string, number>>((n, c) => ({ ...n, [c.reason ?? "unknown"]: (n[c.reason ?? "unknown"] ?? 0) + 1 }), {}),
    labelled: { repeat: labelledChecks("repeat"), progress: labelledChecks("progress") },
    questions: Object.fromEntries(Object.entries(questions).map(([name, items]) => [name, question(items)])),
    jev: {
      ms: { median: quantile(ms, 0.5), p90: quantile(ms, 0.9), max: ms.length ? Math.max(...ms) : null },
      inputTokens: { median: quantile(tokens, 0.5), max: tokens.length ? Math.max(...tokens) : null, total },
      costUsd: total * JEV_INPUT_COST_PER_TOKEN,
      costPerDayUsd: days ? (total * JEV_INPUT_COST_PER_TOKEN) / days : null,
    },
  };
}
export type CheckReport = ReturnType<typeof scoreChecks>;

const pct = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
const num = (value: number | null, digits = 0) => (value === null ? "-" : value.toLocaleString("en-US", { maximumFractionDigits: digits }));
const day = (at: number | null) => (at === null ? "-" : new Date(at).toISOString().slice(0, 10));
export function formatChecks(report: CheckReport, title: string) {
  const lines = [
    title,
    `Checks ${report.checks} from ${day(report.from)} to ${day(report.to)} (${num(report.days, 1)} days, ${report.conversations} conversations): ${report.repeat} repeat, ${report.progress} progress${Object.entries(report.notJudged).map(([reason, n]) => `; ${n} ${reason}`).join("")}. Labelled: ${report.labelled.repeat} repeat, ${report.labelled.progress} progress.`,
  ];
  for (const [name, q] of Object.entries(report.questions)) {
    lines.push(
      `${name}: ${q.judged} judged, ${q.labelled} labelled, ${q.held} held; AUC ${num(q.auc, 3)}${q.spread ? `; replay moved ${q.spread.compared} by ${num(q.spread.mean, 2)} mean, ${num(q.spread.max, 2)} max` : ""}.`,
      `  threshold | flagged | precision | recall${q.spread ? " | flips" : ""}`,
      ...q.thresholds.map((t) =>
        `  ${t.threshold.toFixed(2)} | ${t.flagged}/${q.judged} (${pct(ratio(t.flagged, q.judged))}) | ${pct(t.precision)} (${t.tp}/${t.tp + t.fp}) | ${pct(t.recall)} (${t.tp}/${q.held})${t.flips === null ? "" : ` | ${t.flips}`}`,
      ),
    );
  }
  const { jev } = report;
  lines.push(
    `Jev: ${num(jev.ms.median)} ms median (p90 ${num(jev.ms.p90)}, max ${num(jev.ms.max)}); input tokens ${num(jev.inputTokens.median)} median, ${num(jev.inputTokens.max)} max, ${num(jev.inputTokens.total)} total; estimated cost $${jev.costUsd.toFixed(4)} ($${(jev.costPerDayUsd ?? 0).toFixed(4)} a day).`,
  );
  return lines.join("\n");
}

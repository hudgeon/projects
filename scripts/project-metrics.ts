// Scores replayed project reviews against hand labels and against the files
// each original turn read or changed. Reports carry numbers, review ids and
// paths only; unit text stays in the private replay file.
import { JEV_INPUT_COST_PER_TOKEN } from "../runner/context";
import { CANDIDATE_CHARS } from "../runner/project-context";
import { eligible, instructionFile } from "../runner/project-sources";
import type { Usage } from "../runner/project-turn";

export const CUTOFFS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
export type Ref = { path: string; startChar: number; endChar: number };
export type Unit = Ref & {
  section?: string;
  text?: string;
  score?: number;
  noul: number | null;
  kept: boolean;
  // First and last line of a file unit, when known.
  lines?: [number, number];
};
export type Result = {
  id: string;
  projectId?: string;
  reason: string;
  strategy?: string;
  failure?: string;
  judgeMs: number | null;
  fetchMs?: number | null;
  totalMs?: number | null;
  requestBytes?: number | null;
  inputTokens: number | null;
  considered: Unit[];
  // The original turn's selection and the files that turn used.
  recorded?: { units: (Ref & { lines?: [number, number] })[]; supplied: number[] };
  usage?: Usage;
};
// 2 on-subject, 1 adjacent, 0 off-topic; by review id, then unit key.
export type Labels = Record<string, { units: Record<string, number> }>;
export const key = (u: Ref) => `${u.path}:${u.startChar}-${u.endChar}`;
const chars = (units: Ref[]) =>
  units.reduce((n, u) => n + u.endChar - u.startChar, 0);
// The best units, in order, that fit the budget, as the runner supplies them.
export function supply<T extends Ref>(ranked: T[]) {
  let used = 0;
  return ranked.filter((u) => {
    if (used + u.endChar - u.startChar > CANDIDATE_CHARS) return false;
    used += u.endChar - u.startChar;
    return true;
  });
}
export const atCutoff = (units: Unit[], cutoff: number) =>
  supply(
    units
      .filter((u) => u.noul !== null && u.noul >= cutoff)
      .sort((a, b) => b.noul! - a.noul!),
  );
const ratio = (n: number, d: number) => (d ? n / d : null);
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2
    : null;
};
const mean = (values: number[]) =>
  values.length ? values.reduce((n, v) => n + v, 0) / values.length : null;

// Precision over the labelled units kept; recall over the labelled relevant
// units in the shortlist. Units without a label count in neither.
function selection(
  rows: { units: Unit[]; labels: Record<string, number> }[],
  pick: (units: Unit[]) => Unit[],
) {
  const totals = { turns: rows.length, kept: 0, empty: 0, unlabelled: 0, labelled: 0, strict: 0, lenient: 0, strictAll: 0, lenientAll: 0, chars: 0, relevantChars: 0 };
  for (const { units, labels } of rows) {
    const kept = pick(units);
    totals.kept += kept.length;
    totals.empty += kept.length ? 0 : 1;
    totals.chars += chars(kept);
    for (const u of kept) {
      const label = labels[key(u)];
      if (label === undefined) totals.unlabelled++;
      else {
        totals.labelled++;
        totals.strict += label === 2 ? 1 : 0;
        totals.lenient += label >= 1 ? 1 : 0;
        totals.relevantChars += label >= 1 ? u.endChar - u.startChar : 0;
      }
    }
    for (const u of units) {
      const label = labels[key(u)];
      totals.strictAll += label === 2 ? 1 : 0;
      totals.lenientAll += label >= 1 ? 1 : 0;
    }
  }
  return {
    ...totals,
    keptPerTurn: ratio(totals.kept, totals.turns),
    strictPrecision: ratio(totals.strict, totals.labelled),
    lenientPrecision: ratio(totals.lenient, totals.labelled),
    strictRecall: ratio(totals.strict, totals.strictAll),
    lenientRecall: ratio(totals.lenient, totals.lenientAll),
    charsPerTurn: ratio(totals.chars, totals.turns),
    relevantCharsPerTurn: ratio(totals.relevantChars, totals.turns),
  };
}

// How often Jev's probability ranks a relevant unit above an irrelevant one.
function auc(rows: { units: Unit[]; labels: Record<string, number> }[], strict: boolean) {
  const positive: number[] = [],
    negative: number[] = [];
  for (const { units, labels } of rows)
    for (const u of units) {
      const label = labels[key(u)];
      if (label === undefined || u.noul === null) continue;
      (label >= (strict ? 2 : 1) ? positive : negative).push(u.noul);
    }
  let wins = 0;
  for (const p of positive)
    for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return ratio(wins, positive.length * negative.length);
}

// Implicit usage: did the turn read or change the files a selection supplied,
// and did the selection supply the project files the turn used? File units
// only; a work issue's units are not files.
export function usageProxy(
  usage: Usage,
  supplied: (Ref & { lines?: [number, number] })[],
  shortlist: Ref[],
) {
  const files = new Map(usage.files.map((f) => [f.path, f]));
  const used = usage.files
    .map((f) => f.path)
    .filter((p) => eligible(p) && !instructionFile(p));
  const own = supplied.filter((u) => !u.path.includes("://"));
  const overlaps = (u: Ref & { lines?: [number, number] }) => {
    const f = files.get(u.path);
    if (!f) return false;
    if (f.changed || (f.read && !f.lines) || !u.lines) return !!(f.changed || f.read);
    return f.lines!.some(([a, b]) => a <= u.lines![1] && b >= u.lines![0]);
  };
  const paths = (units: Ref[]) => new Set(units.map((u) => u.path));
  const suppliedPaths = paths(own),
    shortlistPaths = paths(shortlist);
  return {
    supplied: own.length,
    suppliedInUsedFiles: own.filter((u) => files.has(u.path)).length,
    suppliedRead: own.filter(overlaps).length,
    usedFiles: used.length,
    usedFilesSupplied: used.filter((p) => suppliedPaths.has(p)).length,
    usedFilesShortlisted: used.filter((p) => shortlistPaths.has(p)).length,
  };
}
type Proxy = ReturnType<typeof usageProxy>;
const summed = (proxies: Proxy[]) => {
  const total = { supplied: 0, suppliedInUsedFiles: 0, suppliedRead: 0, usedFiles: 0, usedFilesSupplied: 0, usedFilesShortlisted: 0 };
  for (const p of proxies)
    for (const k of Object.keys(total) as (keyof Proxy)[]) total[k] += p[k];
  return {
    turns: proxies.length,
    ...total,
    precision: ratio(total.suppliedInUsedFiles, total.supplied),
    unitPrecision: ratio(total.suppliedRead, total.supplied),
    recall: ratio(total.usedFilesSupplied, total.usedFiles),
    shortlistRecall: ratio(total.usedFilesShortlisted, total.usedFiles),
  };
};

export function score(results: Result[], labels: Labels) {
  const judged = results.filter((r) => r.considered.some((u) => u.noul !== null));
  const labelled = judged
    .map((r) => ({ units: r.considered, labels: labels[r.id]?.units ?? {} }))
    .filter((row) => row.units.some((u) => row.labels[key(u)] !== undefined));
  // Labelled relevant units of each turn, wherever earlier shortlists found
  // them, and how many this shortlist still holds.
  let relevant = 0,
    retained = 0,
    shortlistUnits = 0,
    unlabelledUnits = 0;
  for (const r of judged) {
    const known = labels[r.id]?.units ?? {};
    if (!Object.keys(known).length) continue;
    const keys = new Set(r.considered.map(key));
    for (const [k, v] of Object.entries(known))
      if (v >= 1) {
        relevant++;
        retained += keys.has(k) ? 1 : 0;
      }
    shortlistUnits += r.considered.length;
    unlabelledUnits += r.considered.filter((u) => known[key(u)] === undefined).length;
  }
  const withUsage = results.filter((r) => r.usage && r.considered.length);
  const recorded = withUsage.filter((r) => r.recorded);
  const judgeMs = judged.flatMap((r) => (r.judgeMs === null ? [] : [r.judgeMs]));
  const tokens = judged.flatMap((r) => (r.inputTokens === null ? [] : [r.inputTokens]));
  return {
    reviews: results.length,
    judged: judged.length,
    notJudged: results
      .filter((r) => !judged.includes(r))
      .reduce<Record<string, number>>(
        (counts, r) => ({ ...counts, [r.reason]: (counts[r.reason] ?? 0) + 1 }),
        {},
      ),
    supplied: {
      unitsPerTurn: mean(results.map((r) => r.considered.filter((u) => u.kept).length)),
      charsPerTurn: mean(results.map((r) => chars(r.considered.filter((u) => u.kept)))),
    },
    labels: {
      turns: labelled.length,
      shortlistUnits,
      unlabelledUnits,
      relevant,
      relevantInShortlist: retained,
      auc: { strict: auc(labelled, true), lenient: auc(labelled, false) },
    },
    cutoffs: CUTOFFS.map((cutoff) => ({
      cutoff,
      ...selection(labelled, (units) => atCutoff(units, cutoff)),
    })),
    // What shadow mode and failures supply: retrieval order within budget.
    retrieval: selection(labelled, (units) => supply(units)),
    usage: {
      replayed: summed(
        withUsage.map((r) =>
          usageProxy(r.usage!, r.considered.filter((u) => u.kept), r.considered),
        ),
      ),
      recorded: summed(
        recorded.map((r) =>
          usageProxy(
            r.usage!,
            r.recorded!.supplied.map((i) => r.recorded!.units[i]).filter(Boolean),
            r.recorded!.units,
          ),
        ),
      ),
    },
    jev: {
      judgeMs: { median: median(judgeMs), min: judgeMs.length ? Math.min(...judgeMs) : null, max: judgeMs.length ? Math.max(...judgeMs) : null },
      inputTokens: { median: median(tokens), max: tokens.length ? Math.max(...tokens) : null, total: tokens.reduce((n, t) => n + t, 0) },
      costUsd: tokens.reduce((n, t) => n + t, 0) * JEV_INPUT_COST_PER_TOKEN,
      requestBytes: median(judged.flatMap((r) => (r.requestBytes ? [r.requestBytes] : []))),
    },
    turns: results.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      reason: r.reason,
      units: r.considered.filter((u) => u.kept).length,
      chars: chars(r.considered.filter((u) => u.kept)),
      shortlist: r.considered.length,
      labelled: r.considered.filter((u) => labels[r.id]?.units[key(u)] !== undefined).length,
      judgeMs: r.judgeMs === null ? null : Math.round(r.judgeMs),
      inputTokens: r.inputTokens,
      usedFiles: r.usage?.files.length ?? null,
    })),
  };
}
export type Report = ReturnType<typeof score>;

const pct = (value: number | null) =>
  value === null ? "-" : `${Math.round(value * 100)}%`;
const num = (value: number | null, digits = 0) =>
  value === null ? "-" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const of = (n: number, d: number, value: number | null) =>
  `${pct(value)} (${n}/${d})`;
export const formatUsage = (name: string, u: Report["usage"]["replayed"]) =>
  `Usage, ${name} (${u.turns} turns): supplied units in files the turn used ${of(u.suppliedInUsedFiles, u.supplied, u.precision)}, overlapping what it read or changed ${of(u.suppliedRead, u.supplied, u.unitPrecision)}; used files supplied ${of(u.usedFilesSupplied, u.usedFiles, u.recall)}, shortlisted ${of(u.usedFilesShortlisted, u.usedFiles, u.shortlistRecall)}.`;
export function format(report: Report, title: string) {
  const lines = [
    title,
    `Reviews ${report.reviews}: ${report.judged} judged${Object.entries(report.notJudged).map(([reason, n]) => `, ${n} ${reason}`).join("")}. Supplied per turn: ${num(report.supplied.unitsPerTurn, 1)} units, ${num(report.supplied.charsPerTurn)} chars.`,
    `Labels: ${report.labels.turns} turns; ${report.labels.unlabelledUnits} of ${report.labels.shortlistUnits} shortlisted units unlabelled; ${report.labels.relevantInShortlist} of ${report.labels.relevant} known relevant units in the shortlist; Jev AUC strict ${num(report.labels.auc.strict, 3)}, lenient ${num(report.labels.auc.lenient, 3)}.`,
    "cutoff | kept/turn | empty | strict P | lenient P | strict R | lenient R | chars/turn | relevant chars/turn | kept unlabelled",
  ];
  for (const row of [...report.cutoffs, { cutoff: "order", ...report.retrieval }])
    lines.push(
      [
        typeof row.cutoff === "number" ? row.cutoff.toFixed(2) : "retrieval",
        num(row.keptPerTurn, 1),
        row.empty,
        of(row.strict, row.labelled, row.strictPrecision),
        of(row.lenient, row.labelled, row.lenientPrecision),
        of(row.strict, row.strictAll, row.strictRecall),
        of(row.lenient, row.lenientAll, row.lenientRecall),
        num(row.charsPerTurn),
        num(row.relevantCharsPerTurn),
        row.unlabelled,
      ].join(" | "),
    );
  for (const [name, u] of Object.entries(report.usage))
    lines.push(formatUsage(`${name} selection`, u));
  const { jev } = report;
  lines.push(
    `Jev: judge ${num(jev.judgeMs.median)} ms median (${num(jev.judgeMs.min)}-${num(jev.judgeMs.max)}); input tokens ${num(jev.inputTokens.median)} median, ${num(jev.inputTokens.max)} max, ${num(jev.inputTokens.total)} total; request ${num(jev.requestBytes)} bytes median; estimated cost $${jev.costUsd.toFixed(4)}.`,
    "id | project | reason | units | chars | shortlist | labelled | judge ms | tokens | used files",
    ...report.turns.map((t) =>
      [t.id, t.projectId ?? "-", t.reason, t.units, t.chars, t.shortlist, t.labelled, num(t.judgeMs), num(t.inputTokens), num(t.usedFiles)].join(" | "),
    ),
  );
  return lines.join("\n");
}

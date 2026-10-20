import { z } from "zod";
// Friction in native Claude Code and Codex sessions: fixed categories and
// counts, derived on each machine from its own transcripts by local rules.
// Receipts stay on the machine; a snapshot carries only per-day totals by
// app and the harness versions seen, never a prompt, command, path or output.
export const FRICTION_CATEGORIES = {
  prompts: "prompts",
  toolCalls: "tool calls",
  commandFailed: "failed commands",
  toolFailed: "failed tool calls",
  denied: "denied tool uses",
  hookBlocked: "hook blocks",
  hookFailed: "hook failures",
  misuse: "tool misuse",
  apiErrors: "API errors",
  compactions: "compactions",
  repeatedCommands: "repeated commands",
  interrupted: "interruptions",
} as const;
export type FrictionCategory = keyof typeof FRICTION_CATEGORIES;
export const FRICTION_KEYS = Object.keys(FRICTION_CATEGORIES) as FrictionCategory[];
// The categories that are friction in themselves; prompts and tool calls are
// the volume they happened in.
export const FRICTION_SIGNS = FRICTION_KEYS.filter(
  (key) => key !== "prompts" && key !== "toolCalls",
);
const count = z.number().int().nonnegative();
export const frictionCountsSchema = z
  .object({
    prompts: count,
    toolCalls: count,
    commandFailed: count,
    toolFailed: count,
    denied: count,
    hookBlocked: count,
    hookFailed: count,
    misuse: count,
    apiErrors: count,
    compactions: count,
    repeatedCommands: count,
    interrupted: count,
  })
  .strict();
export type FrictionCounts = z.infer<typeof frictionCountsSchema>;
export const emptyCounts = (): FrictionCounts =>
  Object.fromEntries(FRICTION_KEYS.map((key) => [key, 0])) as FrictionCounts;
export function addCounts(into: FrictionCounts, more: FrictionCounts) {
  for (const key of FRICTION_KEYS) into[key] += more[key];
  return into;
}
export const frictionAppSchema = z.enum(["Codex", "Claude"]);
export type FrictionApp = z.infer<typeof frictionAppSchema>;
const version = z.string().regex(/^[\w.+-]{1,40}$/);
// One UTC day's sessions for one app: those whose last activity fell on it.
export const frictionDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    app: frictionAppSchema,
    sessions: count,
    counts: frictionCountsSchema,
  })
  .strict();
export type FrictionDay = z.infer<typeof frictionDaySchema>;
export const FRICTION_DAYS = 14;
export const frictionSnapshotSchema = z
  .object({
    observedAt: count,
    // The versions the newest session of each app ran with, and the newest
    // Codex release the app itself has seen.
    versions: z
      .object({
        claude: version.optional(),
        codex: version.optional(),
        codexLatest: version.optional(),
      })
      .strict(),
    days: z.array(frictionDaySchema).max(FRICTION_DAYS * 2),
    state: z.enum(["ok", "unavailable"]),
    message: z.string().max(500),
  })
  .strict();
export type FrictionSnapshot = z.infer<typeof frictionSnapshotSchema>;
export const utcDate = (at: number) => new Date(at).toISOString().slice(0, 10);
// Whether one version is newer than another, numeric part by part; a
// pre-release label sorts below a number.
export function newer(release: string, than: string) {
  const parts = (v: string) => v.split(/[.+-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : -1));
  const a = parts(release),
    b = parts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
// Totals over the days since a date, each app's sessions and counts added.
export function frictionTotals(days: FrictionDay[], since: string) {
  const total = { sessions: 0, counts: emptyCounts() };
  for (const day of days)
    if (day.date >= since) {
      total.sessions += day.sessions;
      addCounts(total.counts, day.counts);
    }
  return total;
}
// A short line of the categories seen, for the overview and the local report.
export function frictionLine(counts: FrictionCounts, sessions: number) {
  const parts = FRICTION_SIGNS.filter((key) => counts[key] > 0).map(
    (key) => `${counts[key].toLocaleString("en-US")} ${FRICTION_CATEGORIES[key]}`,
  );
  const volume = `${sessions} session${sessions === 1 ? "" : "s"}, ${counts.prompts} prompts, ${counts.toolCalls} tool calls`;
  return parts.length ? `${volume}: ${parts.join(", ")}` : `${volume}: no friction seen`;
}

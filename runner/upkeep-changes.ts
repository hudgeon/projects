// Closing the loop (docs/upkeep.md): each change the standing issue records,
// compared with the machines' friction in the snapshots the claim hands over,
// for the upkeep brief. A change is compared over a window of as many days as
// its before measure, ending today like the brief's evidence and wholly after
// the day it landed; a window without the sessions the comparison needs is
// "not yet measurable", never "did not move".
import { frictionTotals, utcDate, type FrictionSnapshot } from "../src/friction-model";
import { measureText, recordHeader, valueText, type UpkeepChange } from "../src/upkeep-model";

const DAY = 86400_000;
// A fall moves the measure when the count per session is at least a quarter
// lower and at least this many below what the before rate predicts for the
// after window's sessions; the window needs enough sessions for the before
// rate to predict that many, and never fewer than that many.
export const MOVE_COUNT = 3;
type Machine = { host: string; friction?: FrictionSnapshot };
type Measured = Exclude<UpkeepChange["before"], "none">;
export type Comparison = {
  verdict: "moved" | "did not move" | "rose" | "not yet measurable" | "by its guard";
  after?: Measured;
  text: string;
};
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const rate = (count: number, sessions: number) => (count / sessions).toFixed(2);
const revise = "revise it once or revert it";
export function compareChange(c: UpkeepChange, machines: Machine[], now = Date.now()): Comparison {
  if (c.measure === "guard" || c.before === "none")
    return {
      verdict: "by its guard",
      text: `measured by its guard: a read child confirms the guard is in place and passing on the default branch. Then set its After to "passes" and its State to kept, or its After to "fails" and ${revise}.`,
    };
  const { category, app, machine } = c.measure;
  const before = c.before,
    days = before.days,
    today = utcDate(now);
  const pending = (why: string): Comparison => ({
    verdict: "not yet measurable",
    text: `not yet measurable: ${why}. It stays watching, its After not yet.`,
  });
  const window = `the ${plural(days, "day")} to ${today}`,
    from = utcDate(now - (days - 1) * DAY);
  if (from <= c.date)
    return pending(
      `${window} still hold ${c.date}, the day it landed; the first comparable window is the ${plural(days, "day")} to ${utcDate(Date.parse(c.date) + days * DAY)}`,
    );
  const named = machine === null ? machines : machines.filter((m) => m.host === machine);
  const counted = named.filter((m) => m.friction?.state === "ok");
  const missing = named.filter((m) => m.friction?.state !== "ok").map((m) => m.host);
  if (!counted.length)
    return pending(
      machine
        ? `${machine} has no friction totals in this cycle's snapshots`
        : "no machine has friction totals in this cycle's snapshots",
    );
  const tomorrow = utcDate(now + DAY);
  const total = frictionTotals(
    counted.flatMap((m) => m.friction!.days.filter((d) => d.app === app && d.date < tomorrow)),
    from,
  );
  const a = total.sessions,
    A = total.counts[category],
    b = before.sessions,
    B = before.count;
  const where = `${counted.map((m) => m.host).join(", ")}${missing.length ? `; ${missing.join(", ")} had no totals and ${missing.length === 1 ? "is" : "are"} not counted` : ""}`;
  const needed = Math.max(MOVE_COUNT, Math.ceil((MOVE_COUNT * b) / B));
  if (a < needed)
    return pending(`${window} had ${plural(a, `${app} session`)} on ${where}, and the comparison needs at least ${needed}`);
  const after: Measured = { count: A, sessions: a, days, to: today };
  // Exact comparisons of A/a with B/b, and of B*a/b - A with the margin.
  const fell = 4 * A * b <= 3 * B * a && B * a - A * b >= MOVE_COUNT * b;
  const rose = 4 * A * b >= 5 * B * a && A * b - B * a >= MOVE_COUNT * b;
  const higher = A * b > B * a;
  const verdict = fell ? "moved" : rose ? "rose" : "did not move";
  const numbers = `Before ${valueText(before)} (${rate(B, b)} a session); after ${valueText(after)} (${rate(A, a)} a session), counted on ${where}: ${Math.floor(Math.abs(1 - (A * b) / (B * a)) * 100)}% ${higher ? "higher" : "lower"} a session, ${Number(Math.abs((B * a) / b - A).toFixed(1))} ${higher ? "more" : "fewer"} than the before rate predicts for ${plural(a, "session")}.`;
  return {
    verdict,
    after,
    text: `${verdict === "rose" ? "did not move, it rose" : verdict}. ${numbers} Set its After to "${valueText(after)}"${fell ? " and its State to kept." : `; ${revise}.`}`,
  };
}
export function recordForm(now = Date.now()) {
  return `The record of changes is the table under the "## Upkeep" heading, after the Reviewed versions line, one row per change, in exactly this form:
${recordHeader}
Date: YYYY-MM-DD, the day the change landed, or while it is waiting the day it was recorded. Change: what changed, with its pull request link, at most 300 characters. Measure: "<friction category>, <Claude or Codex>, <machine or all machines>", with a category and a machine as the evidence names them, or "guard" when the guard itself is the measure. Before and After: "<count> in <sessions> sessions, <days> days to YYYY-MM-DD" (a before measure from the evidence's last 7 days reads "7 days to ${utcDate(now)}"), or "not yet" until the after measure is known; a guard measure's Before is "none" and its After "passes" or "fails". Guard: the test or check that keeps the change in place, at most 200 characters. State: waiting, watching, kept, revised or reverted. Escape a literal pipe in a cell as backslash-pipe.`;
}
// The brief's closing-the-loop paragraph: what the record holds and, for each
// change still waiting or watching, what this cycle does with it.
export function changesStatus(
  machines: Machine[],
  review: { changes?: UpkeepChange[] | null } | null | undefined,
  now = Date.now(),
) {
  const form = recordForm(now);
  if (!review)
    return `The record of changes could not be read from this machine's work item cache, so no change is compared this cycle.\n${form}`;
  if (review.changes === undefined)
    return `The standing issue's record of changes is not in this machine's work item cache yet, so no change is compared this cycle.\n${form}`;
  if (review.changes === null)
    return `The record of changes under "## Upkeep" in the standing issue is not in the fixed form below, so no change is compared this cycle: the change child that records the cycle restores the form first, keeping every row's facts.\n${form}`;
  const rows = review.changes;
  const open = rows.filter((c) => c.state === "waiting" || c.state === "watching");
  const kept = rows.filter((c) => c.state === "kept");
  const lines = open.map(
    (c) =>
      `- "${c.change}" (${c.state} since ${c.date}; measure ${measureText(c.measure)}; guard ${c.guard}): ${
        c.state === "waiting"
          ? "a read child checks whether its pull request has merged; once it has, set its State to watching and its Date to the day it merged."
          : compareChange(c, machines, now).text
      }`,
  );
  return [
    !rows.length
      ? "No change is recorded yet."
      : !open.length
        ? "No recorded change is waiting or watching."
        : `Each recorded change still waiting or watching, compared over a window of as many days as its before measure, ending today (${utcDate(now)}) like the evidence:`,
    ...lines,
    kept.length
      ? `Kept changes, whose guards stay in place: ${kept.map((c) => `${c.guard} (${c.date}, ${measureText(c.measure)})`).join("; ")}.`
      : "",
    form,
  ]
    .filter(Boolean)
    .join("\n");
}

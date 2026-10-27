// Hourly delivery at half past makes the daily cycle follow the configured
// deployment time zone, including daylight saving, without embedding an
// owner's location. The cycle starts at the first delivery at or after the
// local start time.
export const WORK_REVIEW_CRON = "30 * * * *";
export const WORK_REVIEW_TIME = "05:30";
const start =
  Number(WORK_REVIEW_TIME.slice(0, 2)) * 60 + Number(WORK_REVIEW_TIME.slice(3));
// The local day, and the local time as minutes after midnight.
export function workReviewDay(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (name: string) => parts.find((p) => p.type === name)?.value;
  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}
export const workReviewDue = (minute: number) => minute >= start;
export const workReviewText =
  "Daily work reconciliation: review changed and due work records against their actual evidence; correct supported facts in the existing canonical issues. Follow the work-review brief. Do not execute the underlying customer or project work.";
export function workReviewScheduleProblem(
  receipt: { scheduledAt: number; observedAt: number; outcome: string } | null,
  now: number,
  timeZone: string,
) {
  if (!receipt) return "No daily scheduled check has been observed yet.";
  const current = workReviewDay(now, timeZone);
  const expected = workReviewDue(current.minute)
    ? current.day
    : workReviewDay(now - 86400_000, timeZone).day;
  if (
    workReviewDay(receipt.scheduledAt, timeZone).day < expected &&
    (current.minute < start || current.minute >= start + 60)
  )
    return "The latest daily scheduled check has not been observed.";
  if (
    ["failed", "no_owner", "no_machine", "no_snapshot"].includes(
      receipt.outcome,
    )
  )
    return `The daily review did not start (${receipt.outcome}).`;
  if (receipt.outcome === "checking" && now - receipt.observedAt > 600000)
    return "The daily scheduled check has not confirmed an outcome.";
  return null;
}

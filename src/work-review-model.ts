// Hourly delivery makes the daily cycle follow the configured deployment time
// zone, including daylight saving, without embedding an owner's location.
export const WORK_REVIEW_CRON = "0 * * * *";
export const WORK_REVIEW_HOUR = 7;
export function workReviewDay(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (name: string) => parts.find((p) => p.type === name)?.value;
  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}
export const workReviewText =
  "Daily work reconciliation: review changed and due work records against their actual evidence; correct supported facts in the existing canonical issues. Follow the work-review brief. Do not execute the underlying customer or project work.";
export function workReviewScheduleProblem(
  receipt: { scheduledAt: number; observedAt: number; outcome: string } | null,
  now: number,
  timeZone: string,
) {
  if (!receipt) return "No daily scheduled check has been observed yet.";
  const current = workReviewDay(now, timeZone);
  const expected =
    current.hour >= WORK_REVIEW_HOUR
      ? current.day
      : workReviewDay(now - 86400_000, timeZone).day;
  if (
    workReviewDay(receipt.scheduledAt, timeZone).day < expected &&
    current.hour !== WORK_REVIEW_HOUR
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

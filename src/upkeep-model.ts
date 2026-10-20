// The upkeep lane: one conversation a week for the deployment owner, in which
// a master reads the friction receipts and installed harness versions on the
// connected machines and makes at most one guarded change to the agent setup
// (docs/upkeep.md). The Worker's cron (wrangler.jsonc, triggers.crons) and
// Settings' Run upkeep now start it.
export const UPKEEP_CRON = "0 6 * * 1";
export const UPKEEP_SCHEDULE = "Mondays at 06:00 UTC";
// Active upkeep conversations at once: the week's, and a follow-up to an
// earlier one.
export const UPKEEP_ACTIVE_LIMIT = 2;
// The ISO week a moment falls in, in UTC: the cron's idempotence key, so a
// trigger that fires twice in one week finds that week's conversation.
export function upkeepWeek(at: number) {
  const date = new Date(at);
  date.setUTCHours(0, 0, 0, 0);
  // ISO weeks start on Monday and belong to the year of their Thursday.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
// One conversation id per portfolio and week, read from a hash as a UUID, so
// the same week asks for the same conversation and finds it already started.
export async function upkeepRequestId(portfolio: string, week: string) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`upkeep:${portfolio}:${week}`)),
  );
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type UpkeepStart = "schedule" | "settings";
// The request that starts a cycle. The evidence and the rules come with the
// runner's brief (runner/upkeep-instructions.ts).
export const upkeepText = (started: UpkeepStart) =>
  `${started === "schedule" ? "Weekly upkeep cycle" : "Upkeep cycle, started from Settings"}: read the friction totals and installed harness versions for every connected machine, check the standing upkeep issue, and decide whether one change to the agent setup is needed this cycle. Follow the upkeep rules in your brief; "no change needed" is a complete result.`;

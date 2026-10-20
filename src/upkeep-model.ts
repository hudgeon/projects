// The upkeep lane: one conversation a week for the deployment owner, in which
// a master reads the friction receipts and installed harness versions on the
// connected machines and makes at most one guarded change to the agent setup
// (docs/upkeep.md). The Worker's cron (wrangler.jsonc, triggers.crons) and
// Settings' Run upkeep now start it.
import { z } from "zod";
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
// The official sources the harness research reads each cycle, and nothing
// else (docs/upkeep.md): one changelog per app, plus the documentation for
// hooks, skills, settings, permission modes, output formats and MCP
// configuration, and for how the runner drives each app (Claude Code's flags
// and background tasks, Codex's app server). An upkeep read child on Claude
// may fetch these hosts only.
export const UPKEEP_SOURCES = [
  { app: "Claude Code", topic: "changelog", url: "https://code.claude.com/docs/en/changelog" },
  { app: "Claude Code", topic: "hooks", url: "https://code.claude.com/docs/en/hooks" },
  { app: "Claude Code", topic: "skills", url: "https://code.claude.com/docs/en/skills" },
  { app: "Claude Code", topic: "settings", url: "https://code.claude.com/docs/en/settings" },
  { app: "Claude Code", topic: "permission modes", url: "https://code.claude.com/docs/en/permission-modes" },
  { app: "Claude Code", topic: "output formats", url: "https://code.claude.com/docs/en/headless" },
  { app: "Claude Code", topic: "CLI flags", url: "https://code.claude.com/docs/en/cli-reference" },
  { app: "Claude Code", topic: "MCP configuration", url: "https://code.claude.com/docs/en/mcp" },
  { app: "Claude Code", topic: "background tasks", url: "https://code.claude.com/docs/en/tools-reference" },
  { app: "Codex", topic: "changelog", url: "https://learn.chatgpt.com/docs/changelog" },
  { app: "Codex", topic: "releases", url: "https://github.com/openai/codex/releases" },
  { app: "Codex", topic: "hooks", url: "https://learn.chatgpt.com/docs/hooks" },
  { app: "Codex", topic: "skills", url: "https://learn.chatgpt.com/docs/build-skills" },
  { app: "Codex", topic: "settings", url: "https://learn.chatgpt.com/docs/config-file/config-reference" },
  { app: "Codex", topic: "permission modes", url: "https://learn.chatgpt.com/docs/permissions" },
  { app: "Codex", topic: "output formats", url: "https://learn.chatgpt.com/docs/non-interactive-mode" },
  { app: "Codex", topic: "MCP configuration", url: "https://learn.chatgpt.com/docs/extend/mcp" },
  { app: "Codex", topic: "app server", url: "https://learn.chatgpt.com/docs/app-server" },
] as const;
export type UpkeepSource = (typeof UPKEEP_SOURCES)[number];
export const UPKEEP_SOURCE_HOSTS = [...new Set(UPKEEP_SOURCES.map((s) => new URL(s.url).hostname))];
// The versions the research last reviewed, as the standing issue records
// them: one line under its `## Upkeep` heading, which the cycle's change
// child keeps current and the next cycle's research starts from.
const version = z.string().regex(/^[\w.+-]{1,40}$/);
export const reviewedVersionsSchema = z
  .object({
    claude: version.optional(),
    codex: version.optional(),
    on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
export type ReviewedVersions = z.infer<typeof reviewedVersionsSchema>;
export const reviewedLine = (versions: { claude?: string; codex?: string }, on: string) =>
  `Reviewed versions: ${[
    versions.claude && `Claude Code ${versions.claude}`,
    versions.codex && `Codex ${versions.codex}`,
  ]
    .filter(Boolean)
    .join(", ")} (${on})`;
export function reviewedVersions(body: string): ReviewedVersions | null {
  const section = body.match(/^## Upkeep\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  const line = section?.match(/^Reviewed versions:\s*(.+)$/im)?.[1];
  if (!line) return null;
  const read = (name: string) =>
    line.match(new RegExp(`\\b${name}\\s+([\\w.+-]{1,40})(?![\\w.+-])`, "i"))?.[1];
  const found = {
    claude: read("Claude Code"),
    codex: read("Codex"),
    on: line.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1],
  };
  const parsed = reviewedVersionsSchema.safeParse(
    Object.fromEntries(Object.entries(found).filter(([, value]) => value)),
  );
  return parsed.success && (parsed.data.claude || parsed.data.codex) ? parsed.data : null;
}

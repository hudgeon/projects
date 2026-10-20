// Prints this machine's friction receipts: per-day totals by app, then the
// sessions with the most friction and, when Projects ran them, the
// conversation and helper they were. Local use only; receipts never leave
// the machine. `npm run friction -- --since 7d --top 10`.
import { homedir } from "node:os";
import path from "node:path";
import { frictionDays } from "../collector/friction";
import { projectsLinks, runnerStateDirectory } from "../collector/friction-runner";
import { frictionDirectory, readReceipts } from "../collector/friction-store";
import {
  FRICTION_CATEGORIES,
  FRICTION_SIGNS,
  frictionLine,
  frictionTotals,
  utcDate,
} from "../src/friction-model";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const days = Number(/^(\d+)d?$/.exec(option("since", "7d"))?.[1] ?? 7);
const top = Number(option("top", "10"));
const home = homedir();
const dir = option("dir", frictionDirectory(home));
const stateDir = option("state", runnerStateDirectory(home));
const now = Date.now();
const since = utcDate(now - (days - 1) * 86400_000);
const n = (value: number) => value.toLocaleString("en-US");
const receipts = (await readReceipts(dir)).filter(
  (r) => r.lastAt !== null && utcDate(r.lastAt) >= since,
);
const links = await projectsLinks(stateDir);
console.log(`Friction on this machine since ${since}: ${n(receipts.length)} sessions (receipts in ${dir})\n`);
const columns = ["date", "app", "sessions", "prompts", "tools", ...FRICTION_SIGNS];
const rows = frictionDays(receipts, now)
  .filter((day) => day.date >= since)
  .map((day) => [
    day.date,
    day.app,
    day.sessions,
    day.counts.prompts,
    day.counts.toolCalls,
    ...FRICTION_SIGNS.map((key) => day.counts[key]),
  ]);
const widths = columns.map((c, i) =>
  Math.max(c.length, ...rows.map((row) => String(row[i]).length)),
);
const line = (cells: (string | number)[]) =>
  cells.map((cell, i) => String(cell).padStart(widths[i])).join("  ");
console.log(line(columns));
for (const row of rows) console.log(line(row));
for (const app of ["Claude", "Codex"] as const) {
  const total = frictionTotals(
    frictionDays(receipts.filter((r) => r.app === app), now),
    since,
  );
  if (total.sessions) console.log(`${app}: ${frictionLine(total.counts, total.sessions)}`);
}
const score = (r: (typeof receipts)[number]) =>
  FRICTION_SIGNS.reduce((sum, key) => sum + r.counts[key], 0);
const worst = receipts
  .filter((r) => score(r) > 0)
  .sort((a, b) => score(b) - score(a))
  .slice(0, top);
if (worst.length) console.log(`\nSessions with the most friction (${worst.length} of ${receipts.filter((r) => score(r) > 0).length} with any):`);
for (const r of worst) {
  const link = links.get(`${r.app}:${r.id}`);
  const where = r.cwd ? path.basename(r.cwd) : "unknown folder";
  const signs = FRICTION_SIGNS.filter((key) => r.counts[key] > 0)
    .map((key) => `${n(r.counts[key])} ${FRICTION_CATEGORIES[key]}`)
    .join(", ");
  console.log(
    `\n${r.app} ${r.version ?? ""} ${r.client ?? ""} ${utcDate(r.lastAt!)} ${where}  id ${r.id}\n  ${n(r.counts.prompts)} prompts, ${n(r.counts.toolCalls)} tool calls: ${signs}`,
  );
  if (link) {
    const events = Object.entries(link.events)
      .map(([key, count]) => (count > 1 ? `${key} ×${count}` : key))
      .join(", ");
    console.log(
      `  Projects ${link.role}${link.mode ? ` (${link.mode})` : ""} in conversation ${link.runId.slice(0, 8)}${link.childId ? `, helper ${link.childId.slice(0, 8)}` : ""}${events ? `: ${events}` : ""}`,
    );
  }
}

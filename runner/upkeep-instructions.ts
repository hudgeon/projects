// The upkeep lane's brief (docs/upkeep.md): what the master is given each
// cycle to keep the agent setup improving from evidence. Friction receipts
// stay on each machine; the brief carries their totals and the harness
// versions from the latest snapshots, says where the receipts are, names the
// standing work issue and the configuration repository, and states the rules.
import { z } from "zod";
import {
  frictionLine,
  frictionSnapshotSchema,
  frictionTotals,
  utcDate,
  type FrictionApp,
  type FrictionDay,
  type FrictionSnapshot,
} from "../src/friction-model";
import type { Person } from "../src/people-model";
import type { ProjectDirectory } from "./workspaces";
import { who, whose } from "./instructions";

const DAY = 86400_000;
// The machines' latest snapshots, as the claim carries them (worker/claims.ts).
const observationSchema = z.array(
  z.object({
    host: z.string(),
    observedAt: z.number(),
    friction: frictionSnapshotSchema.optional(),
  }),
);
const versionLine = (f: FrictionSnapshot) =>
  [
    f.versions.claude ? `Claude Code ${f.versions.claude}` : "",
    f.versions.codex
      ? `Codex ${f.versions.codex}${f.versions.codexLatest ? ` (${f.versions.codexLatest} available)` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(", ") || "no versions seen";
// One app's totals over the days from `from` up to, not including, `until`.
function appTotals(days: FrictionDay[], app: FrictionApp, from: string, until: string) {
  const total = frictionTotals(days.filter((d) => d.app === app && d.date < until), from);
  return total.sessions ? `${app}: ${frictionLine(total.counts, total.sessions)}` : "";
}
function windowLine(days: FrictionDay[], from: string, until: string) {
  const parts = (["Claude", "Codex"] as const)
    .map((app) => appTotals(days, app, from, until))
    .filter(Boolean);
  return parts.length ? parts.join("; ") : "no sessions";
}
// One line per machine: its versions, the last seven days and the seven before.
export function upkeepEvidence(activity: unknown, now = Date.now()) {
  const parsed = observationSchema.safeParse(activity);
  if (!parsed.success || !parsed.data.length)
    return "No machine snapshot is available: read the receipts directly before deciding anything.";
  const week = utcDate(now - 6 * DAY),
    fortnight = utcDate(now - 13 * DAY),
    tomorrow = utcDate(now + DAY);
  return parsed.data
    .map((m) => {
      const f = m.friction,
        when = new Date(m.observedAt).toISOString();
      if (!f) return `- ${m.host} (snapshot ${when}): no friction totals; its collector predates them.`;
      if (f.state !== "ok")
        return `- ${m.host} (snapshot ${when}): ${versionLine(f)}. Friction unavailable: ${f.message}`;
      return `- ${m.host} (snapshot ${when}): ${versionLine(f)}. Last 7 days: ${windowLine(f.days, week, tomorrow)}. The 7 days before: ${windowLine(f.days, fortnight, week)}.`;
    })
    .join("\n");
}
export function upkeepInstructions(o: {
  activity: unknown;
  host: string;
  stateDir: string;
  frictionDir?: string;
  projects: ProjectDirectory[];
  configRepo?: string;
  workRepo?: string;
  run: { workIssue: number | null };
  person?: Person;
  now?: number;
}) {
  const owner = who(o.person);
  const registered =
    o.configRepo && o.projects.find((p) => p.repo?.toLowerCase() === o.configRepo!.toLowerCase());
  const configuration = !o.configRepo
    ? "No configuration repository is named on this machine (configRepo in machine.json), so the shared rules, skills and hooks are out of reach this cycle: say so when a change needs them."
    : registered
      ? `The shared configuration repository is ${o.configRepo}, registered here as project ${registered.id}: dispatch change children into that project for the shared rules, skills, hooks and repository templates. Its own instructions say how it is checked and how it syncs to each machine.`
      : `The shared configuration repository is ${o.configRepo}, but it is not registered as a project on this machine, so a change to it cannot be dispatched here until it is (a .project-overview.json in its checkout under the machine's root, or an entry under projects in machine.json): report such a change as blocked, saying what it would be.`;
  const issue = o.run.workIssue
    ? `The standing upkeep issue is #${o.run.workIssue}${o.workRepo ? ` in ${o.workRepo}` : ""}, linked to this conversation.`
    : `No standing upkeep issue is linked: the work items show no open issue labelled upkeep${o.workRepo ? ` in ${o.workRepo}` : ""}. ${
        o.workRepo
          ? "Before recording anything, have a change child create it there (an issue labelled work and upkeep, titled for agent upkeep, creating the upkeep label when the repository lacks it) and record this cycle in it; later cycles are linked to it."
          : "Without a work repository on this machine (workRepo in machine.json) nothing can be recorded: report that as blocked."
      }`;
  const receipts = `On this machine (${o.host}) each native session has one receipt under ${o.frictionDir ?? "the collector's friction directory beside the runner state"}: counts by category, the app version, client, folder, and first and last activity, never transcript text. The runner's journals and Jev run-check receipts are under ${o.stateDir}. \`npm run friction -- --since 7d --top 10\` in a checkout of the Projects repository prints this machine's per-day totals and the sessions with the most friction, with the conversation and helper of those Projects ran. Your own session may not run commands: dispatch a read child for that detail. Another machine's receipts sit at the same paths under its own home folder: a child reads them over SSH, read-only, with the login this machine already has (never adding keys or changing SSH configuration), or copies the receipt and runner-state folders and points the report at them with --dir and --state. Read and copy counts only: never transcripts, credentials or anything else on that machine.`;
  return `This is Projects' upkeep lane: a weekly cycle that keeps the agent setup improving from evidence, under the rules below. The agent setup is the shared global rules, skills, hooks and repository templates in the configuration repository, each repository's AGENTS.md, and the runner's own prompts and flags in the Projects repository (runner/master-instructions.ts, runner/instructions.ts, runner/upkeep-instructions.ts, the flags in runner/native.ts and hooks/work-item.ts). Nothing here invents progress: the usual result of a cycle is that no change is needed.

Evidence from the latest snapshots. Each machine counts friction in its native Claude Code and Codex sessions by fixed rules: a count is what the transcripts show, not a verdict (a failed command can be a test that correctly failed).
${upkeepEvidence(o.activity, o.now)}

Where the receipts are. ${receipts}

The record. ${issue} It holds every upkeep change with the measure it should move, the before measure and the after measure, and the harness versions reviewed each cycle; there is no second backlog. Record this cycle's result there and account for it in workRecord.

The configuration repository. ${configuration} Machine-local settings (machine.json, service jobs, keychains) and credentials are out of scope; nothing touches them.

Rules:
1. Evidence first. A pattern counts when it appears in at least three sessions over at least two days, or when any category stopped a turn (a hand-back, a stuck or overrun turn, a limit reached). Anything less is noted, not fixed.
2. A standing issue with no recorded baseline makes this a baseline cycle: record the measures above (the seven-day totals per machine and app, and the versions) in the issue and change nothing else.
3. One change per cycle, the smallest that removes the cause: prefer a hook, a test, a skill step or a runner prompt or flag over more instruction prose. A repository AGENTS.md stays under 40 lines.
4. Every change names the measure it should move and ships with a guard that keeps it moved: an instructions test, a hook check, the configuration repository's own check, or a friction category the next cycle compares.
5. Delivery follows each repository's own gates and the deploy skill, then the configuration repository's sync on every connected machine, with the before measure recorded in the standing issue before the change lands. The next cycle records the after measure and revises or reverts a change whose measure did not move.
6. Hooks, skills, tests and runner prompts and flags deliver under ${whose(o.person)} standing approval. An edit to the shared global rules or to any repository AGENTS.md ends as blocked: the child opens the pull request and stops, and you return blocked with its link and the measure, so ${owner}'s move is to review and merge it.
7. "No change needed" is a complete result: one line, no move for ${owner}, with the versions reviewed recorded in the standing issue.`;
}

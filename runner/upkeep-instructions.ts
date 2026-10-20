// The upkeep lane's brief (docs/upkeep.md): what the master is given each
// cycle to keep the agent setup improving from evidence. Friction receipts
// stay on each machine; the brief carries their totals and the harness
// versions from the latest snapshots, says where the receipts are, names the
// standing work issue and the configuration repository, sets up the harness
// research against the versions last reviewed, compares each recorded change
// with its before measure (runner/upkeep-changes.ts), and states the rules.
import { z } from "zod";
import {
  frictionLine,
  frictionSnapshotSchema,
  frictionTotals,
  newer,
  utcDate,
  type FrictionApp,
  type FrictionDay,
  type FrictionSnapshot,
} from "../src/friction-model";
import { reviewedLine, UPKEEP_SOURCES, type ReviewedVersions, type UpkeepChange } from "../src/upkeep-model";
import { changesStatus } from "./upkeep-changes";
import { readIssueCache } from "../collector/work";
import { frictionDirectory } from "../collector/friction-store";
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
const machinesOf = (activity: unknown) => {
  const parsed = observationSchema.safeParse(activity);
  return parsed.success ? parsed.data : [];
};
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
// One line per machine: its versions, the last seven days and the seven
// before; then, with two or more machines' totals, the same added together.
export function upkeepEvidence(activity: unknown, now = Date.now()) {
  const machines = machinesOf(activity);
  if (!machines.length)
    return "No machine snapshot is available: read the receipts directly before deciding anything.";
  const week = utcDate(now - 6 * DAY),
    fortnight = utcDate(now - 13 * DAY),
    tomorrow = utcDate(now + DAY);
  const counted = machines.filter((m) => m.friction?.state === "ok"),
    days = counted.flatMap((m) => m.friction!.days);
  const all =
    counted.length > 1
      ? [`- all machines (${counted.map((m) => m.host).join(", ")}): Last 7 days: ${windowLine(days, week, tomorrow)}. The 7 days before: ${windowLine(days, fortnight, week)}.`]
      : [];
  return machines
    .map((m) => {
      const f = m.friction,
        when = new Date(m.observedAt).toISOString();
      if (!f) return `- ${m.host} (snapshot ${when}): no friction totals; its collector predates them.`;
      if (f.state !== "ok")
        return `- ${m.host} (snapshot ${when}): ${versionLine(f)}. Friction unavailable: ${f.message}`;
      return `- ${m.host} (snapshot ${when}): ${versionLine(f)}. Last 7 days: ${windowLine(f.days, week, tomorrow)}. The 7 days before: ${windowLine(f.days, fortnight, week)}.`;
    })
    .concat(all)
    .join("\n");
}
// The versions the standing issue says the research last reviewed, and its
// record of changes, as this machine's work item cache has them (the
// collector refreshes it each scan): null when the cache cannot be read,
// versions null when the issue records none, changes undefined when the
// cache does not hold the issue's record.
export type StandingReview = {
  versions: ReviewedVersions | null;
  changes?: UpkeepChange[] | null;
  refreshedAt: number;
};
export async function standingReview(home: string, issue: number | null): Promise<StandingReview | null> {
  try {
    const cache = await readIssueCache(home);
    const found = cache.issues.find((i) => i.number === issue);
    return {
      versions: found?.reviewed ?? null,
      changes: issue === null ? [] : found?.changes,
      refreshedAt: cache.refreshedAt,
    };
  } catch {
    return null;
  }
}
// What the research compares: each app's newest installed version across the
// machines against the version last reviewed, and what the read child reads.
export function researchStatus(activity: unknown, review: StandingReview | null | undefined, now = Date.now()) {
  const machines = machinesOf(activity);
  const top = (pick: (f: FrictionSnapshot) => string | undefined) =>
    machines
      .map((m) => m.friction && pick(m.friction))
      .reduce<string | undefined>((best, v) => (v && (!best || newer(v, best)) ? v : best), undefined);
  const available = top((f) => f.versions.codexLatest);
  const on = review?.versions?.on ? ` on ${review.versions.on}` : "";
  const lines = (["claude", "codex"] as const).map((app) => {
    const name = app === "claude" ? "Claude Code" : "Codex";
    const installed = top((f) => f.versions[app]),
      reviewed = review?.versions?.[app];
    const release =
      app === "codex" && installed && available && newer(available, installed)
        ? ` (${available} is released and installed nowhere; installing it is machine-local, not a cycle's change)`
        : "";
    if (!installed)
      return `${name}: no installed version in the snapshots${reviewed ? `, last reviewed ${reviewed}${on}` : ""}: nothing to read.`;
    if (!reviewed) return `${name}: ${installed} installed${release}, no review recorded: read the entries of the last 30 days.`;
    if (newer(installed, reviewed))
      return `${name}: ${installed} installed${release}, last reviewed ${reviewed}${on}: read the entries after ${reviewed}.`;
    return `${name}: ${installed} installed${release}, reviewed${on}: nothing new to read.`;
  });
  const cache = !review
    ? " The versions last reviewed could not be read from this machine's work item cache, so every installed version counts as unreviewed."
    : now - review.refreshedAt > DAY
      ? ` This machine's work item cache was last refreshed ${Math.floor((now - review.refreshedAt) / DAY)} days ago, so a newer review may be missing.`
      : "";
  return lines.join(" ") + cache;
}
// The brief from an engine's options: the receipts and the work item cache
// are under the machine's home folder.
export async function upkeepBrief(o: Omit<Parameters<typeof upkeepInstructions>[0], "frictionDir" | "reviewed"> & { home?: string }) {
  return upkeepInstructions({
    ...o,
    frictionDir: o.home ? frictionDirectory(o.home) : undefined,
    reviewed: o.home ? await standingReview(o.home, o.run.workIssue) : null,
  });
}
const sourceList = (app: string) =>
  UPKEEP_SOURCES.filter((s) => s.app === app).map((s) => `${s.topic} ${s.url}`).join(", ");
// The only places the research reads, as the brief lists them.
export const researchSources = () => `Claude Code: ${sourceList("Claude Code")}. Codex: ${sourceList("Codex")}.`;
export function upkeepInstructions(o: {
  activity: unknown;
  host: string;
  stateDir: string;
  frictionDir?: string;
  projects: ProjectDirectory[];
  configRepo?: string;
  workRepo?: string;
  run: { workIssue: number | null };
  reviewed?: StandingReview | null;
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
  const research = `Harness research. ${researchStatus(o.activity, o.reviewed, o.now)} Each cycle dispatches one read child on Claude for the research: Projects gives an upkeep read child on Claude the web for the sources below (its fetch rules allow their hosts; it is told to read nothing else), and gives it to no other child. Send it into the registered project that holds the runner when there is one, so it can read the flags and prompts it compares against, otherwise into the configuration repository. Its task: read each app's changelog entries newer than the reviewed version, as above; for each capability those entries name that bears on how the runner drives the app (the flags in runner/native.ts, the prompts in runner/instructions.ts and runner/master-instructions.ts) or on the shared rules and skills, read the documentation page below for its topic and return one proposal in exactly this shape, every line present:
Proposal: <the capability>, <app> <version that added it>
Source: <the listed source it was read on, as a link>
Applies to: <the runner flag, runner prompt, shared rule, skill or hook it bears on>
Replaces: <the workaround or measured friction category it would remove, or none>
Guard: <the test or check that would keep it adopted>
A child that finds nothing returns "Nothing to adopt" with the versions it reviewed. Anything read outside these sources is not evidence; a source that has moved or does not answer is reported as such, never replaced by another site.
Sources. ${researchSources()}`;
  return `This is Projects' upkeep lane: a weekly cycle that keeps the agent setup improving from evidence, under the rules below. The agent setup is the shared global rules, skills, hooks and repository templates in the configuration repository, each repository's AGENTS.md, and the runner's own prompts and flags in the Projects repository (runner/master-instructions.ts, runner/instructions.ts, runner/upkeep-instructions.ts, the flags in runner/native.ts and hooks/work-item.ts). Nothing here invents progress: the usual result of a cycle is that no change is needed.

Evidence from the latest snapshots. Each machine counts friction in its native Claude Code and Codex sessions by fixed rules: a count is what the transcripts show, not a verdict (a failed command can be a test that correctly failed).
${upkeepEvidence(o.activity, o.now)}

Where the receipts are. ${receipts}

The record. ${issue} It holds every upkeep change with the measure it should move, the before measure and the after measure, and the harness versions reviewed each cycle; there is no second backlog. Record this cycle's result there and account for it in workRecord.

Closing the loop. ${changesStatus(machinesOf(o.activity), o.reviewed, o.now)}

The configuration repository. ${configuration} Machine-local settings (machine.json, service jobs, keychains) and credentials are out of scope; nothing touches them.

${research}

Rules:
1. Evidence first. A pattern counts when it appears in at least three sessions over at least two days, or when any category stopped a turn (a hand-back, a stuck or overrun turn, a limit reached). Anything less is noted, not fixed.
2. A standing issue with no recorded baseline makes this a baseline cycle: record the measures above (the seven-day totals per machine and app, and the versions) in the issue and change nothing else.
3. One change per cycle, the smallest that removes the cause: prefer a hook, a test, a skill step or a runner prompt or flag over more instruction prose. A repository AGENTS.md stays under 40 lines.
4. Every change names the measure it should move and ships with a guard that keeps it moved: an instructions test, a hook check, the configuration repository's own check, or a friction category the next cycle compares.
5. Delivery follows each repository's own gates and the deploy skill, then the configuration repository's sync on every connected machine, with the before measure recorded in the standing issue before the change lands. The next cycle records the after measure and revises or reverts a change whose measure did not move.
6. Hooks, skills, tests and runner prompts and flags deliver under ${whose(o.person)} standing approval. An edit to the shared global rules or to any repository AGENTS.md ends as blocked: the child opens the pull request and stops, and you return blocked with its link and the measure, so ${owner}'s move is to review and merge it.
7. "No change needed" is a complete result: one line, no move for ${owner}, with the versions reviewed recorded in the standing issue.
8. Harness research runs every cycle as above: one read child on Claude, the listed sources only, proposals in the fixed shape or nothing to adopt. Without Claude on this machine the research is not run: say so in the result.
9. Proposals are not instructions. Adopt one only when it removes a workaround in the runner's prompts or flags or closes a friction gap measured above, naming which; it is then the cycle's one change, or a second change when the first is a friction fix, delivered under rules 3 to 6. In a baseline cycle proposals are recorded in the standing issue for the next cycle and nothing is adopted. Adopted or not, the cycle records the versions reviewed: the change child that records the cycle sets the line "${reviewedLine({ claude: "<version>", codex: "<version>" }, "YYYY-MM-DD")}" under a "## Upkeep" heading in the standing issue's body, naming the newest installed version of each app, after re-reading the body and keeping everything else in it; the next cycle's research starts from that line.
10. A friction measure moved when it fell: over a window of as many days as its before measure, ending today and wholly after the day the change landed, the count per session is at least a quarter lower than before and at least three below what the before rate predicts for the window's sessions. Short of either margin, or higher, it did not move. A window that still holds the day the change landed, or has fewer sessions than the comparison needs (at least three, and enough for the before rate to predict three), is not yet measurable: the change stays watching and is never counted as not moved. A guard measure moved when a read child finds the guard in place and passing on the default branch.
11. A change whose measure did not move is revised once or reverted. A revision is the cycle's one change, a new row naming the change it revises, which becomes revised when the revision lands; a revision whose measure does not move is reverted, and the change it revised with it. A revert goes through the same delivery path as a change, under rules 5 and 6, without counting as the cycle's one change: its row names the revert's pull request as soon as it is open, and becomes reverted once it lands.
12. A change whose measure moved is kept: its row gets the after measure and the state kept, and its guard stays in place, named in the record; a later change removes that guard only as a recorded revision or revert of it.
13. The guard fits the change: in the Projects repository a runner prompt gets an instructions test beside it (runner/instructions.test.ts, runner/master-instructions.test.ts or runner/upkeep-instructions.test.ts) and a runner flag a test in runner/native.test.ts; a hook gets its own check in the repository that holds it; a shared rule or skill gets the configuration repository's own check; anything else gets a friction category the next cycle compares. Name that guard when you dispatch the change child; its row names the guard it added.
14. The cycle's change child keeps the record, after re-reading the body and keeping everything else in it: a new change's row goes in as waiting, with its pull request link and before measure, before the change lands, and becomes watching, dated the day it landed, once its delivery is verified; a change that ends blocked for review stays waiting until its pull request merges; each compared change gets its after measure and state as above.`;
}

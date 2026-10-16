import { inboxSchema } from "./inbox-model";
import { workSnapshotSchema, type Close } from "./work-model";
import { z } from "zod";
import { machineIdSchema } from "./telemetry";
export { machineIdSchema };
const text = z.string().max(500);
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_.:/-]+$/)
  .max(220);
const time = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
export const sourceSchema = z
  .object({
    state: z.enum(["ok", "unavailable", "unsupported"]),
    message: text,
    observedAt: time,
  })
  .strict();
// Provider-reported subscription limits: never inferred from session tokens.
export const quotaSchema = z.discriminatedUnion("state", [
  z.object({state: z.literal("ok"), observedAt: time, weekly: z.object({usedPercent: z.number().min(0).max(100), resetsAt: time}).strict()}).strict(),
  z.object({state: z.enum(["unavailable", "unsupported"]), observedAt: time}).strict(),
]);
export type Quota = z.infer<typeof quotaSchema>;
export const sessionSchema = z
  .object({
    id,
    title: text,
    app: z.enum(["Codex", "Claude"]),
    cwd: z.string().max(1000),
    updatedAt: time,
    state: z.enum(["running", "waiting", "idle", "open", "unknown"]),
    evidence: text,
  })
  .strict();
export const worktreeSchema = z
  .object({
    path: z.string().max(1000),
    branch: text,
    changed: count,
    conflicts: count,
    ahead: count.nullable(),
    behind: count.nullable(),
    // Commits only this machine holds (on no remote branch, never landed on main).
    // Null: no remote or unknown. Absent in snapshots from older collectors.
    unpushed: count.nullable().optional(),
    isPrimary: z.boolean(),
    error: text.nullable(),
    // Git still lists it, but its folder is confirmed gone. Unpushed counts
    // its last commit; without that count (older collectors) push is unknown.
    prunable: z.literal(true).optional(),
  })
  .strict();
export const pullSchema = z
  .object({
    number: count,
    title: text,
    url: z.url().refine((x) => new URL(x).hostname === "github.com"),
    branch: text,
    draft: z.boolean(),
    workIssues: z.array(z.number().int().positive()).max(100).optional(),
    checks: z.enum(["passing", "pending", "failing", "none"]),
    updatedAt: time,
  })
  .strict();
export const projectSchema = z
  .object({
    id,
    name: text,
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    description: text,
    progress: z
      .object({
        summary: text,
        next: z.array(text).max(3),
        completed: count,
        total: count,
        source: text,
        updatedAt: time.nullable(),
      })
      .strict(),
    latestMerge: z
      .object({
        title: text,
        url: z.url().refine((x) => new URL(x).hostname === "github.com"),
        mergedAt: time,
      })
      .strict()
      .nullable(),
    worktrees: z.array(worktreeSchema).max(500),
    sessions: z.array(sessionSchema).max(500),
    pulls: z.array(pullSchema).max(100),
    sources: z
      .object({
        git: sourceSchema,
        github: sourceSchema,
        codex: sourceSchema,
        claude: sourceSchema,
        // Older collectors also send a placeholder for an app nothing reads;
        // it is accepted so their snapshots still publish, and never shown.
        grok: sourceSchema.optional(),
      })
      .strict(),
  })
  .strict();
export const snapshotSchema = z
  .object({
    version: z.literal(1),
    host: id,
    collectedAt: time,
    projects: z.array(projectSchema).max(100),
    unassignedSessions: z.array(sessionSchema).max(2000),
    work: workSnapshotSchema.optional(),
    inbox: inboxSchema.optional(),
    quotas: z.object({codex: quotaSchema, claude: quotaSchema}).strict().optional(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Worktree = z.infer<typeof worktreeSchema>;
// A machine the owner connected, in preference order. The first one heard
// from recently takes the shared duties and new conversations.
export type MachineView = {
  id: string;
  name: string;
  position: number;
  lastCollected: number | null;
  lastRunner: number | null;
  duties: boolean;
  newWork: boolean;
};
export type PortfolioView = {
  archives?: import("./archive-model").ArchiveEntry[];
  snapshots: Snapshot[];
  closes: Close[];
  inboxActions?: import("./inbox-model").InboxAction[];
  machines?: MachineView[];
  // The deployment's time zone, for what "today" means.
  serverTime: number;
};
export const STALE_AFTER = 5 * 60_000;
export function freshness(at: number, now = Date.now()) {
  return now - at > STALE_AFTER || at > now + 60_000;
}
// Machines can share a subscription. Select one observation; never add them.
// A failed newest read is shown as unavailable rather than hiding it with an
// older successful value. The source machine remains visible in the UI.
export function currentQuota(snapshots: Snapshot[], provider: "codex" | "claude") {
  return snapshots.flatMap((s) => s.quotas ? [{host: s.host, ...s.quotas[provider]}] : [])
    .sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
}
function worktreeFor(cwd: string, worktrees: Worktree[]) {
  return worktrees
    .filter((w) => cwd === w.path || cwd.startsWith(w.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
export const IN_PROGRESS_HOURS = 24;
// Checkouts someone is working in: a session whose folder is inside the
// worktree and that is mid-turn or moved within IN_PROGRESS_HOURS. An open
// Claude process or unarchived Codex task with older activity is not evidence
// of work, and neither is anything in a stale observation (at = when observed).
export function attended(project: Project, at: number, now = Date.now()) {
  const paths = new Set<string>();
  if (freshness(at, now)) return paths;
  for (const s of project.sessions) {
    const age = now - s.updatedAt;
    const live = s.state === "running" || s.state === "waiting";
    const recent = age < IN_PROGRESS_HOURS * 3600_000 && age > -60_000;
    const w = live || recent ? worktreeFor(s.cwd, project.worktrees) : null;
    if (w) paths.add(w.path);
  }
  return paths;
}
// Commits that exist only on this machine; older snapshots fall back to the count
// ahead of upstream. Null means the push state is unknown, never clean.
export const pushPending = (w: Worktree) =>
  w.unpushed === undefined ? w.ahead : w.unpushed;
const unsaved = (w: Worktree) =>
  w.changed > 0 || (pushPending(w) ?? 0) > 0;
// Unreadable or conflicting state always needs a look; uncommitted or unpushed
// work does when no session is attending it, because that is abandoned work.
function checkoutConcern(w: Worktree, active: Set<string>) {
  return Boolean(w.error || w.conflicts || (unsaved(w) && !active.has(w.path)));
}
// A failing draft is still being written; a failing ready PR needs you.
export function pullConcern(pull: Project["pulls"][number]) {
  return pull.checks === "failing" && !pull.draft;
}
export type Health = { concerns: string[]; inProgress: string[] };
// What needs you versus what is visibly being worked on, for one observation.
// In-progress work is reported, never dropped: it must not read as clean.
export function health(project: Project, at: number, now = Date.now()): Health {
  const concerns: string[] = [];
  const inProgress: string[] = [];
  const active = attended(project, at, now);
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const split = (list: Worktree[], one: string, many: string) => {
    const worked = list.filter((w) => active.has(w.path)).length;
    if (list.length > worked)
      concerns.push(
        `${count(list.length - worked, one, many)}, no recent session`,
      );
    if (worked)
      inProgress.push(`${count(worked, one, many)} in a recent session`);
  };
  const conflicts = project.worktrees.reduce((n, x) => n + x.conflicts, 0);
  if (conflicts)
    concerns.push(count(conflicts, "merge conflict", "merge conflicts"));
  split(
    project.worktrees.filter((x) => x.changed > 0),
    "checkout with changes",
    "checkouts with changes",
  );
  split(
    project.worktrees.filter((x) => (pushPending(x) ?? 0) > 0),
    "checkout with unpushed commits",
    "checkouts with unpushed commits",
  );
  const failing = project.pulls.filter((x) => x.checks === "failing");
  const ready = failing.filter(pullConcern).length;
  if (ready)
    concerns.push(
      count(ready, "PR with failed checks", "PRs with failed checks"),
    );
  if (failing.length > ready)
    inProgress.push(
      count(
        failing.length - ready,
        "draft PR with failed checks",
        "draft PRs with failed checks",
      ),
    );
  if (project.worktrees.some((x) => x.error))
    concerns.push("Some checkouts could not be read");
  if (project.sources.git.state !== "ok") concerns.push("Git unavailable");
  if (project.sources.github.state !== "ok")
    concerns.push("GitHub unavailable");
  return { concerns, inProgress };
}
export const RECENT_DAYS = 7;
export type Observation = { project: Project; host: string; at: number };
export type Thread = {
  key: string;
  host: string;
  kind: "session" | "checkout" | "pull";
  title: string;
  detail: string;
  at: number;
  tone: "good" | "quiet" | "warning";
  href?: string;
};
// Machine names from the latest overview; an unknown machine shows its id.
const machineNames = new Map<string, string>();
export function setMachineNames(machines: Pick<MachineView, "id" | "name">[]) {
  machineNames.clear();
  for (const machine of machines) machineNames.set(machine.id, machine.name);
}
export function hostName(host: string) {
  return machineNames.get(host) ?? host;
}
// How to reopen a session in its own app, on the machine it lives on. The command
// is pasted into a shell, so only a plain identifier gets one. The ChatGPT
// desktop app handles codex://threads links; Claude has no link to an
// existing session.
export function restart(app: Session["app"], id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(id)) return null;
  return app === "Codex"
    ? { command: `codex resume ${id}`, link: `codex://threads/${id}` }
    : { command: `claude --resume ${id}`, link: null };
}
function branchFor(cwd: string, worktrees: Worktree[]) {
  const match = worktreeFor(cwd, worktrees);
  return match ? (match.isPrimary ? "main checkout" : match.branch) : "";
}
// Every place work physically exists: a live or recent session, a checkout
// with uncommitted or unpushed changes, or an open pull request.
export function threads(
  observations: Observation[],
  github: Observation | undefined,
  now = Date.now(),
): Thread[] {
  const out: Thread[] = [];
  for (const o of observations) {
    const stale = freshness(o.at, now);
    for (const s of o.project.sessions) {
      if (now - s.updatedAt > RECENT_DAYS * 86400_000) continue;
      const branch = branchFor(s.cwd, o.project.worktrees);
      out.push({
        key: `${o.host}:session:${s.app}:${s.id}`,
        host: o.host,
        kind: "session",
        title: s.title,
        detail: `${s.app} on ${hostName(o.host)}${branch ? ` · ${branch}` : ""} · ${stale ? "last known " : ""}${s.state}`,
        at: s.updatedAt,
        tone: stale ? "warning" : s.state === "running" ? "good" : "quiet",
      });
    }
    const active = attended(o.project, o.at, now);
    for (const w of o.project.worktrees) {
      if (!unsaved(w) && !w.error) continue;
      const parts = [
        w.error,
        w.prunable ? "folder removed" : "",
        w.changed ? `${w.changed} changed` : "",
        pushPending(w) ? `${pushPending(w)} unpushed` : "",
        unsaved(w) && !active.has(w.path) ? "no recent session" : "",
      ].filter(Boolean);
      out.push({
        key: `${o.host}:checkout:${w.path}`,
        host: o.host,
        kind: "checkout",
        title: w.isPrimary ? "Main checkout" : w.branch,
        detail: `Checkout on ${hostName(o.host)} · ${parts.join(" · ")}`,
        at: o.at,
        tone: checkoutConcern(w, active) ? "warning" : "quiet",
      });
    }
  }
  for (const pr of github?.project.pulls ?? [])
    out.push({
      key: `pull:${pr.number}`,
      host: github!.host,
      kind: "pull",
      title: `#${pr.number} ${pr.title}`,
      detail: `Pull request · ${pr.branch} · ${pr.draft ? "draft · " : ""}${pr.checks === "none" ? "no checks" : `checks ${pr.checks}`}`,
      at: pr.updatedAt,
      tone: pullConcern(pr) ? "warning" : "quiet",
      href: pr.url,
    });
  // Sessions first (that is where the owner continues), newest first within a kind.
  const order = { session: 0, pull: 1, checkout: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || b.at - a.at);
}
// Ranking uses when work last moved (a session or PR), not when a changed
// checkout happened to be observed; any thread at all still counts as active.
export function lastActivity(list: Thread[]) {
  const moved = list
    .filter((t) => t.kind !== "checkout")
    .reduce((m, t) => Math.max(m, t.at), 0);
  return moved || (list.length ? 1 : 0);
}
export const WORKTREE_CLUTTER = 10;
export function clutter(observations: Observation[]) {
  return observations
    .map((o) => ({
      host: o.host,
      count: o.project.worktrees.filter((w) => !w.isPrimary && !w.prunable)
        .length,
    }))
    .filter((x) => x.count >= WORKTREE_CLUTTER);
}
// GitHub is repository-wide: the freshest successful observation speaks for it.
export function currentGithub(observations: Observation[], now = Date.now()) {
  return observations
    .filter(
      (o) =>
        o.project.sources.github.state === "ok" &&
        !freshness(o.project.sources.github.observedAt, now),
    )
    .sort(
      (a, b) =>
        b.project.sources.github.observedAt -
        a.project.sources.github.observedAt,
    )[0];
}
export type ProjectHealth = Health & {
  verdict: "stale" | "attention" | "progress" | "clean";
};
// One project across every machine. An overdue update outranks everything, a
// concern outranks work in progress, and only a project with neither is clean.
export function projectHealth(
  observations: Observation[],
  now = Date.now(),
): ProjectHealth {
  const github = currentGithub(observations, now);
  const seen = observations.map((o) =>
    health(
      {
        ...o.project,
        pulls: o === github ? o.project.pulls : [],
        sources: {
          ...o.project.sources,
          github: { ...o.project.sources.github, state: "ok" },
        },
      },
      o.at,
      now,
    ),
  );
  const concerns = seen.flatMap((h) => h.concerns);
  if (!github) concerns.push("GitHub unavailable");
  for (const c of clutter(observations))
    concerns.push(
      `${c.count} worktrees on ${hostName(c.host)}; review inactive checkouts`,
    );
  const inProgress = seen.flatMap((h) => h.inProgress);
  return {
    verdict: observations.some((o) => freshness(o.at, now))
      ? "stale"
      : concerns.length
        ? "attention"
        : inProgress.length
          ? "progress"
          : "clean",
    concerns: [...new Set(concerns)],
    inProgress: [...new Set(inProgress)],
  };
}
export function ago(at: number | null, now = Date.now()) {
  if (at === null) return "Unknown";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
export type HostProblem = {
  project: string;
  checkout: string;
  path: string;
  note: string;
  tone: "warning" | "quiet";
};
export type HostHealth = {
  host: string;
  at: number;
  stale: boolean;
  repos: number;
  worktrees: number;
  extra: number;
  changed: number;
  conflicts: number;
  unpushed: number;
  unverified: number;
  behind: number;
  errors: number;
  active: number;
  verdict: "clean" | "unverified" | "progress" | "cleanup" | "stale";
  problems: HostProblem[];
};
// Is this machine clean? Only a fresh snapshot with nothing uncommitted, unpushed,
// conflicting, cluttered or unreadable qualifies. A checkout whose push state
// is unknown stays unverified rather than assumed clean. Work a
// session is attending is in progress: not clean, but not cleanup either.
export function hostHealth(snapshot: Snapshot, now = Date.now()): HostHealth {
  const h: HostHealth = {
    host: snapshot.host,
    at: snapshot.collectedAt,
    stale: freshness(snapshot.collectedAt, now),
    repos: snapshot.projects.length,
    worktrees: 0,
    extra: 0,
    changed: 0,
    conflicts: 0,
    unpushed: 0,
    unverified: 0,
    behind: 0,
    errors: 0,
    active: 0,
    verdict: "clean",
    problems: [],
  };
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  for (const p of snapshot.projects) {
    if (p.sources.git.state !== "ok" && !p.worktrees.some((w) => w.error)) {
      h.errors++;
      h.problems.push({
        project: p.name,
        checkout: "repository",
        path: "",
        note: p.sources.git.message,
        tone: "warning",
      });
    }
    const extra = p.worktrees.filter((w) => !w.isPrimary && !w.prunable).length;
    h.worktrees += p.worktrees.length;
    h.extra += extra;
    if (extra >= WORKTREE_CLUTTER)
      h.problems.push({
        project: p.name,
        checkout: `${extra} extra worktrees`,
        path: "",
        note: "Review inactive worktrees; verify contents and merged commits before removal",
        tone: "warning",
      });
    const active = attended(p, snapshot.collectedAt, now);
    for (const w of p.worktrees) {
      const pending = pushPending(w);
      // The folder is gone and nothing on its commit is left to push, so only
      // Git's record remains. Otherwise pruning could drop a detached commit.
      if (w.prunable && pending === 0) {
        h.problems.push({
          project: p.name,
          checkout: w.branch,
          path: w.path,
          note: "Folder removed; Git still lists it until git worktree prune",
          tone: "quiet",
        });
        continue;
      }
      const notes: string[] = w.prunable ? ["Folder removed"] : [];
      if (w.error) {
        h.errors++;
        notes.push(w.error);
      }
      if (w.conflicts) {
        h.conflicts += w.conflicts;
        notes.push(plural(w.conflicts, "conflict"));
      }
      if (w.changed) {
        h.changed++;
        notes.push(`${w.changed} uncommitted`);
      }
      if (pending) {
        h.unpushed++;
        notes.push(`${pending} unpushed`);
      } else if (pending === null && !w.error) {
        h.unverified++;
        notes.push("push state unknown");
      }
      if (w.behind) {
        h.behind++;
        notes.push(`${w.behind} behind`);
      }
      if (unsaved(w) && active.has(w.path)) {
        h.active++;
        notes.push("recent session");
      }
      if (notes.length)
        h.problems.push({
          project: p.name,
          checkout: w.isPrimary ? "main checkout" : w.branch,
          path: w.path,
          note: notes.join(" · "),
          tone: checkoutConcern(w, active) ? "warning" : "quiet",
        });
    }
  }
  h.problems.sort((a, b) =>
    a.tone === b.tone ? 0 : a.tone === "warning" ? -1 : 1,
  );
  h.verdict = h.stale
    ? "stale"
    : h.problems.some((p) => p.tone === "warning")
      ? "cleanup"
      : h.active
        ? "progress"
        : h.unverified
          ? "unverified"
          : "clean";
  return h;
}

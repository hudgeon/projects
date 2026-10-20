import { readQuotas } from "./quotas";
import { readWork } from "./work";
import { readdir, readFile, stat, lstat, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  Project,
  Snapshot,
  Session,
  Source,
  Worktree,
} from "../src/model";
import { githubToken } from "./github";
import { command, subprocessEnv } from "./command";
import { inboxLogins, type Config } from "./config";
import { readInboxes } from "./inbox-logins";
export type { Config } from "./config";
export { command, machineSecret, subprocessEnv } from "./command";

const metadataSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_.:/-]+$/)
      .max(200)
      .optional(),
    name: z.string().min(1).max(200).optional(),
    plan: z
      .string()
      .max(1000)
      .refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."))
      .optional(),
  })
  .strict();
type Item = {
  directory: string;
  name: string;
  plan?: string;
  id?: string;
  repo?: string;
};
// Repository-local metadata travels with a rename/move and is reviewable by
// the native coding apps. The overview is not another writer of project plans.
export async function discover(config: Config): Promise<Item[]> {
  const found: Item[] = [],
    seen = new Set<string>();
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (config.exclude.some((p) => belongs(dir, path.resolve(config.root, p))))
      return;
    if (++visited > 2000)
      throw new Error("Discovery exceeds 2,000 directories");
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === ".git")) {
      const common = await command(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        dir,
      );
      if (seen.has(common)) return;
      seen.add(common);
      const directory = path.relative(config.root, dir);
      let remote = "";
      try {
        remote = await command("git", ["remote", "get-url", "origin"], dir);
      } catch {
        /* Local-only repositories need explicit metadata. */
      }
      const repo = remote
        .match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1]
        ?.toLowerCase();
      const configured = repo ? config.projects[repo] : undefined;
      const raw = entries.some((e) => e.name === ".project-overview.json")
        ? await readFile(path.join(dir, ".project-overview.json"), "utf8")
        : null;
      if (raw && raw.length > 16_000)
        throw new Error("Project metadata too large");
      const metadata = raw ? metadataSchema.parse(JSON.parse(raw)) : {};
      if (!configured && !raw) return;
      found.push({
        directory,
        name: metadata.name ?? configured?.name ?? path.basename(dir),
        plan: metadata.plan ?? configured?.plan,
        id: metadata.id,
        repo,
      });
      if (found.length > 100)
        throw new Error("Discovery exceeds 100 repositories");
      return;
    }
    if (depth >= 3) {
      if (entries.some((e) => e.isDirectory() && !e.name.startsWith(".")))
        throw new Error(
          `Repository discovery nesting exceeds three levels at ${dir}`,
        );
      return;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !["node_modules", "dist", "build", "vendor"].includes(entry.name)
      )
        await walk(path.join(dir, entry.name), depth + 1);
  }
  await walk(config.root, 0);
  return found;
}
const source = (
  state: Source["state"],
  message: string,
  now: number,
): Source => ({ state, message, observedAt: now });

export function parseWorktrees(
  raw: string,
): { path: string; branch: string; head: string; prunable?: true }[] {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      return {
        path: lines.find((x) => x.startsWith("worktree "))?.slice(9) ?? "",
        branch:
          lines
            .find((x) => x.startsWith("branch "))
            ?.slice(7)
            .replace(/^refs\/heads\//, "") ?? "Detached HEAD",
        head: lines.find((x) => x.startsWith("HEAD "))?.slice(5) ?? "",
        // Git cannot find the folder: removed, or only out of reach.
        ...(lines.some((x) => x.startsWith("prunable"))
          ? { prunable: true as const }
          : {}),
      };
    })
    .filter((x) => x.path);
}
// Git calls a worktree prunable whenever it cannot see the folder, which also
// happens behind an unreadable parent or with its volume unmounted. The folder
// is gone only when it is missing from a parent folder that is present on the
// repository's own volume.
export async function folderRemoved(dir: string, repository: string) {
  try {
    await lstat(dir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    const [parent, repo] = await Promise.all([
      stat(path.dirname(dir)),
      stat(repository),
    ]);
    return parent.isDirectory() && parent.dev === repo.dev;
  } catch {
    return false;
  }
}
// Commits on rev (default HEAD) that no remote branch has and whose changes
// never reached origin/main: work only this machine holds. A squash-merged branch
// keeps its local commits, but every file version it changed appears in main's
// history, so nothing is left to push. Null when there is no remote to push to.
export async function unpushedCommits(
  cwd: string,
  rev = "HEAD",
): Promise<number | null> {
  if (!(await command("git", ["remote"], cwd))) return null;
  const local = (
    await command("git", ["rev-list", rev, "--not", "--remotes"], cwd)
  )
    .split("\n")
    .filter(Boolean).length;
  if (!local) return 0;
  let base: string;
  try {
    base = await command("git", ["merge-base", rev, "origin/main"], cwd);
  } catch {
    return local;
  }
  const files = (
    await command(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", "-z", base, rev],
      cwd,
    )
  )
    .split("\0")
    .filter(Boolean);
  if (!files.length) return 0;
  if (files.length > 200) return local;
  const head = new Map<string, string>();
  for (const entry of (
    await command(
      "git",
      ["--literal-pathspecs", "ls-tree", "-r", "-z", rev, "--", ...files],
      cwd,
    )
  ).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab > 0) head.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]);
  }
  // Every version of these files that main has held since the branch left it.
  const seen = new Set<string>();
  const raw = (
    await command(
      "git",
      [
        "--literal-pathspecs",
        "log",
        "--format=",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        `${base}..origin/main`,
        "--",
        ...files,
      ],
      cwd,
    )
  ).split("\0");
  for (let i = 0; i < raw.length - 1; i++) {
    const meta = raw[i].trim();
    if (!meta.startsWith(":")) continue;
    const blob = meta.split(" ")[3];
    seen.add(`${raw[++i]}\0${/^0+$/.test(blob) ? "deleted" : blob}`);
  }
  return files.every((file) => seen.has(`${file}\0${head.get(file) ?? "deleted"}`))
    ? 0
    : local;
}
export function parseStatus(raw: string) {
  const entries = raw.split("\0");
  let changed = 0,
    conflicts = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    changed++;
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) conflicts++;
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return { changed, conflicts };
}
export function parsePlan(raw: string) {
  const plain = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*`]/g, "")
      .replace(/^#+\s*/, "")
      .trim()
      .slice(0, 500);
  const completed = (raw.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
  const pending = raw.split("\n").filter((l) => /^\s*[-*]\s+\[ \]/.test(l));
  const status = raw
    .split("\n")
    .find((l) =>
      /^\s*(?:\*\*)?(?:status|current status|current phase|phase)\s*[:—]/i.test(
        l,
      ),
    );
  return {
    summary: status
      ? plain(status)
      : "Plan available; no explicit status recorded.",
    next: pending
      .slice(0, 3)
      .map((l) => plain(l.replace(/^\s*[-*]\s+\[ \]\s*/, ""))),
    completed,
    total: completed + pending.length,
  };
}
async function progress(
  root: string,
  plan?: string,
): Promise<Project["progress"]> {
  if (!plan)
    return {
      summary: "No canonical plan linked.",
      next: [],
      completed: 0,
      total: 0,
      source: "",
      updatedAt: null,
    };
  try {
    const p = path.resolve(root, plan);
    const s = await stat(p);
    if (s.size > 1_000_000) throw new Error("too large");
    return {
      ...parsePlan(await readFile(p, "utf8")),
      source: plan,
      updatedAt: Math.floor(s.mtimeMs),
    };
  } catch {
    return {
      summary: "Canonical plan could not be read.",
      next: [],
      completed: 0,
      total: 0,
      source: plan,
      updatedAt: null,
    };
  }
}

async function tail(file: string, max = 64_000) {
  const fh = await open(file, "r");
  try {
    const s = await fh.stat();
    const start = Math.max(0, s.size - max);
    const b = Buffer.alloc(Math.min(s.size, max));
    await fh.read(b, 0, b.length, start);
    const lines = b.toString().split("\n");
    return start ? lines.slice(1) : lines;
  } finally {
    await fh.close();
  }
}
export function codexState(
  lines: string[],
  now: number,
): Pick<Session, "state" | "evidence"> {
  for (const line of [...lines].reverse()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "event_msg") continue;
    const type = record.payload?.type;
    if (["task_complete", "turn_complete", "turn_aborted"].includes(type))
      return {
        state: "idle",
        evidence: "Last recorded turn ended; task remains unarchived.",
      };
    if (["task_started", "turn_started"].includes(type)) {
      const age = now - Date.parse(record.timestamp);
      return age >= 0 && age < 120_000
        ? {
            state: "running",
            evidence: "Turn-start event observed within two minutes.",
          }
        : {
            state: "unknown",
            evidence:
              "Turn started without a recent completion; current activity unconfirmed.",
          };
    }
  }
  return {
    state: "open",
    evidence: "Unarchived native task; activity not confirmed.",
  };
}
async function codex(
  home: string,
  now: number,
): Promise<{ sessions: Session[]; source: Source }> {
  let db: DatabaseSync | undefined;
  try {
    const names = (await readdir(path.join(home, ".codex")))
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!names[0]) throw new Error("no database");
    db = new DatabaseSync(path.join(home, ".codex", names[0]), {
      readOnly: true,
    });
    db.exec("PRAGMA busy_timeout=1500");
    const rows = db
      .prepare(
        "SELECT id,COALESCE(NULLIF(name,''),'Untitled Codex task') AS title,cwd,updated_at,rollout_path FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 2001",
      )
      .all();
    const sessions: Session[] = [];
    for (const row of rows.slice(0, 2000)) {
      let observed: Pick<Session, "state" | "evidence"> = {
        state: "open",
        evidence: "Unarchived native task; activity not confirmed.",
      };
      const updatedAt = Number(row.updated_at) * 1000;
      if (
        now - updatedAt < 24 * 60 * 60_000 &&
        typeof row.rollout_path === "string"
      ) {
        try {
          observed = codexState(await tail(row.rollout_path), now);
        } catch {
          /* An unavailable tail does not close an open task. */
        }
      }
      sessions.push({
        id: String(row.id),
        title: String(row.title).slice(0, 500),
        cwd: String(row.cwd),
        updatedAt,
        app: "Codex",
        ...observed,
      });
    }
    return {
      sessions,
      source: source(
        rows.length > 2000 ? "unavailable" : "ok",
        rows.length > 2000
          ? "Session scan capped at 2,000; list incomplete."
          : "Unarchived tasks from the native local index; not necessarily open windows.",
        now,
      ),
    };
  } catch {
    return {
      sessions: [],
      source: source(
        "unavailable",
        "Codex local index missing, locked, or changed schema.",
        now,
      ),
    };
  } finally {
    db?.close();
  }
}
async function claude(
  home: string,
  now: number,
): Promise<{ sessions: Session[]; source: Source }> {
  try {
    const dir = path.join(home, ".claude/sessions");
    const sessions: Session[] = [];
    let unreadable = false;
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(dir, name), "utf8");
        if (raw.length > 32_000) throw new Error("large");
        const row = JSON.parse(raw);
        if (
          !Number.isInteger(row.pid) ||
          typeof row.sessionId !== "string" ||
          typeof row.cwd !== "string"
        )
          throw new Error("schema");
        try {
          process.kill(row.pid, 0);
        } catch {
          continue;
        }
        // Match executable as well as PID, to avoid stale files pointing at a reused process.
        const executable = await command("ps", [
          "-p",
          String(row.pid),
          "-o",
          "comm=",
        ]);
        if (!/claude/i.test(executable)) continue;
        const updatedAt = Number(
          row.statusUpdatedAt ?? row.updatedAt ?? row.startedAt,
        );
        if (!Number.isFinite(updatedAt)) throw new Error("timestamp");
        const current = now - updatedAt < 120_000;
        const state =
          current && ["running", "waiting", "idle"].includes(row.status)
            ? row.status
            : "open";
        sessions.push({
          id: row.sessionId,
          title: String(row.name ?? "Claude session").slice(0, 500),
          cwd: row.cwd,
          updatedAt,
          app: "Claude",
          state,
          evidence: current
            ? "Native session status and a live Claude process."
            : "Claude process is open; last reported activity is old.",
        });
      } catch {
        unreadable = true;
      }
    }
    return {
      sessions,
      source: source(
        unreadable ? "unavailable" : "ok",
        unreadable
          ? "Some native Claude session records could not be read."
          : "Live local sessions; cloud-only sessions are not visible.",
        now,
      ),
    };
  } catch {
    return {
      sessions: [],
      source: source(
        "unavailable",
        "Claude native session directory unavailable.",
        now,
      ),
    };
  }
}
export function belongs(cwd: string, root: string) {
  return cwd === root || cwd.startsWith(root + path.sep);
}
export function checkState(
  checks: Record<string, unknown>[],
): Project["pulls"][number]["checks"] {
  if (!checks.length) return "none";
  if (
    checks.some((c) =>
      [
        "FAILURE",
        "ERROR",
        "CANCELLED",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
      ].includes(String(c.conclusion ?? c.state)),
    )
  )
    return "failing";
  if (
    checks.some(
      (c) =>
        c.status === "IN_PROGRESS" ||
        c.status === "QUEUED" ||
        c.state === "PENDING" ||
        (!c.conclusion && !c.state),
    )
  )
    return "pending";
  return "passing";
}
// Work issues a pull request names: full issue links or OWNER/REPO#N.
export function workIssueRefs(body: string, repo?: string) {
  if (!repo) return [];
  const name = repo.replaceAll(".", "\\.");
  const refs = new RegExp(
    `(?:https://github\\.com/${name}/issues/|${name}#)([1-9]\\d*)`,
    "g",
  );
  return [
    ...new Set(Array.from(body.matchAll(refs), (m) => Number(m[1]))),
  ].slice(0, 100);
}
async function collectProject(
  config: Config,
  item: Item,
  sessions: Session[],
  sources: Pick<Project["sources"], "codex" | "claude">,
  now: number,
): Promise<Project> {
  const root = path.resolve(config.root, item.directory);
  let repo = `local/${path.basename(item.directory).replace(/[^\w.-]/g, "-")}`;
  let git = source(
    "ok",
    "Local disk checked; ahead/behind uses the last fetched upstream.",
    now,
  );
  const worktrees: Worktree[] = [];
  try {
    let remote = "";
    try {
      remote = await command("git", ["remote", "get-url", "origin"], root);
    } catch {
      /* Local repositories still have inspectable worktrees. */
    }
    const match = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (match) repo = match[1];
    const trees = parseWorktrees(
      await command(
        "git",
        ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
        root,
      ),
    );
    for (const { head, prunable, ...tree } of trees) {
      // Git's record of a folder that is gone: housekeeping, not an unreadable
      // checkout, but its commit can still hold work only this machine has.
      if (prunable && (await folderRemoved(tree.path, root))) {
        worktrees.push({
          ...tree,
          changed: 0,
          conflicts: 0,
          ahead: null,
          behind: null,
          unpushed: /^[0-9a-f]{40,64}$/.test(head)
            ? await unpushedCommits(root, head).catch(() => null)
            : null,
          isPrimary: false,
          error: null,
          prunable: true,
        });
        continue;
      }
      try {
        // Out of reach (unreadable, or its volume unmounted) is unverified,
        // never clean; status from inside it could read an enclosing repository.
        if (prunable) throw new Error("Folder out of reach");
        const changes = parseStatus(
          await command(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
            tree.path,
          ),
        );
        let ahead: number | null = null,
          behind: number | null = null;
        try {
          const counts = (
            await command(
              "git",
              ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
              tree.path,
            )
          )
            .trim()
            .split(/\s+/)
            .map(Number);
          [ahead, behind] = counts;
        } catch {
          /* No upstream is different from synced. */
        }
        worktrees.push({
          ...tree,
          ...changes,
          ahead,
          behind,
          unpushed: await unpushedCommits(tree.path).catch(() => null),
          isPrimary: tree.path === root,
          error: null,
        });
      } catch {
        worktrees.push({
          ...tree,
          changed: 0,
          conflicts: 0,
          ahead: null,
          behind: null,
          isPrimary: tree.path === root,
          error: "Checkout unavailable",
        });
        git = source(
          "unavailable",
          "One or more checkouts could not be inspected.",
          now,
        );
      }
    }
  } catch {
    git = source(
      "unavailable",
      "Repository or worktree list could not be read.",
      now,
    );
  }
  let pulls: Project["pulls"] = [],
    latestMerge: Project["latestMerge"] = null,
    github = source(
      "ok",
      "Current open PRs and check results from GitHub.",
      now,
    ),
    description = "";
  try {
    const metadata = JSON.parse(
      await command("gh", ["repo", "view", repo, "--json", "description"]),
    );
    description = String(metadata.description ?? "").slice(0, 500);
    const raw = JSON.parse(
      await command("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,url,body,headRefName,isDraft,statusCheckRollup,updatedAt",
      ]),
    );
    pulls = raw.map((p: Record<string, unknown>) => ({
      number: p.number,
      title: String(p.title).slice(0, 500),
      url: p.url,
      branch: p.headRefName,
      draft: p.isDraft,
      workIssues: workIssueRefs(String(p.body ?? ""), config.workRepo),
      checks: checkState(p.statusCheckRollup as Record<string, unknown>[]),
      updatedAt: Date.parse(String(p.updatedAt)),
    }));
    const merged = JSON.parse(
      await command("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "merged",
        "--limit",
        "1",
        "--json",
        "title,url,mergedAt",
      ]),
    );
    if (merged[0])
      latestMerge = {
        title: String(merged[0].title).slice(0, 500),
        url: merged[0].url,
        mergedAt: Date.parse(merged[0].mergedAt),
      };
    if (pulls.length === 100)
      github = source(
        "unavailable",
        "PR list reached 100; may be incomplete.",
        now,
      );
  } catch {
    github = source(
      "unavailable",
      "GitHub could not be checked: authentication, network, or repository access.",
      now,
    );
  }
  if (worktrees.length > 500)
    git = source(
      "unavailable",
      "Worktree scan capped at 500; list incomplete.",
      now,
    );
  const relevant = sessions.filter(
    (s) =>
      belongs(s.cwd, root) || worktrees.some((w) => belongs(s.cwd, w.path)),
  );
  if (relevant.length > 500)
    sources = {
      ...sources,
      codex: source("unavailable", "Project session list capped at 500.", now),
    };
  return {
    id: item.id ?? repo.toLowerCase(),
    name: item.name,
    repo,
    description,
    progress: await progress(root, item.plan),
    latestMerge,
    worktrees: worktrees.slice(0, 500),
    sessions: relevant.slice(0, 500),
    pulls,
    sources: { git, github, ...sources },
  };
}
// The inboxes are read by the machine on duty.
export async function collect(
  config: Config,
  { inbox = false }: { inbox?: boolean } = {},
): Promise<Snapshot> {
  const now = Date.now();
  // An app this machine does not use is not a coverage gap.
  const unused = (app: string) => ({
    sessions: [],
    source: source("unsupported", `${app} is not used on this machine.`, now),
  });
  const [c, a, quotas] = await Promise.all([
    config.agents.includes("codex") ? codex(config.home, now) : unused("Codex"),
    config.agents.includes("claude")
      ? claude(config.home, now)
      : unused("Claude"),
    readQuotas(config.home, config.agents, subprocessEnv()),
  ]);
  const sources = { codex: c.source, claude: a.source };
  const projects: Project[] = [];
  // Bound concurrency across repositories; each subprocess has its own deadline.
  const items = await discover(config);
  try {
    await githubToken([
      ...new Set([
        ...(config.workRepo ? [config.workRepo] : []),
        ...items.flatMap((i) => (i.repo ? [i.repo] : [])),
      ]),
    ]);
  } catch {
    process.env.GH_TOKEN = "unavailable";
  }
  for (let i = 0; i < items.length; i += 3)
    projects.push(
      ...(await Promise.all(
        items
          .slice(i, i + 3)
          .map((item) =>
            collectProject(
              config,
              item,
              [...c.sessions, ...a.sessions],
              sources,
              now,
            ),
          ),
      )),
    );
  const ids = new Set<string>();
  for (const p of projects) {
    if (ids.has(p.id))
      throw new Error(
        "Duplicate project identity; assign distinct repository metadata IDs",
      );
    ids.add(p.id);
  }
  const work = config.workRepo
    ? await readWork(config.home, (args) => command("gh", args), config.workRepo)
    : undefined;
  const assigned = new Set(
    projects.flatMap((p) => p.sessions.map((s) => `${s.app}:${s.id}`)),
  );
  return {
    version: 1,
    host: config.host,
    collectedAt: now,
    projects,
    work,
    quotas,
    ...(inbox && inboxLogins(config).length
      ? { inboxes: await readInboxes(config, work?.issues) }
      : {}),
    unassignedSessions: [...c.sessions, ...a.sessions]
      .filter((s) => !assigned.has(`${s.app}:${s.id}`))
      .slice(0, 2000),
  };
}

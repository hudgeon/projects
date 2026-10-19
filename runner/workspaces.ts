import { realpath, mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import {
  checkState,
  discover,
  unpushedCommits,
  type Config,
} from "../collector/collect";
import { Failure, nativeEnv } from "./native";
import {
  LIVE_FILES,
  type Child,
  type RunnerHost,
  type LiveChanges,
  type MasterDecision,
} from "../src/run-model";

const exec = promisify(execFile);
// The runner has one process owner. Its concurrent conversations share Git's
// fetch/ref metadata, even though their eventual worktrees are independent.
const preparations = new Map<string, Promise<unknown>>();
export async function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
) {
  try {
    const result = await exec("git", args, {
      cwd,
      env: {
        ...nativeEnv(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        ...env,
      },
      timeout: 60000,
      maxBuffer: 2_000_000,
    });
    return result.stdout.trim();
  } catch {
    throw new Failure(
      "git_failed",
      "Git could not verify or prepare this workspace.",
    );
  }
}
export type ProjectDirectory = {
  id: string;
  name: string;
  cwd: string;
  plan: string | null;
};
export async function registry(config: Config): Promise<ProjectDirectory[]> {
  const root = await realpath(config.root);
  const found = await discover(config);
  const result: ProjectDirectory[] = [];
  for (const item of found) {
    const id = item.id ?? item.repo;
    if (!id) continue;
    const cwd = await realpath(path.resolve(root, item.directory));
    if (!cwd.startsWith(root + path.sep))
      throw Error("Project directory escaped the registered root.");
    if (result.some((p) => p.id === id))
      throw Error(
        "Duplicate project identity; fix the project metadata before running work.",
      );
    result.push({ id, name: item.name, cwd, plan: item.plan ?? null });
  }
  return result;
}
// A change worktree's saved copy on GitHub, so another machine can continue it.
// Private to Projects: never a branch, so it starts no checks or reviews.
export const savedRef = (runId: string, childId: string) =>
  `refs/projects/wip/${runId}/${childId}`;
const SNAPSHOT = "Projects saved work in progress";
// The GitHub repository behind origin, or null when origin is elsewhere.
async function githubRepo(cwd: string) {
  const url = await git(cwd, ["remote", "get-url", "origin"]).catch(() => "");
  return /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}
const gh = (cwd: string, args: string[]) =>
  exec("gh", args, {
    cwd,
    env: { ...nativeEnv(), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 20000,
    maxBuffer: 1_000_000,
  }).then((result) => result.stdout.trim());
// A ref outside the branches is still listed and fetchable on a public
// repository, so work in progress is saved only to a private one. Unknown
// visibility, such as an offline lookup or a remote off GitHub, saves nothing.
export async function privateOrigin(cwd: string) {
  const repo = await githubRepo(cwd);
  if (!repo) return false;
  return gh(cwd, ["api", `repos/${repo}`, "--jq", ".private"]).then(
    (answer) => answer === "true",
    () => false,
  );
}
// GitHub merged a pull request whose head is exactly this commit, so its work
// has landed even where a squash merge left the branch's own commits behind.
// Unknown, such as a failed lookup or a remote off GitHub, is not landed.
export async function landed(cwd: string, commit: string) {
  const repo = await githubRepo(cwd);
  if (!repo || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
  return gh(cwd, [
    "api",
    `repos/${repo}/commits/${commit}/pulls`,
    "--jq",
    ".[] | select(.merged_at != null) | .head.sha",
  ]).then(
    (heads) => heads.split("\n").includes(commit),
    () => false,
  );
}
// A branch's work has landed when it has commits main does not contain and
// GitHub merged a pull request whose head is its last one. A commit main
// already has can be where a worktree started, with new work on top of it.
const branchLanded = async (cwd: string, commit: string, isLanded: typeof landed) =>
  !(await git(cwd, ["merge-base", "--is-ancestor", commit, "origin/main"]).then(
    () => true,
    () => false,
  )) && (await isLanded(cwd, commit));
// This conversation's copies on GitHub, by the child that saved each. GitHub
// says what exists, not this process, so a restart misses nothing.
async function savedCopies(cwd: string, runId: string) {
  const prefix = savedRef(runId, "");
  const copies = new Map<string, string>();
  for (const line of (
    await git(cwd, ["ls-remote", "origin", `${prefix}*`])
  ).split("\n")) {
    const [commit, ref] = line.split("\t");
    if (ref?.startsWith(prefix)) copies.set(ref.slice(prefix.length), commit);
  }
  return copies;
}
// Copies change in one all-or-nothing push, through the repository's hooks.
const updateCopies = (cwd: string, refspecs: string[]) =>
  git(cwd, ["push", "--quiet", "--atomic", "origin", ...refspecs]);
// Saves the worktree on top of its branch's HEAD, as heldHere builds it, and
// keeps one copy per worktree: copies that earlier children saved in it give
// way to this one. Once GitHub has the work or its branch has landed, the
// worktree's copies are removed and null returns; null also when the
// repository is not known to be private.
export async function saveWorkspace(
  cwd: string,
  runId: string,
  childId: string,
  options: {
    // Earlier children that worked in this worktree.
    older?: string[];
    isPrivate?: (cwd: string) => Promise<boolean>;
    landed?: typeof landed;
  } = {},
): Promise<{ commit: string; at: number } | null> {
  if (!(await (options.isPrivate ?? privateOrigin)(cwd))) return null;
  const held = await heldHere(cwd, options.landed ?? landed);
  const gone = [...(options.older ?? []), ...(held ? [] : [childId])];
  const copies = gone.length
    ? await savedCopies(cwd, runId)
    : new Map<string, string>();
  const removals = gone
    .filter((id) => copies.has(id))
    .map((id) => `:${savedRef(runId, id)}`);
  if (!held) {
    if (removals.length) await updateCopies(cwd, removals);
    return null;
  }
  const commit = held.changed
    ? await git(cwd, ["commit-tree", held.tree, "-p", held.head, "-m", SNAPSHOT])
    : held.head;
  await updateCopies(cwd, [`+${commit}:${savedRef(runId, childId)}`, ...removals]);
  return { commit, at: Date.now() };
}
// What a worktree holds that GitHub lacks, as its copy would carry it: tracked
// and new files as they are, built in a private index so the agent's own index
// is untouched, when they differ from HEAD's tree, or HEAD's commits when no
// remote branch has them and they never reached main. Ignored files are never
// saved; a changed file over 5 MB or that looks like a credential keeps its
// committed version, or is left out when new. Null when GitHub has it all, or
// once the branch has landed: leftover changes are not kept after that.
async function heldHere(cwd: string, isLanded: typeof landed) {
  const index = { GIT_INDEX_FILE: path.join(tmpdir(), `projects-save-${randomUUID()}`) };
  try {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    await git(cwd, ["read-tree", "HEAD"], index);
    await git(cwd, ["add", "-A", "--", "."], index);
    // Renames count as a deletion and a new file, so a renamed file is
    // checked under its new name.
    const changes = (
      await git(cwd, ["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"], index)
    ).split("\0");
    for (let i = 0; i + 1 < changes.length; i += 2) {
      const [status, name] = [changes[i], changes[i + 1]];
      if (status === "D") continue;
      if (
        secretLike(name) ||
        ((await stat(path.join(cwd, name)).catch(() => null))?.size ?? 0) > 5_000_000
      )
        await git(
          cwd,
          status === "A" ? ["rm", "--cached", "-q", "--", name] : ["reset", "-q", "HEAD", "--", name],
          index,
        );
    }
    const tree = await git(cwd, ["write-tree"], index);
    const changed = tree !== (await git(cwd, ["rev-parse", "HEAD^{tree}"]));
    if (!changed && (await unpushedCommits(cwd)) === 0) return null;
    if (await branchLanded(cwd, head, isLanded)) return null;
    return { head, tree, changed };
  } finally {
    await rm(index.GIT_INDEX_FILE, { force: true });
  }
}
// No saved copy or pushed branch exists for a workspace on another machine.
export class UnsavedWorkspace extends Error {}
// Recreates another machine's child worktree here from the newest copy any of
// its children saved, or from its pushed branch when that is newer, as
// uncommitted changes on the same branch. A new native session continues it;
// the old ones stay on that machine. `sharing` lists the change children that
// worked in it, oldest first: one child runs at a time, so a later child's
// copy is newer.
async function restoreWorkspace(
  project: ProjectDirectory,
  sharing: Child[],
  runId: string,
  cwd: string,
) {
  const found = (name: string) =>
    git(project.cwd, ["rev-parse", "--verify", "--quiet", name]).catch(() => null);
  await git(project.cwd, ["fetch", "--no-tags", "origin", "main"]);
  // This conversation's saved copies; one GitHub no longer has goes here too.
  const copies = savedRef(runId, "*");
  await git(project.cwd, ["fetch", "--no-tags", "--prune", "origin", `+${copies}:${copies}`]);
  let saved: string | null = null,
    source = sharing.at(-1)!;
  for (const child of [...sharing].reverse()) {
    saved = await found(savedRef(runId, child.id));
    if (saved) {
      source = child;
      break;
    }
  }
  // The branch that copy was saved from, else the worktree's latest.
  const branch = source.branch;
  if (!branch.startsWith("projects/"))
    throw new UnsavedWorkspace("Only a runner workspace can move between machines.");
  const pushed = await git(project.cwd, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]).then(
    () => found(`refs/remotes/origin/${branch}`),
    () => null,
  );
  if (!saved && !pushed)
    throw new UnsavedWorkspace(
      "That workspace was never saved to GitHub from its machine.",
    );
  const snapshot =
    !!saved && (await git(project.cwd, ["log", "-1", "--format=%s", saved])) === SNAPSHOT;
  const base = saved ? (snapshot ? await git(project.cwd, ["rev-parse", `${saved}^`]) : saved) : null;
  // A branch pushed after the last save supersedes it.
  const newer =
    !!pushed &&
    (!base ||
      (pushed !== base &&
        (await git(project.cwd, ["merge-base", "--is-ancestor", base, pushed]).then(
          () => true,
          () => false,
        ))));
  // The work is as of that commit; anything later on that machine is missing.
  const savedAt =
    Number(await git(project.cwd, ["log", "-1", "--format=%ct", newer ? pushed! : saved!])) * 1000;
  await mkdir(path.dirname(cwd), { recursive: true, mode: 0o700 });
  await git(project.cwd, ["worktree", "add", "-b", branch, cwd, newer ? pushed! : base!]);
  if (snapshot && !newer) {
    await git(cwd, ["read-tree", "--reset", "-u", saved!]);
    await git(cwd, ["reset", "-q"]);
  }
  return { cwd: await realpath(cwd), branch, sessionId: null, restored: true, savedAt };
}
// A worktree outlives its sessions. Its latest session continues only for a
// follow-up by the same app that needs that session's memory: never for a
// read-only review of a change, never once the session cannot continue, and
// never once its context passed this many tokens; a fresh session with a
// written handoff costs less than re-reading it on every request.
export const SESSION_CONTEXT_LIMIT = 200_000;
export function continuesSession(
  existing: Child,
  task: NonNullable<MasterDecision["task"]>,
  previous: Child[],
) {
  if (task.freshSession || !existing.sessionId || existing.agent !== task.agent) return false;
  if (task.mode !== existing.mode) return false;
  // The session's latest turn, which a later follow-up may have made.
  const latest =
    [...previous].reverse().find((c) => c.sessionId === existing.sessionId) ??
    existing;
  return (
    existing.resumable !== false &&
    latest.resumable !== false &&
    (latest.usage?.context ?? 0) < SESSION_CONTEXT_LIMIT
  );
}
export async function prepareWorkspace(
  project: ProjectDirectory,
  task: NonNullable<MasterDecision["task"]>,
  previous: Child[],
  runId: string,
  childId: string,
  root: string,
  host: RunnerHost,
): Promise<{
  cwd: string;
  branch: string;
  sessionId: string | null;
  restored?: boolean;
  savedAt?: number;
}> {
  if (task.workspace !== "new") {
    let existing = previous.find((child) => child.id === task.workspace);
    if (!existing || existing.projectId !== project.id)
      throw new Failure(
        "workspace_changed",
        "The requested workspace does not belong to this conversation and project.",
      );
    // Another machine's worktree: reuse a copy restored here before, or
    // restore one. Moved children name their machine; one without ran on this
    // machine.
    if ((existing.host ?? host) !== host) {
      const moving = existing;
      // The change children that worked in it, oldest first; the first made it.
      const sharing = previous.filter(
        (child) =>
          child.host === moving.host &&
          child.mode === "change" &&
          child.cwd === moving.cwd,
      );
      if (!sharing.length)
        throw new UnsavedWorkspace("A read-only workspace has nothing to move.");
      const local = path.join(
        await realpath(root).catch(() => root),
        runId,
        sharing[0].id,
        path.basename(project.cwd),
      );
      if (!(await stat(local).catch(() => null)))
        return serialized(project, () =>
          restoreWorkspace(project, sharing, runId, local),
        );
      existing = { ...existing, cwd: local, sessionId: null, state: "completed" };
    }
    if (["running", "unknown"].includes(existing.state))
      throw new Failure(
        "workspace_changed",
        "The existing session must be reconciled before its workspace can be reused.",
      );
    if (
      task.mode === "change" &&
      existing.mode === "read" &&
      existing.cwd === project.cwd
    )
      throw new Failure(
        "workspace_changed",
        "Changes require a new worktree, not the primary checkout.",
      );
    const cwd = await realpath(existing.cwd);
    if (cwd !== existing.cwd)
      throw new Failure(
        "workspace_changed",
        "That worktree's folder has moved.",
      );
    const common = await git(project.cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const branch = await git(cwd, ["branch", "--show-current"]);
    // A child may start another branch in its own runner worktree, say for a
    // second pull request, or leave it detached once that merged; elsewhere a
    // different branch means another owner.
    const owned = cwd.startsWith(
      (await realpath(root).catch(() => root)) + path.sep,
    );
    if (
      (await git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])) !== common ||
      (branch !== existing.branch && !owned)
    )
      throw new Failure(
        "workspace_changed",
        "That worktree is on a branch this conversation did not start, so another session may own it.",
      );
    return {
      cwd,
      branch: branch || existing.branch,
      sessionId: continuesSession(existing, task, previous)
        ? existing.sessionId
        : null,
    };
  }
  if (task.mode === "read")
    return {
      cwd: project.cwd,
      branch: await git(project.cwd, ["branch", "--show-current"]),
      sessionId: null,
    };
  const branch = `projects/${runId.slice(0, 8)}/${childId.slice(0, 8)}`;
  const cwd = path.join(root, runId, childId, path.basename(project.cwd));
  await mkdir(path.dirname(cwd), { recursive: true, mode: 0o700 });
  return serialized(project, async () => {
    await git(project.cwd, ["fetch", "--no-tags", "origin", "main"]);
    await git(project.cwd, ["worktree", "add", "-b", branch, cwd, "origin/main"]);
    return { cwd: await realpath(cwd), branch, sessionId: null };
  });
}
// One shared repository's fetch and worktree setup at a time; a failure
// releases the next caller.
async function serialized<T>(
  project: ProjectDirectory,
  action: () => Promise<T>,
): Promise<T> {
  const common = await realpath(
    await git(project.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const preparation = (preparations.get(common) ?? Promise.resolve())
    .catch(() => {})
    .then(action);
  preparations.set(common, preparation);
  try {
    return await preparation;
  } finally {
    if (preparations.get(common) === preparation) preparations.delete(common);
  }
}
// One project's change children grouped by the worktree they worked in,
// oldest first. A child without a machine ran on this one.
function worktrees(children: Child[], projectId: string, host: RunnerHost) {
  const groups = new Map<string, Child[]>();
  for (const child of children)
    if (child.mode === "change" && child.projectId === projectId) {
      const key = `${child.host ?? host}\0${child.cwd}`;
      groups.set(key, [...(groups.get(key) ?? []), child]);
    }
  return [...groups.values()];
}
// The commit a copy was built on: the parent of a snapshot of uncommitted
// work, else the copy itself. Fetched when missing, without a local ref.
async function copyBase(cwd: string, ref: string, commit: string) {
  if (!(await git(cwd, ["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false)))
    await git(cwd, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ref]);
  const [parents, subject] = (
    await git(cwd, ["log", "-1", "--format=%P%x00%s", commit])
  ).split("\0");
  return subject === SNAPSHOT ? parents.split(" ")[0] : commit;
}
// Removes this conversation's copies that nothing needs, as GitHub lists
// them. A copy is kept only while it alone holds work another machine could
// continue: a later child's copy replaces earlier ones in the same worktree,
// and a worktree's copy goes once GitHub has its work, its branch has landed
// or another machine has recreated it. Copies fetched here to recreate a
// worktree go as well.
export async function pruneSaved(
  project: ProjectDirectory,
  runId: string,
  children: Child[],
  root: string,
  host: RunnerHost,
  isLanded: typeof landed = landed,
) {
  await serialized(project, async () => {
    for (const ref of (
      await git(project.cwd, ["for-each-ref", "--format=%(refname)", `refs/projects/wip/${runId}`])
    )
      .split("\n")
      .filter(Boolean))
      await git(project.cwd, ["update-ref", "-d", ref]);
  });
  const copies = await savedCopies(project.cwd, runId);
  if (!copies.size) return;
  const runs = await realpath(root).catch(() => root);
  // Whether a worktree's newest copy still holds work nothing else does.
  const needed = async (group: Child[], id: string) => {
    const worktree = group[0].cwd;
    if ((group[0].host ?? host) === host) {
      // Still that worktree, not a leftover folder inside another repository.
      if (
        await git(worktree, ["rev-parse", "--show-toplevel"]).then(
          (top) => top === worktree,
          () => false,
        )
      )
        return !!(await heldHere(worktree, isLanded));
    } else if (
      children.some(
        (child) =>
          (child.host ?? host) === host &&
          group.some(
            (other) =>
              child.cwd === path.join(runs, runId, other.id, path.basename(project.cwd)),
          ),
      )
    )
      return false;
    // Here only the copy holds this work; it stays until its branch lands.
    return !(await branchLanded(
      project.cwd,
      await copyBase(project.cwd, savedRef(runId, id), copies.get(id)!),
      isLanded,
    ));
  };
  const removals: string[] = [];
  for (const group of worktrees(children, project.id, host)) {
    const ids = group.map((child) => child.id).filter((id) => copies.has(id));
    if (!ids.length) continue;
    const keep = await needed(group, ids.at(-1)!).catch(() => true);
    removals.push(...(keep ? ids.slice(0, -1) : ids));
  }
  if (removals.length)
    await updateCopies(project.cwd, removals.map((id) => `:${savedRef(runId, id)}`));
}
// The conversations with copies in this repository, on GitHub or fetched here.
export async function savedRuns(cwd: string) {
  const refs = [
    ...(await git(cwd, ["ls-remote", "origin", "refs/projects/wip/*"]))
      .split("\n")
      .map((line) => line.split("\t")[1] ?? ""),
    ...(await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/projects/wip"])).split("\n"),
  ];
  return [
    ...new Set(
      refs.flatMap((ref) => /^refs\/projects\/wip\/([0-9a-f-]{36})\//.exec(ref)?.[1] ?? []),
    ),
  ];
}
export async function workspaceEvidence(cwd: string): Promise<string[]> {
  const [head, branch, status, unpushed] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--porcelain"]),
    // Commits no remote branch has; the last fetch or push sets what is known.
    git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
  ]);
  return [
    `Observed HEAD: ${head}`,
    `Observed branch: ${branch || "detached"}`,
    `Observed changed paths: ${status ? status.split("\n").length : 0}`,
    `Observed unpushed commits: ${unpushed}`,
    ...(branch && !["main", "master"].includes(branch)
      ? [await pullEvidence(cwd, branch)]
      : []),
  ];
}
// New files that look like credentials are never read or saved to GitHub,
// even when no ignore rule covers them.
export const secretLike = (name: string) =>
  /(^|\/)(\.env|\.dev\.vars|\.npmrc|id_(rsa|ecdsa|ed25519))|\.(pem|key|p12|pfx|keystore)$|credential|secret|token/i.test(
    name,
  );
// The branch's changed files and line counts since it left main, committed
// and uncommitted alike, for the live view. Names and counts only.
export async function liveChanges(cwd: string): Promise<LiveChanges> {
  const base = await git(cwd, ["merge-base", "HEAD", "origin/main"]).catch(
    () => "HEAD",
  );
  const files: LiveChanges["files"] = [];
  const numstat = await git(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    base,
  ]);
  for (const entry of numstat.split("\0")) {
    const [added, removed, ...name] = entry.split("\t");
    if (!name.length) continue;
    files.push({
      path: name.join("\t"),
      added: Number(added) || 0,
      removed: Number(removed) || 0,
    });
  }
  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  for (const name of untracked.slice(0, 200)) {
    let added = 0;
    try {
      const file = path.join(cwd, name);
      if (!secretLike(name) && (await stat(file)).size <= 1_000_000) {
        const text = await readFile(file, "utf8");
        added =
          (text.match(/\n/g) ?? []).length + (text && !text.endsWith("\n") ? 1 : 0);
      }
    } catch {
      /* A file removed mid-count still counts as one changed file. */
    }
    files.push({ path: name, added, removed: 0 });
  }
  const sum = (key: "added" | "removed") =>
    files.reduce((total, file) => total + file[key], 0);
  return {
    files: files
      .sort((a, b) => b.added + b.removed - (a.added + a.removed))
      .slice(0, LIVE_FILES)
      .map((file) => ({ ...file, path: file.path.slice(0, 300) })),
    total: {
      files: files.length + Math.max(0, untracked.length - 200),
      added: sum("added"),
      removed: sum("removed"),
    },
    at: Date.now(),
  };
}
// The branch's pull request and checks, so the master does not spend a turn
// looking them up. GitHub's answer is evidence, not proof of delivery.
export async function pullEvidence(cwd: string, branch: string) {
  try {
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "url,state,isDraft,statusCheckRollup",
      ],
      {
        cwd,
        env: { ...nativeEnv(), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
        timeout: 20000,
        maxBuffer: 2_000_000,
      },
    );
    const [pull] = z
      .array(
        z.object({
          url: z.url().regex(/^https:\/\/github\.com\//),
          state: z.enum(["OPEN", "CLOSED", "MERGED"]),
          isDraft: z.boolean(),
          statusCheckRollup: z.array(z.record(z.string(), z.unknown())).nullable(),
        }),
      )
      .parse(JSON.parse(stdout));
    if (!pull) return "Observed pull request: none for this branch";
    const state =
      pull.state === "OPEN" && pull.isDraft ? "draft" : pull.state.toLowerCase();
    return `Observed pull request: ${pull.url} · ${state} · checks ${checkState(pull.statusCheckRollup ?? [])}`;
  } catch {
    return "Observed pull request: not checked; GitHub was unavailable";
  }
}

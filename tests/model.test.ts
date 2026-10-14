import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatus,
  parseWorktrees,
  parsePlan,
  codexState,
  belongs,
  checkState,
} from "../collector/collect";
import {
  clutter,
  freshness,
  health,
  hostHealth,
  lastActivity,
  projectHealth,
  restart,
  snapshotSchema,
  threads,
  type Project,
  type Session,
  type Worktree,
  setMachineNames,
} from "../src/model";
setMachineNames([
  { id: "studio", name: "Studio" },
  { id: "laptop", name: "Laptop" },
]);
test("Git rename records and paths with spaces do not inflate change counts", () => {
  assert.deepEqual(
    parseStatus("R  new name\0old name\0?? untracked\0UU conflict\0"),
    { changed: 3, conflicts: 1 },
  );
  assert.deepEqual(
    parseWorktrees(
      "worktree /my repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /another dir\nHEAD def\ndetached\n\nworktree /tmp/gone\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n",
    ),
    [
      { path: "/my repo", branch: "main", head: "abc" },
      { path: "/another dir", branch: "Detached HEAD", head: "def" },
      { path: "/tmp/gone", branch: "Detached HEAD", head: "123", prunable: true },
    ],
  );
});
test("session mapping respects repository boundaries", () => {
  assert.equal(belongs("/repos/app-two", "/repos/app"), false);
  assert.equal(belongs("/repos/app/.Codex/worktrees/task", "/repos/app"), true);
});
test("missing completion does not leave a session permanently running", () => {
  const now = Date.now();
  const event = (type: string, at: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date(at).toISOString(),
      payload: { type },
    });
  assert.equal(codexState([event("task_started", now)], now).state, "running");
  assert.equal(
    codexState([event("task_started", now - 3600_000)], now).state,
    "unknown",
  );
  assert.equal(
    codexState([event("task_started", now), event("task_complete", now)], now)
      .state,
    "idle",
  );
  assert.equal(codexState(["partial invalid JSON"], now).state, "open");
});
test("plan checkboxes are an attributed plan count, not inferred completion", () => {
  assert.deepEqual(
    parsePlan(
      "# Plan\n**Status:** In progress\n- [x] Reader\n- [ ] Writer\n- [ ] Verify",
    ),
    {
      summary: "Status: In progress",
      completed: 1,
      total: 3,
      next: ["Writer", "Verify"],
    },
  );
});
test("unavailable/stale and failed checks cannot become a clean result", () => {
  assert.equal(freshness(1, 600_001), true);
  assert.equal(freshness(600_001, 600_001), false);
  assert.equal(
    checkState([{ conclusion: "CANCELLED", status: "COMPLETED" }]),
    "failing",
  );
  assert.equal(checkState([{ state: "PENDING" }]), "pending");
  assert.equal(checkState([]), "none");
  assert.equal(
    snapshotSchema.safeParse({
      version: 1,
      host: "studio",
      collectedAt: 1,
      projects: [],
      secret: "should not upload",
    }).success,
    false,
  );
});
test("an older collector's placeholder source still publishes; any other unknown source is refused", () => {
  const now = Date.now();
  const project = fixture(now);
  const unused = { state: "unsupported", message: "Not verified", observedAt: now };
  const publishes = (sources: Record<string, unknown>) =>
    snapshotSchema.safeParse({
      version: 1,
      host: "studio",
      collectedAt: now,
      projects: [{ ...project, sources }],
      unassignedSessions: [],
    }).success;
  assert.equal(publishes(project.sources), true);
  assert.equal(publishes({ ...project.sources, grok: unused }), true);
  assert.equal(publishes({ ...project.sources, other: unused }), false);
});
test("work is located by session, changed checkout and open PR; quiet projects have none", () => {
  const now = Date.now();
  const source = { state: "ok" as const, message: "", observedAt: now };
  const project = {
    id: "acme/x",
    name: "X",
    repo: "acme/x",
    description: "",
    progress: {
      summary: "",
      next: [],
      completed: 0,
      total: 0,
      source: "",
      updatedAt: null,
    },
    latestMerge: null,
    worktrees: [
      {
        path: "/r/x",
        branch: "main",
        changed: 0,
        conflicts: 0,
        ahead: 0,
        behind: 0,
        isPrimary: true,
        error: null,
      },
      {
        path: "/r/x/.claude/worktrees/a",
        branch: "claude/a",
        changed: 2,
        conflicts: 0,
        ahead: 1,
        behind: 0,
        isPrimary: false,
        error: null,
      },
    ],
    sessions: [
      {
        id: "s1",
        title: "Fix it",
        app: "Claude" as const,
        cwd: "/r/x/.claude/worktrees/a",
        updatedAt: now - 3600_000,
        state: "idle" as const,
        evidence: "",
      },
      {
        id: "s2",
        title: "Old",
        app: "Codex" as const,
        cwd: "/r/x",
        updatedAt: now - 30 * 86400_000,
        state: "open" as const,
        evidence: "",
      },
    ],
    pulls: [
      {
        number: 7,
        title: "PR",
        url: "https://github.com/acme/x/pull/7",
        branch: "claude/a",
        draft: false,
        checks: "failing" as const,
        updatedAt: now - 7200_000,
      },
    ],
    sources: {
      git: source,
      github: source,
      codex: source,
      claude: source,
    },
  };
  const obs = [{ project, host: "studio", at: now }];
  const list = threads(obs, obs[0], now);
  assert.deepEqual(
    list.map((t) => [t.kind, t.title]),
    [
      ["session", "Fix it"],
      ["pull", "#7 PR"],
      ["checkout", "claude/a"],
    ],
  );
  assert.match(list[0].detail, /Claude on Studio · claude\/a · idle/);
  assert.equal(list[1].tone, "warning");
  assert.equal(lastActivity(list), now - 3600_000);
  const quiet = {
    ...project,
    sessions: [project.sessions[1]],
    pulls: [],
    worktrees: [project.worktrees[0]],
  };
  const q = [{ project: quiet, host: "studio", at: now }];
  assert.equal(threads(q, q[0], now).length, 0);
  assert.equal(lastActivity([]), 0);
  const cluttered = {
    ...quiet,
    worktrees: Array.from({ length: 12 }, (_, i) => ({
      ...project.worktrees[1],
      path: `/r/x/.Codex/worktrees/${i}`,
      changed: 0,
      ahead: 0,
    })),
  };
  assert.deepEqual(clutter([{ project: cluttered, host: "laptop", at: now }]), [
    { host: "laptop", count: 12 },
  ]);
});

test("a machine is clean only when fresh with nothing uncommitted, unpushed, cluttered or unreadable; unknown upstream stays unverified", () => {
  const now = Date.now();
  const source = { state: "ok" as const, message: "", observedAt: now };
  const worktree: Worktree = {
    path: "/r/x",
    branch: "main",
    changed: 0,
    conflicts: 0,
    ahead: 0,
    behind: 0,
    isPrimary: true,
    error: null,
  };
  const project = (worktrees: Worktree[]) => ({
    id: "acme/x",
    name: "X",
    repo: "acme/x",
    description: "",
    progress: {
      summary: "",
      next: [],
      completed: 0,
      total: 0,
      source: "",
      updatedAt: null,
    },
    latestMerge: null,
    worktrees,
    sessions: [],
    pulls: [],
    sources: {
      git: source,
      github: source,
      codex: source,
      claude: source,
    },
  });
  const snapshot = (worktrees: Worktree[], collectedAt = now) => ({
    version: 1 as const,
    host: "laptop",
    collectedAt,
    projects: [project(worktrees)],
    unassignedSessions: [],
  });
  assert.equal(hostHealth(snapshot([worktree]), now).verdict, "clean");
  assert.equal(
    hostHealth(snapshot([worktree]), now + 6 * 60_000).verdict,
    "stale",
  );
  const unknown = hostHealth(
    snapshot([
      worktree,
      {
        ...worktree,
        path: "/r/x/.claude/worktrees/a",
        branch: "a",
        isPrimary: false,
        ahead: null,
        behind: null,
      },
    ]),
    now,
  );
  assert.equal(unknown.verdict, "unverified");
  assert.equal(unknown.unverified, 1);
  assert.equal(unknown.extra, 1);
  const dirty = hostHealth(
    snapshot([
      { ...worktree, behind: 13 },
      {
        ...worktree,
        path: "/r/x/.Codex/worktrees/b",
        branch: "b",
        isPrimary: false,
        changed: 2,
        ahead: null,
      },
      {
        ...worktree,
        path: "/r/x/.Codex/worktrees/c",
        branch: "c",
        isPrimary: false,
        ahead: 5,
      },
    ]),
    now,
  );
  assert.equal(dirty.verdict, "cleanup");
  assert.deepEqual(
    dirty.problems.map((p) => [p.checkout, p.note, p.tone]),
    [
      ["b", "2 uncommitted · push state unknown", "warning"],
      ["c", "5 unpushed", "warning"],
      ["main checkout", "13 behind", "quiet"],
    ],
  );
  // Commits only this machine holds decide push state; an upstream count does not.
  const squashed = hostHealth(
    snapshot([
      worktree,
      { ...worktree, path: "/r/x/.claude/worktrees/s", branch: "s", isPrimary: false, ahead: 4, unpushed: 0 },
      { ...worktree, path: "/r/x/.claude/worktrees/n", branch: "n", isPrimary: false, ahead: null, unpushed: 2 },
      { ...worktree, path: "/tmp/gone", branch: "Detached HEAD", isPrimary: false, ahead: null, behind: null, unpushed: 0, prunable: true },
    ]),
    now,
  );
  assert.deepEqual(
    squashed.problems.map((p) => [p.checkout, p.note, p.tone]),
    [
      ["n", "2 unpushed", "warning"],
      ["Detached HEAD", "Folder removed; Git still lists it until git worktree prune", "quiet"],
    ],
  );
  assert.deepEqual([squashed.extra, squashed.unverified, squashed.errors], [2, 0, 0], "a removed folder is neither a checkout nor unreadable");
  // Pruning is suggested only when nothing on the removed folder's commit is
  // left to push; a record without that count (older collectors) is unknown.
  const removed = [
    { ...worktree, path: "/tmp/kept", branch: "kept", isPrimary: false, ahead: null, behind: null, unpushed: 1, prunable: true as const },
    { ...worktree, path: "/tmp/old", branch: "old", isPrimary: false, ahead: null, behind: null, prunable: true as const },
  ];
  const left = hostHealth(snapshot([worktree, ...removed]), now);
  assert.deepEqual(
    left.problems.map((p) => [p.checkout, p.note, p.tone]),
    [
      ["kept", "Folder removed · 1 unpushed", "warning"],
      ["old", "Folder removed · push state unknown", "quiet"],
    ],
  );
  assert.deepEqual([left.verdict, left.unpushed, left.unverified, left.extra], ["cleanup", 1, 1, 0]);
  assert.equal(hostHealth(snapshot([worktree, removed[1]]), now).verdict, "unverified");
  const obs = [{ project: project([worktree, ...removed]), host: "laptop", at: now }];
  assert.deepEqual(
    threads(obs, undefined, now).map((t) => [t.title, t.detail, t.tone]),
    [["kept", "Checkout on Laptop · folder removed · 1 unpushed · no recent session", "warning"]],
  );
  assert.deepEqual(health(obs[0].project, now, now).concerns, ["1 checkout with unpushed commits, no recent session"]);
  const cluttered = hostHealth(
    snapshot(
      Array.from({ length: 11 }, (_, i) => ({
        ...worktree,
        path: `/r/x/.Codex/worktrees/${i}`,
        branch: `t${i}`,
        isPrimary: i === 0,
      })),
    ),
    now,
  );
  assert.equal(cluttered.verdict, "cleanup");
  assert.match(
    cluttered.problems[0].note,
    /verify contents and merged commits/,
  );
});

test("a session restarts in its own app; only a plain ID becomes a shell command", () => {
  const id = "01a0ae37-2c27-72c1-8fee-8b4840d0bfb3";
  assert.deepEqual(restart("Codex", id), {
    command: `codex resume ${id}`,
    link: `codex://threads/${id}`,
  });
  assert.deepEqual(restart("Claude", id), {
    command: `claude --resume ${id}`,
    link: null,
  });
  for (const bad of ["", "-rf", "a b", "a;rm -rf ~", "$(id)", "a/b", "a`b`"])
    assert.equal(restart("Claude", bad), null, bad);
});

const HOUR = 3600_000;
const tree = "/r/x/.claude/worktrees/a";
function fixture(now: number, over: Partial<Project> = {}): Project {
  const source = { state: "ok" as const, message: "", observedAt: now };
  const checkout: Worktree = {
    path: "/r/x",
    branch: "main",
    changed: 0,
    conflicts: 0,
    ahead: 0,
    behind: 0,
    isPrimary: true,
    error: null,
  };
  return {
    id: "acme/x",
    name: "X",
    repo: "acme/x",
    description: "",
    progress: {
      summary: "",
      next: [],
      completed: 0,
      total: 0,
      source: "",
      updatedAt: null,
    },
    latestMerge: null,
    worktrees: [
      checkout,
      {
        ...checkout,
        path: tree,
        branch: "claude/a",
        isPrimary: false,
        changed: 3,
        ahead: 2,
      },
    ],
    sessions: [],
    pulls: [],
    sources: {
      git: source,
      github: source,
      codex: source,
      claude: source,
    },
    ...over,
  };
}
const session = (over: Partial<Session>): Session => ({
  id: "s1",
  title: "Build it",
  app: "Claude",
  cwd: tree,
  updatedAt: 0,
  state: "open",
  evidence: "",
  ...over,
});
const pull = (number: number, draft: boolean, checks = "failing" as const) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/x/pull/${number}`,
  branch: `b${number}`,
  draft,
  checks,
  updatedAt: 0,
});

test("a failing draft PR is in progress and stays listed as failing; a failing ready PR needs a look", () => {
  const now = Date.now();
  const worktrees = [fixture(now).worktrees[0]];
  const drafts = fixture(now, { worktrees, pulls: [pull(1, true)] });
  assert.deepEqual(health(drafts, now, now), {
    concerns: [],
    inProgress: ["1 draft PR with failed checks"],
  });
  const obs = [{ project: drafts, host: "studio", at: now }];
  assert.equal(projectHealth(obs, now).verdict, "progress");
  const [listed] = threads(obs, obs[0], now);
  assert.match(listed.detail, /draft · checks failing/);
  assert.equal(listed.tone, "quiet");
  const mixed = fixture(now, {
    worktrees,
    pulls: [pull(1, true), pull(2, false), pull(3, true)],
  });
  assert.deepEqual(health(mixed, now, now), {
    concerns: ["1 PR with failed checks"],
    inProgress: ["2 draft PRs with failed checks"],
  });
  const both = [{ project: mixed, host: "studio", at: now }];
  assert.equal(projectHealth(both, now).verdict, "attention");
  assert.deepEqual(
    threads(both, both[0], now).map((t) => t.tone),
    ["quiet", "warning", "quiet"],
  );
});

test("a changed or unpushed checkout is in progress only while a session in that worktree is live or recent", () => {
  const now = Date.now();
  const working = {
    concerns: [],
    inProgress: [
      "1 checkout with changes in a recent session",
      "1 checkout with unpushed commits in a recent session",
    ],
  };
  const abandoned = {
    concerns: [
      "1 checkout with changes, no recent session",
      "1 checkout with unpushed commits, no recent session",
    ],
    inProgress: [],
  };
  const of = (...sessions: Session[]) =>
    health(fixture(now, { sessions }), now, now);
  assert.deepEqual(
    of(session({ state: "running", updatedAt: now - 30_000 })),
    working,
  );
  // A current turn counts even when the app's index timestamp lags behind it.
  assert.deepEqual(
    of(session({ app: "Codex", state: "running", updatedAt: now - 30 * HOUR })),
    working,
  );
  assert.deepEqual(
    of(session({ state: "waiting", updatedAt: now - 60_000 })),
    working,
  );
  assert.deepEqual(
    of(session({ state: "idle", updatedAt: now - 23 * HOUR })),
    working,
  );
  assert.deepEqual(of(), abandoned);
  // An open Claude process or unarchived Codex task with old activity, a
  // session elsewhere in the repository and an impossible timestamp are not
  // evidence that anyone is working in this checkout.
  assert.deepEqual(
    of(
      session({ state: "open", updatedAt: now - 25 * HOUR }),
      session({ id: "s2", state: "unknown", updatedAt: now - 3 * 24 * HOUR }),
      session({ id: "s3", state: "running", updatedAt: now, cwd: "/r/x" }),
      session({ id: "s4", cwd: `${tree}-other`, updatedAt: now }),
      session({ id: "s5", state: "idle", updatedAt: now + HOUR }),
    ),
    abandoned,
  );
  assert.deepEqual(
    of(session({ state: "idle", updatedAt: now, cwd: `${tree}/src` })),
    working,
  );
  // Conflicts and unreadable checkouts need a look whoever is working there.
  const broken = fixture(now, {
    sessions: [session({ state: "running", updatedAt: now })],
  });
  broken.worktrees[1] = { ...broken.worktrees[1], conflicts: 1 };
  assert.deepEqual(health(broken, now, now).concerns, ["1 merge conflict"]);
  const project = fixture(now, {
    sessions: [session({ state: "running", updatedAt: now })],
  });
  const obs = [{ project, host: "studio", at: now }];
  const checkout = threads(obs, obs[0], now).find((t) => t.kind === "checkout");
  assert.equal(checkout?.tone, "quiet");
  const left = [{ project: fixture(now), host: "studio", at: now }];
  const orphan = threads(left, left[0], now)[0];
  assert.equal(orphan.tone, "warning");
  assert.match(orphan.detail, /3 changed · 2 unpushed · no recent session/);
});

test("a stale observation never turns a concern into work in progress or a clean project", () => {
  const now = Date.now();
  const at = now - 6 * 60_000;
  const project = fixture(at, {
    sessions: [session({ state: "running", updatedAt: at })],
  });
  assert.deepEqual(health(project, at, now).inProgress, []);
  assert.equal(health(project, at, now).concerns.length, 2);
  const stale = projectHealth([{ project, host: "laptop", at }], now);
  assert.equal(stale.verdict, "stale");
  assert.ok(stale.concerns.includes("GitHub unavailable"));
  // The Studio is fresh and clean; the Laptop's last word is old. Not clean.
  const clean = fixture(now, { worktrees: [fixture(now).worktrees[0]] });
  assert.equal(
    projectHealth(
      [
        { project: clean, host: "studio", at: now },
        { project: { ...clean, sources: project.sources }, host: "laptop", at },
      ],
      now,
    ).verdict,
    "stale",
  );
  const host = hostHealth(
    {
      version: 1,
      host: "laptop",
      collectedAt: at,
      projects: [project],
      unassignedSessions: [],
    },
    now,
  );
  assert.equal(host.verdict, "stale");
  assert.equal(host.active, 0);
  assert.equal(host.problems[0].tone, "warning");
});

test("badge precedence: update overdue, then needs a look, then in progress, and clean only with neither", () => {
  const now = Date.now();
  const primary = fixture(now).worktrees[0];
  const live = session({ state: "running", updatedAt: now });
  const verdict = (project: Project, at = now) =>
    projectHealth([{ project, host: "studio", at }], now).verdict;
  assert.equal(verdict(fixture(now, { worktrees: [primary] })), "clean");
  assert.equal(verdict(fixture(now, { sessions: [live] })), "progress");
  assert.equal(verdict(fixture(now)), "attention");
  const mixed = fixture(now, { sessions: [live], pulls: [pull(2, false)] });
  assert.equal(verdict(mixed), "attention");
  assert.deepEqual(
    projectHealth([{ project: mixed, host: "studio", at: now }], now).inProgress,
    [
      "1 checkout with changes in a recent session",
      "1 checkout with unpushed commits in a recent session",
    ],
  );
  assert.equal(verdict(mixed, now - 6 * 60_000), "stale");
  // A failed source is a concern, never a quieter badge.
  const unread = fixture(now, { sessions: [live] });
  unread.sources.git = { ...unread.sources.git, state: "unavailable" };
  assert.equal(verdict(unread), "attention");
  const noGithub = fixture(now, { worktrees: [primary] });
  noGithub.sources.github = {
    ...noGithub.sources.github,
    state: "unavailable",
  };
  assert.equal(verdict(noGithub), "attention");
  // A session on one machine does not vouch for the same path on the other.
  assert.equal(
    projectHealth(
      [
        { project: fixture(now, { sessions: [live] }), host: "studio", at: now },
        { project: fixture(now), host: "laptop", at: now },
      ],
      now,
    ).verdict,
    "attention",
  );
});

test("the machines strip agrees: attended work is in progress, abandoned work needs cleanup", () => {
  const now = Date.now();
  const snapshot = (project: Project) => ({
    version: 1 as const,
    host: "studio",
    collectedAt: now,
    projects: [project],
    unassignedSessions: [],
  });
  const live = session({ state: "running", updatedAt: now });
  const working = hostHealth(snapshot(fixture(now, { sessions: [live] })), now);
  assert.equal(working.verdict, "progress");
  assert.equal(working.active, 1);
  assert.deepEqual(
    working.problems.map((p) => [p.checkout, p.note, p.tone]),
    [["claude/a", "3 uncommitted · 2 unpushed · recent session", "quiet"]],
  );
  const abandoned = hostHealth(snapshot(fixture(now)), now);
  assert.equal(abandoned.verdict, "cleanup");
  assert.equal(abandoned.active, 0);
  // In progress outranks "clean where verified": it must not read as clean.
  const unknown = fixture(now, { sessions: [live] });
  unknown.worktrees[1] = { ...unknown.worktrees[1], ahead: null, behind: null };
  assert.equal(hostHealth(snapshot(unknown), now).verdict, "progress");
});

test("housekeeping counts an unreadable checkout once when Git reports its aggregate failure", () => {
  const now = Date.now(),
    p = fixture(now);
  p.sources.git.state = "unavailable";
  p.worktrees = [{ ...p.worktrees[0], error: "Unreadable Git state" }];
  const result = hostHealth(
    {
      version: 1,
      host: "studio",
      collectedAt: now,
      projects: [p],
      unassignedSessions: [],
    },
    now,
  );
  assert.equal(result.errors, 1);
  assert.equal(result.verdict, "cleanup");
});

test("an explicit work reference links a PR even when the native session started on main", async () => {
  const { rows } = await import("../src/work-view");
  const { issue } = await import("./work-fixtures");
  const now = Date.now(),
    p = fixture(now);
  p.pulls = [
    {
      number: 10,
      title: "Unrelated title",
      url: "https://github.com/org/repo/pull/10",
      branch: "feature/new",
      draft: false,
      checks: "passing",
      updatedAt: now,
      workIssues: [7],
    },
  ];
  const work = { issues: [issue(7)], observedAt: now };
  const scan = {
    version: 1 as const,
    host: "studio",
    collectedAt: now,
    projects: [p],
    unassignedSessions: [],
  };
  assert.equal(rows([scan], work, now)[0].pulls.length, 1);
  assert.equal(rows([scan], work, now + 360000)[0].pulls.length, 0);
});

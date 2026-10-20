import { test } from "node:test";
import assert from "node:assert/strict";
import { recordHeader } from "../src/upkeep-model";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  candidates,
  choice,
  classify,
  declaration,
  handleHook,
  prune,
} from "../hooks/work-item";
import { workIssueRefs } from "../collector/collect";
import {
  cacheIssues,
  readIssues,
  readWork,
  workDirectory,
} from "../collector/work";
import { currentWork, issueRepo } from "../src/work-model";
import { issue } from "./work-fixtures";
const unavailable = async () => {
  throw Error("offline");
};
const cache = (home: string) => path.join(workDirectory(home), "issues.json");
async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "work-hooks-"));
  await cacheIssues(home, [issue(7)]);
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
test("only an explicit work selection is accepted, never prose mentioning an issue", () => {
  assert.equal(choice("Please fix #7"), undefined);
  assert.equal(choice("work: #7\nContinue the fix"), 7);
  assert.equal(choice("work: 7"), 7);
  assert.equal(choice("work: none"), null);
  assert.equal(choice("work: #7 or #8"), undefined);
  assert.equal(choice("work: WORK-TEST"), undefined);
  assert.equal(choice("Here is a quote:\nwork: #7"), undefined);
});
test("the assistant declares on its first or last line only", () => {
  assert.equal(declaration("Fixed the reader.\n\nwork: #7\n"), 7);
  assert.equal(declaration("work: none\nQuick answer: 42"), null);
  assert.equal(declaration("I chose #7 for this."), undefined);
  assert.equal(declaration("Start\nwork: #7\nEnd"), undefined);
  assert.equal(declaration(""), undefined);
});
test("unknown sessions ask; explicit selection survives resume, end and re-opening without storing prompts", async () =>
  fixture(async (home) => {
    const input = {
      session_id: "session-1",
      cwd: home,
      hook_event_name: "UserPromptSubmit",
      prompt: "SECRET original prompt",
    };
    const first = await handleHook(input, "Codex", home);
    assert.match(JSON.stringify(first), /Classify it yourself/);
    assert.match(JSON.stringify(first), /"issue\\":\\"#7\\"/);
    assert.doesNotMatch(JSON.stringify(first), /SECRET/);
    await handleHook({ ...input, prompt: "work: #7" }, "Codex", home);
    const resumed = await handleHook(
      { ...input, hook_event_name: "SessionStart" },
      "Codex",
      home,
    );
    assert.match(JSON.stringify(resumed), /work issue #7 \(Issue 7\) by the user/);
    await handleHook(
      { ...input, hook_event_name: "SessionEnd" },
      "Codex",
      home,
    );
    let result = await readWork(home, unavailable, "acme/work");
    assert.equal(result.associations[0].state, "ended");
    assert.equal(result.associations[0].issue, 7);
    const contents = await Promise.all(
      (await readdir(path.join(workDirectory(home), "sessions"))).map((f) =>
        readFile(path.join(workDirectory(home), "sessions", f), "utf8"),
      ),
    );
    assert.ok(!contents.join("").includes("SECRET"));
    await handleHook(
      { ...input, hook_event_name: "SessionStart" },
      "Codex",
      home,
    );
    result = await readWork(home, unavailable, "acme/work");
    assert.equal(result.associations[0].state, "open");
  }));
test("a session is recorded from its first prompt; old records are pruned", async () =>
  fixture(async (home) => {
    const dir = path.join(workDirectory(home), "sessions");
    const input = { session_id: "opened", cwd: home };
    const event = (hook_event_name: string, extra = {}) =>
      handleHook({ ...input, hook_event_name, ...extra }, "Codex", home);
    // A thread the app opens and never uses still gets candidates, no record.
    assert.match(
      JSON.stringify(await event("SessionStart")),
      /Classify it yourself/,
    );
    await event("SessionEnd");
    assert.deepEqual(await readdir(dir), []);
    await event("UserPromptSubmit", { prompt: "Fix it" });
    await event("SessionEnd");
    await event("SessionStart");
    const { associations } = await readWork(home, unavailable, "acme/work");
    assert.deepEqual(
      associations.map((a) => [a.sessionId, a.state]),
      [["opened", "open"]],
    );
    // A first Stop also records: hooks may be installed mid-session.
    await handleHook(
      {
        session_id: "mid",
        cwd: home,
        hook_event_name: "Stop",
        last_assistant_message: "work: #7",
      },
      "Codex",
      home,
    );
    assert.equal((await readdir(dir)).length, 2);
    const old = path.join(dir, "old.json");
    await writeFile(old, "{}");
    const weeksAgo = new Date(Date.now() - 43 * 86400_000);
    await utimes(old, weeksAgo, weeksAgo);
    await prune(dir);
    assert.equal((await readdir(dir)).length, 2);
    await writeFile(old, "{}");
    await utimes(old, weeksAgo, weeksAgo);
    await event("SessionStart");
    assert.ok(!(await readdir(dir)).includes("old.json"));
  }));
test("Claude and Codex identities are separate; unknown issues never overwrite a confirmed choice", async () =>
  fixture(async (home) => {
    const input = {
      session_id: "same",
      cwd: home,
      hook_event_name: "UserPromptSubmit",
      prompt: "work: #7",
    };
    await handleHook(input, "Claude", home);
    const reply = await handleHook(
      { ...input, prompt: "work: #999" },
      "Claude",
      home,
    );
    assert.match(JSON.stringify(reply), /could not be verified/);
    await handleHook({ ...input, prompt: "work: none" }, "Codex", home);
    const { associations } = await readWork(home, unavailable, "acme/work");
    assert.equal(associations.find((a) => a.app === "Claude")?.issue, 7);
    assert.equal(
      associations.find((a) => a.app === "Codex")?.selection,
      "untracked",
    );
  }));
test("closed issues are not offered but stay linked; issues that left the list ask again; a missing or old list is said, not guessed", async () =>
  fixture(async (home) => {
    const input = {
      session_id: "test",
      cwd: home,
      hook_event_name: "UserPromptSubmit",
      prompt: "work: #7",
    };
    const ask = async (prompt = "Continue", session = "test") =>
      JSON.stringify(
        await handleHook(
          { ...input, session_id: session, prompt },
          "Codex",
          home,
        ),
      );
    await ask("work: #7");
    await cacheIssues(home, [issue(7, { open: false }), issue(8)]);
    assert.match(await ask(), /linked to work issue #7/);
    const other = await ask("Continue", "other");
    assert.match(other, /#8/);
    assert.doesNotMatch(other, /#7/);
    await utimes(cache(home), new Date(), new Date(Date.now() - 3 * 86400_000));
    assert.match(await ask("Continue", "other"), /last refreshed 3d ago/);
    await cacheIssues(home, [issue(8)]);
    assert.match(await ask(), /Classify it yourself/);
    await rm(cache(home));
    assert.match(await ask(), /issue list is unavailable/);
    await ask("work: none");
    assert.match(await ask(), /leave this session untracked/);
  }));
test("issues carry type, milestone, customer and repo labels; a failed or truncated read is unavailable, never empty", async () => {
  const raw = (number: number, over = {}) => ({
    number,
    title: `Issue ${number}`,
    body: "Status <!-- hidden --> text",
    url: `https://github.com/acme/work/issues/${number}`,
    state: "OPEN",
    issueType: { name: "Feature" },
    labels: [
      { name: "work" },
      { name: "customer:Acme" },
      { name: "repo:widgets" },
      { name: "repo:bad name" },
    ],
    milestone: { title: "Reporting", description: "Reports for Acme" },
    updatedAt: "2026-09-17T00:00:00Z",
    ...over,
  });
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api")
      return JSON.stringify({
        data: {
          repository: {
            i1: { comments: { nodes: [] } },
            i2: { comments: { nodes: [] } },
            i3: { comments: { nodes: [] } },
          },
        },
      });
    return JSON.stringify(
      args.includes("closed")
        ? [raw(2, { state: "CLOSED", issueType: null, milestone: null })]
        : [
            raw(1),
            // The standing upkeep issue records the harness versions its research last reviewed.
            raw(3, {
              labels: [{ name: "work" }, { name: "upkeep" }],
              body: `Agent upkeep.\n\n## Upkeep\nReviewed versions: Claude Code 2.1.303, Codex 0.162.1 (2026-10-26)\n${"x".repeat(900)}\n${recordHeader}\n| 2026-11-02 | Formatter ([#140](https://github.com/acme/projects/pull/140)) | failed commands, Claude, all machines | 14 in 9 sessions, 7 days to 2026-11-02 | not yet | runner/instructions.test.ts | watching |`,
            }),
          ],
    );
  };
  const now = Date.parse("2026-09-17T12:00:00Z");
  const issues = await readIssues(gh, "acme/work", now);
  assert.deepEqual(issues[0], {
    number: 1,
    title: "Issue 1",
    body: "Status  text",
    position: null,
    details: { people: [], commitments: [], combinedFrom: [], splitFrom: [], continuesAs: [] },
    emailLinks: [],
    area: "business",
    latestUpdate: null,
    updatesState: "ok",
    url: "https://github.com/acme/work/issues/1",
    open: true,
    kind: "feature",
    initiative: { title: "Reporting", capability: "Reports for Acme" },
    customers: ["Acme"],
    repos: ["acme/widgets"],
    updatedAt: Date.parse("2026-09-17T00:00:00Z"),
  });
  assert.equal(issues[1].upkeep, true);
  assert.deepEqual(issues[1].reviewed, { claude: "2.1.303", codex: "0.162.1", on: "2026-10-26" });
  // Its record of changes, read from the whole body.
  assert.deepEqual(issues[1].changes?.map((c) => [c.date, c.measure, c.before, c.after, c.state]), [
    ["2026-11-02", { category: "commandFailed", app: "Claude", machine: null }, { count: 14, sessions: 9, days: 7, to: "2026-11-02" }, null, "watching"],
  ]);
  assert.equal(issues[0].changes, undefined);
  assert.equal(issues[1].area, "unassigned");
  assert.equal(issues[0].upkeep, undefined);
  assert.equal(issues[0].reviewed, undefined);
  assert.deepEqual(
    [issues[2].open, issues[2].kind, issues[2].initiative],
    [false, null, null],
  );
  assert.ok(
    calls
      .filter((c) => c[0] === "issue")
      .every((c) => c.includes("acme/work")),
  );
  assert.ok(
    calls
      .filter((c) => c[0] === "issue")
      .every((c) => c[c.indexOf("--label") + 1] === "work"),
  );
  assert.equal(calls[1].at(-1), "closed:>=2026-08-27");
  await assert.rejects(
    readIssues(
      async () =>
        JSON.stringify(Array.from({ length: 300 }, (_, i) => raw(i + 1))),
      "acme/work",
    ),
  );
  const home = await mkdtemp(path.join(tmpdir(), "work-read-"));
  try {
    assert.equal((await readWork(home, unavailable, "acme/work")).issues, null);
    assert.equal((await readWork(home, gh, "acme/work")).issues?.length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  // The newest scan that could read GitHub supplies the issues.
  const scan = (collectedAt: number, list: typeof issues | null) => ({
    collectedAt,
    work: { issues: list, associations: [], associationsState: "ok" as const },
  });
  assert.equal(
    currentWork([scan(1, issues), scan(2, [issues[0]]), scan(3, null)])
      ?.observedAt,
    2,
  );
  assert.equal(currentWork([scan(3, null)]), undefined);
});
test("the assistant's final-message declaration is saved as its own classification, never over the user's reply", async () =>
  fixture(async (home) => {
    const input = { session_id: "auto", cwd: home, hook_event_name: "Stop" };
    const stop = (last_assistant_message: string) =>
      handleHook({ ...input, last_assistant_message }, "Claude", home);
    const linked = async () =>
      (await readWork(home, unavailable, "acme/work")).associations[0];
    await stop("Done.\n\nwork: #7");
    assert.equal((await linked()).issue, 7);
    assert.equal((await linked()).by, "assistant");
    const resumed = await handleHook(
      { ...input, hook_event_name: "SessionStart" },
      "Claude",
      home,
    );
    assert.match(JSON.stringify(resumed), /your own classification/);
    // An unknown issue or prose mention changes nothing.
    await stop("work: #999");
    await stop("Switching to #8 now");
    assert.equal((await linked()).issue, 7);
    // The assistant may reclassify its own choice, including to untracked.
    await stop("work: none\nJust a question.");
    assert.equal((await linked()).selection, "untracked");
    assert.equal((await linked()).by, "assistant");
    // The user's explicit reply wins and later declarations cannot displace it.
    await handleHook(
      { ...input, hook_event_name: "UserPromptSubmit", prompt: "work: #7" },
      "Claude",
      home,
    );
    await stop("work: none");
    assert.equal((await linked()).issue, 7);
    assert.equal((await linked()).by, "user");
    assert.match(
      JSON.stringify(
        await handleHook(
          { ...input, hook_event_name: "SessionStart" },
          "Claude",
          home,
        ),
      ),
      /by the user/,
    );
  }));
test("candidates are what the user worked on lately: same branch first, then recent, then unlinked issues for this repo; idle and closed issues drop out", () => {
  const now = Date.now(),
    day = 86400_000;
  const [OLD, NEW, BRANCH, RECENT, ELSEWHERE, ELSEWHERE_NEW, CLOSED] = [
    1, 2, 3, 4, 5, 6, 7,
  ];
  const issues = [
    issue(OLD),
    issue(NEW),
    issue(BRANCH),
    issue(RECENT),
    issue(ELSEWHERE, { repos: ["org/other"] }),
    issue(ELSEWHERE_NEW, { repos: ["org/other"] }),
    issue(CLOSED, { open: false }),
  ];
  const link = (
    number: number,
    updatedAt: number,
    branch: string | null = null,
    cwd = "/somewhere",
  ) => ({
    app: "Codex" as const,
    sessionId: `s-${number}-${updatedAt}`,
    cwd,
    repo: "org/repo",
    branch,
    issue: number,
    selection: "confirmed" as const,
    state: "ended" as const,
    updatedAt,
  });
  const here = {
    app: "Claude" as const,
    sessionId: "me",
    repo: "org/repo",
    branch: "feature/x",
    cwd: "/repo/wt",
  };
  const list = candidates(
    issues,
    [
      link(OLD, now - 40 * day),
      link(RECENT, now - 2 * day),
      link(BRANCH, now - 10 * day, "feature/x"),
      link(ELSEWHERE, now - 1 * day),
      link(CLOSED, now - 1 * day, "feature/x"),
    ],
    here,
    now,
  );
  assert.deepEqual(
    list.map((c) => c.issue),
    [BRANCH, RECENT, ELSEWHERE, NEW],
  );
  assert.equal(list[0].continuation, true);
  assert.equal(list[3].active, null);
  // A continuation on the main branch is by folder only.
  const onMain = candidates(
    issues,
    [link(OLD, now - 40 * day, "main", "/repo/wt")],
    { ...here, branch: "main" },
    now,
  );
  assert.equal(onMain[0].issue, OLD);
  // With nothing linked yet, this repository's open issues are offered;
  // outside any repository, every open issue is.
  assert.equal(candidates(issues, [], here, now).length, 4);
  assert.equal(candidates(issues, [], { ...here, repo: null }, now).length, 6);
});
test("malformed stored associations are not silently overwritten", async () =>
  fixture(async (home) => {
    await handleHook(
      {
        session_id: "a",
        cwd: home,
        hook_event_name: "UserPromptSubmit",
        prompt: "Continue",
      },
      "Claude",
      home,
    );
    const dir = path.join(workDirectory(home), "sessions");
    const name = (await readdir(dir))[0];
    await writeFile(path.join(dir, name), "invalid");
    await assert.rejects(
      handleHook(
        { session_id: "a", cwd: home, hook_event_name: "SessionStart" },
        "Claude",
        home,
      ),
    );
    assert.equal(
      (await readWork(home, unavailable, "acme/work")).associationsState,
      "unavailable",
    );
  }));

test("installer preserves unrelated settings and hooks and is idempotent", async () =>
  fixture(async (home) => {
    const { execFileSync } = await import("node:child_process");
    const fakeRepo = path.join(home, "repo");
    await mkdir(path.join(fakeRepo, "scripts"), { recursive: true });
    await mkdir(path.join(fakeRepo, ".local"));
    await writeFile(
      path.join(fakeRepo, "scripts/install-hooks.mjs"),
      await readFile("scripts/install-hooks.mjs", "utf8"),
    );
    await writeFile(
      path.join(fakeRepo, ".local/work-item.mjs"),
      "// test bundle",
    );
    await mkdir(path.join(home, ".claude"));
    const script = path.join(
      home,
      ".local/share/project-overview/work-item.mjs",
    );
    await writeFile(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "existing" }] }],
          // An earlier installation under a node keg that has since gone.
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: `'/opt/homebrew/Cellar/node/1.0.0/bin/node' '${script}' Claude`,
                },
              ],
            },
          ],
        },
      }),
    );
    const run = () =>
      execFileSync(
        process.execPath,
        [path.join(fakeRepo, "scripts/install-hooks.mjs")],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
    run();
    run();
    const config = JSON.parse(
      await readFile(path.join(home, ".claude/settings.json"), "utf8"),
    );
    assert.deepEqual(config.permissions, { allow: ["Read"] });
    assert.equal(config.hooks.Stop.length, 2);
    assert.equal(config.hooks.Stop[0].hooks[0].command, "existing");
    assert.equal(config.hooks.SessionStart.length, 1);
    assert.equal(config.hooks.SessionEnd.length, 1);
    const commands = Object.values(
      config.hooks as Record<string, { hooks: { command: string }[] }[]>,
    ).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    assert.ok(
      commands.every((c) => !c.includes("/Cellar/")),
      "stable node path",
    );
    assert.equal(
      commands.filter((c) => c.endsWith(`'${script}' Claude`)).length,
      4,
    );
    assert.ok(
      (await readdir(path.join(home, "agent-config-backups"))).length >= 1,
    );
  }));

test("work items come from the configured repository only", () => {
  const body =
    "Closes https://github.com/acme/work/issues/12, acme/work#13 and acme/work#13; not acme/workshop#14 or acme/other#15 or acme/work#0.";
  assert.deepEqual(workIssueRefs(body, "acme/work"), [12, 13]);
  assert.deepEqual(workIssueRefs("acme/w.rk#3 acme/wxrk#4", "acme/w.rk"), [3]);
  assert.deepEqual(workIssueRefs(body), [], "no work repository, no work items");
  assert.equal(issueRepo([issue(7)]), "acme/work");
  assert.equal(issueRepo([]), undefined);
  assert.match(classify([], 0, "acme/work"), /labelled "work" in acme\/work/);
});

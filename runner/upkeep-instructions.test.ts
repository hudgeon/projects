import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { executeRun } from "./engine";
import { researchSources, researchStatus, standingReview, upkeepEvidence, upkeepInstructions } from "./upkeep-instructions";
import { UPKEEP_SOURCES, UPKEEP_SOURCE_HOSTS } from "../src/upkeep-model";
import { cacheIssues } from "../collector/work";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyCounts, type FrictionApp, type FrictionCounts } from "../src/friction-model";
import { complete, dispatch, engineOptions, fixture, makeRun, result } from "./run-fixtures";

const owner = { email: "owner@example.com", name: "Owner" };
// Monday 26 October 2026, 06:00 UTC: the week is 20 to 26 October.
const now = Date.UTC(2026, 9, 26, 6);
const day = (date: string, app: FrictionApp, sessions: number, over: Partial<FrictionCounts>) => ({
  date,
  app,
  sessions,
  counts: { ...emptyCounts(), ...over },
});
const studio = {
  observedAt: now - 60_000,
  versions: { claude: "2.1.0", codex: "0.50.0", codexLatest: "0.51.0" },
  days: [
    day("2026-10-25", "Claude", 3, { prompts: 30, toolCalls: 200, commandFailed: 4, denied: 1 }),
    day("2026-10-21", "Claude", 2, { prompts: 10, toolCalls: 80, commandFailed: 2 }),
    day("2026-10-24", "Codex", 1, { prompts: 5, toolCalls: 40 }),
    day("2026-10-15", "Claude", 4, { prompts: 20, toolCalls: 100, hookFailed: 3 }),
    // Fourteen days back: outside both windows.
    day("2026-10-12", "Codex", 2, { prompts: 8, toolCalls: 30, compactions: 1 }),
  ],
  state: "ok" as const,
  message: "Receipts for 12 sessions.",
};
const activity = [
  { host: "studio", observedAt: now - 60_000, friction: studio, projects: [] },
  { host: "laptop", observedAt: now - 120_000, friction: { observedAt: now - 120_000, versions: {}, days: [], state: "unavailable" as const, message: "Native transcripts are unavailable on this machine." }, projects: [] },
  { host: "older", observedAt: now - 180_000, projects: [] },
];
// The standing issue last reviewed the versions the day before this cycle.
const review = { versions: { claude: "2.0.9", codex: "0.50.0", on: "2026-10-19" }, refreshedAt: now - 60_000 };
const config = { id: "agent-config", name: "Agent config", cwd: "/srv/code/agent-config", plan: null, repo: "acme/agent-config" };
const brief = (over: Partial<Parameters<typeof upkeepInstructions>[0]> = {}) =>
  upkeepInstructions({
    activity,
    host: "studio",
    stateDir: "/Users/owner/.local/share/project-overview/runner",
    frictionDir: "/Users/owner/.local/share/project-overview/friction",
    projects: [config, { id: "acme/work", name: "Work", cwd: "/srv/code/work", plan: null, repo: "acme/work" }],
    configRepo: "acme/agent-config",
    workRepo: "acme/work",
    run: { workIssue: 1280 },
    reviewed: review,
    person: owner,
    now,
    ...over,
  });

test("the evidence is each machine's versions and totals for the last week and the week before, from its latest snapshot", () => {
  const lines = upkeepEvidence(activity, now).split("\n");
  assert.equal(lines[0], "- studio (snapshot 2026-10-26T05:59:00.000Z): Claude Code 2.1.0, Codex 0.50.0 (0.51.0 available). Last 7 days: Claude: 5 sessions, 40 prompts, 280 tool calls: 6 failed commands, 1 denied tool uses; Codex: 1 session, 5 prompts, 40 tool calls: no friction seen. The 7 days before: Claude: 4 sessions, 20 prompts, 100 tool calls: 3 hook failures.");
  assert.equal(lines[1], "- laptop (snapshot 2026-10-26T05:58:00.000Z): no versions seen. Friction unavailable: Native transcripts are unavailable on this machine.");
  assert.equal(lines[2], "- older (snapshot 2026-10-26T05:57:00.000Z): no friction totals; its collector predates them.");
  assert.match(upkeepEvidence([], now), /^No machine snapshot is available/);
  assert.match(upkeepEvidence("not activity", now), /^No machine snapshot is available/);
});

test("the brief says where the receipts are, names the record and the configuration repository, and addresses the owner", () => {
  const text = brief();
  assert.match(text, /^This is Projects' upkeep lane: a weekly cycle/);
  assert.ok(text.includes(upkeepEvidence(activity, now)));
  assert.match(text, /On this machine \(studio\) each native session has one receipt under \/Users\/owner\/\.local\/share\/project-overview\/friction/);
  assert.match(text, /never transcript text/);
  assert.match(text, /Jev run-check receipts are under \/Users\/owner\/\.local\/share\/project-overview\/runner/);
  assert.match(text, /`npm run friction -- --since 7d --top 10`/);
  assert.match(text, /dispatch a read child for that detail/);
  assert.match(text, /reads them over SSH, read-only, with the login this machine already has \(never adding keys or changing SSH configuration\)/);
  assert.match(text, /Read and copy counts only: never transcripts, credentials or anything else on that machine/);
  assert.match(text, /The standing upkeep issue is #1280 in acme\/work, linked to this conversation\./);
  assert.match(text, /before measure and the after measure/);
  assert.match(text, /account for it in workRecord/);
  assert.match(text, /The shared configuration repository is acme\/agent-config, registered here as project agent-config: dispatch change children into that project/);
  assert.match(text, /Machine-local settings \(machine\.json, service jobs, keychains\) and credentials are out of scope; nothing touches them/);
  assert.match(text, /under Owner's standing approval/);
  assert.match(text, /so Owner's move is to review and merge it/);
  assert.match(text, /no move for Owner/);
  assert.doesNotMatch(text, /\bthe user\b/);
  const plain = brief({ person: undefined });
  assert.match(plain, /no move for the user/);
  assert.match(plain, /under the user's standing approval/);
});

test("the brief states the rules: evidence thresholds, a baseline cycle, one guarded change, delivery and sync, and what ends blocked", () => {
  const text = brief();
  const rules = text.slice(text.indexOf("Rules:"));
  for (const phrase of [
    "1. Evidence first. A pattern counts when it appears in at least three sessions over at least two days, or when any category stopped a turn",
    "Anything less is noted, not fixed.",
    "2. A standing issue with no recorded baseline makes this a baseline cycle",
    "change nothing else",
    "3. One change per cycle, the smallest that removes the cause: prefer a hook, a test, a skill step or a runner prompt or flag over more instruction prose. A repository AGENTS.md stays under 40 lines.",
    "4. Every change names the measure it should move and ships with a guard that keeps it moved",
    "5. Delivery follows each repository's own gates and the deploy skill, then the configuration repository's sync on every connected machine, with the before measure recorded in the standing issue before the change lands.",
    "revises or reverts a change whose measure did not move",
    "6. Hooks, skills, tests and runner prompts and flags deliver under Owner's standing approval. An edit to the shared global rules or to any repository AGENTS.md ends as blocked: the child opens the pull request and stops",
    "7. \"No change needed\" is a complete result: one line, no move for Owner, with the versions reviewed recorded in the standing issue.",
  ])
    assert.ok(rules.includes(phrase), phrase);
  assert.equal(rules.match(/^\d+\. /gm)?.length, 14);
});

test("the brief closes the loop: what moved means, revised once or reverted, kept guards stay, the guard each change gets, and who keeps the record", () => {
  const text = brief();
  const rules = text.slice(text.indexOf("Rules:"));
  for (const phrase of [
    "10. A friction measure moved when it fell: over a window of as many days as its before measure, ending today and wholly after the day the change landed, the count per session is at least a quarter lower than before and at least three below what the before rate predicts for the window's sessions. Short of either margin, or higher, it did not move.",
    "is not yet measurable: the change stays watching and is never counted as not moved.",
    "11. A change whose measure did not move is revised once or reverted.",
    "a revision whose measure does not move is reverted, and the change it revised with it. A revert goes through the same delivery path as a change, under rules 5 and 6, without counting as the cycle's one change: its row names the revert's pull request as soon as it is open, and becomes reverted once it lands.",
    "12. A change whose measure moved is kept: its row gets the after measure and the state kept, and its guard stays in place, named in the record;",
    "13. The guard fits the change: in the Projects repository a runner prompt gets an instructions test beside it",
    "a hook gets its own check in the repository that holds it; a shared rule or skill gets the configuration repository's own check; anything else gets a friction category the next cycle compares. Name that guard when you dispatch the change child; its row names the guard it added.",
    "14. The cycle's change child keeps the record, after re-reading the body and keeping everything else in it: a new change's row goes in as waiting, with its pull request link and before measure, before the change lands,",
  ])
    assert.ok(rules.includes(phrase), phrase);
  assert.match(text, /\n\nClosing the loop\. The standing issue's record of changes is not in this machine's work item cache yet/);
});

test("without a linked issue or a registered configuration repository, the brief says what that means for the cycle", () => {
  const unlinked = brief({ run: { workIssue: null } });
  assert.match(unlinked, /No standing upkeep issue is linked: the work items show no open issue labelled upkeep in acme\/work\. Before recording anything, have a change child create it there \(an issue labelled work and upkeep/);
  assert.match(brief({ run: { workIssue: null }, workRepo: undefined }), /Without a work repository on this machine \(workRepo in machine\.json\) nothing can be recorded: report that as blocked/);
  assert.match(brief({ projects: [] }), /acme\/agent-config, but it is not registered as a project on this machine, so a change to it cannot be dispatched here until it is/);
  assert.match(brief({ configRepo: undefined }), /No configuration repository is named on this machine \(configRepo in machine\.json\), so the shared rules, skills and hooks are out of reach this cycle/);
  // The registered project is matched by repository, whatever its id, and case does not matter.
  assert.match(brief({ configRepo: "Acme/Agent-Config" }), /registered here as project agent-config/);
});

test("an upkeep conversation's coordinator gets the brief with its machine's sources", async () => {
  const dir = await fixture(), o = engineOptions(dir, { ...makeRun(), lane: "upkeep", workIssue: null, projectId: null });
  o.activity = activity;
  o.configRepo = "acme/agent-config";
  o.home = "/Users/owner";
  o.projects = [...o.projects, config];
  o.person = owner;
  const prompts: string[] = [];
  o.turn = async (opts) => {
    prompts.push(opts.prompt);
    await opts.onSession(randomUUID());
    return complete;
  };
  try {
    await executeRun(o);
    assert.match(prompts[0], /This is Projects' upkeep lane/);
    assert.match(prompts[0], /registered here as project agent-config/);
    assert.match(prompts[0], /one receipt under \/Users\/owner\/\.local\/share\/project-overview\/friction/);
    assert.match(prompts[0], /- studio \(snapshot/);
    assert.match(prompts[0], /You are Owner's Projects master/);
    assert.doesNotMatch(prompts[0], /quick work in Projects' email lane/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the research status compares each app's newest installed version with the one last reviewed and says what to read", () => {
  assert.equal(
    researchStatus(activity, review, now),
    "Claude Code: 2.1.0 installed, last reviewed 2.0.9 on 2026-10-19: read the entries after 2.0.9. Codex: 0.50.0 installed (0.51.0 is released and installed nowhere; installing it is machine-local, not a cycle's change), reviewed on 2026-10-19: nothing new to read.",
  );
  // The newest version across machines is the one compared.
  const laptop = { ...activity[0], host: "laptop", friction: { ...studio, versions: { claude: "2.1.4", codex: "0.49.0" } } };
  assert.match(researchStatus([laptop, ...activity], review, now), /^Claude Code: 2\.1\.4 installed, last reviewed 2\.0\.9 on 2026-10-19: read the entries after 2\.0\.9\. Codex: 0\.50\.0 installed/);
  assert.equal(
    researchStatus(activity, { versions: null, refreshedAt: now - 60_000 }, now),
    "Claude Code: 2.1.0 installed, no review recorded: read the entries of the last 30 days. Codex: 0.50.0 installed (0.51.0 is released and installed nowhere; installing it is machine-local, not a cycle's change), no review recorded: read the entries of the last 30 days.",
  );
  assert.match(researchStatus(activity, null, now), /no review recorded: read the entries of the last 30 days\. .* The versions last reviewed could not be read from this machine's work item cache, so every installed version counts as unreviewed\.$/);
  assert.match(researchStatus(activity, undefined, now), /could not be read from this machine's work item cache/);
  assert.match(researchStatus(activity, { ...review, refreshedAt: now - 3 * 86400_000 - 1 }, now), /This machine's work item cache was last refreshed 3 days ago, so a newer review may be missing\.$/);
  assert.equal(
    researchStatus([], review, now),
    "Claude Code: no installed version in the snapshots, last reviewed 2.0.9 on 2026-10-19: nothing to read. Codex: no installed version in the snapshots, last reviewed 0.50.0 on 2026-10-19: nothing to read.",
  );
  assert.match(researchStatus("not activity", { versions: null, refreshedAt: now }, now), /^Claude Code: no installed version in the snapshots: nothing to read\./);
});

test("the brief sets up the research: one read child on Claude, the listed sources only, a fixed proposal shape and the reviewed-versions line", () => {
  const text = brief();
  assert.match(text, /Harness research\. Claude Code: 2\.1\.0 installed, last reviewed 2\.0\.9 on 2026-10-19: read the entries after 2\.0\.9\./);
  assert.match(text, /Each cycle dispatches one read child on Claude for the research: Projects gives an upkeep read child on Claude the web for the sources below \(its fetch rules allow their hosts; it is told to read nothing else\), and gives it to no other child/);
  assert.match(text, /Send it into the registered project that holds the runner when there is one/);
  assert.match(text, /the flags in runner\/native\.ts, the prompts in runner\/instructions\.ts and runner\/master-instructions\.ts\) or on the shared rules and skills/);
  for (const line of [
    "Proposal: <the capability>, <app> <version that added it>",
    "Source: <the listed source it was read on, as a link>",
    "Applies to: <the runner flag, runner prompt, shared rule, skill or hook it bears on>",
    "Replaces: <the workaround or measured friction category it would remove, or none>",
    "Guard: <the test or check that would keep it adopted>",
    'A child that finds nothing returns "Nothing to adopt" with the versions it reviewed.',
    "a source that has moved or does not answer is reported as such, never replaced by another site.",
  ])
    assert.ok(text.includes(line), line);
  assert.ok(text.includes(`Sources. ${researchSources()}`));
  for (const source of UPKEEP_SOURCES) assert.ok(text.includes(`${source.topic} ${source.url}`), source.url);
  assert.match(researchSources(), /^Claude Code: changelog https:\/\/code\.claude\.com\/docs\/en\/changelog, hooks https:/);
  assert.match(researchSources(), /\. Codex: changelog https:\/\/learn\.chatgpt\.com\/docs\/changelog, releases https:\/\/github\.com\/openai\/codex\/releases, /);
  const rules = text.slice(text.indexOf("Rules:"));
  for (const phrase of [
    "8. Harness research runs every cycle as above: one read child on Claude, the listed sources only, proposals in the fixed shape or nothing to adopt. Without Claude on this machine the research is not run: say so in the result.",
    "9. Proposals are not instructions. Adopt one only when it removes a workaround in the runner's prompts or flags or closes a friction gap measured above, naming which; it is then the cycle's one change, or a second change when the first is a friction fix, delivered under rules 3 to 6.",
    "In a baseline cycle proposals are recorded in the standing issue for the next cycle and nothing is adopted.",
    'sets the line "Reviewed versions: Claude Code <version>, Codex <version> (YYYY-MM-DD)" under a "## Upkeep" heading in the standing issue\'s body, naming the newest installed version of each app, after re-reading the body and keeping everything else in it',
  ])
    assert.ok(rules.includes(phrase), phrase);
  assert.match(brief({ reviewed: null }), /could not be read from this machine's work item cache/);
});

test("the versions last reviewed come from this machine's work item cache, by the standing issue's number", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "upkeep-review-"));
  const issue = (number: number, over = {}) => ({
    number, title: `Issue ${number}`, body: "", url: `https://github.com/acme/work/issues/${number}`, open: true, kind: null,
    initiative: null, customers: [], repos: [], updatedAt: 1, ...over,
  });
  try {
    assert.equal(await standingReview(home, 1280), null, "no cache yet");
    await cacheIssues(home, [issue(1), issue(1280, { upkeep: true, reviewed: { claude: "2.1.303", codex: "0.162.1", on: "2026-10-26" } })]);
    const found = await standingReview(home, 1280);
    assert.deepEqual(found?.versions, { claude: "2.1.303", codex: "0.162.1", on: "2026-10-26" });
    assert.ok(found!.refreshedAt > Date.now() - 60_000);
    assert.deepEqual((await standingReview(home, 1))?.versions, null, "another issue records no review");
    assert.deepEqual((await standingReview(home, null))?.versions, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an upkeep read child is given the web for the research sources' hosts; other children are not", async () => {
  for (const lane of ["upkeep", "standard"] as const) {
    const dir = await fixture(), o = engineOptions(dir, { ...makeRun(), lane, workIssue: null, projectId: null });
    const turns: { readOnly: boolean; web?: string[] }[] = [];
    o.turn = async (opts) => {
      turns.push({ readOnly: opts.readOnly, web: opts.web });
      await opts.onSession(randomUUID());
      return turns.length === 1 ? dispatch() : turns.length === 2 ? result : complete;
    };
    try {
      await executeRun(o);
      assert.equal(turns.length, 3, lane);
      assert.deepEqual(turns.map((t) => t.readOnly), [true, true, true]);
      assert.deepEqual(turns[1].web, lane === "upkeep" ? UPKEEP_SOURCE_HOSTS : undefined, lane);
      assert.deepEqual([turns[0].web, turns[2].web], [undefined, undefined], "the master is never given the web");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

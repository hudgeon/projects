import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { executeRun } from "./engine";
import { upkeepEvidence, upkeepInstructions } from "./upkeep-instructions";
import { emptyCounts, type FrictionApp, type FrictionCounts } from "../src/friction-model";
import { complete, engineOptions, fixture, makeRun } from "./run-fixtures";

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
  assert.equal(rules.match(/^\d\. /gm)?.length, 7);
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
  o.frictionDir = "/Users/owner/.local/share/project-overview/friction";
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

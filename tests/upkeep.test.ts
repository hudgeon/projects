import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { UPKEEP_CRON, UPKEEP_RECORD_ROWS, UPKEEP_SCHEDULE, UPKEEP_SOURCES, UPKEEP_SOURCE_HOSTS, measureText, recordHeader, reviewedLine, reviewedVersions, upkeepChanges, upkeepRequestId, upkeepText, upkeepWeek, valueText } from "../src/upkeep-model";

test("a moment's upkeep week is its ISO week, in UTC", () => {
  assert.equal(upkeepWeek(Date.UTC(2026, 9, 19)), "2026-W43");
  assert.equal(upkeepWeek(Date.UTC(2026, 9, 25, 23, 59)), "2026-W43");
  assert.equal(upkeepWeek(Date.UTC(2026, 9, 26)), "2026-W44");
  assert.equal(upkeepWeek(Date.UTC(2027, 0, 1)), "2026-W53");
  assert.equal(upkeepWeek(Date.UTC(2024, 11, 30)), "2025-W01");
  assert.equal(upkeepWeek(Date.UTC(2021, 0, 3)), "2020-W53");
});

test("the week's conversation id is one UUID per portfolio and week", async () => {
  const id = await upkeepRequestId("example", "2026-W43");
  assert.ok(z.uuid().safeParse(id).success, id);
  assert.equal(id, await upkeepRequestId("example", "2026-W43"));
  assert.notEqual(id, await upkeepRequestId("example", "2026-W44"));
  assert.notEqual(id, await upkeepRequestId("other", "2026-W43"));
});

test("the Worker's cron and the local emulator's run the schedule the model names", async () => {
  for (const file of ["wrangler.jsonc", "wrangler.local.jsonc"]) {
    const crons = /"crons":\s*\[([^\]]*)\]/.exec(await readFile(file, "utf8"))?.[1] ?? "";
    assert.deepEqual(crons.match(/"[^"]+"/g)?.map((s) => JSON.parse(s)), [UPKEEP_CRON], file);
  }
  assert.equal(UPKEEP_CRON, "0 18 * * 5");
  assert.equal(UPKEEP_SCHEDULE, "Fridays at 18:00 UTC");
  assert.match(upkeepText("schedule"), /^Weekly upkeep cycle: read the friction totals/);
  assert.match(upkeepText("settings"), /^Upkeep cycle, started from Settings: /);
  assert.match(upkeepText("settings"), /"no change needed" is a complete result/);
});

test("the research sources are official pages over HTTPS, a changelog and the documentation topics for each app, on a few hosts a research child may fetch", () => {
  for (const source of UPKEEP_SOURCES) {
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:", source.url);
    assert.ok(UPKEEP_SOURCE_HOSTS.includes(url.hostname), source.url);
  }
  for (const app of ["Claude Code", "Codex"]) {
    const topics: string[] = UPKEEP_SOURCES.filter((s) => s.app === app).map((s) => s.topic);
    for (const topic of ["changelog", "hooks", "skills", "settings", "permission modes", "output formats", "MCP configuration"])
      assert.ok(topics.includes(topic), `${app}: ${topic}`);
    assert.equal(new Set(topics).size, topics.length, `${app}: one source per topic`);
  }
  assert.ok(UPKEEP_SOURCES.some((s) => s.app === "Claude Code" && s.topic === "background tasks"));
  assert.ok(UPKEEP_SOURCES.some((s) => s.app === "Codex" && s.topic === "app server"));
  assert.deepEqual(UPKEEP_SOURCE_HOSTS, ["code.claude.com", "learn.chatgpt.com", "github.com"]);
});

test("the standing issue's reviewed versions are read from the line under its Upkeep heading, and written back in the same form", () => {
  const body = "# Agent upkeep\n\n## Current position\nStatus: being worked on\n\n## Upkeep\nReviewed versions: Claude Code 2.1.303, Codex 0.162.1 (2026-10-26)\nOther notes.\n\n## People\n| Person | Role | Next action |\n";
  assert.deepEqual(reviewedVersions(body), { claude: "2.1.303", codex: "0.162.1", on: "2026-10-26" });
  assert.equal(reviewedLine({ claude: "2.1.303", codex: "0.162.1" }, "2026-10-26"), "Reviewed versions: Claude Code 2.1.303, Codex 0.162.1 (2026-10-26)");
  assert.deepEqual(reviewedVersions(`## Upkeep\n${reviewedLine({ codex: "0.163.0" }, "2026-11-02")}`), { codex: "0.163.0", on: "2026-11-02" });
  assert.deepEqual(reviewedVersions("## Upkeep\nreviewed versions: claude code 2.1.0"), { claude: "2.1.0" });
  // Only the line under the heading counts, with well-formed versions.
  assert.equal(reviewedVersions("Reviewed versions: Claude Code 2.1.303 (2026-10-26)"), null);
  assert.equal(reviewedVersions("## Upkeep\nReviewed versions: none yet"), null);
  assert.equal(reviewedVersions(`## Upkeep\nReviewed versions: Claude Code ${"9".repeat(41)}`), null);
  assert.equal(reviewedVersions("## Upkeep\n\n## People\nReviewed versions: Claude Code 2.1.303"), null);
  assert.equal(reviewedVersions(""), null);
});

// The record of changes as a change child writes it: the fixed header, then one row per change.
const pull = (n: number) => `[#${n}](https://github.com/acme/projects/pull/${n})`;
const record = (...rows: string[]) => `## Upkeep\n${reviewedLine({ claude: "2.1.304" }, "2026-11-02")}\n\n${recordHeader}\n${rows.join("\n")}\n\nNotes stay.\n\n## People\n`;
const row = (...cells: string[]) => `| ${cells.join(" | ")} |`;
const watching = row("2026-11-02", `Run the formatter before committing (${pull(140)})`, "failed commands, Claude, all machines", "14 in 9 sessions, 7 days to 2026-11-02", "not yet", "runner/instructions.test.ts", "watching");

test("the record of changes is the table under the Upkeep heading, each cell in its fixed form", () => {
  const body = record(
    watching,
    row("2026-11-03", `Shorter notes \\| one line (${pull(12)})`, "Denied tool uses, Claude Code, laptop", "6 in 4 sessions, 7 days to 2026-11-02", "1 in 1 session, 1 day to 2026-11-09", "the configuration repository's check", "Waiting"),
    row("2026-10-26", `Sandbox flag (${pull(139)}), reverted in ${pull(141)}`, "guard", "none", "fails", "runner/native.test.ts", "reverted"),
  );
  assert.deepEqual(upkeepChanges(body), [
    { date: "2026-11-02", change: `Run the formatter before committing (${pull(140)})`, measure: { category: "commandFailed", app: "Claude", machine: null }, before: { count: 14, sessions: 9, days: 7, to: "2026-11-02" }, after: null, guard: "runner/instructions.test.ts", state: "watching" },
    { date: "2026-11-03", change: `Shorter notes | one line (${pull(12)})`, measure: { category: "denied", app: "Claude", machine: "laptop" }, before: { count: 6, sessions: 4, days: 7, to: "2026-11-02" }, after: { count: 1, sessions: 1, days: 1, to: "2026-11-09" }, guard: "the configuration repository's check", state: "waiting" },
    { date: "2026-10-26", change: `Sandbox flag (${pull(139)}), reverted in ${pull(141)}`, measure: "guard", before: "none", after: "fails", guard: "runner/native.test.ts", state: "reverted" },
  ]);
  // The versions line beside it still reads, and the brief's formatters write the cells back as read.
  assert.deepEqual(reviewedVersions(body), { claude: "2.1.304", on: "2026-11-02" });
  const [first] = upkeepChanges(body)!;
  assert.equal(row(first.date, first.change, measureText(first.measure), valueText(first.before), valueText(first.after), first.guard, first.state), watching);
  assert.equal(recordHeader, "| Date | Change | Measure | Before | After | Guard | State |\n| --- | --- | --- | --- | --- | --- | --- |");
  // No table yet is no change recorded.
  assert.deepEqual(upkeepChanges("## Upkeep\nReviewed versions: Codex 0.163.0"), []);
  assert.deepEqual(upkeepChanges("No section."), []);
  assert.deepEqual(upkeepChanges(record()), []);
});

test("a record that is not in the fixed form is unreadable, never an empty record", () => {
  const swap = (from: string, to: string) => record(watching.replace(from, to));
  for (const [label, body] of [
    ["another table's header", `## Upkeep\n| Date | Change | State |\n| --- | --- | --- |\n| 2026-11-02 | x | watching |`],
    ["volume, not friction", swap("failed commands", "prompts")],
    ["an unknown category", swap("failed commands", "slow builds")],
    ["no machine", swap("Claude, all machines", "Claude")],
    ["an app neither", swap("Claude, all", "Gemini, all")],
    ["a before that is not a count", swap("14 in 9 sessions, 7 days to 2026-11-02", "about 14")],
    ["a guard measure with a count", swap("failed commands, Claude, all machines", "guard")],
    ["a count before a guard measure", swap("14 in 9 sessions, 7 days to 2026-11-02", "none")],
    ["a before count of nothing", swap("14 in 9", "0 in 9")],
    ["a window past the snapshots' days", swap("7 days to", "15 days to")],
    ["no pull request link", swap(`(${pull(140)})`, "(see the notes)")],
    ["an unknown state", swap("watching", "parked")],
    ["an extra cell", swap("| watching |", "| watching | yes |")],
    ["a second table", `${record(watching)}`.replace("Notes stay.", `| a | b |\n| --- | --- |`)],
    ["too many rows", record(...Array(UPKEEP_RECORD_ROWS + 1).fill(watching))],
  ])
    assert.equal(upkeepChanges(body), null, label);
  assert.equal(upkeepChanges(record(...Array(UPKEEP_RECORD_ROWS).fill(watching)))?.length, UPKEEP_RECORD_ROWS);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { UPKEEP_CRON, UPKEEP_SCHEDULE, UPKEEP_SOURCES, UPKEEP_SOURCE_HOSTS, reviewedLine, reviewedVersions, upkeepRequestId, upkeepText, upkeepWeek } from "../src/upkeep-model";

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
  assert.equal(UPKEEP_CRON, "0 6 * * 1");
  assert.equal(UPKEEP_SCHEDULE, "Mondays at 06:00 UTC");
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

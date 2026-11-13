import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Progress, RunMessage } from "../src/run-model";
import type { Screenshot, ScreenshotInput } from "../src/screenshot-model";
import { executeRun } from "./engine";
import { nativeTurn, type NativeOptions } from "./native";
import { engineOptions, fixture, makeRun } from "./run-fixtures";

test("Investigate reads bounded sources, replays a saved result and resumes the same restricted session", async () => {
  const dir = await fixture(), session = randomUUID();
  try {
    execFileSync("git", ["init", "-q", dir]);
    await writeFile(path.join(dir, "README.md"), "# Dispatch\nThe fixture worker writes a dispatch receipt.\n");
    execFileSync("git", ["-C", dir, "add", "README.md"]);
    await writeFile(path.join(dir, "private.md"), "Dispatch uses untracked data which must never be supplied.");
    const run = { ...makeRun(), lane: "investigate" as const, agent: "claude" as const };
    const image: ScreenshotInput = { id: randomUUID(), mime: "image/png", data: "AAAA" };
    run.messages[0].screenshots = [{...image, width: 10, height: 10, bytes: 3, sha256: "f".repeat(64)} as Screenshot];
    const initial = engineOptions(dir, run);
    const forbidden = async () => { throw Error("Unexpected browser, worktree, work record gate or connector"); };
    const turns: NativeOptions[] = [];
    const reports: Progress[] = [];
    const final = () => reports.at(-1)!;
    Object.assign(initial, {
      fullAccess: true,
      browser: forbidden, prepare: forbidden, readWorkRecord: forbidden, connectors: forbidden, mailboxToken: forbidden,
      screenshot: async () => image,
      workRepo: "acme/work",
      githubCommand: async () => JSON.stringify({data: {repository: {issue: {
        title: "Dispatch", updatedAt: "2026-10-01T00:00:00Z",
        body: "## Current position\nPosition: Dispatch receipt observed.\n", comments: {nodes: []},
      }}}}),
      turn: async (options: NativeOptions) => {
        turns.push(options);
        assert.equal(options.agent, "claude");
        assert.equal(options.readOnly, true);
        assert.equal(options.investigation, true);
        assert.equal(options.fullAccess, false);
        assert.equal(options.browser, undefined);
        assert.equal(options.connectors, undefined);
        assert.equal(options.mailbox, undefined);
        assert.deepEqual(options.screenshots, [image]);
        assert.match(options.prompt, /Dispatch receipt observed/);
        assert.doesNotMatch(options.prompt, /untracked data/);
        await options.onSession(session);
        await options.onProcess?.(8000);
        options.onUsage?.({ fresh: 32, cached: 16, output: 8, context: 48 });
        return {
          title: "Dispatch evidence", answer: "The work record reports a dispatch receipt.",
          findings: [{claim: "Dispatch receipt reported", sourceIds: [1]}],
          lastVerified: {claim: "Dispatch receipt reported", sourceIds: [1]},
          firstUnverified: "Downstream import needs an intake receipt.",
        };
      },
      report: async (p: Progress) => {
        reports.push(p);
        if (p.state === "completed" && reports.filter(report => report.state === "completed").length === 1)
          throw Error("Lost report");
      },
    });
    await assert.rejects(executeRun(initial), /Lost report/);
    await executeRun(initial);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].sessionId, undefined);
    assert.deepEqual(final().children, []);
    assert.equal(final().masterUsage?.fresh, 32);
    assert.equal(final().masterUsage?.turns, 1);
    assert.deepEqual(final().reviewedMessageIds, [run.messages[0].id]);
    assert.match(final().summary, /\[Work record\]\(https:\/\/github.com\/acme\/work\/issues\/1112\)/);
    assert.match(final().summary, /First unverified.*Downstream import/);
    const next: RunMessage = {id: randomUUID(), role: "user", text: "Please verify intake.", at: Date.now(), delivery: "queued"};
    await executeRun({ ...initial, run: { ...run, generation: 2, progress: final(),
      messages: [{...run.messages[0], delivery: "reviewed"}, next],
    } });
    assert.equal(turns.length, 2);
    assert.equal(turns[1].sessionId, session);
    assert.deepEqual(final().reviewedMessageIds, [next.id]);
    assert.equal(final().masterUsage?.turns, 2);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("the native investigation rejects a Claude startup with an unexpected tool", async () => {
  const dir = await fixture(), binary = path.join(dir, "fixture.mjs");
  try {
    await writeFile(binary, `#!/usr/bin/env node
import assert from "node:assert/strict";
for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config"]) assert.ok(process.argv.includes(flag));
assert.equal(process.argv[process.argv.indexOf("--tools") + 1], "");
process.stdin.once("data", () => {
  console.log(JSON.stringify({type:"system", subtype:"init", tools:["StructuredOutput", "Bash"], mcp_servers:[]}));
});
`, {mode: 0o700});
    await assert.rejects(nativeTurn({
      agent: "claude", cwd: dir, prompt: "Inspect", schema: {type: "object"},
      readOnly: true, investigation: true, signal: AbortSignal.timeout(5000),
      binaries: {claude: binary}, onSession: async () => {},
    }), /could not confirm its restricted tool profile/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

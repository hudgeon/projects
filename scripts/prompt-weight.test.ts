import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewsDir } from "../runner/project-turn";
import { git } from "../runner/workspaces";
import { fixture } from "../tests/project-fixtures";
import { formatWeight, storedConversations, weigh, weight } from "./prompt-weight";

test("a stored conversation replays through the engine with stand-in turns, and its prompts are counted", async () => {
  const { cwd, options } = await fixture();
  const stateDir = path.join(cwd, ".state"),
    run = randomUUID(),
    helper = randomUUID();
  // A reply's id is its conversation's and turn's, not a UUID of its own.
  const message = (role: "user" | "master", text: string, at: number) => ({ id: role === "user" ? randomUUID() : `${run}:${at}`, role, text, at });
  try {
    await mkdir(path.join(stateDir, "runs"), { recursive: true });
    await mkdir(reviewsDir(stateDir), { recursive: true });
    await writeFile(
      path.join(stateDir, "runs", `${run}.json`),
      JSON.stringify({
        generation: 2,
        phase: "finished",
        pid: null,
        progress: {
          seq: 9,
          state: "completed",
          summary: "Done",
          masterSessionId: randomUUID(),
          children: [
            { id: helper, projectId: options.project.id, agent: "claude", mode: "read", cwd, branch: "main", sessionId: randomUUID(), state: "completed", result: { outcome: "completed", summary: "RECORDED-REPORT", checks: ["Read the importer"], links: [] }, evidence: ["Observed HEAD: abc"] },
            { id: randomUUID(), projectId: "gone/project", agent: "claude", mode: "read", cwd, branch: "main", sessionId: null, state: "completed", result: null, evidence: [] },
          ],
        },
      }),
    );
    await writeFile(
      path.join(stateDir, "runs", `${run}.context.json`),
      JSON.stringify([message("user", "Inspect the importer", 100), message("master", "It keeps the pipe delimiter.", 300), message("user", "Thanks, and the archive?", 400), message("master", "Archived after a week.", 500)]),
    );
    // A journal without its messages is not a conversation to replay.
    await writeFile(path.join(stateDir, "runs", `${randomUUID()}.json`), JSON.stringify({ progress: { children: [] } }));
    await writeFile(path.join(reviewsDir(stateDir), `0000000000200-${run.slice(0, 8)}-${helper.slice(0, 8)}.json`), JSON.stringify({ runId: run, actor: helper, at: 200, projectId: options.project.id, input: { task: "read: RECORDED-TASK" } }));
    await writeFile(path.join(reviewsDir(stateDir), `0000000000150-${run.slice(0, 8)}-master.json`), JSON.stringify({ runId: run, actor: "master", at: 150, projectId: options.project.id, input: { task: "Coordinate" } }));
    const before = await git(cwd, ["status", "--porcelain"]);
    const [conversation, ...others] = await storedConversations(stateDir);
    assert.equal(others.length, 0);
    assert.equal(conversation.projectId, options.project.id);
    assert.deepEqual(conversation.tasks[helper], { at: 200, task: "RECORDED-TASK" });
    const turns = await weigh(conversation, { projects: [options.project], masterCwd: cwd, host: "studio", mode: "off" });
    assert.deepEqual(
      turns!.map((t) => [t.kind, t.resumed]),
      [["coordinator", false], ["helper", false], ["coordinator", true], ["coordinator", true]],
      "the first request dispatches its helper and hears its report; the follow-up resumes the coordinator",
    );
    assert.ok(turns!.every((t) => t.chars > 0 && t.images === 0));
    assert.equal(await git(cwd, ["status", "--porcelain"]), before, "the project is left as it was");
    assert.equal((await git(cwd, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)!.length, 1);
    const report = weight([turns!], 1);
    assert.equal(report.turns, 4);
    assert.equal(report.kinds["coordinator, resumed"].turns, 2);
    assert.equal(report.charsPerTurn, turns!.reduce((n, t) => n + t.chars, 0) / 4);
    const text = formatWeight(report, "Fixture");
    assert.match(text, /Conversations 1 replayed, 1 the engine could not follow: 4 native turns/);
    assert.doesNotMatch(text, /RECORDED/, "counts only");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

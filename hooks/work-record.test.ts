import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheIssues, readAssociations } from "../collector/work";
import { recordHash } from "../collector/work-record";
import { issue } from "../tests/work-fixtures";
import { handleHook } from "./work-item";
const position = (stamp: string, text: string) =>
  `## Current position\nStatus: being worked on. Reviewed: 2026-10-26.\nEvidence checked: ${stamp}\nOutcome / why now: Finish acceptance.\nPosition: ${text}\nNext: Review.\n`;
test("native Stop independently verifies the linked record and leaves a failed read unverified", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "native-record-"));
  try {
    let body = position("2026-10-25T00:00:00.000Z", "Draft");
    await cacheIssues(home, [issue(7, { recordHash: recordHash(body) })]);
    const input = {
      session_id: "test-1",
      cwd: home,
      hook_event_name: "UserPromptSubmit",
      prompt: "work: #7",
    };
    await handleHook(input, "Codex", home);
    const stop = {
      ...input,
      hook_event_name: "Stop",
      last_assistant_message: "Done\nwork: #7",
    };
    const read = async (_repo: string, number: number) => ({
      number,
      body,
      url: `https://github.com/acme/work/issues/${number}`,
    });
    await handleHook(stop, "Codex", home, read);
    assert.equal(
      (await readAssociations(home)).associations[0].recordReview,
      "unverified",
    );
    body = position(new Date().toISOString(), "Delivered; acceptance remains");
    await handleHook(stop, "Codex", home, read);
    assert.equal(
      (await readAssociations(home)).associations[0].recordReview,
      "verified",
    );
    await handleHook(stop, "Codex", home, async () => {
      throw Error("offline");
    });
    assert.equal(
      (await readAssociations(home)).associations[0].recordReview,
      "unverified",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

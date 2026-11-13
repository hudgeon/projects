import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readAssociations } from "../collector/work";
import { handleHook } from "./work-item";

const row = (sessionId: string, tokens: number, entrypoint = "claude-desktop", isSidechain = false) =>
  JSON.stringify({ sessionId, entrypoint, isSidechain, type: "assistant", message: { usage: {
    input_tokens: 1, cache_creation_input_tokens: 1_000, cache_read_input_tokens: tokens - 1_001,
  } } }) + "\n";

test("Claude Desktop advises a handoff before the 150k target and keeps the user's association", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "claude-handoff-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = path.join(home, ".claude", "projects", "fixture");
  await mkdir(folder, { recursive: true });
  const transcript_path = path.join(folder, "desktop.jsonl");
  const input = { session_id: "desktop", transcript_path, cwd: home, hook_event_name: "UserPromptSubmit", prompt: "work: none" };
  await writeFile(transcript_path, row("desktop", 139_999) + row("desktop", 190_000, "claude-desktop", true));
  assert.equal((await handleHook(input, "Claude", home)).systemMessage, undefined);
  await appendFile(transcript_path, row("desktop", 140_000));
  assert.equal((await handleHook(input, "Codex", home)).systemMessage, undefined);
  const results = await Promise.all([handleHook(input, "Claude", home), handleHook(input, "Claude", home)]);
  const advised = results.filter((result) => result.systemMessage);
  assert.equal(advised.length, 1);
  assert.match(advised[0].hookSpecificOutput!.additionalContext, /leave this session untracked[\s\S]*read-only request/);
  assert.equal((await handleHook(input, "Claude", home)).systemMessage, undefined);
  assert.equal((await readAssociations(home)).associations.length, 2);
});

test("the handoff hook skips CLI, invalid transcript paths and pre-compaction usage", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "claude-handoff-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = path.join(home, ".claude", "projects", "fixture");
  await mkdir(folder, { recursive: true });
  const input = { session_id: "desktop", cwd: home, hook_event_name: "UserPromptSubmit", prompt: "work: none" };
  const check = async (transcript_path: string) => (await handleHook({ ...input, transcript_path }, "Claude", home)).systemMessage;
  const transcript = path.join(folder, "desktop.jsonl");
  assert.equal(await check(transcript), undefined);
  const outside = path.join(home, "desktop.jsonl");
  await writeFile(outside, row("desktop", 180_000));
  assert.equal(await check(outside), undefined);
  await symlink(outside, transcript);
  assert.equal(await check(transcript), undefined);
  await rm(transcript);
  await writeFile(transcript, row("desktop", 180_000, "cli"));
  assert.equal(await check(transcript), undefined);
  await writeFile(transcript, row("desktop", 180_000) + JSON.stringify({ sessionId: "desktop", type: "system", subtype: "compact_boundary" }) + "\n" + row("desktop", 180_000).trimEnd());
  assert.equal(await check(transcript), undefined);
});

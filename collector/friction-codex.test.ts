import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyCounts } from "../src/friction-model";
import { codexRecord, emptyCodexState } from "./friction-codex";

const event = (payload: Record<string, unknown>, timestamp = "2026-10-20T02:00:00.000Z") => ({
  timestamp,
  type: "event_msg",
  payload,
});
const item = (item: Record<string, unknown>) => event({ type: "item_completed", item });
const command = (command: string, status: string, exit_code: number | null) =>
  item({ type: "CommandExecution", command, status, exit_code });
test("Codex items, turns and the session's own facts are projected", () => {
  const counts = emptyCounts(),
    state = emptyCodexState();
  const records = [
    {
      timestamp: "2026-10-20T01:59:00.000Z",
      type: "session_meta",
      payload: { id: "thread-1", cli_version: "0.162.1", originator: "codex_exec", cwd: "/work/repo" },
    },
    item({ type: "UserMessage" }),
    command("npm test", "completed", 0),
    command("npm run build", "failed", 1),
    command("rm -rf dist", "declined", null),
    item({ type: "McpToolCall", server: "x", tool: "y", status: "failed" }),
    item({ type: "FileChange", status: "completed" }),
    item({ type: "ContextCompaction" }),
    item({ type: "Reasoning" }),
    event({ type: "turn_aborted" }),
    event({ type: "error" }),
    event({ type: "token_count" }),
    ...[1, 2, 3].map(() => command("ls", "completed", 0)),
  ];
  for (const record of records) codexRecord(record, counts, state);
  assert.equal(counts.prompts, 1);
  assert.equal(counts.toolCalls, 8);
  assert.equal(counts.commandFailed, 1);
  assert.equal(counts.denied, 1);
  assert.equal(counts.toolFailed, 1);
  assert.equal(counts.compactions, 1);
  assert.equal(counts.interrupted, 1);
  assert.equal(counts.apiErrors, 1);
  assert.equal(counts.repeatedCommands, 1);
  assert.equal(state.version, "0.162.1");
  assert.equal(state.client, "codex_exec");
  assert.equal(state.cwd, "/work/repo");
  assert.equal(state.id, "thread-1");
  assert.equal(state.firstAt, Date.parse("2026-10-20T01:59:00.000Z"));
  assert.equal(state.lastAt, Date.parse("2026-10-20T02:00:00.000Z"));
});
test("a completed command with a non-zero exit code is a failed command", () => {
  const counts = emptyCounts();
  codexRecord(command("grep x file", "completed", 1), counts, emptyCodexState());
  assert.equal(counts.commandFailed, 1);
  assert.equal(counts.toolCalls, 1);
});

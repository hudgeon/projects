import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyCounts } from "../src/friction-model";
import { claudeRecord, classifyError, emptyClaudeState, REPEAT_AT } from "./friction-claude";

const run = (records: unknown[]) => {
  const counts = emptyCounts(),
    state = emptyClaudeState();
  for (const record of records) claudeRecord(record, counts, state);
  return { counts, state };
};
const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  version: "2.1.299",
  entrypoint: "cli",
  cwd: "/work/repo",
  timestamp: "2026-10-20T01:00:00.000Z",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, content: unknown, error = true, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-10-20T01:05:00.000Z",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content }] },
  ...extra,
});
test("failed tool results are classified by their text and the tool they answer", () => {
  const { counts, state } = run([
    use("a", "Bash", { command: "npm test" }),
    result("a", "Exit code 1"),
    use("b", "Edit"),
    result("b", "<tool_use_error>File has not been read yet. Read it first.</tool_use_error>"),
    use("c", "Bash"),
    result("c", [{ type: "text", text: "<tool_use_error>Blocked: sleep 45 followed by a check" }]),
    use("d", "Bash"),
    result("d", "Permission for this action was denied by the user."),
    use("e", "mcp__tool__x"),
    result("e", "Something went wrong upstream"),
    use("f", "Bash"),
    result("f", "[Tool call interrupted: the session ended]"),
    use("g", "Bash"),
    result("g", "all good", false),
    use("h", "Bash", { command: "rm -rf dist" }),
    result("h", "Denied", true, { permissionDecision: { decision: "reject", source: "config" } }),
  ]);
  assert.equal(counts.toolCalls, 8);
  assert.equal(counts.commandFailed, 1);
  assert.equal(counts.misuse, 1);
  assert.equal(counts.hookBlocked, 1);
  assert.equal(counts.denied, 2);
  assert.equal(counts.toolFailed, 1);
  assert.equal(counts.interrupted, 1);
  assert.equal(counts.prompts, 0);
  assert.equal(state.version, "2.1.299");
  assert.equal(state.client, "cli");
  assert.equal(state.cwd, "/work/repo");
  assert.equal(state.firstAt, Date.parse("2026-10-20T01:00:00.000Z"));
  assert.equal(state.lastAt, Date.parse("2026-10-20T01:05:00.000Z"));
  assert.deepEqual(state.tools, {}, "answered tool uses are forgotten");
});
test("prompts, API errors, compactions, hook failures and repeated commands are counted", () => {
  const same = Array.from({ length: REPEAT_AT + 1 }, (_, i) => use(`r${i}`, "Bash", { command: "git status" }));
  const { counts } = run([
    { type: "user", message: { content: "Fix the build" } },
    { type: "user", message: { content: [{ type: "text", text: "and the tests" }] } },
    { type: "system", subtype: "api_error", retryAttempt: 2, maxRetries: 10 },
    { type: "system", subtype: "compact_boundary", level: "info" },
    { type: "system", subtype: "stop_hook_summary", hookErrors: ["hook exited 1"] },
    { type: "attachment", attachment: { type: "hook_success", exitCode: 2 } },
    { type: "attachment", attachment: { type: "hook_success", exitCode: 0 } },
    ...same,
    use("other", "Bash", { command: "git diff" }),
  ]);
  assert.equal(counts.prompts, 2);
  assert.equal(counts.apiErrors, 1);
  assert.equal(counts.compactions, 1);
  assert.equal(counts.hookFailed, 2);
  assert.equal(counts.repeatedCommands, 1, "the third run counts once, later runs do not add");
  assert.equal(counts.toolCalls, REPEAT_AT + 2);
});
test("a failure with no recognisable text is a failed command for Bash and a failed tool call otherwise", () => {
  assert.equal(classifyError("Exit code 2", "Bash"), "commandFailed");
  assert.equal(classifyError("boom", "Read"), "toolFailed");
  assert.equal(classifyError("boom", undefined), "toolFailed");
});
test("records that are not objects, or have no message, change nothing", () => {
  const { counts } = run([null, 3, "x", { type: "assistant" }, { type: "user", message: {} }]);
  assert.deepEqual(counts, emptyCounts());
});

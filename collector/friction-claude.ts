import { createHash } from "node:crypto";
import type { FrictionCounts } from "../src/friction-model";
// Claude Code transcript records (one JSON object a line) projected onto the
// friction categories. Deterministic local rules; nothing here keeps text.
export type ClaudeState = {
  // Tool uses awaiting their result, by id: the tool's name.
  tools: Record<string, string>;
  // How often each command ran, by hash; the third run counts as repetition.
  commands: Record<string, number>;
  version?: string;
  client?: string;
  cwd?: string;
  firstAt?: number;
  lastAt?: number;
};
export const emptyClaudeState = (): ClaudeState => ({ tools: {}, commands: {} });
const TOOLS_KEPT = 200,
  COMMANDS_KEPT = 500;
export const REPEAT_AT = 3;
export const commandHash = (command: string) =>
  createHash("sha256").update(command).digest("hex").slice(0, 16);
export function noteCommand(commands: Record<string, number>, command: string) {
  const hash = commandHash(command);
  if (!(hash in commands) && Object.keys(commands).length >= COMMANDS_KEPT)
    return false;
  commands[hash] = (commands[hash] ?? 0) + 1;
  return commands[hash] === REPEAT_AT;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const resultText = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => object(block))
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("\n")
      : "";
// What a failed tool result was: the user declining, a hook blocking it, the
// tool refusing a misuse of itself, an interruption, or the tool failing.
export function classifyError(
  text: string,
  tool: string | undefined,
): "denied" | "hookBlocked" | "misuse" | "interrupted" | "commandFailed" | "toolFailed" {
  const head = text.slice(0, 400);
  if (/hook error|^<tool_use_error>Blocked:|blocked by .{0,40}hook/i.test(head))
    return "hookBlocked";
  if (
    /permission (for this action was|to use .{0,80} has been) denied|user doesn't want to proceed|denied by the user|requires approval/i.test(
      head,
    )
  )
    return "denied";
  if (/interrupted|\[Request interrupted/i.test(head)) return "interrupted";
  if (/^<tool_use_error>|InputValidationError/.test(head)) return "misuse";
  return tool === "Bash" ? "commandFailed" : "toolFailed";
}
export function claudeRecord(
  record: unknown,
  counts: FrictionCounts,
  state: ClaudeState,
) {
  const row = object(record);
  if (typeof row.version === "string" && /^[\w.+-]{1,40}$/.test(row.version))
    state.version = row.version;
  if (typeof row.entrypoint === "string" && !state.client)
    state.client = row.entrypoint.slice(0, 40);
  if (typeof row.cwd === "string" && !state.cwd) state.cwd = row.cwd.slice(0, 1000);
  if (typeof row.timestamp === "string") {
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at)) {
      state.firstAt = Math.min(state.firstAt ?? at, at);
      state.lastAt = Math.max(state.lastAt ?? at, at);
    }
  }
  const message = object(row.message);
  const blocks = Array.isArray(message.content)
    ? message.content.map((block) => object(block))
    : [];
  if (row.type === "assistant") {
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      counts.toolCalls += 1;
      const name = typeof block.name === "string" ? block.name : "unknown";
      if (typeof block.id === "string") {
        const ids = Object.keys(state.tools);
        if (ids.length >= TOOLS_KEPT) delete state.tools[ids[0]];
        state.tools[block.id] = name;
      }
      const command = object(block.input).command;
      if (name === "Bash" && typeof command === "string" && noteCommand(state.commands, command))
        counts.repeatedCommands += 1;
    }
  } else if (row.type === "user") {
    if (typeof message.content === "string") counts.prompts += 1;
    else if (blocks.length && !blocks.some((block) => block.type === "tool_result"))
      counts.prompts += 1;
    const denied = object(row.permissionDecision).decision === "reject";
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const tool = state.tools[id];
      delete state.tools[id];
      if (block.is_error !== true) continue;
      counts[denied ? "denied" : classifyError(resultText(block.content), tool)] += 1;
    }
  } else if (row.type === "system") {
    if (row.subtype === "api_error") counts.apiErrors += 1;
    else if (row.subtype === "compact_boundary") counts.compactions += 1;
    else if (row.subtype === "stop_hook_summary" && Array.isArray(row.hookErrors))
      counts.hookFailed += Math.min(row.hookErrors.length, 20);
  } else if (row.type === "attachment") {
    const attachment = object(row.attachment);
    if (
      (typeof attachment.type === "string" && /^hook_(error|failure)/.test(attachment.type)) ||
      (attachment.type === "hook_success" &&
        typeof attachment.exitCode === "number" &&
        attachment.exitCode !== 0)
    )
      counts.hookFailed += 1;
  }
}

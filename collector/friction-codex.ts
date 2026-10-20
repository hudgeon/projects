import type { FrictionCounts } from "../src/friction-model";
import { noteCommand } from "./friction-claude";
// Codex rollout records (one JSON object a line) projected onto the friction
// categories. Deterministic local rules; nothing here keeps text.
export type CodexState = {
  commands: Record<string, number>;
  version?: string;
  client?: string;
  cwd?: string;
  id?: string;
  firstAt?: number;
  lastAt?: number;
};
export const emptyCodexState = (): CodexState => ({ commands: {} });
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const toolItems = new Set([
  "McpToolCall",
  "DynamicToolCall",
  "FileChange",
  "WebSearch",
  "ImageView",
  "Extension",
]);
export function codexRecord(
  record: unknown,
  counts: FrictionCounts,
  state: CodexState,
) {
  const row = object(record);
  const payload = object(row.payload);
  if (typeof row.timestamp === "string") {
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at)) {
      state.firstAt = Math.min(state.firstAt ?? at, at);
      state.lastAt = Math.max(state.lastAt ?? at, at);
    }
  }
  if (row.type === "session_meta") {
    if (typeof payload.cli_version === "string" && /^[\w.+-]{1,40}$/.test(payload.cli_version))
      state.version = payload.cli_version;
    if (typeof payload.originator === "string") state.client = payload.originator.slice(0, 40);
    if (typeof payload.cwd === "string") state.cwd = payload.cwd.slice(0, 1000);
    if (typeof payload.id === "string") state.id = payload.id.slice(0, 80);
    return;
  }
  if (row.type !== "event_msg") return;
  if (payload.type === "turn_aborted") counts.interrupted += 1;
  else if (payload.type === "error" || payload.type === "stream_error") counts.apiErrors += 1;
  else if (payload.type === "item_completed") {
    const item = object(payload.item);
    const type = typeof item.type === "string" ? item.type : "";
    const status = item.status;
    if (type === "UserMessage") counts.prompts += 1;
    else if (/compaction/i.test(type)) counts.compactions += 1;
    else if (type === "CommandExecution") {
      counts.toolCalls += 1;
      if (status === "declined") counts.denied += 1;
      else if (status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0))
        counts.commandFailed += 1;
      if (typeof item.command === "string" && noteCommand(state.commands, item.command))
        counts.repeatedCommands += 1;
    } else if (toolItems.has(type)) {
      counts.toolCalls += 1;
      if (status === "declined") counts.denied += 1;
      else if (status === "failed") counts.toolFailed += 1;
    }
  }
}

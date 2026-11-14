import { constants, existsSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { claudeContextTokens } from "../collector/friction-claude";
import { clientKind } from "../src/friction-model";

const HANDOFF_TOKENS = 140_000;
const TAIL_BYTES = 256 * 1024;
export const handoffNotice = "Claude Code is near the 150k context target. Save a handoff and start a new session for the next phase.";
export const handoffContext = "The previous Claude Code call used at least 140k context tokens. At the next safe phase boundary, leave a concise handoff with the verified outcome, remaining step and issue, plan, or worktree pointers. Use review-work for a linked change. For a read-only request, put the pointers in the reply. Then ask the user to open a fresh Claude Code session for the next phase. Finish the current phase safely and carry forward the user's approvals and constraints.";

async function reachedLimit(home: string, session: string, transcript: string) {
  const projects = path.join(home, ".claude", "projects");
  const parts = path.relative(projects, transcript).split(path.sep);
  if (!path.isAbsolute(transcript) || parts.length !== 2 || parts[0] === ".." || parts[1] !== `${session}.jsonl`)
    return false;
  const file = path.join(await realpath(projects), ...parts);
  if ((await realpath(file)) !== file) return false;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let lines: string[];
  try {
    const info = await handle.stat();
    if (!info.isFile()) return false;
    const start = Math.max(0, info.size - TAIL_BYTES);
    const bytes = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    lines = bytes.toString("utf8", 0, bytesRead).split("\n");
    lines.pop(); // A record being appended may be incomplete.
    if (start) lines.shift();
  } finally {
    await handle.close();
  }
  for (const line of lines.reverse()) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.sessionId !== session || row.isSidechain === true) continue;
    if (row.type === "system" && row.subtype === "compact_boundary") return false;
    if (row.type !== "assistant") continue;
    const tokens = claudeContextTokens(row.message?.usage);
    // Only a session someone is working in: desktop or terminal, never -p or the SDK.
    if (tokens) return clientKind(row.entrypoint) !== undefined && tokens >= HANDOFF_TOKENS;
  }
  return false;
}

// One advisory per native session. The marker is local and never a work association.
export async function adviseClaudeHandoff(home: string, session: string, transcript: unknown, marker: string) {
  if (typeof transcript !== "string" || existsSync(marker)) return false;
  try {
    if (!(await reachedLimit(home, session, transcript))) return false;
    await (await open(marker, "wx", 0o600)).close();
    return true;
  } catch {
    // Missing or unreadable usage leaves the normal prompt and association alone.
    return false;
  }
}

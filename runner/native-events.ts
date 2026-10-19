import path from "node:path";
import {
  LIVE_STEPS,
  progressNoteInputSchema,
  type LivePlanStep,
  type NativeActivity,
  type ProgressNoteInput,
  type WaitLabel,
} from "../src/run-model";

// Native protocol events projected into fixed, safe shapes. Nothing here
// returns native text, a command, its output or a tool's payload.
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
// Only an explicitly marked public status message is eligible. Ordinary text,
// reasoning, tool arguments/results and final structured results stay local.
export function parseProgressNote(text: unknown): ProgressNoteInput | null {
  if (typeof text !== "string" || text.length > 5000) return null;
  const match = /^PROJECTS_PROGRESS (\{[^\n]*\})\s*$/.exec(text.trim());
  if (!match) return null;
  try {
    const parsed = progressNoteInputSchema.safeParse(JSON.parse(match[1]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
// Deliberately project to fixed categories; even a tool name can contain private
// data. No native text or payload crosses this callback.
export function codexActivity(
  item: Record<string, unknown>,
  finished: boolean,
): NativeActivity | null {
  const kinds: Record<string, NativeActivity["kind"]> = {
    commandExecution: "command",
    fileChange: "edit",
    mcpToolCall: "tool",
    dynamicToolCall: "tool",
    webSearch: "search",
    contextCompaction: "compaction",
    agentMessage: "response",
  };
  const kind =
    typeof item.type === "string" && Object.hasOwn(kinds, item.type)
      ? kinds[item.type]
      : undefined;
  return kind
    ? {
        kind,
        state: !finished
          ? "started"
          : item.status === "failed" || item.success === false
            ? "failed"
            : "finished",
      }
    : null;
}
// Plans are the agent's own step labels, clipped; statuses map to three states.
export function planSteps(
  items: unknown,
  text: (item: Record<string, unknown>) => unknown,
  status: (item: Record<string, unknown>) => unknown,
): LivePlanStep[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => object(entry))
    .flatMap((item) => {
      const step = typeof text(item) === "string" ? String(text(item)).trim() : "";
      const state = status(item);
      if (!step) return [];
      return [
        {
          step: step.length > 200 ? `${step.slice(0, 199)}…` : step,
          status:
            state === "completed"
              ? ("done" as const)
              : state === "inProgress" || state === "in_progress"
                ? ("active" as const)
                : ("pending" as const),
        },
      ];
    })
    .slice(0, LIVE_STEPS);
}
export function claudeToolKind(name: unknown): NativeActivity["kind"] {
  if (name === "Read") return "read";
  if (name === "Glob" || name === "Grep" || name === "WebSearch")
    return "search";
  if (name === "Edit" || name === "Write") return "edit";
  if (name === "Bash") return "command";
  return "tool";
}

// A file a turn read or changed: its absolute path and, for a partial read,
// its first and last line. Searches and listings are not reads.
export type FileTouch = {
  path: string;
  change?: true;
  lines?: [number, number];
};
const line = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
const range = (first: number, last: number): Pick<FileTouch, "lines"> =>
  first > 0 && last >= first ? { lines: [first, last] } : {};
// Claude names the file in its tool's input; Read may name a line range.
export function claudeFiles(
  tool: unknown,
  input: Record<string, unknown>,
  cwd: string,
): FileTouch[] {
  const file = input.file_path ?? input.notebook_path;
  if (typeof file !== "string" || !file) return [];
  if (tool === "Read") {
    const first = line(input.offset) ?? 1,
      count = line(input.limit);
    return [
      {
        path: path.resolve(cwd, file),
        ...(line(input.offset) || count
          ? range(first, first + (count ?? 2000) - 1)
          : {}),
      },
    ];
  }
  return ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(String(tool))
    ? [{ path: path.resolve(cwd, file), change: true }]
    : [];
}
// Codex reports the files a command read, from its own parse of the command,
// and those a patch changed. Only a `sed -n` or `head` read's numbers are
// taken from the command.
export function codexFiles(
  item: Record<string, unknown>,
  cwd: string,
): FileTouch[] {
  if (
    item.type === "commandExecution" &&
    item.status !== "declined" &&
    Array.isArray(item.commandActions)
  )
    return item.commandActions.flatMap((entry) => {
      const action = object(entry);
      if (action.type !== "read" || typeof action.path !== "string") return [];
      const command = String(action.command ?? ""),
        sed = /\bsed\s+-n\s+['"]?(\d+)(?:,(\d+))?p\b/.exec(command),
        head = /\bhead\s+-(?:n\s*)?(\d+)\b/.exec(command);
      return action.path
        ? [
            {
              path: path.resolve(
                typeof item.cwd === "string" ? item.cwd : cwd,
                action.path,
              ),
              ...(sed
                ? range(+sed[1], +(sed[2] ?? sed[1]))
                : head
                  ? range(1, +head[1])
                  : {}),
            },
          ]
        : [];
    });
  if (
    item.type === "fileChange" &&
    item.status === "completed" &&
    Array.isArray(item.changes)
  )
    return item.changes.flatMap((entry) => {
      const file = object(entry).path;
      return typeof file === "string" && file
        ? [{ path: path.resolve(cwd, file), change: true as const }]
        : [];
    });
  return [];
}
// What the runner refused, by kind: never tool names or arguments.
export const codexRequests: Record<string, string> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file change",
  "item/permissions/requestApproval": "permission",
  "item/tool/requestUserInput": "question for the user",
};
export function claudeRefusal(tool: unknown): string {
  if (tool === "Bash") return "command";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit")
    return "file change";
  if (tool === "WebFetch" || tool === "WebSearch") return "web request";
  if (typeof tool === "string" && tool.startsWith("mcp__projects_browser__"))
    return "browser action";
  if (typeof tool === "string" && tool.startsWith("mcp__"))
    return "connector tool";
  return "other tool";
}
// What a command waits on, read on this machine; only the category leaves it.
// The thing waited on wins over the loop waiting for it.
const waitRules: [WaitLabel, RegExp][] = [
  ["review", /\bcodex\s+(exec|review)\b|\bclaude\s+(-p|--print)\b|security-review/],
  ["checks", /\bgh\s+(pr\s+checks|run\s+(watch|view))\b/],
  ["tests", /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\b(vitest|jest|pytest)\b|\bplaywright\s+test\b|\b(node|tsx)\s+--test\b|\b(go|cargo)\s+test\b/],
  ["build", /\b(npm|pnpm|yarn)\s+run\s+[\w:-]*(build|typecheck)\b|\btsc\b|\bvite\s+build\b|\b(go|cargo)\s+build\b/],
  ["deploy", /\bwrangler\s+deploy\b|\b(npm|pnpm|yarn)\s+run\s+deploy\b|\bgh\s+workflow\s+run\b|install-machine/],
  ["git", /\bgit\s+(push|pull|fetch|clone)\b/],
  ["remote", /\bssh\s/],
  ["loop", /\b(until|while)\b[\s\S]*\bsleep\b|^\s*sleep\s+\d/],
];
export function waitLabel(command: unknown): WaitLabel | undefined {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (typeof text !== "string") return undefined;
  return waitRules.find(([, rule]) => rule.test(text))?.[0];
}

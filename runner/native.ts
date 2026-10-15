import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ScreenshotInput } from "../src/screenshot-model";
import type { FailureReason } from "../src/telemetry";
import type { ConnectorAccess } from "./connectors";
import {
  LIVE_STEPS,
  progressNoteInputSchema,
  type LivePlanStep,
  type NativeActivity,
  type ProgressNoteInput,
} from "../src/run-model";

export type SteerInput = { text: string; screenshots?: ScreenshotInput[] };
// A turn's tokens so far, as its app reports them: new input (cache writes
// included), cached input read again and output, with the latest request's
// context size.
export type TurnUsage = {
  fresh: number;
  cached: number;
  output: number;
  context: number;
};
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
export type NativeOptions = {
  agent: "codex" | "claude";
  cwd: string;
  prompt: string;
  screenshots?: ScreenshotInput[];
  browser?: { endpoint: string; capability: string; outputDir: string };
  sessionId?: string;
  schema: Record<string, unknown>;
  readOnly: boolean;
  writableRoots?: string[];
  signal: AbortSignal;
  onSession: (id: string) => Promise<void>;
  onProcess?: (pid: number) => Promise<void>;
  onActivity?: (event: NativeActivity) => void;
  onProgress?: (note: ProgressNoteInput) => void;
  // The working agent's own plan, as it changes.
  onPlan?: (steps: LivePlanStep[]) => void;
  // Once the turn is running: delivers the user's feedback into it. Rejects when
  // the turn has finished or cannot take more input.
  onSteer?: (steer: (input: SteerInput) => Promise<void>) => void;
  // Requests the runner refused during a turn that still returned its result,
  // as categories; never tool names or arguments.
  onRefused?: (categories: string[]) => void;
  // Called as the turn's token use grows.
  onUsage?: (usage: TurnUsage) => void;
  // The user's connectors, for helpers only.
  connectors?: ConnectorAccess;
  binaries?: { codex?: string; claude?: string };
  // First wait before re-running a turn the model was too busy to start.
  retryDelayMs?: number;
};
// The runner credential, Doppler credentials and provider API keys must never
// reach a coding process. Native tools use the user's existing local login.
export function nativeEnv(
  browser?: NativeOptions["browser"],
): NodeJS.ProcessEnv {
  // Wrangler augments ProcessEnv with required Worker bindings; those bindings
  // intentionally do not exist in a native process's environment.
  const env = Object.fromEntries(
    [
      "HOME",
      "PATH",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TERM",
      "SSH_AUTH_SOCK",
      "CODEX_HOME",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
  ) as NodeJS.ProcessEnv;
  // A change sandbox cannot write ~/.cache, so uv (the work repository's email
  // draft helper among others) keeps its cache in the writable temporary directory.
  env.UV_CACHE_DIR = path.join(tmpdir(), "projects-uv-cache");
  if (browser) {
    env.PLAYWRIGHT_MCP_CDP_ENDPOINT = browser.endpoint;
    env.PLAYWRIGHT_MCP_CDP_HEADERS = `Authorization: Bearer ${browser.capability}`;
  }
  return env;
}
export const browserTools = (readOnly: boolean) => [
  // Navigation/waiting return accessibility snapshots without accepting a
  // filename. Standalone capture tools can write named files in MCP roots, so
  // they belong only to change children, never the read-only coordinator.
  "browser_navigate",
  "browser_wait_for",
  ...(!readOnly
    ? [
        "browser_snapshot",
        "browser_take_screenshot",
        "browser_console_messages",
        "browser_network_requests",
        "browser_click",
        "browser_type",
        "browser_fill_form",
        "browser_press_key",
        "browser_select_option",
        "browser_hover",
        "browser_drag",
        "browser_resize",
        "browser_navigate_back",
      ]
    : []),
];
// Claude's allowedTools grants permission but does not hide other MCP tools.
// Keep the pinned provider's unapproved tools out of the model's context, too.
const browserToolNames =
  "browser_click browser_close browser_console_messages browser_drag browser_drop browser_emulate_media browser_evaluate browser_file_upload browser_fill_form browser_find browser_handle_dialog browser_hover browser_navigate browser_navigate_back browser_network_request browser_network_requests browser_press_key browser_resize browser_run_code_unsafe browser_select_option browser_snapshot browser_take_screenshot browser_type browser_wait_for browser_tabs browser_get_config browser_network_state_set browser_route browser_route_list browser_unroute browser_cookie_clear browser_cookie_delete browser_cookie_get browser_cookie_list browser_cookie_set browser_localstorage_clear browser_localstorage_delete browser_localstorage_get browser_localstorage_list browser_localstorage_set browser_sessionstorage_clear browser_sessionstorage_delete browser_sessionstorage_get browser_sessionstorage_list browser_sessionstorage_set browser_set_storage_state browser_storage_state browser_annotate browser_hide_highlight browser_highlight browser_resume browser_start_recording browser_start_tracing browser_start_video browser_stop_recording browser_stop_tracing browser_stop_video browser_video_chapter browser_video_hide_actions browser_video_show_actions browser_mouse_click_xy browser_mouse_down browser_mouse_drag_xy browser_mouse_move_xy browser_mouse_up browser_mouse_wheel browser_pdf_save browser_generate_locator browser_verify_element_visible browser_verify_list_visible browser_verify_text_visible browser_verify_value".split(
    " ",
  );
export const hiddenBrowserTools = (readOnly: boolean) =>
  browserToolNames.filter((tool) => !browserTools(readOnly).includes(tool));
const browserArgs = (o: NativeOptions) => [
  "-y",
  "@playwright/mcp@0.0.83",
  "--output-dir",
  o.browser!.outputDir,
  "--output-max-size",
  "50000000",
  "--no-webmcp",
  "--codegen",
  "none",
];
export function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 3000);
  timer.unref();
}
export class NativeStopError extends Error {}
// A failure with a known cause, from a native session or the runner itself: its
// message is what the user reads, its reason the safe category telemetry keeps.
export class Failure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
  }
}
// The model was at capacity or its connection dropped. `acted` records whether
// the turn had already run a command or tool, which makes a retry unsafe.
export class NativeBusyError extends Error {
  constructor(readonly acted: boolean) {
    super(
      "OpenAI's model was busy, so this turn did not finish. Send a follow-up to try again.",
    );
  }
}
const BUSY = new Set([
  "serverOverloaded",
  "internalServerError",
  "flexUnavailable",
  "rateLimitExceeded",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
// Codex's own failure category; no message or detail is kept.
function turnFailure(info: unknown, acted: boolean): Error {
  const kind =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? Object.keys(info)[0]
        : null;
  if (kind && BUSY.has(kind)) return new NativeBusyError(acted);
  const known: Record<string, [FailureReason, string]> = {
    usageLimitExceeded: [
      "usage_limit",
      "Your Codex usage limit is reached. Send a follow-up after it resets.",
    ],
    contextWindowExceeded: [
      "context_exceeded",
      "This Codex session ran out of room.",
    ],
    sessionBudgetExceeded: [
      "context_exceeded",
      "This Codex session reached its budget.",
    ],
    unauthorized: [
      "signed_out",
      "Codex is signed out on this machine. Sign in to Codex there, then send a follow-up.",
    ],
    cyberPolicy: ["policy_refused", "Codex declined this turn under its usage policy."],
    misalignmentPolicyViolation: [
      "policy_refused",
      "Codex declined this turn under its usage policy.",
    ],
    tooManyDenials: [
      "permission_required",
      "Codex stopped after too many of its requests were refused.",
    ],
    sandboxError: [
      "sandbox_error",
      "Codex's sandbox could not run a command.",
    ],
  };
  const [reason, message] = (kind && known[kind]) || [
    "turn_failed",
    "Codex's turn failed before it reported; what it finished is unconfirmed.",
  ];
  return new Failure(reason, message);
}
// Which request Codex refused, so a failure names its step.
const opening: [FailureReason, string] = [
  "session_rejected",
  "Codex could not open the session.",
];
const rejected: Record<string, [FailureReason, string]> = {
  initialize: [
    "native_unavailable",
    "Codex would not start a session. Check its installation and local login.",
  ],
  "thread/start": opening,
  "thread/resume": opening,
  "turn/start": ["turn_rejected", "Codex rejected the turn."],
};
// What a refused request would have done, never its tool, command or text.
const codexRequests: Record<string, string> = {
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
export function nativeProcessStopped(pid: number | null): boolean {
  if (!pid || pid <= 1) return false;
  // Check the detached process group too: a shell/tool can outlive its parent.
  for (const target of [pid, -pid]) {
    try {
      process.kill(target, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  }
  return true;
}
async function confirmStopped(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolve, reject) => {
    const closed = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("close", closed);
      reject(
        new NativeStopError(
          "An agent process did not confirm it stopped, so nothing else was started. Send a follow-up once it has stopped.",
        ),
      );
    }, 6000);
    child.once("close", closed);
    stopProcess(child);
  });
}
function object(value: unknown): Record<string, unknown> {
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
function codexActivity(
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
function planSteps(
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
const userContent = (input: SteerInput, kind: "codex" | "claude") => [
  { type: "text", text: input.text },
  ...(input.screenshots ?? []).map((image) =>
    kind === "codex"
      ? { type: "image", url: `data:${image.mime};base64,${image.data}` }
      : {
          type: "image",
          source: { type: "base64", media_type: image.mime, data: image.data },
        },
  ),
];
function claudeToolKind(name: unknown): NativeActivity["kind"] {
  if (name === "Read") return "read";
  if (name === "Glob" || name === "Grep" || name === "WebSearch")
    return "search";
  if (name === "Edit" || name === "Write") return "edit";
  if (name === "Bash") return "command";
  return "tool";
}
// Only native protocol events are parsed. Tool output is drained, never uploaded.
function readLines(
  child: ChildProcessWithoutNullStreams,
  receive: (line: Record<string, unknown>) => void,
  fail: (error: Error) => void,
) {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8_000_000) {
      fail(
        new Failure(
          "protocol_error",
          "Native response exceeded the protocol limit.",
        ),
      );
      return;
    }
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        receive(object(JSON.parse(line)));
      } catch {
        fail(
          new Failure(
            "protocol_error",
            "Native session returned an invalid protocol message.",
          ),
        );
      }
    }
  });
  child.on("error", () =>
    fail(
      new Failure(
        "native_unavailable",
        "Native agent could not start. Check its installation and local login.",
      ),
    ),
  );
  child.stdin.on("error", () =>
    fail(Error("Native session input closed unexpectedly.")),
  );
}
export async function nativeTurn(options: NativeOptions): Promise<unknown> {
  options.signal.throwIfAborted();
  return options.agent === "codex" ? codexTurn(options) : claudeTurn(options);
}
async function codexTurn(o: NativeOptions): Promise<unknown> {
  // Named profiles grant exact Git metadata paths. The legacy workspace-write
  // policy protects them even as extra roots. These overrides are process-local;
  // the user's Codex configuration is never edited.
  const filesystem = {
    ":root": "read",
    ":tmpdir": "write",
    ":slash_tmp": "write",
    [o.cwd]: "write",
    [path.join(o.cwd, ".git")]: "read",
    [path.join(o.cwd, ".codex")]: "read",
    [path.join(o.cwd, ".agents")]: "read",
    ...Object.fromEntries(
      (o.writableRoots ?? []).map((root) => [root, "write"]),
    ),
  };
  const profile = `{${Object.entries(filesystem)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(",")}}`;
  const child = spawn(
    o.binaries?.codex ?? "codex",
    [
      ...(o.connectors?.codex ?? []),
      ...(o.browser
        ? Object.entries({
            command: "npx",
            args: browserArgs(o),
            env_vars: [
              "PLAYWRIGHT_MCP_CDP_ENDPOINT",
              "PLAYWRIGHT_MCP_CDP_HEADERS",
            ],
            enabled_tools: browserTools(o.readOnly),
            startup_timeout_sec: 60,
            // Carry the user's browser grant only to the tools exposed for this
            // native phase. Other MCP tools and filesystem approvals stay intact.
            ...Object.fromEntries(
              browserTools(o.readOnly).map((tool) => [
                `tools.${tool}.approval_mode`,
                "approve",
              ]),
            ),
          }).flatMap(([key, value]) => [
            "-c",
            `mcp_servers.projects_browser.${key}=${JSON.stringify(value)}`,
          ])
        : []),
      ...(o.readOnly
        ? []
        : [
            "-c",
            `permissions.projects_job.filesystem=${profile}`,
            "-c",
            "permissions.projects_job.network.enabled=true",
          ]),
      "app-server",
      "--listen",
      "stdio://",
    ],
    { cwd: o.cwd, env: nativeEnv(o.browser), detached: true, stdio: "pipe" },
  );
  let next = 1,
    finalText = "",
    turnId = "",
    threadId = "",
    refusals: string[] = [],
    acted = false,
    baseline: { input: number; cached: number; output: number } | undefined;
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let finish: (value: unknown) => void = () => {},
    rejectTurn: (error: Error) => void = () => {},
    completed: Promise<unknown> = Promise.resolve();
  const arm = () => {
    completed = new Promise<unknown>((resolve, reject) => {
      finish = resolve;
      rejectTurn = reject;
    });
    // A failure can arrive while a request is pending; observe the rejection.
    void completed.catch(() => {});
  };
  arm();
  const fail = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    rejectTurn(error);
    stopProcess(child);
  };
  const send = (value: unknown) =>
    child.stdin.write(`${JSON.stringify(value)}\n`);
  const methods = new Map<number, string>();
  const request = (method: string, params: unknown, timeout = 90000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Failure("native_timeout", `Codex ${method} timed out.`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      methods.set(id, method);
      send({ id, method, params });
    });
  const abort = () => fail(Error("Native turn stopped."));
  o.signal.addEventListener("abort", abort, { once: true });
  readLines(
    child,
    (message) => {
      if (typeof message.id === "number" && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) {
          const known = rejected[methods.get(message.id) ?? ""];
          entry.reject(
            known
              ? new Failure(...known)
              : Error("Codex rejected a session request."),
          );
        } else entry.resolve(object(message.result));
        return;
      }
      const p = object(message.params);
      // The runner answers every request for approval or input itself: it
      // declines, and the turn carries on without it.
      if (message.id !== undefined && typeof message.method === "string") {
        refusals.push(
          codexRequests[message.method] ??
            (message.method.endsWith("/requestApproval")
              ? "approval"
              : "other request"),
        );
        if (message.method === "item/tool/requestUserInput")
          send({ id: message.id, result: { answers: {} } });
        else if (message.method === "item/permissions/requestApproval")
          send({ id: message.id, result: { permissions: {}, scope: "turn" } });
        else if (message.method.endsWith("/requestApproval"))
          send({ id: message.id, result: { decision: "decline" } });
        else
          send({
            id: message.id,
            error: {
              code: -32601,
              message: "This operation requires operator review.",
            },
          });
        return;
      }
      if (p.threadId && p.threadId !== threadId) return;
      // The thread's running totals; this process's turns are the growth
      // since just before the first report it saw.
      if (message.method === "thread/tokenUsage/updated") {
        const usage = object(p.tokenUsage);
        const total = object(usage.total),
          last = object(usage.last);
        const read = (key: string) => count(total[key]);
        baseline ??= {
          input: read("inputTokens") - count(last.inputTokens),
          cached: read("cachedInputTokens") - count(last.cachedInputTokens),
          output: read("outputTokens") - count(last.outputTokens),
        };
        const input = Math.max(0, read("inputTokens") - baseline.input),
          cached = Math.max(0, read("cachedInputTokens") - baseline.cached);
        o.onUsage?.({
          fresh: Math.max(0, input - cached),
          cached,
          output: Math.max(0, read("outputTokens") - baseline.output),
          context: count(last.inputTokens),
        });
      }
      if (message.method === "turn/started") {
        const id = object(p.turn).id;
        if (typeof id === "string") turnId = id;
        o.onActivity?.({ kind: "turn", state: "started" });
      }
      if (message.method === "turn/plan/updated")
        o.onPlan?.(
          planSteps(
            p.plan,
            (item) => item.step,
            (item) => item.status,
          ),
        );
      if (
        message.method === "item/started" ||
        message.method === "item/completed"
      ) {
        const activity = codexActivity(
          object(p.item),
          message.method === "item/completed",
        );
        if (activity) o.onActivity?.(activity);
        if (activity && !["response", "compaction"].includes(activity.kind))
          acted = true;
      }
      if (message.method === "item/completed") {
        const item = object(p.item);
        if (item.type === "agentMessage" && item.phase === "commentary") {
          const note = parseProgressNote(item.text);
          if (note) o.onProgress?.(note);
        }
        if (
          item.type === "agentMessage" &&
          item.phase !== "commentary" &&
          typeof item.text === "string"
        )
          finalText = item.text;
      }
      if (message.method === "turn/completed") {
        const turn = object(p.turn);
        if (turn.status !== "completed") {
          rejectTurn(turnFailure(object(turn.error).codexErrorInfo, acted));
          return;
        }
        try {
          if (finalText.length > 100000) throw Error();
          const value = JSON.parse(finalText);
          o.onActivity?.({ kind: "turn", state: "finished" });
          // A refused request is evidence for the master, not a failure: the
          // turn went on without it and reported.
          if (refusals.length) o.onRefused?.(refusals);
          finish(value);
        } catch {
          rejectTurn(
            new Failure(
              "invalid_result",
              "Codex did not return a valid structured result.",
            ),
          );
        }
      }
    },
    fail,
  );
  child.on("close", () =>
    fail(
      new Failure(
        "native_exited",
        "Codex exited before confirming the turn result.",
      ),
    ),
  );
  try {
    if (child.pid) await o.onProcess?.(child.pid);
    await request("initialize", {
      clientInfo: {
        name: "projects_runner",
        title: "Projects",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: !o.readOnly },
    });
    send({ method: "initialized", params: {} });
    // Codex refuses to resume an archived thread. A thread that was never
    // archived rejects this harmlessly; resume still reports real failures.
    if (o.sessionId)
      await request("thread/unarchive", { threadId: o.sessionId }, 15000).catch(
        () => {},
      );
    const started = await request(
      o.sessionId ? "thread/resume" : "thread/start",
      {
        ...(o.sessionId ? { threadId: o.sessionId } : {}),
        cwd: o.cwd,
        approvalPolicy: "never",
        ...(o.readOnly
          ? { sandbox: "read-only" }
          : { permissions: "projects_job" }),
      },
    );
    const thread = object(started.thread);
    if (typeof thread.id !== "string")
      throw new Failure(
        "protocol_error",
        "Codex did not identify its session.",
      );
    if (o.sessionId && object(thread.status).type === "active")
      throw new Failure(
        "session_active",
        "Codex session is already active; do not overlap its current turn.",
      );
    threadId = thread.id;
    await o.onSession(threadId);
    let result: unknown;
    for (let attempt = 1; ; attempt++) {
      finalText = "";
      refusals = [];
      acted = false;
      const turn = await request("turn/start", {
        threadId,
        input: userContent({ text: o.prompt, screenshots: o.screenshots }, "codex"),
        cwd: o.cwd,
        approvalPolicy: "never",
        ...(o.readOnly
          ? { sandboxPolicy: { type: "readOnly", networkAccess: true } }
          : { permissions: "projects_job" }),
        outputSchema: o.schema,
      });
      const started = object(turn.turn).id;
      if (typeof started === "string") turnId = started;
      // Codex adds steered input to the active turn; it refuses once the turn
      // has ended, and the feedback then waits for the master's next decision.
      o.onSteer?.(async (input) => {
        if (!turnId) throw Error("The turn has not started.");
        await request(
          "turn/steer",
          {
            threadId,
            expectedTurnId: turnId,
            input: userContent(input, "codex"),
          },
          15000,
        );
      });
      try {
        result = await completed;
        break;
      } catch (error) {
        // A busy model that had not yet run anything can run the same turn
        // again: twice more, after one and then two waits.
        if (!(error instanceof NativeBusyError) || error.acted || attempt >= 3)
          throw error;
        await delay((o.retryDelayMs ?? 60_000) * attempt, undefined, {
          signal: o.signal,
        });
        arm();
      }
    }
    // Archiving keeps runner threads out of the user's Codex sidebar; archived
    // threads remain resumable. Failed or stopped threads stay visible for
    // inspection.
    await request("thread/archive", { threadId }, 15000).catch(() => {});
    return result;
  } finally {
    o.signal.removeEventListener("abort", abort);
    await confirmStopped(child);
  }
}
async function claudeTurn(o: NativeOptions): Promise<unknown> {
  const session = o.sessionId ?? randomUUID();
  // Write session identity before the process can execute a prompt.
  await o.onSession(session);
  // A stop that arrived while the identity was saved starts nothing.
  o.signal.throwIfAborted();
  const connectors = o.connectors?.claude;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Input stays open until the result so feedback can reach the running turn.
    "--input-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(o.schema),
    "--permission-mode",
    "dontAsk",
    // TodoWrite only keeps the session's own plan; it changes nothing.
    "--tools",
    o.readOnly
      ? "Read,Glob,Grep,TodoWrite"
      : "Read,Glob,Grep,Edit,Write,Bash,TodoWrite",
    "--allowedTools",
    [
      o.readOnly
        ? "Read,Glob,Grep,TodoWrite"
        : "Read,Glob,Grep,Edit,Write,Bash,TodoWrite",
      ...(o.browser
        ? browserTools(o.readOnly).map(
            (tool) => `mcp__projects_browser__${tool}`,
          )
        : []),
      ...(connectors?.allow ?? []),
    ].join(","),
    ...(o.browser || connectors?.deny.length
      ? [
          "--disallowedTools",
          [
            ...(o.browser
              ? hiddenBrowserTools(o.readOnly).map(
                  (tool) => `mcp__projects_browser__${tool}`,
                )
              : []),
            ...(connectors?.deny ?? []),
          ].join(","),
        ]
      : []),
    // Without approved connectors, only this conversation's browser: anything
    // else would be refused in dontAsk mode, failing the whole turn. With
    // them, local MCP servers and blocked connector tools stay hidden.
    ...(connectors ? [] : ["--strict-mcp-config"]),
    "--mcp-config",
    JSON.stringify({
      mcpServers: o.browser
        ? { projects_browser: { command: "npx", args: browserArgs(o) } }
        : {},
    }),
    ...(o.sessionId ? ["--resume", session] : ["--session-id", session]),
  ];
  const child = spawn(o.binaries?.claude ?? "claude", args, {
    cwd: o.cwd,
    env: nativeEnv(o.browser),
    detached: true,
    stdio: "pipe",
  });
  let result: unknown,
    received = false,
    failed = false,
    refusals: string[] = [],
    subtype = "",
    open = true;
  const write = (input: SteerInput) =>
    child.stdin.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: userContent(input, "claude") },
      }) + "\n",
    );
  const close = () => {
    if (!open) return;
    open = false;
    child.stdin.end();
  };
  const tools = new Map<string, NativeActivity["kind"]>();
  // Each request's usage, by message: a message streamed in parts repeats it.
  const requests = new Map<string, Record<string, unknown>>();
  let context = 0;
  // While the turn runs, its requests so far; once it reports, the result's
  // own count for this turn. Never the per-model totals: on a resumed session
  // they include every earlier turn.
  const usage = (turn?: Record<string, unknown>) => {
    const counted =
      turn && Object.values(turn).some((value) => typeof value === "number")
        ? [turn]
        : [...requests.values()];
    return {
      fresh: counted.reduce((n, u) => n + count(u.input_tokens) + count(u.cache_creation_input_tokens), 0),
      cached: counted.reduce((n, u) => n + count(u.cache_read_input_tokens), 0),
      output: counted.reduce((n, u) => n + count(u.output_tokens), 0),
      context,
    };
  };
  const completion = new Promise<unknown>((resolve, reject) => {
    const fail = (error: Error) => {
      stopProcess(child);
      reject(error);
    };
    const abort = () => fail(Error("Native turn stopped."));
    o.signal.addEventListener("abort", abort, { once: true });
    if (o.signal.aborted) abort();
    readLines(
      child,
      (message) => {
        if (message.type === "system" && message.subtype === "init")
          o.onActivity?.({ kind: "turn", state: "started" });
        if (message.type === "assistant") {
          const sent = object(message.message);
          const used = object(sent.usage);
          if (typeof sent.id === "string" && Object.keys(used).length) {
            requests.set(sent.id, used);
            // A helper's sub-agents report too; the turn's own context is
            // what its top-level requests carry.
            if (!message.parent_tool_use_id)
              context =
                count(used.input_tokens) +
                count(used.cache_creation_input_tokens) +
                count(used.cache_read_input_tokens);
            o.onUsage?.(usage());
          }
        }
        if (message.type === "assistant" || message.type === "user") {
          const content = object(message.message).content;
          if (Array.isArray(content))
            for (const entry of content) {
              const block = object(entry);
              if (message.type === "assistant" && block.type === "text") {
                const note = parseProgressNote(block.text);
                if (note) o.onProgress?.(note);
              }
              if (
                message.type === "assistant" &&
                block.type === "tool_use" &&
                block.name === "TodoWrite"
              )
                o.onPlan?.(
                  planSteps(
                    object(block.input).todos,
                    (item) => item.content,
                    (item) => item.status,
                  ),
                );
              if (
                message.type === "assistant" &&
                block.type === "tool_use" &&
                typeof block.id === "string"
              ) {
                const kind = claudeToolKind(block.name);
                if (!tools.has(block.id))
                  o.onActivity?.({ kind, state: "started" });
                tools.set(block.id, kind);
              }
              if (
                message.type === "user" &&
                block.type === "tool_result" &&
                typeof block.tool_use_id === "string"
              ) {
                const kind = tools.get(block.tool_use_id);
                if (kind)
                  o.onActivity?.({
                    kind,
                    state: block.is_error ? "failed" : "finished",
                  });
                tools.delete(block.tool_use_id);
              }
            }
        }
        if (message.type !== "result") return;
        // A resumed session can first report a turn that never ran, such as
        // a background task's notice from its previous process. The turn for
        // this prompt follows; its input stays open until then.
        if (message.subtype === "success" && message.num_turns === 0) return;
        o.onUsage?.(usage(object(message.usage)));
        subtype = typeof message.subtype === "string" ? message.subtype : "";
        if (message.is_error || message.subtype !== "success") failed = true;
        // Don't-ask mode refuses what was not granted, and the turn carries on
        // without it. Only the kind of each refused request is kept.
        if (Array.isArray(message.permission_denials))
          refusals = message.permission_denials.map((denial) =>
            claudeRefusal(object(denial).tool_name),
          );
        result = message.structured_output;
        received = true;
        // One turn per process: ending input lets Claude exit.
        close();
        o.onActivity?.({ kind: "turn", state: failed ? "failed" : "finished" });
      },
      fail,
    );
    child.on("close", (code) => {
      open = false;
      o.signal.removeEventListener("abort", abort);
      if (subtype === "error_max_turns")
        reject(
          new Failure(
            "turn_limit",
            "Claude reached its turn limit before finishing.",
          ),
        );
      else if (failed)
        reject(
          new Failure(
            "turn_failed",
            "Claude's turn failed before it reported; what it finished is unconfirmed.",
          ),
        );
      else if (!received)
        reject(
          new Failure(
            "native_exited",
            "Claude exited before confirming the turn result.",
          ),
        );
      else if (code !== 0 || result === undefined)
        reject(
          new Failure(
            "invalid_result",
            "Claude did not return a valid structured result.",
          ),
        );
      else {
        if (refusals.length) o.onRefused?.(refusals);
        resolve(result);
      }
    });
    void (async () => {
      if (child.pid) await o.onProcess?.(child.pid);
      o.signal.throwIfAborted();
      write({ text: o.prompt, screenshots: o.screenshots });
      // Claude reads a message sent mid-turn at its next step.
      o.onSteer?.(async (input) => {
        if (!open) throw Error("The turn has finished.");
        write(input);
      });
    })().catch(() => fail(Error("Native turn could not be recorded safely.")));
  });
  try {
    return await completion;
  } finally {
    await confirmStopped(child);
  }
}

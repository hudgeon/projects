import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ScreenshotInput } from "../src/screenshot-model";
import type { ExecutionEvent, FailureReason } from "../src/telemetry";
import type { ConnectorAccess } from "./connectors";
import type {
  LivePlanStep,
  NativeActivity,
  ProgressNoteInput,
} from "../src/run-model";
import {
  claudeFiles,
  claudeRefusal,
  claudeToolKind,
  codexActivity,
  codexFiles,
  codexRequests,
  commandText,
  object,
  planSteps,
  parseProgressNote,
  type FileTouch,
} from "./native-events";
import { browserArgs, browserTools, hiddenBrowserTools } from "./native-browser";
import { fullAccess, codexPermissions, codexFilesystem } from "./native-access";
export { browserTools, hiddenBrowserTools } from "./native-browser";

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
  fullAccess?: boolean;
  codexFast?: boolean;
  onTiming?: (fields: Pick<ExecutionEvent, "model" | "effort" | "attempts" | "firstOutputMs">) => void;
  writableRoots?: string[];
  signal: AbortSignal;
  onSession: (id: string) => Promise<void>;
  onProcess?: (pid: number) => Promise<void>;
  // A command's own text comes too, for the runner and Jev only.
  onActivity?: (event: NativeActivity, command?: string) => void;
  onProgress?: (note: ProgressNoteInput) => void;
  // The working agent's own plan, as it changes.
  onPlan?: (steps: LivePlanStep[]) => void;
  // Once the turn is running: delivers the user's feedback into it. Rejects when
  // the turn has finished or cannot take more input.
  onSteer?: (steer: (input: SteerInput) => Promise<void>) => void;
  // Requests the runner refused during a turn that still returned its result,
  // as categories; never tool names or arguments.
  onRefused?: (categories: string[]) => void;
  // The process ran on after the turn's result, so it was stopped with
  // whatever it left running; the result stands.
  onOverran?: () => void;
  // How long a Claude process may run on after its result.
  resultExitMs?: number;
  // Called as the turn's token use grows.
  onUsage?: (usage: TurnUsage) => void;
  // Each file the turn reads or changes: paths and line ranges only.
  onFile?: (file: FileTouch) => void;
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
  const child = spawn(
    o.binaries?.codex ?? "codex",
    [
      ...(o.connectors?.codex ?? []),
      "-c", "features.fast_mode=true",
      "-c", `service_tier=${JSON.stringify(o.codexFast ? "fast" : "default")}`,
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
      ...codexFilesystem(o),
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
  let turnRequestedAt: number | null = null, firstOutputAt: number | null = null;
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
      if (message.method === "item/agentMessage/delta" && typeof p.delta === "string" && p.delta.length && firstOutputAt === null && turnRequestedAt !== null) {
        firstOutputAt = performance.now();
        o.onTiming?.({firstOutputMs: Math.round(firstOutputAt - turnRequestedAt)});
      }
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
        if (activity) o.onActivity?.(activity, commandText(object(p.item).command));
        if (activity && !["response", "compaction"].includes(activity.kind))
          acted = true;
      }
      if (message.method === "item/completed") {
        const item = object(p.item);
        if (o.onFile) codexFiles(item, o.cwd).forEach(o.onFile);
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
        serviceTier: o.codexFast ? "fast" : "default",
        approvalPolicy: "never",
        ...codexPermissions(o, true),
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
    o.onTiming?.({
      ...(typeof started.model === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(started.model) ? {model: started.model} : {}),
      ...(typeof started.reasoningEffort === "string" && /^[a-zA-Z0-9_-]{1,30}$/.test(started.reasoningEffort) ? {effort: started.reasoningEffort} : {}),
    });
    await o.onSession(threadId);
    let result: unknown;
    for (let attempt = 1; ; attempt++) {
      finalText = "";
      refusals = [];
      acted = false;
      o.onTiming?.({attempts: attempt});
      turnRequestedAt = performance.now();
      firstOutputAt = null;
      const turn = await request("turn/start", {
        threadId,
        input: userContent({ text: o.prompt, screenshots: o.screenshots }, "codex"),
        cwd: o.cwd,
        serviceTier: o.codexFast ? "fast" : "default",
        serviceTierForTurn: o.codexFast ? "fast" : "default",
        approvalPolicy: "never",
        ...codexPermissions(o),
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
// A turn ends at its result. Claude keeps its process while a command the
// agent left in the background runs, then starts a turn of its own when that
// command finishes, which nobody reads. Whatever still runs this long after
// the result is stopped, and the result stands.
export const RESULT_EXIT_MS = 30_000;
async function claudeTurn(o: NativeOptions): Promise<unknown> {
  const session = o.sessionId ?? randomUUID();
  // Write session identity before the process can execute a prompt.
  await o.onSession(session);
  // A stop that arrived while the identity was saved starts nothing.
  o.signal.throwIfAborted();
  const connectors = o.connectors?.claude;
  const unrestricted = fullAccess(o);
  const enabledTools = unrestricted ? "default" : o.readOnly
    ? "Read,Glob,Grep,TodoWrite"
    : "Read,Glob,Grep,Edit,Write,Bash,TodoWrite,TaskOutput,TaskStop,Monitor";
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
    unrestricted ? "bypassPermissions" : "dontAsk",
    // TodoWrite only keeps the session's own plan; it changes nothing.
    "--tools",
    enabledTools,
    ...(unrestricted ? [] : [
    "--allowedTools",
    [
      enabledTools,
      ...(o.browser
        ? browserTools(o.readOnly).map(
            (tool) => `mcp__projects_browser__${tool}`,
          )
        : []),
      ...(connectors?.allow ?? []),
    ].join(","),
    ]),
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
    ...(connectors || unrestricted ? [] : ["--strict-mcp-config"]),
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
    open = true,
    overran = false,
    exit: NodeJS.Timeout | undefined;
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
                if (!tools.has(block.id)) {
                  o.onActivity?.({ kind, state: "started" }, block.name === "Bash" ? commandText(object(block.input).command) : undefined);
                  if (o.onFile)
                    claudeFiles(block.name, object(block.input), o.cwd).forEach(o.onFile);
                }
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
        // Only the first result answers this prompt.
        if (received) return;
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
        exit = setTimeout(() => {
          overran = true;
          o.onOverran?.();
          stopProcess(child);
        }, o.resultExitMs ?? RESULT_EXIT_MS);
        o.onActivity?.({ kind: "turn", state: failed ? "failed" : "finished" });
      },
      fail,
    );
    child.on("close", (code) => {
      open = false;
      clearTimeout(exit);
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
      else if ((code !== 0 && !overran) || result === undefined)
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

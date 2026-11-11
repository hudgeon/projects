import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Child, RunMessage } from "../src/run-model";
import { childContext } from "./child-report";
export { childContext } from "./child-report";
import {
  contextErrorCodeSchema,
  contextFailureSchema,
  type ContextFailure,
} from "../src/telemetry";

// A fresh coordinator is rebuilt, not replayed: the first request and the
// newest user messages within this budget, every proposal those messages
// answered, the latest reported position and one line for each helper. The
// bounded prompt is a view of the retained sources, not a new source of
// authority; the exact conversation and every report stay on disk.
export const HANDOVER_CHAR_LIMIT = 8_000;
export const EVIDENCE_CHAR_LIMIT = 24_000;
export const JEV_MODEL = "jev-1.14.0";
// https://docs.typesafe.ai/models: Jev 1.14 costs $0.042/M input tokens;
// output tokens are free. Keep this rate beside the pinned model.
export const JEV_INPUT_COST_PER_TOKEN = 0.000000042;
// The model reads at most 64k tokens per request, and 32k for the state with
// any one question. A token covers at least one UTF-8 byte, so counting bytes
// overstates tokens; the margins leave room for the model's own framing.
export const REQUEST_BYTES = 60_000;
export const QUESTION_BYTES = 30_000;
const POLICY = 1;
export const contextConfigSchema = z
  .object({
    mode: z.enum(["off", "shadow", "select"]).default("off"),
    gateway: z
      .object({
        accountId: z.string().regex(/^[a-f0-9]{32}$/),
        gatewayId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ContextConfig = z.infer<typeof contextConfigSchema>;

export function contextConversation(messages: RunMessage[]) {
  const users = messages.filter((message) => message.role === "user");
  const selected = users.length ? [users[0]] : [];
  let chars = selected[0]?.text.length ?? 0;
  for (let i = users.length - 1; i > 0; i--) {
    if (
      selected.length > 1 &&
      chars + users[i].text.length > HANDOVER_CHAR_LIMIT
    )
      break;
    selected.splice(1, 0, users[i]);
    chars += users[i].text.length;
  }
  return {
    userInstructions: selected,
    omittedUserInstructions: users.length - selected.length,
    latestReportedPosition:
      messages.findLast((message) => message.role === "master") ?? null,
  };
}

// What a coordinator starting without its predecessor's session is given of
// the conversation. A short approval's preceding proposal travels with it,
// verbatim and newest first within the evidence budget; every user exchange
// is treated this way, without guessing which ones grant permission. Nothing
// here is judged by a model: a handover is rebuilt by fixed rules.
export function rebuildContext(messages: RunMessage[], children: Child[]) {
  const conversation = contextConversation(messages);
  const selectedUsers = new Set(conversation.userInstructions.map((m) => m.id));
  const proposals = messages.filter(
    (m, i) => m.role === "master" && selectedUsers.has(messages[i + 1]?.id),
  );
  let proposalChars = 0;
  const approvalContext = proposals
    .toReversed()
    .filter((m) => {
      if (proposalChars + m.text.length > EVIDENCE_CHAR_LIMIT) return false;
      proposalChars += m.text.length;
      return true;
    })
    .reverse();
  return {
    version: contextVersion(messages, children),
    conversation,
    approvalContext,
    omittedProposals: proposals.length - approvalContext.length,
    children: childContext(children),
    sources: messages.map((m) => ({ id: m.id, role: m.role, at: m.at })),
    childSources: children.map((c) => ({ id: c.id, state: c.state })),
  };
}

const probabilities = z.record(z.string(), z.number().min(0).max(1));
export const selectionRecordSchema = z
  .object({
    version: z.string(),
    policy: z.literal(POLICY),
    model: z.literal(JEV_MODEL),
    probabilities,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    transport: z.enum(["direct", "gateway"]).optional(),
    selectionId: z.uuid().optional(),
    // Requests a project review's shortlist was judged in.
    batches: z.number().int().positive().optional(),
  })
  .strict();
export type SelectionRecord = z.infer<typeof selectionRecordSchema>;
export type Selector = {
  mode: ContextConfig["mode"];
  key: () => Promise<string>;
  gateway?: ContextConfig["gateway"];
  fetch?: typeof fetch;
};
// The key is read once and kept in memory, so selections do not wait on the
// secret store; a failed or empty read is tried again at the next selection.
export function keptKey(read: () => Promise<string>) {
  let key = "";
  return async () => (key ||= await read());
}
export function contextVersion(messages: RunMessage[], children: Child[]) {
  return createHash("sha256")
    .update(JSON.stringify({ policy: POLICY, messages, children }))
    .digest("hex");
}

// Error messages, stacks, hostnames and arbitrary codes are never diagnostic data.
// Node fetch can wrap a system error in a cause or AggregateError; inspect at
// most eight objects, including cyclic chains, and retain only known codes.
function transportFailure(
  error: unknown,
): Pick<ContextFailure, "kind" | "errorCode"> {
  const pending: unknown[] = [error];
  for (let i = 0; i < pending.length && i < 8; i++) {
    const value = pending[i];
    if (!value || typeof value !== "object") continue;
    const e = value as {
      code?: unknown;
      cause?: unknown;
      name?: unknown;
      errors?: unknown;
    };
    const parsed = contextErrorCodeSchema.safeParse(e.code);
    if (parsed.success) {
      const code = parsed.data;
      const kind =
        code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? "dns"
          : code.includes("TIMEOUT") || code === "ETIMEDOUT"
            ? "timeout"
            : code.includes("CERT") || code.includes("SIGNATURE")
              ? "tls"
              : ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)
                ? "socket"
                : ["UND_ERR_ABORTED", "ABORT_ERR"].includes(code)
                  ? "aborted"
                  : [
                        "ERR_INVALID_URL",
                        "ERR_INVALID_CHAR",
                        "UND_ERR_INVALID_ARG",
                      ].includes(code)
                    ? "request_invalid"
                    : "connect";
      return { kind, errorCode: code };
    }
    if (e.cause) pending.push(e.cause);
    if (Array.isArray(e.errors)) pending.push(...e.errors.slice(0, 4));
  }
  return {
    kind:
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : error instanceof Error && error.name === "AbortError"
          ? "aborted"
          : error instanceof TypeError
            ? "network"
            : "unexpected",
  };
}

// Whether a request fits the model's documented limits, counted in bytes.
export function fitsRequest(
  state: unknown,
  questions: Record<string, unknown>,
) {
  const largest = Math.max(
    0,
    ...Object.values(questions).map((q) =>
      Buffer.byteLength(JSON.stringify(q)),
    ),
  );
  return (
    Buffer.byteLength(JSON.stringify(state)) + largest <= QUESTION_BYTES &&
    Buffer.byteLength(JSON.stringify({ model: JEV_MODEL, state, questions })) <=
      REQUEST_BYTES
  );
}

// Project reviews and run checks use the same bounded, priced transport and
// strict answer coverage. Retrieval and policy stay in code.
export async function judgeContext(o: {
  version: string;
  state: unknown;
  questions: Record<string, unknown>;
  count: number;
  signal: AbortSignal;
  selector: Selector;
  cached?: unknown;
  trigger: "project-turn" | "project-replay" | "dispatch-check" | "progress-check" | "wait-check" | "check-replay";
}): Promise<
  | {
      record: SelectionRecord;
      cached: boolean;
      reason: null;
      failure?: undefined;
    }
  | {
      record: undefined;
      cached: false;
      reason: string;
      failure?: ContextFailure;
    }
> {
  const started = performance.now(),
    selectionId = randomUUID(),
    body = JSON.stringify({
      model: JEV_MODEL,
      state: o.state,
      questions: o.questions,
    });
  let stage: ContextFailure["stage"] = "prepare",
    stageStarted = started;
  let response: Response | undefined;
  const move = (next: ContextFailure["stage"]) => {
    stage = next;
    stageStarted = performance.now();
  };
  const failed = (
    reason: string,
    details?: Pick<ContextFailure, "kind" | "errorCode">,
  ) => ({
    record: undefined,
    cached: false as const,
    reason,
    failure: details
      ? contextFailureSchema.parse({
          selectionId,
          stage,
          ...details,
          transport: o.selector.gateway ? "gateway" : "direct",
          durationMs: Math.round(performance.now() - started),
          stageDurationMs: Math.round(performance.now() - stageStarted),
          timeoutMs: 8000,
          requestBytes: Buffer.byteLength(body),
          candidateCount: o.count,
          ...(response
            ? {
                status: response.status,
                ...Object.fromEntries(
                  [
                    ["gatewayLogId", "cf-aig-log-id"],
                    ["providerRequestId", "x-request-id"],
                    ["cfRay", "cf-ray"],
                  ].flatMap(([field, header]) => {
                    const value = contextFailureSchema.shape[
                      field as "gatewayLogId" | "providerRequestId" | "cfRay"
                    ].safeParse(response!.headers.get(header));
                    return value.success ? [[field, value.data]] : [];
                  }),
                ),
              }
            : {}),
        })
      : undefined,
  });
  if (o.selector.mode === "off") return failed("disabled");
  if (!fitsRequest(o.state, o.questions))
    return failed("request_too_large", { kind: "request_too_large" });
  let record: SelectionRecord;
  const cached = selectionRecordSchema.safeParse(o.cached);
  if (
    cached.success &&
    cached.data.version === o.version &&
    Array.from({ length: o.count }).every(
      (_, i) => cached.data.probabilities[`keep_${i}`] !== undefined,
    ) &&
    Object.keys(cached.data.probabilities).length === o.count
  )
    record = cached.data;
  else {
    move("key");
    let key: string;
    try {
      key = await o.selector.key();
    } catch (error) {
      o.signal.throwIfAborted();
      return failed("key_unavailable", {
        ...transportFailure(error),
        kind: "key_unavailable",
      });
    }
    if (!key.trim())
      return failed("key_unavailable", { kind: "key_unavailable" });
    move("request");
    const timeout = AbortSignal.timeout(8000);
    try {
      const gateway = o.selector.gateway;
      const endpoint = gateway
        ? `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/custom-typesafe/v1/systemone`
        : "https://api.typesafe.ai/v1/systemone";
      response = await (o.selector.fetch ?? fetch)(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...(gateway
            ? {
                "cf-aig-collect-log": "true",
                "cf-aig-collect-log-payload": "false",
                "cf-aig-skip-cache": "true",
                "cf-aig-max-attempts": "1",
                "cf-aig-no-wholesale": "true",
                "cf-aig-custom-cost": JSON.stringify({
                  per_token_in: JEV_INPUT_COST_PER_TOKEN,
                  per_token_out: 0,
                }),
                "cf-aig-metadata": JSON.stringify({
                  process: o.trigger.includes("check") ? "run-checks" : "context-selection",
                  trigger: o.trigger,
                  worker: "projects-runner",
                  model: JEV_MODEL,
                  selectionId,
                }),
              }
            : {}),
        },
        body,
        signal: AbortSignal.any([o.signal, timeout]),
      });
      move("response");
      if (!response.ok)
        return failed(`http_${response.status === 429 ? "limited" : "error"}`, {
          kind: "http",
        });
      const answer = await response.json();
      move("validation");
      const parsed = z
        .object({
          model: z.literal(JEV_MODEL),
          answers: z.record(
            z.string(),
            z.object({
              type: z.literal("noul"),
              noul: z.number().min(0).max(1),
            }),
          ),
          usage: z.object({
            input_tokens: z.number().int().nonnegative(),
            output_tokens: z.number().int().nonnegative(),
          }),
        })
        .parse(answer);
      if (
        Object.keys(parsed.answers).length !== o.count ||
        !Array.from({ length: o.count }).every(
          (_, i) => parsed.answers[`keep_${i}`],
        )
      )
        return failed("invalid_response", { kind: "answer_coverage" });
      record = {
        version: o.version,
        policy: POLICY,
        model: JEV_MODEL,
        probabilities: Object.fromEntries(
          Object.entries(parsed.answers).map(([k, v]) => [k, v.noul]),
        ),
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
        durationMs: performance.now() - started,
        transport: gateway ? "gateway" : "direct",
        selectionId,
      };
    } catch (error) {
      o.signal.throwIfAborted();
      return failed(
        error instanceof z.ZodError || error instanceof SyntaxError
          ? "invalid_response"
          : "service_failed",
        error instanceof z.ZodError
          ? { kind: "invalid_schema" }
          : error instanceof SyntaxError
            ? { kind: "invalid_json" }
            : {
                ...transportFailure(error),
                ...(timeout.aborted ? { kind: "timeout" as const } : {}),
              },
      );
    }
  }
  o.signal.throwIfAborted();
  return {
    record,
    cached: record === (cached.success ? cached.data : null),
    reason: null,
  };
}

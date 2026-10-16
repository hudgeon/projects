import { z } from "zod";
// A connected machine's id: a slug of the name its owner gave it.
export const machineIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const outcome = z.enum([
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "shutdown",
  "accepted",
  "rejected",
]);
const reason = z.enum([
  "invalid_result",
  "process_unconfirmed",
  "native_error",
  "native_timeout",
  "native_unavailable",
  "permission_required",
  "session_active",
  "protocol_error",
  "shutdown",
  "cancelled",
  "claim_lost",
  "unexpected",
  "http_error",
  "network_error",
  "invalid_response",
  "step_limit",
  "model_busy",
  "usage_limit",
  "session_rejected",
  "turn_rejected",
  "native_exited",
  "turn_failed",
  "context_exceeded",
  "signed_out",
  "policy_refused",
  "sandbox_error",
  "turn_limit",
  "workspace_changed",
  "git_failed",
  "decision_rejected",
  "child_limit",
  "screenshot_failed",
  "journal_problem",
  "report_failed",
  "recovery_limit",
  "time_limit",
  "token_limit",
]);
export type FailureReason = z.infer<typeof reason>;
export const executionEventSchema = z
  .object({
    id: z.uuid(),
    at: ms,
    event: z.enum([
      "native_started",
      "native_finished",
      "workspace_prepared",
      "workspace_save_failed",
      "recovery_started",
      "recovery_finished",
      "checkpoint_replayed",
      "master_decision",
      "execution_interrupted",
      "execution_paused",
      // A failure the runner gave back to the master instead of the owner.
      "execution_handed_back",
      // A helper turn past its time or tokens was asked to wrap up.
      "turn_limit_reached",
    ]),
    actor: z.enum(["master", "codex", "claude"]).optional(),
    // The app running a master turn; a child's actor already names its app.
    agent: z.enum(["codex", "claude"]).optional(),
    childId: z.uuid().optional(),
    turnId: z.uuid().optional(),
    mode: z.enum(["read", "change"]).optional(),
    resumed: z.boolean().optional(),
    durationMs: ms.optional(),
    // Requested speed and resolved session configuration, never prompt text.
    codexFast: z.boolean().optional(),
    model: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/).optional(),
    effort: z.string().regex(/^[a-zA-Z0-9_-]{1,30}$/).optional(),
    firstOutputMs: ms.optional(),
    attempts: z.number().int().min(1).max(3).optional(),
    tokenUsageObserved: z.boolean().optional(),
    // A finished native turn's tokens, as its app reported them.
    freshTokens: ms.optional(),
    cachedTokens: ms.optional(),
    outputTokens: ms.optional(),
    outcome: outcome.optional(),
    reason: reason.optional(),
    action: z.enum(["dispatch", "complete", "blocked"]).optional(),
  })
  .strict();
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
// Bounded receipts travel through the existing authenticated report/journal path.
// They contain categories and timings, never model text or native identifiers.
export const TELEMETRY_LIMIT = 40;
export const routeSchema = z.enum([
  "/api/auth/request",
  "/api/auth/verify",
  "/api/auth/logout",
  "/api/overview",
  "/api/execution-settings",
  "/api/archive",
  "/api/ingest",
  "/api/closes",
  "/api/review",
  "/api/work/close",
  "/api/inbox/act",
  "/api/inbox/actions",
  "/api/inbox/threads/:id",
  "/api/push/key",
  "/api/push/events",
  "/api/push/subscribe",
  "/api/push/unsubscribe",
  "/api/runs",
  "/api/runs/:id",
  "/api/runs/:id/message",
  "/api/runs/:id/cancel",
  "/api/runs/:id/archive",
  "/api/runs/:id/screenshots/:id",
  "/api/runs/:id/browser",
  "/api/runs/:id/browser/view",
  "/api/browser/:id/cdp",
  "/api/runner/claim",
  "/api/runner/heartbeat",
  "/api/runner/report",
  "/api/runner/screenshot",
  "/api/runner/readiness",
  "/api/runner/browser",
  "unknown",
  "asset",
]);
// This runtime allowlist is shared by the Worker and runner. Unknown properties
// are stripped even if a caller accidentally supplies a prompt, Error or token.
export const telemetryFieldsSchema = executionEventSchema
  .omit({ event: true, id: true })
  .partial()
  .extend({
    runId: z.uuid().optional(),
    generation: z.number().int().positive().optional(),
    eventId: z.uuid().optional(),
    requestId: z.uuid().optional(),
    messageId: z.uuid().optional(),
    seq: z.number().int().nonnegative().optional(),
    route: routeSchema.optional(),
    method: z.enum(["GET", "POST", "HEAD", "OPTIONS", "OTHER"]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    state: z
      .enum([
        "queued",
        "running",
        "cancelling",
        "completed",
        "blocked",
        "failed",
        "cancelled",
      ])
      .optional(),
    previousState: z
      .enum([
        "queued",
        "running",
        "cancelling",
        "completed",
        "blocked",
        "failed",
        "cancelled",
      ])
      .optional(),
    queueMs: ms.optional(),
    feedbackMs: ms.optional(),
    heartbeatAgeMs: ms.optional(),
    conversationAgeMs: ms.optional(),
    concurrency: z.number().int().min(1).max(5).optional(),
    host: machineIdSchema.optional(),
    browserOperation: z.enum(["lookup", "connect", "close"]).optional(),
    childCount: z.number().int().min(0).max(24).optional(),
    attempt: z.number().int().positive().optional(),
    sampleRate: z.number().min(0).max(1).optional(),
  })
  .strip();
export type TelemetryFields = z.infer<typeof telemetryFieldsSchema>;
const logEventSchema = z.enum([
  ...executionEventSchema.shape.event.options,
  "request_finished",
  "operation_failed",
  "conversation_created",
  "conversation_claimed",
  "conversation_moved",
  "conversation_state_changed",
  "conversation_archived",
  "conversation_restored",
  "project_archived",
  "project_restored",
  "session_archived",
  "session_restored",
  "feedback_queued",
  "feedback_steered",
  "feedback_reviewed",
  "runner_disconnected",
  "runner_reconnected",
  "alarm_reconciled",
  "alarm_failed",
  "progress_summary_saved",
  "browser_created",
  "browser_connected",
  "browser_closed",
  "browser_failed",
  "runner_request_failed",
  "runner_request_recovered",
  "runner_started",
  "runner_stopping",
  "runner_needs_inspection",
  "runner_connection_unavailable",
  "runner_start_failed",
  "runner_draining",
  "runner_executor_adopted",
  "runner_executor_failed",
  "notification_sent",
]);
export function telemetry(
  component: "worker" | "conversation" | "runner",
  event: z.infer<typeof logEventSchema>,
  fields: TelemetryFields = {},
  level: "info" | "warn" | "error" = "info",
) {
  // Observability must never change execution or delivery semantics.
  try {
    const parsed = telemetryFieldsSchema.safeParse(fields);
    const name = logEventSchema.safeParse(event);
    if (!parsed.success || !name.success) {
      console.warn(
        JSON.stringify({
          schemaVersion: 1,
          at: Date.now(),
          event: "telemetry_invalid",
        }),
      );
      return;
    }
    console[level](
      JSON.stringify({
        schemaVersion: 1,
        at: Date.now(),
        component,
        event: name.data,
        ...parsed.data,
      }),
    );
  } catch {
    /* The execution receipt remains authoritative if logging fails. */
  }
}

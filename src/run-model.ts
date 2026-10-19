import { z } from "zod";
import {
  executionEventSchema,
  machineIdSchema,
  TELEMETRY_LIMIT,
} from "./telemetry";
import { screenshotInputsSchema, type Screenshot } from "./screenshot-model";

const uuid = z.uuid();
const projectId = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
export const agentSchema = z.enum(["codex", "claude"]);
export type Agent = z.infer<typeof agentSchema>;
export const runStateSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);
// Quick work (such as an unsubscribe) has its own runner capacity and a
// lighter master turn, so it never waits behind long-running work.
export const laneSchema = z.enum(["standard", "quick"]);
export type Lane = z.infer<typeof laneSchema>;
export const QUICK_ACTIVE_LIMIT = 30;
export const STANDARD_ACTIVE_LIMIT = 10;
export const messageInputSchema = z
  .object({
    requestId: uuid,
    text: z.string().trim().min(1).max(8000),
    screenshots: screenshotInputsSchema.optional(),
  })
  .strict();
export const runInputSchema = messageInputSchema
  .extend({
    projectId: projectId.nullable(),
    agent: z.enum(["auto", "codex", "claude"]),
    // Which native app coordinates the conversation; Codex when omitted.
    masterAgent: agentSchema.optional(),
    workIssue: z.number().int().positive().nullable(),
    // The Gmail thread a conversation was started from, so the inbox can show
    // that it is being handled. A label only; it grants no mailbox access.
    emailThread: z
      .string()
      .regex(/^[a-f0-9]{10,40}$/)
      .nullable()
      .optional(),
    lane: laneSchema.optional(),
  })
  .strict();
export const runListSchema = z.object({
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  projectId: projectId.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  // Every conversation started from an email, current or Done, for the inbox.
  email: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
export const EMAIL_RUN_LIMIT = 500;
export type RunListOptions = {
  archived?: boolean;
  projectId?: string;
  offset?: number;
  email?: boolean;
};
export const runArchiveSchema = z.object({ archived: z.boolean() }).strict();
export const childResultSchema = z
  .object({
    outcome: z.enum(["completed", "blocked"]),
    summary: z.string().max(6000),
    checks: z.array(z.string().max(600)).max(12),
    links: z
      .array(
        z
          .url()
          .max(1000)
          .regex(/^https:\/\/github\.com\//)
          .refine(
            (s) =>
              new URL(s).protocol === "https:" &&
              new URL(s).hostname === "github.com",
          ),
      )
      .max(12),
  })
  .strict();
// Tokens native turns used, as their apps reported them: new input (cache
// writes included), cached input read again, and output, with the turn count
// and the size of the latest request's context. Counts only.
const tokens = z.number().int().nonnegative();
export const usageSchema = z
  .object({
    fresh: tokens,
    cached: tokens,
    output: tokens,
    turns: tokens,
    context: tokens,
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;
export const noUsage = (): Usage => ({
  fresh: 0,
  cached: 0,
  output: 0,
  turns: 0,
  context: 0,
});
export const usageTotal = (usage: Usage | undefined) =>
  usage ? usage.fresh + usage.cached + usage.output : 0;
// Why the other app took over coordinating, as the details say it.
export const MASTER_TAKEOVER = {
  policy_refused: "declined this conversation under its usage policy",
  usage_limit: "reached its usage limit",
  signed_out: "is signed out on this machine",
  native_unavailable: "would not start on this machine",
  repeated_failure: "failed twice in a row",
} as const;
export const childSchema = z
  .object({
    id: uuid,
    projectId,
    agent: agentSchema,
    mode: z.enum(["read", "change"]),
    cwd: z.string().max(1200),
    branch: z.string().max(200),
    sessionId: z.string().max(200).nullable(),
    state: z.enum([
      "running",
      "completed",
      "blocked",
      "failed",
      "cancelled",
      "unknown",
    ]),
    result: childResultSchema.nullable(),
    evidence: z.array(z.string().max(1000)).max(8),
    // The machine whose sessions and worktree it used. Children from before
    // machines were recorded ran on the conversation's machine.
    host: machineIdSchema.optional(),
    // False once its native session cannot continue, such as one that ran out
    // of room: work in its worktree continues in a fresh session.
    resumable: z.boolean().optional(),
    // Its turns' tokens, its recovery inspection included.
    usage: usageSchema.optional(),
  })
  .strict();
// Activity contains only protocol categories, never commands, arguments,
// transcripts, reasoning, file contents or tool output.
export const nativeActivitySchema = z
  .object({
    kind: z.enum([
      "turn",
      "command",
      "read",
      "search",
      "edit",
      "tool",
      "compaction",
      "response",
    ]),
    state: z.enum(["started", "finished", "failed"]),
  })
  .strict();
export const activitySchema = nativeActivitySchema
  .extend({
    id: uuid,
    at: z.number().int().positive(),
    actor: z.enum(["master", "codex", "claude"]),
    childId: uuid.nullable(),
  })
  .strict();
export const ACTIVITY_LIMIT = 40;
// Explicit, user-facing progress notes; never a copy of a native transcript.
export const progressNoteInputSchema = z
  .object({
    done: z.array(z.string().trim().min(1).max(240)).max(8),
    remaining: z.array(z.string().trim().min(1).max(240)).max(8),
    // The steps the owner must take before work can continue; null otherwise.
    yourMove: z.string().trim().min(1).max(400).nullable().optional(),
    // Older notes named any obstacle here, often one the agent worked around,
    // so it is accepted but never shown as something the owner must do.
    blocker: z.string().trim().min(1).max(400).nullable().optional(),
  })
  .strict();
export const progressNoteSchema = progressNoteInputSchema
  .extend({
    id: uuid,
    at: z.number().int().positive(),
    actor: z.enum(["master", "codex", "claude"]),
    childId: uuid.nullable(),
  })
  .strict();
export const PROGRESS_NOTE_LIMIT = 12;
export const LIVE_STEPS = 12;
export const LIVE_FILES = 20;
// While a turn runs: the working agent's own plan and the branch's changed
// files. Plan steps are agent text; changes are file names and line counts,
// never contents. Neither reaches telemetry.
export const livePlanStepSchema = z
  .object({
    step: z.string().trim().min(1).max(200),
    status: z.enum(["pending", "active", "done"]),
  })
  .strict();
const lines = z.number().int().nonnegative();
export const liveChangesSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(300),
            added: lines,
            removed: lines,
          })
          .strict(),
      )
      .max(LIVE_FILES),
    total: z.object({ files: lines, added: lines, removed: lines }).strict(),
    at: z.number().int().positive(),
  })
  .strict();
// What a long wait is on, as a category the runner reads from the command on
// its own machine; the command itself never leaves it.
export const waitLabels = ["review", "checks", "tests", "build", "deploy", "git", "remote", "loop"] as const;
export type WaitLabel = (typeof waitLabels)[number];
// A turn waiting on one step: since when, on what, and once the runner sees
// signs it may be stuck, which sign and since when things went quiet. Times
// and categories only.
export const liveWatchSchema = z
  .object({
    since: z.number().int().positive(),
    on: z.enum(["command", "tool", "agent"]),
    label: z.enum(waitLabels).optional(),
    stuck: z.enum(["idle", "silent"]).optional(),
    quietSince: z.number().int().positive().optional(),
  })
  .strict();
export type LiveWatch = z.infer<typeof liveWatchSchema>;
export const liveSchema = z
  .object({
    actor: z.enum(["master", "codex", "claude"]),
    childId: uuid.nullable(),
    at: z.number().int().positive(),
    plan: z.array(livePlanStepSchema).max(LIVE_STEPS).optional(),
    changes: liveChangesSchema.optional(),
    // When the change worktree was last saved to GitHub for another machine.
    savedAt: z.number().int().positive().optional(),
    watch: liveWatchSchema.optional(),
  })
  .strict();
export type LivePlanStep = z.infer<typeof livePlanStepSchema>;
export type LiveChanges = z.infer<typeof liveChangesSchema>;
export type Live = z.infer<typeof liveSchema>;
export const PROGRESS_UPDATE_MS = 5 * 60_000;
export const PROGRESS_UPDATE_LIMIT = 24;
export type ProgressNoteInput = z.infer<typeof progressNoteInputSchema>;
export type ProgressNote = z.infer<typeof progressNoteSchema>;
export type ProgressUpdate = {
  id: string;
  generation: number;
  from: number;
  to: number;
  done: string[];
  note: ProgressNote | null;
  operations: Partial<Record<NativeActivity["kind"], number>>;
  failed: number;
  state: RunState;
  disconnected: boolean;
};
export const progressSchema = z
  .object({
    seq: z.number().int().positive(),
    state: z.enum(["running", "completed", "blocked", "failed", "cancelled"]),
    // The master's short label for what this conversation is working on.
    title: z.string().trim().min(1).max(80).optional(),
    summary: z.string().max(12000),
    children: z.array(childSchema).max(24),
    masterSessionId: z.string().max(200).nullable(),
    // The app that owns masterSessionId; Codex when omitted.
    masterAgent: agentSchema.optional(),
    // Every coordinator turn's tokens in this conversation.
    masterUsage: usageSchema.optional(),
    // The other app took over coordinating, for the rest of the conversation,
    // when this one refused, was unavailable or kept failing.
    masterFallback: z
      .object({
        from: agentSchema,
        reason: z.enum(
          Object.keys(MASTER_TAKEOVER) as [keyof typeof MASTER_TAKEOVER],
        ),
        at: z.number().int().positive(),
      })
      .strict()
      .optional(),
    activity: z.array(activitySchema).max(ACTIVITY_LIMIT).optional(),
    reviewedMessageIds: z.array(uuid).max(40).optional(),
    // Feedback given to the agent working at the time; the master still
    // reviews it at its next decision.
    steeredMessageIds: z.array(uuid).max(40).optional(),
    live: liveSchema.optional(),
    telemetry: z.array(executionEventSchema).max(TELEMETRY_LIMIT).optional(),
    notes: z.array(progressNoteSchema).max(PROGRESS_NOTE_LIMIT).optional(),
  })
  .strict();
const runnerIdentitySchema = z.object({ runnerId: uuid }).strict();
export const runnerClaimSchema = runnerIdentitySchema
  .extend({
    activeRunIds: z.array(uuid).max(20).default([]),
    // Lanes with a free slot; an older runner omits it and takes either.
    lanes: z.array(laneSchema).min(1).max(2).optional(),
    // It can fetch an HTML edition the owner opened; an older runner cannot.
    documents: z.boolean().optional(),
  })
  .strict();
export const runnerReportSchema = runnerIdentitySchema
  .extend({
    id: uuid,
    generation: z.number().int().positive(),
    progress: progressSchema,
  })
  .strict();
export const runnerHeartbeatSchema = runnerIdentitySchema
  .extend({ id: uuid, generation: z.number().int().positive() })
  .strict();
// An explicit report for this request, not a claim that the runner independently
// verified external systems. Older journals and read-only answers may omit it.
const deliveryGateSchema = z
  .object({
    status: z.enum(["verified", "not_required", "pending"]),
    evidence: z.string().trim().min(1).max(1000),
  })
  .strict();
export const deliverySchema = z
  .object({
    scope: z.string().trim().min(1).max(600),
    checks: deliveryGateSchema,
    review: deliveryGateSchema,
    merge: deliveryGateSchema,
    deployment: deliveryGateSchema,
    visual: deliveryGateSchema,
    sync: deliveryGateSchema,
  })
  .strict();
export const workRecordSchema = z
  .object({
    status: z.enum(["updated", "unchanged", "pending"]),
    evidence: z.string().trim().min(1).max(1200),
  })
  .strict();
export const masterDecisionSchema = z
  .object({
    action: z.enum(["dispatch", "complete", "blocked"]),
    // Unbounded here so an over-long label cannot invalidate a decision; the
    // runner trims it to the progress title limit.
    title: z.string().nullable(),
    summary: z.string().max(8000),
    // Rotate only after this decision; never interrupt an executing child.
    resetContext: z.boolean().nullable().optional(),
    delivery: deliverySchema.nullable().optional(),
    // The coordinator's readback assessment of the canonical work record,
    // kept in its private decision journal, never a second work backlog.
    workRecord: workRecordSchema.nullable().optional(),
    task: z
      .object({
        projectId,
        agent: agentSchema,
        mode: z.enum(["read", "change"]),
        workspace: z.string().max(200),
        // Retain the owned worktree while discarding the native transcript.
        freshSession: z.boolean().nullable().optional(),
        prompt: z.string().min(1).max(8000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RunInput = z.infer<typeof runInputSchema>;
export type MessageInput = z.infer<typeof messageInputSchema>;
export type Child = z.infer<typeof childSchema>;
export type ChildResult = z.infer<typeof childResultSchema>;
export type Progress = z.infer<typeof progressSchema>;
export type MasterDecision = z.infer<typeof masterDecisionSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type NativeActivity = z.infer<typeof nativeActivitySchema>;
export type RunActivity = z.infer<typeof activitySchema>;
export function activityLabel(event: NativeActivity) {
  const names: Record<NativeActivity["kind"], string> = {
    turn: "Agent turn",
    command: "Command",
    read: "File read",
    search: "Search",
    edit: "File change",
    tool: "Tool call",
    compaction: "Context compaction",
    response: "Response",
  };
  return `${names[event.kind]} ${event.state}`;
}
export type RunMessage = {
  id: string;
  role: "user" | "master";
  text: string;
  at: number;
  delivery?: "queued" | "steered" | "reviewed";
  screenshots?: Screenshot[];
};
// A connected machine's id.
export type RunnerHost = string;
export type Run = {
  id: string;
  projectId: string | null;
  agent: RunInput["agent"];
  masterAgent?: Agent;
  workIssue: number | null;
  emailThread?: string | null;
  lane?: Lane;
  // The person who started it, by email. Conversations from before people had
  // profiles belong to the deployment owner, which the portfolio fills in when
  // it reads them.
  owner: string;
  generation: number;
  state: RunState;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  // The machine that claimed it; its follow-ups stay there. Unset before a
  // claim.
  host?: RunnerHost;
  // The owner continued it elsewhere while this machine was away. Its
  // sessions and worktrees stay there; the next machine starts a new
  // coordinator.
  movedFrom?: RunnerHost;
  movedAt?: number;
  archivedAt?: number | null;
  connection?: "connected" | "disconnected";
  messages: RunMessage[];
  progress: Progress | null;
  updates?: ProgressUpdate[];
  nextUpdateAt?: number | null;
};
export type RunSummary = Pick<
  Run,
  | "id"
  | "projectId"
  | "agent"
  | "state"
  | "createdAt"
  | "updatedAt"
  | "heartbeatAt"
  | "archivedAt"
  | "workIssue"
  | "emailThread"
  | "lane"
  | "host"
  | "owner"
> & {
  title: string;
  projectIds?: string[];
  // Index summaries saved before these fields existed are refreshed on load.
  status?: string;
  remaining?: number | null;
  // Running, but waiting on steps only the owner can take.
  needsYou?: boolean;
  // Running, but the runner sees signs its current step is stuck.
  stuck?: boolean;
};
export function runProjectIds(
  run: Pick<Run, "projectId" | "progress">,
): string[] {
  return [
    ...new Set([
      ...(run.projectId ? [run.projectId] : []),
      ...(run.progress?.children.map((child) => child.projectId) ?? []),
    ]),
  ];
}
export const activeRun = (state: RunState) =>
  ["queued", "running", "cancelling"].includes(state);
// The user's move: finished work to review, or running work only they can
// unblock.
export const awaitsYou = (run: Pick<RunSummary, "state" | "needsYou" | "stuck">) =>
  !activeRun(run.state) || !!run.needsYou || !!run.stuck;
export const RUNNER_STALE_MS = 45_000;
// A later machine in the owner's order starts new conversations only once
// every earlier machine's runner has been silent this long. An idle runner
// claims every two seconds and a busy one heartbeats every ten, so a restart
// or brief network drop does not hand work over.
export const FALLBACK_AFTER_MS = 120_000;

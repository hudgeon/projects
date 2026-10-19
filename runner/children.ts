// Helpers' results: accepting one, inspecting an interrupted helper
// read-only, and giving failures back to the coordinator.
import type { ExecutionEvent } from "../src/telemetry";
import { childResultSchema, type Child, type ChildResult } from "../src/run-model";
import { Failure, NativeStopError, nativeProcessStopped } from "./native";
import type { ProjectDirectory } from "./workspaces";
import { childContext } from "./context";
import { SPENT, UNAVAILABLE, HANDBACK_LIMIT } from "./turn-limits";
import type { Execution } from "./execution";
import { outputSchema } from "./decisions";

export function handBack(
  x: Execution,
  reason: NonNullable<ExecutionEvent["reason"]>,
  fields: Omit<ExecutionEvent, "id" | "at" | "event" | "reason">,
  plain: string,
  prompt: string,
): void {
  const { s, event } = x;
  event("execution_handed_back", { ...fields, reason });
  if (++s.handbacks > HANDBACK_LIMIT)
    throw new Failure(
      "recovery_limit",
      `This turn ran into ${HANDBACK_LIMIT + 1} problems in a row, so Projects paused it. The last one: ${plain}`,
    );
  s.nextPrompt = prompt;
}
export async function acceptChild(x: Execution, child: Child, value: ChildResult): Promise<void> {
  const { s, j, persist, evidence, lastSaved, copiedAt, refusedBy, overran, freshIn } = x;
  child.result = value;
  child.state = value.outcome;
  child.evidence = await evidence(child.cwd);
  const copied = copiedAt.get(child.id),
    saved = lastSaved.get(child.id),
    refused = refusedBy.get(child.id) ?? [];
  const counts = new Map<string, number>();
  for (const kind of refused) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  child.evidence = [
    ...child.evidence,
    ...(copied
      ? [
          `Observed starting copy from another machine, as of: ${new Date(copied).toISOString()}`,
        ]
      : []),
    ...(saved
      ? [`Observed saved copy on GitHub: ${new Date(saved).toISOString()}`]
      : []),
    ...(refused.length
      ? [
          `Observed refused requests, which the agent carried on without: ${[...counts].map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind)).join(", ")}`,
        ]
      : []),
    ...(freshIn.has(child.id)
      ? ["Observed: a fresh session continued this worktree"]
      : []),
    ...(overran.has(child.id)
      ? ["Observed: its process ran on after it reported, so Projects stopped it and any commands it left running"]
      : []),
  ].slice(0, 8);
  j.phase = "ready";
  j.pid = null;
  delete j.checkpoint;
  await persist();
  s.nextPrompt = `A child has returned. Review the evidence before deciding what remains. Native success is not delivery proof.\n${JSON.stringify(child)}\nOther children: ${childContext(j.progress.children.filter((c) => c.id !== child.id))}`;
}
// A child whose turn ended without a confirmed result is inspected
// read-only in its own session, after the usual ownership checks; nothing
// it did is repeated.
export async function inspect(x: Execution, child: Child, project: ProjectDirectory): Promise<void> {
  const {
    o, j, persist, publish, prepare, evidence, here, runTurn, workLine, projectBrief, acceptChild,
  } = x;
  await prepare(
    project,
    {
      projectId: child.projectId,
      agent: child.agent,
      mode: child.mode,
      workspace: child.id,
      prompt: "Inspect recovery",
    },
    j.progress.children.map((c) =>
      c.id === child.id ? { ...c, state: "blocked" } : c,
    ),
    o.run.id,
    child.id,
    o.worktreeRoot,
    here,
  );
  child.evidence = await evidence(child.cwd);
  const browser = await o.browser?.();
  const projectContext = await projectBrief(project, child.cwd,
    "Read-only recovery inspection of the same native session and existing workspace; verify uncertain prior effects without replaying them.",
    child.id, child.agent, child.sessionId, "");
  child.state = "unknown";
  // Inspection resumes this session with restricted tools. Keep its history
  // for reconciliation, but continue changes in a fresh session afterwards.
  child.resumable = false;
  j.phase = "child";
  await publish(
    "running",
    "Checking what the interrupted work finished before continuing.",
  );
  const recovered = await runTurn(
    {
      agent: child.agent,
      cwd: child.cwd,
      sessionId: child.sessionId!,
      browser,
      readOnly: true,
      signal: o.signal,
      schema: outputSchema(childResultSchema),
      prompt: `${workLine}${projectContext.prompt}\nRECOVERY INSPECTION ONLY. Your previous turn ended without a confirmed receipt. Review this same session's history and inspect the existing workspace read-only. Do not repeat mutating commands, execute changes, publish, close issues, or retry external side effects. You may repeat read-only checks to establish current evidence. Return the required structured result describing what is demonstrably complete and what remains uncertain. A historical success claim is not current verification. Use outcome blocked for any unresolved work or uncertainty; the master will decide what happens next. Observed workspace: ${JSON.stringify(child.evidence)}`,
      onSession: async (id) => {
        if (id !== child.sessionId)
          throw Error("Recovery must use the existing native session.");
      },
      onFile: projectContext.onFile,
      onProcess: async (pid) => {
        j.pid = pid;
        await persist();
      },
    },
    child,
    (value) => {
      j.checkpoint = {
        kind: "child",
        childId: child.id,
        value: childResultSchema.parse(value),
      };
    },
  );
  await projectContext.remember(child.sessionId);
  await acceptChild(child, childResultSchema.parse(recovered));
}
// A helper turn failed while this runner watched it. Its process has
// stopped; the master hears what failed, and what an inspection of the same
// session found, or the worktree's state when that session cannot run.
export async function recoverChild(
  x: Execution,
  child: Child,
  project: ProjectDirectory,
  error: unknown,
): Promise<void> {
  const { o, j, failureReason, persist, evidence, appName, handBack, inspect } = x;
  const reason = failureReason(error);
  const plain = error instanceof Error ? error.message : "It stopped.";
  child.state = "unknown";
  if (SPENT.has(reason)) child.resumable = false;
  // A tool the agent started can outlive it briefly; wait for its group.
  const stopped = o.processStopped ?? nativeProcessStopped;
  for (let waited = 0; j.pid && !stopped(j.pid); waited += 1000) {
    if (waited >= 30_000)
      throw new NativeStopError(
        "An agent process did not confirm it stopped, so nothing else was started. Send a follow-up once it has stopped.",
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  let inspected = false;
  if (child.sessionId && !SPENT.has(reason) && !UNAVAILABLE.has(reason))
    try {
      await inspect(child, project);
      inspected = true;
    } catch (inspection) {
      if (o.signal.aborted || inspection instanceof NativeStopError)
        throw inspection;
    }
  if (!inspected) {
    child.state = "blocked";
    child.result = {
      outcome: "blocked",
      summary: `${appName(child.agent)} stopped before reporting: ${plain} What it finished is unconfirmed; the observed worktree is below.`,
      checks: [],
      links: [],
    };
    child.evidence = await evidence(child.cwd).catch(() => []);
    j.phase = "ready";
    j.pid = null;
    delete j.checkpoint;
    await persist();
  }
  handBack(
    reason,
    { actor: child.agent, childId: child.id },
    plain,
    `${appName(child.agent)}'s turn ended before it reported: ${plain} ${inspected ? "Projects then inspected its session read-only; the report below is that inspection, not new work." : "Its session could not be inspected, so only the observed worktree is known."} Never repeat a change the evidence shows already landed. To continue in that worktree, give its ID as the workspace${child.resumable === false ? "; a fresh session starts there" : ""}. A failure you can retry or route around, for example with the other app, is not blocked.\n${JSON.stringify(child)}\nOther children: ${childContext(j.progress.children.filter((c) => c.id !== child.id))}`,
  );
}
// A saved helper result is accepted without another turn, and an interrupted
// turn is reconciled read-only before anything new starts.
export async function resumeInterrupted(x: Execution) {
  const { s, o, j, event, persist, interrupted, ranHere, acceptChild, inspect, paused } = x;
  if (j.checkpoint?.kind === "child") {
    event("checkpoint_replayed", { actor: "master" });
    const child = j.progress.children.find(
      (c) => c.id === (j.checkpoint as { childId: string }).childId,
    );
    if (!child)
      throw new Failure(
        "journal_problem",
        "A saved helper result could not be matched to its helper, so nothing was repeated.\n\n**Your move:** Start a new conversation for this work; this one's saved state on its machine needs repair first.",
      );
    await acceptChild(child, j.checkpoint.value);
  } else if (interrupted && !j.checkpoint) {
    if (await paused()) return "paused";
    event("recovery_started");
    const recoveryStarted = performance.now();
    o.signal.throwIfAborted();
    if (!(o.processStopped ?? nativeProcessStopped)(j.pid))
      throw new NativeStopError(
        "A previous agent process may still be running, so nothing new was started.\n\n**Your move:** Send a follow-up once it has stopped.",
      );
    // Only this machine's own step can have been interrupted here. A moved
    // conversation's earlier steps stay on another machine, outcome unknown,
    // and the coordinator checks them before repeating anything.
    const child = [...j.progress.children]
      .reverse()
      .find(
        (c) =>
          ranHere(c) && ["running", "unknown", "cancelled"].includes(c.state),
      );
    if (child) {
      if (!child.sessionId)
        throw new Failure(
          "journal_problem",
          "An interrupted helper left no session to check, so nothing was repeated.\n\n**Your move:** Start a new conversation for this work; this one's saved state on its machine needs repair first.",
        );
      const project = o.projects.find((p) => p.id === child.projectId);
      if (!project || (o.run.projectId && project.id !== o.run.projectId))
        throw new Failure(
          "workspace_changed",
          "The recovery workspace is outside this conversation's registered project.",
        );
      // Reuse the existing ownership checks, without creating a workspace or
      // granting write access. A PID disappearing alone never replays work.
      await inspect(child, project);
      s.nextPrompt +=
        "\nThis was a read-only reconciliation of an interrupted turn, not a new execution. Verify external effects and unfinished steps before resuming; never repeat already completed changes. Address the latest user feedback.";
    } else {
      if (!j.progress.masterSessionId)
        throw new Failure(
          "journal_problem",
          "The interrupted coordinator left no session to resume, so nothing was repeated.\n\n**Your move:** Start a new conversation for this work; this one's saved state on its machine needs repair first.",
        );
      j.phase = "ready";
      j.pid = null;
      await persist();
      s.nextPrompt +=
        "\nYour last coordinator turn was interrupted. No new dispatch from it was executed. Reconcile the recorded children and current user messages before deciding what remains.";
    }
    event("recovery_finished", {
      durationMs: Math.round(performance.now() - recoveryStarted),
      outcome: "completed",
    });
  }
}

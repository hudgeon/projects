import { workRecordGate } from "./work-record";
import path from "node:path";
import { z } from "zod";
import type { ScreenshotInput } from "../src/screenshot-model";
import type { Agent, Child, RunMessage } from "../src/run-model";
import { nativeTurn, Failure, NativeStopError } from "./native";
import { prepareWorkspace, pruneSaved, workspaceEvidence } from "./workspaces";
import { clip, plainText } from "../src/run-text";
import { keptKey } from "./context";
import { stoppedText } from "./turn-limits";
import { runChecks } from "./run-checks";
import type { EngineOptions, Execution, RunState } from "./execution";
import { readJournal, openJournal } from "./journal";
import { openCoordinator } from "./coordinator";
import { completionProblem, decide } from "./decisions";
import { runTurn } from "./turns";
import { handBack, acceptChild, inspect, recoverChild, resumeInterrupted } from "./children";
import { dispatch } from "./dispatch";
export { contextConversation, HANDOVER_CHAR_LIMIT } from "./context";
export { activityBrief } from "./activity-brief";
export { MASTER_INPUT_CHAR_LIMIT, MASTER_CONTEXT_LIMIT, HANDBACK_LIMIT, stoppedText } from "./turn-limits";
export { savePrivate } from "./journal";
export { outputSchema, completionProblem } from "./decisions";
export { workInstructions, responseInstructions } from "./instructions";
export { masterInstructions, quickInstructions, movedInstructions } from "./master-instructions";
export type { EngineOptions } from "./execution";

export async function executeRun(o: EngineOptions) {
  if (o.run.lane === "review") o = {...o, inboxes: o.inboxes?.filter(login => login.delegated)};
  // An executor reads the selector's key once and keeps it in memory.
  const selector = o.contextSelector && {...o.contextSelector, key: keptKey(o.contextSelector.key)};
  const checks = runChecks({ selector, stateDir: o.stateDir, runId: o.run.id, signal: o.signal });
  const file = path.join(o.stateDir, "runs", `${o.run.id}.json`);
  const { journal: j, movedHere } = await readJournal(o, file);
  // Nothing is running yet; a live view saved before a restart is stale.
  delete j.progress.live;
  const { event, failureReason, persist, publish, undelivered, delivery } = openJournal(o, j, file);
  if (j.generation > o.run.generation)
    throw new Failure(
      "journal_problem",
      "An older job cannot replace a newer local turn.",
    );
  if (j.phase === "finished" && j.generation === o.run.generation) {
    await o.report(j.progress);
    return;
  }
  const interrupted = ["master", "child", "uncertain"].includes(j.phase);
  const followUp = j.generation !== o.run.generation && !interrupted;
  if (j.generation !== o.run.generation) {
    j.generation = o.run.generation;
    j.progress.seq = 0;
    delete j.progress.notes;
    delete j.delivery;
    delete j.workBaseline;
    delete j.workChanged;
    delete j.progress.reviewChanged;
    if (!interrupted) j.phase = "ready";
  }
  const verifyWorkRecord = await workRecordGate(o.workRepo, o.run.workIssue, o.readWorkRecord, j.workBaseline);
  j.workBaseline = verifyWorkRecord.baseline;
  await persist();
  const turn = o.turn ?? nativeTurn,
    prepare = o.prepare ?? prepareWorkspace,
    evidence = o.evidence ?? workspaceEvidence;
  // Children moved from another machine name it; one without a host was
  // recorded by this machine's runner before hosts were kept.
  const here = o.host;
  const ranHere = (c: Child) => (c.host ?? here) === here;
  // When each change child's worktree was last saved to GitHub, and how
  // recent another machine's copy was for one recreated here.
  const lastSaved = new Map<string, number>(),
    copiedAt = new Map<string, number>(),
    // What each child's agent asked for and the runner refused.
    refusedBy = new Map<string, string[]>(),
    // Children whose process ran on after they reported, until stopped.
    overran = new Set<string>(),
    // Children that continued an existing worktree in a fresh session.
    freshIn = new Set<string>();
  // Once a turn ends, the conversation's copies on GitHub that nothing needs
  // are removed. Unreachable GitHub leaves them for the runner's hourly sweep.
  const settle = () =>
    Promise.all(
      o.projects
        .filter((p) =>
          j.progress.children.some(
            (c) => c.mode === "change" && c.projectId === p.id,
          ),
        )
        .map((p) =>
          (o.prune ?? pruneSaved)(
            p,
            o.run.id,
            j.progress.children,
            o.worktreeRoot,
            here,
          ).catch(() => {}),
        ),
    );
  const imageCache = new Map<string, ScreenshotInput>();
  const screenshots = async (selected: RunMessage[]) => {
    const images: ScreenshotInput[] = [];
    for (const image of selected.flatMap(
      (message) => message.screenshots ?? [],
    )) {
      if (!imageCache.has(image.id)) {
        if (!o.screenshot)
          throw new Failure(
            "screenshot_failed",
            "Screenshot content could not be loaded.",
          );
        imageCache.set(image.id, await o.screenshot(image));
      }
      images.push(imageCache.get(image.id)!);
    }
    return images;
  };
  j.progress.reviewedMessageIds ??= [];
  // The conversation's coordinator app, or this machine's own app when the chosen
  // one is not signed in here. A native session belongs to the app that
  // started it; Codex is recorded by omission, as before this choice.
  const agents = o.agents ?? ["codex", "claude"];
  // The owner's choice, or the app that took over coordinating.
  const chosen = j.progress.masterFallback
    ? (j.progress.masterAgent ?? "codex")
    : (o.run.masterAgent ?? "codex");
  const s: RunState = {
    messages: o.run.messages,
    masterAgent: agents.includes(chosen) ? chosen : agents[0],
    coordinator: null,
    contextPlan: undefined,
    nextPrompt: "",
    dispatched: 0,
    masterFailures: 0,
    handbacks: 0,
  };
  const refreshMessages = async () => {
    s.messages = (await o.messages?.()) ?? s.messages;
  };
  if ((j.progress.masterAgent ?? "codex") !== s.masterAgent)
    j.progress.masterSessionId = null;
  if (s.masterAgent === "codex") delete j.progress.masterAgent;
  else j.progress.masterAgent = s.masterAgent;
  const appName = (agent: Agent) => (agent === "codex" ? "Codex" : "Claude");
  // A request for an app this machine has not signed in to starts nothing.
  if (!interrupted && o.run.agent !== "auto" && !agents.includes(o.run.agent)) {
    j.phase = "finished";
    await publish(
      "blocked",
      `${appName(o.run.agent)} is not signed in on this machine, so nothing was started.\n\n**Your move:** Send this again with ${agents.map(appName).join(" or ")} as the agent.`,
    );
    return;
  }
  // A follow-up starts from current evidence: a pull request may have merged
  // or its checks finished since the child returned.
  if (followUp)
    for (const child of j.progress.children
      .filter((c) => c.mode === "change" && ranHere(c))
      .slice(-6))
      try {
        child.evidence = await evidence(child.cwd);
      } catch {
        /* The last reported evidence stays. */
      }
  const {
    workLine,
    coordinatorFile,
    contextFile,
    resumed,
    resetCoordinator,
    workContext,
    briefHash,
    projectBrief,
    instructionsVersion,
    brief,
    rotate,
  } = await openCoordinator(o, j, s, movedHere, agents, selector);
  const begun = performance.now();
  const paused = async () => {
    if (!o.drain?.aborted) return false;
    event("execution_paused");
    await persist();
    await publish(
      "running",
      "Projects is updating. This conversation continues where it left off in a moment.",
    );
    return true;
  };
  const x: Execution = {
    s, o, selector, checks, file, j, event, failureReason, persist, publish, interrupted, turn,
    prepare, evidence, here, ranHere, undelivered, delivery, lastSaved, copiedAt, refusedBy,
    overran, freshIn, screenshots, refreshMessages, agents, appName, workLine, coordinatorFile,
    contextFile, resumed, resetCoordinator, workContext, briefHash, projectBrief,
    instructionsVersion, brief, rotate, begun, paused,
    runTurn: (...args) => runTurn(x, ...args),
    handBack: (...args) => handBack(x, ...args),
    acceptChild: (...args) => acceptChild(x, ...args),
    inspect: (...args) => inspect(x, ...args),
    recoverChild: (...args) => recoverChild(x, ...args),
  };
  try {
    if ((await resumeInterrupted(x)) === "paused") return;
    const maxSteps = o.maxSteps ?? 12;
    for (let step = 0; step < maxSteps; step++) {
      if (await paused()) return;
      await refreshMessages();
      o.signal.throwIfAborted();
      // The turn's last step asks for a report the owner can act on, not a
      // dispatch that could never start.
      const last = step === maxSteps - 1;
      const decided = await decide(x, step, last);
      if (decided === "paused") return;
      if (decided === "again") continue;
      const { decision, inputIds, heard } = decided;
      // Feedback steered into the master's own turn was part of this decision.
      const reviewedIds = [...new Set([...inputIds, ...heard])];
      const title = clip(plainText(decision.title ?? ""), 80);
      if (title) j.progress.title = title;
      j.phase = "ready";
      j.pid = null;
      delete j.checkpoint;
      await persist();
      // Each receipt stays bounded; message delivery is durable on the Worker.
      // A large backlog is acknowledged in batches before publishing completion.
      const pendingReceipts = reviewedIds.filter(id =>
        s.messages.find(m => m.id === id)?.delivery !== "reviewed");
      for (let i = 0; i < pendingReceipts.length; i += 40) {
        j.progress.reviewedMessageIds = pendingReceipts.slice(i, i + 40);
        await publish("running", j.progress.summary);
      }
      event("master_decision", { actor: "master", action: decision.action });
      await refreshMessages();
      if (
        s.messages.some((m) => m.role === "user" && !reviewedIds.includes(m.id))
      ) {
        await publish(
          "running",
          "New feedback arrived. The master is reviewing it before continuing.",
        );
        s.nextPrompt =
          "New user feedback arrived while you were deciding. Your last proposed action has NOT been executed. Reconsider it using the current conversation before proceeding.";
        continue;
      }
      o.signal.throwIfAborted();
      // A decision the runner cannot carry out goes back with the reason;
      // nothing has run for it.
      const refuse = (message: string) =>
        x.handBack(
          "decision_rejected",
          { actor: "master", agent: s.masterAgent },
          message,
          `Your decision was not carried out: ${message} Nothing ran for it. Decide again within this request.`,
        );
      const unfinished = completionProblem(
        decision,
        j.progress.children,
        !!workContext,
      ) ?? await verifyWorkRecord(decision, j.workChanged);
      if (unfinished) {
        refuse(unfinished);
        continue;
      }
      if (decision.action !== "dispatch") {
        if (decision.task) {
          refuse("a finished or blocked decision cannot carry a task.");
          continue;
        }
        if (decision.resetContext) resetCoordinator();
        if (decision.action === "complete" && decision.delivery)
          j.delivery = decision.delivery;
        if (o.run.lane === "review") j.progress.reviewChanged = decision.workRecord?.status === "updated";
        if (decision.workRecord) j.workRecord = decision.workRecord;
        else delete j.workRecord;
        j.phase = "finished";
        await publish(
          decision.action === "complete" ? "completed" : "blocked",
          decision.summary,
        );
        await settle();
        return;
      }
      const task = decision.task;
      if (!task) {
        refuse("a dispatch needs a task.");
        continue;
      }
      if (last) {
        j.phase = "finished";
        await publish(
          "blocked",
          `${decision.summary}\n\nThis turn used its last step before that could start.\n\n**Your move:** Send a follow-up to continue.`,
        );
        await settle();
        return;
      }
      if (task.mode === "change") {j.workChanged = true; await persist();}
      if ((await dispatch(x, decision, task, inputIds, reviewedIds, refuse)) === "paused") return;
    }
    j.phase = "finished";
    await publish(
      "blocked",
      stoppedText("This turn used all its steps before it finished."),
    );
    await settle();
  } catch (error) {
    event("execution_interrupted", {
      reason: failureReason(error),
      outcome:
        o.signal.aborted && o.signal.reason === "shutdown"
          ? "shutdown"
          : o.signal.aborted && o.signal.reason === "cancelled"
            ? "cancelled"
            : "blocked",
    });
    const cancelled =
      o.signal.aborted &&
      o.signal.reason === "cancelled" &&
      !(error instanceof NativeStopError);
    const running = j.progress.children.find((c) => c.state === "running");
    if (running) running.state = cancelled ? "cancelled" : "unknown";
    const ambiguous = ["child", "master", "uncertain"].includes(j.phase);
    j.phase = ambiguous ? "uncertain" : "finished";
    const message = stoppedText(
      error instanceof z.ZodError
        ? "An agent's answer did not match the format Projects expects."
        : error instanceof Error && error.message
          ? error.message
          : "Something unexpected stopped this turn.",
    );
    if (o.signal.aborted && o.signal.reason === "shutdown") {
      j.phase = ambiguous ? "uncertain" : "ready";
      await publish(
        "running",
        "Runner is restarting. Saved work will be reconciled when it reconnects.",
      );
      return;
    }
    await publish(
      cancelled ? "cancelled" : "blocked",
      cancelled
        ? "Stopped. Existing work and native sessions are retained."
        : message.slice(0, 12000),
    );
  }
}

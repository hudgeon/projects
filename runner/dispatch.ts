// Carrying out a dispatch: the checks before anything runs, the helper's
// workspace and project review, its turn and its result.
import { randomUUID } from "node:crypto";
import { childResultSchema, type Child, type MasterDecision, type ChildResult } from "../src/run-model";
import { Failure, NativeStopError } from "./native";
import { git, UnsavedWorkspace } from "./workspaces";
import { clip } from "../src/run-text";
import { connectorAccess } from "./connectors";
import { helperInstructions, requesterInstructions } from "./instructions";
import { HELPER_FAILURES } from "./turn-limits";
import type { Execution } from "./execution";
import type { Journal } from "./journal";
import { outputSchema } from "./decisions";
import { UPKEEP_SOURCE_HOSTS } from "../src/upkeep-model";

export async function dispatch(
  x: Execution,
  decision: MasterDecision,
  task: NonNullable<MasterDecision["task"]>,
  inputIds: string[],
  reviewedIds: string[],
  refuse: (message: string) => void,
) {
  const {
    s, o, checks, j, event, failureReason, persist, publish, prepare, here, undelivered, runTurn,
    copiedAt, refusedBy, freshIn, screenshots, refreshMessages, agents, appName, workLine,
    resetCoordinator, workContext, projectBrief, handBack, acceptChild, recoverChild, paused,
  } = x;
  // Keep the decision so the restarted runner dispatches it without a
  // new master turn.
  if (o.drain?.aborted) {
    j.checkpoint = { kind: "master", value: decision, inputIds };
    if (await paused()) return "paused";
  }
  const project = o.projects.find((p) => p.id === task.projectId);
  if (!project || (o.run.projectId && project.id !== o.run.projectId)) {
    refuse("that project is outside this request.");
    return "again";
  }
  if (o.run.agent !== "auto" && task.agent !== o.run.agent) {
    refuse(`this request is limited to ${appName(o.run.agent)}.`);
    return "again";
  }
  if (!agents.includes(task.agent)) {
    s.nextPrompt = `${appName(task.agent)} is not signed in on this machine. Your proposed action has NOT been executed. Dispatch with agent ${agents.join(" or ")}.`;
    return "again";
  }
  if (j.progress.children.length >= 24)
    throw new Failure(
      "child_limit",
      "This conversation has used all 24 of its helper sessions. Start a new conversation to continue the work.",
    );
  const images = await screenshots(s.messages);
  const browser = await o.browser?.();
  const id = randomUUID();
  const preparing = performance.now();
  // A workspace on another machine is recreated here from its newest copy.
  let workspace: Awaited<ReturnType<typeof prepare>>;
  try {
    workspace = await prepare(
      project,
      task,
      j.progress.children,
      o.run.id,
      id,
      o.worktreeRoot,
      here,
    );
  } catch (error) {
    if (error instanceof UnsavedWorkspace) {
      s.nextPrompt = `That workspace is on another machine and has no copy on GitHub to continue from. Your proposed action has NOT been executed. Dispatch with workspace "new", checking GitHub for anything it already pushed.`;
      return "again";
    }
    // Nothing ran: the master chooses another workspace.
    if (
      o.signal.aborted ||
      !(error instanceof Failure) ||
      !["workspace_changed", "git_failed"].includes(error.reason)
    )
      throw error;
    handBack(
      error.reason,
      { actor: task.agent, mode: task.mode },
      error.message,
      `Projects could not use that workspace: ${error.message} Your proposed action has NOT been executed. Choose again: "new", or another of this conversation's workspaces for this project.`,
    );
    return "again";
  }
  event("workspace_prepared", {
    childId: id,
    actor: task.agent,
    mode: task.mode,
    resumed: task.workspace !== "new",
    durationMs: Math.round(performance.now() - preparing),
  });
  const { restored, savedAt, ...place } = workspace;
  if (restored && savedAt) copiedAt.set(id, savedAt);
  // An existing worktree in a fresh session: the earlier report is the
  // handoff, since that session's memory does not come with it.
  const earlier =
    task.workspace !== "new" && !place.sessionId && !restored
      ? ([...j.progress.children]
          .reverse()
          .find((c) => c.cwd === place.cwd && c.result) ?? null)
      : undefined;
  if (earlier !== undefined) freshIn.add(id);
  const handoff =
    earlier === undefined
      ? ""
      : `This worktree holds work from earlier sessions in this conversation. You are a fresh session, so their memory is not available.${earlier ? ` The latest report from it: ${JSON.stringify({ summary: clip(earlier.result!.summary, 3000), checks: earlier.result!.checks, links: earlier.result!.links, observed: earlier.evidence })}` : ""} Review git status, the branch and its pull request before continuing, and never repeat a change that already landed.\n\n`;
  const child: Child = {
    id,
    projectId: project.id,
    agent: task.agent,
    mode: task.mode,
    ...place,
    host: here,
    // A prepared workspace has no native execution yet. The durable
    // checkpoint reuses it if an update arrives during project review.
    state: "cancelled",
    result: null,
    evidence: [],
  };
  if (decision.resetContext) resetCoordinator();
  j.progress.children.push(child);
  j.phase = "ready";
  j.checkpoint = {kind: "master", value: {...decision, task: {...task, workspace: child.id}}, inputIds: reviewedIds};
  await persist();
  let projectContext: Awaited<ReturnType<typeof projectBrief>>;
  try {
    projectContext = await projectBrief(project, child.cwd, `${task.mode}: ${task.prompt}`, child.id, child.agent, child.sessionId);
    if (projectContext.prompt) {await refreshMessages(); s.messages = o.latestMessages?.() ?? s.messages;}
  } catch (error) {
    delete j.checkpoint;
    await persist();
    throw error;
  }
  if (s.messages.some(m => m.role === "user" && !reviewedIds.includes(m.id))) {
    delete j.checkpoint;
    await persist();
    s.nextPrompt = `New feedback arrived during project context selection. No helper turn started. The prepared workspace is retained as child ${child.id}; reconsider the current request before reusing it.`;
    return "again";
  }
  if (await paused()) return "paused";
  delete j.checkpoint;
  child.state = "running";
  s.dispatched++;
  checks.dispatch(task.prompt, child, j.progress.children);
  j.phase = "child";
  await persist();
  await publish("running", decision.summary);
  let value: ChildResult;
  try {
    value = childResultSchema.parse(
      await runTurn(
        {
          agent: task.agent,
          cwd: child.cwd,
          sessionId: child.sessionId ?? undefined,
          screenshots: images,
          browser,
          prompt: `${workLine}${workContext ? `${workContext}\n\n` : ""}${projectContext.prompt}\n${handoff}${restored ? `This worktree was recreated on this machine from another machine's copy on GitHub${savedAt ? `, which holds its work as of ${new Date(savedAt).toISOString()}` : ""}; its uncommitted changes are present. Work after that may be missing and the earlier session's memory is not available: review git status, the branch and its pull request before continuing, and never repeat a change that already landed.\n\n` : ""}${task.prompt}\n\n${requesterInstructions(o.person, o.inboxes)}${s.messages.some((message) => message.screenshots?.length) ? "The attached screenshots are user-provided evidence, ordered by these messages: " + JSON.stringify(s.messages.filter((message) => message.screenshots?.length)) + "\n\n" : ""}Work only on this assigned task. Read repository instructions and the relevant plan. Preserve other sessions. Use this worktree for changes. Carry this assigned outcome through its authorized checks, required review, merge, deployment, visual verification and required machine sync before returning; a draft-only request ends at the verified saved draft. Keep working through routine fixable failures and delivery stages in this same session. Report actual gate evidence and remaining steps; a green open PR or a native turn ending is not release completion. Stop for missing authority or a failed gate you cannot fix within scope. Return the required structured result with actual check evidence and GitHub links; no secrets or raw tool output.\n\n${helperInstructions(task.agent, o.fullAccess, o.person)}`,
          schema: outputSchema(childResultSchema),
          readOnly: task.mode === "read",
          // An upkeep read child researches the harnesses on their official
          // sites (docs/upkeep.md); no other child is given the web this way.
          ...(o.run.lane === "upkeep" && task.mode === "read" ? { web: UPKEEP_SOURCE_HOSTS } : {}),
          connectors: await (o.connectors ?? connectorAccess)(),
          // A Git worktree's index/objects live in its repository's common Git
          // directory. Grant that exact directory, never the primary worktree.
          writableRoots:
            task.mode === "change" && task.agent === "codex"
              ? await Promise.all([
                  git(child.cwd, [
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                  ]),
                  git(child.cwd, ["rev-parse", "--absolute-git-dir"]),
                ])
              : [],
          signal: o.signal,
          onSession: async (sid) => {
            child.sessionId = sid;
            await persist();
          },
          onProcess: async (pid) => {
            j.pid = pid;
            await persist();
          },
          onRefused: (categories) => refusedBy.set(child.id, categories),
          onFile: projectContext.onFile,
        },
        child,
        (value) => {
          j.checkpoint = {
            kind: "child",
            childId: child.id,
            value: childResultSchema.parse(value),
          };
        },
        { exclude: [], received: [] },
      ),
    );
  } catch (error) {
    // A result the helper returned is saved before delivery; a report
    // that failed after it is not the helper's failure.
    const receipt = j.checkpoint as Journal["checkpoint"];
    const returned =
      receipt?.kind === "child" && receipt.childId === child.id;
    if (
      o.signal.aborted ||
      returned ||
      (error && typeof error === "object" && undelivered.has(error)) ||
      error instanceof NativeStopError ||
      !HELPER_FAILURES.has(failureReason(error))
    )
      throw error;
    await recoverChild(child, project, error);
    return "again";
  }
  await projectContext.remember(child.sessionId);
  await acceptChild(child, value);
  await publish(
    "running",
    `Result returned from ${task.agent}. Master is checking it.`,
  );
}

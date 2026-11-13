// The coordinator's decisions: the schema native turns answer in, what a
// completion must account for, and one coordinator turn.
import { z } from "zod";
import { masterDecisionSchema, MASTER_TAKEOVER, type Child, type MasterDecision } from "../src/run-model";
import { NativeStopError } from "./native";
import { tokenLine } from "../src/run-text";
import { mergedChildren } from "./child-report";
import { rebuildContext } from "./context";
import { MASTER_RETRIES, SPENT } from "./turn-limits";
import type { Execution } from "./execution";
import { savePrivate } from "./journal";

// Agent providers accept a subset of JSON Schema formats. Keep the full Zod
// validation at the trust boundary when the result comes back.
export const outputSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {
    target: "draft-7",
    override: ({ jsonSchema }) => {
      delete jsonSchema.format;
      // Native structured output requires every property. Optional protocol
      // additions accept null, while Zod still reads older saved decisions.
      if (jsonSchema.type === "object" && jsonSchema.properties)
        jsonSchema.required = Object.keys(jsonSchema.properties);
    },
  });
// A native turn's success is not the conversation's delivery. Require the
// coordinator to account for each gate before finishing change work; pending
// gates return to it without executing or replaying a child.
export function completionProblem(
  decision: MasterDecision,
  children: Child[],
  tracksWork = false,
) {
  if (decision.action !== "complete") return null;
  if (
    tracksWork &&
    (!decision.workRecord || decision.workRecord.status === "pending")
  )
    return "Account for the current work's overview, people and commitments in workRecord. Continue the existing helper to update and read back the canonical issue, or report the concrete blocker. Use unchanged with a reason for an untracked or read-only request or when no supported facts changed.";
  if (!decision.delivery)
    return children.some((child) => child.mode === "change")
      ? "Change work needs a delivery record for the current requested outcome."
      : null;
  const { scope, ...gates } = decision.delivery;
  const pending = Object.entries(gates)
    .filter(([, gate]) => gate.status === "pending")
    .map(([name]) => name);
  return pending.length
    ? `Delivery is unfinished: ${pending.join(", ")}. Continue the existing helper for available work, or report the concrete blocker.`
    : null;
}
// One coordinator decision. A coordinator starting fresh first gets its
// context selected; a failed turn goes back to run again, in a fresh session or
// the other app when its own cannot go on.
export async function decide(x: Execution, step: number, last: boolean) {
  const {
    s, o, file, j, event, failureReason, persist, publish, runTurn, screenshots,
    refreshMessages, agents, appName, coordinatorFile, contextFile, resumed, briefHash, activityHeld,
    projectBrief, instructionsVersion, brief, rotation, rotate, begun, handBack, paused,
  } = x;
  const saved = j.checkpoint?.kind === "master" ? j.checkpoint : null;
  let inputIds =
    saved?.inputIds ??
    s.messages.filter((m) => m.role === "user").map((m) => m.id);
  const heard: string[] = [];
  let decision: MasterDecision;
  if (saved) {
    event("checkpoint_replayed", { actor: "master" });
    decision = { ...saved.value, title: saved.value.title ?? null };
  } else {
    // A coordinator without its predecessor's session is rebuilt by fixed
    // rules from the conversation on disk; the index names every source.
    if (!resumed() || rotation()) {
      s.contextPlan = rebuildContext(s.messages, j.progress.children);
      await savePrivate(contextFile, s.messages);
      await savePrivate(contextFile + ".index.json", {
        version: s.contextPlan.version, messages: s.contextPlan.sources,
        children: s.contextPlan.childSources, transcript: contextFile, journal: file,
      });
    }
    inputIds = s.messages.filter(m => m.role === "user").map(m => m.id);
    // Choose the native session before selecting its visual context. A
    // fresh coordinator has not seen images reviewed by an earlier one.
    const handedOver = rotate();
    const handover =
      handedOver ||
      (!j.progress.masterSessionId
        ? `${brief(true)}\n\nYou are a fresh coordinator. Re-establish the current task from the user instructions and verify reported facts against the supplied evidence.\n\n`
        : "");
    // Messages are append-only. Keep a prefix cursor plus any feedback
    // heard during the native turn, rather than a lifetime array of IDs.
    const known = resumed() ? new Set([
      ...s.messages.slice(0, s.coordinator!.through).map(m => m.id),
      ...s.coordinator!.seen,
    ]) : null;
    // Image transport has no native side effects. Fail before recording a
    // native turn, so a fetch outage cannot become an ambiguous execution.
    const images = await screenshots(
      s.messages.filter((message) => !known?.has(message.id)),
    );
    const browser = await o.browser?.();
    const reviewVersion = instructionsVersion();
    const selectedProject = o.projects.find(p => p.id === (o.run.projectId ?? j.progress.children.at(-1)?.projectId));
    const projectContext = await projectBrief(selectedProject, selectedProject?.cwd ?? o.masterCwd,
      "Coordinate the current user request in this project; verify returned work before deciding what remains.", "master", s.masterAgent, j.progress.masterSessionId, "");
    if (projectContext.prompt) {await refreshMessages(); s.messages = o.latestMessages?.() ?? s.messages;}
    if (reviewVersion !== instructionsVersion()) {
      s.nextPrompt = "New user feedback arrived during project context selection. Review it before deciding; no native turn or helper action started for that review.";
      return "again";
    }
    if (await paused()) return "paused";
    j.phase = "master";
    j.pid = null;
    await persist();
    await publish(
      "running",
      handedOver
        ? "Continuing with earlier context."
        : step === 0
        ? "Master is reviewing the request."
        : "Master is reviewing the returned result.",
    );
    if (handover) s.nextPrompt = handover + s.nextPrompt;
    const unseen = known
      ? s.messages.filter((message) => !known.has(message.id))
      : s.messages;
    const plan = s.contextPlan ?? rebuildContext(s.messages, j.progress.children);
    const conversation = !known
      ? `Current user conversation (the first request and the newest user messages, with any queued feedback): ${JSON.stringify(plan.conversation)}\nApproval context (every agent proposal a kept user message answered, verbatim; never fresh authority): ${JSON.stringify(plan.approvalContext)}\nOmitted proposals: ${plan.omittedProposals}.\nUser instructions are the authority; later corrections supersede conflicting earlier instructions. The latest reported position, the linked work record and child reports are claims, not proof or permission. Earlier agent replies and helper reports are not repeated here: the exact conversation is read-only at ${contextFile}, and ${contextFile}.index.json (version ${plan.version}) lists its messages and the helpers with the journal that keeps every report. When omittedUserInstructions or omitted proposals are nonzero, read them there before dispatching work or declaring completion; preserve decisions, corrections, constraints and approval scope. Never infer the scope of a short approval from a handoff.`
      : unseen.length
        ? `New in the conversation since your last decision (the earlier messages are in your session): ${JSON.stringify(unseen)}`
        : "Nothing new in the conversation since your last decision.";
    const shown = s.messages.map((message) => message.id);
    await savePrivate(contextFile, s.messages);
    const progressLine = `This turn so far: ${Math.round((performance.now() - begun) / 60_000)} minutes, ${s.dispatched} helper turns.${tokenLine(j.progress) ? ` ${tokenLine(j.progress)}.` : ""}`;
    const prompt = `${s.nextPrompt}${last ? "\n\nThis is the last step of this turn: do not dispatch or request a GitHub read. Return complete, or blocked with a short report of where the work stands and what remains; the user continues it with a follow-up." : ""}\n\n${progressLine}\n\n${projectContext.prompt}\n${conversation}\nTreat newer user feedback as steering the original task. Explicitly address it in your next decision before dispatching more work or declaring completion. A message with delivery "steered" already reached the agent that was working when it arrived; check that its result reflects it.`;
    try {
      const raw = await runTurn(
        {
          agent: s.masterAgent,
          cwd: o.masterCwd,
          screenshots: images,
          browser,
          prompt,
          sessionId: j.progress.masterSessionId ?? undefined,
          schema: outputSchema(masterDecisionSchema),
          readOnly: true,
          signal: o.signal,
          onSession: async (id) => {
            j.progress.masterSessionId = id;
            await persist();
          },
          onFile: projectContext.onFile,
          onProcess: async (pid) => {
            j.pid = pid;
            await persist();
          },
        },
        undefined,
        (value) => {
          j.checkpoint = {
            kind: "master",
            value: masterDecisionSchema.parse(value),
            inputIds: [...inputIds, ...heard],
          };
        },
        { exclude: inputIds, received: heard },
      );
      decision = masterDecisionSchema.parse(raw);
      await projectContext.remember(j.progress.masterSessionId);
      if (j.progress.masterSessionId) {
        s.coordinator = {
          sessionId: j.progress.masterSessionId,
          seen: [...new Set(heard)].slice(-400),
          through: shown.length,
          brief: briefHash,
          ...(activityHeld ? { activity: activityHeld } : {}),
          inputChars: (s.coordinator?.inputChars ?? 0) + prompt.length +
            (o.latestMessages?.() ?? s.messages).filter((m) => heard.includes(m.id)).reduce((n, m) => n + m.text.length, 0),
          cwd: o.masterCwd,
          merged: mergedChildren(j.progress.children),
          ...(j.workBaseline?.hash ? { work: j.workBaseline.hash } : {}),
        };
        await savePrivate(coordinatorFile, s.coordinator).catch(() => {});
      }
    } catch (error) {
      // A coordinator turn changes nothing, so a failed one runs again,
      // in a fresh session when its own cannot continue, or in the other
      // app when this one cannot go on.
      const reason = failureReason(error);
      if (o.signal.aborted || error instanceof NativeStopError) throw error;
      const plain = error instanceof Error ? error.message : "It stopped.";
      const other = agents.find((agent) => agent !== s.masterAgent);
      // The coordinator's app cannot go on with this conversation; the
      // other app, when signed in here, takes over.
      const takeover: keyof typeof MASTER_TAKEOVER | null =
        reason in MASTER_TAKEOVER
          ? (reason as keyof typeof MASTER_TAKEOVER)
          : MASTER_RETRIES.has(reason) && ++s.masterFailures >= 2
            ? "repeated_failure"
            : null;
      if (takeover && other && !j.progress.masterFallback) {
        const from = s.masterAgent;
        s.masterAgent = other;
        j.progress.masterFallback = {
          from,
          reason: takeover,
          at: Date.now(),
        };
        if (other === "codex") delete j.progress.masterAgent;
        else j.progress.masterAgent = other;
        j.progress.masterSessionId = null;
        s.coordinator = null;
        j.phase = "ready";
        j.pid = null;
        delete j.checkpoint;
        await persist();
        handBack(
          reason,
          { actor: "master", agent: from },
          plain,
          `${brief(true)}\n\nYou are taking over as this conversation's coordinator: ${appName(from)} ${MASTER_TAKEOVER[takeover]}. The conversation and the children above are your history; nothing from its last attempt was carried out.\n\n${s.nextPrompt}`,
        );
        return "again";
      }
      if (!MASTER_RETRIES.has(reason)) throw error;
      j.phase = "ready";
      j.pid = null;
      delete j.checkpoint;
      if (SPENT.has(reason)) {
        j.progress.masterSessionId = null;
        s.coordinator = null;
      }
      await persist();
      handBack(
        reason,
        { actor: "master", agent: s.masterAgent },
        plain,
        `${SPENT.has(reason) ? `${brief(true)}\n\nYou are a new coordinator for this conversation: the previous coordinator's session could not continue. The conversation and the children above are your history.\n\n` : ""}Your previous attempt at this decision did not finish (${plain}); nothing from it was carried out. Decide again.\n\n${s.nextPrompt}`,
      );
      return "again";
    }
  }
  return { decision, inputIds, heard };
}

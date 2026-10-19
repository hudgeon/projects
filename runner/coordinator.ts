// The coordinator's brief and session record: what a fresh or resumed
// coordinator is given, and the handover when its session grows large.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Agent } from "../src/run-model";
import { childContext, selectContext } from "./context";
import { contextBrief, type ProjectTurn } from "./project-turn";
import { workInstructions } from "./instructions";
import { MASTER_CONTEXT_LIMIT, MASTER_INPUT_CHAR_LIMIT } from "./turn-limits";
import { activityBrief } from "./activity-brief";
import type { EngineOptions, RunState } from "./execution";
import { savePrivate, type Journal } from "./journal";
import { masterInstructions, movedInstructions, personInstructions, quickInstructions } from "./master-instructions";

// The coordinator's brief and session record for one execution, read once,
// and the first prompt of a turn that resumes its session.
export async function openCoordinator(
  o: EngineOptions,
  j: Journal,
  s: RunState,
  movedHere: boolean,
  agents: Agent[],
  selector: EngineOptions["contextSelector"],
) {
  const workLine = o.run.workIssue ? `work: #${o.run.workIssue}\n\n` : "";
  // A coordinator session remembers what it was given: its brief and the
  // messages it read. Projects records that beside the journal, so a resumed
  // coordinator receives only what is new to it.
  const coordinatorFile = path.join(
    o.stateDir,
    "runs",
    `${o.run.id}.coordinator.json`,
  );
  // Exact exchanges stay available locally when an approval or correction
  // refers to an omitted reply. They are never copied to portfolio snapshots.
  const contextFile = path.join(o.stateDir, "runs", `${o.run.id}.context.json`);
  try {
    s.coordinator = z
      .object({
        sessionId: z.string(),
        seen: z.array(z.string()).max(400),
        brief: z.string(),
        inputChars: z.number().nonnegative().default(0),
        through: z.number().int().nonnegative().default(0),
      })
      .parse(JSON.parse(await readFile(coordinatorFile, "utf8")));
  } catch {
    // A new coordinator, or one from before this record: it gets everything.
  }
  const resumed = () =>
    !!j.progress.masterSessionId &&
    s.coordinator?.sessionId === j.progress.masterSessionId;
  const resetCoordinator = () => {
    j.progress.masterSessionId = null;
    s.coordinator = null;
    if (j.progress.masterUsage) j.progress.masterUsage.context = 0;
  };
  const workContext =
    o.run.lane === "quick" ? "" : workInstructions(o.workRepo, o.run.workIssue);
  const stableBrief = `${masterInstructions}${personInstructions(o.person)}${movedHere ? `\n\n${movedInstructions}` : ""}\n\n${workContext}\n\nRegistered projects: ${JSON.stringify(o.projects)}\nSelected project: ${o.run.projectId ?? "choose from registered projects"}; child agent: ${o.run.agent === "auto" && agents.length > 1 ? "auto" : o.run.agent === "auto" ? agents[0] : o.run.agent}.${o.run.lane === "quick" ? `\n${quickInstructions(o)}` : ""}`;
  const briefHash = createHash("sha256")
    .update(stableBrief)
    .digest("hex")
    .slice(0, 24);
  const projectBrief = (...turn: ProjectTurn) =>
    contextBrief({stateDir: o.stateDir, run: o.run, host: o.host, workRepo: o.workRepo, selector, signal: o.signal, save: savePrivate,
      instructions: s.messages.filter(m => m.role === "user").map(m => m.text)}, ...turn);
  const instructionsVersion = () => createHash("sha256").update(JSON.stringify(s.messages
    .filter(m => m.role === "user").map(m => [m.id, m.text, m.screenshots]))).digest("hex");
  // Quick work skips the repository activity dump: it is most of a first turn's
  // input and only matters when choosing where code changes can safely go.
  const brief = (full: boolean) =>
    `${workLine}${full ? stableBrief : "A follow-up turn in this conversation; your instructions and the registered projects are unchanged."}\n${o.run.lane === "quick" ? "" : `Active work (check the timestamps; gaps are unknown, not clean): ${JSON.stringify(activityBrief(o.activity, o.run.projectId))}\n`}Previous children: ${full && s.contextPlan ? s.contextPlan.children : childContext(j.progress.children, full ? 6 : 2)}`;
  // A coordinator whose session grew large hands over to a fresh one.
  const rotate = () => {
    if (!j.progress.masterSessionId) {
      resetCoordinator();
      return "";
    }
    if (
      (j.progress.masterUsage?.context ?? 0) <= MASTER_CONTEXT_LIMIT &&
      (s.coordinator?.inputChars ?? 0) < MASTER_INPUT_CHAR_LIMIT
    ) return "";
    resetCoordinator();
    return `${brief(true)}\n\nYou are a new coordinator for this conversation: the previous coordinator's session grew large, so Projects started a fresh one. The conversation and the children above are your history.\n\n`;
  };
  s.nextPrompt = j.progress.masterSessionId
    ? brief(!(resumed() && s.coordinator?.brief === briefHash))
    : "";
  return {
    workLine, coordinatorFile, contextFile, resumed, resetCoordinator, workContext, briefHash,
    projectBrief, instructionsVersion, brief, rotate,
  };
}

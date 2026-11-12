import { workReviewInstructions } from "./work-review-instructions";
// The coordinator's brief and session record: what a fresh or resumed
// coordinator is given, and the handover when its session grows large.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Agent } from "../src/run-model";
import { childContext, mergedChildren } from "./child-report";
import { contextBrief, type ProjectTurn } from "./project-turn";
import { workCoordinatorInstructions } from "./work-instructions";
import { MASTER_BOUNDARY_SHARE, MASTER_CONTEXT_LIMIT, MASTER_INPUT_CHAR_LIMIT } from "./turn-limits";
import { activityBrief, activityNews, activitySeen } from "./activity-brief";
import type { EngineOptions, RunState } from "./execution";
import { savePrivate, type Journal } from "./journal";
import { masterInstructions, movedInstructions, personInstructions, quickInstructions } from "./master-instructions";
import { upkeepBrief } from "./upkeep-instructions";
import type { SessionMemory } from "./session-memory";

// The coordinator's brief and session record for one execution, read once,
// and the first prompt of a turn that resumes its session.
export async function openCoordinator(
  o: EngineOptions,
  j: Journal,
  s: RunState,
  file: string,
  movedHere: boolean,
  agents: Agent[],
  memory: SessionMemory,
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
        activity: z.record(z.string(), z.string()).optional(),
        cwd: z.string().optional(),
        merged: z.array(z.string()).max(400).optional(),
        work: z.string().optional(),
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
    o.run.lane === "quick" ? "" : workCoordinatorInstructions(o.workRepo, o.run.workIssue, o.person);
  const review = o.run.lane === "review" ? `\n${workReviewInstructions}` : "";
  const upkeep = o.run.lane === "upkeep" ? `\n${await upkeepBrief(o)}` : "";
  // A conversation on one project hears that project alone, with its folder
  // and plan; one still choosing hears every registered project's id and
  // name, and the helper it dispatches reads that project's own files.
  const selected = o.projects.find((p) => p.id === o.run.projectId);
  const projects = selected
    ? `Selected project: ${JSON.stringify(selected)}; helpers go to this project only`
    : `Registered projects (id: name): ${o.projects.map((p) => `${p.id}: ${p.name}`).join("; ") || "none"}\nSelected project: ${o.run.projectId ?? "choose from registered projects"}`;
  const stableBrief = `${masterInstructions(o.person)}${personInstructions(o.person)}${movedHere ? `\n\n${movedInstructions}` : ""}\n\n${workContext}\n\n${projects}; child agent: ${o.run.agent === "auto" && agents.length > 1 ? "auto" : o.run.agent === "auto" ? agents[0] : o.run.agent}.${o.run.lane === "quick" ? `\n${quickInstructions(o)}` : upkeep + review}`;
  // The brief a session holds is known by its instructions and projects
  // alone. Active work is tracked entry by entry without its timestamps, so
  // an observation taken again does not send everything twice.
  const briefHash = createHash("sha256").update(stableBrief).digest("hex").slice(0, 24);
  const activity = o.run.lane === "quick" ? undefined : activityBrief(o.activity, o.run.projectId);
  const activityHeld = activity === undefined ? undefined : activitySeen(activity);
  const activeWork = (list: unknown, label = "Active work") => `${label} (check the timestamps; gaps are unknown, not clean): ${JSON.stringify(list)}\n`;
  // For a session that holds the brief: only the active work that changed.
  const news = () => {
    if (activity === undefined) return "";
    if (!s.coordinator?.activity) return activeWork(activity);
    const { changed, gone } = activityNews(activity, s.coordinator.activity);
    if (!changed.length && !gone.length) return "Active work is as you last saw it.\n";
    return `${changed.length ? activeWork(changed, "Active work that changed since you last saw it") : ""}${gone.length ? `No longer listed in active work: ${gone.join(", ")}.\n` : ""}`;
  };
  // The coordinator's app runs in its own folder, a helper's in the workspace
  // reviewed: each loads the instruction files there by itself.
  const projectBrief = (...turn: ProjectTurn) =>
    contextBrief({stateDir: o.stateDir, run: o.run, workRepo: o.workRepo, signal: o.signal, save: savePrivate, memory,
      native: turn[3] === "master" ? o.masterCwd : turn[1],
      instructions: s.messages.filter(m => m.role === "user").map(m => m.text)}, ...turn);
  const instructionsVersion = () => createHash("sha256").update(JSON.stringify(s.messages
    .filter(m => m.role === "user").map(m => [m.id, m.text, m.screenshots]))).digest("hex");
  // Quick work skips the repository activity dump: it is most of a first turn's
  // input and only matters when choosing where code changes can safely go.
  // Every coordinator gets one line for each child, whether or not it holds
  // its history: a returned helper's report follows in the same prompt, and
  // the journal keeps every other report in full.
  const brief = (full: boolean) =>
    `${workLine}${full ? stableBrief : "A follow-up turn in this conversation; your instructions and the registered projects are unchanged."}\n${full ? (activity === undefined ? "" : activeWork(activity)) : news()}Previous children${j.progress.children.length ? ` (one line each; every report is in ${file})` : ""}: ${childContext(j.progress.children)}`;
  // A boundary the engine can see, at which the session hands over: it ran
  // in another folder, a helper's pull request was merged since it last
  // looked, or the linked work issue's position changed. A record from before
  // these were kept names none, so such a session continues to its next
  // boundary rather than handing over for every earlier merge.
  // A boundary ends a session that has grown past the share; a smaller one
  // carries on, and the boundary is remembered rather than kept.
  const boundary = (grown: boolean) => {
    const c = s.coordinator;
    if (!c || !resumed()) return "";
    if (c.cwd && c.cwd !== o.masterCwd) return "the coordinator's folder changed";
    if (!grown) return "";
    if (c.merged && mergedChildren(j.progress.children).some((id) => !c.merged!.includes(id)))
      return "a helper's pull request was merged";
    if (c.work && j.workBaseline?.hash && c.work !== j.workBaseline.hash)
      return "the linked work issue's position changed";
    return "";
  };
  const grown = (share: number) =>
    (j.progress.masterUsage?.context ?? 0) > MASTER_CONTEXT_LIMIT * share ||
    (s.coordinator?.inputChars ?? 0) >= MASTER_INPUT_CHAR_LIMIT * share;
  // Why the session hands over now, or nothing.
  const rotation = () =>
    !j.progress.masterSessionId ? "" : grown(1) ? "the previous coordinator's session grew large" : boundary(grown(MASTER_BOUNDARY_SHARE));
  // A coordinator at a boundary hands over to a fresh one.
  const rotate = () => {
    if (!j.progress.masterSessionId) {
      resetCoordinator();
      return "";
    }
    const reason = rotation();
    if (!reason) return "";
    resetCoordinator();
    return `${brief(true)}\n\nYou are a new coordinator for this conversation: ${reason}, so Projects started a fresh one. The conversation and the children above are your history.\n\n`;
  };
  s.nextPrompt = j.progress.masterSessionId
    ? brief(!(resumed() && s.coordinator?.brief === briefHash))
    : "";
  return {
    workLine, coordinatorFile, contextFile, resumed, resetCoordinator, workContext, briefHash, activityHeld,
    projectBrief, instructionsVersion, brief, rotation, rotate,
  };
}

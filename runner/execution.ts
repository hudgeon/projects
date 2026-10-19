// What an execution is given, and what its steps share: the conversation's
// changing state and the services built once for it.
import type { Screenshot, ScreenshotInput } from "../src/screenshot-model";
import type { Agent, BrowserSignIn, Child, Progress, Run, RunMessage, RunnerHost } from "../src/run-model";
import type { Person } from "../src/people-model";
import type { NativeOptions, nativeProcessStopped } from "./native";
import type { ProjectDirectory, liveChanges, prepareWorkspace, pruneSaved, saveWorkspace, workspaceEvidence } from "./workspaces";
import type { ConnectorAccess } from "./connectors";
import type { Selector, selectContext } from "./context";
import type { TURN_LIMITS } from "./turn-limits";
import type { runChecks } from "./run-checks";
import type { WATCH_LIMITS } from "./turn-watch";
import type { Journal, openJournal } from "./journal";
import type { openCoordinator } from "./coordinator";
import type { runTurn } from "./turns";
import type { handBack, acceptChild, inspect, recoverChild } from "./children";

export type EngineOptions = {
  run: Run;
  projects: ProjectDirectory[];
  stateDir: string;
  worktreeRoot: string;
  masterCwd: string;
  activity: unknown;
  signal: AbortSignal;
  report: (progress: Progress) => Promise<void>;
  messages?: () => Promise<RunMessage[]>;
  screenshot?: (image: Screenshot) => Promise<ScreenshotInput>;
  browser?: () => Promise<NativeOptions["browser"]>;
  codexFast?: () => Promise<boolean>;
  fullAccess?: boolean;
  contextSelector?: Selector;
  turn?: (options: NativeOptions) => Promise<unknown>;
  prepare?: typeof prepareWorkspace;
  evidence?: typeof workspaceEvidence;
  maxSteps?: number;
  processStopped?: typeof nativeProcessStopped;
  // Aborted when an update asks the runner to restart at the next pause.
  drain?: AbortSignal;
  // The machine this runner is on; children record it.
  host: RunnerHost;
  // The native apps signed in on this machine, preferred first.
  agents?: Agent[];
  // The email lane's inbox and drafting repository.
  inboxAccount?: string;
  workRepo?: string;
  // Whose conversation this is, as the claim said: named in prompts and the
  // author of helpers' commits; never in receipts or telemetry.
  person?: Person;
  // How this machine's conversation browser signs in to Projects.
  browserSignIn?: BrowserSignIn;
  // The conversation's messages as of the latest heartbeat, without a request.
  latestMessages?: () => RunMessage[];
  changes?: typeof liveChanges;
  liveChangesMs?: number;
  save?: typeof saveWorkspace;
  saveMs?: number;
  prune?: typeof pruneSaved;
  // The user's connectors for helpers; discovered by the runner when omitted.
  connectors?: () => Promise<ConnectorAccess>;
  limits?: Partial<typeof TURN_LIMITS & typeof WATCH_LIMITS>;
};
// What an execution's steps change as it runs.
export type RunState = {
  // The conversation as last read.
  messages: RunMessage[];
  // The coordinator's app, or the one that took over coordinating.
  masterAgent: Agent;
  // What the coordinator's session was given: its brief and the messages it read.
  coordinator: { sessionId: string; seen: string[]; brief: string; inputChars: number; through: number } | null;
  contextPlan: Awaited<ReturnType<typeof selectContext>> | undefined;
  // What the coordinator hears at its next turn.
  nextPrompt: string;
  dispatched: number;
  masterFailures: number;
  // Failures given back to the master this turn; past the limit the owner
  // hears about the last one.
  handbacks: number;
};
type Bound<F> = F extends (x: Execution, ...args: infer A) => infer R ? (...args: A) => R : never;
// One execution's options, journal, state and services, which its steps share.
export type Execution = ReturnType<typeof openJournal> &
  Awaited<ReturnType<typeof openCoordinator>> & {
    s: RunState;
    o: EngineOptions;
    selector: EngineOptions["contextSelector"];
    checks: ReturnType<typeof runChecks>;
    file: string;
    j: Journal;
    interrupted: boolean;
    turn: NonNullable<EngineOptions["turn"]>;
    prepare: typeof prepareWorkspace;
    evidence: typeof workspaceEvidence;
    here: RunnerHost;
    ranHere: (c: Child) => boolean;
    lastSaved: Map<string, number>;
    copiedAt: Map<string, number>;
    refusedBy: Map<string, string[]>;
    overran: Set<string>;
    freshIn: Set<string>;
    screenshots: (selected: RunMessage[]) => Promise<ScreenshotInput[]>;
    refreshMessages: () => Promise<void>;
    agents: Agent[];
    appName: (agent: Agent) => string;
    begun: number;
    paused: () => Promise<boolean>;
    runTurn: Bound<typeof runTurn>;
    handBack: Bound<typeof handBack>;
    acceptChild: Bound<typeof acceptChild>;
    inspect: Bound<typeof inspect>;
    recoverChild: Bound<typeof recoverChild>;
  };

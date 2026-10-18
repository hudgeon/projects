// Conversations, decisions and engine options shared by the runner's tests.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EngineOptions } from "./engine";
import type { Progress, Run, MasterDecision } from "../src/run-model";

export const result = {
  outcome: "completed" as const,
  summary: "Verified",
  checks: ["Fixture check passed"],
  links: [],
};
export const makeRun = (): Run => ({
  id: randomUUID(),
  projectId: "acme/test",
  agent: "auto",
  workIssue: 1112,
  generation: 1,
  state: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  heartbeatAt: Date.now(),
  messages: [
    {
      id: randomUUID(),
      role: "user",
      text: "Complete the requested work",
      at: Date.now(),
    },
  ],
  progress: null,
});
export const progress = (): Progress => ({
  seq: 1,
  state: "running",
  summary: "Inspecting",
  children: [],
  masterSessionId: randomUUID(),
});

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
export async function fixture() {
  return mkdtemp(path.join(tmpdir(), "projects-runner-"));
}
export const delivery = {
  scope: "Complete the requested fixture change",
  checks: {status: "verified" as const, evidence: "Fixture checks passed at the fixture revision"},
  ...Object.fromEntries(["review", "merge", "deployment", "visual", "sync"].map(name => [name, {status: "not_required" as const, evidence: "This fixture request ends at local verification"}])),
} as NonNullable<MasterDecision["delivery"]>;
export const complete: MasterDecision = {
  action: "complete",
  title: null,
  summary: "Verified completion",
  delivery,
  task: null,
};
export const dispatch = (workspace = "new"): MasterDecision => ({
  action: "dispatch",
  title: "Inspect the **test** project",
  summary: "Delegating inspection",
  task: {
    projectId: "acme/test",
    agent: "claude",
    mode: "read",
    workspace,
    prompt: "Inspect this project",
  },
});
export function engineOptions(dir: string, run = makeRun()): EngineOptions {
  return {
    run,
    host: "studio",
    projects: [{ id: "acme/test", name: "Test", cwd: dir, plan: null }],
    stateDir: dir,
    masterCwd: dir,
    worktreeRoot: path.join(dir, "worktrees"),
    activity: [],
    signal: new AbortController().signal,
    report: async () => {},
    evidence: async () => ["Observed fixture HEAD"],
    prepare: async () => ({ cwd: dir, branch: "main", sessionId: null }),
    save: async () => null,
    prune: async () => {},
    connectors: async () => ({ claude: null, codex: null }),
  };
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 20000) {
  for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 50))) {
    if (await check()) return;
    if (Date.now() > until) throw Error("Timed out waiting");
  }
}

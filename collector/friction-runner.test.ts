import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectsLinks } from "./friction-runner";

test("native sessions Projects ran are linked to their conversation, helper, events and judgments", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "runner-"));
  await mkdir(path.join(stateDir, "runs"), { recursive: true });
  await mkdir(path.join(stateDir, "run-checks"), { recursive: true });
  const child = "11111111-1111-4111-8111-111111111111";
  await writeFile(
    path.join(stateDir, "runs", "run-1.json"),
    JSON.stringify({
      generation: 1,
      phase: "finished",
      pid: null,
      progress: {
        masterSessionId: "master-session",
        children: [
          { id: child, agent: "claude", mode: "change", sessionId: "helper-session", state: "completed" },
          { id: "other", agent: "codex", mode: "read", sessionId: null, state: "failed" },
        ],
        telemetry: [
          { event: "execution_handed_back", reason: "native_error", childId: child },
          { event: "turn_stuck", reason: "commands_idle", childId: child },
          { event: "turn_stuck", reason: "commands_idle", childId: child },
          { event: "master_decision", actor: "master", action: "dispatch" },
          { event: "native_finished", outcome: "completed", childId: "unknown-child" },
        ],
      },
    }),
  );
  await writeFile(path.join(stateDir, "runs", "selection.json"), JSON.stringify([1, 2]));
  await writeFile(
    path.join(stateDir, "run-checks", "2026-10-19T23-13-09-750Z-progress-x.json"),
    JSON.stringify({ kind: "progress", child, judged: { progressing: 0.2, repeating: 0.7, waiting: 0.1, blocked: 0.5 } }),
  );
  await writeFile(
    path.join(stateDir, "run-checks", "2026-10-19T23-14-09-750Z-repeat-y.json"),
    JSON.stringify({ kind: "repeat", child, judged: { overlap: 0.9 } }),
  );
  const links = await projectsLinks(stateDir);
  assert.deepEqual(links.get("Claude:helper-session"), {
    runId: "run-1",
    role: "helper",
    childId: child,
    mode: "change",
    events: {
      "result:completed": 1,
      "execution_handed_back:native_error": 1,
      "turn_stuck:commands_idle": 2,
      "jev:progress_checks": 1,
      "jev:repeating": 1,
      "jev:blocked": 1,
    },
  });
  assert.deepEqual(links.get("Codex:master-session"), {
    runId: "run-1",
    role: "master",
    events: { master_decision: 1 },
  });
  assert.equal(links.size, 2);
});
test("a machine without runner state has no links", async () => {
  const links = await projectsLinks(path.join(await mkdtemp(path.join(tmpdir(), "runner-")), "none"));
  assert.equal(links.size, 0);
});

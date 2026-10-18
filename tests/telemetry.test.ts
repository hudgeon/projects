import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  telemetry,
  executionEventSchema,
  TELEMETRY_LIMIT,
  contextFailureSchema,
} from "../src/telemetry";
import { progressSchema } from "../src/run-model";

test("telemetry strips unknown fields and never logs validation inputs or raw errors", (t) => {
  const lines: string[] = [];
  t.mock.method(Date, "now", () => 1791800000000);
  t.mock.method(console, "info", (line: string) => lines.push(line));
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  const id = randomUUID();
  const sensitive = {
    prompt: "private prompt",
    token: "private bearer",
    error: Error("private stderr"),
    cwd: "/private/worktree",
  };
  telemetry("runner", "native_finished", {
    ...sensitive,
    runId: id,
    durationMs: 17,
    outcome: "completed",
  });
  telemetry("runner", "native_finished", {
    ...sensitive,
    runId: "private-invalid-identifier",
  });
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        schemaVersion: 1,
        at: 1791800000000,
        component: "runner",
        event: "native_finished",
        durationMs: 17,
        outcome: "completed",
        runId: id,
      },
      { schemaVersion: 1, at: 1791800000000, event: "telemetry_invalid" },
    ],
  );
  telemetry("runner", "runner_started");
  telemetry("runner", "native_finished", { at: 1791700000000 });
  assert.equal(JSON.parse(lines.at(-2)!).at, 1791800000000);
  assert.equal(JSON.parse(lines.at(-1)!).at, 1791700000000); // retain original native event time on delivery
  t.mock.method(console, "info", () => {
    throw Error("logging unavailable");
  });
  assert.doesNotThrow(() => telemetry("runner", "runner_started"));
});

test("Jev logs retain diagnostic correlation and reject unapproved nested data", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  const failure = {
    selectionId: randomUUID(),
    stage: "request" as const,
    kind: "dns" as const,
    transport: "gateway" as const,
    durationMs: 12,
    stageDurationMs: 10,
    timeoutMs: 8000,
    requestBytes: 400,
    candidateCount: 2,
    errorCode: "ENOTFOUND" as const,
  };
  const fields = {
    runId: randomUUID(),
    contextTrigger: "project-turn" as const,
    contextFailure: failure,
  };
  telemetry(
    "runner",
    "jev_selection_failed",
    { ...fields, ...{ token: "private key", error: Error("private stderr") } },
    "warn",
  );
  assert.deepEqual(JSON.parse(lines[0]).contextFailure, failure);
  assert.equal(JSON.parse(lines[0]).runId, fields.runId);
  for (const invalid of [
    { ...failure, message: "private host" },
    { ...failure, errorCode: "private token" },
    { ...failure, providerRequestId: "private token" },
    { ...failure, cfRay: "private path" },
  ]) {
    assert.equal(contextFailureSchema.safeParse(invalid).success, false);
    telemetry(
      "runner",
      "jev_selection_failed",
      { ...fields, contextFailure: invalid as typeof failure },
      "warn",
    );
    assert.equal(JSON.parse(lines.at(-1)!).event, "telemetry_invalid");
  }
  assert.doesNotMatch(lines.join("\n"), /private|stderr|message|token/);
});

test("runner receipt telemetry is bounded, typed and excludes native payloads", () => {
  const event = {
    id: randomUUID(),
    at: Date.now(),
    event: "native_finished",
    actor: "claude",
    durationMs: 100,
    outcome: "completed",
  };
  assert.ok(executionEventSchema.safeParse(event).success);
  for (const unsafe of [
    { ...event, prompt: "private" },
    { ...event, outcome: "private stderr" },
    { ...event, durationMs: -1 },
    { ...event, turnId: "native transcript" },
  ])
    assert.equal(executionEventSchema.safeParse(unsafe).success, false);
  const progress = {
    seq: 1,
    state: "running",
    summary: "Private result",
    children: [],
    masterSessionId: null,
  };
  assert.ok(progressSchema.safeParse(progress).success); // deployed older runners remain compatible
  assert.ok(
    progressSchema.safeParse({
      ...progress,
      telemetry: Array(TELEMETRY_LIMIT).fill(event),
    }).success,
  );
  assert.equal(
    progressSchema.safeParse({
      ...progress,
      telemetry: Array(TELEMETRY_LIMIT + 1).fill(event),
    }).success,
    false,
  );
});

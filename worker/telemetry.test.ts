import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress } from "../src/run-model";
import type { TelemetryFields } from "../src/telemetry";
import { start, options } from "./miniflare-fixtures";

test("Worker spans retain safe request diagnostics and receipts log lifecycle timings once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-telemetry-"));
  const script = path.join(dir, "worker.mjs");
  // Test-only log sink and alarm trigger; no diagnostic/auth endpoint is added
  // to the production Worker. The real tracing API runs in workerd here.
  await build({
    stdin: {
      contents: `import worker, { Portfolio, Conversation as BaseConversation } from "./worker/index";
        import { observeRequest } from "./worker/telemetry";
        export { Portfolio };
        export class Conversation extends BaseConversation { triggerAlarm() { return super.alarm(); } }
        const logs = [];
        for (const level of ["info", "warn", "error"]) console[level] = (line) => logs.push({ level, ...JSON.parse(line) });
        export default { fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path === "/__test_logs") return Response.json(logs);
          if (path === "/__test_failure") return observeRequest(request, () => { throw Error("private-error-content"); });
          return worker.fetch(request, env);
        } };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const token = "sensitive-runner-token".repeat(3);
  const mf = await start(await options(script, dir, { RUNNER_TOKEN: token }));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const runId = randomUUID(),
      runnerId = randomUUID(),
      messageId = randomUUID();
    await store.createRun({
      requestId: runId,
      text: "sensitive-prompt",
      projectId: null,
      agent: "auto",
      workIssue: null,
    }, "owner@example.com");
    const post = (route: string, body: unknown) =>
      mf.dispatchFetch("https://example.com" + route, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post("/api/runner/claim", { runnerId })).status, 200);
    await store.messageRun(runId, {
      requestId: messageId,
      text: "sensitive-feedback",
    });
    await store.messageRun(runId, {
      requestId: messageId,
      text: "sensitive-feedback",
    });
    const eventId = randomUUID(),
      turnId = randomUUID();
    const progress: Progress = {
      seq: 1,
      state: "running",
      summary: "sensitive-receipt",
      children: [],
      masterSessionId: "sensitive-session",
      notes: [{
        id: randomUUID(), at: Date.now(), actor: "master", childId: null,
        done: ["sensitive-progress-note"], remaining: ["sensitive-plan"],
        blocker: "sensitive-blocker",
      }],
      reviewedMessageIds: [runId, messageId],
      telemetry: [
        {
          id: eventId,
          at: Date.now(),
          event: "native_finished",
          actor: "master",
          turnId,
          durationMs: 123456,
          outcome: "completed",
        },
      ],
    };
    const report = (value: unknown) =>
      post("/api/runner/report", {
        runnerId,
        id: runId,
        generation: 1,
        progress: value,
      });
    assert.equal(
      (
        await report({
          ...progress,
          telemetry: [
            { ...progress.telemetry![0], prompt: "sensitive-illegal-field" },
          ],
        })
      ).status,
      400,
    );
    assert.equal((await report(progress)).status, 200);
    assert.equal((await report(progress)).status, 200);
    assert.equal((await report({ ...progress, seq: 2 })).status, 200);
    assert.equal(
      (
        await post("/api/runner/heartbeat", {
          runnerId: randomUUID(),
          id: runId,
          generation: 1,
        })
      ).status,
      409,
    );
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name: JSON.stringify(["test", runId]) },
    );
    await storage.exec(
      "UPDATE agent_runs SET payload=json_set(payload,'$.heartbeatAt',?)",
      Date.now() - 60000,
    );
    const conversations = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const conversation = conversations.get(
      conversations.idFromName(JSON.stringify(["test", runId])),
    ) as unknown as { triggerAlarm(): Promise<void> };
    await conversation.triggerAlarm();
    assert.equal(
      (
        await post("/api/runner/heartbeat", {
          runnerId,
          id: runId,
          generation: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (await report({ ...progress, seq: 3, state: "completed" })).status,
      200,
    );
    assert.equal(
      (await report({ ...progress, seq: 3, state: "completed" })).status,
      200,
    );
    const denied = await mf.dispatchFetch(
      "https://example.com/api/private-sensitive-path?token=sensitive-query",
      { headers: { Cookie: "sensitive-cookie" } },
    );
    assert.equal(denied.status, 401);
    const failed = await mf.dispatchFetch("https://example.com/__test_failure");
    assert.equal(failed.status, 503);
    assert.match(
      failed.headers.get("X-Projects-Request-Id")!,
      /^[a-f0-9-]{36}$/,
    );
    const logs = (await (
      await mf.dispatchFetch("https://example.com/__test_logs")
    ).json()) as (TelemetryFields & { event: string; level: string })[];
    for (const event of [
      "conversation_created",
      "conversation_claimed",
      "feedback_queued",
      "feedback_reviewed",
      "native_finished",
      "runner_disconnected",
      "runner_reconnected",
      "alarm_reconciled",
      "progress_summary_saved",
      "conversation_state_changed",
    ])
      assert.equal(
        logs.filter((line) => line.event === event && line.runId === runId)
          .length,
        1,
        event,
      );
    const native = logs.find((line) => line.event === "native_finished")!;
    assert.equal(native.durationMs, 123456);
    assert.equal(native.turnId, turnId);
    assert.equal(native.eventId, eventId);
    assert.equal(
      logs.find((line) => line.event === "runner_disconnected")!
        .heartbeatAgeMs! >= 60000,
      true,
    );
    assert.ok(
      logs.some(
        (line) =>
          line.event === "request_finished" &&
          line.route === "/api/runner/report" &&
          line.status === 400,
      ),
    );
    assert.ok(
      logs.some(
        (line) =>
          line.status === 503 &&
          line.level === "error" &&
          line.requestId === failed.headers.get("X-Projects-Request-Id"),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(logs),
      /sensitive|private-error-content/,
    );
    assert.equal((await store.getRun(runId))?.state, "completed");
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

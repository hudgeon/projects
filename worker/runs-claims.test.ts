import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio, Conversation } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress, Run, RunInput } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";
import { closeSnapshot } from "./snapshot-fixtures";

test("one Studio recovers concurrent conversation claims without sharing resume state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-concurrent-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), owner = randomUUID();
  const config = await options(script, dir, {RUNNER_TOKEN: runner});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const claim = async (activeRunIds: string[] = []) => {
    const response = await mf.dispatchFetch("https://example.com/api/runner/claim", {method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"}, body: JSON.stringify({runnerId: owner, activeRunIds})});
    assert.equal(response.status, 200);
    return (await response.json() as {run: Run | null}).run;
  };
  try {
    let db = await store();
    const runs: Run[] = [];
    for (let i = 0; i < 3; i++) runs.push(JSON.parse(JSON.stringify(await db.createRun({requestId: randomUUID(), text: `Independent conversation ${i}`, projectId: null, agent: "auto", workIssue: null}, "owner@example.com"))));
    const active: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = (await claim(active))!;
      assert.ok(!active.includes(next.id));
      assert.equal((await claim(active))!.id, next.id, "a lost claim reply retries its reservation");
      active.push(next.id);
    }
    assert.equal(await claim(active), null);
    assert.equal(await db.claimRun(randomUUID(), [], undefined, "studio"), null, "another owner cannot steal active work");
    const receipts = runs.map(run => ({seq: 1, state: "running" as const, summary: "Inspecting independently", masterSessionId: randomUUID(), children: [], reviewedMessageIds: [run.messages[0].id]}));
    for (let i = 0; i < runs.length; i++) assert.equal(await db.reportRun(owner, runs[i].id, 1, receipts[i], "studio"), true);
    await db.cancelRun(runs[0].id);
    assert.equal((await db.heartbeatRun(owner, runs[0].id, 1, "studio"))!.cancel, true);
    assert.equal((await db.heartbeatRun(owner, runs[1].id, 1, "studio"))!.cancel, false);
    await mf.dispose(); mf = await start(config); db = await store();
    const recovered: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = (await claim(recovered))!;
      assert.ok(!recovered.includes(next.id));
      const index = runs.findIndex(run => run.id === next.id);
      assert.equal(next.progress!.masterSessionId, receipts[index].masterSessionId);
      recovered.push(next.id);
    }
    assert.deepEqual(new Set(recovered), new Set(active));
    await db.reportRun(owner, runs[1].id, 1, {...receipts[1], seq: 2, state: "completed"}, "studio");
    await db.messageRun(runs[1].id, {requestId: randomUUID(), text: "Resume only this conversation"});
    const follow = (await claim([runs[0].id, runs[2].id]))!;
    assert.equal(follow.id, runs[1].id);
    assert.equal(follow.generation, 2);
    assert.equal(follow.progress!.masterSessionId, receipts[1].masterSessionId);
    assert.equal((await db.getRun(runs[2].id))!.generation, 1);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});
test("conversations isolate credentials and persist idempotent ownership, cancellation and follow-ups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-runs-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const collector = "c".repeat(64),
    runner = "r".repeat(64),
    origin = "https://example.com";
  const config = await options(script, dir, {
    ALLOWED_EMAILS: "owner@example.com",
    COLLECTOR_TOKEN: collector,
    RUNNER_TOKEN: runner,
  });
  let mf = await start(config);
  const store = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  const post = (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(origin + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    let db = await store();
    const salt = token(),
      value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = { Cookie: `__Host-projects=${value}`, Origin: origin },
      bearer = { Authorization: `Bearer ${runner}` };
    const input: RunInput = {
      requestId: randomUUID(),
      text: "Verify the project",
      projectId: null,
      agent: "auto",
      workIssue: null,
    };
    assert.equal(
      (await post("/api/runs", input, { Cookie: browser.Cookie })).status,
      403,
    );
    assert.equal(
      (
        await post("/api/runs", input, {
          Authorization: `Bearer ${collector}`,
          Origin: origin,
        })
      ).status,
      401,
    );
    assert.equal(
      (await post("/api/runner/claim", { runnerId: randomUUID() }, browser))
        .status,
      401,
    );
    assert.equal(
      (
        await post(
          "/api/runner/claim",
          { runnerId: randomUUID() },
          { Authorization: `Bearer ${collector}` },
        )
      ).status,
      401,
    );
    assert.equal(
      (await mf.dispatchFetch(origin + "/api/overview", { headers: bearer }))
        .status,
      401,
    );
    assert.equal(
      (await post("/api/ingest", closeSnapshot(), bearer)).status,
      401,
    );
    assert.equal((await post("/api/runs", input, browser)).status, 409); // missing inventory is not clean
    await db.publish(
      closeSnapshot() as unknown as Parameters<Portfolio["publish"]>[0],
    );
    const starts = await Promise.all([
      post("/api/runs", input, browser),
      post("/api/runs", input, browser),
    ]);
    assert.deepEqual(
      starts.map((r) => r.status),
      [200, 200],
    );
    assert.equal((await db.listRuns()).length, 1);
    assert.equal((await db.listRuns())[0].title, input.text);
    const owner = randomUUID(),
      other = randomUUID();
    const claim = async (id = owner) =>
      (await (
        await post("/api/runner/claim", { runnerId: id }, bearer)
      ).json()) as { run: Run | null; activity: unknown[] };
    const first = await claim();
    assert.equal(first.run?.id, input.requestId);
    assert.equal(first.activity.length, 1);
    assert.equal((await claim()).run?.id, input.requestId);
    assert.equal((await claim(other)).run, null);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Portfolio",
      { name: "test" },
    );
    await storage.exec(
      "UPDATE conversation_index SET payload=json_set(payload,'$.heartbeatAt',0)",
    );
    assert.equal((await claim(other)).run, null); // expiration never creates a replacement executor
    await mf.dispose();
    mf = await start(config);
    db = await store();
    assert.equal((await claim()).run?.id, input.requestId);
    const receipt: Progress = {
      seq: 1,
      state: "running",
      summary: "Reviewing",
      children: [],
      masterSessionId: randomUUID(),
    };
    const report = (progress: Progress, generation = 1, runnerId = owner) =>
      post(
        "/api/runner/report",
        { runnerId, id: input.requestId, generation, progress },
        bearer,
      );
    assert.equal((await report(receipt, 1, other)).status, 409);
    assert.equal(
      (await report({ ...receipt, unexpected: "raw output" } as Progress))
        .status,
      400,
    );
    assert.equal((await report(receipt)).status, 200);
    assert.equal((await report(receipt)).status, 200);
    assert.equal(
      (await post(`/api/runs/${input.requestId}/cancel`, {}, browser)).status,
      200,
    );
    const heartbeat = await post(
      "/api/runner/heartbeat",
      { runnerId: owner, id: input.requestId, generation: 1 },
      bearer,
    );
    assert.equal(
      ((await heartbeat.json()) as { cancel: boolean }).cancel,
      true,
    );
    assert.equal(
      (
        await report({
          ...receipt,
          seq: 2,
          state: "completed",
          summary: "Late completion",
        })
      ).status,
      200,
    );
    let run = (await db.getRun(input.requestId))!;
    assert.equal(run.state, "cancelled");
    assert.equal(run.progress?.state, "cancelled");
    assert.equal(run.messages.length, 2);
    assert.match(run.messages[1].text, /Stopped/);
    assert.equal(
      (await report({ ...receipt, seq: 2, state: "completed" })).status,
      200,
    ); // final receipt retry
    assert.equal((await db.getRun(input.requestId))?.messages.length, 2);
    const follow = {
      requestId: randomUUID(),
      text: "Continue with the clarification",
    };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await post(`/api/runs/${input.requestId}/message`, follow, browser))
          .status,
        200,
      );
    run = (await db.getRun(input.requestId))!;
    assert.equal(run.generation, 2);
    assert.equal(run.messages.length, 3);
    assert.equal(run.state, "queued");
    assert.equal(
      (await report({ ...receipt, seq: 999, state: "completed" })).status,
      409,
    ); // old turn cannot overwrite new one
    assert.equal((await claim()).run?.generation, 2);
    assert.equal(
      (
        await report(
          { ...receipt, seq: 1, state: "blocked", summary: "Needs a decision" },
          2,
        )
      ).status,
      200,
    );
    const queued = await db.createRun({ ...input, requestId: randomUUID() }, "owner@example.com");
    await db.cancelRun(queued.id);
    assert.equal((await claim()).run, null); // queued cancellation never reaches a native process
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("active conversation cap includes old runs outside the history page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-runs-cap-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(await options(script, dir));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"),
      db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const input = () => ({
      requestId: randomUUID(),
      text: "Inspect",
      projectId: null,
      agent: "auto" as const,
      workIssue: null,
    });
    const old = await db.createRun(input(), "owner@example.com");
    for (let n = 0; n < 55; n++) {
      const r = await db.createRun(input(), "owner@example.com");
      await db.cancelRun(r.id);
    }
    for (let n = 0; n < 9; n++) await db.createRun(input(), "owner@example.com");
    assert.ok((await db.listRuns()).some((r) => r.id === old.id));
    await assert.rejects(async () => db.createRun(input(), "owner@example.com"));
    const cancelled = (await db.listRuns()).find(
      (r) => r.state === "cancelled",
    )!;
    await assert.rejects(async () =>
      db.messageRun(cancelled.id, {
        requestId: randomUUID(),
        text: "Continue",
      }),
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conversation alarm detects disconnection without replacing its claim and repairs a lost index update", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-alarm-")),
    script = path.join(dir, "worker.mjs");
  await build({
    stdin: {
      contents: `export {default,Portfolio} from './worker/index'; import {Conversation as Base} from './worker/runs'; export class Conversation extends Base { triggerAlarm() { return super.alarm(); } }`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(await options(script, dir));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"),
      store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const owner = randomUUID(),
      run = await store.createRun({
        requestId: randomUUID(),
        text: "Inspect",
        projectId: null,
        agent: "auto",
        workIssue: null,
      }, "owner@example.com");
    await store.claimRun(owner, [], undefined, "studio");
    const name = JSON.stringify(["test", run.id]);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name },
    );
    await storage.exec(
      "UPDATE agent_runs SET payload=json_set(payload,'$.heartbeatAt',0)",
    );
    // Invoke the actual handler through a test-only subclass; alarm is reserved
    // over RPC and the production class exposes no manual alarm endpoint.
    const conversations = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const object = conversations.get(
      conversations.idFromName(name),
    ) as unknown as Conversation & { triggerAlarm(): Promise<void> };
    await object.triggerAlarm();
    assert.equal((await store.getRun(run.id))?.connection, "disconnected");
    assert.equal(await store.claimRun(randomUUID(), [], undefined, "studio"), null);
    await store.heartbeatRun(owner, run.id, 1, "studio");
    assert.equal((await store.getRun(run.id))?.connection, "connected");
    await store.reportRun(owner, run.id, 1, {
      seq: 1,
      state: "completed",
      summary: "Done",
      children: [],
      masterSessionId: null,
      reviewedMessageIds: [run.id],
    }, "studio");
    // Bypass the directory to model a committed message whose RPC reply was lost.
    await object.message(run.id, { requestId: randomUUID(), text: "Continue" });
    await object.triggerAlarm();
    assert.equal((await store.claimRun(owner, [], undefined, "studio"))?.generation, 2);
    assert.equal(
      (await store.getRun(run.id))?.messages.at(-1)?.delivery,
      "queued",
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("quick work is claimed only into a free quick slot and has its own capacity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-lanes-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: "r".repeat(64)}));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const create = (text: string, lane?: "quick") => db.createRun({requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null, ...(lane ? {lane} : {})}, "owner@example.com");
    const big = await create("Refactor the importer");
    const reply = await create("Reply to Rob", "quick");
    const runner = randomUUID();
    assert.equal((await db.claimRun(runner, [], ["quick"], "studio"))!.id, reply.id, "a full standard pool still takes quick work");
    assert.equal(await db.claimRun(runner, [reply.id], ["quick"], "studio"), null, "standard work waits for a standard slot");
    assert.equal((await db.claimRun(runner, [reply.id], ["standard", "quick"], "studio"))!.id, big.id);
    assert.equal((await db.listRuns()).find((r) => r.id === reply.id)!.lane, "quick");
    // Ten standard conversations fill their bound; quick work can still start.
    for (let i = 0; i < 9; i++) await create(`Standard ${i}`);
    await assert.rejects(create("One too many"));
    for (let i = 0; i < 5; i++) await create(`Reply ${i}`, "quick");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

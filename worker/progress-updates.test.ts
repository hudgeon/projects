import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { Portfolio, Conversation } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";

test("five-minute summaries survive alarms, duplicate receipts, restart and disconnection without replaying work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-progress-")),
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
  const config = await options(script, dir);
  let mf = await start(config);
  const owner = randomUUID(),
    runId = randomUUID();
  const name = JSON.stringify(["test", runId]);
  const store = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  const object = async () => {
    const ns = await mf.getDurableObjectNamespace("CONVERSATIONS");
    return ns.get(ns.idFromName(name)) as unknown as Conversation & {
      triggerAlarm(): Promise<void>;
    };
  };
  const makeDue = async (disconnected = false, duration = 300_000) => {
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name },
    );
    await storage.exec(
      "UPDATE progress_window SET payload=json_set(payload,'$.from',?)",
      Date.now() - duration,
    );
    await storage.exec(
      "UPDATE agent_runs SET payload=json_set(payload,'$.nextUpdateAt',?,'$.heartbeatAt',?)",
      Date.now() - 1,
      disconnected ? 0 : Date.now(),
    );
  };
  try {
    let portfolio = await store();
    await portfolio.createRun({
      requestId: runId,
      text: "Inspect progress",
      projectId: null,
      agent: "auto",
      workIssue: null,
    }, "owner@example.com");
    assert.equal((await portfolio.getRun(runId))?.nextUpdateAt, undefined);
    const claim = await portfolio.claimRun(owner, [], undefined, "studio");
    assert.ok(claim?.nextUpdateAt && claim.nextUpdateAt > Date.now() + 290_000);
    const note = {
      id: randomUUID(),
      at: Date.now(),
      actor: "codex" as const,
      childId: null,
      done: ["Checked the implementation"],
      remaining: ["Run tests", "Verify deployment"],
      blocker: null,
    };
    const receipt: Progress = {
      seq: 1,
      state: "running",
      summary: "Checking",
      children: [],
      masterSessionId: null,
      activity: [
        {
          id: randomUUID(),
          at: Date.now(),
          actor: "codex",
          childId: null,
          kind: "command",
          state: "finished",
        },
      ],
      notes: [note],
    };
    await portfolio.reportRun(owner, runId, 1, receipt, "studio");
    await portfolio.reportRun(owner, runId, 1, receipt, "studio");
    await portfolio.reportRun(owner, runId, 1, { ...receipt, seq: 2 }, "studio");
    await portfolio.heartbeatRun(owner, runId, 1, "studio");
    assert.equal(
      (await portfolio.getRun(runId))?.nextUpdateAt, claim!.nextUpdateAt,
    );
    await (await object()).triggerAlarm();
    assert.equal((await portfolio.getRun(runId))?.updates?.length ?? 0, 0);
    await makeDue();
    await (await object()).triggerAlarm();
    let run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, 1);
    assert.deepEqual(run.updates[0].done, note.done);
    assert.deepEqual(run.updates[0].operations, { command: 1 });
    assert.deepEqual(run.updates[0].note?.remaining, note.remaining);
    assert.equal(run.updates[0].disconnected, false);
    assert.equal(run.generation, 1);
    await mf.dispose();
    mf = await start(config);
    portfolio = await store();
    await (await object()).triggerAlarm();
    assert.equal((await portfolio.getRun(runId))?.updates?.length, 1);
    await portfolio.archiveRun(runId, true);
    await makeDue(true);
    await (await object()).triggerAlarm();
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, 2);
    assert.deepEqual(run.updates[1].done, []);
    assert.deepEqual(run.updates[1].operations, {});
    assert.equal(run.updates[1].note?.at, note.at);
    assert.equal(run.updates[1].disconnected, true);
    assert.ok(run.nextUpdateAt && run.nextUpdateAt > Date.now());
    assert.equal(await portfolio.claimRun(randomUUID(), [], undefined, "studio"), null);
    await portfolio.heartbeatRun(owner, runId, 1, "studio");
    await portfolio.reportRun(owner, runId, 1, {
      ...receipt,
      seq: 3,
      state: "completed",
      reviewedMessageIds: [runId],
    }, "studio");
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.state, "completed");
    assert.equal(run.nextUpdateAt, null);
    assert.equal(run.updates?.at(-1)?.state, "completed");
    const count = run.updates!.length;
    await (await object()).triggerAlarm();
    assert.equal((await portfolio.getRun(runId))?.updates?.length, count);
    await portfolio.archiveRun(runId, false);
    await portfolio.messageRun(runId, {
      requestId: randomUUID(),
      text: "Continue",
    });
    const follow = await portfolio.claimRun(owner, [], undefined, "studio");
    assert.equal(follow?.generation, 2);
    await makeDue();
    await (await object()).triggerAlarm();
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.at(-1)?.note, null);
    assert.deepEqual(run.updates?.at(-1)?.done, []);
    assert.equal(run.updates?.at(-1)?.generation, 2);
    assert.equal(run.updates?.length, count + 1);
    await makeDue(false, 20 * 60_000);
    await (await object()).triggerAlarm();
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, count + 2, "delays create one honest interval, not invented backfill");
    const delayed = run.updates!.at(-1)!;
    assert.ok(delayed.to - delayed.from >= 20 * 60_000);
    for (let i = 0; i < 26; i++) {
      await makeDue();
      await (await object()).triggerAlarm();
    }
    run = (await portfolio.getRun(runId))!;
    assert.equal(run.updates?.length, 24);
    assert.equal(new Set(run.updates!.map(update => update.id)).size, 24);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

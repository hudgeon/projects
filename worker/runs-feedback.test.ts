import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress, RunInput } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";

test("feedback given to the agent at work is marked so and still reviewed by the master", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-steer-")),
    script = path.join(dir, "worker.mjs");
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const mf = await start(await options(script, dir, { ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: "r".repeat(64) })),
    owner = randomUUID();
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const input: RunInput = { requestId: randomUUID(), text: "Change the button", projectId: null, agent: "auto", workIssue: null };
    await db.createRun(input);
    await db.claimRun(owner, [], undefined, "studio");
    const steer = { requestId: randomUUID(), text: "Use the blue button" };
    await db.messageRun(input.requestId, steer);
    const receipt: Progress = { seq: 1, state: "running", summary: "Changing", masterSessionId: randomUUID(), children: [], reviewedMessageIds: [input.requestId] };
    assert.equal(await db.reportRun(owner, input.requestId, 1, { ...receipt, steeredMessageIds: [randomUUID()] }, "studio"), false, "only this conversation's messages");
    assert.equal(await db.reportRun(owner, input.requestId, 1, { ...receipt, steeredMessageIds: [steer.requestId], live: { actor: "claude", childId: randomUUID(), at: Date.now(), plan: [{ step: "Change the button", status: "active" }], changes: { files: [{ path: "src/button.tsx", added: 3, removed: 1 }], total: { files: 1, added: 3, removed: 1 }, at: Date.now() } } }, "studio"), true);
    const steered = (await db.getRun(input.requestId))!;
    assert.equal(steered.messages.find((m) => m.id === steer.requestId)?.delivery, "steered");
    assert.equal(steered.progress?.live?.changes?.total.added, 3);
    // The master's next decision reviews it; completion does not wait on it.
    assert.equal(await db.reportRun(owner, input.requestId, 1, { ...receipt, seq: 2, state: "completed", summary: "Done", steeredMessageIds: [steer.requestId], reviewedMessageIds: [input.requestId, steer.requestId] }, "studio"), true);
    const done = (await db.getRun(input.requestId))!;
    assert.equal(done.messages.find((m) => m.id === steer.requestId)?.delivery, "reviewed");
    assert.equal(done.state, "completed");
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("active feedback is durable, idempotent and cannot be lost at completion or replayed by another runner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-feedback-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir, {
      ALLOWED_EMAILS: "owner@example.com",
      RUNNER_TOKEN: "r".repeat(64),
    }),
    owner = randomUUID(),
    other = randomUUID();
  let mf = await start(config);
  const store = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  try {
    let db = await store();
    const input: RunInput = {
      requestId: randomUUID(),
      text: "Inspect",
      projectId: null,
      agent: "auto",
      workIssue: null,
    };
    const run = { id: input.requestId };
    await db.createRun(input);
    // Long chats retain their identity and claim; retries never add messages.
    const historical: string[] = [];
    for (let i = 0; i < 45; i++) {
      const message = {requestId: randomUUID(), text: `Earlier instruction ${i}`};
      historical.push(message.requestId);
      await db.messageRun(run.id, message);
      await db.messageRun(run.id, message);
    }
    assert.equal((await db.getRun(run.id))!.messages.length, 46);
    const queued = { requestId: randomUUID(), text: "Check the README too" };
    await db.messageRun(run.id, queued);
    assert.equal((await db.claimRun(owner, [], undefined, "studio"))?.generation, 1);
    const feedbackSalt = token(), cookie = token(), email = "owner@example.com";
    await db.issue(email, feedbackSalt, digest(`${feedbackSalt}:123456`));
    await db.verify(email, "123456", digest(cookie));
    const repeat = (requestId = input.requestId) => mf.dispatchFetch(`https://example.com/api/runs/${run.id}/message`, {
      method: "POST", headers: {Origin: "https://example.com", Cookie: `__Host-projects=${cookie}`, "Content-Type": "application/json"},
      body: JSON.stringify({requestId, text: input.text}),
    });
    assert.equal((await repeat()).status, 200, "an accepted request retry stays idempotent");
    const feedback = { requestId: randomUUID(), text: "Explain the result" };
    await db.messageRun(run.id, feedback);
    await db.messageRun(run.id, feedback);
    assert.equal((await db.getRun(run.id))?.messages.length, 48);
    assert.equal((await db.getRun(run.id))?.generation, 1);
    assert.equal(
      (await db.heartbeatRun(owner, run.id, 1, "studio"))?.messages.at(-1)?.delivery,
      "queued",
    );
    // A bounded receipt can acknowledge a large backlog in batches.
    assert.equal(await db.reportRun(owner, run.id, 1, {seq: 1, state: "running", summary: "Reviewing", masterSessionId: null, children: [], reviewedMessageIds: historical.slice(0, 40)}, "studio"), true);
    const receipt: Progress = {
      seq: 2,
      state: "running",
      summary: "Reviewing feedback",
      masterSessionId: randomUUID(),
      children: [],
      reviewedMessageIds: [
        input.requestId,
        queued.requestId,
        feedback.requestId,
        ...historical.slice(40),
      ],
    };
    assert.equal(await db.reportRun(other, run.id, 1, receipt, "studio"), false);
    assert.equal(await db.reportRun(owner, run.id, 1, receipt, "studio"), true);
    assert.equal(
      (await db.getRun(run.id))?.messages.at(-1)?.delivery,
      "reviewed",
    );
    const late = { requestId: randomUUID(), text: "Add a concise summary" };
    await db.messageRun(run.id, late);
    const final = {
      ...receipt,
      seq: 3,
      state: "completed" as const,
      summary: "Completed the original request",
    };
    assert.equal(await db.reportRun(owner, run.id, 1, final, "studio"), true);
    assert.equal(await db.reportRun(owner, run.id, 1, final, "studio"), true); // lost response retry
    assert.equal((await db.getRun(run.id))?.state, "queued");
    assert.equal((await db.getRun(run.id))?.generation, 1); // retain receipt identity until next claim
    assert.equal(await db.claimRun(other, [], undefined, "studio"), null);
    await mf.dispose();
    mf = await start(config);
    db = await store();
    const follow = await db.claimRun(owner, [], undefined, "studio");
    assert.equal(follow?.generation, 2);
    assert.equal(follow?.progress?.masterSessionId, receipt.masterSessionId);
    assert.equal(
      follow?.messages.find((m) => m.id === late.requestId)?.delivery,
      "queued",
    );
    assert.equal(await db.reportRun(owner, run.id, 1, final, "studio"), false);
    assert.equal(
      await db.reportRun(owner, run.id, 2, {
        ...final,
        seq: 1,
        reviewedMessageIds: [...receipt.reviewedMessageIds!, late.requestId],
      }, "studio"),
      true,
    );
    assert.equal((await db.getRun(run.id))?.state, "completed");
    assert.equal(
      (await db.getRun(run.id))?.messages.find((m) => m.id === late.requestId)
        ?.delivery,
      "reviewed",
    );
    const cancelled = await db.createRun({ ...input, requestId: randomUUID() });
    await db.claimRun(owner, [], undefined, "studio");
    await db.messageRun(cancelled.id, {
      requestId: randomUUID(),
      text: "Pending feedback",
    });
    await db.cancelRun(cancelled.id);
    // Test the public error response: Miniflare cannot propagate synchronous
    // RPC throws with their original message through its Node proxy.
    const salt = token(),
      session = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(session));
    const rejected = await mf.dispatchFetch(
      `https://example.com/api/runs/${cancelled.id}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          Cookie: `__Host-projects=${session}`,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          text: "Too late",
        }),
      },
    );
    assert.equal(rejected.status, 409);
    assert.match(await rejected.text(), /current turn to stop/);
    for (let i = 0; i < 120; i++) await db.rate(`feedback:${email}`, 120, 3600_000);
    assert.equal((await repeat(randomUUID())).status, 429, "feedback throughput is bounded independently of chat length");
    assert.equal((await repeat()).status, 200, "lost-response retries bypass throttling without executing again");
    await db.reportRun(owner, cancelled.id, 1, {
      ...final,
      reviewedMessageIds: [],
    }, "studio");
    assert.equal((await db.getRun(cancelled.id))?.state, "cancelled");
    assert.equal(await db.claimRun(owner, [], undefined, "studio"), null);
    const legacy = await db.createRun({ ...input, requestId: randomUUID() });
    await db.claimRun(owner, [], undefined, "studio");
    await db.messageRun(legacy.id, {
      requestId: randomUUID(),
      text: "New feedback to an old runner",
    });
    await db.reportRun(owner, legacy.id, 1, {
      ...final,
      reviewedMessageIds: undefined,
    }, "studio");
    assert.equal((await db.getRun(legacy.id))?.state, "blocked");
    assert.equal(await db.claimRun(owner, [], undefined, "studio"), null);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

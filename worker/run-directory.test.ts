import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import { runInputSchema, type Progress, type Run, type RunInput } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";

test("conversation lists lead with a short title, the current step and the email being handled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-summary-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), origin = "https://example.com";
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: "c".repeat(64)}));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const thread = "1a1324eccd4e4489";
    const input: RunInput = {requestId: randomUUID(), text: "Reply to Rob about “Re: November plan”\n\nSay Thursday works.\n\nEmail: [Re: November plan](https://mail.google.com/mail/u/#all/1a1324eccd4e4489) from Rob.", projectId: null, agent: "auto", workIssue: 942, emailThread: thread};
    assert.equal(runInputSchema.safeParse({...input, emailThread: "not-a-thread"}).success, false);
    const run: Run = JSON.parse(JSON.stringify(await db.createRun(input)));
    let [listed] = await db.listRuns();
    assert.deepEqual(
      {title: listed.title, status: listed.status, emailThread: listed.emailThread, workIssue: listed.workIssue, remaining: listed.remaining},
      {title: "Reply to Rob about “Re: November plan”", status: "Waiting for a free slot", emailThread: thread, workIssue: 942, remaining: null},
    );
    const owner = randomUUID();
    await db.claimRun(owner, [], undefined, "studio");
    const report = (progress: Progress) => mf.dispatchFetch(origin + "/api/runner/report", {
      method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"},
      body: JSON.stringify({runnerId: owner, id: run.id, generation: run.generation, progress}),
    });
    const note = {id: randomUUID(), at: Date.now(), actor: "codex" as const, childId: null, done: ["Read the thread"], remaining: ["Draft the reply", "Save it in Gmail"], blocker: null};
    const running: Progress = {seq: 1, state: "running", title: "Reply to Rob about training", summary: "Asked Codex to draft it.\n\nwork: #942", children: [], masterSessionId: null, notes: [note]};
    assert.equal((await report({...running, title: "x".repeat(81)})).status, 400, "titles stay short");
    assert.equal((await report(running)).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.title, listed.status, listed.remaining, listed.needsYou], ["Reply to Rob about training", "Draft the reply", 2, false]);
    // Only steps the user must take put a running conversation in their move.
    assert.equal((await report({...running, seq: 2, notes: [{...note, id: randomUUID(), at: Date.now() + 1, yourMove: "Sign in to Gmail on the Studio"}]})).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.state, listed.status, listed.needsYou], ["running", "Sign in to Gmail on the Studio", true]);
    // Signs the current step is stuck reach the list too.
    const watch = {since: Date.now() - 12 * 60_000, on: "command" as const, label: "review" as const, stuck: "idle" as const, quietSince: Date.now() - 12 * 60_000};
    assert.equal((await report({...running, seq: 3, live: {actor: "codex", childId: null, at: Date.now(), watch}})).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.stuck, listed.status], [true, "What it is waiting on has used no CPU for 12 min"]);
    assert.equal((await report({...running, seq: 4, state: "completed", notes: [], reviewedMessageIds: [run.id], summary: "Drafted the [reply to Rob](https://mail.google.com/mail/u/#all/1a13ab). **Your move:** send it.\n\nwork: #942"})).status, 200);
    [listed] = await db.listRuns();
    assert.deepEqual([listed.state, listed.title, listed.status, listed.remaining], ["completed", "Reply to Rob about training", "Drafted the reply to Rob.", null]);
    assert.equal((await db.getRun(run.id))!.emailThread, thread);
    // The inbox joins every email conversation, including Done ones, in one read.
    await db.createRun({requestId: randomUUID(), text: "Not from email", projectId: null, agent: "auto", workIssue: null});
    await db.archiveRun(run.id, true);
    assert.deepEqual((await db.listRuns()).map((r) => r.emailThread ?? null), [null]);
    const email = await db.listRuns({email: true});
    assert.deepEqual(email.map((r) => [r.id, r.emailThread, !!r.archivedAt]), [[run.id, thread, true]]);
    const browser = await (await mf.dispatchFetch(origin + "/api/runs?email=true")).status;
    assert.equal(browser, 401, "the email join still needs the signed-in owner");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

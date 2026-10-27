import { snapshotSchema } from "../src/model";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import type { Portfolio } from "./index";
import { start, options } from "./miniflare-fixtures";
import { closeSnapshot } from "./snapshot-fixtures";
import { issue } from "../tests/work-fixtures";
import {
  WORK_REVIEW_CRON,
  workReviewDay,
  workReviewScheduleProblem,
} from "../src/work-review-model";
import { startInputSchema } from "../src/run-model";

test("daily review records skips, starts once per local day, retries after an offline morning and shares runner admission", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "work-review-"));
  const script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(
    await options(script, dir, {
      OWNER_EMAIL: "owner@example.com",
      ALLOWED_EMAILS: "owner@example.com",
      TIME_ZONE: "Europe/London",
      RUNNER_TOKEN: "r".repeat(64),
      COLLECTOR_TOKEN: "c".repeat(64),
    }),
  );
  const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
  const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
  const at = Date.UTC(2026, 9, 27, 5, 30); // next local day, 05:30
  const cron = async (time: number) => {
    const r = await mf.dispatchFetch(
      `https://example.com/cdn-cgi/local/scheduled?time=${time}&cron=${encodeURIComponent(WORK_REVIEW_CRON)}`,
    );
    assert.equal(r.status, 200, await r.text());
  };
  try {
    await cron(at - 3600000);
    assert.equal(await db.upkeepSchedule("work-review"), null);
    await cron(at);
    assert.equal(
      (await db.upkeepSchedule("work-review"))?.outcome,
      "no_snapshot",
    );
    await db.publish(
      snapshotSchema.parse({
        ...closeSnapshot(Date.now()),
        work: {
          repo: "acme/work",
          issues: [issue(7)],
          associations: [],
          associationsState: "ok",
        },
      }),
    );
    await cron(at + 3600000);
    const receipt = (await db.upkeepSchedule("work-review"))!;
    assert.equal(receipt.outcome, "started");
    await cron(at + 3600000);
    assert.equal((await db.upkeepSchedule("work-review"))?.outcome, "exists");
    assert.equal(
      (await db.listRuns()).filter((r) => r.lane === "review").length,
      1,
    );
    const run = (await db.getRun(receipt.runId!))!;
    assert.equal(run.owner, "owner@example.com");
    assert.equal(
      await db.claimRun(
        randomUUID(),
        [],
        ["standard", "quick", "upkeep"],
        "studio",
      ),
      null,
    );
    assert.equal(
      (await db.claimRun(randomUUID(), [], ["review"], "studio"))?.id,
      run.id,
    );
    assert.equal(
      await db.upkeepSchedule(),
      null,
      "weekly receipt is kept separately",
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("daily local clock follows daylight saving and the composer cannot start the reserved lane", () => {
  assert.deepEqual(
    workReviewDay(Date.UTC(2026, 5, 2, 4, 30), "Europe/London"),
    { day: "2026-06-02", minute: 5 * 60 + 30 },
  );
  assert.deepEqual(
    workReviewDay(Date.UTC(2026, 9, 27, 5, 30), "Europe/London"),
    { day: "2026-10-27", minute: 5 * 60 + 30 },
  );
  // London summer time: 05:30 local on 2 June is 04:30 UTC.
  const zone = "Europe/London";
  const seen = (at: number) => ({
    scheduledAt: at,
    observedAt: at,
    outcome: "started",
  });
  const previous = seen(Date.UTC(2026, 5, 1, 4, 30));
  const today = seen(Date.UTC(2026, 5, 2, 4, 30));
  for (const [now, receipt, problem] of [
    [Date.UTC(2026, 5, 2, 4, 0), previous, false], // 05:00: not yet due
    [Date.UTC(2026, 5, 2, 5, 0), previous, false], // 06:00: may still land
    [Date.UTC(2026, 5, 2, 5, 31), previous, true], // 06:31: missing
    [Date.UTC(2026, 5, 2, 5, 31), today, false],
  ] as const)
    assert.equal(
      workReviewScheduleProblem(receipt, now, zone) !== null,
      problem,
    );
  assert.equal(
    startInputSchema.safeParse({
      requestId: randomUUID(),
      text: "review",
      projectId: null,
      agent: "auto",
      workIssue: null,
      lane: "review",
    }).success,
    false,
  );
});

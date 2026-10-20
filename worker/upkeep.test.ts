// The upkeep lane in the Worker (worker/upkeep.ts, worker/settings.ts): the
// weekly trigger, Run upkeep now, and the lane's own slot and capacity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import type { Run, RunSummary } from "../src/run-model";
import { UPKEEP_CRON, UPKEEP_SCHEDULE, upkeepRequestId, upkeepWeek } from "../src/upkeep-model";
import { emptyCounts } from "../src/friction-model";
import { issue } from "../tests/work-fixtures";
import { closeSnapshot } from "./snapshot-fixtures";
import { start, options } from "./miniflare-fixtures";
import { startUpkeep, type UpkeepStore } from "./upkeep";

const DAY = 86400_000;
// Monday 26 October 2026, 06:00 UTC, when the cron fires.
const monday = Date.UTC(2026, 9, 26, 6);
const bundle = async (dir: string) => {
  const script = path.join(dir, "worker.mjs");
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  return script;
};
const friction = {
  observedAt: monday - 60_000,
  versions: { claude: "2.1.0" },
  days: [{ date: "2026-10-25", app: "Claude" as const, sessions: 2, counts: { ...emptyCounts(), prompts: 4, toolCalls: 9, commandFailed: 1 } }],
  state: "ok" as const,
  message: "Receipts for 2 sessions.",
};

test("the weekly trigger starts one upkeep conversation a week for the deployment owner, and Settings starts one now", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-upkeep-")), script = await bundle(dir);
  const runner = "r".repeat(64), collector = "c".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, { ALLOWED_EMAILS: "owner@example.com, matt.smith@example.com", OWNER_EMAIL: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: collector });
  const mf = await start(config);
  const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
  const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
  const scheduled = async (at: number, cron = UPKEEP_CRON) => {
    const response = await mf.dispatchFetch(`${origin}/cdn-cgi/local/scheduled?time=${at}&cron=${encodeURIComponent(cron)}`);
    assert.equal(response.status, 200, await response.text());
  };
  const cycles = async () => (await db.listRuns()).filter((r) => r.lane === "upkeep").sort((a, b) => a.createdAt - b.createdAt);
  const finish = async (owner: string, run: Pick<RunSummary, "id">, generation = 1) =>
    assert.equal(await db.reportRun(owner, run.id, generation, { seq: 1, state: "completed", summary: "No change needed this cycle.", children: [], masterSessionId: randomUUID() }, "studio"), true);
  try {
    // Nothing to run for until a machine has published.
    await scheduled(monday);
    assert.deepEqual(await cycles(), []);
    await db.publish({ ...closeSnapshot(monday - 60_000), work: { issues: [issue(7), issue(10, { upkeep: true, open: false }), issue(9, { title: "Agent upkeep", upkeep: true })], associations: [], associationsState: "ok" }, friction } as Parameters<Portfolio["publish"]>[0]);
    await scheduled(monday);
    const [first] = await cycles();
    assert.equal(first.owner, "owner@example.com", "the deployment owner's, as nobody asked for it");
    assert.equal(first.workIssue, 9, "linked to the open standing issue labelled upkeep");
    assert.equal(first.id, await upkeepRequestId("test", upkeepWeek(monday)));
    const run = (await db.getRun(first.id))!;
    assert.equal(run.lane, "upkeep");
    assert.match(run.messages[0].text, /^Weekly upkeep cycle: /);
    // The same week again (a retry, a second firing) finds it; a cron this
    // Worker does not know starts nothing.
    await scheduled(monday + DAY);
    await scheduled(monday + 6 * DAY, "0 7 * * 2");
    assert.equal((await cycles()).length, 1);
    // The next week waits while a cycle is still active, then starts its own.
    await scheduled(monday + 7 * DAY);
    assert.equal((await cycles()).length, 1);
    const owner = randomUUID();
    assert.equal((await db.claimRun(owner, [], ["upkeep"], "studio"))!.id, first.id);
    await finish(owner, first);
    await scheduled(monday + 7 * DAY);
    const second = (await cycles())[1];
    assert.equal(second.id, await upkeepRequestId("test", upkeepWeek(monday + 7 * DAY)));
    await finish(owner, (await db.claimRun(owner, [], ["upkeep"], "studio"))!);
    // Run upkeep now: a cycle of its own for the deployment owner, whoever asks.
    const salt = token(), cookie = token();
    await db.issue("matt.smith@example.com", salt, digest(`${salt}:123456`));
    await db.verify("matt.smith@example.com", "123456", digest(cookie));
    const user = { Cookie: `__Host-projects=${cookie}`, Origin: origin, "Content-Type": "application/json" };
    const post = (route: string, body: unknown, headers: Record<string, string> = user) => mf.dispatchFetch(origin + route, { method: "POST", headers, body: JSON.stringify(body) });
    type View = { latest: RunSummary | null; schedule: string; started?: string; error?: string };
    const response = await post("/api/upkeep", {});
    let view = (await response.json()) as View;
    assert.equal(response.status, 200, JSON.stringify(view));
    assert.equal(view.started, "started");
    assert.equal(view.schedule, UPKEEP_SCHEDULE);
    const now = view.latest!;
    assert.equal(now.owner, "owner@example.com");
    assert.equal(now.lane, "upkeep");
    assert.match((await db.getRun(now.id))!.messages[0].text, /^Upkeep cycle, started from Settings: /);
    assert.equal((await cycles()).length, 3);
    // Asked again while it runs, or by the trigger, nothing more starts.
    view = (await (await post("/api/upkeep", {})).json()) as View;
    assert.equal(view.started, "active");
    assert.equal(view.latest!.id, now.id);
    await scheduled(monday + 14 * DAY);
    assert.equal((await cycles()).length, 3);
    view = (await (await mf.dispatchFetch(origin + "/api/upkeep", { headers: user })).json()) as View;
    assert.equal(view.latest!.id, now.id);
    assert.equal(view.schedule, UPKEEP_SCHEDULE);
    // The claim carries each machine's friction totals and versions for the brief.
    const claim = (await (await post("/api/runner/claim", { runnerId: owner, activeRunIds: [], lanes: ["upkeep"] }, { Authorization: `Bearer ${runner}`, "Content-Type": "application/json" })).json()) as { run: Run | null; activity: { host: string; friction?: unknown }[] };
    assert.equal(claim.run?.id, now.id);
    assert.deepEqual(claim.activity.map((a) => [a.host, a.friction]), [["studio", friction]]);
    // Nobody starts an upkeep conversation from the composer, and machine
    // tokens never reach Settings.
    assert.equal((await post("/api/runs", { requestId: randomUUID(), text: "Upkeep", projectId: null, agent: "auto", workIssue: null, lane: "upkeep" })).status, 400);
    assert.equal((await post("/api/upkeep", {}, { Authorization: `Bearer ${runner}`, Origin: origin, "Content-Type": "application/json" })).status, 401);
    assert.equal((await post("/api/upkeep", {}, { Authorization: `Bearer ${collector}`, Origin: origin, "Content-Type": "application/json" })).status, 401);
    assert.equal((await post("/api/upkeep", {}, { Origin: origin, "Content-Type": "application/json" })).status, 401);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("upkeep is claimed only by a runner offering its lane, into its own slot, with a capacity of its own", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-upkeep-lane-")), script = await bundle(dir);
  const mf = await start(await options(script, dir, { ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: "r".repeat(64) }));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const create = (text: string, lane?: "quick" | "upkeep") => db.createRun({ requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null, ...(lane ? { lane } : {}) }, "owner@example.com");
    const cycle = await create("Weekly upkeep", "upkeep");
    const big = await create("Refactor the importer");
    const runner = randomUUID();
    assert.equal((await db.claimRun(runner, [], undefined, "studio"))!.id, big.id, "a runner from before the lane, offering none, takes standard work");
    assert.equal(await db.claimRun(runner, [big.id], ["standard", "quick"], "studio"), null, "upkeep waits for a runner with its slot free");
    assert.equal((await db.claimRun(runner, [big.id], ["upkeep"], "studio"))!.id, cycle.id);
    assert.equal((await db.listRuns()).find((r) => r.id === cycle.id)!.lane, "upkeep");
    assert.equal((await db.latestRun("upkeep"))!.id, cycle.id);
    assert.equal((await db.latestRun("upkeep", true))!.id, cycle.id);
    assert.equal((await db.latestRun("standard"))!.id, big.id);
    // Two active cycles at most: the week's and a follow-up to an earlier one.
    await create("Follow up last week's cycle", "upkeep");
    await assert.rejects(create("One too many", "upkeep"));
    assert.equal((await create("Reply to Rob", "quick")).lane, "quick", "other lanes keep their own bounds");
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cycle is the deployment owner's; without an owner only the local emulator's caller stands in", async () => {
  const created: { owner: string; lane?: string }[] = [];
  const store = {
    runnable: async () => true,
    overview: async () => [closeSnapshot()],
    getRun: async () => null,
    latestRun: async () => null,
    createRun: async (input: { lane?: string }, owner: string) => {
      created.push({ owner, lane: input.lane });
      return { id: "created" } as unknown as Run;
    },
  } as unknown as UpkeepStore;
  const env = { OWNER_EMAIL: "", ALLOWED_EMAILS: "owner@example.com, matt.smith@example.com" } as unknown as Env;
  assert.deepEqual(await startUpkeep(store, env, randomUUID(), "settings", "matt.smith@example.com"), { skipped: "no_owner" });
  assert.deepEqual(await startUpkeep(store, env, randomUUID(), "schedule"), { skipped: "no_owner" });
  assert.deepEqual(await startUpkeep(store, env, randomUUID(), "settings", "local"), { id: "created", started: "started" });
  assert.deepEqual(await startUpkeep(store, { ...env, OWNER_EMAIL: "Owner@Example.com" } as unknown as Env, randomUUID(), "settings", "matt.smith@example.com"), { id: "created", started: "started" });
  assert.deepEqual(created.map((c) => c.owner), ["local", "owner@example.com"]);
  assert.ok(created.every((c) => c.lane === "upkeep"));
});

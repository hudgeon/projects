import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyCounts, frictionSnapshotSchema, weightLine } from "../src/friction-model";
import { collectFriction } from "./friction";
import { frictionDirectory, readReceipts, type Receipt } from "./friction-store";
import { noteRoles, weightFile, weightSource, weightTotals } from "./friction-weight";

const now = Date.parse("2026-10-20T10:00:00.000Z");
const hour = 3600_000;
const receipt = (
  app: Receipt["app"],
  id: string,
  lastAt: number,
  weight: Receipt["weight"],
  more: Partial<Receipt> = {},
): Receipt => ({
  app,
  id,
  file: "/x",
  bytes: 1,
  observedAt: now,
  firstAt: lastAt - 1000,
  lastAt,
  counts: emptyCounts(),
  weight,
  state: {},
  ...more,
});
const w = (start: number, peak: number) => ({ start, peak });
test("a session's source is the runner's role for it, else what its client says", () => {
  const source = (more: Partial<Receipt>) => weightSource(receipt("Claude", "a", now, null, more));
  assert.equal(source({ client: "claude-desktop" }), "desktop");
  assert.equal(source({ client: "Codex Desktop" }), "desktop");
  assert.equal(source({ client: "sdk-cli" }), "cli", "a scripted run nobody's journal names");
  assert.equal(source({}), "cli");
  assert.equal(source({ client: "sdk-cli", role: "helper" }), "helper");
  assert.equal(source({ client: "projects_runner", role: "coordinator" }), "coordinator");
  assert.equal(source({ client: "projects_runner" }), "projects", "the runner's, its role no longer on record");
});
test("weight is the median start and peak of measured sessions by day, app and source, and over seven days", () => {
  const weight = weightTotals(
    [
      receipt("Claude", "a", now - hour, w(80_000, 300_000), { client: "claude-desktop" }),
      receipt("Claude", "b", now - 2 * hour, w(90_000, 100_000), { client: "claude-desktop" }),
      receipt("Claude", "c", now - 3 * hour, w(40_000, 60_000), { client: "sdk-cli", role: "helper" }),
      receipt("Claude", "unmeasured", now - hour, null, { client: "claude-desktop" }),
      receipt("Claude", "uncounted", now - hour, undefined, { client: "claude-desktop" }),
      receipt("Codex", "d", now - 24 * hour, w(20_000, 50_000), { client: "projects_runner", role: "coordinator" }),
      receipt("Codex", "e", now - 8 * 24 * hour, w(10_000, 500_000), { client: "Codex Desktop" }),
      receipt("Codex", "old", now - 20 * 24 * hour, w(1, 1), { client: "Codex Desktop" }),
    ],
    now,
  );
  assert.deepEqual(
    weight.days.map((d) => [d.date, d.app, d.source, d.sessions, d.start, d.peak]),
    [
      ["2026-10-12", "Codex", "desktop", 1, 10_000, 500_000],
      ["2026-10-12", "Codex", "all", 1, 10_000, 500_000],
      ["2026-10-19", "Codex", "coordinator", 1, 20_000, 50_000],
      ["2026-10-19", "Codex", "all", 1, 20_000, 50_000],
      ["2026-10-20", "Claude", "desktop", 2, 85_000, 200_000],
      ["2026-10-20", "Claude", "helper", 1, 40_000, 60_000],
      ["2026-10-20", "Claude", "all", 3, 80_000, 100_000],
    ],
  );
  assert.deepEqual(
    weight.week.map((d) => [d.app, d.source, d.sessions]),
    [
      ["Claude", "desktop", 2],
      ["Claude", "helper", 1],
      ["Claude", "all", 3],
      ["Codex", "coordinator", 1],
      ["Codex", "all", 1],
    ],
    "the session of eight days ago is in its day and not in the seven",
  );
  assert.equal(weightLine(weight.week[0]), "Claude desktop app: start 85k, peak 200k (2 sessions)");
  const friction = { observedAt: now, versions: {}, days: [], weight, state: "ok", message: "" };
  assert.ok(frictionSnapshotSchema.safeParse(friction).success);
  assert.equal(
    frictionSnapshotSchema.safeParse({ ...friction, weight: { ...weight, week: [{ ...weight.week[0], cwd: "/w" }] } }).success,
    false,
    "nothing else rides along",
  );
});
test("a scan measures sessions, keeps the runner's role for one, recounts receipts that predate weight and writes the file the doctor reads", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "home-"));
  const at = new Date(now).toISOString();
  const projects = path.join(home, ".claude/projects/-work-repo");
  await mkdir(projects, { recursive: true });
  const call = (context: number) =>
    JSON.stringify({ type: "assistant", entrypoint: "sdk-cli", timestamp: at, message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: context - 1 } } }) + "\n";
  await writeFile(path.join(projects, "helper-1.jsonl"), call(30_000) + call(70_000));
  await writeFile(path.join(projects, "script-1.jsonl"), call(12_000));
  const runs = path.join(home, ".local/share/project-overview/runner/runs");
  await mkdir(runs, { recursive: true });
  const journal = (children: unknown[]) => writeFile(path.join(runs, "run-1.json"), JSON.stringify({ progress: { children } }));
  await journal([{ id: "child-1", agent: "claude", mode: "change", sessionId: "helper-1", state: "running" }]);
  const dir = frictionDirectory(home);
  // A receipt from before weight was read: counted to the end of its transcript.
  const stale = receipt("Claude", "script-1", now, undefined, { file: path.join(projects, "script-1.jsonl"), bytes: Buffer.byteLength(call(12_000)) });
  delete stale.weight;
  await mkdir(path.join(dir, "claude"), { recursive: true });
  await writeFile(path.join(dir, "claude/script-1.json"), JSON.stringify(stale));
  const first = await collectFriction(home, ["claude"], now);
  assert.deepEqual(
    first.weight?.week.map((d) => [d.source, d.sessions, d.start, d.peak]),
    [["cli", 1, 12_000, 12_000], ["helper", 1, 30_000, 70_000], ["all", 2, 21_000, 41_000]],
  );
  assert.deepEqual(JSON.parse(await readFile(weightFile(dir), "utf8")), { observedAt: now, ...first.weight });
  // The conversation moves on and its journal no longer names the helper.
  await journal([]);
  const second = await collectFriction(home, ["claude"], now + 1000);
  assert.deepEqual(second.weight, first.weight);
  const receipts = await readReceipts(dir);
  assert.equal(receipts.find((r) => r.id === "helper-1")?.role, "helper");
  await noteRoles(dir, home, receipts);
  assert.equal(receipts.find((r) => r.id === "script-1")?.role, undefined);
});

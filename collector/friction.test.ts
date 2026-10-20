import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyCounts, frictionLine, frictionTotals, utcDate } from "../src/friction-model";
import { snapshotSchema } from "../src/model";
import { claudeTranscripts, codexTranscripts, collectFriction, frictionDays, frictionVersions, newer } from "./friction";
import type { Receipt } from "./friction-store";

const now = Date.parse("2026-10-20T10:00:00.000Z");
const receipt = (app: Receipt["app"], id: string, lastAt: number, version: string, counts: Partial<Receipt["counts"]> = {}): Receipt => ({
  app,
  id,
  file: "/x",
  bytes: 1,
  observedAt: now,
  firstAt: lastAt - 1000,
  lastAt,
  version,
  counts: { ...emptyCounts(), ...counts },
  state: {},
});
test("days add each app's sessions by the UTC day they were last active, within fourteen days", () => {
  const days = frictionDays(
    [
      receipt("Claude", "a", now - 3600_000, "2.1.299", { prompts: 2, commandFailed: 1 }),
      receipt("Claude", "b", now - 7200_000, "2.1.295", { prompts: 1, apiErrors: 3 }),
      receipt("Codex", "c", now - 86400_000, "0.162.1", { toolCalls: 5 }),
      receipt("Codex", "d", now - 20 * 86400_000, "0.150.0", { toolCalls: 9 }),
      { ...receipt("Codex", "e", now, "0.162.1"), lastAt: null },
    ],
    now,
  );
  assert.deepEqual(
    days.map((d) => [d.date, d.app, d.sessions, d.counts.prompts, d.counts.commandFailed, d.counts.apiErrors, d.counts.toolCalls]),
    [
      ["2026-10-19", "Codex", 1, 0, 0, 0, 5],
      ["2026-10-20", "Claude", 2, 3, 1, 3, 0],
    ],
  );
  const total = frictionTotals(days, utcDate(now - 6 * 86400_000));
  assert.equal(total.sessions, 3);
  assert.equal(frictionLine(total.counts, total.sessions), "3 sessions, 3 prompts, 5 tool calls: 1 failed commands, 3 API errors");
  assert.equal(frictionLine(emptyCounts(), 0), "0 sessions, 0 prompts, 0 tool calls: no friction seen");
});
test("versions come from each app's newest session, and Codex's own release check", () => {
  assert.deepEqual(
    frictionVersions(
      [
        receipt("Claude", "a", now - 3600_000, "2.1.299"),
        receipt("Claude", "b", now - 7200_000, "2.1.295"),
        receipt("Codex", "c", now, "0.162.1"),
      ],
      "0.163.0",
    ),
    { claude: "2.1.299", codex: "0.162.1", codexLatest: "0.163.0" },
  );
  assert.deepEqual(frictionVersions([], { not: "a string" }), {});
  assert.deepEqual(
    frictionVersions([receipt("Codex", "c", now, "0.162.1")], "0.154.0"),
    { codex: "0.162.1" },
    "a release check older than the install is not an update",
  );
  assert.equal(newer("0.163.0", "0.162.1"), true);
  assert.equal(newer("2.1.300", "2.1.299"), true);
  assert.equal(newer("0.162.1", "0.162.1"), false);
});
test("a snapshot carries friction totals and nothing else from the receipts", () => {
  const friction = {
    observedAt: now,
    versions: { claude: "2.1.299" },
    days: [{ date: "2026-10-20", app: "Claude", sessions: 1, counts: emptyCounts() }],
    state: "ok",
    message: "Receipts for 1 sessions.",
  };
  const base = { version: 1, host: "laptop", collectedAt: now, projects: [], unassignedSessions: [] };
  assert.ok(snapshotSchema.safeParse({ ...base, friction }).success);
  assert.ok(snapshotSchema.safeParse(base).success, "older collectors send none");
  assert.equal(snapshotSchema.safeParse({ ...base, friction: { ...friction, receipts: [] } }).success, false);
  assert.equal(snapshotSchema.safeParse({ ...base, friction: { ...friction, versions: { claude: "2.1.299 (dirty)" } } }).success, false);
});
test("transcripts are found where each app keeps them, and a machine without either is unavailable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "home-"));
  const claude = path.join(home, ".claude/projects/-work-repo");
  await mkdir(path.join(claude, "11111111-1111-4111-8111-111111111111"), { recursive: true });
  await writeFile(path.join(claude, "11111111-1111-4111-8111-111111111111.jsonl"), JSON.stringify({ type: "user", message: { content: "hi" }, timestamp: new Date(now).toISOString(), version: "2.1.299" }) + "\n");
  await writeFile(path.join(claude, "11111111-1111-4111-8111-111111111111", "notes.jsonl"), "{}\n");
  const day = path.join(home, ".codex/sessions/2026/10/20");
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, "rollout-2026-10-20T01-00-00-22222222-2222-4222-8222-222222222222.jsonl"), JSON.stringify({ type: "session_meta", timestamp: new Date(now).toISOString(), payload: { cli_version: "0.162.1", cwd: "/w" } }) + "\n");
  await mkdir(path.join(home, ".codex/sessions/2025/01/01"), { recursive: true });
  await writeFile(path.join(home, ".codex/sessions/2025/01/01/rollout-old-33333333-3333-4333-8333-333333333333.jsonl"), "{}\n");
  assert.deepEqual((await claudeTranscripts(home)).map((t) => t.id), ["11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual((await codexTranscripts(home, now)).map((t) => t.id), ["22222222-2222-4222-8222-222222222222"]);
  const friction = await collectFriction(home, ["codex", "claude"], now);
  assert.equal(friction.state, "ok");
  assert.deepEqual(friction.versions, { claude: "2.1.299", codex: "0.162.1" });
  assert.deepEqual(friction.days.map((d) => [d.app, d.sessions, d.counts.prompts]), [["Claude", 1, 1], ["Codex", 1, 0]]);
  assert.match(friction.message, /^Receipts for 2 sessions \(1 Claude, 1 Codex\); 2 updated this scan\.$/);
  const none = await collectFriction(await mkdtemp(path.join(tmpdir(), "empty-")), ["claude"], now);
  assert.equal(none.state, "unavailable");
});

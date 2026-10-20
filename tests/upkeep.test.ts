import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { UPKEEP_CRON, UPKEEP_SCHEDULE, upkeepRequestId, upkeepText, upkeepWeek } from "../src/upkeep-model";

test("a moment's upkeep week is its ISO week, in UTC", () => {
  assert.equal(upkeepWeek(Date.UTC(2026, 9, 19)), "2026-W43");
  assert.equal(upkeepWeek(Date.UTC(2026, 9, 25, 23, 59)), "2026-W43");
  assert.equal(upkeepWeek(Date.UTC(2026, 9, 26)), "2026-W44");
  assert.equal(upkeepWeek(Date.UTC(2027, 0, 1)), "2026-W53");
  assert.equal(upkeepWeek(Date.UTC(2024, 11, 30)), "2025-W01");
  assert.equal(upkeepWeek(Date.UTC(2021, 0, 3)), "2020-W53");
});

test("the week's conversation id is one UUID per portfolio and week", async () => {
  const id = await upkeepRequestId("example", "2026-W43");
  assert.ok(z.uuid().safeParse(id).success, id);
  assert.equal(id, await upkeepRequestId("example", "2026-W43"));
  assert.notEqual(id, await upkeepRequestId("example", "2026-W44"));
  assert.notEqual(id, await upkeepRequestId("other", "2026-W43"));
});

test("the Worker's cron and the local emulator's run the schedule the model names", async () => {
  for (const file of ["wrangler.jsonc", "wrangler.local.jsonc"]) {
    const crons = /"crons":\s*\[([^\]]*)\]/.exec(await readFile(file, "utf8"))?.[1] ?? "";
    assert.deepEqual(crons.match(/"[^"]+"/g)?.map((s) => JSON.parse(s)), [UPKEEP_CRON], file);
  }
  assert.equal(UPKEEP_CRON, "0 6 * * 1");
  assert.equal(UPKEEP_SCHEDULE, "Mondays at 06:00 UTC");
  assert.match(upkeepText("schedule"), /^Weekly upkeep cycle: read the friction totals/);
  assert.match(upkeepText("settings"), /^Upkeep cycle, started from Settings: /);
  assert.match(upkeepText("settings"), /"no change needed" is a complete result/);
});

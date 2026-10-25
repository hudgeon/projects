import { test } from "node:test";
import assert from "node:assert/strict";
import { upkeepScheduleProblem } from "./upkeep-model";
const friday = Date.UTC(2026, 9, 30, 18);
test("upkeep distinguishes unverified, missed, skipped and recorded scheduled checks", () => {
  assert.match(upkeepScheduleProblem(null, friday)!, /not verified/);
  const receipt = {scheduledAt: friday, observedAt: friday, outcome: "started" as const};
  assert.equal(upkeepScheduleProblem(receipt, friday + 6 * 86400000), null);
  assert.match(upkeepScheduleProblem(receipt, friday + 7 * 86400000 + 11 * 60000)!, /not been recorded/);
  assert.match(upkeepScheduleProblem({...receipt, outcome: "no_machine"}, friday)!, /no connected machine/);
  assert.equal(upkeepScheduleProblem({...receipt, outcome: "exists"}, friday), null);
});

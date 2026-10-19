import { test } from "node:test";
import assert from "node:assert/strict";
import { sendBatches } from "./project-judge";

test("batches cover every rank once; interleaved batches each span the retrieval order", () => {
  for (const n of [1, 7, 8, 9, 10, 27, 38, 40])
    for (const order of [undefined, "retrieval", "interleaved", "reversed", "shuffled"] as const) {
      const groups = sendBatches(n, order, "seed", 8);
      assert.deepEqual(groups.flat().toSorted((a, b) => a - b), Array.from({ length: n }, (_, i) => i), `${order} ${n}`);
      assert.equal(groups.length, Math.ceil(n / 8));
      assert.ok(groups.every((g) => g.length <= 8 && g.length > 0));
    }
  assert.deepEqual(sendBatches(10, "interleaved", "seed", 8), [[0, 2, 4, 6, 8], [1, 3, 5, 7, 9]]);
  assert.deepEqual(sendBatches(9, "reversed", "seed", 4), [[8, 7, 6, 5], [4, 3, 2, 1], [0]]);
  assert.deepEqual(sendBatches(9, undefined, "seed", 4), [[0, 1, 2, 3], [4, 5, 6, 7], [8]]);
  assert.deepEqual(sendBatches(20, "shuffled", "0abc1234", 8), sendBatches(20, "shuffled", "0abc1234", 8), "the same shuffle for the same seed");
  assert.notDeepEqual(sendBatches(20, "shuffled", "0abc1234", 8), sendBatches(20, "shuffled", "ff00ff00", 8));
});

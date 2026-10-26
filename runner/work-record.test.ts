import { test } from "node:test";
import assert from "node:assert/strict";
import { workRecordGate } from "./work-record";
import { recordHash, verifiedRecord } from "../collector/work-record";
import { complete } from "./run-fixtures";
const body = (cutoff: string, position = "Accepted") =>
  `## Current position\nStatus: needs verification. Reviewed: 2026-10-26.\nEvidence checked: ${cutoff}\nOutcome / why now: Finish the pilot.\nPosition: ${position}\nNext: Review acceptance.\n`;
test("independent readback rejects unchanged, stale, wrong-issue and unavailable records", async () => {
  const old = body("2026-10-25T00:00:00.000Z", "Draft");
  let current = old;
  const read = async (_repo: string, number: number) => ({
    number,
    body: current,
    url: `https://github.com/acme/work/issues/${number}`,
  });
  const gate = await workRecordGate("acme/work", 7, read);
  const updated = {
    ...complete,
    workRecord: {
      status: "updated" as const,
      evidence: "https://github.com/acme/work/issues/7",
    },
  };
  assert.match((await gate(updated))!, /no verified fresh/);
  current = body(new Date().toISOString());
  assert.equal(await gate(updated), null);
  assert.match(
    (await gate({
      ...updated,
      workRecord: {
        ...updated.workRecord,
        evidence: "https://github.com/other/work/issues/7",
      },
    }))!,
    /exact canonical/,
  );
  assert.match(
    (await gate({
      ...updated,
      workRecord: { ...updated.workRecord, issues: [8] },
    }))!,
    /linked issue/,
  );
  const unreadable = await workRecordGate("acme/work", 7, async () => {
    throw Error("offline");
  });
  assert.match((await unreadable(updated))!, /original work record/);
  assert.equal(
    await unreadable({
      ...complete,
      workRecord: {
        status: "unchanged",
        evidence: "Read-only question; no facts changed",
      },
    }),
    null,
  );
  assert.match(
    (await gate(
      {
        ...complete,
        workRecord: { status: "unchanged", evidence: "No change" },
      },
      true,
    ))!,
    /linked change turn/,
  );
  assert.equal(verifiedRecord(old, Date.now()), false);
  assert.equal(verifiedRecord(current, Date.now(), recordHash(current)), false);
});
test("saved baseline survives a checkpoint and explicit issue lists verify every update", async () => {
  let current = body("2026-10-25T00:00:00.000Z", "Draft");
  const read = async (_repo: string, number: number) => ({
    number,
    body: current,
    url: `https://github.com/acme/work/issues/${number}`,
  });
  const first = await workRecordGate("acme/work", 7, read);
  current = body(new Date().toISOString());
  const resumed = await workRecordGate("acme/work", 7, read, first.baseline);
  assert.equal(
    await resumed({
      ...complete,
      workRecord: {
        status: "updated",
        evidence: "Reconciled incoming and sent mail; read back both records",
        issues: [7, 8],
      },
    }),
    null,
  );
});

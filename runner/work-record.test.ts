import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { workRecordGate } from "./work-record";
import {
  recordHash,
  replaceWorkPosition,
  verifiedRecord,
  writeWorkPosition,
} from "../collector/work-record";
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
  current = body(new Date().toISOString(), "x".repeat(2001));
  assert.match((await gate(updated))!, /at most 2000 characters/);
  current = body(new Date().toISOString()).repeat(2);
  assert.match((await gate(updated))!, /exactly one Current position/);
  current = body(new Date().toISOString());
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

test("replacement preserves other sections and rejects stale reads before writing", async () => {
  const tail =
    "\n## Outcome\nThe original scope.\n\n## Email threads\nOriginal reviewed ID.\n";
  const stamp = "2026-10-26T00:00:00.000Z";
  const old = body(stamp, "x".repeat(3000)) + tail;
  const template = body(stamp).split("\n").slice(1).join("\n").trim();
  const position = template.replace(
    "Accepted",
    "x".repeat(2000 - template.length + "Accepted".length),
  );
  assert.equal(position.length, 2000);
  assert.throws(() => replaceWorkPosition(old, position + "x"), /at most 2000/);
  assert.throws(
    () => replaceWorkPosition(old, position + "\n## Outcome\nOther"),
    /only the text/,
  );

  for (const boundary of ["# Scope", "##\tScope", "Scope\n-----"]) {
    assert.throws(
      () =>
        replaceWorkPosition(
          body(stamp) + "\n" + boundary + "\nPreserve me.",
          position,
        ),
      /Normalize the next section/,
    );
  }
  assert.throws(
    () =>
      replaceWorkPosition(
        body(stamp) + "\n```text\n## Scope\nPreserve me.",
        position,
      ),
    /ambiguous Markdown headings/,
  );
  let actual = old;
  let writes = 0;
  const url = "https://github.com/acme/work/issues/7";
  const read = async () => ({ number: 7, body: actual, url });
  const write = async (_repo: string, _issue: number, changed: string) => {
    writes++;
    actual = changed;
  };
  await assert.rejects(
    writeWorkPosition("acme/work", 7, "stale", position, read, write),
    /changed/,
  );
  assert.equal(writes, 0);
  const expected = createHash("sha256").update(old).digest("hex");
  assert.equal(
    await writeWorkPosition("acme/work", 7, expected, position, read, write),
    url,
  );
  assert.equal(actual, "## Current position\n" + position + "\n" + tail);
  assert.equal(writes, 1);
  await assert.rejects(
    writeWorkPosition(
      "acme/work",
      7,
      createHash("sha256").update(actual).digest("hex"),
      template,
      read,
      async () => {
        actual += "Concurrent edit";
      },
    ),
    /Readback differs/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyCounts, type FrictionCounts } from "../src/friction-model";
import {
  pruneReceipts,
  readLines,
  readReceipts,
  receiptFile,
  savePrivate,
  scanTranscripts,
  type Parser,
  type Receipt,
} from "./friction-store";

// Counts records; the state carries the last value seen between scans.
const parser: Parser<{ last: number | null }> = {
  app: "Claude",
  empty: () => ({ last: null }),
  record: (record, counts, state) => {
    counts.toolCalls += 1;
    state.last = (record as { n: number }).n;
  },
  facts: () => ({ cwd: "/w", version: "1.0.0", client: "cli", firstAt: 1, lastAt: 2 }),
};
const line = (n: number) => JSON.stringify({ n }) + "\n";
const setup = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friction-"));
  const file = path.join(dir, "aaaa-1.jsonl");
  return { dir: path.join(dir, "receipts"), file, transcripts: [{ id: "aaaa-1", file }] };
};
test("only complete lines are read, and the next read starts after the last line end", async () => {
  const { file } = await setup();
  await writeFile(file, line(1) + line(2) + '{"n":3');
  const read = await readLines(file, 0, 1 << 20);
  assert.equal(read.reset, false);
  if (!read.reset) {
    assert.deepEqual(read.lines, [line(1).trim(), line(2).trim()]);
    assert.equal(read.next, (line(1) + line(2)).length);
  }
});
test("receipts follow a transcript's appended bytes and restart when it shrinks", async () => {
  const { dir, file, transcripts } = await setup();
  const now = Date.now();
  await writeFile(file, line(1) + line(2) + '{"n":3');
  const receipts = new Map<string, Receipt>();
  assert.deepEqual(await scanTranscripts(dir, parser, transcripts, receipts, now), { updated: 1, waiting: 0, failed: 0 });
  let receipt = receipts.get("Claude:aaaa-1")!;
  assert.equal(receipt.counts.toolCalls, 2);
  assert.equal(receipt.cwd, "/w");
  // Nothing new: the file is as long as the receipt counted... except the partial line.
  await appendFile(file, '}\n' + line(4));
  assert.deepEqual(await scanTranscripts(dir, parser, transcripts, receipts, now + 1), { updated: 1, waiting: 0, failed: 0 });
  receipt = receipts.get("Claude:aaaa-1")!;
  assert.equal(receipt.counts.toolCalls, 4, "the partial line is counted once, when complete");
  assert.deepEqual(receipt.state, { last: 4 });
  assert.deepEqual(await scanTranscripts(dir, parser, transcripts, receipts, now + 2), { updated: 0, waiting: 0, failed: 0 });
  await truncate(file, line(1).length);
  await scanTranscripts(dir, parser, transcripts, receipts, now + 3);
  assert.equal(receipts.get("Claude:aaaa-1")!.counts.toolCalls, 1, "a rewritten transcript is counted afresh");
  const saved = await readReceipts(dir);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].bytes, line(1).length);
});
test("the scan keeps within its budgets, skips old unseen transcripts and bad ids", async () => {
  const { dir, file, transcripts } = await setup();
  const now = Date.now();
  const other = path.join(path.dirname(file), "bbbb-2.jsonl");
  const old = path.join(path.dirname(file), "cccc-3.jsonl");
  await writeFile(file, line(1));
  await writeFile(other, line(1));
  await writeFile(old, line(1));
  const past = (now - 100 * 86400_000) / 1000;
  await utimes(old, past, past);
  const receipts = new Map<string, Receipt>();
  const result = await scanTranscripts(
    dir,
    parser,
    [
      ...transcripts,
      { id: "bbbb-2", file: other },
      { id: "cccc-3", file: old },
      { id: "../escape", file: other },
      { id: "dddd-4", file: path.join(path.dirname(file), "missing.jsonl") },
    ],
    receipts,
    now,
    { bytes: 1 << 20, files: 1 },
  );
  assert.deepEqual(result, { updated: 1, waiting: 1, failed: 1 });
  assert.equal(receipts.size, 1);
  assert.deepEqual(await readdir(path.join(dir, "claude")), [`${receipts.values().next().value!.id}.json`]);
});
test("a receipt path is never built from an id that could leave the directory", () => {
  assert.equal(receiptFile("/r", "Claude", "abc-123"), "/r/claude/abc-123.json");
  for (const id of ["../escape", "a/b", "", "x".repeat(81), "a b"])
    assert.throws(() => receiptFile("/r", "Codex", id), /Invalid receipt id/);
});
test("receipts of sessions idle past the retention are removed; damaged files are skipped", async () => {
  const { dir } = await setup();
  const now = Date.now();
  const receipt = (id: string, lastAt: number): Receipt => ({
    app: "Codex",
    id,
    file: "/x",
    bytes: 0,
    observedAt: now,
    firstAt: lastAt,
    lastAt,
    counts: emptyCounts() as FrictionCounts,
    state: {},
  });
  await savePrivate(receiptFile(dir, "Codex", "new"), receipt("new", now - 86400_000));
  await savePrivate(receiptFile(dir, "Codex", "old"), receipt("old", now - 95 * 86400_000));
  await writeFile(receiptFile(dir, "Codex", "bad"), "{not json");
  const read = await readReceipts(dir);
  assert.deepEqual(read.map((r) => r.id).sort(), ["new", "old"]);
  const kept = await pruneReceipts(dir, read, now);
  assert.deepEqual(kept.map((r) => r.id), ["new"]);
  assert.deepEqual((await readdir(path.join(dir, "codex"))).sort(), ["bad.json", "new.json"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JEV_MODEL } from "./context";
import { BATCH, reviewProjectContext } from "./project-context";
import { fixture } from "./run-fixtures";
import { git } from "./workspaces";

// A small project whose notes split into twenty sections over four files
// (no source supplies more than eight units), so a review shortlists many.
async function project() {
  const dir = await fixture();
  await writeFile(path.join(dir, "AGENTS.md"), "Draft only; publishing requires approval.\n");
  for (const file of [0, 1, 2, 3])
    await writeFile(
      path.join(dir, `notes-${file}.md`),
      Array.from({ length: 5 }, (_, i) => `# Importer section ${file}.${i}\n\nThe importer delimiter note ${file}.${i} covers the pipe fixture. ${"Each section is long enough to stay a unit of its own. ".repeat(4)}\n`).join("\n"),
    );
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "."]);
  await git(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "Fixture"]);
  return dir;
}
// Jev stands in: each candidate is rated by the slot it was sent in, within
// its request; the fail-th request, if any, times out.
function bySlot(sent: unknown[][], fail?: number) {
  return {
    mode: "select" as const,
    key: async () => "fixture-key",
    fetch: async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      sent.push(body.state.candidates);
      if (sent.length === fail) throw new DOMException("slow", "TimeoutError");
      return Response.json({
        model: JEV_MODEL,
        answers: Object.fromEntries(Object.keys(body.questions).map((k, j) => [k, { type: "noul", noul: j / 100 }])),
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    },
  };
}

test("a replay can send the shortlist reversed or shuffled; receipts and ratings stay in retrieval order", async () => {
  const dir = await project();
  try {
    // One request holds the whole shortlist here, so a rating is the slot in it.
    const review = (order?: "reversed" | "shuffled") => {
      const sent: unknown[][] = [];
      return reviewProjectContext({
        project: { id: "fixture", name: "Fixture", cwd: dir, plan: null },
        task: "Fix the importer delimiter",
        instructions: ["Fix the importer delimiter"],
        signal: new AbortController().signal,
        selector: bySlot(sent),
        order,
        batch: 40,
      }).then((view) => ({ ...view, sent }));
    };
    const normal = await review();
    const n = normal.receipt.considered.length;
    assert.ok(n >= 10, "the fixture shortlists many units");
    assert.equal(normal.receipt.order, undefined);
    assert.equal(normal.sent.length, 1);
    assert.deepEqual(normal.sent[0].map((c: any) => c.section), normal.receipt.considered.map((u) => u.section));
    assert.deepEqual(Array.from({ length: n }, (_, i) => normal.record!.probabilities[`keep_${i}`]), Array.from({ length: n }, (_, i) => i / 100));

    const reversed = await review("reversed");
    assert.equal(reversed.receipt.order, "reversed");
    assert.deepEqual(reversed.receipt.considered.map((u) => u.section), normal.receipt.considered.map((u) => u.section), "the receipt keeps retrieval order");
    assert.deepEqual(reversed.sent[0].map((c: any) => c.section), normal.receipt.considered.map((u) => u.section).reverse(), "candidates went out reversed");
    assert.deepEqual(Array.from({ length: n }, (_, i) => reversed.record!.probabilities[`keep_${i}`]), Array.from({ length: n }, (_, i) => (n - 1 - i) / 100), "each unit's rating is the slot it was sent in");
    assert.notEqual(reversed.receipt.version, normal.receipt.version, "a cached rating is never reused across orders");

    const shuffled = await review("shuffled");
    const again = await review("shuffled");
    const slots = Array.from({ length: n }, (_, i) => Math.round(shuffled.record!.probabilities[`keep_${i}`] * 100));
    assert.deepEqual(slots.toSorted((a, b) => a - b), Array.from({ length: n }, (_, i) => i), "a permutation of the slots");
    assert.notDeepEqual(slots, Array.from({ length: n }, (_, i) => i));
    assert.deepEqual(again.record!.probabilities, shuffled.record!.probabilities, "the same shuffle every time");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the shortlist is judged a few candidates per request, in parallel, with ratings keyed by retrieval rank; a failed batch fails the review", async () => {
  const dir = await project();
  try {
    const review = (o: { batch?: number; fail?: number; cached?: unknown }) => {
      const sent: unknown[][] = [];
      return reviewProjectContext({
        project: { id: "fixture", name: "Fixture", cwd: dir, plan: null },
        task: "Fix the importer delimiter",
        instructions: ["Fix the importer delimiter"],
        signal: new AbortController().signal,
        selector: bySlot(sent, o.fail),
        batch: o.batch,
        cached: o.cached,
      }).then((view) => ({ ...view, sent }));
    };
    const whole = await review({});
    assert.equal(whole.receipt.batch, BATCH);
    assert.equal(whole.sent.length, 1, "one request holds the whole shortlist");
    assert.equal(whole.record!.batches, 1);
    const batched = await review({ batch: 8 });
    const n = batched.receipt.considered.length;
    assert.equal(batched.receipt.batch, 8);
    assert.equal(batched.sent.length, Math.ceil(n / 8), "as many requests as batches of eight");
    assert.ok(batched.sent.every((candidates) => candidates.length <= 8));
    assert.deepEqual(batched.sent.flat().map((c: any) => c.section), batched.receipt.considered.map((u) => u.section), "retrieval order across the batches");
    assert.equal(batched.record!.batches, batched.sent.length);
    assert.equal(batched.record!.inputTokens, 100 * batched.sent.length, "tokens are summed over the batches");
    for (let i = 0; i < n; i++) assert.equal(batched.record!.probabilities[`keep_${i}`], (i % 8) / 100, `unit ${i} rated by its slot within its batch`);
    assert.notEqual(batched.receipt.version, whole.receipt.version, "a cached rating is never reused across batch sizes");
    assert.equal(batched.receipt.reason, "selected");
    assert.equal(batched.record!.version, batched.receipt.version);

    const reused = await review({ batch: 8, cached: batched.record });
    assert.equal(reused.sent.length, 0, "an unchanged shortlist reuses the whole judgment");
    assert.equal(reused.receipt.cached, true);

    const single = await review({ batch: 1 });
    assert.equal(single.sent.length, n);
    assert.ok(Object.values(single.record!.probabilities).every((p) => p === 0));

    const failed = await review({ batch: 8, fail: 2 });
    assert.equal(failed.record, undefined, "a partial judgment never passes for a whole one");
    assert.equal(failed.receipt.reason, "service_failed");
    assert.equal(failed.receipt.failure!.kind, "timeout");
    assert.equal(failed.receipt.strategy, "baseline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

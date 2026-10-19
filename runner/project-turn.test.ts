import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { savePrivate } from "./engine";
import { contextBrief, REVIEW_DAYS, REVIEWS, reviewsDir, usage } from "./project-turn";
import { fixture, selector } from "../tests/project-fixtures";

test("a turn's usage keeps project-relative paths and line ranges and only counts other files", () => {
  const used = usage(["/real/project", "/link/project"]);
  used.add({ path: "/real/project/src/a.ts", lines: [10, 20] });
  used.add({ path: "/link/project/src/a.ts", lines: [21, 30] });
  used.add({ path: "/real/project/src/a.ts", lines: [50, 60] });
  used.add({ path: "/real/project/README.md" });
  used.add({ path: "/real/project/README.md", lines: [1, 5] });
  used.add({ path: "/real/project/src/b.ts", change: true });
  used.add({ path: "/real/projector/x.ts" });
  used.add({ path: "/home/notes.md", lines: [1, 2] });
  used.add({ path: "/real/project" });
  const summary = used.summary();
  assert.deepEqual(summary.files, [
    { path: "src/a.ts", read: true, lines: [[10, 30], [50, 60]] },
    { path: "README.md", read: true },
    { path: "src/b.ts", changed: true },
  ]);
  assert.equal(summary.outside, 3);
  assert.equal(summary.more, 0);
});

test("every review is receipted with its inputs, within a bounded history", async () => {
  const { cwd, options } = await fixture();
  const stateDir = path.join(cwd, ".state"),
    dir = reviewsDir(stateDir),
    now = Date.now();
  try {
    await mkdir(dir, { recursive: true });
    // A full history and one review past the age limit.
    const old = `${now - (REVIEW_DAYS + 1) * 86_400_000}-aaaaaaaa-master.json`;
    await writeFile(path.join(dir, old), "{}");
    for (let i = 0; i < REVIEWS; i++)
      await writeFile(path.join(dir, `${now - 86_400_000 + i}-bbbbbbbb-master.json`), "{}");
    await writeFile(path.join(dir, "notes.txt"), "kept");
    const brief = await contextBrief(
      {
        stateDir,
        run: { id: "cccccccc-0000-4000-8000-000000000000", generation: 1 },
        host: "test",
        selector: selector().value,
        signal: options.signal,
        instructions: options.instructions,
        save: savePrivate,
      },
      options.project,
      cwd,
      options.task,
      "dddddddd-0000-4000-8000-000000000000",
      "claude",
    );
    const names = (await readdir(dir)).sort();
    assert.equal(names.filter((n) => n.endsWith(".json")).length, REVIEWS);
    assert.ok(!names.includes(old), "a review past the age limit is removed");
    assert.ok(!names.includes(`${now - 86_400_000}-bbbbbbbb-master.json`), "the oldest beyond the limit goes");
    assert.ok(names.includes(`${now - 86_400_000 + 1}-bbbbbbbb-master.json`));
    assert.ok(names.includes("notes.txt"), "only review receipts are pruned");
    const name = names.find((n) => n.endsWith("-cccccccc-dddddddd.json"))!;
    assert.match(brief.prompt, new RegExp(`Private project context receipt: .*${name}`));
    brief.onFile({ path: path.join(cwd, "src/invoices.ts"), lines: [1, 1] });
    await brief.remember("session");
    const receipt = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    assert.equal(receipt.id, name.slice(0, -5));
    assert.equal(receipt.actor, "dddddddd-0000-4000-8000-000000000000");
    assert.deepEqual(receipt.input, {
      plan: "PLAN.md",
      cwd,
      root: receipt.input.root,
      task: options.task,
      instructions: options.instructions,
    });
    assert.equal(receipt.supplied.length, receipt.selected);
    assert.deepEqual(receipt.usage.files, [{ path: "src/invoices.ts", read: true, lines: [[1, 1]] }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

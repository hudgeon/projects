import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { savePrivate } from "./engine";
import { contextBrief, REVIEW_DAYS, REVIEWS, reviewsDir, usage } from "./project-turn";
import { reviewProjectContext } from "./project-context";
import { sessionMemory } from "./session-memory";
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

test("instruction files the turn's app loads itself are named, never sent; others reach a native session once", async () => {
  const { cwd, options } = await fixture();
  const elsewhere = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const stateDir = path.join(cwd, ".state");
  const brief = (native: string, session?: string) =>
    contextBrief(
      { stateDir, run: { id: "cccccccc-0000-4000-8000-000000000000", generation: 1 }, host: "test", selector: selector().value, signal: options.signal, instructions: options.instructions, native, save: savePrivate },
      options.project, cwd, options.task, "master", "codex", session,
    );
  try {
    await writeFile(path.join(cwd, "src/AGENTS.md"), "Never change the account boundary in this directory.\n");
    // A helper works in the project: its app loads the root file, not the nested one.
    const helper = await reviewProjectContext({ ...options, selector: selector().value, native: cwd });
    // Should an app stop loading it, the agent is still told which file to read.
    assert.match(helper.prompt, /Repository instructions your app has loaded itself, not repeated here: AGENTS\.md\. Read any of them you do not hold before you act\./);
    assert.doesNotMatch(helper.prompt, /Drafting only/);
    assert.match(helper.prompt, /Never change the account boundary/, "an app does not load a nested file at its start");
    assert.deepEqual(helper.sent, { "src/AGENTS.md": helper.receipt.sources.find((s) => s.path === "src/AGENTS.md")!.hash });
    assert.equal(helper.receipt.sources.find((s) => s.path === "AGENTS.md")!.status, "read", "loaded, not a gap");
    // A coordinator elsewhere is sent both once in its session, then only what changes.
    const first = await brief(elsewhere, "session-1");
    assert.match(first.prompt, /Drafting only[\s\S]*Never change the account boundary/);
    await first.remember("session-1");
    await writeFile(path.join(cwd, "src/invoices.ts"), 'export const delimiter = ";"; // Invoice format, semicolons now\n');
    const second = await brief(elsewhere, "session-1");
    assert.match(second.prompt, /semicolons now/, "a changed view is sent");
    assert.match(second.prompt, /Repository instructions sent earlier in this session, unchanged since: AGENTS\.md, src\/AGENTS\.md\./);
    assert.doesNotMatch(second.prompt, /Drafting only|Never change the account boundary/);
    await second.remember("session-1");
    await writeFile(path.join(cwd, "AGENTS.md"), "Drafting only. Publishing now needs two approvals.\n");
    const third = await brief(elsewhere, "session-1");
    assert.match(third.prompt, /Publishing now needs two approvals/, "an instruction file that changed is sent again");
    assert.match(third.prompt, /unchanged since: src\/AGENTS\.md\./);
    assert.match((await brief(elsewhere, "session-2")).prompt, /two approvals[\s\S]*Never change the account boundary/, "another session starts with both");
    // A session that compacted its history is sent the view and the files again.
    await third.remember("session-1");
    const memory = sessionMemory(stateDir, "cccccccc-0000-4000-8000-000000000000");
    const turn = (session: string) => contextBrief(
      { stateDir, run: { id: "cccccccc-0000-4000-8000-000000000000", generation: 1 }, host: "test", selector: selector().value, signal: options.signal, instructions: options.instructions, native: elsewhere, memory, save: savePrivate },
      options.project, cwd, options.task, "master", "codex", session,
    );
    const compacting = await turn("session-1");
    assert.match(compacting.prompt, /Project context is unchanged from the view already supplied/);
    await memory.forget("session-1");
    await compacting.remember("session-1");
    assert.match((await turn("session-1")).prompt, /two approvals[\s\S]*Never change the account boundary/, "what the compacting turn held does not count");
    // A file too long to send is a gap only for an app that does not load it.
    await writeFile(path.join(cwd, "AGENTS.md"), "Long standing rules. ".repeat(1_250));
    const long = await reviewProjectContext({ ...options, selector: selector().value, native: cwd });
    assert.match(long.prompt, /loaded itself, not repeated here: AGENTS\.md/);
    assert.doesNotMatch(long.prompt, /read_required/);
    assert.match((await reviewProjectContext({ ...options, selector: selector().value, native: elsewhere })).prompt, /"path":"AGENTS\.md"[^}]*"status":"read_required"/);
  } finally {
    await Promise.all([rm(cwd, { recursive: true, force: true }), rm(elsewhere, { recursive: true, force: true })]);
  }
});

test("shadow mode receipts its review and leaves the turn's prompt as it is with selection off", async () => {
  const { cwd, options } = await fixture();
  const stateDir = path.join(cwd, ".state");
  try {
    const brief = await contextBrief(
      { stateDir, run: { id: "cccccccc-0000-4000-8000-000000000000", generation: 1 }, host: "test", selector: { ...selector().value, mode: "shadow" }, signal: options.signal, instructions: options.instructions, save: savePrivate },
      options.project, cwd, options.task, "master", "codex", "session-1",
    );
    assert.equal(brief.prompt, "");
    brief.onFile({ path: path.join(cwd, "src/invoices.ts") });
    await brief.remember("session-1");
    const [name] = (await readdir(reviewsDir(stateDir))).filter((n) => n.endsWith(".json"));
    const receipt = JSON.parse(await readFile(path.join(reviewsDir(stateDir), name), "utf8"));
    assert.equal(receipt.strategy, "shadow");
    assert.ok(receipt.record && receipt.considered.length, "Jev's ranking is kept to compare with what the turn went on to read");
    assert.deepEqual(receipt.supplied, []);
    assert.deepEqual(receipt.usage.files, [{ path: "src/invoices.ts", read: true }]);
    assert.deepEqual(await readdir(path.join(stateDir, "runs")).catch(() => []), [], "no view was given to remember");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

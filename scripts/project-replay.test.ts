import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../runner/workspaces";
import { reviewsDir } from "../runner/project-turn";
import { fixture, selector } from "../tests/project-fixtures";
import { evaluationDir, replayReview, storedReviews, type Review } from "./project-replay";

test("a replay reviews the recorded commit in a shared clone and leaves the project's checkout as it was", async () => {
  const { cwd, options } = await fixture();
  try {
    const recorded = await git(cwd, ["rev-parse", "HEAD"]);
    await writeFile(path.join(cwd, "src/invoices.ts"), 'export const delimiter = ";"; // Invoice format, semicolons now\n');
    await git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-am", "Later work"]);
    await writeFile(path.join(cwd, "README.md"), "Uncommitted notes about invoices.\n");
    const before = {
      head: await git(cwd, ["rev-parse", "HEAD"]),
      status: await git(cwd, ["status", "--porcelain"]),
      worktrees: await git(cwd, ["worktree", "list", "--porcelain"]),
    };
    const usage = { at: 2, files: [{ path: "src/invoices.ts", read: true as const }], outside: 0, more: 0 };
    const review: Review = {
      id: "1792300000000-aaaaaaaa-master",
      source: "history",
      at: 1,
      projectId: options.project.id,
      head: recorded,
      plan: "PLAN.md",
      task: options.task,
      instructions: options.instructions,
      recorded: { units: [{ path: "src/invoices.ts", startChar: 0, endChar: 30 }], supplied: [0] },
      usage,
    };
    const jev = selector((_body, init) => {
      assert.equal(JSON.parse(new Headers(init.headers).get("cf-aig-metadata")!).trigger, "project-replay");
    });
    const result = await replayReview(review, { repository: cwd, selector: jev.value, signal: AbortSignal.timeout(30_000) });
    assert.equal(jev.calls, 1);
    assert.equal(result.reason, "selected");
    const invoices = result.considered.find((u) => u.path === "src/invoices.ts")!;
    assert.match(invoices.text!, /"\|"/, "the recorded commit's text, not the checkout's");
    assert.deepEqual(invoices.lines, [1, 1]);
    assert.equal(invoices.kept, true);
    assert.equal(result.considered.find((u) => u.path === "src/weather.ts")?.kept ?? false, false);
    assert.ok(!result.considered.some((u) => /Uncommitted/.test(u.text ?? "")));
    assert.deepEqual(result.recorded!.units[0].lines, [1, 1]);
    assert.deepEqual(result.usage, usage);
    assert.ok(result.inputTokens! > 0 && result.requestBytes! > 0 && result.judgeMs! >= 0);
    assert.deepEqual(
      {
        head: await git(cwd, ["rev-parse", "HEAD"]),
        status: await git(cwd, ["status", "--porcelain"]),
        worktrees: await git(cwd, ["worktree", "list", "--porcelain"]),
      },
      before,
    );
    assert.equal((await replayReview({ ...review, head: null }, { repository: cwd, selector: jev.value, signal: AbortSignal.timeout(5_000) })).reason, "no_commit");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stored reviews join the October seed, labelled gold copies and the runner's history, each once", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "project-reviews-"));
  try {
    const evaluation = evaluationDir(stateDir);
    await mkdir(path.join(evaluation, "reviews"), { recursive: true });
    await mkdir(reviewsDir(stateDir), { recursive: true });
    const seed = { at: 1, projectId: "example/project", head: "a".repeat(40), cwd: null, workIssue: null, instructions: ["Fix the importer"], old: {}, found: true };
    await writeFile(
      path.join(evaluation, "turns.json"),
      JSON.stringify([
        { ...seed, id: "11111111-master", runId: "11111111", actor: "master", task: "Coordinate the current user request.", query: "" },
        { ...seed, id: "11111111-22222222", runId: "11111111", actor: "22222222-x", task: "read: RECOVERY INSPECTION ONLY. Earlier helper task", query: null },
        { ...seed, id: "11111111-33333333", runId: "11111111", actor: "33333333-x", task: "change: Fix the importer", query: null },
      ]),
    );
    const receipt = (id: string, extra = {}) => ({
      id,
      at: 5,
      projectId: "example/project",
      head: "b".repeat(40),
      input: { plan: null, cwd: "/work", root: "/work", task: "change: Fix it", instructions: ["Fix it"] },
      considered: [{ path: "a.md", startChar: 0, endChar: 4, score: 1 }],
      supplied: [0],
      ...extra,
    });
    await writeFile(path.join(evaluation, "reviews", "5-gold-master.json"), JSON.stringify(receipt("5-gold-master")));
    await writeFile(path.join(reviewsDir(stateDir), "5-gold-master.json"), JSON.stringify(receipt("5-gold-master", { input: { plan: null, task: "changed", instructions: [] } })));
    await writeFile(path.join(reviewsDir(stateDir), "6-run-master.json"), JSON.stringify(receipt("6-run-master")));
    await writeFile(path.join(reviewsDir(stateDir), "7-old-master.json"), JSON.stringify({ id: "7-old-master", at: 7 }));
    const reviews = await storedReviews(stateDir);
    assert.deepEqual(reviews.map((r) => [r.id, r.source]), [
      ["11111111-master", "seed"],
      ["11111111-22222222", "seed"],
      ["11111111-33333333", "seed"],
      ["5-gold-master", "gold"],
      ["6-run-master", "history"],
    ]);
    assert.equal(reviews[0].query, "");
    assert.match(reviews[1].task, /^Read-only recovery inspection/);
    assert.equal(reviews[1].query, "");
    assert.equal(reviews[2].query, undefined);
    assert.equal(reviews[2].plan, undefined, "a seed's plan comes from the project at its commit");
    assert.equal(reviews[3].task, "change: Fix it");
    assert.deepEqual(reviews[4].recorded, { units: [{ path: "a.md", startChar: 0, endChar: 4 }], supplied: [0] });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

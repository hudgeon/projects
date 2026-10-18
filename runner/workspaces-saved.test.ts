import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { git, prepareWorkspace, pruneSaved, saveWorkspace, savedRef, savedRuns, UnsavedWorkspace } from "./workspaces";
import type { Child } from "../src/run-model";
import { result, fixture, dispatch } from "./run-fixtures";

test("a change worktree saved on one machine is recreated on the other with its uncommitted work", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin.git");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    const clone = async (name: string) => {
      const cwd = path.join(dir, name, "repo");
      await git(dir, ["clone", origin, cwd]);
      await git(cwd, ["config", "user.email", "test@example.invalid"]);
      await git(cwd, ["config", "user.name", "Test"]);
      return {id: "acme/test", name: "Test", cwd, plan: null};
    };
    const seed = await clone("seed");
    await git(seed.cwd, ["checkout", "-b", "main"]);
    await writeFile(path.join(seed.cwd, "a.txt"), "one\n");
    await writeFile(path.join(seed.cwd, "b.txt"), "keep\n");
    await git(seed.cwd, ["add", "."]);
    await git(seed.cwd, ["commit", "-m", "Initial"]);
    await git(seed.cwd, ["push", "-u", "origin", "main"]);
    const studio = await clone("studio"), laptop = await clone("laptop");
    const runId = randomUUID(), childId = randomUUID();
    const task = {...dispatch().task!, mode: "change" as const};
    const ws = await prepareWorkspace(studio, task, [], runId, childId, path.join(dir, "studio-runs"), "studio");
    await writeFile(path.join(ws.cwd, "a.txt"), "one\ntwo\n");
    await git(ws.cwd, ["commit", "-am", "Committed, not pushed"]);
    await writeFile(path.join(ws.cwd, "a.txt"), "one\ntwo\nthree\n");
    await rm(path.join(ws.cwd, "b.txt"));
    await writeFile(path.join(ws.cwd, "new.txt"), "fresh\n");
    const saved = await saveWorkspace(ws.cwd, runId, childId, {isPrivate: async () => true});
    assert.ok(saved);
    assert.match(await git(studio.cwd, ["ls-remote", "origin", savedRef(runId, childId)]), new RegExp(saved!.commit));
    const child: Child = {...ws, id: childId, projectId: studio.id, agent: "codex", mode: "change", state: "unknown", sessionId: "studio-session", result: null, evidence: [], host: "studio"};
    const restored = await prepareWorkspace(laptop, {...task, workspace: childId}, [child], runId, randomUUID(), path.join(dir, "laptop-runs"), "laptop");
    assert.equal(restored.restored, true);
    assert.equal(restored.sessionId, null, "a new session here; the old one stays on the Studio");
    assert.equal(restored.branch, ws.branch);
    assert.equal(await readFile(path.join(restored.cwd, "a.txt"), "utf8"), "one\ntwo\nthree\n");
    assert.equal(await readFile(path.join(restored.cwd, "new.txt"), "utf8"), "fresh\n");
    assert.deepEqual((await git(restored.cwd, ["status", "--porcelain"])).split("\n").map((line) => line.trim()).sort(), ["?? new.txt", "D b.txt", "M a.txt"]);
    assert.equal(await git(restored.cwd, ["log", "-1", "--format=%s"]), "Committed, not pushed");
    // Asking again reuses the copy already made here.
    const again = await prepareWorkspace(laptop, {...task, workspace: childId}, [child], runId, randomUUID(), path.join(dir, "laptop-runs"), "laptop");
    assert.deepEqual([again.cwd, again.restored], [restored.cwd, undefined]);
    // A branch pushed after the save supersedes it.
    await git(ws.cwd, ["add", "-A"]);
    await git(ws.cwd, ["commit", "-m", "Finished"]);
    await git(ws.cwd, ["push", "origin", `HEAD:refs/heads/${ws.branch}`]);
    const third = await clone("third");
    const newer = await prepareWorkspace(third, {...task, workspace: childId}, [child], runId, randomUUID(), path.join(dir, "third-runs"), "laptop");
    assert.equal(await git(newer.cwd, ["log", "-1", "--format=%s"]), "Finished");
    assert.equal(await git(newer.cwd, ["status", "--porcelain"]), "");
    // Once everything is on GitHub, the saved copy is removed.
    assert.equal(await saveWorkspace(ws.cwd, runId, childId, {isPrivate: async () => true}), null);
    assert.equal(await git(studio.cwd, ["ls-remote", "origin", savedRef(runId, childId)]), "");
    // A workspace never saved or pushed cannot move.
    const lost = {...child, id: randomUUID(), branch: "projects/never/saved"};
    await assert.rejects(prepareWorkspace(third, {...task, workspace: lost.id}, [lost], runId, randomUUID(), path.join(dir, "third-runs"), "laptop"), UnsavedWorkspace);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("the other machine continues a worktree from the newest copy any of its children saved", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin.git");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    const clone = async (name: string) => {
      const cwd = path.join(dir, name, "repo");
      await git(dir, ["clone", origin, cwd]);
      await git(cwd, ["config", "user.email", "test@example.invalid"]);
      await git(cwd, ["config", "user.name", "Test"]);
      return {id: "acme/test", name: "Test", cwd, plan: null};
    };
    const seed = await clone("seed");
    await git(seed.cwd, ["checkout", "-b", "main"]);
    await writeFile(path.join(seed.cwd, "a.txt"), "one\n");
    await git(seed.cwd, ["add", "."]);
    await git(seed.cwd, ["commit", "-m", "Initial"]);
    await git(seed.cwd, ["push", "-u", "origin", "main"]);
    const studio = await clone("studio"), laptop = await clone("laptop");
    const runId = randomUUID(), first = randomUUID(), second = randomUUID();
    const task = {...dispatch().task!, mode: "change" as const};
    const miniRuns = path.join(dir, "studio-runs"), airRuns = path.join(dir, "laptop-runs");
    const ws = await prepareWorkspace(studio, task, [], runId, first, miniRuns, "studio");
    const firstChild: Child = {...ws, id: first, projectId: studio.id, agent: "codex", mode: "change", state: "completed", sessionId: "first-session", result, evidence: [], host: "studio"};
    await writeFile(path.join(ws.cwd, "a.txt"), "first turn\n");
    assert.ok(await saveWorkspace(ws.cwd, runId, first, {isPrivate: async () => true}));
    // A follow-up works on in the same worktree and saves newer work under its own ID.
    const reused = await prepareWorkspace(studio, {...task, workspace: first}, [firstChild], runId, second, miniRuns, "studio");
    assert.equal(reused.cwd, ws.cwd);
    const secondChild: Child = {...firstChild, ...reused, id: second, sessionId: "second-session", state: "unknown"};
    await writeFile(path.join(ws.cwd, "a.txt"), "second turn\n");
    const newest = await saveWorkspace(ws.cwd, runId, second, {isPrivate: async () => true});
    assert.ok(newest);
    const children = [firstChild, secondChild];
    // The master names the worktree's first child: the second child's newer copy comes back.
    const restored = await prepareWorkspace(laptop, {...task, workspace: first}, children, runId, randomUUID(), airRuns, "laptop");
    assert.equal(restored.restored, true);
    assert.equal(await readFile(path.join(restored.cwd, "a.txt"), "utf8"), "second turn\n");
    assert.equal(restored.savedAt, Number(await git(studio.cwd, ["log", "-1", "--format=%ct", newest!.commit])) * 1000, "the copy's own time, not an assumed interval");
    // Naming the later child reuses that copy instead of making a second one.
    const again = await prepareWorkspace(laptop, {...task, workspace: second}, children, runId, randomUUID(), airRuns, "laptop");
    assert.deepEqual([again.cwd, again.restored], [restored.cwd, undefined]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// A bare origin with main, and a clone of it for each machine.
async function originFixture(dir: string) {
  const origin = path.join(dir, "origin.git");
  await git(dir, ["init", "--bare", "-b", "main", origin]);
  const clone = async (name: string) => {
    const cwd = path.join(dir, name, "repo");
    await git(dir, ["clone", origin, cwd]);
    await git(cwd, ["config", "user.email", "test@example.invalid"]);
    await git(cwd, ["config", "user.name", "Test"]);
    return {id: "acme/test", name: "Test", cwd, plan: null};
  };
  const seed = await clone("seed");
  await git(seed.cwd, ["checkout", "-b", "main"]);
  await writeFile(path.join(seed.cwd, "a.txt"), "one\n");
  await git(seed.cwd, ["add", "."]);
  await git(seed.cwd, ["commit", "-m", "Initial"]);
  await git(seed.cwd, ["push", "-u", "origin", "main"]);
  return clone;
}
// The children whose copies of this conversation are on the origin.
const savedIds = async (cwd: string, runId: string) =>
  (await git(cwd, ["ls-remote", "origin", savedRef(runId, "*")])).split("\n").filter(Boolean).map((line) => line.split("/").at(-1)!).sort();
const changeChild = (id: string, place: {cwd: string; branch: string}, host: "studio" | "laptop"): Child =>
  ({...place, id, projectId: "acme/test", agent: "codex", mode: "change", state: "completed", sessionId: null, result, evidence: [], host});

test("a worktree keeps one copy on GitHub, and GitHub, not the runner's memory, decides when it goes", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const studio = await (await originFixture(dir))("studio");
    const runId = randomUUID(), first = randomUUID(), second = randomUUID(), third = randomUUID();
    const ws = await prepareWorkspace(studio, {...dispatch().task!, mode: "change" as const}, [], runId, first, path.join(dir, "runs"), "studio");
    const merged = new Set<string>();
    const save = (child: string, older: string[] = []) =>
      saveWorkspace(ws.cwd, runId, child, {older, isPrivate: async () => true, landed: async (_cwd, commit) => merged.has(commit)});
    // The first turn ends with work only this machine has; the runner restarts.
    await writeFile(path.join(ws.cwd, "a.txt"), "first turn\n");
    assert.ok(await save(first));
    assert.deepEqual(await savedIds(studio.cwd, runId), [first]);
    // A follow-up in the same worktree commits and pushes before saving anything.
    await git(ws.cwd, ["commit", "-am", "Second turn"]);
    await git(ws.cwd, ["push", "-u", "origin", ws.branch]);
    assert.equal(await save(second, [first]), null);
    assert.deepEqual(await savedIds(studio.cwd, runId), [], "the first turn's copy goes once GitHub has the work");
    // Each save replaces the copies earlier children made in this worktree.
    await writeFile(path.join(ws.cwd, "a.txt"), "second turn, more\n");
    assert.ok(await save(second, [first]));
    await writeFile(path.join(ws.cwd, "a.txt"), "third turn\n");
    const newest = await save(third, [first, second]);
    assert.deepEqual(await savedIds(studio.cwd, runId), [third]);
    assert.equal(await git(studio.cwd, ["show", `${newest!.commit}:a.txt`]), "third turn");
    // Once its branch has landed, leftover changes are not kept.
    merged.add(await git(ws.cwd, ["rev-parse", "HEAD"]));
    assert.equal(await save(third, [first, second]), null);
    assert.deepEqual(await savedIds(studio.cwd, runId), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("after a turn the Studio keeps only the newest copy of a worktree that alone holds its work", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const studio = await (await originFixture(dir))("studio");
    const runId = randomUUID(), root = path.join(dir, "runs");
    const [a1, a2, b, c, stranger] = Array.from({length: 5}, () => randomUUID());
    const task = {...dispatch().task!, mode: "change" as const};
    const keep = {isPrivate: async () => true, landed: async () => false};
    // a1 and a2 worked in one worktree that still holds unsaved work; an
    // earlier runner left a1's copy behind.
    const w1 = await prepareWorkspace(studio, task, [], runId, a1, root, "studio");
    await writeFile(path.join(w1.cwd, "a.txt"), "unsaved\n");
    await saveWorkspace(w1.cwd, runId, a1, keep);
    await saveWorkspace(w1.cwd, runId, a2, keep);
    // b's work reached its branch after its last save.
    const w2 = await prepareWorkspace(studio, task, [], runId, b, root, "studio");
    await writeFile(path.join(w2.cwd, "b.txt"), "done\n");
    await saveWorkspace(w2.cwd, runId, b, keep);
    await git(w2.cwd, ["add", "."]);
    await git(w2.cwd, ["commit", "-m", "Done"]);
    await git(w2.cwd, ["push", "-u", "origin", w2.branch]);
    // c's worktree is gone; only its copy holds the work.
    const w3 = await prepareWorkspace(studio, task, [], runId, c, root, "studio");
    await writeFile(path.join(w3.cwd, "a.txt"), "committed\n");
    await git(w3.cwd, ["commit", "-am", "Branch work"]);
    await writeFile(path.join(w3.cwd, "a.txt"), "only in the copy\n");
    await saveWorkspace(w3.cwd, runId, c, keep);
    const base = await git(w3.cwd, ["rev-parse", "HEAD"]);
    await rm(w3.cwd, {recursive: true, force: true});
    // A copy of no recorded child, and one fetched here earlier.
    await git(studio.cwd, ["push", "origin", `HEAD:${savedRef(runId, stranger)}`]);
    await git(studio.cwd, ["update-ref", savedRef(runId, a1), "HEAD"]);
    assert.deepEqual(await savedRuns(studio.cwd), [runId]);
    const children = [changeChild(a1, w1, "studio"), changeChild(a2, w1, "studio"), changeChild(b, w2, "studio"), changeChild(c, w3, "studio")];
    const merged = new Set<string>();
    const prune = () => pruneSaved(studio, runId, children, root, "studio", async (_cwd, commit) => merged.has(commit));
    await prune();
    assert.deepEqual(await savedIds(studio.cwd, runId), [a2, c, stranger].sort());
    assert.equal(await git(studio.cwd, ["for-each-ref", "refs/projects/wip"]), "", "no fetched copy stays here");
    // A worktree still at main's commit has not landed, whatever merged there.
    merged.add(base).add(await git(w1.cwd, ["rev-parse", "HEAD"]));
    await prune();
    assert.deepEqual(await savedIds(studio.cwd, runId), [a2, stranger].sort(), "a copy goes once its branch has landed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a machine removes another's copies once it recreates their worktree or their branch lands, and keeps its own while they hold unlanded work", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const clone = await originFixture(dir);
    const studio = await clone("studio"), laptop = await clone("laptop");
    const runId = randomUUID(), miniRuns = path.join(dir, "studio-runs"), airRuns = path.join(dir, "laptop-runs");
    const [a1, a2, d, here, own] = Array.from({length: 5}, () => randomUUID());
    const task = {...dispatch().task!, mode: "change" as const};
    const keep = {isPrivate: async () => true, landed: async () => false};
    const w1 = await prepareWorkspace(studio, task, [], runId, a1, miniRuns, "studio");
    await writeFile(path.join(w1.cwd, "a.txt"), "first\n");
    await saveWorkspace(w1.cwd, runId, a1, keep);
    await writeFile(path.join(w1.cwd, "a.txt"), "second\n");
    await saveWorkspace(w1.cwd, runId, a2, keep);
    const w4 = await prepareWorkspace(studio, task, [], runId, d, miniRuns, "studio");
    await writeFile(path.join(w4.cwd, "a.txt"), "committed\n");
    await git(w4.cwd, ["commit", "-am", "Branch work"]);
    await writeFile(path.join(w4.cwd, "a.txt"), "never continued\n");
    await saveWorkspace(w4.cwd, runId, d, keep);
    const base = await git(w4.cwd, ["rev-parse", "HEAD"]);
    // A copy an earlier runner here saved of its own worktree, since removed.
    await writeFile(path.join(laptop.cwd, "own.txt"), "own work\n");
    await git(laptop.cwd, ["add", "own.txt"]);
    await git(laptop.cwd, ["commit", "-qm", "Own work"]);
    const ownBase = await git(laptop.cwd, ["rev-parse", "HEAD"]);
    await git(laptop.cwd, ["push", "origin", `HEAD:${savedRef(runId, own)}`]);
    await git(laptop.cwd, ["reset", "-q", "--hard", "HEAD~1"]);
    const minis = [changeChild(a1, w1, "studio"), changeChild(a2, w1, "studio"), changeChild(d, w4, "studio")];
    const restored = await prepareWorkspace(laptop, {...task, workspace: a2}, minis, runId, here, airRuns, "laptop");
    assert.equal(await readFile(path.join(restored.cwd, "a.txt"), "utf8"), "second\n");
    const children = [...minis, changeChild(here, restored, "laptop"), changeChild(own, {cwd: path.join(airRuns, "gone"), branch: "projects/gone"}, "laptop")];
    const merged = new Set<string>();
    const prune = () => pruneSaved(laptop, runId, children, airRuns, "laptop", async (_cwd, commit) => merged.has(commit));
    await prune();
    assert.deepEqual(await savedIds(laptop.cwd, runId), [d, own].sort(), "work nobody has continued stays, and so does this machine's own copy");
    assert.equal(await git(laptop.cwd, ["for-each-ref", "refs/projects/wip"]), "", "the copy fetched to recreate the worktree is removed");
    merged.add(base).add(ownBase);
    await prune();
    assert.deepEqual(await savedIds(laptop.cwd, runId), [], "each copy goes once its branch has landed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { continuesSession, git, liveChanges, prepareWorkspace, privateOrigin, saveWorkspace, savedRef, SESSION_CONTEXT_LIMIT, workspaceEvidence } from "./workspaces";
import type { Child } from "../src/run-model";
import { result, fixture, dispatch } from "./run-fixtures";

test("a child's evidence names commits not yet pushed and its pull request", async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin"), primary = path.join(dir, "primary");
    await git(dir, ["init", "--bare", origin]);
    await git(dir, ["clone", origin, primary]);
    await git(primary, ["config", "user.email", "test@example.invalid"]);
    await git(primary, ["config", "user.name", "Test"]);
    await git(primary, ["checkout", "-b", "main"]);
    await writeFile(path.join(primary, "README.md"), "Initial\n");
    await git(primary, ["add", "README.md"]);
    await git(primary, ["commit", "-m", "Initial"]);
    await git(primary, ["push", "-u", "origin", "main"]);
    assert.deepEqual((await workspaceEvidence(primary)).slice(3), ["Observed unpushed commits: 0"], "main has no pull request to look up");
    await git(primary, ["checkout", "-b", "projects/work"]);
    await writeFile(path.join(primary, "README.md"), "Changed\n");
    await git(primary, ["commit", "-am", "Change"]);
    const evidence = await workspaceEvidence(primary);
    assert.equal(evidence[3], "Observed unpushed commits: 1");
    // This origin is not on GitHub, so the lookup is reported, never guessed.
    assert.equal(evidence[4], "Observed pull request: not checked; GitHub was unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktrees start at current origin/main and reuse only an owned unchanged branch", async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin"),
      primary = path.join(dir, "primary");
    await git(dir, ["init", "--bare", origin]);
    await git(dir, ["clone", origin, primary]);
    await git(primary, ["config", "user.email", "test@example.invalid"]);
    await git(primary, ["config", "user.name", "Test"]);
    await git(primary, ["checkout", "-b", "main"]);
    await writeFile(path.join(primary, "README.md"), "Initial\n");
    await git(primary, ["add", "README.md"]);
    await git(primary, ["commit", "-m", "Initial"]);
    await git(primary, ["push", "-u", "origin", "main"]);
    const project = {
      id: "acme/test",
      name: "Test",
      cwd: primary,
      plan: null,
    };
    const id = randomUUID(),
      runId = randomUUID();
    const task = { ...dispatch().task!, mode: "change" as const };
    const ws = await prepareWorkspace(
      project,
      task,
      [],
      runId,
      id,
      path.join(dir, "owned"), "studio",
    );
    assert.notEqual(ws.cwd, primary);
    assert.match(ws.branch, /^projects\//);
    assert.equal(
      await git(ws.cwd, ["rev-parse", "HEAD"]),
      await git(primary, ["rev-parse", "origin/main"]),
    );
    const peers = await Promise.all(Array.from({length: 3}, () => prepareWorkspace(
      project, task, [], randomUUID(), randomUUID(), path.join(dir, "owned"), "studio",
    )));
    assert.equal(new Set(peers.map(peer => peer.cwd)).size, 3);
    assert.equal(new Set(peers.map(peer => peer.branch)).size, 3);
    for (const peer of peers) assert.equal(await git(peer.cwd, ["rev-parse", "HEAD"]), await git(primary, ["rev-parse", "origin/main"]));
    const recovery = await Promise.allSettled([
      prepareWorkspace(project, task, [], runId, id, path.join(dir, "owned"), "studio"),
      prepareWorkspace(project, task, [], randomUUID(), randomUUID(), path.join(dir, "owned"), "studio"),
    ]);
    assert.equal(recovery[0].status, "rejected", "an existing branch is never overwritten");
    assert.equal(recovery[1].status, "fulfilled", "a failed setup must release the next conversation's setup");
    const child: Child = {
      ...ws,
      id,
      projectId: project.id,
      agent: "claude",
      mode: "change",
      state: "completed",
      sessionId: randomUUID(),
      result,
      evidence: [],
    };
    const resume = await prepareWorkspace(
      project,
      { ...task, workspace: id },
      [child],
      runId,
      randomUUID(),
      dir, "studio",
    );
    assert.equal(resume.sessionId, child.sessionId);
    assert.equal(resume.cwd, ws.cwd);
    await assert.rejects(
      prepareWorkspace(
        project,
        { ...task, workspace: "not-owned" },
        [child],
        runId,
        randomUUID(),
        dir, "studio",
      ),
      /does not belong/,
    );
    await assert.rejects(
      prepareWorkspace(
        project,
        { ...task, workspace: id },
        [{ ...child, mode: "read", cwd: primary, branch: "main" }],
        runId,
        randomUUID(),
        dir, "studio",
      ),
      /primary checkout/,
    );
    // A child's second branch in its own runner worktree is still its own.
    await git(ws.cwd, ["checkout", "-b", "projects/second-pull-request"]);
    const second = await prepareWorkspace(project, { ...task, workspace: id }, [child], runId, randomUUID(), path.join(dir, "owned"), "studio");
    assert.deepEqual([second.cwd, second.branch], [ws.cwd, "projects/second-pull-request"]);
    // So is the detached checkout a child leaves once its pull request merged.
    await git(ws.cwd, ["checkout", "--detach"]);
    const detached = await prepareWorkspace(project, { ...task, workspace: id }, [child], runId, randomUUID(), path.join(dir, "owned"), "studio");
    assert.deepEqual([detached.cwd, detached.branch, detached.sessionId], [ws.cwd, child.branch, child.sessionId]);
    // A session that cannot continue leaves its worktree to a fresh one.
    const fresh = await prepareWorkspace(project, { ...task, workspace: id }, [{ ...child, resumable: false }], runId, randomUUID(), path.join(dir, "owned"), "studio");
    assert.deepEqual([fresh.cwd, fresh.sessionId], [ws.cwd, null]);
    await git(ws.cwd, ["checkout", "projects/second-pull-request"]);
    // Outside the runner's own worktrees, a different branch means another owner.
    await assert.rejects(
      prepareWorkspace(
        project,
        { ...task, workspace: id },
        [child],
        runId,
        randomUUID(),
        path.join(dir, "elsewhere"), "studio",
      ),
      /did not start, so another session may own it/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live changes count the branch's committed, uncommitted and new files", async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin"), work = path.join(dir, "work");
    await git(dir, ["init", "--bare", origin]);
    await git(dir, ["clone", origin, work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "Test"]);
    await git(work, ["checkout", "-b", "main"]);
    await writeFile(path.join(work, "a.txt"), "one\ntwo\n");
    await git(work, ["add", "a.txt"]);
    await git(work, ["commit", "-m", "Initial"]);
    await git(work, ["push", "-u", "origin", "main"]);
    await git(work, ["checkout", "-b", "projects/work"]);
    await writeFile(path.join(work, "a.txt"), "one\nthree\n");
    await git(work, ["commit", "-am", "Committed change"]);
    await writeFile(path.join(work, "a.txt"), "one\nthree\nfour\n");
    await writeFile(path.join(work, "new.txt"), "x\ny\nz\n");
    const changes = await liveChanges(work);
    assert.deepEqual(changes.files, [{path: "a.txt", added: 2, removed: 1}, {path: "new.txt", added: 3, removed: 0}]);
    assert.deepEqual(changes.total, {files: 2, added: 5, removed: 1});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("work in progress is saved only to a private origin, through its hooks and without credentials", {timeout: 60000}, async () => {
  const dir = await fixture();
  try {
    const origin = path.join(dir, "origin.git"), cwd = path.join(dir, "work"), hooks = path.join(dir, "hooks");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    await git(dir, ["clone", origin, cwd]);
    await git(cwd, ["config", "user.email", "test@example.invalid"]);
    await git(cwd, ["config", "user.name", "Test"]);
    await git(cwd, ["checkout", "-b", "main"]);
    await writeFile(path.join(cwd, "a.txt"), "one\n");
    await writeFile(path.join(cwd, "deploy-token.txt"), "placeholder\n");
    await writeFile(path.join(cwd, "settings.example"), "KEY=example\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "Initial"]);
    await git(cwd, ["push", "-u", "origin", "main"]);
    await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
    await writeFile(path.join(cwd, "deploy-token.txt"), "real-value\n");
    await rename(path.join(cwd, "settings.example"), path.join(cwd, ".env.production"));
    await writeFile(path.join(cwd, ".dev.vars"), "API_KEY=real\n");
    const runId = randomUUID(), childId = randomUUID(), ref = savedRef(runId, childId);
    assert.equal(await privateOrigin(cwd), false, "a remote off GitHub is not known to be private");
    assert.equal(await saveWorkspace(cwd, runId, childId), null);
    assert.equal(await saveWorkspace(cwd, runId, childId, {isPrivate: async () => false}), null, "a public repository gets nothing");
    assert.equal(await git(cwd, ["ls-remote", "origin", ref]), "");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-push"), `#!/bin/sh\ntouch "${path.join(dir, "hook-ran")}"\n`, {mode: 0o755});
    await git(cwd, ["config", "core.hooksPath", hooks]);
    const saved = await saveWorkspace(cwd, runId, childId, {isPrivate: async () => true});
    assert.ok(saved);
    assert.ok(await stat(path.join(dir, "hook-ran")), "the repository's own push hook ran");
    assert.match(await git(cwd, ["ls-remote", "origin", ref]), new RegExp(saved!.commit));
    assert.deepEqual((await git(cwd, ["ls-tree", "-r", "--name-only", saved!.commit])).split("\n"), ["a.txt", "deploy-token.txt"], "a renamed or new credential-like file stays local");
    assert.equal(await git(cwd, ["show", `${saved!.commit}:deploy-token.txt`]), "placeholder", "a changed credential-like file keeps its committed version");
    assert.equal(await git(cwd, ["show", `${saved!.commit}:a.txt`]), "one\ntwo");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a worktree's session continues only for a same-app follow-up while it is small; reviews and large sessions start fresh", () => {
  const usage = (context: number) => ({fresh: 1, cached: 1, output: 1, turns: 1, context});
  const made: Child = {id: randomUUID(), projectId: "acme/test", agent: "claude", mode: "change", cwd: "/w", branch: "projects/a", sessionId: "s1", state: "completed", result, evidence: [], usage: usage(80_000)};
  const followUp = {...dispatch(made.id).task!, mode: "change" as const};
  assert.equal(continuesSession(made, followUp, [made]), true);
  assert.equal(continuesSession(made, {...followUp, freshSession: true}, [made]), false, "an explicit context reset keeps the workspace but drops its transcript");
  assert.equal(continuesSession(made, {...followUp, mode: "read"}, [made]), false, "a review of a change is independent");
  assert.equal(continuesSession({...made, mode: "read"}, followUp, [made]), false, "a restricted read session cannot continue changes");
  assert.equal(continuesSession(made, {...followUp, agent: "codex"}, [made]), false);
  assert.equal(continuesSession({...made, resumable: false}, followUp, [made]), false);
  // The session's latest turn decides, even when a later follow-up made it.
  const later: Child = {...made, id: randomUUID(), usage: usage(SESSION_CONTEXT_LIMIT)};
  assert.equal(continuesSession(made, followUp, [made, later]), false);
  assert.equal(continuesSession({...made, sessionId: null}, followUp, [made]), false);
});

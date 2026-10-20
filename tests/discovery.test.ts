import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { collect, subprocessEnv, unpushedCommits } from "../collector/collect";
import { discover, command, machineSecret } from "../collector/collect";
import { configSchema } from "../collector/config";
import type { Worktree } from "../src/model";

test("unnamed native tasks never upload the original prompt as a title", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-title-"));
  try {
    await mkdir(path.join(root, ".codex"));
    await mkdir(path.join(root, "repos"));
    const db = new DatabaseSync(path.join(root, ".codex/state_5.sqlite"));
    db.exec(
      "CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,archived INTEGER)",
    );
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,0)").run(
      "task-1",
      null,
      "Private original prompt",
      root,
      Math.floor(Date.now() / 1000),
      "",
    );
    db.close();
    const snapshot = await collect(
      configSchema.parse({
        host: "laptop",
        root: path.join(root, "repos"),
        home: root,
      }),
    );
    assert.equal(snapshot.unassignedSessions[0].title, "Untitled Codex task");
    assert.equal(
      JSON.stringify(snapshot).includes("Private original prompt"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("project identity and metadata survive moves; new opt-in and removal replace the catalogue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-discovery-"));
  try {
    const initial = path.join(root, "old-name");
    await mkdir(initial);
    await command("git", ["init"], initial);
    await command(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/example.git"],
      initial,
    );
    const config = configSchema.parse({
      host: "laptop",
      root,
      home: root,
      projects: { "acme/example": { name: "Example", plan: "PLAN.md" } },
    });
    assert.equal((await discover(config))[0].name, "Example");
    await mkdir(path.join(root, "products"));
    await rename(initial, path.join(root, "products/new-name"));
    assert.equal((await discover(config))[0].directory, "products/new-name");
    assert.equal((await discover(config))[0].plan, "PLAN.md");
    await writeFile(
      path.join(root, "products/new-name/.project-overview.json"),
      JSON.stringify({
        id: "stable-example",
        name: "Renamed",
        plan: "docs/PLAN.md",
      }),
    );
    assert.equal((await discover(config))[0].id, "stable-example");
    const other = path.join(root, "new-project");
    await mkdir(other);
    await command("git", ["init"], other);
    assert.equal((await discover(config)).length, 1);
    await writeFile(
      path.join(other, ".project-overview.json"),
      JSON.stringify({ id: "new", name: "New project" }),
    );
    assert.equal((await discover(config)).length, 2);
    await rm(other, { recursive: true });
    assert.equal((await discover(config)).length, 1);
    await writeFile(
      path.join(root, "products/new-name/.project-overview.json"),
      "{invalid",
    );
    await assert.rejects(discover(config));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("the Laptop reads Gmail only on duty, and its upload bearer never reaches a subprocess", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-duty-"));
  const bin = path.join(root, "bin"),
    marker = path.join(root, "gws-called"),
    PATH = process.env.PATH;
  try {
    await mkdir(bin);
    await mkdir(path.join(root, "repos"));
    await writeFile(path.join(bin, "gws"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${PATH}`;
    process.env.COLLECTOR_TOKEN = "y".repeat(64);
    process.env.RUNNER_TOKEN = "z".repeat(64);
    const config = configSchema.parse({
      host: "laptop",
      root: path.join(root, "repos"),
      home: root,
      inboxAccount: "owner@example.com",
    });
    assert.equal((await collect(config)).inboxes, undefined);
    assert.equal(existsSync(marker), false, "off duty, Gmail is not read");
    assert.equal((await collect(config, { inbox: true })).inboxes?.[0].state, "unavailable");
    assert.equal(existsSync(marker), true, "on duty, the Laptop reads Gmail");
    assert.equal(subprocessEnv().COLLECTOR_TOKEN, undefined);
    assert.equal(subprocessEnv().RUNNER_TOKEN, undefined);
  } finally {
    process.env.PATH = PATH;
    Reflect.deleteProperty(process.env, "COLLECTOR_TOKEN");
    Reflect.deleteProperty(process.env, "RUNNER_TOKEN");
    await rm(root, { recursive: true, force: true });
  }
});

test("a removed worktree folder is housekeeping, and squash-merged work is not unpushed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-hygiene-"));
  try {
    const origin = path.join(root, "origin.git"), repo = path.join(root, "repos", "app");
    const git = (args: string[], cwd = repo) => command("git", args, cwd);
    await git(["init", "--bare", "-b", "main", origin], root);
    await mkdir(path.dirname(repo), { recursive: true });
    await git(["clone", origin, repo], root);
    await git(["config", "user.email", "test@example.invalid"]);
    await git(["config", "user.name", "Test"]);
    await git(["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "a.txt"), "one\n");
    await writeFile(path.join(repo, ".project-overview.json"), JSON.stringify({ id: "acme/hygiene", name: "Hygiene" }));
    await git(["add", "."]);
    await git(["commit", "-m", "Initial"]);
    await git(["push", "-u", "origin", "main"]);
    const feature = path.join(root, "worktrees", "feature");
    await git(["worktree", "add", "-b", "feature", feature, "origin/main"]);
    await writeFile(path.join(feature, "a.txt"), "two\n");
    await git(["commit", "-am", "Step one"], feature);
    await writeFile(path.join(feature, "b.txt"), "new\n");
    await git(["add", "b.txt"], feature);
    await git(["commit", "-m", "Step two"], feature);
    assert.equal(await unpushedCommits(feature), 2, "commits only this machine holds");
    // Main takes the same changes as one squash commit; the branch is never pushed.
    await writeFile(path.join(repo, "a.txt"), "two\n");
    await writeFile(path.join(repo, "b.txt"), "new\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Squash merge"]);
    await writeFile(path.join(repo, "a.txt"), "three\n");
    await git(["commit", "-am", "Later change"]);
    await git(["push", "origin", "main"]);
    assert.equal(await unpushedCommits(feature), 0, "its changes landed, even though main moved on");
    await writeFile(path.join(feature, "c.txt"), "unpushed\n");
    await git(["add", "c.txt"], feature);
    await git(["commit", "-m", "Step three"], feature);
    assert.equal(await unpushedCommits(feature), 3, "new work on top is unpushed again");
    const gone = path.join(root, "worktrees", "gone");
    await git(["worktree", "add", "--detach", gone, "origin/main"]);
    await rm(gone, { recursive: true, force: true });
    const snapshot = await collect(configSchema.parse({ host: "laptop", root: path.join(root, "repos"), home: root }));
    const project = snapshot.projects.find((p) => p.id === "acme/hygiene")!;
    assert.equal(project.sources.git.state, "ok", "a removed folder is not an unreadable repository");
    const removed = project.worktrees.find((w) => w.path.endsWith(`${path.sep}gone`));
    assert.deepEqual([removed?.prunable, removed?.error, removed?.unpushed], [true, null, 0]);
    assert.equal(project.worktrees.find((w) => w.branch === "feature")?.unpushed, 3);
    const local = path.join(root, "local");
    await mkdir(local);
    await git(["init", "-b", "main"], local);
    await git(["config", "user.email", "test@example.invalid"], local);
    await git(["config", "user.name", "Test"], local);
    await writeFile(path.join(local, "x.txt"), "x\n");
    await git(["add", "."], local);
    await git(["commit", "-m", "Local only"], local);
    assert.equal(await unpushedCommits(local), null, "no remote: nowhere to push");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a folder Git cannot see stays unverified unless confirmed removed, and a removed folder's commit still counts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-prunable-"));
  const at = (name: string) => path.join(root, "worktrees", name);
  try {
    const origin = path.join(root, "origin.git"), repo = path.join(root, "repos", "app");
    const git = (args: string[], cwd = repo) => command("git", args, cwd);
    await git(["init", "--bare", "-b", "main", origin], root);
    await mkdir(path.dirname(repo), { recursive: true });
    await git(["clone", origin, repo], root);
    await git(["config", "user.email", "test@example.invalid"]);
    await git(["config", "user.name", "Test"]);
    await git(["checkout", "-b", "main"]);
    await writeFile(path.join(repo, ".project-overview.json"), JSON.stringify({ id: "acme/prunable", name: "Prunable" }));
    await git(["add", "."]);
    await git(["commit", "-m", "Initial"]);
    await git(["push", "-u", "origin", "main"]);
    const add = async (dir: string, args: string[], file?: string) => {
      await mkdir(path.dirname(dir), { recursive: true });
      await git(["worktree", "add", ...args, dir, "origin/main"]);
      if (!file) return;
      await writeFile(path.join(dir, file), `${file}\n`);
      await git(["add", file], dir);
      await git(["commit", "-m", file], dir);
    };
    // Live checkouts with uncommitted and unpushed work that Git cannot see:
    // behind an unreadable parent, and on a volume that has gone away.
    await add(path.join(at("blocked"), "wt"), ["-b", "blocked"], "blocked.txt");
    await writeFile(path.join(at("blocked"), "wt", "draft.txt"), "uncommitted\n");
    await add(path.join(at("volume"), "wt"), ["-b", "volume"], "volume.txt");
    // Folders that are really gone.
    await add(at("kept"), ["-b", "kept"], "kept.txt");
    await add(at("detached"), ["--detach"], "detached.txt");
    await add(at("merged"), ["-b", "merged"], "merged.txt");
    await add(at("clean"), ["--detach"]);
    // "merged" lands on main as one squash commit; its branch is never pushed.
    await writeFile(path.join(repo, "merged.txt"), "merged.txt\n");
    await git(["add", "merged.txt"]);
    await git(["commit", "-m", "Squash merge"]);
    await git(["push", "origin", "main"]);
    for (const name of ["kept", "detached", "merged", "clean"])
      await rm(at(name), { recursive: true });
    await chmod(at("blocked"), 0o000);
    await rename(at("volume"), at("unmounted"));
    assert.equal(
      (await git(["worktree", "list", "--porcelain"])).match(/^prunable /gm)?.length,
      6,
      "Git flags every folder it cannot see, reachable or not",
    );
    const snapshot = await collect(configSchema.parse({ host: "laptop", root: path.join(root, "repos"), home: root }));
    const project = snapshot.projects.find((p) => p.id === "acme/prunable")!;
    const record = (...parts: string[]) =>
      project.worktrees.find((w) => w.path.endsWith(path.join(path.sep, ...parts)));
    const state = (w?: Worktree) => [w?.prunable, w?.error, w?.unpushed];
    assert.deepEqual(state(record("blocked", "wt")), [undefined, "Checkout unavailable", undefined]);
    assert.deepEqual(state(record("volume", "wt")), [undefined, "Checkout unavailable", undefined]);
    assert.equal(project.sources.git.state, "unavailable", "coverage shows the checkouts that were not read");
    assert.deepEqual(state(record("kept")), [true, null, 1], "the branch still holds a commit only this machine has");
    assert.deepEqual(state(record("detached")), [true, null, 1], "pruning would drop this commit");
    assert.deepEqual(state(record("merged")), [true, null, 0], "its changes landed on main");
    assert.deepEqual(state(record("clean")), [true, null, 0]);
  } finally {
    await chmod(at("blocked"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a machine reads a secret from its Doppler config with only its read-only service token", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "projects-doppler-"));
  try {
    const base = path.join(home, ".local/share/project-overview"),
      fake = path.join(home, "doppler"),
      log = path.join(home, "call.json");
    await mkdir(base, { recursive: true });
    await writeFile(fake, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), token: process.env.DOPPLER_TOKEN ?? null, runner: process.env.RUNNER_TOKEN ?? null}));
if (process.argv[4] === "MISSING") { console.error("raw provider detail"); process.exit(1); }
process.stdout.write("r".repeat(64) + "\\n");
`, { mode: 0o755 });
    await writeFile(path.join(base, "doppler-token"), "dp.st.example\n", { mode: 0o600 });
    process.env.RUNNER_TOKEN = "x".repeat(64);
    const config = { home, doppler: { project: "projects", config: "laptop" } };
    assert.equal(await machineSecret(config, "RUNNER_TOKEN", fake), "r".repeat(64));
    const call = JSON.parse(await readFile(log, "utf8"));
    assert.deepEqual(call.args, ["secrets", "get", "RUNNER_TOKEN", "--plain", "--config-dir", path.join(base, "doppler"), "--project", "projects", "--config", "laptop"]);
    assert.equal(call.token, "dp.st.example");
    assert.equal(call.runner, null, "no other token reaches the call");
    await assert.rejects(machineSecret(config, "MISSING", fake), (e: Error) => e.message === "MISSING could not be read from this machine's Doppler config.");
    await assert.rejects(machineSecret({ home }, "RUNNER_TOKEN", fake), /names no Doppler config/);
    await chmod(path.join(base, "doppler-token"), 0o644);
    await assert.rejects(machineSecret(config, "RUNNER_TOKEN", fake), /readable only by its owner/);
  } finally {
    Reflect.deleteProperty(process.env, "RUNNER_TOKEN");
    await rm(home, { recursive: true, force: true });
  }
});

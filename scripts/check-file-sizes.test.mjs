import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "check-file-sizes.mjs");
// Each test gets a repository of its own, untouched by this machine's Git
// settings.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
function repository(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "file-sizes-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  const write = (files) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
  };
  const commit = (files) => {
    write(files);
    git("add", "--all");
    git("commit", "--quiet", "--message", "Change");
  };
  const check = (base = "main") =>
    spawnSync(process.execPath, [script, base], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
  git("init", "--quiet", "--initial-branch=main");
  return { git, write, commit, check };
}
// Text of an exact size, distinct for each name so that Git pairs only real
// renames.
const text = (name, bytes) =>
  `${name}\n`.repeat(Math.ceil(bytes / (name.length + 1))).slice(0, bytes);

test("work that adds or grows a file over 5,000 tokens fails with how to split it", (t) => {
  const repo = repository(t);
  repo.commit({
    "big.ts": text("big", 30_000),
    "edge.ts": text("edge", 19_000),
    "old.ts": text("old", 30_000),
  });
  repo.git("switch", "--quiet", "--create", "work");
  repo.git("mv", "old.ts", "renamed.ts");
  repo.commit({
    "big.ts": text("big", 30_100),
    "edge.ts": text("edge", 20_001),
    "renamed.ts": text("old", 30_100),
  });
  // Not yet committed: the check sees work as it would be committed.
  repo.write({ "new.test.ts": text("new", 20_001) });

  const result = repo.check();
  assert.equal(result.status, 1);
  assert.deepEqual(
    result.stderr.split("\n").filter((line) => line.startsWith("  ")),
    [
      "  big.ts: 7,525 tokens (30,100 bytes, was 30,000)",
      "  edge.ts: 5,001 tokens (20,001 bytes, was 19,000)",
      "  new.test.ts: 5,001 tokens (20,001 bytes, new)",
      "  renamed.ts: 7,525 tokens (30,100 bytes, was 30,000)",
    ],
  );
  for (const rule of [
    /by feature or route/,
    /helpers stay beside their callers/,
    /tests go in per-module files next to the code they cover/,
    /public exports stay stable/,
  ])
    assert.match(result.stderr, rule);
});

test("files over the limit may stay the same size or shrink, judged from where work left main", (t) => {
  const repo = repository(t);
  repo.commit({
    "big.ts": text("big", 30_000),
    "same.ts": text("same", 30_000),
    "shrinks.ts": text("shrinks", 30_000),
    "moved.ts": text("moved", 30_000),
    "package-lock.json": "{}\n",
  });
  repo.git("switch", "--quiet", "--create", "work");
  repo.git("mv", "moved.ts", "elsewhere.ts");
  repo.commit({
    "same.ts": text("SAME", 30_000),
    "shrinks.ts": text("shrinks", 25_000),
    "limit.ts": text("limit", 20_000),
    "package-lock.json": text("lock", 50_000),
    "dist/app.js": text("app", 50_000),
    "icon.png": Buffer.alloc(50_000),
  });
  // Main shrinks big.ts after the work left it; the work's untouched copy is
  // not counted as growth.
  repo.git("switch", "--quiet", "main");
  repo.commit({ "big.ts": text("big", 25_000) });
  repo.git("switch", "--quiet", "work");

  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^No file over 5,000 tokens is new or larger/);
});

test("the check fails closed without a merge base to compare with", (t) => {
  const repo = repository(t);
  repo.commit({ "small.ts": text("small", 100) });
  const result = repo.check("origin/main");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No merge base with origin\/main/);
});

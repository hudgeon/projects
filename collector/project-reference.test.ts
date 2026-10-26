import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { command } from "./command";
import { configSchema } from "./config";
import { locateProject } from "./project-reference";

test("exact local project lookup follows moves and refuses missing or duplicate IDs", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "project-reference-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = configSchema.parse({ host: "laptop", root, home: root });
  const initial = path.join(root, "old-folder");
  await mkdir(initial);
  await command("git", ["init"], initial);
  await command(
    "git",
    ["remote", "add", "origin", "git@github.com:example/repository.git"],
    initial,
  );
  await writeFile(
    path.join(initial, ".project-overview.json"),
    JSON.stringify({ name: "Example", plan: "docs/PLAN.md" }),
  );
  const before = await locateProject(config, "example/repository");
  assert.equal(before.cwd, initial);
  assert.equal(before.plan, path.join(initial, "docs/PLAN.md"));
  assert.equal(before.host, "laptop");
  const moved = path.join(root, "renamed-folder");
  await rename(initial, moved);
  assert.equal((await locateProject(config, before.id)).cwd, moved);
  await assert.rejects(locateProject(config, "repository"), /not found/);
  await assert.rejects(
    locateProject(config, "Example/repository"),
    /not found/,
  );
  await writeFile(
    path.join(moved, ".project-overview.json"),
    JSON.stringify({ id: "stable-project", name: "Example" }),
  );
  assert.equal((await locateProject(config, "stable-project")).plan, null);
  await assert.rejects(locateProject(config, before.id), /not found/);
  const local = path.join(root, "local-only");
  await mkdir(local);
  await command("git", ["init"], local);
  await writeFile(path.join(local, ".project-overview.json"), "{}");
  assert.equal((await locateProject(config, "local/local-only")).cwd, local);
  const duplicate = path.join(root, "duplicate");
  await mkdir(duplicate);
  await command("git", ["init"], duplicate);
  await writeFile(
    path.join(duplicate, ".project-overview.json"),
    JSON.stringify({ id: "stable-project" }),
  );
  await assert.rejects(locateProject(config, "stable-project"), /Duplicate/);
});

// What .github/scripts/deployment-config.mjs leaves beside the identity it fills in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("the deployment keeps the weekly upkeep trigger beside the identity it fills in", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "projects-config-"));
  try {
    await writeFile(path.join(directory, "wrangler.jsonc"), await readFile("wrangler.jsonc", "utf8"));
    execFileSync(
      process.execPath,
      [path.resolve(".github/scripts/deployment-config.mjs")],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          PROJECTS_HOST: "projects.example.com",
          PROJECTS_PORTFOLIO: "example",
          PROJECTS_OWNER_EMAIL: "owner@example.com",
          PROJECTS_EMAIL_FROM: "sign-in@notify.example.com",
        },
        stdio: "pipe",
      },
    );
    const config = JSON.parse(await readFile(path.join(directory, "wrangler.jsonc"), "utf8"));
    assert.deepEqual(config.triggers, { crons: ["0 18 * * 5", "0 * * * *"] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

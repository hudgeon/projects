import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { claudeAuthStatus, upkeepAuth } from "./upkeep-auth";

test("Claude status exposes only readiness for the existing subscription", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-auth-"));
  const binary = path.join(dir, "claude");
  try {
    for (const [version, status, exit, expected] of [
      ["2.1.317", { loggedIn: true, authMethod: "claude.ai", email: "owner@example.com" }, 0, "ready"],
      ["2.1.322", { loggedIn: false, authMethod: "none" }, 1, "signed_out"],
      ["2.2.0", { loggedIn: false, authMethod: "none" }, 2, "unknown"],
      ["3.0.0", { loggedIn: true, authMethod: "api_key" }, 0, "unknown"],
      ["2.1.304", { loggedIn: false, authMethod: "none" }, 1, "unknown"],
    ] as const) {
      await writeFile(binary, `#!/bin/sh
if [ "$*" = "--version" ]; then echo '${version} (Claude Code)'; exit 0; fi
test "$*" = "auth status --json" || exit 3
printf '%s\\n' '${JSON.stringify(status)}'
exit ${exit}
`, { mode: 0o700 });
      assert.equal(await claudeAuthStatus(binary), expected);
    }
    assert.equal(await claudeAuthStatus(path.join(dir, "missing")), "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner polling shares one check and notices a renewed login on its next check", async () => {
  let now = 0, checks = 0;
  const readiness = upkeepAuth(async () => ++checks === 1 ? "signed_out" : "ready", () => now);
  assert.equal(readiness(), undefined);
  assert.equal(readiness(), undefined);
  assert.equal(checks, 1);
  await setImmediate();
  assert.equal(readiness(), "signed_out");
  now += 5 * 60_000;
  assert.equal(readiness(), "signed_out");
  await setImmediate();
  assert.equal(readiness(), "ready");
  now += 60_000;
  assert.equal(readiness(), "ready");
  assert.equal(checks, 2);
});

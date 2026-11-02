import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registeredUsers, readSupportUsers } from "./support-users";
import { mailHash } from "./mail-identity";
test("registered-user evidence is complete and fresh; its isolated command cannot inherit mailbox or service tokens", async () => {
  const now = Date.now(), payload = { complete: true, observedAt: now, hashes: [mailHash("customer@example.org")] };
  assert.equal(registeredUsers(JSON.stringify(payload), now).has(mailHash("customer@example.org")), true);
  for (const changed of [{ complete: false }, { observedAt: now - 60_001 }, { observedAt: now + 5001 }, { hashes: ["not-a-hash"] }])
    assert.throws(() => registeredUsers(JSON.stringify({ ...payload, ...changed }), now));
  const directory = await mkdtemp(path.join(tmpdir(), "support-users-"));
  const before = process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
  process.env.GOOGLE_WORKSPACE_CLI_TOKEN = "must-not-reach-directory";
  try {
    const program = "if(process.env.GOOGLE_WORKSPACE_CLI_TOKEN||process.env.COLLECTOR_TOKEN||process.env.DOPPLER_TOKEN)process.exit(1);process.stdout.write(" + JSON.stringify(JSON.stringify(payload)) + ")";
    assert.equal((await readSupportUsers([process.execPath, "-e", program], directory)).size, 1);
    await assert.rejects(readSupportUsers(undefined, directory), /not connected/);
    await assert.rejects(readSupportUsers([process.execPath, "-e", "process.stdout.write('{}')"], directory), /unavailable/);
  } finally {
    if (before === undefined) delete process.env.GOOGLE_WORKSPACE_CLI_TOKEN; else process.env.GOOGLE_WORKSPACE_CLI_TOKEN = before;
    await rm(directory, { recursive: true, force: true });
  }
});

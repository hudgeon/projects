import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownerAllowed, requiredSecretNames } from "./wrangler-config.mjs";
test("the deployment owner must be one of the allowed addresses, compared as the Worker compares them", async () => {
  assert.equal(ownerAllowed("Owner@Example.com", " ada@example.com, owner@example.com "), true);
  assert.equal(ownerAllowed("owner@example.com", "ada@example.com"), false);
  assert.equal(ownerAllowed("owner@example.com", "owner@example.com.au"), false);
  assert.equal(ownerAllowed("", "owner@example.com"), false);
  assert.equal(ownerAllowed(undefined, "owner@example.com"), false);
  assert.equal(ownerAllowed("owner@example.com", undefined), false);
  // The secrets file is written only when the owner the config names can sign
  // in. The script reads the wrangler config of its working directory, so the
  // check runs against a copy of this checkout's config naming the placeholder
  // owner, not the config Deploy has already filled in with the real one.
  const directory = await mkdtemp(path.join(tmpdir(), "projects-secrets-"));
  const output = path.join(directory, "secrets.json");
  const required = requiredSecretNames();
  await writeFile(
    path.join(directory, "wrangler.jsonc"),
    (await readFile("wrangler.jsonc", "utf8")).replace(/"OWNER_EMAIL":\s*"[^"]*"/, '"OWNER_EMAIL": "owner@example.com"'),
  );
  const build = (allowed) =>
    execFileSync(process.execPath, [path.resolve(".github/scripts/build-secrets-file.mjs"), output], {
      cwd: directory,
      env: { ...process.env, ...Object.fromEntries(required.map((name) => [name, "private-value"])), ALLOWED_EMAILS: allowed },
      stdio: "pipe",
    });
  try {
    let failure;
    try {
      build("ada@example.com");
    } catch (error) {
      failure = String(error.stderr);
    }
    assert.match(failure ?? "", /OWNER_EMAIL is not one of ALLOWED_EMAILS: add the deployment owner's address/);
    assert.doesNotMatch(failure ?? "", /example\.com|private-value/, "the message names no address or value");
    await assert.rejects(readFile(output), "a refused list writes no secrets file");
    // An empty list never skips the check: it fails as a missing secret first.
    try {
      build("");
      failure = "";
    } catch (error) {
      failure = String(error.stderr);
    }
    assert.match(failure, /Doppler supplied no value for: ALLOWED_EMAILS/);
    await assert.rejects(readFile(output));
    build("ada@example.com, Owner@Example.com");
    assert.deepEqual(Object.keys(JSON.parse(await readFile(output, "utf8"))).sort(), [...required].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

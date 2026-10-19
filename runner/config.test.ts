import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { installedRelease, invalidKeys, schema } from "./config";
import { fixture } from "./run-fixtures";

test("invalid keys name the key path, including a key this schema does not know, and never a value", () => {
  const result = schema.safeParse({
    host: "studio",
    root: "/srv/code",
    home: "/Users/owner",
    endpoint: "https://projects.example.com",
    concurrency: 9,
    projects: { "acme/secret-repo": { name: 42 } },
    helpers: { fullAccess: true, later: "a value" },
  });
  assert.equal(result.success, false);
  const keys = invalidKeys(result.error!.issues);
  assert.deepEqual(keys.sort(), ["concurrency", "helpers.later", "projects.*.name"]);
  assert.ok(!keys.join().includes("secret-repo"), "an owner's project id is not a key path");
  assert.deepEqual(invalidKeys(schema.safeParse("not an object").error!.issues), ["<root>"]);
});

test("the installed release is read from the record beside the bundle, and is nothing from sources", async () => {
  const dir = await fixture();
  try {
    const bundle = path.join(dir, "share/runner.mjs");
    await mkdir(path.dirname(bundle), { recursive: true });
    assert.equal(installedRelease(bundle), undefined);
    const commit = "0123456789abcdef0123456789abcdef01234567";
    await writeFile(path.join(dir, "share/release.json"), JSON.stringify({ commit, dirty: false }));
    assert.equal(installedRelease(bundle), "0123456789ab");
    await writeFile(path.join(dir, "share/release.json"), JSON.stringify({ commit, dirty: true }));
    assert.equal(installedRelease(bundle), "0123456789ab-dirty");
    await writeFile(path.join(dir, "share/release.json"), JSON.stringify({ commit: "../not-a-commit" }));
    assert.equal(installedRelease(bundle), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

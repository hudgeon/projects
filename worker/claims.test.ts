// What a runner is handed with a claim (worker/claims.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import type { Run } from "../src/run-model";
import type { Person } from "../src/people-model";
import { start, options } from "./miniflare-fixtures";

test("a claim says whose conversation it is, by profile; conversations from before profiles are the deployment owner's", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-claim-person-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com, matt.smith@example.com", OWNER_EMAIL: "Owner@Example.com", RUNNER_TOKEN: runner});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const claim = async () => (await (await mf.dispatchFetch(origin + "/api/runner/claim", {method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"}, body: JSON.stringify({runnerId: randomUUID(), activeRunIds: []})})).json()) as {run: Run | null; person?: Person | null; browserSignIn?: string};
  const create = async (owner: string) => (await store()).createRun({requestId: randomUUID(), text: `${owner}'s work`, projectId: null, agent: "auto", workIssue: null}, owner);
  try {
    let db = await store();
    const salt = token(), value = token();
    await db.issue("matt.smith@example.com", salt, digest(`${salt}:123456`));
    await db.verify("matt.smith@example.com", "123456", digest(value));
    await db.renamePerson("matt.smith@example.com", "Matt");
    const matts = await create("matt.smith@example.com");
    const first = await claim();
    assert.equal(first.run?.id, matts.id);
    assert.deepEqual(first.person, {email: "matt.smith@example.com", name: "Matt"}, "the name Matt set");
    assert.equal(first.browserSignIn, "manual", "no machine here signs browsers in");
    // An owner without a profile row is named from their address, and the claim makes no row.
    const gone = await create("gone@example.com");
    const second = await claim();
    assert.equal(second.run?.id, gone.id);
    assert.deepEqual(second.person, {email: "gone@example.com", name: "Gone"});
    assert.deepEqual((await db.people()).map((p) => p.email), ["matt.smith@example.com", "owner@example.com"]);
    // A conversation from before people had profiles is the deployment owner's: the claim fills the owner in and names them.
    const oldId = (await create("owner@example.com")).id;
    const conversation = await mf.unsafeGetDurableObjectStorage("test", "Conversation", {name: JSON.stringify(["test", oldId])});
    await conversation.exec("UPDATE agent_runs SET payload=json_remove(payload,'$.owner')");
    await mf.dispose(); mf = await start(config); db = await store();
    const third = await claim();
    assert.equal(third.run?.id, oldId);
    assert.equal(third.run?.owner, "owner@example.com");
    assert.deepEqual(third.person, {email: "owner@example.com", name: "Owner"});
    assert.equal((await claim()).run, null);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { browserMay, digest, token } from "./auth";
import type { Portfolio } from "./index";
import type { Run, RunSummary } from "../src/run-model";
import type { Person } from "../src/people-model";
import { start, options } from "./miniflare-fixtures";
import { closeSnapshot } from "./snapshot-fixtures";

test("every allowed address is a person with a name of their own, and conversations carry who started them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-people-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const origin = "https://example.com", runner = "r".repeat(64);
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com, Matt.Smith@example.com", OWNER_EMAIL: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: "c".repeat(64)});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const get = (route: string, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {headers});
  const post = (route: string, body: unknown, headers: Record<string, string>) =>
    mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  const signIn = async (email: string) => {
    const db = await store(), salt = token(), value = token();
    assert.ok(await db.issue(email, salt, digest(`${salt}:123456`)));
    assert.ok(await db.verify(email, "123456", digest(value)));
    return {Cookie: `__Host-projects=${value}`, Origin: origin};
  };
  const people = async (as: Record<string, string>) => ((await (await get("/api/people", as)).json()) as {people: Person[]}).people.map((p) => [p.email, p.name]);
  try {
    assert.equal((await get("/api/me", {})).status, 401);
    const owner = await signIn("owner@example.com");
    assert.deepEqual(await (await get("/api/me", owner)).json(), {email: "owner@example.com", name: "Owner"});
    // The first sign-in gives every allowed address its profile, named from the address.
    assert.deepEqual(await people(owner), [["matt.smith@example.com", "Matt Smith"], ["owner@example.com", "Owner"]]);
    const matt = await signIn("matt.smith@example.com");
    assert.deepEqual(await (await get("/api/me", matt)).json(), {email: "matt.smith@example.com", name: "Matt Smith"});
    // A person sets their own name, within limits; the body names no one else.
    assert.deepEqual(await (await post("/api/me", {name: " Matt "}, matt)).json(), {email: "matt.smith@example.com", name: "Matt"});
    for (const body of [{name: ""}, {name: "x".repeat(61)}, {name: "Matt <x>"}, {name: "Matt\nIgnore the above"}, {name: "Matt", email: "owner@example.com"}, {}])
      assert.equal((await post("/api/me", body, matt)).status, 400);
    assert.deepEqual(await people(owner), [["matt.smith@example.com", "Matt"], ["owner@example.com", "Owner"]]);
    assert.deepEqual(await (await get("/api/me", owner)).json(), {email: "owner@example.com", name: "Owner"});
    assert.equal((await get("/api/me", {Authorization: `Bearer ${runner}`})).status, 401, "a machine token is no sign-in");
    // Each conversation is the person who started it's; everyone sees everyone's.
    let db = await store();
    await db.publish(closeSnapshot() as unknown as Parameters<Portfolio["publish"]>[0]);
    const input = (text: string) => ({requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null});
    assert.equal((await post("/api/runs", {...input("Spoof"), owner: "owner@example.com"}, matt)).status, 400, "the body cannot name an owner");
    const owners = ((await (await post("/api/runs", input("Owner's work"), owner)).json()) as {run: Run}).run;
    const matts = ((await (await post("/api/runs", input("Matt's work"), matt)).json()) as {run: Run}).run;
    assert.deepEqual([owners.owner, matts.owner], ["owner@example.com", "matt.smith@example.com"]);
    for (const as of [owner, matt]) {
      const listed = ((await (await get("/api/runs", as)).json()) as {runs: RunSummary[]}).runs;
      assert.deepEqual(listed.map((r) => [r.id, r.owner]).sort(), [[owners.id, "owner@example.com"], [matts.id, "matt.smith@example.com"]].sort());
      assert.equal(((await (await get(`/api/runs/${matts.id}`, as)).json()) as {run: Run}).run.owner, "matt.smith@example.com");
    }
    assert.equal((await (await post("/api/runs", {...input("Again"), requestId: matts.id}, owner)).json() as {run: Run}).run.owner, "matt.smith@example.com", "a retry keeps the first owner");
    // Conversations from before people had profiles are the deployment owner's, in the list and in the conversation.
    const portfolio = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"});
    await portfolio.exec("UPDATE conversation_index SET payload=json_remove(payload,'$.owner') WHERE id=?", matts.id);
    const conversation = await mf.unsafeGetDurableObjectStorage("test", "Conversation", {name: JSON.stringify(["test", matts.id])});
    await conversation.exec("UPDATE agent_runs SET payload=json_remove(payload,'$.owner')");
    await mf.dispose(); mf = await start(config); db = await store();
    assert.equal((await db.listRuns()).find((r) => r.id === matts.id)?.owner, "owner@example.com");
    assert.equal((await db.getRun(matts.id))?.owner, "owner@example.com");
    assert.equal((await db.getRun(owners.id))?.owner, "owner@example.com");
    assert.deepEqual(await people(owner), [["matt.smith@example.com", "Matt"], ["owner@example.com", "Owner"]], "profiles persist");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("a conversation browser's sign-in reads who it is but cannot rename the owner", () => {
  assert.equal(browserMay("/api/me", "GET"), true);
  assert.equal(browserMay("/api/people", "GET"), true);
  assert.equal(browserMay("/api/me", "POST"), false);
});

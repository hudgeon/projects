import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio, Conversation } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress, Run } from "../src/run-model";
import type { PortfolioView } from "../src/model";
import { sessionArchived } from "../src/archive-model";
import { start, options } from "./miniflare-fixtures";
import { archiveSnapshot } from "./snapshot-fixtures";

test("legacy conversations migrate exactly once into isolated objects, preserving native claims and feedback through restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-migrate-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir);
  let mf = await start(config);
  const db = async () => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    return ns.get(ns.idFromName("test")) as unknown as Portfolio;
  };
  const owner = randomUUID(),
    id = randomUUID();
  const old: Run = {
    id,
    projectId: null,
    agent: "auto",
    workIssue: 1112,
    generation: 2,
    state: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatAt: Date.now(),
    messages: [
      {
        id: randomUUID(),
        role: "user",
        text: "Original request",
        at: Date.now(),
      },
      {
        id: randomUUID(),
        role: "user",
        text: "Continue",
        at: Date.now(),
        delivery: "queued",
      },
    ],
    progress: {
      seq: 4,
      state: "running",
      summary: "Working",
      children: [],
      masterSessionId: randomUUID(),
    },
  };
  try {
    await (await db()).listRuns();
    const source = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {
      name: "test",
    });
    await source.exec(
      "INSERT INTO agent_runs(id,payload,owner,updated) VALUES(?,?,?,?)",
      id,
      JSON.stringify(old),
      owner,
      old.updatedAt,
    );
    await mf.dispose();
    mf = await start(config);
    let store = await db();
    assert.equal((await store.getRun(id))?.id, old.id);
    const destination = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Conversation",
      { name: JSON.stringify(["test", id]) },
    );
    assert.deepEqual(
      JSON.parse(
        (
          await destination.exec<{ payload: string }>(
            "SELECT payload FROM agent_runs",
          )
        )[0].payload,
      ),
      old,
    );
    assert.equal((await store.claimRun(owner, [], undefined, "studio"))?.id, id);
    assert.equal(await store.claimRun(randomUUID(), [], undefined, "studio"), null);
    const ns = await mf.getDurableObjectNamespace("CONVERSATIONS");
    const conversation = ns.get(
      ns.idFromName(JSON.stringify(["test", id])),
    ) as unknown as Conversation;
    // Repeating migration with an obsolete snapshot must not overwrite newer state.
    const feedback = {
      requestId: randomUUID(),
      text: "Keep the native session",
    };
    await store.messageRun(id, feedback);
    await conversation.initialize(old, owner);
    assert.equal(
      (await conversation.record())?.run.messages.at(-1)?.id,
      feedback.requestId,
    );
    const other = await store.createRun({
      requestId: randomUUID(),
      text: "Independent",
      projectId: null,
      agent: "auto",
      workIssue: null,
    });
    const isolated = ns.get(
      ns.idFromName(JSON.stringify(["test", other.id])),
    ) as unknown as Conversation;
    assert.equal((await isolated.record())?.run.messages.length, 1);
    assert.equal((await conversation.record())?.run.messages.length, 3);
    const migrated = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Portfolio",
      { name: "test" },
    );
    assert.equal((await migrated.exec("SELECT * FROM agent_runs")).length, 0);
    await mf.dispose();
    mf = await start(config);
    store = await db();
    assert.equal(
      (await store.getRun(id))?.progress?.masterSessionId,
      old.progress!.masterSessionId,
    );
    assert.equal((await store.getRun(id))?.messages.at(-1)?.delivery, "queued");
    assert.equal((await store.claimRun(owner, [], undefined, "studio"))?.id, id);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive choices require browser authorization and survive snapshot replacement, machine changes and restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-archive-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const collector = "c".repeat(64), runner = "r".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", COLLECTOR_TOKEN: collector, RUNNER_TOKEN: runner});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const post = (body: unknown, headers: Record<string, string> = {}) => mf.dispatchFetch(origin + "/api/archive", {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  try {
    let db = await store();
    const salt = token(), value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = {Cookie: `__Host-projects=${value}`, Origin: origin};
    const snapshot = archiveSnapshot("studio");
    await db.publish(snapshot);
    await db.publish(archiveSnapshot("laptop"));
    const session = {kind: "session", host: "studio", app: "Codex", sessionId: "shared-session"} as const;
    const project = {kind: "project", projectId: "acme/fixture"} as const;
    const input = {target: session, archived: true};
    const unauthorized: Record<string, string>[] = [{}, {Authorization: `Bearer ${collector}`}, {Authorization: `Bearer ${runner}`}];
    for (const headers of unauthorized)
      assert.equal((await post(input, {Origin: origin, ...headers})).status, 401);
    assert.equal((await post(input, {Cookie: browser.Cookie})).status, 403);
    assert.equal((await post(input, {...browser, Origin: "https://elsewhere.example"})).status, 403);
    assert.equal((await post({...input, arbitrary: "no"}, browser)).status, 400);
    assert.equal((await post({target: {...project, projectId: "unknown/project"}, archived: true}, browser)).status, 404);
    assert.equal((await post(input, browser)).status, 200);
    const first = await db.archives();
    assert.equal((await post(input, browser)).status, 200);
    assert.deepEqual(await db.archives(), first, "retries keep the original archive receipt");
    assert.equal(sessionArchived(first, "studio", "Codex", "shared-session"), true);
    assert.equal(sessionArchived(first, "laptop", "Codex", "shared-session"), false);
    assert.equal(sessionArchived(first, "studio", "Claude", "shared-session"), false);
    assert.equal((await post({target: project, archived: true}, browser)).status, 200);
    assert.deepEqual((await db.overview()).find((s) => s.host === "studio"), snapshot, "archive does not rewrite collector evidence");
    const refreshed = archiveSnapshot("studio", snapshot.collectedAt + 100);
    refreshed.projects[0].name = "Renamed fixture";
    refreshed.projects[0].sessions[0].cwd = "/moved/project";
    await db.publish(refreshed);
    const saved = await db.archives();
    await mf.dispose();
    mf = await start(config);
    db = await store();
    const view = await (await mf.dispatchFetch(origin + "/api/overview", {headers: browser})).json() as PortfolioView;
    assert.deepEqual(view.archives, saved);
    assert.equal(view.snapshots.find((s) => s.host === "studio")!.projects[0].name, "Renamed fixture");
    await db.publish({...refreshed, collectedAt: refreshed.collectedAt + 100, projects: []});
    assert.equal((await post({target: session, archived: false}, browser)).status, 200, "restore remains possible after an item disappears from inventory");
    assert.equal((await post({target: project, archived: false}, browser)).status, 200);
    assert.deepEqual(await db.archives(), []);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test("conversation archives preserve active claims, receipts and history, with project filtering and legacy-index recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-conversation-archive-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const runner = "r".repeat(64), collector = "c".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: collector});
  let mf = await start(config);
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  try {
    let db = await store();
    const salt = token(), value = token();
    await db.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await db.verify("owner@example.com", "123456", digest(value));
    const browser = {Cookie: `__Host-projects=${value}`, Origin: origin};
    const run: Run = JSON.parse(JSON.stringify(await db.createRun({requestId: randomUUID(), text: "Inspect and keep history", projectId: null, agent: "auto", workIssue: null})));
    const owner = randomUUID();
    const claimed: Run = JSON.parse(JSON.stringify(await db.claimRun(owner, [], undefined, "studio")));
    const child = {id: randomUUID(), projectId: "acme/chosen", agent: "codex" as const, mode: "read" as const, cwd: "/fixture", branch: "main", sessionId: randomUUID(), state: "running" as const, result: null, evidence: []};
    const progress: Progress = {seq: 1, state: "running", summary: "Inspecting", children: [child], masterSessionId: randomUUID()};
    const route = origin + `/api/runs/${run.id}/archive`;
    const archive = (archived: boolean, headers: Record<string, string> = browser) => mf.dispatchFetch(route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify({archived})});
    const unauthorized: Record<string, string>[] = [{}, {Authorization: `Bearer ${runner}`}, {Authorization: `Bearer ${collector}`}];
    for (const headers of unauthorized)
      assert.equal((await archive(true, {Origin: origin, ...headers})).status, 401);
    assert.equal((await archive(true, {Cookie: browser.Cookie})).status, 403);
    const [archived, reported] = await Promise.all([archive(true), db.reportRun(owner, run.id, run.generation, progress, "studio")]);
    assert.equal(archived.status, 200);
    assert.equal(reported, true);
    const kept = (await db.getRun(run.id))!;
    assert.ok(kept.archivedAt);
    assert.equal(kept.state, "running");
    assert.equal(kept.generation, claimed.generation);
    assert.deepEqual(kept.messages, claimed.messages);
    assert.deepEqual(kept.progress, progress);
    assert.deepEqual(await db.listRuns(), []);
    assert.deepEqual((await db.listRuns({archived: true, projectId: child.projectId})).map((r) => r.id), [run.id]);
    assert.equal((await db.claimRun(owner, [], undefined, "studio"))!.id, run.id);
    assert.equal(await db.claimRun(randomUUID(), [], undefined, "studio"), null);
    assert.deepEqual((await db.getRun(run.id))!.messages, claimed.messages);
    assert.equal(await db.reportRun(owner, run.id, run.generation, {...progress, seq: 2, state: "completed", children: [{...child, state: "completed"}]}, "studio"), true);
    assert.ok((await db.getRun(run.id))!.archivedAt, "a later receipt cannot unarchive the conversation");
    // Existing pre-feature directory summaries do not contain selected child projects.
    const storage = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"});
    // ...nor the list title and status line added later.
    await storage.exec("UPDATE conversation_index SET payload=json_set(json_remove(payload,'$.projectIds','$.status'),'$.title',?) WHERE id=?", "x".repeat(160), run.id);
    await mf.dispose();
    mf = await start(config);
    db = await store();
    assert.deepEqual((await db.listRuns({archived: true, projectId: child.projectId})).map((r) => [r.projectIds, r.title, r.status]), [[[child.projectId], "Inspect and keep history", "Inspecting"]]);
    assert.equal((await db.getRun(run.id))!.messages.length, 2, "history survives archive and restart");
    assert.equal((await archive(false)).status, 200);
    const restored = (await db.getRun(run.id))!;
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.generation, claimed.generation);
    for (let i = 0; i < 51; i++) {
      const newer = await db.createRun({requestId: randomUUID(), text: `Other conversation ${i}`, projectId: "acme/other", agent: "auto", workIssue: null});
      await db.cancelRun(newer.id);
    }
    assert.equal((await db.listRuns()).length, 50);
    const filtered = await (await mf.dispatchFetch(origin + `/api/runs?projectId=${encodeURIComponent(child.projectId)}`, {headers: browser})).json() as {runs: {id: string}[]; nextOffset: number | null};
    assert.deepEqual(filtered.runs.map((r) => r.id), [run.id], "project filtering happens before the history limit");
    assert.equal(filtered.nextOffset, null);
    assert.equal((await db.listRuns({offset: 50})).length, 2);
    assert.equal((await mf.dispatchFetch(origin + "/api/runs?offset=-1", {headers: browser})).status, 400);
    // Done is a visibility choice: the user's own follow-up brings it back, once.
    assert.equal((await archive(true)).status, 200);
    const followUp = {requestId: randomUUID(), text: "Continue after Done"};
    const sent = async () => mf.dispatchFetch(origin + `/api/runs/${run.id}/message`, {
      method: "POST", headers: {...browser, "Content-Type": "application/json"},
      body: JSON.stringify(followUp),
    });
    assert.equal((await sent()).status, 200);
    assert.equal((await sent()).status, 200, "a retried follow-up is idempotent");
    const followed = (await db.getRun(run.id))!;
    assert.equal(followed.archivedAt, null);
    assert.equal(followed.generation, run.generation + 1);
    assert.equal(followed.state, "queued");
    assert.equal(followed.messages.filter((m) => m.id === followUp.requestId).length, 1);
    assert.deepEqual((await db.listRuns()).map((r) => r.id).includes(run.id), true);
    assert.equal((await archive(true)).status, 200);
    assert.equal((await db.claimRun(owner, [], undefined, "studio"))!.id, run.id, "archiving queued work does not silently cancel it");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

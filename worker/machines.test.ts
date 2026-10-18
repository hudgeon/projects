import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Run } from "../src/run-model";
import type { PortfolioView } from "../src/model";
import { start, options } from "./miniflare-fixtures";
import { closeSnapshot, inboxSnapshot, archiveSnapshot } from "./snapshot-fixtures";

test("machines join from the site; each token acts only as its machine, in the owner's order, until replaced or removed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-machines-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const origin = "https://example.com";
  const mf = await start(await options(script, dir, {ALLOWED_EMAILS: "owner@example.com"}));
  const store = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  const bearer = (value: string) => ({Authorization: `Bearer ${value}`});
  const post = (route: string, body: unknown, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  const get = (route: string, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {headers});
  type Added = {machine: string; tokens: {collector: string; runner: string}; machines: {id: string; name: string; duties: boolean}[]};
  const snapshot = (host: string, at = Date.now()) => ({version: 1, host, collectedAt: at, projects: [], unassignedSessions: []});
  const claim = async (token: string, runnerId: string) => {
    const response = await post("/api/runner/claim", {runnerId, activeRunIds: []}, bearer(token));
    assert.equal(response.status, 200);
    return (await response.json() as {run: Run | null}).run;
  };
  try {
    const salt = token(), cookie = token();
    await (await store()).issue("owner@example.com", salt, digest(`${salt}:123456`));
    await (await store()).verify("owner@example.com", "123456", digest(cookie));
    const owner = {Cookie: `__Host-projects=${cookie}`, Origin: origin};
    assert.deepEqual(((await (await get("/api/machines", owner)).json()) as {machines: unknown[]}).machines, []);
    assert.equal((await post("/api/runs", {requestId: randomUUID(), text: "Too early", projectId: null, agent: "auto", workIssue: null}, owner)).status, 503, "conversations wait for a machine");
    const studio = (await (await post("/api/machines", {name: "Studio"}, owner)).json()) as Added;
    const laptop = (await (await post("/api/machines", {name: "Laptop"}, owner)).json()) as Added;
    assert.deepEqual([studio.machine, laptop.machine], ["studio", "laptop"]);
    assert.deepEqual(laptop.machines.map((m) => m.name), ["Studio", "Laptop"]);
    assert.equal(((await (await post("/api/machines", {name: "Studio"}, owner)).json()) as Added).machine, "studio-2", "names repeat; ids stay unique");
    assert.equal((await post("/api/machines/studio-2/remove", {}, owner)).status, 200);
    // A machine publishes only its own snapshot, and its tokens reach no session route.
    assert.equal((await post("/api/ingest", snapshot("studio"), bearer(studio.tokens.collector))).status, 200);
    assert.equal((await post("/api/ingest", snapshot("laptop"), bearer(studio.tokens.collector))).status, 403);
    assert.equal((await post("/api/ingest", snapshot("studio", Date.now() + 1), bearer(studio.tokens.runner))).status, 401, "a runner token is not a collector token");
    assert.equal((await get("/api/overview", bearer(studio.tokens.collector))).status, 401);
    assert.equal((await post("/api/ingest", snapshot("laptop"), bearer(laptop.tokens.collector))).status, 200);
    const duties = async (value: string) => ((await (await get("/api/collector/duties", bearer(value))).json()) as {duties: boolean}).duties;
    assert.deepEqual([await duties(studio.tokens.collector), await duties(laptop.tokens.collector)], [true, false], "the first machine in order is on duty");
    // New conversations go to the first machine present; a claim stays with its machine.
    const studioRunner = randomUUID();
    assert.equal(await claim(studio.tokens.runner, studioRunner), null);
    const created = (await (await post("/api/runs", {requestId: randomUUID(), text: "Inspect", projectId: null, agent: "auto", workIssue: null}, owner)).json()) as {run: Run};
    assert.equal(await claim(laptop.tokens.runner, studioRunner), null, "the laptop waits while the studio is present, even reusing its runner ID");
    const taken = (await claim(studio.tokens.runner, studioRunner))!;
    assert.deepEqual([taken.id, taken.host], [created.run.id, "studio"]);
    assert.equal((await post("/api/runner/heartbeat", {runnerId: studioRunner, id: taken.id, generation: 1}, bearer(laptop.tokens.runner))).status, 409, "another machine cannot act on its claim");
    // The owner's order decides duties.
    assert.equal((await post("/api/machines/laptop", {position: 0}, owner)).status, 200);
    assert.deepEqual([await duties(studio.tokens.collector), await duties(laptop.tokens.collector)], [false, true]);
    const view = (await (await get("/api/overview", {Cookie: owner.Cookie})).json()) as PortfolioView;
    assert.deepEqual(view.machines?.map((m) => [m.id, m.name, m.duties]), [["laptop", "Laptop", true], ["studio", "Studio", false]]);
    // Replaced tokens stop at once; a removed machine's tokens and snapshot go too.
    const replaced = (await (await post("/api/machines/studio/tokens", {}, owner)).json()) as Added;
    assert.equal((await post("/api/ingest", snapshot("studio", Date.now() + 2), bearer(studio.tokens.collector))).status, 401);
    assert.equal((await post("/api/ingest", snapshot("studio", Date.now() + 3), bearer(replaced.tokens.collector))).status, 200);
    assert.equal((await post("/api/machines/laptop", {name: "Old laptop"}, owner)).status, 200);
    assert.equal((await post("/api/machines/laptop/remove", {}, owner)).status, 200);
    assert.equal((await get("/api/collector/duties", bearer(laptop.tokens.collector))).status, 401);
    const after = (await (await get("/api/overview", {Cookie: owner.Cookie})).json()) as PortfolioView;
    assert.deepEqual([after.machines?.map((m) => m.id), after.snapshots.map((s) => s.host)], [["studio"], ["studio"]]);
    assert.equal((await post("/api/machines", {name: "   "}, owner)).status, 400);
    assert.equal((await post("/api/machines", {name: "Laptop"}, {Cookie: owner.Cookie, Origin: "https://elsewhere.example"})).status, 403, "only this page can add a machine");
  } finally {
    await mf.dispose();
    await rm(dir, {recursive: true, force: true});
  }
});

test("real Durable Object rejects older snapshots and keeps host state through restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-test-"));
  const script = path.join(dir, "local.mjs");
  await build({
    entryPoints: ["worker/local.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir, { COLLECTOR_TOKEN: "x".repeat(64), LAPTOP_COLLECTOR_TOKEN: "y".repeat(64) });
  let mf = await start(config);
  const now = Date.now();
  const post = (host: string, at: number, extra = {}) =>
    mf.dispatchFetch("http://127.0.0.1/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        host,
        collectedAt: at,
        projects: [],
        unassignedSessions: [],
        ...extra,
      }),
    });
  try {
    assert.equal((await post("studio", now)).status, 200);
    assert.equal((await post("studio", now - 1)).status, 409);
    assert.equal((await post("laptop", now)).status, 200);
    assert.equal((await post("unknown", now)).status, 400);
    assert.equal((await post("studio", now + 7200_000)).status, 400);
    assert.equal(
      (await post("studio", now + 1, { unexpected: "private data" })).status,
      400,
    );
    await mf.dispose();
    mf = await start(config);
    const data = (await (
      await mf.dispatchFetch("http://127.0.0.1/api/overview")
    ).json()) as { snapshots: { host: string; collectedAt: number }[] };
    assert.deepEqual(
      data.snapshots.map((s) => s.host),
      ["laptop", "studio"],
    );
    assert.equal(data.snapshots[1].collectedAt, now);
    assert.equal(
      (
        await mf.dispatchFetch("http://127.0.0.1/api/delete", {
          method: "POST",
        })
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("the Laptop's collector publishes for itself and takes the Studio's duties only while the Studio is away", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-laptop-collector-"));
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: path.join(dir, "worker.mjs") });
  const studio = {Authorization: `Bearer ${"x".repeat(64)}`}, laptop = {Authorization: `Bearer ${"y".repeat(64)}`};
  const mf = await start(await options(path.join(dir, "worker.mjs"), dir, { ALLOWED_EMAILS: "owner@example.com", COLLECTOR_TOKEN: "x".repeat(64), LAPTOP_COLLECTOR_TOKEN: "y".repeat(64) }));
  const origin = "https://example.com";
  const get = async (route: string, headers: Record<string, string>) => mf.dispatchFetch(origin + route, {headers});
  const ingest = (snapshot: object, headers: Record<string, string>) => mf.dispatchFetch(`${origin}/api/ingest`, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(snapshot)});
  const duties = async () => ((await (await get("/api/collector/duties", laptop)).json()) as {duties: boolean}).duties;
  const closes = async (headers: Record<string, string>) => ((await (await get("/api/closes", headers)).json()) as {closes: {issue: number}[]}).closes.map((c) => c.issue);
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const salt = token(), value = token();
    await store.issue("owner@example.com", salt, digest(`${salt}:123456`));
    await store.verify("owner@example.com", "123456", digest(value));
    const signed = {Cookie: `__Host-projects=${value}`, Origin: origin, "Content-Type": "application/json"};
    assert.equal((await ingest(inboxSnapshot(), studio)).status, 200);
    assert.equal((await mf.dispatchFetch(`${origin}/api/work/close`, {method: "POST", headers: signed, body: JSON.stringify({issue: 7})})).status, 200);
    assert.equal(await duties(), false, "the Studio is present");
    assert.deepEqual(await closes(laptop), [], "requests go to the machine on duty");
    assert.deepEqual(await closes(studio), [7]);
    assert.equal((await ingest(closeSnapshot(), laptop)).status, 403, "the Laptop cannot publish the Studio's snapshot");
    assert.equal((await ingest({...archiveSnapshot("laptop"), work: closeSnapshot().work}, laptop)).status, 200);
    assert.equal((await ingest(archiveSnapshot("laptop", Date.now() + 1000), studio)).status, 403, "a machine publishes only its own snapshot");
    assert.equal((await mf.dispatchFetch(`${origin}/api/review`, {method: "POST", headers: {...laptop, "Content-Type": "application/json"}, body: "{}"})).status, 410, "daily publication is retired for every machine regardless of duty");
    assert.equal((await get("/api/overview", laptop)).status, 401, "the Laptop's bearer reads nothing");
    // Five minutes without a publish from the Studio's collector.
    await (await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"})).exec("UPDATE collector_contact SET at=? WHERE host='studio'", Date.now() - 5 * 60_000);
    assert.equal(await duties(), true);
    assert.deepEqual(await closes(laptop), [7]);
    const inbox = {...inboxSnapshot().inbox, observedAt: Date.now() + 1000};
    assert.equal((await ingest({...archiveSnapshot("laptop", Date.now() + 1000), work: closeSnapshot().work, inbox}, laptop)).status, 200);
    const view = (await (await get("/api/overview", {Cookie: signed.Cookie})).json()) as PortfolioView;
    assert.equal(view.snapshots.find((s) => s.inbox?.observedAt === inbox.observedAt)?.host, "laptop", "the Laptop's inbox read is the newest");
    assert.equal((await ingest(closeSnapshot(Date.now() + 2000), studio)).status, 200);
    assert.equal(await duties(), false, "the Studio takes its duties back as soon as it publishes");
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

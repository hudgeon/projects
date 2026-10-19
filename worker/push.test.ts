import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Response as MockResponse } from "miniflare";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";

test("a person's devices are woken, without content, when a conversation of theirs becomes their move", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-push-"));
  const script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const { privateKey } = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
  const runner = "r".repeat(64), collector = "c".repeat(64), origin = "https://example.com";
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com, matt.smith@example.com", OWNER_EMAIL: "owner@example.com", RUNNER_TOKEN: runner, COLLECTOR_TOKEN: collector, VAPID_PRIVATE_KEY: JSON.stringify({kty, crv, x, y, d})});
  const pushes: {url: string; auth: string; body: string}[] = [];
  let status = 201;
  config.workers![0].dev = {outboundService: {type: "fetcher", handler: async (request) => {
    pushes.push({url: request.url, auth: request.headers.get("Authorization") ?? "", body: await request.text()});
    return new MockResponse(null, {status});
  }}};
  const mf = await start(config);
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 60 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(check());
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const signIn = async (email: string) => {
      const salt = token(), value = token();
      await db.issue(email, salt, digest(`${salt}:123456`));
      await db.verify(email, "123456", digest(value));
      return {Cookie: `__Host-projects=${value}`, Origin: origin};
    };
    const owner = await signIn("owner@example.com"), matt = await signIn("matt.smith@example.com");
    const call = (route: string, body?: object, headers: Record<string, string> = owner) =>
      mf.dispatchFetch(origin + route, body ? {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)} : {headers});
    const events = async (as = owner) => ((await (await call("/api/push/events", undefined, as)).json()) as {events: {id: string; title: string; body: string; url: string}[]}).events;
    assert.equal((await call("/api/push/key", undefined, {})).status, 401);
    assert.equal((await call("/api/push/key", undefined, {Authorization: `Bearer ${collector}`})).status, 401, "the collector cannot reach notifications");
    const {key} = (await (await call("/api/push/key")).json()) as {key: string};
    assert.match(key, /^B[A-Za-z0-9_-]{86}$/);
    assert.equal((await call("/api/push/subscribe", {endpoint: "https://evil.example/push"})).status, 400, "only browser push services");
    assert.equal((await call("/api/push/subscribe", {endpoint: "https://web.push.apple.com/QGc2V0LXRva2Vu"}, {Cookie: owner.Cookie})).status, 403, "same-origin only");
    const laptop = "https://web.push.apple.com/QGc2V0LXRva2Vu", phone = "https://fcm.googleapis.com/fcm/send/bWF0dA";
    assert.equal((await call("/api/push/subscribe", {endpoint: laptop})).status, 200);
    await waitFor(() => pushes.length === 1);
    assert.deepEqual([pushes[0].url, pushes[0].body], [laptop, ""], "the push carries nothing");
    assert.match(pushes[0].auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);
    assert.deepEqual((await events()).map((e) => [e.title, e.url]), [["Notifications are on", "/"]]);
    assert.deepEqual(await events(matt), [], "the test notice is the subscriber's alone");
    assert.equal((await call("/api/push/subscribe", {endpoint: laptop})).status, 200);
    await settle();
    assert.equal(pushes.length, 1, "opening Projects again sends no second test");
    // A second person's device gets its own test notice, and only that device.
    assert.equal((await call("/api/push/subscribe", {endpoint: phone}, matt)).status, 200);
    await waitFor(() => pushes.length === 2);
    assert.equal(pushes[1].url, phone);
    assert.deepEqual((await events(matt)).map((e) => e.title), ["Notifications are on"]);
    assert.equal((await events()).length, 1);
    const finish = async (text: string, person: string) => {
      await db.createRun({requestId: randomUUID(), text, projectId: null, agent: "auto", workIssue: null}, person);
      const slot = randomUUID();
      const run = (await db.claimRun(slot, [], undefined, "studio"))!;
      const report = (progress: Progress) => mf.dispatchFetch(origin + "/api/runner/report", {
        method: "POST", headers: {Authorization: `Bearer ${runner}`, "Content-Type": "application/json"},
        body: JSON.stringify({runnerId: slot, id: run.id, generation: run.generation, progress}),
      });
      const running: Progress = {seq: 1, state: "running", title: `${text} about training`, summary: "Asked Codex to draft it.", children: [], masterSessionId: null};
      assert.equal((await report(running)).status, 200);
      assert.equal((await report({...running, seq: 2, state: "completed", reviewedMessageIds: [run.id], summary: `Drafted the ${text.toLowerCase()}. **Your move:** send it.`})).status, 200);
      return run.id;
    };
    // A conversation becoming its owner's move wakes that person's devices only,
    // and only that person's notices show it.
    const matts = await finish("Reply to Rob", "matt.smith@example.com");
    await waitFor(() => pushes.length === 3);
    assert.equal(pushes[2].url, phone);
    assert.deepEqual((await events(matt))[0], {...(await events(matt))[0], title: "Ready: Reply to Rob about training", body: "Drafted the reply to rob.", url: `/?run=${matts}`});
    assert.deepEqual((await events()).map((e) => e.url), ["/"], "the first person hears nothing of it");
    await settle();
    assert.equal(pushes.length, 3);
    const owners = await finish("Reply to Ben", "owner@example.com");
    await waitFor(() => pushes.length === 4);
    assert.equal(pushes[3].url, laptop);
    assert.deepEqual((await events()).map((e) => e.url), [`/?run=${owners}`, "/"]);
    assert.deepEqual((await events(matt)).map((e) => e.url), [`/?run=${matts}`, "/"]);
    // Devices and notices from before people had profiles are the deployment owner's.
    const storage = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", {name: "test"});
    const legacy = "https://updates.push.services.mozilla.com/wpush/v2/gAAAA";
    await storage.exec("INSERT INTO push_devices(endpoint,created,used,email) VALUES(?,1,1,NULL)", legacy);
    await storage.exec("INSERT INTO push_events(id,run,title,body,at,email) VALUES('older',NULL,'Ready: Older work','Done earlier.',?,NULL)", Date.now());
    assert.equal((await events())[0].id, "older");
    assert.equal((await events(matt)).some((e) => e.id === "older"), false);
    await finish("Reply to Phil", "owner@example.com");
    await waitFor(() => pushes.length === 6);
    assert.deepEqual(pushes.slice(4).map((p) => p.url).sort(), [laptop, legacy].sort());
    // Unsubscribing forgets only the caller's own device, legacy ones included.
    assert.equal((await call("/api/push/unsubscribe", {endpoint: laptop}, matt)).status, 200);
    assert.equal((await call("/api/push/unsubscribe", {endpoint: legacy}, matt)).status, 200);
    await finish("Reply to Sam", "owner@example.com");
    await waitFor(() => pushes.length === 8);
    assert.deepEqual(pushes.slice(6).map((p) => p.url).sort(), [laptop, legacy].sort(), "another person cannot forget them");
    assert.equal((await call("/api/push/unsubscribe", {endpoint: laptop})).status, 200);
    assert.equal((await call("/api/push/unsubscribe", {endpoint: legacy})).status, 200);
    await finish("Reply to Kim", "owner@example.com");
    await settle();
    assert.equal(pushes.length, 8, "the owner's devices are forgotten");
    // A subscription the browser dropped is forgotten after one attempt.
    status = 410;
    await finish("Reply to Jo", "matt.smith@example.com");
    await waitFor(() => pushes.length === 9);
    assert.equal(pushes[8].url, phone);
    status = 201;
    await finish("Reply to Lee", "matt.smith@example.com");
    await settle();
    assert.equal(pushes.length, 9);
    // Ten devices a person, the most recently opened; another person's stay.
    await db.subscribePush(laptop, "owner@example.com");
    for (let i = 0; i < 11; i++) await db.subscribePush(`https://web.push.apple.com/matt-${i}`, "matt.smith@example.com");
    const devices = async (email: string) =>
      ((await storage.exec("SELECT endpoint FROM push_devices WHERE email=? ORDER BY endpoint", email)) as {endpoint: string}[]).map((d) => d.endpoint);
    assert.deepEqual(await devices("owner@example.com"), [laptop]);
    const kept = await devices("matt.smith@example.com");
    assert.equal(kept.length, 10);
    assert.equal(kept.includes("https://web.push.apple.com/matt-0"), false, "the oldest goes");
    assert.equal(kept.includes(phone), false, "the oldest goes");
    assert.equal(kept.includes("https://web.push.apple.com/matt-10"), true);
  } finally { await mf.dispose(); await rm(dir, {recursive: true, force: true}); }
});

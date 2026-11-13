import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { INVESTIGATE_HEADER, type Run, type RunInput } from "../src/run-model";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { options, start } from "./miniflare-fixtures";
import { archiveSnapshot } from "./snapshot-fixtures";

test("Investigate is opt-in, private and requires a capable runner on first claim and recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-investigate-test-"));
  const script = path.join(dir, "worker.mjs");
  const runner = "r".repeat(64), owner = "owner@example.com", other = "other@example.com";
  const origin = "https://example.com", runnerId = randomUUID();
  await build({entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const mf = await start(await options(script, dir, {
    ALLOWED_EMAILS: [owner, other].join(","), OWNER_EMAIL: owner, RUNNER_TOKEN: runner,
  }));
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    await store.publish(archiveSnapshot("studio"));
    const signIn = async (email: string) => {
      const salt = token(), value = token();
      await store.issue(email, salt, digest(`${salt}:123456`));
      assert.ok(await store.verify(email, "123456", digest(value)));
      return {Cookie: `__Host-projects=${value}`, Origin: origin};
    };
    const signed = await signIn(owner), guest = await signIn(other);
    const get = (route: string, headers = signed) => mf.dispatchFetch(origin + route, {headers});
    const post = (route: string, data: unknown, headers: Record<string, string> = signed) =>
      mf.dispatchFetch(origin + route, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(data)});
    const claim = async (supports: boolean, lanes = ["standard"], activeRunIds: string[] = []) => {
      const response = await post("/api/runner/claim", {runnerId, lanes, activeRunIds}, {
        Authorization: `Bearer ${runner}`, ...(supports ? {[INVESTIGATE_HEADER]: "1"} : {}),
      });
      assert.equal(response.status, 200);
      return (await response.json() as {run: Run | null}).run;
    };
    const image = {
      id: randomUUID(), mime: "image/png" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    };
    const input: RunInput = {requestId: randomUUID(), text: "Check the records", projectId: "acme/fixture",
      agent: "claude", workIssue: null, lane: "investigate", screenshots: [image]};
    assert.equal((await post("/api/runs", input, guest)).status, 403);
    for (const invalid of [{projectId: null}, {agent: "auto"}, {emailThread: "0123456789"}])
      assert.equal((await post("/api/runs", {...input, ...invalid})).status, 400);
    assert.equal((await post("/api/runs", input)).status, 200);
    const route = `/api/runs/${input.requestId}`;
    assert.equal((await get(route)).status, 200);
    assert.equal((await get(`${route}/screenshots/${image.id}`)).status, 200);
    assert.equal((await get(route, guest)).status, 404);
    assert.equal((await get(`${route}/screenshots/${image.id}`, guest)).status, 404);
    assert.equal((await post(`${route}/message`, {requestId: randomUUID(), text: "Follow up"}, guest)).status, 404);
    assert.equal((await post("/api/runs", {...input, lane: undefined}, guest)).status, 409);
    assert.equal((await post(`${route}/move`, {})).status, 409);
    const list = async (headers: typeof signed) => (await (await get("/api/runs", headers)).json()) as {investigate: boolean; runs: Run[]};
    assert.equal((await list(signed)).investigate, true);
    assert.deepEqual(await list(guest).then(v => [v.investigate, v.runs.length]), [false, 0]);

    assert.equal(await claim(false), null);
    assert.equal(await claim(true, []), null);
    assert.equal((await claim(true))?.id, input.requestId);
    assert.equal(await claim(false), null, "old runners cannot recover an active reservation");
    const standard = {...input, requestId: randomUUID(), agent: "auto", lane: undefined, screenshots: []};
    assert.equal((await post("/api/runs", standard)).status, 200);
    assert.equal((await claim(false))?.id, standard.requestId, "a reserved investigation does not stop ordinary claims");
    assert.equal((await claim(true, ["standard"], [standard.requestId]))?.id, input.requestId);
    assert.equal((await store.getRun(standard.requestId))?.lane, undefined);
  } finally {
    await mf.dispose();
    await rm(dir, {recursive: true, force: true});
  }
});

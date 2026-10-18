import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import type { Close } from "../src/work-model";
import { applyCloses } from "../collector/close";
import { issue } from "../tests/work-fixtures";
import { start, options } from "./miniflare-fixtures";
import { closeSnapshot } from "./snapshot-fixtures";

test("Mark done needs a same-origin session; the upload token only exchanges close requests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-close-"));
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: path.join(dir, "worker.mjs"),
  });
  const bearer = `Bearer ${"x".repeat(64)}`;
  const mf = await start(
    await options(path.join(dir, "worker.mjs"), dir, {
      ALLOWED_EMAILS: "owner@example.com",
      COLLECTOR_TOKEN: "x".repeat(64),
    }),
  );
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const salt = token(),
      value = token();
    await store.issue("owner@example.com", salt, digest(`${salt}:123456`));
    assert.equal(
      await store.verify("owner@example.com", "123456", digest(value)),
      true,
    );
    const session = `__Host-projects=${value}`;
    const origin = "https://example.com";
    await store.publish(
      closeSnapshot() as unknown as Parameters<Portfolio["publish"]>[0],
    );
    const close = (number: unknown, headers: Record<string, string> = {}) =>
      mf.dispatchFetch(`${origin}/api/work/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ issue: number }),
      });
    assert.equal((await close(7, { Cookie: session })).status, 403);
    assert.equal(
      (await close(7, { Cookie: session, Origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (await close(7, { Authorization: bearer, Origin: origin })).status,
      401,
    );
    const signed = { Cookie: session, Origin: origin };
    assert.equal((await close("7", signed)).status, 400);
    assert.equal((await close(999, signed)).status, 404);
    assert.equal((await close(8, signed)).status, 409);
    const first = await close(7, signed);
    assert.equal(first.status, 200);
    const queued = ((await first.json()) as { close: Close }).close;
    assert.equal(queued.state, "queued");
    const repeat = (
      (await (await close(7, signed)).json()) as {
        close: Close;
      }
    ).close;
    assert.equal(repeat.requestedAt, queued.requestedAt);
    // Sessions cannot use the collector's close exchange, and vice versa.
    assert.equal(
      (
        await mf.dispatchFetch(`${origin}/api/closes`, {
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await mf.dispatchFetch(`${origin}/api/overview`, {
          headers: { Authorization: bearer },
        })
      ).status,
      401,
    );
    const pending = (await (
      await mf.dispatchFetch(`${origin}/api/closes`, {
        headers: { Authorization: bearer },
      })
    ).json()) as { closes: object[] };
    assert.deepEqual(pending.closes, [
      { issue: 7, requestedAt: queued.requestedAt },
    ]);
    const report = (body: object) =>
      mf.dispatchFetch(`${origin}/api/closes`, {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const done = {
      issue: 7,
      requestedAt: queued.requestedAt,
      state: "done",
      message: null,
    };
    assert.equal((await report({ ...done, extra: 1 })).status, 400);
    assert.deepEqual(await (await report({ ...done, requestedAt: 1 })).json(), {
      updated: false,
    });
    assert.deepEqual(await (await report(done)).json(), { updated: true });
    assert.deepEqual(await (await report(done)).json(), { updated: false });
    const view = (await (
      await mf.dispatchFetch(`${origin}/api/overview`, {
        headers: { Cookie: session },
      })
    ).json()) as { closes: Close[] };
    assert.equal(view.closes[0].state, "done");
    // Closed here and not yet seen closed by a scan: no second request.
    assert.equal((await close(7, signed)).status, 409);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("the Studio closes a queued issue and reports it; without GitHub it stays queued", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-studio-"));
  const script = path.join(dir, "local.mjs");
  await build({
    entryPoints: ["worker/local.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const mf = await start(await options(script, dir, { COLLECTOR_TOKEN: "x".repeat(64) }));
  try {
    const endpoint = (await mf.ready).href;
    const call = async (route: string, init: RequestInit = {}) =>
      fetch(new URL(route, endpoint), init);
    assert.equal(
      (
        await call("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(closeSnapshot()),
        })
      ).status,
      200,
    );
    const closed: string[] = [];
    const gh = async (args: string[]) => {
      closed.push(args[2]);
      return "";
    };
    // Nothing queued: nothing touches GitHub.
    await applyCloses(endpoint, {}, [issue(7)], "acme/work", gh);
    assert.deepEqual(closed, []);
    assert.equal(
      (
        await call("/api/work/close", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(endpoint).origin,
          },
          body: JSON.stringify({ issue: 7 }),
        })
      ).status,
      200,
    );
    const state = async () =>
      ((await (await call("/api/overview")).json()) as { closes: Close[] })
        .closes[0];
    await applyCloses(endpoint, {}, null, "acme/work", gh);
    await applyCloses(endpoint, {}, [issue(7)], "acme/work", async () => {
      throw Error("offline");
    });
    assert.equal((await state()).state, "queued");
    assert.match((await state()).message ?? "", /retrying/);
    assert.deepEqual(closed, []);
    await applyCloses(endpoint, {}, [issue(7)], "acme/work", gh);
    assert.deepEqual(closed, ["7"]);
    assert.equal((await state()).state, "done");
    assert.equal((await state()).message, null);
    assert.deepEqual(await (await call("/api/closes")).json(), { closes: [] });
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { start, options } from "./miniflare-fixtures";

test("OTP consumption is atomic, capped, persisted and logout revokes access", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-login-")),
    script = path.join(dir, "worker.mjs");
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: script,
  });
  const config = await options(script, dir, {
    ALLOWED_EMAILS: "owner@example.com",
    COLLECTOR_TOKEN: "x".repeat(64),
  });
  let mf = await start(config);
  try {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const store = ns.get(ns.idFromName("test")) as unknown as Portfolio;
    const email = "owner@example.com",
      salt = token(),
      code = "123456";
    assert.equal(
      await store.issue(email, salt, digest(`${salt}:${code}`)),
      true,
    );
    assert.equal(await store.issue(email, token(), "replacement"), false);
    const verify = () =>
      mf.dispatchFetch("https://example.com/api/auth/verify", {
        method: "POST",
        headers: {
          Origin: "https://example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, code }),
      });
    const results = await Promise.all([verify(), verify()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    const signed = results
      .find((r) => r.status === 200)!
      .headers.get("Set-Cookie")!;
    assert.match(signed, /__Host-projects=.*Secure; HttpOnly; SameSite=Strict/);
    const session = signed.split(";")[0];
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: session },
        })
      ).status,
      200,
    );
    // A browser session cannot publish snapshots.
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/ingest", {
          method: "POST",
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
    await mf.dispose();
    mf = await start(config);
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: session },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/auth/logout", {
          method: "POST",
          headers: { Cookie: session, Origin: "https://example.com" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
    const ns2 = await mf.getDurableObjectNamespace("PORTFOLIOS"),
      store2 = ns2.get(ns2.idFromName("test")) as unknown as Portfolio;
    await store2.issue(email, salt, digest(`${salt}:${code}`));
    for (let i = 0; i < 5; i++)
      assert.equal(await store2.verify(email, "000000", token()), false);
    assert.equal(await store2.verify(email, code, token()), false);
    assert.equal(await store2.rate("test-rate", 1, 60000), true);
    assert.equal(await store2.rate("test-rate", 1, 60000), false);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "test",
      "Portfolio",
      { name: "test" },
    );
    await storage.exec("UPDATE codes SET expires=?,attempts=0", Date.now() - 1);
    assert.equal(await store2.verify(email, code, token()), false);
    const expired = token();
    await storage.exec(
      "INSERT INTO sessions(hash,email,expires) VALUES(?,?,?)",
      digest(expired),
      email,
      Date.now() - 1,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Cookie: `__Host-projects=${expired}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/auth/request", {
          method: "POST",
          headers: {
            Origin: "https://example.com",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: "outsider@example.com" }),
        })
      ).status,
      200,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("production rejects unauthenticated reads and writes, including spoofed headers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "project-overview-auth-"));
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    outfile: path.join(dir, "worker.mjs"),
  });
  const mf = await start(
    await options(path.join(dir, "worker.mjs"), dir, {
      ALLOWED_EMAILS: "owner@example.com",
      COLLECTOR_TOKEN: "x".repeat(64),
    }),
  );
  try {
    for (const route of ["/api/overview", "/api/ingest"]) {
      const r = await mf.dispatchFetch(`https://example.com${route}`, {
        headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
      });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("Cache-Control"), "no-store");
    }
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/overview", {
          headers: { Authorization: `Bearer ${"x".repeat(64)}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://example.com/api/auth/request", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retired daily publication cannot email or expose old editions, while OTP email still works", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-retired-brief-")), script = path.join(dir, "worker.mjs");
  await build({entryPoints: ["tests/fixtures/email-worker.js"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script});
  const config = await options(script, dir, {ALLOWED_EMAILS: "owner@example.com", OWNER_EMAIL: "owner@example.com", EMAIL_FROM: "projects@notify.example.com", SITE_URL: "https://projects.example.com", COLLECTOR_TOKEN: "x".repeat(64)});
  type EmailTest = Portfolio & {sentEmails(): Promise<{text: string}[]>; seedBriefHistory(): Promise<void>; briefHistory(): Promise<string[]>};
  let mf = await start(config);
  const store = async () => {const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as EmailTest;};
  const headers = {"Content-Type": "application/json", Authorization: `Bearer ${"x".repeat(64)}`};
  try {
    await (await store()).seedBriefHistory();
    for (const body of ['{"review":{},"sendDaily":true}', '{malformed legacy payload']) {
      const res = await mf.dispatchFetch("https://example.com/api/review", {method: "POST", headers, body});
      assert.equal(res.status, 410);
      assert.match(await res.text(), /retired/);
    }
    assert.deepEqual(await (await store()).sentEmails(), []);
    assert.deepEqual(await (await store()).briefHistory(), ["historical edition"]);
    await mf.dispose(); mf = await start(config);
    assert.deepEqual(await (await store()).briefHistory(), ["historical edition"], "retirement preserves stored history across restart");
    assert.equal((await mf.dispatchFetch("https://example.com/api/overview", {headers})).status, 401);
    const otp = await mf.dispatchFetch("https://example.com/api/auth/request", {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://example.com"}, body: JSON.stringify({email: "owner@example.com"})});
    assert.equal(otp.status, 200);
    const sent = await (await store()).sentEmails();
    assert.equal(sent.length, 1, "the sign-in email binding remains functional");
    const code = sent[0].text.match(/\b[0-9]{6}\b/)![0];
    const signed = await mf.dispatchFetch("https://example.com/api/auth/verify", {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://example.com"}, body: JSON.stringify({email: "owner@example.com", code})});
    assert.equal(signed.status, 200);
    const overview = await mf.dispatchFetch("https://example.com/api/overview", {headers: {Cookie: signed.headers.get("Set-Cookie")!.split(";")[0]}});
    assert.equal(overview.status, 200);
    const overviewBody = (await overview.json()) as object;
    assert.equal("review" in overviewBody, false);
  } finally {await mf.dispose(); await rm(dir, {recursive: true, force: true});}
});

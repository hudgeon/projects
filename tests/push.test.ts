import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { pushEndpoint, sendPush, vapidAuthorization, vapidPublicKey } from "../worker/push";
import { notice } from "../src/run-text";
import type { RunSummary } from "../src/run-model";

async function testPushKey() {
  const { privateKey } = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey("jwk", privateKey);
  return JSON.stringify({ kty, crv, x, y, d });
}

test("only the browsers' own push services can receive the Worker's posts", () => {
  for (const ok of [
    "https://web.push.apple.com/QGc2V0LXRva2Vu",
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])
    assert.equal(pushEndpoint(ok), true, ok);
  for (const bad of [
    "http://web.push.apple.com/x",
    "https://web.push.apple.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://evil.example/web.push.apple.com",
    "https://web.push.apple.com.evil.example/x",
    "https://127.0.0.1/x",
    "not a url",
    `https://web.push.apple.com/${"x".repeat(1000)}`,
  ])
    assert.equal(pushEndpoint(bad), false, bad);
});

test("pushes are VAPID-signed for the service's origin and carry no content", async () => {
  const secret = await testPushKey();
  const endpoint = "https://web.push.apple.com/QGc2V0LXRva2Vu";
  const now = Date.UTC(2026, 9, 13);
  const header = await vapidAuthorization(endpoint, secret, "https://projects.example.com", now);
  const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(key, vapidPublicKey(secret));
  const [head, claims, signature] = jwt.split(".");
  const parsed = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.deepEqual(parsed, { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://projects.example.com" });
  const point = Buffer.from(key, "base64url");
  const verifier = await webcrypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(
    await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${head}.${claims}`)),
    true,
  );
  const requests: Request[] = [];
  const respond = (status: number) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(null, { status });
  }) as typeof fetch;
  assert.equal(await sendPush(endpoint, secret, "https://projects.example.com", respond(201)), "sent");
  assert.equal(await sendPush(endpoint, secret, "https://projects.example.com", respond(410)), "gone");
  assert.equal(await sendPush(endpoint, secret, "https://projects.example.com", respond(404)), "gone");
  assert.equal(await sendPush(endpoint, secret, "https://projects.example.com", respond(500)), "failed");
  assert.equal(await sendPush(endpoint, secret, "https://projects.example.com", (async () => { throw Error("offline"); }) as typeof fetch), "failed");
  assert.equal(await requests[0].text(), "", "no payload crosses the push service");
  assert.equal(requests[0].headers.get("TTL"), "86400");
  assert.match(requests[0].headers.get("Authorization")!, /^vapid t=/);
});

test("a notice fires once, to the conversation's owner, when an existing conversation becomes their move", () => {
  const run = (over: Partial<RunSummary>): RunSummary => ({
    id: "6f1d1b9a-6a39-4c43-9a6b-2b7c3e5e2f10",
    projectId: null,
    agent: "auto",
    state: "running",
    createdAt: 1,
    updatedAt: 2,
    heartbeatAt: 2,
    workIssue: null,
    owner: "owner@example.com",
    title: "Reply to Rob about training",
    status: "Drafted the reply to Rob.",
    ...over,
  });
  assert.deepEqual(notice(run({}), run({ state: "completed" })), { to: "owner@example.com", title: "Ready: Reply to Rob about training", body: "Drafted the reply to Rob." });
  assert.equal(notice(run({ owner: "matt.smith@example.com" }), run({ owner: "matt.smith@example.com", state: "completed" }))?.to, "matt.smith@example.com", "addressed to whoever started it");
  assert.equal(notice(run({}), run({ state: "blocked" }))?.title, "Needs you: Reply to Rob about training");
  assert.equal(notice(run({}), run({ needsYou: true }))?.title, "Needs you: Reply to Rob about training");
  assert.equal(notice(run({ needsYou: true }), run({ state: "completed" }))?.title, "Ready: Reply to Rob about training");
  assert.equal(notice(run({}), run({ stuck: true }))?.title, "May be stuck: Reply to Rob about training");
  assert.equal(notice(run({ stuck: true }), run({ stuck: true })), null, "once per stuck stretch");
  assert.equal(notice(run({}), run({ state: "failed" }))?.title, "Failed: Reply to Rob about training");
  assert.equal(notice(null, run({ state: "completed" })), null, "a new or migrated row is not news");
  assert.equal(notice(run({}), run({ state: "cancelled" })), null, "the user stopped it");
  assert.equal(notice(run({ state: "completed" }), run({ state: "completed", archivedAt: 3 })), null, "Done");
  assert.equal(notice(run({ state: "completed", archivedAt: 3 }), run({ state: "completed" })), null, "Reopen");
  assert.equal(notice(run({ state: "completed" }), run({ state: "completed" })), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DELEGATION_SCOPES,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READ_SCOPE,
  NO_MAILBOX_DIR,
  TOKEN_ENDPOINT,
  delegatedEnv,
  delegatedToken,
  delegationGrant,
  parseDelegationKey,
} from "./delegation";

// A key as Google issues one, for a service account that exists only here.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issued = {
  type: "service_account",
  project_id: "projects-test",
  private_key_id: "0123abcd",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  client_email: "inboxes@projects-test.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: TOKEN_ENDPOINT,
};
const decode = (grant: string) => {
  const [header, claims, signature] = grant.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
    valid: createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"),
  };
};
test("the key is accepted as Google issued it and refused otherwise, without being echoed", () => {
  assert.deepEqual(parseDelegationKey(JSON.stringify(issued)), {
    type: "service_account",
    client_email: issued.client_email,
    private_key: issued.private_key,
    token_uri: TOKEN_ENDPOINT,
  });
  for (const raw of [
    "not json",
    JSON.stringify({ ...issued, type: "authorized_user" }),
    JSON.stringify({ ...issued, private_key: "secret" }),
    // Only the PKCS#8 PEM Google issues, not a PKCS#1 one.
    JSON.stringify({ ...issued, private_key: privateKey.export({ type: "pkcs1", format: "pem" }) }),
    // A grant is as good as a token, so it only ever goes to Google.
    JSON.stringify({ ...issued, token_uri: "https://example.com/token" }),
  ])
    assert.throws(() => parseDelegationKey(raw), (e: Error) => e.message === "GMAIL_DELEGATION_KEY is not a service account key." && !e.message.includes("secret"));
  assert.deepEqual(DELEGATION_SCOPES, [GMAIL_READ_SCOPE, GMAIL_MODIFY_SCOPE]);
});
test("a grant names the key, the person and the scope for an hour, signed with the key", () => {
  const key = parseDelegationKey(JSON.stringify(issued));
  const grant = delegationGrant(key, "ada@example.com", GMAIL_READ_SCOPE, 1_700_000_000_500);
  const { header, claims, valid } = decode(grant);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(claims, {
    iss: issued.client_email,
    sub: "ada@example.com",
    scope: GMAIL_READ_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: 1_700_000_000,
    exp: 1_700_000_000 + 3600,
  });
  assert.ok(valid, "signed by the key");
  assert.equal(decode(delegationGrant(key, "sam@example.com", GMAIL_READ_SCOPE)).claims.sub, "sam@example.com");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  const [header_, claims_, signature] = grant.split(".");
  assert.equal(createVerify("RSA-SHA256").update(`${header_}.${claims_}`).verify(other, signature, "base64url"), false);
});
test("a token comes from Google's endpoint for the grant; a refusal names only the error code", async () => {
  const key = parseDelegationKey(JSON.stringify(issued));
  const requests: { url: string; method?: string; sub: string; scope: string; grantType: string | null }[] = [];
  const google = (status: number, body: object): typeof fetch => async (url, init) => {
    const form = new URLSearchParams(init?.body as URLSearchParams);
    const { claims, valid } = decode(form.get("assertion") ?? "");
    assert.ok(valid);
    requests.push({ url: String(url), method: init?.method, sub: claims.sub, scope: claims.scope, grantType: form.get("grant_type") });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  assert.equal(await delegatedToken(key, "ada@example.com", GMAIL_MODIFY_SCOPE, google(200, { access_token: "ya29.token", expires_in: 3599, token_type: "Bearer" })), "ya29.token");
  assert.deepEqual(requests, [{ url: TOKEN_ENDPOINT, method: "POST", sub: "ada@example.com", scope: GMAIL_MODIFY_SCOPE, grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer" }]);
  // Google's description can name the account; the code alone is kept.
  await assert.rejects(
    delegatedToken(key, "sam@example.com", GMAIL_READ_SCOPE, google(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens for sam@example.com." })),
    (e: Error) => e.message === "Delegated Gmail access was refused (unauthorized_client)." && !e.message.includes("sam@"),
  );
  await assert.rejects(delegatedToken(key, "sam@example.com", GMAIL_READ_SCOPE, google(200, { token_type: "Bearer" })), /^Error: Delegated Gmail access was refused\.$/);
  await assert.rejects(delegatedToken(key, "sam@example.com", GMAIL_READ_SCOPE, google(400, { error: "bad <code> sam@example.com" })), /^Error: Delegated Gmail access was refused\.$/);
  await assert.rejects(delegatedToken(key, "sam@example.com", GMAIL_READ_SCOPE, async () => new Response("<html>", { status: 502 })), /refused\.$/);
});
test("a delegated gws call runs on the token alone", () => {
  assert.deepEqual(delegatedEnv("ya29.token"), {
    GOOGLE_WORKSPACE_CLI_TOKEN: "ya29.token",
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: NO_MAILBOX_DIR,
    GOOGLE_APPLICATION_CREDENTIALS: path.join(NO_MAILBOX_DIR, "none.json"),
  });
  assert.equal(NO_MAILBOX_DIR, path.join(tmpdir(), "projects-no-mailbox"));
});

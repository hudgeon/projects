import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowed,
  authorize,
  cookie,
  digest,
  equal,
  otp,
  sessionCookie,
  token,
  sameOrigin,
  login,
  browserMay,
  signsIn,
} from "../worker/auth";
test("OTP and sessions use distinct random credentials and host-only secure cookies", () => {
  assert.match(otp(), /^\d{6}$/);
  assert.match(token(), /^[a-f0-9]{64}$/);
  assert.notEqual(token(), token());
  assert.equal(digest("a").length, 64);
  assert.equal(equal("abc", "abc"), true);
  assert.equal(equal("abc", "abcd"), false);
  assert.equal(
    allowed("owner@example.com", { ALLOWED_EMAILS: " Owner@Example.com " }),
    true,
  );
  assert.equal(
    allowed("other@example.com", { ALLOWED_EMAILS: "owner@example.com" }),
    false,
  );
  const value = token();
  assert.equal(
    cookie(
      new Request("https://example.com", {
        headers: { cookie: sessionCookie(value) },
      }),
    ),
    value,
  );
  assert.match(sessionCookie(value), /Secure; HttpOnly; SameSite=Strict/);
  assert.equal(
    sameOrigin(
      new Request("https://example.com", {
        headers: { origin: "https://evil.example" },
      }),
    ),
    false,
  );
});
test("a machine token authorises only its own routes, and only its hash leaves the Worker", async () => {
  const value = token(),
    seen: unknown[] = [];
  const env = {
    PORTFOLIOS: {
      getByName: () => ({
        machineCaller: async (role: string, hash: string) => {
          seen.push(role, hash);
          return role === "collector" && hash === digest(value)
            ? { role, machine: "studio", plainOwner: false }
            : null;
        },
        session: () => {
          throw Error("Not a session");
        },
      }),
    },
  } as unknown as Env;
  const request = new Request("https://example.com", {
    headers: { Authorization: `Bearer ${value}` },
  });
  assert.deepEqual(await authorize(request, env, true), {
    role: "collector",
    machine: "studio",
    plainOwner: false,
  });
  assert.equal(await authorize(request, env, false, true), null);
  assert.equal(await authorize(request, env, false), null);
  assert.equal(await authorize(new Request("https://example.com"), env, true), null);
  assert.ok(!seen.includes(value), "the token itself never reaches the portfolio");
});
test("a conversation browser's sign-in is the owner's, marked with its machine and limited", async () => {
  const value = token();
  const env = {
    PORTFOLIO_ID: "test",
    ALLOWED_EMAILS: "owner@example.com",
    PORTFOLIOS: {
      getByName: () => ({
        session: async (hash: string) =>
          hash === digest(value) ? { email: "owner@example.com", machine: "studio" } : null,
      }),
    },
  } as unknown as Env;
  const request = new Request("https://example.com", {
    headers: { cookie: sessionCookie(value) },
  });
  assert.deepEqual(await authorize(request, env, false), {
    role: "browser",
    email: "owner@example.com",
    machine: "studio",
  });
  assert.equal(
    await authorize(request, { ...env, ALLOWED_EMAILS: "other@example.com" } as Env, false),
    null,
    "an owner the allowlist no longer names is signed out",
  );
  assert.equal(await authorize(request, env, true), null, "never a machine's route");
  assert.equal(browserMay("/api/overview", "GET"), true);
  assert.equal(browserMay("/api/runs", "POST"), true);
  assert.equal(browserMay("/api/machines", "GET"), true);
  for (const [path, method] of [
    ["/api/machines", "POST"],
    ["/api/machines/studio/tokens", "POST"],
    ["/api/execution-settings", "POST"],
    ["/api/runs/00000000-0000-4000-8000-000000000000/browser/view", "POST"],
    ["/api/inbox/threads/abcdef1234", "GET"],
    ["/api/inbox/act", "POST"],
    ["/api/push/key", "GET"],
  ])
    assert.equal(browserMay(path, method), false, path);
  assert.equal(signsIn({ BROWSER_SIGN_IN: " studio,laptop " }, "laptop"), true);
  assert.equal(signsIn({ BROWSER_SIGN_IN: "studio" }, "studio-2"), false);
  assert.equal(signsIn({ BROWSER_SIGN_IN: "" }, ""), false);
  assert.equal(signsIn({}, "studio"), false);
});
test("sign-in codes go out through the email binding and stay out of responses", async () => {
  const sent: { from: unknown; to: string; text: string }[] = [];
  let cancelled = 0;
  const store = {
    rate: async () => true,
    issue: async () => true,
    cancelCode: async () => {
      cancelled++;
    },
  };
  const email = {
    send: async (message: (typeof sent)[number]) => {
      sent.push(message);
      return { messageId: "message-1" };
    },
  };
  const env = {
    PORTFOLIO_ID: "test",
    ALLOWED_EMAILS: "owner@example.com",
    EMAIL_FROM: "projects@notify.example.com",
    PORTFOLIOS: { getByName: () => store },
    EMAIL: email,
  } as unknown as Env;
  const request = (address: string) =>
    new Request("https://projects.example.com/api/auth/request", {
      method: "POST",
      headers: {
        Origin: "https://projects.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: address }),
    });
  const ok = await login(request("Owner@Example.com"), env);
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].from, { name: "Projects", email: "projects@notify.example.com" });
  assert.equal(sent[0].to, "owner@example.com");
  const code = /code is (\d{6})\./.exec(sent[0].text)?.[1];
  assert.ok(code);
  assert.ok(!(await ok.text()).includes(code));
  assert.equal((await login(request("outsider@example.com"), env)).status, 200);
  assert.equal(sent.length, 1, "an address outside the allowlist gets nothing");
  email.send = async () => {
    throw Error("E_SENDER_NOT_VERIFIED provider detail");
  };
  const failed = await login(request("owner@example.com"), env);
  assert.equal(failed.status, 503);
  assert.equal(cancelled, 1, "an undelivered code cannot be used");
  assert.doesNotMatch(await failed.text(), /provider detail/);
});

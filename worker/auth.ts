import {
  timingSafeEqual,
  randomInt,
  randomBytes,
  createHash,
} from "node:crypto";
import type { MachineCaller } from "./machines";
export const SESSION_SECONDS = 7 * 86400;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => Buffer.from(randomBytes(32)).toString("hex");
export const otp = () => String(randomInt(0, 1000000)).padStart(6, "0");
export function equal(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
// Every allowed address is a person who may sign in (worker/people.ts).
export function allowedEmails(env: { ALLOWED_EMAILS: string }) {
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
export function allowed(email: string, env: { ALLOWED_EMAILS: string }) {
  return allowedEmails(env).includes(email);
}
// The deployment owner, whose conversations from before people had profiles
// these are.
export const deploymentOwner = (env: { OWNER_EMAIL?: string }) =>
  (env.OWNER_EMAIL ?? "").trim().toLowerCase();
export const SESSION_COOKIE = "__Host-projects";
export function cookie(request: Request) {
  return (
    /(?:^|;\s*)__Host-projects=([a-f0-9]{64})(?:;|$)/.exec(
      request.headers.get("cookie") ?? "",
    )?.[1] ?? ""
  );
}
export function sessionCookie(value: string) {
  return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${value ? SESSION_SECONDS : 0}`;
}
export class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
// Enforce actual streamed bytes; Content-Length alone is not a bound.
export async function readJson(request: Request, limit: number) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new BodyError(400, "Expected JSON");
  const reader = request.body?.getReader();
  if (!reader) throw new BodyError(400, "Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new BodyError(413, "Too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new BodyError(400, "Invalid JSON");
  }
}
export function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}
// A conversation browser a machine's runner drives, signed in as the
// conversation's owner by the Worker itself (worker/browser.ts). It acts as
// that person, less the routes browserMay() keeps for a person's own sign-in.
export type BrowserCaller = { role: "browser"; email: string; machine: string };
// Machines whose conversation browsers start signed in as the conversation's
// owner: exact machine IDs, comma separated, from the deployment's
// BROWSER_SIGN_IN.
export function signsIn(
  env: { BROWSER_SIGN_IN?: string },
  machine: string | null | undefined,
) {
  return (
    !!machine &&
    (env.BROWSER_SIGN_IN ?? "")
      .split(",")
      .map((id) => id.trim())
      .includes(machine)
  );
}
// A browser's sign-in acts as the conversation's owner, except for what
// outlives the browser or reaches beyond it: connecting, changing or removing
// machines, how agents run, the person's name, watching or driving browsers,
// email, and notifications.
export function browserMay(pathname: string, method: string) {
  const read = method === "GET" || method === "HEAD";
  if (
    /^\/api\/machines(?:\/|$)/.test(pathname) ||
    pathname === "/api/execution-settings" ||
    pathname === "/api/upkeep" ||
    pathname === "/api/me"
  )
    return read;
  return !(
    /^\/api\/runs\/[^/]+\/browser\/view$/.test(pathname) ||
    pathname.startsWith("/api/inbox/") ||
    pathname.startsWith("/api/push/")
  );
}
// A signed-in owner's email, "local" in the local emulator, a machine's
// collector or runner token, or a conversation browser's own sign-in.
export type Caller = string | MachineCaller | BrowserCaller;
// Who is calling: a machine on its own routes, otherwise a signed-in email.
export async function authorize(
  request: Request,
  env: Env,
  collector: boolean,
  runner = false,
): Promise<Caller | null> {
  if (runner || collector) {
    const value =
      /^Bearer (\S{32,200})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!value) return null;
    // Only the token's hash leaves the Worker.
    return env.PORTFOLIOS.getByName(env.PORTFOLIO_ID).machineCaller(
      runner ? "runner" : "collector",
      digest(value),
    );
  }
  const value = cookie(request);
  if (!value) return null;
  const found = await env.PORTFOLIOS.getByName(env.PORTFOLIO_ID).session(
    digest(value),
  );
  if (!found || !allowed(found.email, env)) return null;
  // Only the owner's own sign-in has no machine; anything else is limited.
  return found.machine === null
    ? found.email
    : { role: "browser", email: found.email, machine: found.machine };
}
export async function login(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const store = env.PORTFOLIOS.getByName(env.PORTFOLIO_ID),
    route = new URL(request.url).pathname;
  if (route === "/api/auth/logout") {
    const value = cookie(request);
    if (value) await store.revoke(digest(value));
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionCookie("") } },
    );
  }
  if (!["/api/auth/request", "/api/auth/verify"].includes(route))
    return new Response("Not found", { status: 404 });
  let input;
  try {
    input = (await readJson(request, 2048)) as Record<string, unknown> | null;
  } catch (e) {
    if (e instanceof BodyError)
      return new Response(e.message, { status: e.status });
    throw e;
  }
  const email =
    typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  const ip = digest(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await store.rate(`ip:${ip}`, 60, 60_000)))
    return new Response("Try again later", { status: 429 });
  if (route === "/api/auth/request") {
    const generic = () =>
      Response.json({
        ok: true,
        message: "If this address is allowed, a code is on its way.",
      });
    if (!allowed(email, env)) return generic();
    if (!env.EMAIL || !env.EMAIL_FROM)
      return new Response("Sign-in is not configured", { status: 503 });
    if (!(await store.rate(`email:${email}`, 5, 3600_000)))
      return new Response("Try again later", { status: 429 });
    const code = otp(),
      salt = token();
    if (!(await store.issue(email, salt, digest(`${salt}:${code}`))))
      return new Response("Wait a minute before requesting another code", {
        status: 429,
      });
    let delivered = false;
    try {
      await env.EMAIL.send({
        from: { name: "Projects", email: env.EMAIL_FROM },
        to: email,
        subject: "Your Projects sign-in code",
        text: `Your Projects sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
      });
      delivered = true;
    } catch {
      /* Never expose provider details or code. */
    }
    if (!delivered) {
      await store.cancelCode(email, salt);
      return new Response("Email delivery unavailable; try again later", {
        status: 503,
      });
    }
    return generic();
  }
  const code = typeof input?.code === "string" ? input.code : "";
  if (!allowed(email, env) || !/^\d{6}$/.test(code))
    return new Response("Invalid or expired code", { status: 401 });
  const value = token();
  if (!(await store.verify(email, code, digest(value))))
    return new Response("Invalid or expired code", { status: 401 });
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie(value) } },
  );
}

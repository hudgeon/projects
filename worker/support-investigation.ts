// Restricted service adapter. Credentials and protected results remain in this
// invocation; callers receive workflow metadata and authenticated review links.
import { z } from "zod";
import { digest, readJson } from "./auth";
import { groundedSupportSummary, supportSummarySchema, supportReceiptSchema, supportReferences, supportText, type SupportTaskPointer, type SupportInvestigationView } from "../src/support-model";
import type { Portfolio } from "./index";
import type { MachineCaller } from "./machines";
export type SupportEnvironment = Env & { SUPPORT_READER?: Fetcher; SUPPORT_APP_URL?: string };
export type SupportSource = { id: string; owner: string; account: string; active: boolean; text: string; subject: string;
  canBootstrap?: boolean; messageKeys?: string[]; request?: { key: string; sender: string; audience: { to: string[]; cc: string[] } } };
type Store = Pick<DurableObjectStub<Portfolio>, "supportSource" | "supportInvestigation" | "rate">;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bootstrap"), key: hash, owner: z.email(), requestKey: hash, summary: supportSummarySchema }).strict(),
  z.object({ action: z.literal("prepare"), key: hash }).strict(),
]);
const bootSchema = z.object({ task: z.uuid(), path: z.string(), state: z.enum(["awaiting-verification", "verified", "prepared", "held", "finished"]) }).strict();
export function supportAvailable(env: SupportEnvironment) {
  try { const url = new URL(env.SUPPORT_APP_URL ?? ""); return Boolean(env.SUPPORT_READER && url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash); }
  catch { return false; }
}
export const supportAudienceHash = (source: SupportSource) => digest(JSON.stringify({ to: source.request?.audience.to ?? [], cc: source.request?.audience.cc ?? [] }));
export const supportSourceHash = (source: SupportSource) => digest(JSON.stringify({ account: source.account, sender: source.request?.sender, subject: source.subject, text: supportText(source.text) }));
export function supportView(pointer: SupportTaskPointer, env: SupportEnvironment): SupportInvestigationView {
  if (!supportAvailable(env)) return { state: "off" };
  const base = new URL(`/support-investigation/${pointer.task}`, env.SUPPORT_APP_URL).href;
  return { state: pointer.state, ...(!pointer.invalidated ? { verificationUrl: base } : {}), ...(pointer.state === "prepared" && !pointer.invalidated ? { reviewUrl: base + "/review" } : {}) };
}
async function service(env: SupportEnvironment, path: "/bootstrap" | "/claim" | "/prepare-review" | "/invalidate" | "/health", body: object, token?: string): Promise<unknown> {
  if (!supportAvailable(env)) throw Error("Support reader unavailable");
  const response = await env.SUPPORT_READER!.fetch(new Request("https://support.internal" + path, { method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }));
  if (!response.ok) throw Error("Support reader unavailable");
  // Never log this response or return it through the source/collector API.
  return response.json();
}
export async function invalidateSupport(env: SupportEnvironment, task: string) {
  try { await service(env, "/invalidate", { task }); return true; } catch { return false; }
}
export async function supportHealthy(env: SupportEnvironment) {
  try { const result = await service(env, "/health", {}); return !!result && typeof result === "object" && "policy" in result && result.policy === "support-grant-v1"; }
  catch { return false; }
}
export function supportMatches(pointer: SupportTaskPointer, source: SupportSource) {
  return source.active && !!source.request && supportReceiptSchema.shape.request.safeParse(source.request).success && source.request.key === pointer.requestKey && supportAudienceHash(source) === pointer.audienceHash && supportSourceHash(source) === pointer.sourceHash;
}
export async function investigationRoutes(request: Request, store: Store, caller: string | MachineCaller, onDuty: () => Promise<boolean>, allowed: (email: string) => boolean, env: SupportEnvironment) {
  const path = new URL(request.url).pathname, intake = path === "/api/collector/support-investigation";
  if (!intake && path !== "/api/support/investigation") return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const input = inputSchema.safeParse(await readJson(request, 2048));
  if (!input.success) return new Response("Invalid request", { status: 400 });
  const body = input.data;
  if (intake !== (body.action === "bootstrap")) return new Response("Not permitted", { status: 403 });
  const reply = (view: SupportInvestigationView) => Response.json({ investigation: view }, { headers: { "Cache-Control": "no-store" } });
  if (!supportAvailable(env)) return reply({ state: "off" });
  if (body.action === "bootstrap" ? typeof caller === "string" || caller.role !== "collector" || !allowed(body.owner.toLowerCase()) || !(await onDuty()) : typeof caller !== "string") return new Response("Not permitted", { status: 403 });
  const viewer = body.action === "bootstrap" ? body.owner.toLowerCase() : caller as string;
  if (!(await store.rate(`support-investigation:${viewer}`, 30, 60_000))) return new Response("Try later", { status: 429 });
  const source = await store.supportSource(body.key, viewer, body.action === "bootstrap" ? (caller as MachineCaller).machine : undefined);
  if (!source) return new Response("Not found", { status: 404 });
  let pointer: SupportTaskPointer | null = await store.supportInvestigation(source.id, source.owner);
  if (pointer && !supportMatches(pointer, source)) {
    const invalidated = await invalidateSupport(env, pointer.task);
    await store.supportInvestigation(source.id, source.owner, { ...pointer, state: "held", invalidated });
    return reply({ state: "held" });
  }
  if (!source.active || !source.request || !supportReceiptSchema.shape.request.safeParse(source.request).success) return reply({ state: "held" });
  if (body.action === "bootstrap" && !source.canBootstrap) return reply({ state: "held" });
  if (body.action === "bootstrap" && (source.request.key !== body.requestKey || groundedSupportSummary(body.summary, source.text).kind !== "issue")) return reply({ state: "held" });
  if (body.action === "prepare" && !pointer) return reply({ state: "held" });
  try {
    const boot = bootSchema.parse(await service(env, "/bootstrap", { sourceKey: digest("support-source-v1\n" + source.account + "\n" + source.request.key + "\n" + supportSourceHash(source)),
      sender: source.request.sender, mailbox: source.account, audience: source.request.audience }));
    if (boot.path !== `/support-investigation/${boot.task}` || pointer && pointer.task !== boot.task) return reply({ state: "held" });
    pointer ??= { task: boot.task, requestKey: source.request.key, audienceHash: supportAudienceHash(source), sourceHash: supportSourceHash(source), summary: body.action === "bootstrap" ? groundedSupportSummary(body.summary, source.text) : { kind: "needs-review", excerpt: "", area: "other" }, state: "awaiting-verification" };
    if (body.action === "bootstrap") {
      // The durable draft reservation is also the initial registered-sender
      // workflow boundary. The store refuses a different/stale request.
      const bound = await store.supportInvestigation(source.id, source.owner, pointer);
      if (!bound || bound.task !== pointer.task) { await invalidateSupport(env, boot.task); return reply({ state: "held" }); }
      return reply(supportView(bound, env));
    }
    let state: SupportTaskPointer["state"] = boot.state === "prepared" ? "prepared" : boot.state === "awaiting-verification" ? "awaiting-verification" : "held";
    if (boot.state === "verified") {
      const requests = supportReferences(source.text), summary = groundedSupportSummary(pointer.summary, source.text);
      if (summary.kind === "issue" && requests.length) {
        const claimed = z.object({ result: z.object({ token: z.string().regex(/^sr_[a-f0-9]{64}$/), expiresAt: z.string(), operations: z.array(z.string()) }).strict() }).strict().parse(await service(env, "/claim", { task: boot.task }));
        const prepared = z.object({ result: z.object({ prepared: z.literal(true) }).strict() }).strict().parse(await service(env, "/prepare-review", { task: boot.task, input: { subject: source.subject.slice(0, 200), reflection: { excerpt: summary.excerpt, area: summary.area }, requests } }, claimed.result.token));
        // This path returns metadata only, never a fact or protected body.
        // Human review regenerates facts inside the authenticated source app.
        if (prepared.result.prepared) state = "prepared";
      }
    }
    const fresh = await store.supportSource(body.key, viewer);
    if (!fresh || !supportMatches(pointer, fresh)) { await invalidateSupport(env, boot.task); state = "held"; }
    const saved = await store.supportInvestigation(source.id, source.owner, { ...pointer, state });
    return reply(saved ? supportView(saved, env) : { state: "held" });
  } catch { return reply({ state: "unavailable" }); }
}

// Pass only explicit, authenticated internal paste jobs to the tool-free
// classifier. No chat source, support reservation or record-read grant exists.
import { z } from "zod";
import { readJson } from "./auth";
import type { MachineCaller } from "./machines";
import { supportAvailable, type SupportEnvironment } from "./support-investigation";
import { supportSummarySchema } from "../src/support-model";

const id = z.string().regex(/^\d{13}-[a-f0-9-]{36}$/);
const result = supportSummarySchema.extend({ inputUsed: z.string().max(4000), reply: z.string().min(1).max(5000), version: z.string().min(1).max(100), durationMs: z.number().int().nonnegative().max(120_000) }).strict();
const finish = z.object({ action: z.literal("finish"), id, region: z.enum(["au", "uk"]), claim: z.uuid(), result: result.optional() }).strict();
const input = z.discriminatedUnion("action", [z.object({ action: z.literal("poll") }).strict(), finish]);
const output = z.object({ job: z.object({ id, region: z.enum(["au", "uk"]), claim: z.uuid(), message: z.string().min(1).max(12_000) }).strict().nullable() }).strict();
export async function supportPreviewRoutes(request: Request, caller: string | MachineCaller, onDuty: () => Promise<boolean>, env: SupportEnvironment, rate: () => Promise<boolean>) {
  if (new URL(request.url).pathname !== "/api/collector/support-preview") return null;
  const reply = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return reply({}, 405);
  if (typeof caller === "string" || caller.role !== "collector" || !await onDuty()) return reply({}, 403);
  const reader = env.SUPPORT_READER;
  if (!reader || !supportAvailable(env)) return reply({}, 503);
  if (!await rate()) return reply({}, 429);
  try {
    const body = input.parse(await readJson(request, 35_000));
    const { action, ...payload } = body;
    const response = await reader.fetch(new Request(`https://support.internal/preview/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    }));
    if (!response.ok) return reply({}, 503);
    if (action === "poll") return reply(output.parse(await response.json()));
    return reply(z.object({ accepted: z.literal(true) }).strict().parse(await response.json()));
  } catch { return reply({}, 503); }
}

// Optional, manually invoked rehearsal client. GitHub's collector, work cache,
// close queue, runner readback and hook selection remain the authority paths.
import { createHash } from "node:crypto";
import { z } from "zod";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{26}$`));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ precision: 3 });
export const workAliasSchema = z.object({ host: z.string().regex(/^[a-z0-9.-]+$/i), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), issue: z.number().int().positive() }).strict();
export type WorkAlias = z.infer<typeof workAliasSchema>;
const envelope = z.object({ schema: z.literal("company-context/work-read@1"), authority: z.literal("rehearsal"), workAuthority: z.literal("github"), classification: z.literal("restricted"), observedAt: instant });
const recordSchema = z.object({ id: id("wrk"), ownerId: id("prn"), authority: z.literal("rehearsal"), alias: workAliasSchema, version: z.number().int().nonnegative(), revisionId: id("wrv").nullable(), sha256: digest.nullable() }).strict();
const citationSchema = z.object({ editionId: id("wse"), sha256: digest, startByte: z.number().int().nonnegative(), endByte: z.number().int().positive() }).strict();
const sourceSchema = z.object({
  editionId: id("wse"), workId: id("wrk"), sourceKey: z.string().min(1).max(1000), sourceVersion: z.string().min(1).max(200),
  kind: z.enum(["request", "comment", "decision", "correction", "observation", "attachment", "timeline"]),
  author: z.object({ id: z.string().max(500), name: z.string().max(500), kind: z.enum(["human", "agent", "system", "unknown"]) }).strict(),
  sourceAt: instant.nullable(), locator: z.string().max(2000), origin: z.object({ system: z.string().max(200), repositoryId: z.string().nullable(), issueId: z.string().nullable(), commentId: z.string().nullable() }).strict(),
  mediaType: z.string().max(200), supersedesId: id("wse").nullable(), repliesToId: id("wse").nullable(), unavailableReason: z.string().max(2000).nullable(), sha256: digest.nullable(), recordedAt: instant, recordedBy: id("prn"), authority: z.literal("rehearsal"),
}).strict();
const cursorSchema = z.object({ at: instant, editionId: id("wse") }).strict();
const pageSchema = envelope.extend({ workId: id("wrk"), through: z.number().int().nonnegative(), sources: z.array(sourceSchema.extend({ byteSize: z.number().int().min(0).max(2_000_000).nullable() })).max(25), next: cursorSchema.nullable() }).strict();
export type WorkSource = z.infer<typeof pageSchema>["sources"][number];
export class WorkServiceError extends Error {
  constructor(readonly code: "denied" | "unavailable" | "invalid") { super(`Work rehearsal ${code}`); }
}
export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export function workServiceEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
    || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new WorkServiceError("invalid");
  return url;
}
async function boundedJson(response: Response) {
  if (!response.ok) { await response.body?.cancel(); throw new WorkServiceError(response.status === 401 || response.status === 403 ? "denied" : "unavailable"); }
  if (!response.headers.get("content-type")?.startsWith("application/json")) { await response.body?.cancel(); throw new WorkServiceError("invalid"); }
  const reader = response.body?.getReader();
  if (!reader) throw new WorkServiceError("invalid");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) throw new WorkServiceError("invalid");
      parts.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class WorkServiceClient {
  private endpoint: URL;
  constructor(endpoint: string, private token: string, private transport: typeof fetch = fetch) {
    this.endpoint = workServiceEndpoint(endpoint);
    if (!/^wrt_[A-Za-z0-9_-]{43}$/.test(token)) throw new WorkServiceError("invalid");
  }
  private async get<T extends z.ZodType>(path: string, schema: T, signal?: AbortSignal): Promise<z.output<T>> {
    try {
      const response = await this.transport(new URL(`/api/work/v1${path}`, this.endpoint), {
        method: "GET", headers: { authorization: `Bearer ${this.token}`, accept: "application/json" }, redirect: "error", cache: "no-store",
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      });
      const raw = await boundedJson(response);
      const result = schema.parse(raw);
      // A dated retained source can be old; a fresh network read receipt cannot.
      const age = Date.now() - Date.parse(envelope.parse(raw).observedAt);
      if (age < -60_000 || age > 60_000) throw new WorkServiceError("invalid");
      return result;
    } catch (error) {
      if (error instanceof WorkServiceError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new WorkServiceError(error instanceof z.ZodError || error instanceof SyntaxError ? "invalid" : "unavailable");
    }
  }
  async resolve(alias: WorkAlias, signal?: AbortSignal) {
    workAliasSchema.parse(alias);
    const params = new URLSearchParams({ host: alias.host, repository: alias.repository, issue: String(alias.issue) });
    const result = await this.get(`/resolve?${params}`, envelope.extend({ record: recordSchema.nullable() }).strict(), signal);
    if (result.record && (result.record.alias.host !== alias.host.toLowerCase() || result.record.alias.repository !== alias.repository.toLowerCase() || result.record.alias.issue !== alias.issue)) throw new WorkServiceError("invalid");
    return result.record as z.infer<typeof recordSchema> | null;
  }
  async read(workId: string, signal?: AbortSignal) {
    id("wrk").parse(workId);
    const schema = envelope.extend({ record: recordSchema, receipt: z.object({ workId: id("wrk"), authority: z.literal("rehearsal"), revisionId: id("wrv"), version: z.number().int().positive(), sha256: digest }).strict().nullable(), assessment: z.record(z.string(), z.unknown()).nullable() }).strict();
    const result = await this.get(`/records/${workId}`, schema, signal) as z.infer<typeof schema>;
    const { record: r, receipt: c, assessment: a } = result;
    if (r.id !== workId || (r.version === 0 ? c !== null || a !== null || r.sha256 !== null || r.revisionId !== null
      : !c || !a || c.workId !== workId || c.version !== r.version || c.revisionId !== r.revisionId || c.sha256 !== r.sha256 || sha256(JSON.stringify(a)) !== c.sha256)) throw new WorkServiceError("invalid");
    return result;
  }
  async sources(workId: string, options: { through?: number; after?: z.infer<typeof cursorSchema>; signal?: AbortSignal } = {}) {
    id("wrk").parse(workId);
    const params = new URLSearchParams({ limit: "25" });
    if (options.through !== undefined) params.set("through", String(options.through));
    if (options.after) { params.set("afterAt", options.after.at); params.set("afterId", options.after.editionId); }
    const result = await this.get(`/records/${workId}/sources?${params}`, pageSchema, options.signal) as z.infer<typeof pageSchema>;
    if (result.workId !== workId || result.sources.some(s => s.workId !== workId) || (options.through !== undefined && result.through !== options.through)
      || result.sources.some(s => (s.sha256 === null) !== (s.unavailableReason !== null) || (s.sha256 === null) !== (s.byteSize === null))) throw new WorkServiceError("invalid");
    const position = (s: WorkSource) => [s.sourceAt ?? s.recordedAt, s.editionId].join("/");
    for (let i = 0; i < result.sources.length; i++) if (position(result.sources[i]) <= (i ? position(result.sources[i - 1]) : options.after ? `${options.after.at}/${options.after.editionId}` : "")) throw new WorkServiceError("invalid");
    const last = result.sources.at(-1);
    if (result.next && (!last || result.next.at !== (last.sourceAt ?? last.recordedAt) || result.next.editionId !== last.editionId)) throw new WorkServiceError("invalid");
    return result;
  }
  async excerpt(workId: string, citation: z.infer<typeof citationSchema>, signal?: AbortSignal) {
    id("wrk").parse(workId); citationSchema.parse(citation);
    if (citation.endByte <= citation.startByte || citation.endByte - citation.startByte > 32_000) throw new WorkServiceError("invalid");
    const params = new URLSearchParams({ sha256: citation.sha256, startByte: String(citation.startByte), endByte: String(citation.endByte) });
    const schema = envelope.extend({ citation: citationSchema, source: sourceSchema, text: z.string().max(32_000), excerptSha256: digest }).strict();
    const result = await this.get(`/records/${workId}/sources/${citation.editionId}/excerpt?${params}`, schema, signal) as z.infer<typeof schema>;
    if (result.source.workId !== workId || result.source.editionId !== citation.editionId || result.source.sha256 !== citation.sha256 || Object.keys(citation).some(k => result.citation[k as keyof typeof citation] !== citation[k as keyof typeof citation])
      || Buffer.byteLength(result.text, "utf8") !== citation.endByte - citation.startByte || sha256(result.text) !== result.excerptSha256) throw new WorkServiceError("invalid");
    return result;
  }
}

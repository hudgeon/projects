import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkServiceClient, WorkServiceError, sha256 } from "./work-service";
import { rehearseWorkRead } from "./work-rehearsal";

const workId = `wrk_${"1".repeat(26)}`, editionId = `wse_${"2".repeat(26)}`, principal = `prn_${"3".repeat(26)}`;
const alias = { host: "github.com", repository: "example/work", issue: 7 };
const token = `wrt_${"a".repeat(43)}`, body = "Keep the original café decision.\n", bodyHash = sha256(body);
const envelope = () => ({ schema: "company-context/work-read@1", authority: "rehearsal", workAuthority: "github", classification: "restricted", observedAt: new Date().toISOString() });
const record = { id: workId, ownerId: principal, authority: "rehearsal", alias, version: 0, revisionId: null, sha256: null };
const source = (i: number) => ({ editionId: `wse_${String(i + 1).padStart(26, "0")}`, workId, sourceKey: `comment:${i}`, sourceVersion: "1", kind: "comment", author: { id: "a", name: "Person", kind: "human" }, sourceAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), locator: `https://github.com/example/work/issues/7${i ? `#${i}` : ""}`, origin: { system: "github", repositoryId: "r", issueId: "7", commentId: String(i) }, mediaType: "text/markdown", supersedesId: null, repliesToId: null, unavailableReason: null, sha256: bodyHash, recordedAt: "2026-10-30T00:00:00.000Z", recordedBy: principal, authority: "rehearsal", byteSize: Buffer.byteLength(body) });
function client(read: (url: URL, init: RequestInit) => unknown) {
  return new WorkServiceClient("https://context.example.test", token, (async (input, init) => {
    const value = read(new URL(String(input)), init!);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch);
}
const read = () => ({ ...envelope(), record, receipt: null, assessment: null });
const canonical = async () => ({ number: 7, body, url: "https://github.com/example/work/issues/7" });

test("rehearses all pages beyond five comments and independently reads GitHub without certifying an assessment", async () => {
  let requests = 0, ghReads = 0;
  const c = client((url, init) => {
    requests++;
    assert.equal(url.origin, "https://context.example.test");
    assert.equal(init.redirect, "error"); assert.equal(init.method, "GET");
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${token}`);
    if (url.pathname.endsWith("/resolve")) return { ...envelope(), record };
    if (!url.pathname.endsWith("/sources")) return read();
    const sources = Array.from({ length: 28 }, (_, i) => source(i));
    const next = { at: sources[24].sourceAt, editionId: sources[24].editionId };
    if (url.searchParams.has("through")) {
      assert.equal(url.searchParams.get("through"), "28");
      assert.equal(url.searchParams.get("afterId"), next.editionId);
      return { ...envelope(), workId, through: 28, sources: sources.slice(25), next: null };
    }
    return { ...envelope(), workId, through: 28, sources: sources.slice(0, 25), next };
  });
  const report = await rehearseWorkRead(c, alias, async () => { ghReads++; return canonical(); });
  assert.equal(report.status, "read");
  assert.equal(report.authority, "github");
  if (report.status !== "read") return;
  assert.deepEqual(report.history, { through: 28, pages: 2, sourceCount: 28, gaps: 0, exactBodyObserved: true, coverage: "provider-limited" });
  assert.equal(report.reconciledAssessment, false); assert.equal(ghReads, 2); assert.equal(requests, 4);
});
test("distinguishes not captured from denied, offline, stale and an invalid authority response", async () => {
  assert.equal((await rehearseWorkRead(client(() => ({ ...envelope(), record: null })), alias, canonical)).status, "not_captured");
  for (const value of [new Response("private source", { status: 401 }), new Response("upstream error", { status: 503 }), { ...envelope(), workAuthority: "native", record }, { ...envelope(), observedAt: "2020-01-01T00:00:00.000Z", record }]) {
    await assert.rejects(client(() => value).resolve(alias), WorkServiceError);
  }
  await assert.rejects(client(() => { throw Error("private token in raw exception"); }).resolve(alias), (e: WorkServiceError) => e.code === "unavailable" && !e.message.includes("token"));
});
test("refuses credentials in URLs, paths, insecure remote transport, redirects and unbounded response bodies", async () => {
  for (const endpoint of ["https://user:pass@example.test", "http://example.test", "https://example.test/extra", "https://example.test?token=x"]) assert.throws(() => new WorkServiceClient(endpoint, token), WorkServiceError);
  await assert.rejects(client(() => new Response(null, { status: 302, headers: { location: "https://other.example.test" } })).resolve(alias), WorkServiceError);
  await assert.rejects(client(() => new Response("x".repeat(1_000_001), { headers: { "content-type": "application/json" } })).resolve(alias), WorkServiceError);
});
test("checks exact assessment receipts instead of accepting a projection or comment as saved work", async () => {
  const assessment = { schema: "company-context/work@1", currentPosition: "Test context", evidenceCheckedAt: "2026-10-30T00:00:00.000Z" }, hash = sha256(JSON.stringify(assessment)), revisionId = `wrv_${"4".repeat(26)}`;
  const response = { ...envelope(), record: { ...record, version: 1, revisionId, sha256: hash }, receipt: { workId, authority: "rehearsal", version: 1, revisionId, sha256: hash }, assessment };
  assert.equal((await client(() => response).read(workId)).receipt?.sha256, hash);
  await assert.rejects(client(() => ({ ...response, assessment: { ...assessment, currentPosition: "changed projection" } })).read(workId), WorkServiceError);
  await assert.rejects(client(() => ({ ...response, receipt: { ...response.receipt, workId: `wrk_${"5".repeat(26)}` } })).read(workId), WorkServiceError);
});
test("retains gaps, rejects moving canonical bodies, wrong aliases, cross-record sources and looping cursors", async () => {
  const gap = { ...source(0), unavailableReason: "Deleted edition unavailable", sha256: null, byteSize: null };
  const page = { ...envelope(), workId, through: 1, sources: [gap], next: null };
  assert.equal((await client(() => page).sources(workId)).sources[0].unavailableReason, gap.unavailableReason);
  await assert.rejects(client(() => ({ ...envelope(), record: { ...record, alias: { ...alias, repository: "other/work" } } })).resolve(alias), WorkServiceError);
  await assert.rejects(client(() => ({ ...page, sources: [{ ...gap, workId: `wrk_${"5".repeat(26)}` }] })).sources(workId), WorkServiceError);
  await assert.rejects(client(() => ({ ...page, next: { at: gap.sourceAt, editionId: `wse_${"6".repeat(26)}` } })).sources(workId), WorkServiceError);
  let ghReads = 0;
  const c = client(url => url.pathname.endsWith("/resolve") ? { ...envelope(), record } : url.pathname.endsWith("/sources") ? page : read());
  await assert.rejects(rehearseWorkRead(c, alias, async () => ({ ...(await canonical()), body: ghReads++ ? "moving source" : body })), WorkServiceError);
});
test("verifies exact UTF-8 excerpt length, source identity and response digest", async () => {
  const citation = { editionId, sha256: bodyHash, startByte: 0, endByte: Buffer.byteLength(body) };
  const { byteSize, ...metadata } = { ...source(0), editionId };
  const response = { ...envelope(), citation, source: metadata, text: body, excerptSha256: bodyHash };
  assert.equal((await client(() => response).excerpt(workId, citation)).text, body);
  await assert.rejects(client(() => ({ ...response, text: "altered" })).excerpt(workId, citation), WorkServiceError);
  await assert.rejects(client(() => ({ ...response, source: { ...metadata, sha256: "0".repeat(64) } })).excerpt(workId, citation), WorkServiceError);
});

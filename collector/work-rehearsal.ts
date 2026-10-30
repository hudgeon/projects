import type { ReadWorkRecord } from "./work-record";
import { recordHash } from "./work-record";
import { WorkServiceClient, WorkServiceError, sha256, type WorkAlias } from "./work-service";

// A separate private report, never an Issue/WorkSnapshot or canonical cache.
// Source enumeration and a matching body digest do not certify an assessment.
export async function rehearseWorkRead(client: WorkServiceClient, alias: WorkAlias, readCanonical: ReadWorkRecord, signal?: AbortSignal) {
  const canonical = await readCanonical(alias.repository, alias.issue);
  const liveSha256 = sha256(canonical.body);
  const resolved = await client.resolve(alias, signal);
  const base = { schema: "projects/work-rehearsal@1", authority: "github", mode: "read-only-rehearsal", checkedAt: new Date().toISOString(), alias, canonical: { url: canonical.url, bodySha256: liveSha256, recordHash: recordHash(canonical.body) } };
  if (!resolved) return { ...base, status: "not_captured" as const };
  const read = await client.read(resolved.id, signal);
  if (JSON.stringify(read.record.alias) !== JSON.stringify(resolved.alias)) throw new WorkServiceError("invalid");
  const seen = new Set<string>(); let next, through: number | undefined, pages = 0, sourceCount = 0, gaps = 0, exactBodyObserved = false;
  do {
    if (pages >= 1000) throw new WorkServiceError("unavailable");
    const page = await client.sources(resolved.id, { through, after: next ?? undefined, signal });
    through = page.through; next = page.next; pages++;
    for (const source of page.sources) {
      if (seen.has(source.editionId)) throw new WorkServiceError("invalid");
      seen.add(source.editionId); sourceCount++;
      if (source.unavailableReason) gaps++;
      // Same original locator and digest, never amount/title/issue number alone.
      if (source.locator === canonical.url && source.sha256 === liveSha256 && source.mediaType.startsWith("text/")) exactBodyObserved = true;
    }
  } while (next);
  // A moving live issue is a conflict, not a stale successful comparison.
  const independentlyRead = await readCanonical(alias.repository, alias.issue);
  if (independentlyRead.url !== canonical.url || sha256(independentlyRead.body) !== liveSha256) throw new WorkServiceError("unavailable");
  return { ...base, status: "read" as const, native: read, history: { through, pages, sourceCount, gaps, exactBodyObserved, coverage: "provider-limited" }, reconciledAssessment: false };
}

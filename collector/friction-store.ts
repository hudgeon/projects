import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { emptyCounts, frictionAppSchema, frictionCountsSchema, type FrictionCounts } from "../src/friction-model";
// Private friction receipts: one JSON file per native session under the
// machine's state directory, kept 90 days, updated from the bytes a
// transcript appended since the last scan. Only this machine reads them.
export const frictionDirectory = (home: string) =>
  path.join(home, ".local/share/project-overview/friction");
export const RECEIPT_DAYS = 90;
export const SCAN_BYTES = 64 * 1024 * 1024,
  SCAN_FILES = 60;
const receiptId = z.string().regex(/^[\w-]{1,80}$/);
export const receiptSchema = z
  .object({
    app: frictionAppSchema,
    id: receiptId,
    file: z.string().max(2000),
    // Bytes of the transcript already counted, up to a line end.
    bytes: z.number().int().nonnegative(),
    observedAt: z.number().int().nonnegative(),
    firstAt: z.number().int().nonnegative().nullable(),
    lastAt: z.number().int().nonnegative().nullable(),
    cwd: z.string().max(1000).optional(),
    version: z.string().max(40).optional(),
    client: z.string().max(40).optional(),
    counts: frictionCountsSchema,
    // The parser's own carry-over between scans.
    state: z.unknown(),
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
export type Parser<S> = {
  app: Receipt["app"];
  empty: () => S;
  record: (record: unknown, counts: FrictionCounts, state: S) => void;
  // What the state knows about the session as a whole.
  facts: (state: S) => Pick<Receipt, "cwd" | "version" | "client" | "firstAt" | "lastAt">;
};
export type Transcript = { id: string; file: string };
export async function savePrivate(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}
// Every receipt path passes through here, so an id that could leave the
// directory is refused whatever listed or saved it.
export function receiptFile(dir: string, app: Receipt["app"], id: string) {
  if (!receiptId.safeParse(id).success) throw new Error("Invalid receipt id");
  return path.join(dir, app.toLowerCase(), `${id}.json`);
}
// Every readable receipt; one that cannot be read or no longer fits is skipped.
export async function readReceipts(dir: string): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  for (const app of ["claude", "codex"]) {
    let names: string[] = [];
    try {
      names = await readdir(path.join(dir, app));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = receiptSchema.safeParse(
          JSON.parse(await readFile(path.join(dir, app, name), "utf8")),
        );
        if (parsed.success) receipts.push(parsed.data);
      } catch {
        /* A receipt being written, or damaged; the next scan rewrites it. */
      }
    }
  }
  return receipts;
}
// The complete lines a file holds from an offset, within a byte budget, and
// where the next read starts: after the last line end read.
export async function readLines(file: string, from: number, max: number) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < from) return { reset: true as const, size };
    const want = Math.min(size - from, max),
      cut = from + want < size;
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await handle.read(buffer, got, want - got, from + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const end = got ? buffer.lastIndexOf(0x0a, got - 1) : -1;
    if (end < 0) return { reset: false as const, size, cut, lines: [] as string[], next: from };
    return {
      reset: false as const,
      size,
      cut,
      lines: buffer.toString("utf8", 0, end).split("\n"),
      next: from + end + 1,
    };
  } finally {
    await handle.close();
  }
}
// Brings one session's receipt up to its transcript. Returns the bytes read.
export async function updateReceipt<S>(
  dir: string,
  parser: Parser<S>,
  transcript: Transcript,
  existing: Receipt | undefined,
  now: number,
  budget: number,
) {
  let receipt: Receipt =
    existing && existing.file === transcript.file
      ? existing
      : {
          app: parser.app,
          id: transcript.id,
          file: transcript.file,
          bytes: 0,
          observedAt: now,
          firstAt: null,
          lastAt: null,
          counts: emptyCounts(),
          state: parser.empty(),
        };
  const read = await readLines(transcript.file, receipt.bytes, budget);
  if (read.reset) {
    receipt = { ...receipt, bytes: 0, counts: emptyCounts(), state: parser.empty(), firstAt: null, lastAt: null };
    return updateReceipt(dir, parser, transcript, receipt, now, budget);
  }
  const state = receipt.state as S;
  for (const line of read.lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    parser.record(record, receipt.counts, state);
  }
  const facts = parser.facts(state);
  receipt = { ...receipt, ...facts, bytes: read.next, observedAt: now, state };
  await savePrivate(receiptFile(dir, parser.app, receipt.id), receipt);
  return {
    receipt,
    bytes: read.next - (existing?.file === transcript.file ? existing.bytes : 0),
    // Cut short by the budget; a partial last line is not waiting.
    more: read.cut,
  };
}
// Updates the receipts for the transcripts that changed, newest first, within
// the scan's budgets; what does not fit waits for the next scan.
export async function scanTranscripts<S>(
  dir: string,
  parser: Parser<S>,
  transcripts: Transcript[],
  receipts: Map<string, Receipt>,
  now: number,
  budget = { bytes: SCAN_BYTES, files: SCAN_FILES },
) {
  const cutoff = now - RECEIPT_DAYS * 86400_000;
  const changed: { transcript: Transcript; mtime: number }[] = [];
  let failed = 0;
  for (const transcript of transcripts) {
    if (!receiptId.safeParse(transcript.id).success) continue;
    try {
      const s = await stat(transcript.file);
      const existing = receipts.get(`${parser.app}:${transcript.id}`);
      if (!existing && s.mtimeMs < cutoff) continue;
      if (existing && existing.file === transcript.file && existing.bytes === s.size) continue;
      changed.push({ transcript, mtime: s.mtimeMs });
    } catch {
      failed += 1;
    }
  }
  changed.sort((a, b) => b.mtime - a.mtime);
  let bytes = budget.bytes,
    files = budget.files,
    waiting = 0,
    updated = 0;
  for (const { transcript } of changed) {
    if (files <= 0 || bytes <= 0) {
      waiting += 1;
      continue;
    }
    try {
      const result = await updateReceipt(
        dir,
        parser,
        transcript,
        receipts.get(`${parser.app}:${transcript.id}`),
        now,
        bytes,
      );
      receipts.set(`${parser.app}:${transcript.id}`, result.receipt);
      bytes -= result.bytes;
      files -= 1;
      updated += 1;
      if (result.more) waiting += 1;
    } catch {
      failed += 1;
    }
  }
  return { updated, waiting, failed };
}
// Receipts of sessions idle past the retention are removed.
export async function pruneReceipts(dir: string, receipts: Receipt[], now: number) {
  const cutoff = now - RECEIPT_DAYS * 86400_000;
  const kept: Receipt[] = [];
  for (const receipt of receipts) {
    if ((receipt.lastAt ?? receipt.observedAt) < cutoff)
      await rm(receiptFile(dir, receipt.app, receipt.id), { force: true });
    else kept.push(receipt);
  }
  return kept;
}

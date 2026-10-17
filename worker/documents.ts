import { digest } from "./auth";
import {
  MAX_DOCUMENT_BYTES,
  sourceKey,
  type DocumentFailure,
  type DocumentJob,
  type DocumentStatus,
  type HtmlSource,
} from "../src/document-model";

// A machine has this long to take an owner's request, then to deliver it.
export const DOCUMENT_WAIT_MS = 60_000;
// Editions kept, the least recently opened dropped first.
const KEEP = 30;
const CHUNK = 1_000_000;
type Row = {
  id: string;
  repo: string;
  commit_sha: string;
  path: string;
  state: DocumentStatus["state"];
  reason: DocumentFailure | null;
  requested: number;
  leased: number | null;
  runner: string | null;
  lease: string | null;
  bytes: number | null;
  fetched: number | null;
};
// The HTML editions the owner has opened, by repository, commit and file.
// Only a runner of the owner's machines fills one, and only once asked.
export class Documents {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,repo TEXT NOT NULL,commit_sha TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,requested INTEGER NOT NULL,leased INTEGER,runner TEXT,lease TEXT,bytes INTEGER,fetched INTEGER,viewed INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS document_chunks(id TEXT NOT NULL,seq INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,seq))",
    );
  }
  static id(source: HtmlSource) {
    return digest(sourceKey(source));
  }
  private row(id: string) {
    return this.storage.sql
      .exec<Row>("SELECT * FROM documents WHERE id=?", id)
      .toArray()[0];
  }
  // A request nobody took, or took and never delivered, fails rather than
  // waiting forever; the owner can ask again.
  private expire(now: number) {
    this.storage.sql.exec(
      "UPDATE documents SET state='failed',reason=CASE WHEN leased IS NULL THEN 'no_machine' ELSE 'unavailable' END,runner=NULL,lease=NULL WHERE state='pending' AND COALESCE(leased,requested) <= ?",
      now - DOCUMENT_WAIT_MS,
    );
  }
  private view(row: Row): DocumentStatus {
    return {
      state: row.state,
      reason: row.reason,
      bytes: row.bytes,
      fetchedAt: row.fetched,
      content: row.state === "ready" ? `/api/documents/${row.id}` : null,
    };
  }
  request(source: HtmlSource, retry = false, now = Date.now()) {
    this.expire(now);
    const id = Documents.id(source);
    const row = this.row(id);
    if (!row)
      this.storage.sql.exec(
        "INSERT INTO documents(id,repo,commit_sha,path,state,requested,viewed) VALUES(?,?,?,?,'pending',?,?)",
        id,
        source.repo,
        source.commit,
        source.path,
        now,
        now,
      );
    else if (row.state === "failed" && retry)
      this.storage.sql.exec(
        "UPDATE documents SET state='pending',reason=NULL,requested=?,leased=NULL,runner=NULL,lease=NULL WHERE id=?",
        now,
        id,
      );
    this.storage.sql.exec("UPDATE documents SET viewed=? WHERE id=?", now, id);
    this.prune();
    return this.view(this.row(id)!);
  }
  status(source: HtmlSource, now = Date.now()) {
    this.expire(now);
    const row = this.row(Documents.id(source));
    return row ? this.view(row) : null;
  }
  // The oldest waiting request, for a runner that can fetch documents.
  lease(owner: string, now = Date.now()): DocumentJob | null {
    this.expire(now);
    const row = this.storage.sql
      .exec<Row>(
        "UPDATE documents SET leased=?,runner=?,lease=? WHERE id=(SELECT id FROM documents WHERE state='pending' AND leased IS NULL ORDER BY requested LIMIT 1) RETURNING *",
        now,
        owner,
        crypto.randomUUID(),
      )
      .toArray()[0];
    return row
      ? { id: row.id, lease: row.lease!, repo: row.repo, commit: row.commit_sha, path: row.path }
      : null;
  }
  // Only the runner given this lease delivers it, once, before it expires.
  deliver(
    owner: string,
    id: string,
    lease: string,
    result: { bytes: Uint8Array } | { failure: DocumentFailure },
    now = Date.now(),
  ) {
    return this.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(id);
      if (!row || row.state !== "pending" || row.runner !== owner || row.lease !== lease) return false;
      const failure =
        "failure" in result
          ? result.failure
          : result.bytes.length > MAX_DOCUMENT_BYTES
            ? "too_large"
            : null;
      if (failure) {
        this.storage.sql.exec(
          "UPDATE documents SET state='failed',reason=?,runner=NULL,lease=NULL WHERE id=?",
          failure,
          id,
        );
        return true;
      }
      const { bytes } = result as { bytes: Uint8Array };
      this.storage.sql.exec("DELETE FROM document_chunks WHERE id=?", id);
      for (let seq = 0; seq * CHUNK < bytes.length; seq++)
        this.storage.sql.exec(
          "INSERT INTO document_chunks(id,seq,data) VALUES(?,?,?)",
          id,
          seq,
          bytes.slice(seq * CHUNK, (seq + 1) * CHUNK),
        );
      this.storage.sql.exec(
        "UPDATE documents SET state='ready',reason=NULL,runner=NULL,lease=NULL,bytes=?,fetched=? WHERE id=?",
        bytes.length,
        now,
        id,
      );
      return true;
    });
  }
  content(id: string, now = Date.now()) {
    const row = this.row(id);
    if (row?.state !== "ready" || row.bytes === null) return null;
    const chunks = this.storage.sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM document_chunks WHERE id=? ORDER BY seq",
        id,
      )
      .toArray()
      .map((chunk) => new Uint8Array(chunk.data));
    const bytes = new Uint8Array(row.bytes);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset + chunk.length > bytes.length) return null;
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== bytes.length) return null;
    this.storage.sql.exec("UPDATE documents SET viewed=? WHERE id=?", now, id);
    return bytes;
  }
  private prune() {
    const gone = this.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM documents ORDER BY viewed DESC LIMIT -1 OFFSET ?",
        KEEP,
      )
      .toArray();
    for (const { id } of gone) {
      this.storage.sql.exec("DELETE FROM document_chunks WHERE id=?", id);
      this.storage.sql.exec("DELETE FROM documents WHERE id=?", id);
    }
  }
}

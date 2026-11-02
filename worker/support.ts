// Sending cannot be retried as though it were an ordinary failed read. This
// ledger survives a machine change and records the boundary before Gmail.
import { readJson } from "./auth";
import { acknowledgmentInputSchema, type Acknowledgment, type AcknowledgmentInput } from "../src/support-model";
import type { MachineCaller } from "./machines";
import type { Portfolio } from "./index";
type Row = { key: string; owner: string; account: string; host: string; token: string; state: Acknowledgment["state"]; at: number | null; request_key: string | null; draft_id: string | null; triage: "issue" | "other" | "needs-review" | null };
export class SupportAcknowledgments {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS support_acknowledgments(key TEXT PRIMARY KEY,owner TEXT NOT NULL,account TEXT NOT NULL,host TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,at INTEGER)");
    const columns = storage.sql.exec<{ name: string }>("PRAGMA table_info(support_acknowledgments)").toArray();
    for (const column of ["request_key", "draft_id", "triage"])
      if (!columns.some(c => c.name === column)) storage.sql.exec(`ALTER TABLE support_acknowledgments ADD COLUMN ${column} TEXT`);
  }
  act(input: AcknowledgmentInput, host: string): Acknowledgment | null {
    const { key, action } = input;
    // A stale installed collector can never obtain permission to send email.
    if (action === "begin" || action === "uncertain") return null;
    let draft = false;
    let row = this.storage.sql.exec<Row>("SELECT * FROM support_acknowledgments WHERE key=?", key).toArray()[0];
    if (!row && action === "reserve") {
      if (!input.requestKey) return null;
      this.storage.sql.exec("INSERT INTO support_acknowledgments(key,owner,account,host,token,state,request_key) VALUES(?,?,?,?,?,'reserved',?)", key, input.owner.toLowerCase(), input.account.toLowerCase(), host, crypto.randomUUID(), input.requestKey);
      row = this.storage.sql.exec<Row>("SELECT * FROM support_acknowledgments WHERE key=?", key).one();
    }
    if (!row || row.owner !== input.owner.toLowerCase() || row.account !== input.account.toLowerCase()) return null;
    if (action === "reserve" && row.state === "reserved" && input.requestKey && row.request_key !== input.requestKey) {
      // Safe to replace an unsent reservation; never replace a drafting or
      // completed draft, including one a person has edited or deleted.
      row = { ...row, request_key: input.requestKey, host, token: crypto.randomUUID() };
      this.storage.sql.exec("UPDATE support_acknowledgments SET request_key=?,host=?,token=? WHERE key=?", input.requestKey, host, row.token, key);
    }
    if (action === "reserve" && row.state === "reserved" && row.host !== host) {
      row = { ...row, host, token: crypto.randomUUID() };
      this.storage.sql.exec("UPDATE support_acknowledgments SET host=?,token=? WHERE key=?", host, row.token, key);
    }
    const owns = row.host === host && input.token === row.token;
    if (action !== "reserve") {
      if (!owns) return null;
      if (action === "release" && row.state === "reserved") {
        this.storage.sql.exec("DELETE FROM support_acknowledgments WHERE key=?", key);
        return null;
      }
      if (["begin-draft", "drafted", "draft-uncertain"].includes(action) && (!input.requestKey || input.requestKey !== row.request_key)) return null;
      if (action === "drafted" && !input.draftId) return null;
      const next = action === "begin-draft" && row.state === "reserved" ? "drafting"
        : action === "drafted" && ["drafting", "draft-uncertain"].includes(row.state) ? "drafted"
        : action === "draft-uncertain" && row.state === "drafting" ? "draft-uncertain"
        : action === "sent" && ["sending", "uncertain"].includes(row.state) ? "sent"
        : row.state;
      const at = ["sent", "drafted"].includes(next) ? row.at ?? Date.now() : row.at;
      const draftId = next === "drafted" ? row.draft_id ?? input.draftId! : row.draft_id;
      const triage = row.triage ?? input.triage ?? null;
      draft = action === "begin-draft" && row.state === "reserved";
      this.storage.sql.exec("UPDATE support_acknowledgments SET state=?,at=?,draft_id=?,triage=? WHERE key=?", next, at, draftId, triage, key);
      row = { ...row, state: next, at, draft_id: draftId, triage };
    }
    return { state: row.state, ...(row.at === null ? {} : row.state === "sent" ? { acknowledgedAt: row.at } : { draftedAt: row.at }),
      ...(draft ? { draft: true as const } : {}),
      ...(row.draft_id ? { draftId: row.draft_id } : {}), ...(row.request_key ? { requestKey: row.request_key } : {}),
      ...(row.triage ? { triage: row.triage } : {}),
      ...(row.host === host && (row.state === "reserved" || owns) ? { token: row.token } : {}) };
  }
}
type Store = Pick<DurableObjectStub<Portfolio>, "supportAcknowledgment" | "rate">;
export async function supportRoutes(request: Request, store: Store, caller: string | MachineCaller, onDuty: () => Promise<boolean>, allowed: (email: string) => boolean) {
  if (new URL(request.url).pathname !== "/api/support/ack") return null;
  if (typeof caller === "string" || caller.role !== "collector" || !(await onDuty())) return new Response("Only the collector on duty can acknowledge support", { status: 403 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const parsed = acknowledgmentInputSchema.safeParse(await readJson(request, 2048));
  if (!parsed.success || !allowed(parsed.data.owner.toLowerCase())) return new Response("Invalid acknowledgment", { status: 400 });
  if (!(await store.rate(`support:${caller.machine}`, 500, 60_000))) return new Response("Try later", { status: 429 });
  const receipt = await store.supportAcknowledgment(parsed.data, caller.machine);
  return Response.json({ receipt }, { headers: { "Cache-Control": "no-store" } });
}

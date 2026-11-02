// Sending cannot be retried as though it were an ordinary failed read. This
// ledger survives a machine change and records the boundary before Gmail.
import { readJson } from "./auth";
import { acknowledgmentInputSchema, supportTaskPointerSchema, type Acknowledgment, type AcknowledgmentInput, type SupportTaskPointer } from "../src/support-model";
import type { MachineCaller } from "./machines";
import type { Portfolio } from "./index";
import { investigationRoutes, supportAvailable, supportView, supportMatches, invalidateSupport, type SupportEnvironment, type SupportSource } from "./support-investigation";
import type { Chats } from "./chats";
import type { ChatList, ChatRead } from "../src/chat-model";
export { supportHealthy } from "./support-investigation";
type Row = { key: string; owner: string; account: string; host: string; token: string; state: Acknowledgment["state"]; at: number | null; request_key: string | null; draft_id: string | null; triage: "issue" | "other" | "needs-review" | null; investigation: string | null };
export class SupportAcknowledgments {
  constructor(private storage: DurableObjectStorage, private env?: SupportEnvironment, private background?: (work: Promise<unknown>) => void) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS support_acknowledgments(key TEXT PRIMARY KEY,owner TEXT NOT NULL,account TEXT NOT NULL,host TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,at INTEGER)");
    const columns = storage.sql.exec<{ name: string }>("PRAGMA table_info(support_acknowledgments)").toArray();
    for (const column of ["request_key", "draft_id", "triage", "investigation"])
      if (!columns.some(c => c.name === column)) storage.sql.exec(`ALTER TABLE support_acknowledgments ADD COLUMN ${column} TEXT`);
  }
  canBootstrap(key: string, owner: string, requestKey?: string) {
    return !!requestKey && this.storage.sql.exec("SELECT key FROM support_acknowledgments WHERE key=? AND owner=? AND request_key=? AND state='reserved'", key, owner.toLowerCase(), requestKey).toArray().length === 1;
  }
  task(key: string, owner: string, value?: SupportTaskPointer, source?: SupportSource | null): SupportTaskPointer | null {
    const row = this.storage.sql.exec<Row>("SELECT * FROM support_acknowledgments WHERE key=? AND owner=?", key, owner.toLowerCase()).toArray()[0];
    if (!row) return null;
    let prior: SupportTaskPointer | null = null;
    if (row.investigation) { try { prior = supportTaskPointerSchema.parse(JSON.parse(row.investigation)); } catch { return null; } }
    if (!value) return prior;
    const parsed = supportTaskPointerSchema.safeParse(value);
    if (!parsed.success || !source || source.account !== row.account || !supportMatches(parsed.data, source) && parsed.data.state !== "held") return prior;
    if (prior && (prior.task !== value.task || prior.requestKey !== value.requestKey || prior.audienceHash !== value.audienceHash || prior.sourceHash !== value.sourceHash)) return prior;
    if (!prior && (row.state !== "reserved" || row.request_key !== value.requestKey || value.summary.kind !== "issue")) return null;
    if (prior?.invalidated) return prior;
    this.storage.sql.exec("UPDATE support_acknowledgments SET investigation=? WHERE key=?", JSON.stringify(parsed.data), key);
    return parsed.data;
  }
  decorate(list: ChatList): ChatList {
    return { ...list, items: list.items.map(item => {
      if (item.source !== "support" || !item.support) return item;
      const pointer = this.task(item.id, item.owner);
      return { ...item, support: { ...item.support, investigation: pointer && this.env ? supportView(pointer, this.env) : { state: item.support.investigation?.state === "unavailable" ? "unavailable" as const : "off" as const } } };
    }) };
  }
  async publish(chats: Chats, read: ChatRead, host: string) {
    const result = await chats.publish(read, host);
    if (result.accepted && read.source === "support" && this.env && supportAvailable(this.env)) {
      const pointers = this.storage.sql.exec<Row>("SELECT * FROM support_acknowledgments WHERE owner=? AND investigation IS NOT NULL", read.owner.toLowerCase()).toArray();
      let scheduled = 0;
      for (const row of pointers) {
        let pointer: SupportTaskPointer;
        try { pointer = supportTaskPointerSchema.parse(JSON.parse(row.investigation!)); } catch { continue; }
        if (pointer.invalidated || scheduled >= 10) continue;
        const item = read.items.find(item => item.id === row.key);
        const source = item?.support ? { id: item.id, owner: read.owner, account: item.support.account, request: item.support.request, subject: item.place.name, text: item.text, active: read.state === "ok" } : null;
        if (source && supportMatches(pointer, source)) continue;
        scheduled++;
        this.storage.sql.exec("UPDATE support_acknowledgments SET investigation=? WHERE key=?", JSON.stringify({ ...pointer, state: "held" }), row.key);
        const work = invalidateSupport(this.env, pointer.task).then(invalidated => {
          if (invalidated) this.storage.sql.exec("UPDATE support_acknowledgments SET investigation=? WHERE key=?", JSON.stringify({ ...pointer, state: "held", invalidated: true }), row.key);
        });
        this.background?.(work);
      }
    }
    return result;
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
type Store = Pick<DurableObjectStub<Portfolio>, "supportAcknowledgment" | "supportSource" | "supportInvestigation" | "rate">;
export async function supportRoutes(request: Request, store: Store, caller: string | MachineCaller, onDuty: () => Promise<boolean>, allowed: (email: string) => boolean, env: SupportEnvironment) {
  const investigation = await investigationRoutes(request, store, caller, onDuty, allowed, env);
  if (investigation) return investigation;
  if (new URL(request.url).pathname !== "/api/support/ack") return null;
  if (typeof caller === "string" || caller.role !== "collector" || !(await onDuty())) return new Response("Only the collector on duty can acknowledge support", { status: 403 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const parsed = acknowledgmentInputSchema.safeParse(await readJson(request, 2048));
  if (!parsed.success || !allowed(parsed.data.owner.toLowerCase())) return new Response("Invalid acknowledgment", { status: 400 });
  if (!(await store.rate(`support:${caller.machine}`, 500, 60_000))) return new Response("Try later", { status: 429 });
  const receipt = await store.supportAcknowledgment(parsed.data, caller.machine);
  return Response.json({ receipt }, { headers: { "Cache-Control": "no-store" } });
}

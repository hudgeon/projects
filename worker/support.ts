// Sending cannot be retried as though it were an ordinary failed read. This
// ledger survives a machine change and records the boundary before Gmail.
import { readJson } from "./auth";
import { acknowledgmentInputSchema, type Acknowledgment, type AcknowledgmentInput } from "../src/support-model";
import type { MachineCaller } from "./machines";
import type { Portfolio } from "./index";
type Row = { key: string; owner: string; account: string; host: string; token: string; state: Acknowledgment["state"]; at: number | null };
export class SupportAcknowledgments {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS support_acknowledgments(key TEXT PRIMARY KEY,owner TEXT NOT NULL,account TEXT NOT NULL,host TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,at INTEGER)");
  }
  act(input: AcknowledgmentInput, host: string): Acknowledgment | null {
    const { key, action } = input;
    let send = false;
    let row = this.storage.sql.exec<Row>("SELECT * FROM support_acknowledgments WHERE key=?", key).toArray()[0];
    if (!row && action === "reserve") {
      this.storage.sql.exec("INSERT INTO support_acknowledgments(key,owner,account,host,token,state) VALUES(?,?,?,?,?,'reserved')", key, input.owner.toLowerCase(), input.account.toLowerCase(), host, crypto.randomUUID());
      row = this.storage.sql.exec<Row>("SELECT * FROM support_acknowledgments WHERE key=?", key).one();
    }
    if (!row || row.owner !== input.owner.toLowerCase() || row.account !== input.account.toLowerCase()) return null;
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
      const next = action === "begin" && row.state === "reserved" ? "sending"
        : action === "sent" && ["sending", "uncertain"].includes(row.state) ? "sent"
        : action === "uncertain" && row.state === "sending" ? "uncertain" : row.state;
      const at = next === "sent" ? row.at ?? Date.now() : row.at;
      send = action === "begin" && row.state === "reserved";
      this.storage.sql.exec("UPDATE support_acknowledgments SET state=?,at=? WHERE key=?", next, at, key);
      row = { ...row, state: next, at };
    }
    return { state: row.state, ...(row.at === null ? {} : { acknowledgedAt: row.at }),
      ...(send ? { send: true as const } : {}),
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

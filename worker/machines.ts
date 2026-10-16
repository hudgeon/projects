import { digest, token } from "./auth";
import { FALLBACK_AFTER_MS } from "../src/run-model";
import type { MachineView } from "../src/model";

// A machine publishes its own snapshot with its collector token and runs
// conversations with its runner token; only their hashes are kept. Machines
// are ordered: the first one heard from recently takes the shared duties
// (work items, Mark done, inbox) and new conversations.
export const COLLECTOR_SILENCE_MS = 5 * 60_000;
export type MachineRole = "collector" | "runner";
export type MachineCaller = {
  role: MachineRole;
  machine: string;
  // A machine whose conversations were claimed before owners were per
  // machine keeps its runner IDs as owners, so those claims stay valid.
  plainOwner: boolean;
};
type Row = {
  id: string;
  name: string;
  position: number;
  collector_hash: string | null;
  runner_hash: string | null;
  plain_owner: number;
};
export const machineName = (value: string) => {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
};
export class Machines {
  constructor(private storage: DurableObjectStorage) {
    const sql = storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,collector_hash TEXT UNIQUE,runner_hash TEXT UNIQUE,plain_owner INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS collector_contact(host TEXT PRIMARY KEY,at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS runner_contact(host TEXT PRIMARY KEY,at INTEGER NOT NULL)",
    );
  }
  private rows() {
    return this.storage.sql
      .exec<Row>("SELECT * FROM machines ORDER BY position,created")
      .toArray();
  }
  private contact(table: "collector_contact" | "runner_contact", host: string) {
    return (
      this.storage.sql
        .exec<{ at: number }>(`SELECT at FROM ${table} WHERE host=?`, host)
        .toArray()[0]?.at ?? null
    );
  }
  private present(
    table: "collector_contact" | "runner_contact",
    host: string,
    window: number,
    now: number,
  ) {
    const at = this.contact(table, host);
    return at !== null && now - at < window;
  }
  // Duties go to the first machine in order whose collector published in the
  // last five minutes; a caller that is not registered (the owner, locally)
  // has them only when no machine does.
  collectorDuties(host: string, now = Date.now()) {
    for (const row of this.rows()) {
      if (row.id === host) return true;
      if (this.present("collector_contact", row.id, COLLECTOR_SILENCE_MS, now))
        return false;
    }
    return true;
  }
  // New conversations go to the first machine in order whose runner called
  // in the last two minutes; a runner that is not registered (only a direct
  // call, as in tests) takes them only when no machine is present. A
  // conversation stays with the machine that claimed it.
  takesNewWork(host: string, now = Date.now()) {
    for (const row of this.rows()) {
      if (row.id === host) return true;
      if (this.present("runner_contact", row.id, FALLBACK_AFTER_MS, now))
        return false;
    }
    return true;
  }
  runnerAway(host: string, now = Date.now()) {
    return !this.present("runner_contact", host, FALLBACK_AFTER_MS, now);
  }
  list(now = Date.now()): MachineView[] {
    return this.rows().map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      lastCollected: this.contact("collector_contact", row.id),
      lastRunner: this.contact("runner_contact", row.id),
      duties: this.collectorDuties(row.id, now),
      newWork: this.takesNewWork(row.id, now),
    }));
  }
  // The token's hash, from the Worker; the token itself never arrives here.
  caller(role: MachineRole, hash: string): MachineCaller | null {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const row = this.storage.sql
      .exec<Row>(
        `SELECT * FROM machines WHERE ${role === "collector" ? "collector_hash" : "runner_hash"}=?`,
        hash,
      )
      .toArray()[0];
    return row
      ? { role, machine: row.id, plainOwner: row.plain_owner === 1 }
      : null;
  }
  // Both tokens are replaced together and returned once; only hashes stay.
  private tokens(id: string) {
    const collector = token(),
      runner = token();
    this.storage.sql.exec(
      "UPDATE machines SET collector_hash=?,runner_hash=? WHERE id=?",
      digest(collector),
      digest(runner),
      id,
    );
    return { collector, runner };
  }
  // A new machine goes last.
  add(value: string) {
    const name = machineName(value);
    if (!name) return null;
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28)
        .replace(/-+$/, "") || "machine";
    let id = base;
    for (let n = 2; this.registered(id); n++) id = `${base}-${n}`;
    this.storage.sql.exec(
      "INSERT INTO machines(id,name,position,created) VALUES(?,?,(SELECT COALESCE(MAX(position)+1,0) FROM machines),?)",
      id,
      name,
      Date.now(),
    );
    return { id, tokens: this.tokens(id) };
  }
  replaceTokens(id: string) {
    return this.registered(id) ? this.tokens(id) : null;
  }
  rename(id: string, value: string) {
    const name = machineName(value);
    if (!name || !this.registered(id)) return false;
    this.storage.sql.exec("UPDATE machines SET name=? WHERE id=?", name, id);
    return true;
  }
  move(id: string, position: number) {
    const ids = this.rows().map((row) => row.id);
    const from = ids.indexOf(id);
    if (from === -1) return false;
    ids.splice(from, 1);
    ids.splice(Math.max(0, Math.min(position, ids.length)), 0, id);
    ids.forEach((machine, index) =>
      this.storage.sql.exec(
        "UPDATE machines SET position=? WHERE id=?",
        index,
        machine,
      ),
    );
    return true;
  }
  // Removing a machine revokes its tokens at once and drops its snapshot.
  // Conversations it claimed stay, and can continue on another machine.
  remove(id: string) {
    if (!this.registered(id)) return false;
    this.storage.sql.exec("DELETE FROM machines WHERE id=?", id);
    this.storage.sql.exec("DELETE FROM snapshots WHERE host=?", id);
    this.storage.sql.exec("DELETE FROM collector_contact WHERE host=?", id);
    return true;
  }
  first() {
    return this.rows()[0]?.id ?? null;
  }
  registered(id: string) {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM machines WHERE id=?", id)
        .toArray().length === 1
    );
  }
  // Conversations can start once some machine can run them.
  runnable() {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM machines WHERE runner_hash IS NOT NULL LIMIT 1")
        .toArray().length === 1
    );
  }
}

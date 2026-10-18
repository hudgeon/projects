import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { MESSAGE_REQUEST_BYTES } from "../src/screenshot-model";
import type { MessageInput } from "../src/run-model";
import { Runs } from "./run-directory";
import { pushEndpoint, sendPush, vapidPublicKey } from "./push";
import { notice } from "../src/run-text";
import { attributes, observeRequest, trace } from "./telemetry";
import { BrowserSignIns, browserPath } from "./browser";
import { Documents } from "./documents";
import { DOCUMENT_CSP, MAX_DOCUMENT_BYTES, documentRequestSchema, htmlSource, runnerDocumentSchema, runnerLeaseSchema, type HtmlSource } from "../src/document-model";
export { Conversation } from "./runs";
import { runInputSchema, runListSchema, runArchiveSchema, messageInputSchema, runnerClaimSchema, runnerHeartbeatSchema, runnerReportSchema, type Lane, type RunnerHost, type RunInput, type Progress, type RunListOptions } from "../src/run-model";
import { archiveInputSchema, archiveKey, type ArchiveEntry, type ArchiveTarget } from "../src/archive-model";
import { telemetry } from "../src/telemetry";
import { codexComparison, executionSettingsSchema, METRIC_LIMIT, METRIC_WINDOW_MS, type CodexSample, type ExecutionSettings } from "../src/codex-metrics";
import { z } from "zod";
import {
  authorize,
  login,
  digest,
  equal,
  readJson,
  sameOrigin,
  SESSION_SECONDS,
  type Caller,
  allowed,
  browserMay,
  signsIn,
} from "./auth";
import { freshness, snapshotSchema, STALE_AFTER, type Snapshot } from "../src/model";
import { Machines, type MachineCaller, type MachineRole } from "./machines";
import {
  currentInbox,
  inboxActionReportSchema,
  inboxActionRequestSchema,
  type InboxAction,
  type InboxActionReport,
  type PendingInboxAction,
} from "../src/inbox-model";
import {
  closeReportSchema,
  currentWork,
  isDone,
  RECENT_WORK_DAYS,
  type Close,
  type CloseReport,
  type PendingClose,
} from "../src/work-model";

// How long a machine on duty keeps its last inbox read through scans that
// could not learn they were on duty.
const KEEP_INBOX_MS = 3 * STALE_AFTER;
// A portfolio belongs to one owner, not a shared global collection.
export class Portfolio extends DurableObject<Env> {
  private runs: Runs;
  private machines: Machines;
  private documents: Documents;
  private signIns: BrowserSignIns;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.machines = new Machines(ctx.storage);
    this.documents = new Documents(ctx.storage);
    this.signIns = new BrowserSignIns(ctx.storage, env, (id) => this.machines.registered(id));
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS codex_metrics (id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS codex_metrics_at ON codex_metrics(at)");
    this.runs = new Runs(ctx.storage, env, this.machines, (previous, next) => {
      const text = notice(previous, next);
      if (text) this.notify({ run: next.id, ...text });
    });
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, created INTEGER NOT NULL, used INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS push_events (id TEXT PRIMARY KEY, run TEXT, title TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshots (host TEXT PRIMARY KEY, observed INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS archive_entries (key TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, sent INTEGER NOT NULL, attempts INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)",
    );
    // Closes were keyed by an older work ID before work items became issues.
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS closes");
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS issue_closes (issue INTEGER PRIMARY KEY, requested INTEGER NOT NULL, email TEXT NOT NULL, state TEXT NOT NULL, message TEXT, updated INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS inbox_actions (thread TEXT PRIMARY KEY, action TEXT NOT NULL, requested INTEGER NOT NULL, state TEXT NOT NULL, message TEXT, updated INTEGER NOT NULL)",
    );
    if (!this.ctx.storage.sql.exec<{name: string}>("PRAGMA table_info(inbox_actions)").toArray().some(c => c.name === "issue"))
      this.ctx.storage.sql.exec("ALTER TABLE inbox_actions ADD COLUMN issue INTEGER");

  }
  // Each machine's collector publishes its own snapshot. The first machine in
  // order that published in the last five minutes also reads the inbox and
  // work items and applies Mark done and inbox requests.
  collectorDuties(from: string) {
    return this.machines.collectorDuties(from);
  }
  machineCaller(role: MachineRole, hash: string) {
    return this.machines.caller(role, hash);
  }
  machineList() {
    return this.machines
      .list()
      .map((machine) => ({ ...machine, browserSignIn: signsIn(this.env, machine.id) }));
  }
  runnable() {
    return this.machines.runnable();
  }
  machineRegistered(id: string) {
    return this.machines.registered(id);
  }
  addMachine(name: string) {
    return this.machines.add(name);
  }
  replaceMachineTokens(id: string) {
    return this.machines.replaceTokens(id);
  }
  renameMachine(id: string, name: string) {
    return this.machines.rename(id, name);
  }
  moveMachine(id: string, position: number) {
    return this.machines.move(id, position);
  }
  removeMachine(id: string) {
    const removed = this.machines.remove(id);
    if (removed) this.signIns.endMachine(id);
    return removed;
  }
  // Only a conversation's own browser starts and ends these (worker/browser.ts).
  startBrowserSignIn(hash: string, run: string, machine: string, expires: number) {
    return this.signIns.start(hash, run, machine, expires);
  }
  endBrowserSignIn(run: string) {
    this.signIns.end(run);
  }
  listRuns(options: RunListOptions = {}) { return this.runs.list(options); }
  runtimeVersions(id?: string) { return this.runs.runtimeVersions(id); }
  getRun(id: string) { return this.runs.get(id); }
  createRun(input: RunInput) { return this.runs.create(input); }
  messageRun(id: string, input: MessageInput) { return this.runs.message(id, input); }
  screenshot(id: string, screenshotId: string, owner?: string, generation?: number) { return this.runs.screenshot(id, screenshotId, owner, generation); }
  cancelRun(id: string) { return this.runs.cancel(id); }
  // Done finishes an activity; source email is archived only by an explicit action.
  archiveRun(id: string, archived: boolean) { return this.runs.archive(id, archived); }
  moveRun(id: string) { return this.runs.move(id); }
  runners() { return this.runs.runners(); }
  claimRun(owner: string, activeRunIds: string[], lanes: Lane[] | undefined, host: RunnerHost) { return this.runs.claim(owner, activeRunIds, lanes, host); }
  // HTML editions come only from repositories a machine reports: a project or
  // the work repository.
  requestDocument(source: HtmlSource, retry: boolean) {
    const repo = source.repo.toLowerCase();
    const known = this.overview().some((s) => s.projects.some((p) => p.repo.toLowerCase() === repo) || s.work?.repo?.toLowerCase() === repo);
    return known ? this.documents.request(source, retry) : null;
  }
  documentStatus(source: HtmlSource) { return this.documents.status(source); }
  leaseDocument(owner: string) { return this.documents.lease(owner); }
  deliverDocument(owner: string, id: string, lease: string, result: { bytes: Uint8Array } | { failure: "not_found" | "too_large" | "not_html" | "unavailable" }) { return this.documents.deliver(owner, id, lease, result); }
  documentContent(id: string) { return this.documents.content(id); }
  heartbeatRun(owner: string, id: string, generation: number, host: RunnerHost) { return this.runs.heartbeat(owner, id, generation, host); }
  async reportRun(owner: string, id: string, generation: number, progress: Progress, host: RunnerHost) {
    return this.runs.report(owner, id, generation, progress, host, recorded => {
      // Use the canonical receipt, not an older/replayed request body.
      for (const event of recorded.telemetry ?? [])
        if (event.event === "native_finished" && (event.agent ?? event.actor) === "codex" && event.codexFast !== undefined && event.at <= Date.now() && event.at >= Date.now() - METRIC_WINDOW_MS)
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO codex_metrics(id,at,payload) VALUES(?,?,?)", `${id}:${event.id}`, event.at, JSON.stringify({...event, host}));
      this.pruneCodexMetrics();
    });
  }
  executionSettings(): Promise<ExecutionSettings> {
    return this.ctx.storage.get<ExecutionSettings>("execution-settings").then(value => value ?? {codexFast: false});
  }
  async setExecutionSettings(input: ExecutionSettings) {
    await this.ctx.storage.put("execution-settings", executionSettingsSchema.parse(input));
    return this.executionSettings();
  }
  private pruneCodexMetrics() {
    this.ctx.storage.sql.exec("DELETE FROM codex_metrics WHERE at < ?", Date.now() - METRIC_WINDOW_MS);
    this.ctx.storage.sql.exec("DELETE FROM codex_metrics WHERE id IN (SELECT id FROM codex_metrics ORDER BY at DESC,id DESC LIMIT -1 OFFSET ?)", METRIC_LIMIT);
  }
  async executionSettingsView() {
    this.pruneCodexMetrics();
    const samples = this.ctx.storage.sql.exec<{payload: string}>("SELECT payload FROM codex_metrics ORDER BY at DESC,id DESC").toArray().map(row => JSON.parse(row.payload) as CodexSample);
    return {...await this.executionSettings(), metrics: codexComparison(samples)};
  }
  rate(key: string, max: number, window: number) {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM limits WHERE expires <= ?", now);
    const row = this.ctx.storage.sql
      .exec<{ count: number }>(
        "INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
        key,
        now + window,
      )
      .one();
    return row.count <= max;
  }
  issue(email: string, salt: string, hash: string) {
    const now = Date.now();
    return (
      this.ctx.storage.sql
        .exec(
          "INSERT INTO codes(email,salt,hash,expires,sent,attempts) VALUES(?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,expires=excluded.expires,sent=excluded.sent,attempts=0 WHERE codes.sent <= ? RETURNING email",
          email,
          salt,
          hash,
          now + 600_000,
          now,
          now - 60_000,
        )
        .toArray().length === 1
    );
  }
  cancelCode(email: string, salt: string) {
    this.ctx.storage.sql.exec(
      "DELETE FROM codes WHERE email=? AND salt=?",
      email,
      salt,
    );
  }
  verify(email: string, code: string, hash: string) {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.ctx.storage.sql
        .exec<{
          salt: string;
          hash: string;
          attempts: number;
          expires: number;
        }>("SELECT * FROM codes WHERE email=?", email)
        .toArray()[0];
      if (!row || row.expires <= now || row.attempts >= 5) return false;
      this.ctx.storage.sql.exec(
        "UPDATE codes SET attempts=attempts+1 WHERE email=?",
        email,
      );
      if (!equal(row.hash, digest(`${row.salt}:${code}`))) return false;
      this.ctx.storage.sql.exec("DELETE FROM codes WHERE email=?", email);
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires<=?", now);
      this.ctx.storage.sql.exec(
        "INSERT INTO sessions(hash,email,expires) VALUES(?,?,?)",
        hash,
        email,
        now + SESSION_SECONDS * 1000,
      );
      return true;
    });
  }
  // The owner's own sign-in, or a conversation browser's, with its machine.
  session(hash: string): { email: string; machine: string | null } | null {
    const email = this.ctx.storage.sql
      .exec<{ email: string }>(
        "SELECT email FROM sessions WHERE hash=? AND expires>?",
        hash,
        Date.now(),
      )
      .toArray()[0]?.email;
    return email ? { email, machine: null } : this.signIns.find(hash);
  }
  revoke(hash: string) {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE hash=?", hash);
    this.signIns.revoke(hash);
  }
  async publish(snapshot: Snapshot) {
    this.ctx.storage.sql.exec(
      "INSERT INTO collector_contact(host,at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET at=excluded.at",
      snapshot.host,
      Date.now(),
    );
    // The machine on duty keeps its last inbox read through a scan that could
    // not learn it was on duty, so a brief outage does not empty the inbox.
    // The read keeps its own time, so its age shows, and lapses after a few
    // missed scans.
    const last = !snapshot.inbox && this.collectorDuties(snapshot.host)
      ? this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM snapshots WHERE host=?", snapshot.host).toArray()[0]
      : undefined;
    const kept = last ? (JSON.parse(last.payload) as Snapshot).inbox : undefined;
    const stored = kept && Date.now() - kept.observedAt < KEEP_INBOX_MS ? { ...snapshot, inbox: kept } : snapshot;
    const result = this.ctx.storage.sql
      .exec<{ host: string }>(
        "INSERT INTO snapshots(host,observed,payload) VALUES(?,?,?) ON CONFLICT(host) DO UPDATE SET observed=excluded.observed,payload=excluded.payload WHERE excluded.observed > snapshots.observed RETURNING host",
        snapshot.host,
        snapshot.collectedAt,
        JSON.stringify(stored),
      )
      .toArray();
    return { accepted: result.length === 1 };
  }
  overview() {
    return this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM snapshots ORDER BY host")
      .toArray()
      .map((x) => JSON.parse(x.payload) as Snapshot);
  }
  archives(): ArchiveEntry[] {
    return this.ctx.storage.sql.exec<{payload: string}>("SELECT payload FROM archive_entries ORDER BY key")
      .toArray().map((row) => JSON.parse(row.payload) as ArchiveEntry);
  }
  archive(target: ArchiveTarget, archived: boolean): ArchiveEntry[] | null {
    const key = archiveKey(target);
    if (!archived) {
      const changed = this.ctx.storage.sql.exec("DELETE FROM archive_entries WHERE key=? RETURNING key", key).toArray().length;
      if (changed) telemetry("worker", target.kind === "project" ? "project_restored" : "session_restored");
      return this.archives();
    }
    const existing = this.archives();
    if (existing.some((entry) => archiveKey(entry.target) === key)) return existing;
    const snapshots = this.overview().sort((a, b) => b.collectedAt - a.collectedAt);
    let item: {title: string; projectId: string | null} | undefined;
    if (target.kind === "project") {
      const project = snapshots.flatMap((snapshot) => snapshot.projects).find((p) => p.id === target.projectId);
      if (project) item = { title: project.name, projectId: project.id };
    } else {
      const snapshot = snapshots.find((s) => s.host === target.host);
      const session = [
        ...(snapshot?.projects.flatMap((p) => p.sessions.map((s) => ({...s, projectId: p.id}))) ?? []),
        ...(snapshot?.unassignedSessions.map((s) => ({...s, projectId: null})) ?? []),
      ].find((s) => s.id === target.sessionId && s.app === target.app);
      if (session) item = {title: session.title, projectId: session.projectId};
    }
    if (!item) return null;
    this.ctx.storage.sql.exec(
      "INSERT INTO archive_entries(key,payload) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
      key, JSON.stringify({target, ...item, archivedAt: Date.now()} satisfies ArchiveEntry),
    );
    telemetry("worker", target.kind === "project" ? "project_archived" : "session_archived");
    return this.archives();
  }
  closes(): Close[] {
    return this.ctx.storage.sql
      .exec<{
        issue: number;
        requested: number;
        state: Close["state"];
        message: string | null;
        updated: number;
      }>(
        "SELECT issue,requested,state,message,updated FROM issue_closes ORDER BY issue",
      )
      .toArray()
      .map((r) => ({
        issue: r.issue,
        requestedAt: r.requested,
        state: r.state,
        message: r.message,
        updatedAt: r.updated,
      }));
  }
  // One queued request per issue; a finished or failed one can be asked again.
  // Finished requests outlive the window in which a closed issue is shown.
  requestClose(issue: number, email: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM issue_closes WHERE state<>'queued' AND updated<?",
      now - 2 * RECENT_WORK_DAYS * 86400_000,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO issue_closes(issue,requested,email,state,message,updated) VALUES(?,?,?,'queued',NULL,?) ON CONFLICT(issue) DO UPDATE SET requested=excluded.requested,email=excluded.email,state='queued',message=NULL,updated=excluded.updated WHERE issue_closes.state<>'queued'",
      issue,
      now,
      email,
      now,
    );
    return this.closes().find((c) => c.issue === issue)!;
  }
  pendingCloses(): PendingClose[] {
    return this.closes()
      .filter((c) => c.state === "queued")
      .map(({ issue, requestedAt }) => ({ issue, requestedAt }));
  }
  inboxActions(): InboxAction[] {
    return this.ctx.storage.sql
      .exec<{ thread: string; action: InboxAction["action"]; requested: number; state: InboxAction["state"]; message: string | null; updated: number; issue: number | null }>(
        "SELECT thread,action,requested,state,message,updated,issue FROM inbox_actions ORDER BY requested",
      )
      .toArray()
      .map((r) => ({ threadId: r.thread, action: r.action, requestedAt: r.requested, state: r.state, message: r.message, updatedAt: r.updated, ...(r.issue !== null ? { issue: r.issue } : {}) }));
  }
  // One request per thread. Only a thread in the latest inbox read can be
  // queued; a queued request can be withdrawn before the machine on duty
  // applies it.
  requestInboxAction(threadId: string, action: InboxAction["action"], cancel = false, issue?: number) {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM inbox_actions WHERE state<>'queued' AND updated<?", now - 7 * 86400_000);
    if (cancel) {
      this.ctx.storage.sql.exec("DELETE FROM inbox_actions WHERE thread=? AND action=? AND state='queued'", threadId, action);
      return this.inboxActions();
    }
    const thread = currentInbox(this.overview())?.threads.find((t) => t.id === threadId);
    if (!thread) return null;
    if (action === "link" && (!issue || !currentWork(this.overview())?.issues.some(i => i.number === issue && i.open))) return null;
    if (action !== "link" && issue !== undefined) return null;
    // A different queued operation must finish before accepting another one.
    const pending = this.inboxActions().find(a => a.threadId === threadId && a.state === "queued");
    if (pending) return pending.action === action && pending.issue === issue ? this.inboxActions() : null;
    this.ctx.storage.sql.exec(
      "INSERT INTO inbox_actions(thread,action,requested,state,message,updated,issue) VALUES(?,?,?,'queued',NULL,?,?) ON CONFLICT(thread) DO UPDATE SET action=excluded.action,requested=excluded.requested,state='queued',message=NULL,updated=excluded.updated,issue=excluded.issue",
      threadId, action, now, now, issue ?? null,
    );
    return this.inboxActions();
  }
  pendingInboxActions(): PendingInboxAction[] {
    return this.inboxActions()
      .filter((a) => a.state === "queued")
      .map(({ threadId, action, requestedAt, issue }) => ({ threadId, action, requestedAt, ...(issue !== undefined ? { issue } : {}) }));
  }
  // Only the exact request the machine on duty was given, and only while
  // still queued.
  reportInboxAction(r: InboxActionReport) {
    const updated = this.ctx.storage.sql
      .exec(
        "UPDATE inbox_actions SET state=?,message=?,updated=? WHERE thread=? AND action=? AND requested=? AND issue IS ? AND state='queued' RETURNING thread",
        r.state, r.message, Date.now(), r.threadId, r.action, r.requestedAt, r.issue ?? null,
      )
      .toArray();
    return { updated: updated.length === 1 };
  }
  // One thread's latest message text, read from the stored inbox on demand.
  inboxThread(threadId: string) {
    const thread = currentInbox(this.overview())?.threads.find((t) => t.id === threadId);
    return thread ? { body: thread.body ?? null, unsubscribe: thread.unsubscribe ?? null } : null;
  }
  // A device's push URL is a capability: it stays here, never logged or returned.
  // Opening Projects refreshes a device; only a new one gets the test notice.
  subscribePush(endpoint: string) {
    const now = Date.now();
    const known = this.ctx.storage.sql.exec("SELECT 1 FROM push_devices WHERE endpoint=?", endpoint).toArray().length > 0;
    this.ctx.storage.sql.exec(
      "INSERT INTO push_devices(endpoint,created,used) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET used=excluded.used",
      endpoint, now, now,
    );
    this.ctx.storage.sql.exec("DELETE FROM push_devices WHERE endpoint NOT IN (SELECT endpoint FROM push_devices ORDER BY used DESC LIMIT 10)");
    if (!known)
      this.notify({ run: null, title: "Notifications are on", body: "Projects will tell you here when a conversation is ready or needs you." }, [endpoint]);
  }
  unsubscribePush(endpoint: string) {
    this.ctx.storage.sql.exec("DELETE FROM push_devices WHERE endpoint=?", endpoint);
  }
  // What a woken device shows: the last day's notices, newest first.
  pushEvents() {
    return this.ctx.storage.sql
      .exec<{ id: string; run: string | null; title: string; body: string; at: number }>(
        "SELECT id,run,title,body,at FROM push_events WHERE at>? ORDER BY at DESC LIMIT 5",
        Date.now() - 86400_000,
      )
      .toArray()
      .map((e) => ({ id: e.id, title: e.title, body: e.body, at: e.at, url: e.run ? `/?run=${e.run}` : "/" }));
  }
  // Pushes carry nothing; each device fetches pushEvents with its own sign-in.
  private notify(event: { run: string | null; title: string; body: string }, endpoints?: string[]) {
    const at = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO push_events(id,run,title,body,at) VALUES(?,?,?,?,?)",
      crypto.randomUUID(), event.run, event.title, event.body, at,
    );
    this.ctx.storage.sql.exec("DELETE FROM push_events WHERE at<? OR id NOT IN (SELECT id FROM push_events ORDER BY at DESC LIMIT 50)", at - 86400_000);
    const secret = this.env.VAPID_PRIVATE_KEY;
    const targets = endpoints ?? this.ctx.storage.sql.exec<{ endpoint: string }>("SELECT endpoint FROM push_devices").toArray().map((d) => d.endpoint);
    if (!secret || !targets.length) return;
    this.ctx.waitUntil(
      Promise.all(
        targets.map(async (endpoint) => {
          const result = await sendPush(endpoint, secret, this.env.SITE_URL);
          if (result === "gone") this.ctx.storage.sql.exec("DELETE FROM push_devices WHERE endpoint=?", endpoint);
          telemetry(
            "worker",
            "notification_sent",
            result === "failed" ? { outcome: "failed", reason: "http_error" } : { outcome: result === "sent" ? "accepted" : "rejected" },
            result === "failed" ? "warn" : "info",
          );
        }),
      ),
    );
  }
  // Only the request the machine on duty was given, and only while it is
  // still queued.
  reportClose(r: CloseReport) {
    const updated = this.ctx.storage.sql
      .exec(
        "UPDATE issue_closes SET state=?,message=?,updated=? WHERE issue=? AND requested=? AND state='queued' RETURNING issue",
        r.state,
        r.message,
        Date.now(),
        r.issue,
        r.requestedAt,
      )
      .toArray();
    return { updated: updated.length === 1 };
  }
}

// Routes authorised by the collector token; every other route needs a session.
export const collectorRoutes = new Set(["/api/ingest", "/api/closes", "/api/inbox/actions", "/api/review", "/api/collector/duties"]);
export const runnerRoutes = new Set(["/api/runner/claim", "/api/runner/heartbeat", "/api/runner/report", "/api/runner/screenshot", "/api/runner/readiness", "/api/runner/browser", "/api/runner/document"]);
// An owner's HTML edition, served only to their signed-in session.
export const documentPath = /^\/api\/documents\/([a-f0-9]{64})$/;
async function runtimeStatus(store: DurableObjectStub<Portfolio>, env: Env, id?: string) {
  try {
    const versions = await trace("runtime.check", {}, () => store.runtimeVersions(id));
    const worker = env.CF_VERSION_METADATA?.id ?? "local";
    return {worker, portfolio: versions.portfolio, conversation: versions.conversation,
      ready: versions.portfolio === worker && versions.conversation === worker};
  } catch {
    return {ready: false};
  }
}
// Each machine's runner IDs map to owners of its own, so one machine's token
// can never act on a conversation another machine claimed. Still a UUID for
// capabilities.
async function runnerOwner(machine: MachineCaller, runnerId: string) {
  if (machine.plainOwner) return runnerId;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${machine.machine}:${runnerId}`)));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const updatingScreenshots = () => Response.json({error: "Projects is finishing an update. Your screenshot is still in the draft; try sending it again shortly."}, {status: 503});
const closeRequestSchema = z
  .object({ issue: z.number().int().positive() })
  .strict();
const pushRequestSchema = z
  .object({ endpoint: z.string().max(1000).refine(pushEndpoint) })
  .strict();
export async function handle(
  request: Request,
  env: Env,
  signedIn: Caller | null,
): Promise<Response> {
  const url = new URL(request.url);
  if (!signedIn)
    return Response.json(
      { error: "Sign in with your email code to view projects." },
      { status: 401 },
    );
  // A conversation browser's own sign-in acts as the owner within its limits.
  const browser = typeof signedIn !== "string" && signedIn.role === "browser" ? signedIn : null;
  if (browser && !browserMay(url.pathname, request.method))
    return Response.json(
      { error: "This browser signed in automatically and cannot do this. Sign in with your email code." },
      { status: 403 },
    );
  const caller: string | MachineCaller = browser ? browser.email : (signedIn as string | MachineCaller);
  // A machine's tokens never reach a session route, and the bearer, not the
  // request body, says which machine is calling.
  const machine = typeof caller === "string" ? null : caller;
  const collecting = machine?.role === "collector";
  if (collecting && !collectorRoutes.has(url.pathname))
    return new Response("Not found", { status: 404 });
  const runner = machine?.role === "runner" ? machine : null;
  if (machine && !runner && runnerRoutes.has(url.pathname))
    return new Response("Not found", { status: 404 });
  if (runner && !runnerRoutes.has(url.pathname))
    return new Response("Not found", { status: 404 });
  if (runnerRoutes.has(url.pathname) && !runner)
    return new Response("Unauthorized", { status: 401 });
  const store = env.PORTFOLIOS.getByName(env.PORTFOLIO_ID);
  // Only the machine on duty applies requests; the owner may act as it.
  const onDuty = async () => !collecting || (await store.collectorDuties(machine!.machine));
  if (url.pathname === "/api/runner/readiness") {
    if (request.method !== "GET") return new Response("Method not allowed", {status: 405});
    const status = await runtimeStatus(store, env);
    return Response.json(status, {status: status.ready ? 200 : 503});
  }
  if (runner) {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const host = runner.machine;
    try {
      const delivery = url.pathname.endsWith("/document");
      const raw = await readJson(request, delivery ? Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 4096 : 1_000_000);
      const owner = await runnerOwner(runner, z.object({ runnerId: z.uuid() }).parse(raw).runnerId);
      if (delivery) {
        // A runner whose slots are all busy asks here, since it is not claiming.
        if (runnerLeaseSchema.safeParse(raw).success) {
          const document = await store.leaseDocument(owner);
          return Response.json(document ? { document } : {});
        }
        const input = runnerDocumentSchema.parse(raw);
        const accepted = await trace("document.deliver", {}, () =>
          store.deliverDocument(owner, input.id, input.lease, input.failure ? { failure: input.failure } : { bytes: new Uint8Array(Buffer.from(input.content!, "base64")) }));
        return Response.json({ accepted }, { status: accepted ? 200 : 409 });
      }
      if (url.pathname.endsWith("/browser")) {
        const input = runnerHeartbeatSchema.parse(raw);
        const conversation = env.CONVERSATIONS.getByName(JSON.stringify([env.PORTFOLIO_ID, input.id]));
        const grant = await trace("browser.grant", {runId: input.id, generation: input.generation}, () => conversation.browserGrant(owner, input.generation));
        return Response.json(grant ?? {error: "Browser is not available for this claim"}, {status: grant ? 200 : 409});
      }
      if (url.pathname.endsWith("/screenshot")) {
        const input = runnerHeartbeatSchema.extend({ screenshotId: z.uuid() }).strict().parse(raw);
        const image = await trace("conversation.screenshot", { runId: input.id, generation: input.generation }, () =>
          store.screenshot(input.id, input.screenshotId, owner, input.generation));
        return Response.json(image ? { screenshot: { id: image.metadata.id, mime: image.metadata.mime, data: Buffer.from(image.bytes).toString("base64") } } : { error: "Screenshot is not available for this claim" }, { status: image ? 200 : 404 });
      }
      if (url.pathname.endsWith("/claim")) {
        const input = runnerClaimSchema.parse(raw);
        const run = await trace("dispatch", {}, async () => {
          const claimed = await store.claimRun(owner, input.activeRunIds, input.lanes, host);
          if (claimed) attributes({ runId: claimed.id, generation: claimed.generation });
          return claimed;
        });
        if (run) attributes({ runId: run.id, generation: run.generation });
        const activity = run
          ? (await store.overview()).map((s) => ({
              host: s.host,
              observedAt: s.collectedAt,
              unassignedSessions: s.unassignedSessions,
              projects: s.projects.map((p) => ({
                id: p.id,
                sessions: p.sessions,
                worktrees: p.worktrees,
                pulls: p.pulls,
                sources: p.sources,
              })),
            }))
          : [];
        // A runner that can fetch documents takes the oldest one waiting.
        const document = input.documents ? await store.leaseDocument(owner) : null;
        return Response.json({ run, activity, settings: await store.executionSettings(), ...(document ? { document } : {}) });
      }
      if (url.pathname.endsWith("/heartbeat")) {
        const input = runnerHeartbeatSchema.parse(raw);
        attributes({ runId: input.id, generation: input.generation });
        const result = await trace("heartbeat", { runId: input.id, generation: input.generation }, () => store.heartbeatRun(owner, input.id, input.generation, host));
        const body = result ? z.object({cancel: z.boolean(), messages: z.array(z.unknown())}).parse(result) : null;
        return Response.json(body ? {...body, settings: await store.executionSettings()} : { error: "Claim no longer active" }, {
          status: result ? 200 : 409,
        });
      }
      const input = runnerReportSchema.parse(raw);
      attributes({ runId: input.id, generation: input.generation, seq: input.progress.seq });
      const accepted = await trace("report", { runId: input.id, generation: input.generation, seq: input.progress.seq }, () => store.reportRun(owner, input.id, input.generation, input.progress, host));
      return Response.json({ accepted }, { status: accepted ? 200 : 409 });
    } catch {
      return Response.json({ error: "Invalid runner request" }, { status: 400 });
    }
  }
  if (url.pathname === "/api/execution-settings") {
    if (request.method === "GET") return Response.json(await store.executionSettingsView());
    if (request.method !== "POST") return new Response("Method not allowed", {status: 405});
    let input;
    try { input = executionSettingsSchema.parse(await readJson(request, 1024)); }
    catch { return Response.json({error: "Invalid execution settings"}, {status: 400}); }
    await store.setExecutionSettings(input);
    return Response.json(await store.executionSettingsView());
  }
  // The owner connects machines. Tokens appear once, when a machine is added
  // or its tokens are replaced, and only their hashes are kept.
  const machineRoute = /^\/api\/machines(?:\/([a-z0-9-]{1,32})(?:\/(tokens|remove))?)?$/.exec(url.pathname);
  if (machineRoute) {
    const [, id, action] = machineRoute;
    if (!id && request.method === "GET")
      return Response.json({ machines: await store.machineList() });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    if (!(await store.rate(`machines:${caller}`, 60, 3600_000)))
      return Response.json({ error: "Try again later." }, { status: 429 });
    if (!id) {
      let input;
      try { input = z.object({ name: z.string().max(200) }).strict().parse(await readJson(request, 1024)); }
      catch { return Response.json({ error: "Invalid machine" }, { status: 400 }); }
      const added = await store.addMachine(input.name);
      return added
        ? Response.json({ machine: added.id, tokens: added.tokens, machines: await store.machineList() })
        : Response.json({ error: "Name the machine in 40 characters or fewer." }, { status: 400 });
    }
    if (action === "tokens") {
      const tokens = await store.replaceMachineTokens(id);
      return tokens
        ? Response.json({ machine: id, tokens, machines: await store.machineList() })
        : Response.json({ error: "Machine not found" }, { status: 404 });
    }
    if (action === "remove")
      return (await store.removeMachine(id))
        ? Response.json({ machines: await store.machineList() })
        : Response.json({ error: "Machine not found" }, { status: 404 });
    let input;
    try {
      input = z.object({ name: z.string().max(200).optional(), position: z.number().int().min(0).max(1000).optional() })
        .strict().parse(await readJson(request, 1024));
    } catch {
      return Response.json({ error: "Invalid machine change" }, { status: 400 });
    }
    if (input.name !== undefined && !(await store.renameMachine(id, input.name)))
      return Response.json({ error: "Name the machine in 40 characters or fewer." }, { status: 400 });
    if (input.position !== undefined && !(await store.moveMachine(id, input.position)))
      return Response.json({ error: "Machine not found" }, { status: 404 });
    return Response.json({ machines: await store.machineList() });
  }
  // A browser's own sign-in never reaches a conversation started from an email.
  const emailRun = async (id: string) => !!browser && !!(await store.getRun(id))?.emailThread;
  const browserRoute = /^\/api\/runs\/([a-f0-9-]{36})\/browser(?:\/(view))?$/.exec(url.pathname);
  if (browserRoute) {
    if (!(await store.getRun(browserRoute[1])) || (await emailRun(browserRoute[1]))) return new Response("Not found", {status: 404});
    const conversation = env.CONVERSATIONS.getByName(JSON.stringify([env.PORTFOLIO_ID, browserRoute[1]]));
    if (!browserRoute[2] && request.method === "GET") return Response.json(await trace("browser.status", {runId: browserRoute[1]}, () => conversation.browserStatus()));
    if (browserRoute[2] && request.method === "POST") {
      let input;
      try { input = z.object({readonly: z.boolean()}).strict().parse(await readJson(request, 512)); }
      catch { return new Response("Invalid browser request", {status: 400}); }
      if (!(await store.rate(`browser:${caller}`, 30, 60_000))) return new Response("Try again shortly", {status: 429});
      const view = await trace("browser.view", {runId: browserRoute[1]}, () => conversation.browserView(input.readonly));
      return Response.json(view ?? {error: "The browser has closed. Ask the agent to open it again."}, {status: view ? 200 : 409});
    }
    return new Response("Method not allowed", {status: 405});
  }
  if (url.pathname === "/api/archive" && request.method === "POST") {
    let input;
    try { input = archiveInputSchema.parse(await readJson(request, 2048)); }
    catch { return Response.json({error: "Invalid archive request"}, {status: 400}); }
    if (!(await store.rate(`archive:${caller}`, 120, 60_000)))
      return Response.json({error: "Try again shortly."}, {status: 429});
    const archives = await trace("archive.update", {}, () => store.archive(input.target, input.archived));
    return Response.json(archives ? {archives} : {error: "This item is no longer in the project inventory."}, {status: archives ? 200 : 404});
  }
  if (url.pathname === "/api/runs" && request.method === "GET") {
    const options = runListSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!options.success) return Response.json({error: "Invalid conversation filter"}, {status: 400});
    const listed = await trace("conversation.list", {}, () => store.listRuns(options.data));
    const runs = browser ? (options.data.email ? [] : listed.filter((run) => !run.emailThread)) : listed;
    return Response.json({
      runs,
      nextOffset: listed.length === 50 && !options.data.email ? options.data.offset + 50 : null,
      enabled: await store.runnable(),
      runners: await store.runners(),
    });
  }
  if (url.pathname === "/api/runs" && request.method === "POST") {
    if (!(await store.runnable()))
      return Response.json(
        { error: "Connect a machine before starting conversations." },
        { status: 503 },
      );
    let input;
    try {
      input = runInputSchema.parse(await readJson(request, MESSAGE_REQUEST_BYTES));
    } catch {
      return Response.json({ error: "Invalid conversation" }, { status: 400 });
    }
    // A browser's own sign-in starts no conversation from an email and reads
    // none back through a retry.
    if (browser && input.emailThread)
      return Response.json({ error: "Sign in with your email code to work on email." }, { status: 403 });
    const previous = await trace("conversation.read", { runId: input.requestId }, () => store.getRun(input.requestId));
    attributes({ runId: input.requestId });
    if (previous)
      return browser && previous.emailThread
        ? Response.json({ error: "Invalid conversation" }, { status: 409 })
        : Response.json({ run: previous });
    if (input.screenshots?.length && !(await runtimeStatus(store, env, input.requestId)).ready)
      return updatingScreenshots();
    // Quick work has its own hourly bound, sized for working through email.
    if (!(await store.rate(input.lane === "quick" ? `quick-runs:${caller}` : `runs:${caller}`, input.lane === "quick" ? 60 : 30, 3600_000)))
      return new Response("Try again later", { status: 429 });
    const snapshots = await store.overview();
    // Any connected machine may run it, so one machine's old inventory does
    // not block new work. The claiming runner still checks the project
    // against its own machine's registry.
    if (!snapshots.length)
      return Response.json(
        { error: "Refresh the project inventory before starting work." },
        { status: 409 },
      );
    if (input.projectId && !snapshots.some((s) => s.projects.some((p) => p.id === input.projectId)))
      return Response.json(
        { error: "Project is not registered on any connected machine." },
        { status: 400 },
      );
    if (
      input.workIssue &&
      !currentWork(snapshots)?.issues.some((i) => i.number === input.workIssue)
    )
      return Response.json({ error: "Unknown work issue." }, { status: 400 });
    try {
      const run = await trace("conversation.create", { runId: input.requestId }, () => store.createRun(input));
      // Another sign-in may have saved this request ID since the check above.
      return browser && run.emailThread
        ? Response.json({ error: "Invalid conversation" }, { status: 409 })
        : Response.json({ run });
    } catch {
      return Response.json(
        { error: "Conversation could not be saved. Check the screenshots or active conversation limit." },
        { status: 409 },
      );
    }
  }
  // The viewer asks with POST, so no repository or file name enters a URL.
  if (url.pathname === "/api/documents") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let source: HtmlSource | null, retry: boolean;
    try {
      const input = documentRequestSchema.parse(await readJson(request, 2048));
      source = htmlSource(input.url);
      retry = input.retry ?? false;
    } catch {
      return Response.json({ error: "Invalid document request" }, { status: 400 });
    }
    if (!source) return Response.json({ error: "Only HTML files linked at a saved commit open here." }, { status: 400 });
    const known = await store.documentStatus(source);
    if (known && !(retry && known.state === "failed")) return Response.json({ document: known });
    if (!(await store.rate(`documents:${caller}`, 120, 3600_000)))
      return Response.json({ error: "Try again later." }, { status: 429 });
    const document = await trace("document.request", {}, () => store.requestDocument(source, retry));
    return Response.json(document ? { document } : { error: "This repository is not on a connected machine." }, { status: document ? 200 : 404 });
  }
  const documentRoute = documentPath.exec(url.pathname);
  if (documentRoute) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const bytes = await trace("document.read", {}, () => store.documentContent(documentRoute[1]));
    return bytes
      ? new Response(bytes, { headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": "inline",
          "Cross-Origin-Resource-Policy": "same-origin",
          // For browsers without CSP frame-ancestors.
          "X-Frame-Options": "SAMEORIGIN",
        } })
      : new Response("This document is not available.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const imageRoute = /^\/api\/runs\/([a-f0-9-]{36})\/screenshots\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (imageRoute) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const [, id, screenshotId] = imageRoute;
    if (await emailRun(id)) return new Response("Screenshot not found", { status: 404 });
    const image = await trace("conversation.screenshot", { runId: id }, () => store.screenshot(id, screenshotId));
    return image ? new Response(image.bytes, { headers: {
      "Content-Type": image.metadata.mime,
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
    } }) : new Response("Screenshot not found", { status: 404 });
  }
  const runRoute = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(message|cancel|archive|move))?$/.exec(
    url.pathname,
  );
  if (runRoute) {
    const [, id, action] = runRoute;
    attributes({ runId: id });
    if (await emailRun(id)) return Response.json({ run: null }, { status: 404 });
    if (request.method === "GET" && !action) {
      const run = await trace("conversation.read", { runId: id }, () => store.getRun(id));
      return Response.json({ run, runners: await store.runners() }, { status: run ? 200 : 404 });
    }
    if (request.method !== "POST" || !action)
      return new Response("Method not allowed", { status: 405 });
    if (action === "move") {
      const run = await trace("conversation.move", { runId: id }, async () => await store.moveRun(id));
      if (run === "machine-present")
        return Response.json({ error: "Its machine is back; it continues this conversation." }, { status: 409 });
      return Response.json(run ? { run } : { error: "Conversation not found" }, { status: run ? 200 : 404 });
    }
    if (action === "archive") {
      let input;
      try { input = runArchiveSchema.parse(await readJson(request, 512)); }
      catch { return Response.json({error: "Invalid archive request"}, {status: 400}); }
      const run = await trace("conversation.archive", {runId: id}, () => store.archiveRun(id, input.archived));
      return Response.json(run ? {run} : {error: "Conversation not found"}, {status: run ? 200 : 404});
    }
    try {
      if (action === "cancel")
        return Response.json({ run: await trace("conversation.cancel", { runId: id }, () => store.cancelRun(id)) });
      if (!(await store.runnable()))
        return Response.json(
          { error: "Connect a machine before sending feedback." },
          { status: 503 },
        );
      const input = messageInputSchema.parse(await readJson(request, MESSAGE_REQUEST_BYTES));
      // A lost-response retry must still return its saved receipt at the rate limit.
      const existing = await store.getRun(id);
      if (existing?.messages.some(message => message.id === input.requestId))
        return Response.json({ run: existing });
      if (!(await store.rate(`feedback:${caller}`, 120, 3600_000)))
        return Response.json({ error: "Too many follow-ups. Try again later." }, { status: 429 });
      if (input.screenshots?.length && !(await runtimeStatus(store, env, id)).ready)
        return updatingScreenshots();
      return Response.json({ run: await trace("conversation.feedback", { runId: id }, () => store.messageRun(id, input)) });
    } catch {
      return Response.json(
        {
          error:
            "This turn cannot start. Wait for the current turn to stop, or start a new conversation.",
        },
        { status: 409 },
      );
    }
  }
  // Legacy publishers fail closed without reading the payload or sending mail.
  // Historical SQLite records are retained, but never returned or retried.
  if (url.pathname === "/api/review")
    return Response.json({ error: "Daily briefs have been retired." }, { status: 410 });
  if (url.pathname === "/api/collector/duties" && request.method === "GET")
    return Response.json({ duties: await onDuty() });
  // Requests go only to the machine on duty, so one machine applies each.
  if (url.pathname === "/api/closes" && request.method === "GET")
    return Response.json({ closes: (await onDuty()) ? await store.pendingCloses() : [] });
  if (url.pathname === "/api/closes" && request.method === "POST") {
    let report;
    try {
      report = closeReportSchema.parse(await readJson(request, 4096));
    } catch {
      return Response.json({ error: "Invalid report" }, { status: 400 });
    }
    return Response.json(await store.reportClose(report));
  }
  if (url.pathname === "/api/inbox/actions" && request.method === "GET")
    return Response.json({ actions: (await onDuty()) ? await store.pendingInboxActions() : [] });
  if (url.pathname === "/api/inbox/actions" && request.method === "POST") {
    let report;
    try {
      report = inboxActionReportSchema.parse(await readJson(request, 4096));
    } catch {
      return Response.json({ error: "Invalid report" }, { status: 400 });
    }
    return Response.json(await store.reportInboxAction(report));
  }
  if (url.pathname === "/api/push/key" && request.method === "GET")
    return env.VAPID_PRIVATE_KEY
      ? Response.json({ key: vapidPublicKey(env.VAPID_PRIVATE_KEY) })
      : Response.json({ error: "Notifications are not set up yet." }, { status: 503 });
  if (url.pathname === "/api/push/events" && request.method === "GET")
    return Response.json(
      { events: await trace("push.events", {}, () => store.pushEvents()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  if ((url.pathname === "/api/push/subscribe" || url.pathname === "/api/push/unsubscribe") && request.method === "POST") {
    let input;
    try {
      input = pushRequestSchema.parse(await readJson(request, 2048));
    } catch {
      return Response.json({ error: "Invalid notification request" }, { status: 400 });
    }
    if (!(await store.rate(`push:${caller}`, 10, 3600_000)))
      return Response.json({ error: "Try again shortly." }, { status: 429 });
    if (url.pathname.endsWith("/unsubscribe")) await store.unsubscribePush(input.endpoint);
    else if (!env.VAPID_PRIVATE_KEY)
      return Response.json({ error: "Notifications are not set up yet." }, { status: 503 });
    else await trace("push.subscribe", {}, () => store.subscribePush(input.endpoint));
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/inbox/act" && request.method === "POST") {
    let input;
    try {
      input = inboxActionRequestSchema.parse(await readJson(request, 512));
    } catch {
      return Response.json({ error: "Invalid inbox request" }, { status: 400 });
    }
    if (!(await store.rate(`inbox:${caller}`, 120, 60_000)))
      return Response.json({ error: "Try again shortly." }, { status: 429 });
    const actions = await trace("inbox.action", {}, () =>
      store.requestInboxAction(input.threadId, input.action, input.cancel, input.issue));
    return Response.json(actions ? { actions } : { error: "This email or work item is unavailable, or another action is still queued." }, { status: actions ? 200 : 404 });
  }
  const inboxThread = /^\/api\/inbox\/threads\/([a-f0-9]{10,40})$/.exec(url.pathname);
  if (inboxThread && request.method === "GET") {
    const thread = await trace("inbox.read", {}, () => store.inboxThread(inboxThread[1]));
    return Response.json(thread ? { thread } : { error: "This email is no longer in the inbox." }, {
      status: thread ? 200 : 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === "/api/work/close" && request.method === "POST") {
    let number;
    try {
      number = closeRequestSchema.parse(await readJson(request, 512)).issue;
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
    if (!(await store.rate(`close:${caller}`, 30, 3600_000)))
      return new Response("Try again later", { status: 429 });
    const work = currentWork(await store.overview());
    const issue = work?.issues.find((i) => i.number === number);
    if (!work || !issue)
      return new Response("Unknown work issue", { status: 404 });
    const earlier = (await store.closes()).find((c) => c.issue === number);
    if (isDone(issue, work.observedAt, earlier))
      return new Response("This issue is already closed.", { status: 409 });
    // Only a signed-in owner reaches this route; machine tokens stop above.
    return Response.json({ close: await store.requestClose(number, caller as string) });
  }
  if (url.pathname === "/api/ingest" && request.method === "POST") {
    try {
      const snapshot = snapshotSchema.parse(await readJson(request, 2_000_000));
      if (!(await store.machineRegistered(snapshot.host)))
        return Response.json({ error: "Unknown machine" }, { status: 400 });
      if (machine && snapshot.host !== machine.machine)
        return Response.json({ error: "A machine publishes only its own snapshot" }, { status: 403 });
      if (Math.abs(Date.now() - snapshot.collectedAt) > 10 * 60_000)
        return Response.json(
          { error: "Snapshot timestamp outside allowed window" },
          { status: 400 },
        );
      const result = await store.publish(snapshot);
      return Response.json(result, { status: result.accepted ? 200 : 409 });
    } catch {
      return Response.json({ error: "Invalid snapshot" }, { status: 400 });
    }
  }
  if (url.pathname === "/api/overview" && request.method === "GET")
    return Response.json({
      // Message text stays out of the 30-second poll; it is read per thread.
      // A browser's own sign-in gets no inbox and no work item's email links;
      // work text is shown as written.
      snapshots: (await store.overview()).map(({ inbox, ...snapshot }) =>
        browser
          ? {
              ...snapshot,
              ...(snapshot.work && {
                work: {
                  ...snapshot.work,
                  issues: snapshot.work.issues?.map(({ emailLinks: _links, ...issue }) => issue) ?? null,
                },
              }),
            }
          : inbox
            ? {
                ...snapshot,
                inbox: {
                  ...inbox,
                  threads: inbox.threads.map(({ body: _body, ...thread }) => thread),
                },
              }
            : snapshot,
      ),
      ...(browser && { emailHidden: true }),
      archives: await store.archives(),
      closes: await store.closes(),
      inboxActions: browser ? [] : await store.inboxActions(),
      machines: await store.machineList(),
      serverTime: Date.now(),
    });
  if (url.pathname.startsWith("/api/"))
    return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  return env.ASSETS.fetch(request);
}

// A document's own policy keeps its HTML in an opaque origin even when opened
// directly; everything else gets the app's.
export function secure(response: Response, document = false) {
  const result = new Response(response.body, {status: response.status, statusText: response.statusText, headers: response.headers, webSocket: response.webSocket});
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("Strict-Transport-Security", "max-age=31536000");
  result.headers.set(
    "Content-Security-Policy",
    document
      ? DOCUMENT_CSP
      : "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return result;
}
export default {
  async fetch(request: Request, env: Env) {
    const document = documentPath.test(new URL(request.url).pathname);
    return secure(
      await observeRequest(request, async () => {
        const pathname = new URL(request.url).pathname,
          collector = collectorRoutes.has(pathname),
          runner = runnerRoutes.has(pathname);
        const browser = browserPath.exec(pathname);
        if (browser) {
          // The conversation validates its own short-lived capability; neither
          // session cookies nor collector/runner bearers authorize this socket.
          if (!request.headers.get("Authorization")?.startsWith("Bearer "))
            return new Response("Browser access expired", {status: 403});
          return trace("browser.connect", {runId: browser[1]}, () => env.CONVERSATIONS.getByName(JSON.stringify([env.PORTFOLIO_ID, browser[1]])).fetch(request));
        }
        if (pathname.startsWith("/api/auth/"))
          return trace("auth", {}, () => login(request, env));
        // The deploy verifier asks whether the version it just published
        // serves every object, without a machine token. Only that version's
        // id, which only the publisher knows, wakes the objects.
        if (pathname === "/api/readiness" && request.method === "GET") {
          const version = new URL(request.url).searchParams.get("version");
          if (!version || version !== env.CF_VERSION_METADATA?.id)
            return Response.json({ ready: false });
          const status = await runtimeStatus(env.PORTFOLIOS.getByName(env.PORTFOLIO_ID), env);
          return Response.json({ ready: status.ready });
        }
        if (
          !pathname.startsWith("/api/") &&
          (request.method === "GET" || request.method === "HEAD")
        )
          return env.ASSETS.fetch(request);
        // Browser writes must come from this page, beyond SameSite cookies.
        if (
          !collector &&
          !runner &&
          !["GET", "HEAD"].includes(request.method) &&
          !sameOrigin(request)
        )
          return new Response("Forbidden", { status: 403 });
        const caller = await trace("auth", {}, () =>
          authorize(request, env, collector, runner),
        );
        return handle(request, env, caller);
      }),
      document,
    );
  },
} satisfies ExportedHandler<Env>;

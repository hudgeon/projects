import { reviewSchema, reviewProblem, type Review, type PublishedReview } from "../src/review-model";
import { reviewEmail } from "./review-email";
import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { MESSAGE_REQUEST_BYTES } from "../src/screenshot-model";
import type { MessageInput } from "../src/run-model";
import { Runs } from "./run-directory";
import { pushEndpoint, sendPush, vapidPublicKey } from "./push";
import { notice } from "../src/run-text";
import { attributes, observeRequest, trace } from "./telemetry";
import { browserPath } from "./browser";
export { Conversation } from "./runs";
import { runInputSchema, runListSchema, runArchiveSchema, messageInputSchema, runnerClaimSchema, runnerHeartbeatSchema, runnerReportSchema, type Lane, type RunnerHost, type RunInput, type Progress, type RunListOptions } from "../src/run-model";
import { archiveInputSchema, archiveKey, type ArchiveEntry, type ArchiveTarget } from "../src/archive-model";
import { telemetry } from "../src/telemetry";
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
} from "./auth";
import { freshness, snapshotSchema, STALE_AFTER, type Snapshot } from "../src/model";
import { Machines, type MachineCaller, type MachineRole } from "./machines";
import {
  currentInbox,
  inboxActionReportSchema,
  inboxActionRequestSchema,
  inboxQueue,
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
  // The daily review email this instance is sending, if any.
  private reviewSend?: Promise<boolean>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.machines = new Machines(ctx.storage);
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
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS daily_review (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, published INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS review_emails (day TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, started INTEGER NOT NULL, state TEXT NOT NULL, provider_id TEXT)");
    // Closes were keyed by an older work ID before work items became issues.
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS closes");
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS issue_closes (issue INTEGER PRIMARY KEY, requested INTEGER NOT NULL, email TEXT NOT NULL, state TEXT NOT NULL, message TEXT, updated INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS inbox_actions (thread TEXT PRIMARY KEY, action TEXT NOT NULL, requested INTEGER NOT NULL, state TEXT NOT NULL, message TEXT, updated INTEGER NOT NULL)",
    );
    // Email threads marked Done while no current inbox read could see them.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS deferred_archives (thread TEXT PRIMARY KEY, requested INTEGER NOT NULL)",
    );
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
    return this.machines.list();
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
    return this.machines.remove(id);
  }
  listRuns(options: RunListOptions = {}) { return this.runs.list(options); }
  runtimeVersions(id?: string) { return this.runs.runtimeVersions(id); }
  getRun(id: string) { return this.runs.get(id); }
  createRun(input: RunInput) { return this.runs.create(input); }
  messageRun(id: string, input: MessageInput) { return this.runs.message(id, input); }
  screenshot(id: string, screenshotId: string, owner?: string, generation?: number) { return this.runs.screenshot(id, screenshotId, owner, generation); }
  cancelRun(id: string) { return this.runs.cancel(id); }
  async archiveRun(id: string, archived: boolean) {
    const run = await this.runs.archive(id, archived);
    // Done on an email conversation archives its Gmail thread too; Reopen
    // withdraws the request until the machine on duty applies it.
    if (run?.emailThread) {
      if (archived) await this.archiveHandledEmails([run.emailThread]);
      else {
        this.requestInboxAction(run.emailThread, "archive", true);
        this.ctx.storage.sql.exec("DELETE FROM deferred_archives WHERE thread=?", run.emailThread);
      }
    }
    return run;
  }
  // Queue a Gmail archive for inbox threads whose conversation is Done and
  // that nobody has written to since; a newer email stays in the inbox. A
  // thread no current read can see waits for one that can, instead of being
  // lost or judged on an old read; a complete read that lacks it shows it out
  // of the inbox.
  async archiveHandledEmails(threadIds?: string[]) {
    const snapshots = this.overview();
    const inbox = currentInbox(snapshots);
    const waiting = (threadIds ?? []).filter((thread) =>
      !inbox || freshness(inbox.observedAt) || (inbox.state !== "ok" && !inbox.threads.some((t) => t.id === thread)));
    for (const thread of waiting)
      this.ctx.storage.sql.exec("INSERT INTO deferred_archives(thread,requested) VALUES(?,?) ON CONFLICT(thread) DO NOTHING", thread, Date.now());
    const ids = threadIds?.filter((thread) => !waiting.includes(thread));
    if (!inbox || ids?.length === 0) return;
    const conversations = await this.runs.list({ email: true });
    const actions = this.inboxActions();
    const queued = new Set(actions.filter((a) => a.state === "queued").map((a) => a.threadId));
    for (const row of inboxQueue(inbox, currentWork(snapshots)?.issues ?? [], conversations, actions))
      if (row.state === "handled" && row.thread.inInbox && !queued.has(row.thread.id) && (!ids || ids.includes(row.thread.id)))
        this.requestInboxAction(row.thread.id, "archive");
  }
  moveRun(id: string) { return this.runs.move(id); }
  runners() { return this.runs.runners(); }
  claimRun(owner: string, activeRunIds: string[], lanes: Lane[] | undefined, host: RunnerHost) { return this.runs.claim(owner, activeRunIds, lanes, host); }
  heartbeatRun(owner: string, id: string, generation: number, host: RunnerHost) { return this.runs.heartbeat(owner, id, generation, host); }
  reportRun(owner: string, id: string, generation: number, progress: Progress, host: RunnerHost) { return this.runs.report(owner, id, generation, progress, host); }
  review(): PublishedReview | null {
    const row = this.ctx.storage.sql.exec<{ payload: string; published: number }>("SELECT payload,published FROM daily_review WHERE id=1").toArray()[0];
    if (!row) return null;
    const review = reviewSchema.parse(JSON.parse(row.payload));
    const email = this.ctx.storage.sql.exec<{ hash: string; state: string }>("SELECT hash,state FROM review_emails WHERE day=?", review.date).toArray()[0];
    const state = email?.state === "sent" ? "sent" : email?.state === "failed" ? "failed" : "pending";
    return { ...review, publishedAt: row.published, email: !email ? "not requested" : email.hash !== digest(JSON.stringify(review)) ? `previous edition ${state}` : state };
  }
  async publishReview(review: Review, sendDaily: boolean) {
    const now = Date.now();
    const editionHash = digest(JSON.stringify(review));
    const problem = reviewProblem(review, now, this.env.TIME_ZONE);
    if (problem || digest(review.brief) !== review.briefSha256) return { status: 400, error: problem || "Review hash mismatch" };
    const work = currentWork(await this.overview());
    if (!work || now - work.observedAt > 10 * 60_000) return { status: 409, error: "Refresh Projects work evidence before publishing" };
    const previous = this.review();
    if (previous && previous.verifiedAt > review.verifiedAt) return { status: 409, error: "A newer review is already published" };
    const outstanding = this.ctx.storage.sql.exec<{hash:string;state:string}>("SELECT hash,state FROM review_emails WHERE day=?", review.date).toArray()[0];
    if (outstanding?.state === "pending" && outstanding.hash !== editionHash) return { status: 409, error: "Earlier edition has unconfirmed delivery; verify it before publishing another" };
    // Commit the visible edition before any external side effect.
    this.ctx.storage.sql.exec("INSERT INTO daily_review(id,payload,published) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,published=excluded.published", JSON.stringify(review), now);
    if (!sendDaily) return { status: 200, published: true, email: "not requested", hash: review.briefSha256 };
    if (!this.env.EMAIL || !this.env.EMAIL_FROM || !allowed(this.env.OWNER_EMAIL, this.env)) return { status: 503, published: true, error: "Daily email is not configured for the owner" };
    // Email has no idempotency key: store the EXACT message, send it once and
    // resend only after a reported failure. A send whose outcome was never
    // recorded, such as one cut off by a restart, needs verification instead.
    const message = reviewEmail(review, { from: this.env.EMAIL_FROM, to: this.env.OWNER_EMAIL, site: this.env.SITE_URL, repo: work.repo });
    const claimed = this.ctx.storage.sql.exec("INSERT INTO review_emails(day,hash,payload,started,state) VALUES(?,?,?,?,'pending') ON CONFLICT(day) DO UPDATE SET hash=excluded.hash,payload=excluded.payload,started=excluded.started,state='pending',provider_id=NULL WHERE review_emails.state='failed' RETURNING day", review.date, editionHash, JSON.stringify(message), now).toArray().length === 1;
    // A concurrent publish waits for this instance's send instead of guessing.
    if (!claimed) await this.reviewSend;
    const mail = this.ctx.storage.sql.exec<{hash:string;payload:string;state:string}>("SELECT hash,payload,state FROM review_emails WHERE day=?", review.date).one();
    if (mail.state === "sent") return { status: 200, published: true, email: "already sent", hash: review.briefSha256 };
    if (mail.hash !== editionHash) return { status: 409, published: true, error: "Earlier edition has unconfirmed delivery; resolve it before another send" };
    if (!claimed)
      return mail.state === "failed"
        ? { status: 503, published: true, error: "Email delivery failed; retry this exact edition" }
        : { status: 409, published: true, error: "Delivery needs verification; an earlier send was never confirmed" };
    const attempt = (async () => {
      try {
        const result = await this.env.EMAIL.send(JSON.parse(mail.payload));
        this.ctx.storage.sql.exec("UPDATE review_emails SET state='sent',provider_id=? WHERE day=?", String(result.messageId).slice(0, 200), review.date);
        return true;
      } catch {
        this.ctx.storage.sql.exec("UPDATE review_emails SET state='failed' WHERE day=?", review.date);
        return false;
      }
    })();
    this.reviewSend = attempt;
    const sent = await attempt.finally(() => {
      if (this.reviewSend === attempt) this.reviewSend = undefined;
    });
    return sent
      ? { status: 200, published: true, email: "sent", hash: review.briefSha256 }
      : { status: 503, published: true, error: "Email delivery failed; retry this exact edition" };
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
  session(hash: string) {
    return (
      this.ctx.storage.sql
        .exec<{ email: string }>(
          "SELECT email FROM sessions WHERE hash=? AND expires>?",
          hash,
          Date.now(),
        )
        .toArray()[0]?.email ?? null
    );
  }
  revoke(hash: string) {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE hash=?", hash);
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
    // Emails marked Done before Done archived them in Gmail are archived once,
    // from the first complete inbox read; a failure retries on the next read.
    if (result.length && snapshot.inbox?.state === "ok" && !this.ctx.storage.kv.get("handledEmailsArchived"))
      try {
        await this.archiveHandledEmails();
        this.ctx.storage.kv.put("handledEmailsArchived", Date.now());
      } catch {}
    // Done that found no read able to see its thread archives once one can; a
    // failure retries on the next read, and after a week it lapses, like other
    // inbox requests. The machine on duty still applies each archive only
    // against its own fresh read (collector/inbox-actions.ts), never this one.
    if (result.length && snapshot.inbox)
      this.ctx.storage.sql.exec("DELETE FROM deferred_archives WHERE requested<?", Date.now() - 7 * 86400_000);
    const inbox = result.length && snapshot.inbox ? currentInbox(this.overview()) : undefined;
    const seen = inbox && inbox.state !== "unavailable"
      ? this.ctx.storage.sql.exec<{ thread: string }>("SELECT thread FROM deferred_archives").toArray()
          .map((row) => row.thread)
          .filter((thread) => inbox.state === "ok" || inbox.threads.some((t) => t.id === thread))
      : [];
    if (seen.length)
      try {
        await this.archiveHandledEmails(seen);
        for (const thread of seen) this.ctx.storage.sql.exec("DELETE FROM deferred_archives WHERE thread=?", thread);
      } catch {}
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
      .exec<{ thread: string; action: InboxAction["action"]; requested: number; state: InboxAction["state"]; message: string | null; updated: number }>(
        "SELECT thread,action,requested,state,message,updated FROM inbox_actions ORDER BY requested",
      )
      .toArray()
      .map((r) => ({ threadId: r.thread, action: r.action, requestedAt: r.requested, state: r.state, message: r.message, updatedAt: r.updated }));
  }
  // One request per thread. Only a thread in the latest inbox read can be
  // queued; a queued request can be withdrawn before the machine on duty
  // applies it.
  requestInboxAction(threadId: string, action: InboxAction["action"], cancel = false) {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM inbox_actions WHERE state<>'queued' AND updated<?", now - 7 * 86400_000);
    if (cancel) {
      this.ctx.storage.sql.exec("DELETE FROM inbox_actions WHERE thread=? AND action=? AND state='queued'", threadId, action);
      return this.inboxActions();
    }
    const thread = currentInbox(this.overview())?.threads.find((t) => t.id === threadId);
    if (!thread) return null;
    this.ctx.storage.sql.exec(
      "INSERT INTO inbox_actions(thread,action,requested,state,message,updated) VALUES(?,?,?,'queued',NULL,?) ON CONFLICT(thread) DO UPDATE SET action=excluded.action,requested=excluded.requested,state='queued',message=NULL,updated=excluded.updated WHERE inbox_actions.state<>'queued' OR inbox_actions.action<>excluded.action",
      threadId, action, now, now,
    );
    return this.inboxActions();
  }
  pendingInboxActions(): PendingInboxAction[] {
    return this.inboxActions()
      .filter((a) => a.state === "queued")
      .map(({ threadId, action, requestedAt }) => ({ threadId, action, requestedAt }));
  }
  // Only the exact request the machine on duty was given, and only while
  // still queued.
  reportInboxAction(r: InboxActionReport) {
    const updated = this.ctx.storage.sql
      .exec(
        "UPDATE inbox_actions SET state=?,message=?,updated=? WHERE thread=? AND action=? AND requested=? AND state='queued' RETURNING thread",
        r.state, r.message, Date.now(), r.threadId, r.action, r.requestedAt,
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
export const runnerRoutes = new Set(["/api/runner/claim", "/api/runner/heartbeat", "/api/runner/report", "/api/runner/screenshot", "/api/runner/readiness", "/api/runner/browser"]);
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
  caller: Caller | null,
): Promise<Response> {
  const url = new URL(request.url);
  if (!caller)
    return Response.json(
      { error: "Sign in with your email code to view projects." },
      { status: 401 },
    );
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
  // Only the machine on duty applies requests and publishes the reviewed
  // daily edition; the owner, signed in or local, may act as it.
  const onDuty = async () => !collecting || (await store.collectorDuties(machine!.machine));
  if (collecting && url.pathname === "/api/review" && !(await onDuty()))
    return Response.json({ error: "Only the machine on duty publishes the daily review." }, { status: 409 });
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
      const raw = await readJson(request, 1_000_000);
      const owner = await runnerOwner(runner, z.object({ runnerId: z.uuid() }).parse(raw).runnerId);
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
        return Response.json({ run, activity });
      }
      if (url.pathname.endsWith("/heartbeat")) {
        const input = runnerHeartbeatSchema.parse(raw);
        attributes({ runId: input.id, generation: input.generation });
        const result = await trace("heartbeat", { runId: input.id, generation: input.generation }, () => store.heartbeatRun(owner, input.id, input.generation, host));
        return Response.json(result ?? { error: "Claim no longer active" }, {
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
  const browserRoute = /^\/api\/runs\/([a-f0-9-]{36})\/browser(?:\/(view))?$/.exec(url.pathname);
  if (browserRoute) {
    if (!(await store.getRun(browserRoute[1]))) return new Response("Not found", {status: 404});
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
    const runs = await trace("conversation.list", {}, () => store.listRuns(options.data));
    return Response.json({
      runs,
      nextOffset: runs.length === 50 && !options.data.email ? options.data.offset + 50 : null,
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
    const previous = await trace("conversation.read", { runId: input.requestId }, () => store.getRun(input.requestId));
    attributes({ runId: input.requestId });
    if (previous) return Response.json({ run: previous });
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
      return Response.json({ run: await trace("conversation.create", { runId: input.requestId }, () => store.createRun(input)) });
    } catch {
      return Response.json(
        { error: "Conversation could not be saved. Check the screenshots or active conversation limit." },
        { status: 409 },
      );
    }
  }
  const imageRoute = /^\/api\/runs\/([a-f0-9-]{36})\/screenshots\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (imageRoute) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const [, id, screenshotId] = imageRoute;
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
  if (url.pathname === "/api/review" && request.method === "POST") {
    let input;
    try { input = z.object({ review: reviewSchema, sendDaily: z.boolean().default(false) }).strict().parse(await readJson(request, 30000)); }
    catch { return Response.json({ error: "Invalid reviewed edition" }, { status: 400 }); }
    if (!(await store.rate("review-publication", 20, 3600_000))) return new Response("Try again later", { status: 429 });
    const result = await store.publishReview(input.review, input.sendDaily);
    return Response.json(result, { status: result.status });
  }
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
      store.requestInboxAction(input.threadId, input.action, input.cancel));
    return Response.json(actions ? { actions } : { error: "This email is no longer in the inbox." }, { status: actions ? 200 : 404 });
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
      snapshots: (await store.overview()).map((snapshot) =>
        snapshot.inbox
          ? {
              ...snapshot,
              inbox: {
                ...snapshot.inbox,
                threads: snapshot.inbox.threads.map(
                  ({ body: _body, ...thread }) => thread,
                ),
              },
            }
          : snapshot,
      ),
      archives: await store.archives(),
      review: await store.review(),
      closes: await store.closes(),
      inboxActions: await store.inboxActions(),
      machines: await store.machineList(),
      timeZone: env.TIME_ZONE,
      serverTime: Date.now(),
    });
  if (url.pathname.startsWith("/api/"))
    return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  return env.ASSETS.fetch(request);
}

export function secure(response: Response) {
  const result = new Response(response.body, {status: response.status, statusText: response.statusText, headers: response.headers, webSocket: response.webSocket});
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("Strict-Transport-Security", "max-age=31536000");
  result.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return result;
}
export default {
  async fetch(request: Request, env: Env) {
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
    );
  },
} satisfies ExportedHandler<Env>;

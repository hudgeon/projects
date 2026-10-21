// Each person's inbox, as the machine on duty read it with that account's own
// sign-in: the requests queued against it, which only its owner makes, its
// message text, served to that owner one thread at a time, and what everyone
// else sees of it, which is enough to count what waits there.
import { readJson } from "./auth";
import {
  countsOnly,
  currentInbox,
  inboxActionReportSchema,
  inboxActionRequestSchema,
  sameAccount,
  snapshotInboxes,
  type InboxAction,
  type InboxActionReport,
  type PendingInboxAction,
} from "../src/inbox-model";
import { currentWork } from "../src/work-model";
import { STALE_AFTER, type Snapshot } from "../src/model";
import { trace } from "./telemetry";
import type { MachineCaller } from "./machines";
import type { Portfolio } from "./index";

// How long a machine on duty keeps its last inbox reads through scans that
// could not learn they were on duty.
const KEEP_INBOX_MS = 3 * STALE_AFTER;
// A scan that could not learn it was on duty carries no inboxes: the
// machine's last reads stay, each with its own time so its age shows, and
// lapse after a few missed scans, so a brief outage empties nobody's inbox.
export function keepInboxes(snapshot: Snapshot, previous: Snapshot | undefined, now = Date.now()): Snapshot {
  if (!snapshot.inboxPlaceholders && previous?.inboxPlaceholders &&
      now - previous.inboxPlaceholders.observedAt < KEEP_INBOX_MS)
    snapshot = { ...snapshot, inboxPlaceholders: previous.inboxPlaceholders };
  if (snapshotInboxes(snapshot).length || !previous) return snapshot;
  const kept = snapshotInboxes(previous).filter((inbox) => now - inbox.observedAt < KEEP_INBOX_MS);
  return kept.length ? { ...snapshot, inboxes: kept } : snapshot;
}
// What the overview carries of the inboxes: a browser's own sign-in nothing,
// and no work item's email links; a person their own threads without message
// text, and everyone else's with only what counts the threads waiting there.
export function overviewInboxes(snapshot: Snapshot, viewer: string | null): Snapshot {
  const { inbox: _inbox, inboxes: _inboxes, inboxPlaceholders, ...rest } = snapshot;
  if (viewer === null)
    return {
      ...rest,
      ...(rest.work && {
        work: { ...rest.work, issues: rest.work.issues?.map(({ emailLinks: _links, ...issue }) => issue) ?? null },
      }),
    };
  const all = snapshotInboxes(snapshot);
  return all.length
    ? {
        ...rest,
        ...(inboxPlaceholders && { inboxPlaceholders }),
        inboxes: all.map((inbox) =>
          sameAccount(inbox.account, viewer)
            ? { ...inbox, threads: inbox.threads.map(({ body: _body, ...thread }) => thread) }
            : countsOnly(inbox),
        ),
      }
    : { ...rest, ...(inboxPlaceholders && { inboxPlaceholders }) };
}
type Row = {
  thread: string;
  account: string | null;
  action: InboxAction["action"];
  requested: number;
  state: InboxAction["state"];
  message: string | null;
  updated: number;
  issue: number | null;
};
export class InboxRequests {
  constructor(
    private storage: DurableObjectStorage,
    private overview: () => Snapshot[],
    // Whose the requests from before accounts were recorded are.
    private owner: string,
  ) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS inbox_actions (thread TEXT PRIMARY KEY, action TEXT NOT NULL, requested INTEGER NOT NULL, state TEXT NOT NULL, message TEXT, updated INTEGER NOT NULL)",
    );
    const columns = storage.sql.exec<{ name: string }>("PRAGMA table_info(inbox_actions)").toArray().map((c) => c.name);
    for (const column of ["issue INTEGER", "account TEXT", "requester TEXT"])
      if (!columns.includes(column.split(" ")[0])) storage.sql.exec(`ALTER TABLE inbox_actions ADD COLUMN ${column}`);
    // Requests from before accounts were recorded were made in the only inbox
    // there was, the deployment owner's: they are attributed once, here, so no
    // later read has to guess.
    if (owner) storage.sql.exec("UPDATE inbox_actions SET account=? WHERE account IS NULL", owner);
  }
  private rows(): InboxAction[] {
    return this.storage.sql
      .exec<Row>("SELECT thread,account,action,requested,state,message,updated,issue FROM inbox_actions ORDER BY requested")
      .toArray()
      .map((r) => {
        const account = r.account ?? (this.owner || undefined);
        return {
          threadId: r.thread,
          ...(account ? { account } : {}),
          action: r.action,
          requestedAt: r.requested,
          state: r.state,
          message: r.message,
          updatedAt: r.updated,
          ...(r.issue !== null ? { issue: r.issue } : {}),
        };
      });
  }
  // Everyone's requests: each names its inbox, so every view can tell what is
  // clearing from it, and nothing of the email itself.
  list(): InboxAction[] {
    return this.rows();
  }
  // One request per thread, from the inbox's owner, naming a thread in the
  // latest read of their inbox; a queued request can be withdrawn by them
  // before the machine on duty applies it.
  request(threadId: string, action: InboxAction["action"], requester: string, cancel = false, issue?: number) {
    const now = Date.now();
    this.storage.sql.exec("DELETE FROM inbox_actions WHERE state<>'queued' AND updated<?", now - 7 * 86400_000);
    if (cancel) {
      this.storage.sql.exec(
        "DELETE FROM inbox_actions WHERE thread=? AND action=? AND state='queued' AND lower(COALESCE(account,?))=lower(?)",
        threadId, action, this.owner, requester,
      );
      return this.rows();
    }
    const inbox = currentInbox(this.overview(), requester);
    const thread = inbox?.threads.find((t) => t.id === threadId);
    if (!inbox || !thread) return null;
    if (action === "link" && (!issue || !currentWork(this.overview())?.issues.some((i) => i.number === issue && i.open))) return null;
    if (action !== "link" && issue !== undefined) return null;
    // A different queued operation must finish before accepting another one.
    const pending = this.rows().find((a) => a.threadId === threadId && a.state === "queued");
    if (pending) return pending.action === action && pending.issue === issue ? this.rows() : null;
    this.storage.sql.exec(
      "INSERT INTO inbox_actions(thread,account,requester,action,requested,state,message,updated,issue) VALUES(?,?,?,?,?,'queued',NULL,?,?) ON CONFLICT(thread) DO UPDATE SET account=excluded.account,requester=excluded.requester,action=excluded.action,requested=excluded.requested,state='queued',message=NULL,updated=excluded.updated,issue=excluded.issue",
      threadId, inbox.account.toLowerCase(), requester, action, now, now, issue ?? null,
    );
    return this.rows();
  }
  // What the machine on duty applies, each in the inbox it names.
  pending(): PendingInboxAction[] {
    return this.rows()
      .filter((a) => a.state === "queued")
      .map(({ threadId, account, action, requestedAt, issue }) => ({
        threadId,
        ...(account ? { account } : {}),
        action,
        requestedAt,
        ...(issue !== undefined ? { issue } : {}),
      }));
  }
  // Only the exact request the machine on duty was given, and only while
  // still queued.
  report(r: InboxActionReport) {
    const updated = this.storage.sql
      .exec(
        "UPDATE inbox_actions SET state=?,message=?,updated=? WHERE thread=? AND action=? AND requested=? AND issue IS ? AND state='queued' RETURNING thread",
        r.state, r.message, Date.now(), r.threadId, r.action, r.requestedAt, r.issue ?? null,
      )
      .toArray();
    return { updated: updated.length === 1 };
  }
  // One thread's latest message text, from the stored read of the asking
  // person's own inbox.
  thread(threadId: string, account: string) {
    const thread = currentInbox(this.overview(), account)?.threads.find((t) => t.id === threadId);
    return thread ? { body: thread.body ?? null, unsubscribe: thread.unsubscribe ?? null } : null;
  }
}
type Store = Pick<DurableObjectStub<Portfolio>, "pendingInboxActions" | "reportInboxAction" | "requestInboxAction" | "inboxThread" | "rate">;
// The exchange with the machine on duty, and a signed-in person's requests
// and thread reads in their own inbox. A conversation browser's sign-in never
// reaches these (browserMay); machine tokens reach only the exchange.
export async function inboxRoutes(
  request: Request,
  store: Store,
  caller: string | MachineCaller,
  onDuty: () => Promise<boolean>,
): Promise<Response | null> {
  const url = new URL(request.url);
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
  if (typeof caller !== "string") return null;
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
      store.requestInboxAction(input.threadId, input.action, caller, input.cancel, input.issue));
    return Response.json(actions ? { actions } : { error: "This email or work item is unavailable, or another action is still queued." }, { status: actions ? 200 : 404 });
  }
  const thread = /^\/api\/inbox\/threads\/([a-f0-9]{10,40})$/.exec(url.pathname);
  if (thread && request.method === "GET") {
    const found = await trace("inbox.read", {}, () => store.inboxThread(thread[1], caller));
    return Response.json(found ? { thread: found } : { error: "This email is no longer in your inbox." }, {
      status: found ? 200 : 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}

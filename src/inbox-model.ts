import { z } from "zod";
import type { Issue } from "./work-model";
import type { RunSummary } from "./run-model";
const id = z.string().regex(/^[a-f0-9]{10,40}$/);
export const INBOX_BODY_LIMIT = 4000;
// How the latest message's list can be left (RFC 2369 / RFC 8058). One-click
// lists are unsubscribed by the machine on duty; others are left to a conversation.
export const unsubscribeSchema = z
  .object({
    oneClick: z.boolean(),
    url: z
      .url()
      .max(2000)
      .refine((value) => new URL(value).protocol === "https:")
      .nullable(),
    mailto: z.string().max(500).startsWith("mailto:").nullable(),
  })
  .strict();
export const inboxThreadSchema = z
  .object({
    id,
    subject: z.string().max(300),
    from: z.string().max(300),
    latestMessageId: id,
    updatedAt: z.number().int().nonnegative(),
    reference: z.boolean().optional(),
    inInbox: z.boolean().optional(),
    lastSentByMe: z.boolean(),
    unread: z.boolean(),
    messages: z.number().int().positive(),
    // The latest message as plain text, quotes removed, for threads in the
    // inbox. Served one thread at a time, never in the overview or telemetry.
    body: z.string().max(INBOX_BODY_LIMIT).optional(),
    unsubscribe: unsubscribeSchema.nullable().optional(),
  })
  .strict();
export const inboxSchema = z
  .object({
    account: z.email(),
    observedAt: z.number().int().nonnegative(),
    state: z.enum(["ok", "unavailable", "incomplete"]),
    threads: z.array(inboxThreadSchema).max(500),
  })
  .strict();
export type Inbox = z.infer<typeof inboxSchema>;
export type InboxThread = z.infer<typeof inboxThreadSchema>;
export const sameAccount = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
type Inboxed = { inbox?: Inbox; inboxes?: Inbox[] };
// Every inbox a snapshot carries: one per connected account, or the single
// inbox of a collector from before accounts were listed, which is its owner's.
export const snapshotInboxes = (s: Inboxed) =>
  s.inboxes ?? (s.inbox ? [s.inbox] : []);
// The machine on duty reads Gmail; the newest read of each account wins.
export function currentInboxes(snapshots: Inboxed[]) {
  const newest = new Map<string, Inbox>();
  for (const inbox of snapshots
    .flatMap(snapshotInboxes)
    .sort((a, b) => b.observedAt - a.observedAt))
    if (!newest.has(inbox.account.toLowerCase()))
      newest.set(inbox.account.toLowerCase(), inbox);
  return [...newest.values()];
}
// A person's inbox is the account that is their address. Without an address,
// the newest inbox of all: what a collector from before accounts were listed
// read, which is its owner's.
export function currentInbox(snapshots: Inboxed[], account?: string) {
  const inboxes = currentInboxes(snapshots);
  return account
    ? inboxes.find((inbox) => sameAccount(inbox.account, account))
    : inboxes[0];
}
// The inbox holding a thread, whoever's it is: a work item's email link.
export function inboxWithThread(snapshots: Inboxed[], threadId: string) {
  return currentInboxes(snapshots).find((inbox) =>
    inbox.threads.some((thread) => thread.id === threadId),
  );
}
// What everyone else sees of a person's inbox: what counts the threads waiting
// in it and recognises them on work items, never their subject, sender, text
// or list links.
export function countsOnly(inbox: Inbox): Inbox {
  return {
    ...inbox,
    threads: inbox.threads.map(
      ({ body: _body, unsubscribe: _list, ...thread }) => ({
        ...thread,
        subject: "",
        from: "",
      }),
    ),
  };
}
// A person's requests to archive or leave a list, in their own inbox. Like
// Mark done, the Worker only queues a thread ID; the machine on duty applies
// it with that account's own Gmail sign-in.
export const inboxActionSchema = z
  .object({
    threadId: id,
    // The inbox the thread is in. Absent on a request from before accounts
    // were recorded, which was the owner's.
    account: z.email().optional(),
    action: z.enum(["archive", "unsubscribe", "link"]),
    issue: z.number().int().positive().optional(),
    requestedAt: z.number().int().positive(),
    state: z.enum(["queued", "done", "failed"]),
    message: z.string().max(200).nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type InboxAction = z.infer<typeof inboxActionSchema>;
export const inboxActionRequestSchema = z
  .object({
    threadId: id,
    action: z.enum(["archive", "unsubscribe", "link"]),
    issue: z.number().int().positive().optional(),
    cancel: z.boolean().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.action === "link"
        ? a.cancel || a.issue !== undefined
        : a.issue === undefined,
    "Link requests need a work issue; other actions cannot name one.",
  );
export const pendingInboxActionSchema = inboxActionSchema.pick({
  threadId: true,
  account: true,
  action: true,
  requestedAt: true,
  issue: true,
});
export type PendingInboxAction = z.infer<typeof pendingInboxActionSchema>;
export const inboxActionReportSchema = inboxActionSchema.omit({
  updatedAt: true,
});
export type InboxActionReport = z.infer<typeof inboxActionReportSchema>;
// A thread linked from another Gmail account cannot be read with this inbox's
// login. It is outside this inbox's coverage, not a failed read.
export function trackedThreads(account: string, issues: Issue[]) {
  return issues.flatMap((issue) =>
    (issue.emailLinks ?? [])
      .filter((link) => {
        const url = link.url ? new URL(link.url) : null;
        // Gmail names the account as ?authuser= or in the path, /mail/u/NAME/.
        const user =
          url?.searchParams.get("authuser") ??
          decodeURIComponent(
            url?.pathname.match(/^\/mail\/u\/([^/]+)/)?.[1] ?? "",
          );
        return (
          !user?.includes("@") || user.toLowerCase() === account.toLowerCase()
        );
      })
      .map((link) => link.threadId),
  );
}
export function gmailUrl(account: string, thread: string) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${thread}`;
}
export function inboxRows(inbox: Inbox, issues: Issue[]) {
  return inbox.threads
    .map((thread) => {
      const linked = issues.filter((i) =>
        i.emailLinks?.some((l) => l.threadId === thread.id),
      );
      const reviewed =
        !!(thread.reference && linked.length === 0) ||
        (linked.length > 0 &&
          linked.every((i) =>
            i.emailLinks?.some(
              (l) =>
                l.threadId === thread.id &&
                l.reviewedMessageId === thread.latestMessageId,
            ),
          ));
      return {
        thread,
        linked,
        reviewed,
        reason:
          thread.reference && !linked.length
            ? "Reference only"
            : !linked.length
              ? "Not linked to work"
              : !reviewed
                ? "New message to review"
                : "Linked to work",
      };
    })
    .sort(
      (a, b) =>
        Number(a.reviewed) - Number(b.reviewed) ||
        b.thread.updatedAt - a.thread.updatedAt,
    );
}
type ThreadConversation = Pick<
  RunSummary,
  "id" | "emailThread" | "archivedAt" | "createdAt" | "updatedAt" | "state"
>;
// Where each thread in the inbox stands for the owner. A thread read only
// because work links it, and already out of the inbox, waits on nobody. A
// requested archive or unsubscribe clears it at once (a failed one returns
// it); a current conversation is handling it unless it failed or was
// stopped; a Done conversation handled it unless someone wrote again
// afterwards.
export function inboxQueue<T extends ThreadConversation>(
  inbox: Inbox,
  issues: Issue[],
  conversations: T[],
  actions: InboxAction[] = [],
) {
  // Another inbox's requests never clear this one's threads.
  actions = actions.filter(
    (a) => !a.account || sameAccount(a.account, inbox.account),
  );
  const latest = new Map<string, T>();
  for (const run of conversations)
    if (
      run.emailThread &&
      (latest.get(run.emailThread)?.createdAt ?? -1) < run.createdAt
    )
      latest.set(run.emailThread, run);
  const requested = new Map(
    actions.filter((a) => a.action !== "link").map((a) => [a.threadId, a]),
  );
  // Reads from older collectors do not say; their threads are in the inbox.
  const waiting = inboxRows(inbox, issues).filter(
    (row) => row.thread.inInbox !== false,
  );
  return waiting.map((row) => {
    const conversation = latest.get(row.thread.id);
    // A request made before the latest message cannot clear a newer email.
    const action = requested.get(row.thread.id);
    const current =
      action && action.requestedAt >= row.thread.updatedAt ? action : undefined;
    const state: "todo" | "handling" | "handled" | "reviewed" | "clearing" =
      current && current.state !== "failed"
        ? "clearing"
        : conversation &&
            !conversation.archivedAt &&
            !["failed", "cancelled"].includes(conversation.state)
          ? "handling"
          : conversation?.archivedAt &&
              (row.thread.lastSentByMe ||
                row.thread.updatedAt <= conversation.updatedAt)
            ? "handled"
            : row.reviewed
              ? "reviewed"
              : "todo";
    return { ...row, conversation, action: current, state };
  });
}

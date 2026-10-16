import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ago,
  freshness,
  hostName,
  type PortfolioView,
  type Snapshot,
} from "./model";
import { currentWork, type Issue } from "./work-model";
import {
  currentInbox,
  gmailUrl,
  inboxQueue,
  inboxRows,
  type InboxAction,
  type InboxThread,
} from "./inbox-model";
import {
  Composer,
  errorText,
  LinkedText,
  runStates,
  useEmailConversations,
} from "./run-view";
import { conversationSearch, workSearch } from "./navigation";
import { clip } from "./run-text";
import { api, privateQueryPolicy } from "./overview-query";
import type { Run, RunSummary } from "./run-model";
import type { ArchiveEntry } from "./archive-model";

export function sender(from: string) {
  const name = from
    .replace(/<[^>]*>/, "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return name || from.match(/<([^>]+)>/)?.[1] || from;
}
// Only a source link crosses into the activity request; email prose stays out.
export function activityContext(thread: InboxThread, account: string) {
  return {
    title: "Activity from email",
    detail: `Source email: ${gmailUrl(account, thread.id)}. Read it only if relevant to this activity. Do not assume this requires a reply.`,
  };
}
// Lists without one-click unsubscribe go to a quick conversation. The request
// authorizes only the list's own unsubscribe mechanism.
export function unsubscribeRequest(thread: InboxThread, account: string) {
  const subject = thread.subject.replace(/[[\]]/g, "");
  const how = [
    thread.unsubscribe?.url ? `unsubscribe link ${thread.unsubscribe.url}` : "",
    thread.unsubscribe?.mailto
      ? `unsubscribe address ${thread.unsubscribe.mailto}`
      : "",
  ].filter(Boolean);
  return [
    `Unsubscribe me from ${sender(thread.from)}`,
    `Email: [${subject}](${gmailUrl(account, thread.id)}). Leave this mailing list using its own unsubscribe mechanism${how.length ? ` (${how.join("; ")})` : ""}. You may send one unsubscribe email to the list's unsubscribe address if that is its mechanism; send nothing else. If it needs me to click or confirm, give me the link.`,
  ].join("\n\n");
}
// Emails to handle, and whether that number covers the whole inbox. A stale,
// truncated or failed read is never presented as an inbox with nothing to do.
function coverage(snapshots: Snapshot[], now: number) {
  const inbox = currentInbox(snapshots),
    work = currentWork(snapshots);
  return (
    !!inbox &&
    inbox.state === "ok" &&
    !freshness(inbox.observedAt, now) &&
    !!work &&
    !freshness(work.observedAt, now)
  );
}
export function inboxCount(
  snapshots: Snapshot[],
  runs: RunSummary[] | undefined,
  actions: InboxAction[],
  now: number,
) {
  const inbox = currentInbox(snapshots);
  if (!inbox || !runs) return null;
  return {
    todo:
      inbox.state === "unavailable"
        ? 0
        : inboxQueue(
            inbox,
            currentWork(snapshots)?.issues ?? [],
            runs,
            actions,
          ).filter((item) => item.state === "todo").length,
    complete: coverage(snapshots, now),
  };
}
type Item = ReturnType<typeof inboxQueue<RunSummary>>[number];
// Archive and unsubscribe are queued for the machine on duty, like Mark done; the email
// leaves the list at once and the request can be withdrawn until it is applied.
function useInboxAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      threadId: string;
      action: InboxAction["action"];
      cancel?: boolean;
      issue?: number;
    }) => api<{ actions: InboxAction[] }>("/api/inbox/act", input),
    onSuccess: ({ actions }) =>
      client.setQueryData<PortfolioView>(["overview"], (old) =>
        old ? { ...old, inboxActions: actions } : old,
      ),
  });
}
const actionWords = {
  archive: ["Archiving", "Archived"],
  unsubscribe: ["Unsubscribing", "Unsubscribed"],
  link: ["Linking", "Linked"],
} as const;
function Preview({
  thread,
  account,
}: {
  thread: InboxThread;
  account: string;
}) {
  const [all, setAll] = useState(false);
  const preview = useQuery({
    queryKey: ["inbox-thread", thread.id, thread.latestMessageId],
    queryFn: () =>
      api<{ thread: { body: string | null } }>(
        `/api/inbox/threads/${thread.id}`,
      ),
    ...privateQueryPolicy(60_000),
  });
  const body = preview.data?.thread.body;
  const long =
    (body?.length ?? 0) > 900 || (body?.split("\n").length ?? 0) > 14;
  return (
    <div className="mail-preview">
      {preview.isPending ? (
        <p className="subtle">Loading the latest message…</p>
      ) : preview.error ? (
        <p className="error-inline">{errorText(preview.error)}</p>
      ) : body ? (
        <>
          <p className={`mail-body${long && !all ? " clamp" : ""}`}>
            <LinkedText text={body} />
          </p>
          {long && (
            <button className="link-button" onClick={() => setAll(!all)}>
              {all ? "Show less" : "Show all"}
            </button>
          )}
        </>
      ) : (
        <p className="subtle">No preview for this message.</p>
      )}
      <a href={gmailUrl(account, thread.id)} target="_blank" rel="noreferrer">
        Open in Gmail
      </a>
    </div>
  );
}
function MailRow({
  item,
  account,
  snapshots,
  archives,
  now,
  selected = false,
  issues,
  linkAction,
}: {
  selected?: boolean;
  issues: Issue[];
  linkAction?: InboxAction;
  item: Item;
  account: string;
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  now: number;
}) {
  const [composing, setComposing] = useState(false),
    [open, setOpen] = useState(selected),
    [linking, setLinking] = useState(false),
    [issue, setIssue] = useState("");
  const element = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) {
      setOpen(true);
      element.current?.scrollIntoView({ block: "center" });
    }
  }, [selected]);
  const navigate = useNavigate({ from: "/" });
  const act = useInboxAction();
  const client = useQueryClient();
  const { thread, linked, conversation, state, action } = item;
  const [label, tone] = conversation ? runStates[conversation.state] : ["", ""];
  // No one-click link: archive now and let a quick conversation leave the list.
  const askToUnsubscribe = useMutation({
    mutationFn: async () => {
      const run = await api<{ run: Run }>("/api/runs", {
        requestId: crypto.randomUUID(),
        text: unsubscribeRequest(thread, account),
        projectId: null,
        agent: "auto",
        workIssue: null,
        emailThread: thread.id,
        lane: "quick",
      });
      await act.mutateAsync({ threadId: thread.id, action: "archive" });
      return run;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }),
  });
  const unsubscribe = () =>
    thread.unsubscribe?.oneClick
      ? act.mutate({ threadId: thread.id, action: "unsubscribe" })
      : askToUnsubscribe.mutate();
  const busy =
    act.isPending ||
    askToUnsubscribe.isPending ||
    linkAction?.state === "queued";
  const error = act.error ?? askToUnsubscribe.error;
  if (state === "clearing" && action)
    return (
      <li className="mail mail-clearing">
        <span className="mail-subject">{thread.subject}</span>
        <span className="mail-meta">
          {actionWords[action.action][action.state === "done" ? 1 : 0]}
          {action.state === "queued" ? "… applied on the next check." : "."}
          {action.state === "queued" && (
            <>
              {" "}
              <button
                className="link-button"
                disabled={busy}
                onClick={() =>
                  act.mutate({
                    threadId: thread.id,
                    action: action.action,
                    cancel: true,
                  })
                }
              >
                Undo
              </button>
            </>
          )}
        </span>
      </li>
    );
  return (
    <li className="mail" ref={element}>
      <button
        className="mail-open"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="mail-subject">{thread.subject}</span>
        <span className="mail-meta">
          {sender(thread.from)} · {ago(thread.updatedAt, now)}
          {thread.messages > 1 ? ` · ${thread.messages} messages` : ""}
          {thread.lastSentByMe ? " · you wrote last" : ""}
        </span>
      </button>
      {!!linked.length && (
        <span className="mail-work">
          {linked.map((issue) => (
            <Link
              key={issue.number}
              to="/"
              search={workSearch(issue.number, thread.id)}
            >
              {clip(issue.title, 80)}
            </Link>
          ))}
        </span>
      )}
      {conversation && (
        <Link
          className="mail-convo"
          to="/"
          search={conversationSearch(
            conversation.id,
            undefined,
            conversation.archivedAt ? true : undefined,
          )}
        >
          <span
            className={`state-dot tone-${conversation.archivedAt ? "quiet" : tone}`}
            aria-hidden="true"
          />
          <strong>{conversation.archivedAt ? "Done" : label}</strong>
          {conversation.status ? ` · ${conversation.status}` : ""}
        </Link>
      )}
      {action?.state === "failed" && (
        <span className="error-inline">
          {action.action === "archive" ? "Archive" : "Unsubscribe"} didn’t work:{" "}
          {action.message ?? "try again."}
        </span>
      )}
      {open && <Preview thread={thread} account={account} />}
      {!composing && (
        <span className="mail-actions">
          {state !== "handling" && !linked.length && (
            <button className="btn-quiet" onClick={() => setComposing(true)}>
              Start standalone activity
            </button>
          )}
          {!linked.length && (
            <button
              className="btn-quiet"
              disabled={busy}
              onClick={() => setLinking(!linking)}
            >
              Link to bigger work
            </button>
          )}
          <button
            className="btn-quiet"
            disabled={busy}
            onClick={() =>
              act.mutate({ threadId: thread.id, action: "archive" })
            }
          >
            Archive
          </button>
          {thread.unsubscribe && (
            <button
              className="btn-quiet"
              disabled={busy}
              title={
                thread.unsubscribe.oneClick
                  ? "Projects uses the list's one-click unsubscribe, then archives"
                  : "Archives now and asks Projects to leave the list"
              }
              onClick={unsubscribe}
            >
              Unsubscribe
            </button>
          )}
        </span>
      )}
      {linkAction && (
        <p
          className={linkAction.state === "failed" ? "error-inline" : "subtle"}
          role="status"
        >
          {linkAction.state === "queued"
            ? "Linking to bigger work on the next check…"
            : linkAction.message}
          {linkAction.state === "queued" && (
            <button
              className="btn-quiet"
              onClick={() =>
                act.mutate({
                  threadId: thread.id,
                  action: "link",
                  issue: linkAction.issue,
                  cancel: true,
                })
              }
            >
              Undo
            </button>
          )}
          {linkAction.state === "done" && linkAction.issue && (
            <Link to="/" search={workSearch(linkAction.issue, thread.id)}>
              {" "}
              Open bigger work
            </Link>
          )}
        </p>
      )}
      {linking && (
        <form
          className="mail-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (issue && !busy)
              act.mutate(
                { threadId: thread.id, action: "link", issue: Number(issue) },
                { onSuccess: () => setLinking(false) },
              );
          }}
        >
          <label>
            Bigger work{" "}
            <select
              required
              value={issue}
              disabled={busy}
              onChange={(event) => setIssue(event.target.value)}
            >
              <option value="">Choose work…</option>
              {issues
                .filter((i) => i.open)
                .map((i) => (
                  <option key={i.number} value={i.number}>
                    {i.title}
                  </option>
                ))}
            </select>
          </label>
          <button className="btn-quiet" disabled={!issue || busy}>
            Link
          </button>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => setLinking(false)}
          >
            Cancel
          </button>
        </form>
      )}
      {error && (
        <span role="alert" className="error-inline">
          {errorText(error)}
        </span>
      )}
      {composing && (
        <Composer
          snapshots={snapshots}
          archives={archives}
          context={activityContext(thread, account)}
          emailThread={thread.id}
          workIssue={linked.length === 1 ? linked[0].number : undefined}
          autoFocus
          submitLabel="Start activity"
          placeholder="What needs doing?"
          onCancel={() => setComposing(false)}
          onStarted={(run) => {
            setComposing(false);
            void navigate({ to: "/", search: conversationSearch(run.id) });
          }}
        />
      )}
    </li>
  );
}
export function InboxView({
  snapshots,
  archives,
  actions,
  now,
  selectedEmail,
}: {
  selectedEmail?: string;
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  actions: InboxAction[];
  now: number;
}) {
  const inbox = currentInbox(snapshots),
    work = currentWork(snapshots);
  const conversations = useEmailConversations();
  if (!inbox)
    return (
      <section className="inbox">
        <p className="subtle">No machine has read the inbox yet.</p>
      </section>
    );
  // Until the conversations load, every email would look unhandled.
  if (!conversations.data)
    return (
      <section className="inbox">
        <p className={conversations.error ? "error" : "subtle"} role="status">
          {errorText(conversations.error) ?? "Loading the inbox…"}
        </p>
      </section>
    );
  const items = inboxQueue(
    inbox,
    work?.issues ?? [],
    conversations.data.runs,
    actions,
  );
  const selectedSource =
    selectedEmail && !items.some((i) => i.thread.id === selectedEmail)
      ? inboxRows(inbox, work?.issues ?? []).find(
          (i) => i.thread.id === selectedEmail,
        )
      : undefined;
  const list = (state: Item["state"]) =>
    items.some((item) => item.state === state) && (
      <ul className="mail-list">
        {items
          .filter((item) => item.state === state)
          .map((item) => (
            <MailRow
              key={item.thread.id}
              item={item}
              selected={selectedEmail === item.thread.id}
              issues={work?.issues ?? []}
              linkAction={actions.find(
                (a) => a.threadId === item.thread.id && a.action === "link",
              )}
              account={inbox.account}
              snapshots={snapshots}
              archives={archives}
              now={now}
            />
          ))}
      </ul>
    );
  const count = (state: Item["state"]) =>
    items.filter((item) => item.state === state).length;
  const complete = coverage(snapshots, now);
  // The machine on duty reads Gmail.
  const readerHost = snapshots.find((s) => s.inbox === inbox)?.host;
  const reader = readerHost ? hostName(readerHost) : "the machine on duty";
  return (
    <section className="inbox" aria-label="Inbox">
      <div className="section-head">
        <h2>
          To handle <span className="count">{count("todo")}</span>
        </h2>
        <span className="subtle">
          {inbox.account} · checked {ago(inbox.observedAt, now)} on {reader}
        </span>
      </div>
      {selectedSource && (
        <ul className="mail-list">
          <MailRow
            key={selectedSource.thread.id}
            item={{
              ...selectedSource,
              conversation: undefined,
              action: undefined,
              state: selectedSource.reviewed ? "reviewed" : "todo",
            }}
            selected
            issues={work?.issues ?? []}
            account={inbox.account}
            snapshots={snapshots}
            archives={archives}
            now={now}
          />
        </ul>
      )}
      {selectedEmail &&
        !selectedSource &&
        !items.some((i) => i.thread.id === selectedEmail) && (
          <p className="notice">
            This email is not in the latest inventory. Open its source from the
            work issue in GitHub.
          </p>
        )}
      {!complete && (
        <p className="notice" role="status">
          {inbox.state === "unavailable"
            ? `${readerHost ? hostName(readerHost) : "The machine on duty"} couldn’t read Gmail, so this list may be out of date.`
            : inbox.state === "incomplete"
              ? "Some threads couldn’t be read, so a few may be missing."
              : "This list may be out of date: no machine has checked recently."}
        </p>
      )}
      {list("todo")}
      {!count("todo") && complete && (
        <p className="subtle">Nothing waiting. New replies come back here.</p>
      )}
      {!!count("clearing") && (
        <>
          <h3 className="section-sub">
            Archiving <span className="count">{count("clearing")}</span>
          </h3>
          {list("clearing")}
        </>
      )}
      {!!count("handling") && (
        <>
          <h3 className="section-sub">
            In conversations <span className="count">{count("handling")}</span>
          </h3>
          {list("handling")}
        </>
      )}
      {!!count("handled") && (
        <details
          className="fold"
          open={items.some(
            (i) => i.state === "handled" && i.thread.id === selectedEmail,
          )}
        >
          <summary>
            Handled <span className="count">{count("handled")}</span>
          </summary>
          {list("handled")}
        </details>
      )}
      {!!count("reviewed") && (
        <details
          className="fold"
          open={items.some(
            (i) => i.state === "reviewed" && i.thread.id === selectedEmail,
          )}
        >
          <summary>
            Reviewed <span className="count">{count("reviewed")}</span>
          </summary>
          <p className="subtle">
            Linked to work or kept for reference. A new message brings a thread
            back.
          </p>
          {list("reviewed")}
        </details>
      )}
    </section>
  );
}

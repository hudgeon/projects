import { ago, freshness, hostName, type Snapshot } from "./model";
import { currentWork } from "./work-model";
import {
  currentInbox,
  currentInboxes,
  currentInboxPlaceholders,
  gmailUrl,
  inboxQueue,
  inboxRows,
  sameAccount,
  snapshotInboxes,
  type Inbox,
  type InboxAction,
} from "./inbox-model";
import { errorText, useEmailConversations } from "./run-view";
import { MailRow, sender, type Item } from "./inbox-row";
import { useMe, useOwnerLabel } from "./people-view";
import type { RunSummary } from "./run-model";
import type { ArchiveEntry } from "./archive-model";
import type { ChatSource } from "./chat-model";
import { ChatSections, SourceFilter, useChats } from "./chat-view";
import type { ChatList, ChatView } from "./chat-model";
import { withoutSupportCopies } from "./support-copies";

const mailRead = (list?: ChatList) => list?.reads.find(read => read.emailQueue);
const mailHealthy = (list: ChatList | undefined, now: number) => {
  const read = mailRead(list);
  return !read || (read.state === "ok" && now - read.observedAt < 90_000);
};

function emailQueue(inbox: Inbox, items: Item[], messages?: ChatList) {
  const mail = messages?.items.filter(item => item.mail && sameAccount(item.owner, inbox.account)) ?? [];
  const byMessage = new Map(mail.map(item => [item.mail!.messageKey, item]));
  const rows = items.map(row => {
    const queued = byMessage.get(row.thread.latestMessageKey ?? "");
    if (queued) byMessage.delete(queued.mail!.messageKey);
    return queued?.mail?.urgent && row.state !== "clearing"
      ? { ...row, state: "todo" as const, thread: { ...row.thread, urgent: true } }
      : row;
  }).sort((a, b) => Number(!!b.thread.urgent) - Number(!!a.thread.urgent));
  return { rows, extra: [...byMessage.values()] };
}

function QueuedEmail({ item, account, now }: { item: ChatView; account: string; now: number }) {
  return (
    <li className="mail">
      <a className="mail-open" href={gmailUrl(item.mail!.account, item.mail!.thread)} target="_blank" rel="noreferrer">
        <span className="mail-subject">{item.mail?.urgent && <strong>Urgent · </strong>}{item.place.name}</span>
        <span className="mail-meta">
          {sameAccount(item.mail!.account, account) ? "Your inbox" : "Support"} · {sender(item.from)} · {ago(item.at, now)}
        </span>
      </a>
    </li>
  );
}

// Emails to handle in one inbox, and whether that number covers the whole
// inbox. A stale, truncated or failed read is never presented as an inbox with
// nothing to do.
function coverage(inbox: Inbox | undefined, snapshots: Snapshot[], now: number) {
  const work = currentWork(snapshots);
  return (
    !!inbox &&
    inbox.state === "ok" &&
    !freshness(inbox.observedAt, now) &&
    !!work &&
    !freshness(work.observedAt, now)
  );
}
// What waits in one person's inbox, by their account. Everyone's requests
// come in, so another person's archive clears their count too.
export function inboxCount(
  snapshots: Snapshot[],
  runs: RunSummary[] | undefined,
  actions: InboxAction[],
  now: number,
  account: string | undefined,
  support?: ChatList,
) {
  const inbox = account ? currentInbox(snapshots, account) : undefined;
  if (!inbox || !runs) return null;
  const items = inbox.state === "unavailable" ? [] :
    inboxQueue(withoutSupportCopies(inbox, support, now), currentWork(snapshots)?.issues ?? [], runs, actions);
  const queue = emailQueue(inbox, items, support);
  return {
    todo: queue.rows.filter(item => item.state === "todo").length + queue.extra.length,
    complete: coverage(inbox, snapshots, now) && mailHealthy(support, now),
  };
}
// The Inbox: the person's email and, once a machine reads them, their Slack
// and Teams items, by source or all together. A conversation browser's own
// sign-in sees neither.
export function InboxView({
  source,
  ...email
}: Parameters<typeof EmailInbox>[0] & { source?: "email" | ChatSource }) {
  const chats = useChats();
  if (source === "support" && mailRead(chats.data)) source = "email";
  return (
    <div className="inbox">
      {!email.emailHidden && <SourceFilter source={source} list={chats.data} />}
      {(!source || source === "email") && <EmailInbox {...email} />}
      {!email.emailHidden && source !== "email" && <ChatSections source={source} now={email.now} />}
    </div>
  );
}
// The signed-in person's own inbox, as its machine read it, or how much waits
// in everyone's. Another person's messages are never shown here: only the
// count of them.
function EmailInbox({
  snapshots,
  archives,
  actions,
  now,
  selectedEmail,
  emailHidden,
  everyone,
  onEveryone,
}: {
  selectedEmail?: string;
  emailHidden?: boolean;
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  actions: InboxAction[];
  now: number;
  everyone: boolean;
  onEveryone: (everyone: boolean) => void;
}) {
  const me = useMe().data?.email;
  const support = useChats().data;
  const ownerLabel = useOwnerLabel();
  const inboxes = currentInboxes(snapshots),
    work = currentWork(snapshots);
  const conversations = useEmailConversations();
  const inbox = me ? currentInbox(snapshots, me) : undefined;
  const placeholderScan = currentInboxPlaceholders(snapshots);
  const placeholders = placeholderScan?.inboxPlaceholders;
  const others = inboxes.filter((other) => other !== inbox);
  if (emailHidden)
    return (
      <section className="inbox">
        <p className="subtle">
          This browser signed in automatically, so it cannot see email.
        </p>
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
  const runs = conversations.data.runs;
  const readerOf = (read: Inbox) => {
    const host = snapshots.find((s) => snapshotInboxes(s).includes(read))?.host;
    return host ? hostName(host) : "the machine on duty";
  };
  const scope = (others.length > 0 || !!placeholders?.names.length) && (
    <div className="filters scope" role="group" aria-label="Whose inbox">
      <button
        type="button"
        className={everyone ? "" : "selected"}
        aria-pressed={!everyone}
        onClick={() => onEveryone(false)}
      >
        Yours
      </button>
      <button
        type="button"
        className={everyone ? "selected" : ""}
        aria-pressed={everyone}
        onClick={() => onEveryone(true)}
      >
        Everyone
      </button>
    </div>
  );
  if (everyone && (others.length || placeholders?.names.length))
    return (
      <section className="inbox" aria-label="Inbox">
        {scope}
        <ul className="mail-list">
          {placeholders?.names.map((name) => (
            <li className="mail" key={`placeholder:${name}`}>
              <span className="mail-subject">
                {name} <span className="count">0</span>
              </span>
              <span className="mail-meta">
                checked {ago(placeholders.observedAt, now)} on {hostName(placeholderScan!.host)}
              </span>
            </li>
          ))}
          {inboxes.map((read) => {
            const count = inboxCount(snapshots, runs, actions, now, read.account, read.account === me ? support : undefined);
            return (
              <li className="mail" key={read.account}>
                <span className="mail-subject">
                  {ownerLabel(read.account)}
                  {count && (
                    <span className="count">
                      {count.todo}
                      {count.complete ? "" : "?"}
                    </span>
                  )}
                </span>
                <span className="mail-meta">
                  {count ? `${count.todo} to handle` : "Unread"}
                  {count && !count.complete ? ", list may be out of date" : ""}
                  {` · ${read.account} · checked ${ago(read.observedAt, now)} on ${readerOf(read)}`}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="subtle">
          Each person sees their own messages; everyone sees the counts.
        </p>
      </section>
    );
  if (!inbox)
    return (
      <section className="inbox" aria-label="Inbox">
        {scope}
        <p className="subtle">
          {me
            ? "No machine has read your inbox yet. Connect your Gmail sign-in on the machine on duty to see it here."
            : "Loading your inbox…"}
        </p>
      </section>
    );
  const { rows: items, extra } = emailQueue(inbox,
    inboxQueue(withoutSupportCopies(inbox, support, now), work?.issues ?? [], runs, actions), support);
  const selectedSource =
    selectedEmail && !items.some((i) => i.thread.id === selectedEmail)
      ? inboxRows(inbox, work?.issues ?? []).find(
          (i) => i.thread.id === selectedEmail,
        )
      : undefined;
  const list = (state: Item["state"]) =>
    (items.some((item) => item.state === state) || (state === "todo" && extra.length > 0)) && (
      <ul className="mail-list">
        {state === "todo" && extra.filter(item => item.mail?.urgent).map(item =>
          <QueuedEmail key={item.key} item={item} account={inbox.account} now={now} />)}
        {items
          .filter((item) => item.state === state)
          .map((item) => (
            <MailRow
              key={item.thread.id}
              item={item}
              selected={selectedEmail === item.thread.id}
              issues={work?.issues ?? []}
              linkAction={actions.find(
                (a) =>
                  a.threadId === item.thread.id &&
                  a.action === "link" &&
                  (!a.account ||
                    a.account.toLowerCase() === inbox.account.toLowerCase()),
              )}
              account={inbox.account}
              snapshots={snapshots}
              archives={archives}
              now={now}
            />
          ))}
        {state === "todo" && extra.filter(item => !item.mail?.urgent).map(item =>
          <QueuedEmail key={item.key} item={item} account={inbox.account} now={now} />)}
      </ul>
    );
  const count = (state: Item["state"]) =>
    items.filter((item) => item.state === state).length + (state === "todo" ? extra.length : 0);
  const complete = coverage(inbox, snapshots, now);
  const urgentCount = items.filter(item => item.thread.urgent && item.state === "todo").length +
    extra.filter(item => item.mail?.urgent).length;
  const latestCheck = mailRead(support);
  const reader = readerOf(inbox);
  return (
    <section className="inbox" aria-label="Inbox">
      {scope}
      <div className="section-head">
        <h2>
          To handle <span className="count">{count("todo")}</span>
          {latestCheck && mailHealthy(support, now) && <span className="subtle"> · {urgentCount} urgent</span>}
        </h2>
        <span className="subtle">
          {inbox.account} · checked {ago(inbox.observedAt, now)} on {reader}
          {latestCheck && ` · urgency checked ${ago(latestCheck.observedAt, now).toLowerCase()}`}
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
            {others.some((other) =>
              other.threads.some((t) => t.id === selectedEmail),
            )
              ? "This email is in another person's inbox, so only they can open it here."
              : "This email is not in the latest inventory. Open its source from the work issue in GitHub."}
          </p>
        )}
      {!complete && (
        <p className="notice" role="status">
          {inbox.state === "unavailable"
            ? `${reader === "the machine on duty" ? "The machine on duty" : reader} couldn’t read Gmail as ${inbox.account}, so this list may be out of date.`
            : inbox.state === "incomplete"
              ? "Some threads couldn’t be read, so a few may be missing."
              : "This list may be out of date: no machine has checked recently."}
        </p>
      )}
      {!mailHealthy(support, now) && (
        <p className="notice" role="status">The latest urgent email check is incomplete or out of date.</p>
      )}
      {list("todo")}
      {!count("todo") && complete && mailHealthy(support, now) && (
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

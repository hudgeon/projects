import { CHAT_ITEMS_LIMIT, CHAT_TEXT_LIMIT, type ChatItem, type ChatRead } from "../src/chat-model";
import { sameAccount } from "../src/inbox-model";
import { GMAIL_READ_SCOPE } from "./delegation";
import { inboxLogins, type Config } from "./config";
import { delegatedGws, delegationKey, gwsFor } from "./inbox-logins";
import { readInbox } from "./inbox";
import { mailHash, mailbox } from "./mail-identity";
import { postChatRead, type Site } from "./upload";

// The normal inbox reader caches unchanged Gmail history IDs. The short
// overlap also catches urgent mail routed past INBOX by a Gmail filter.
export async function readMailQueue(config: Config, now = Date.now()): Promise<ChatRead> {
  const support = config.support!;
  const owner = inboxLogins(config).find(login => sameAccount(login.account, support.owner));
  // Each scan needs fresh short-lived grants. Both reads share the same
  // in-memory key lookup for that scan, so a failed lookup can be retried.
  const scope = { home: config.home, doppler: config.doppler };
  const delegated = (account: string) => delegatedGws(account, GMAIL_READ_SCOPE, () => delegationKey(scope));
  const shared = support.configDir ? gwsFor({ account: support.account, configDir: support.configDir })
    : delegated(support.account);
  const since = now - 30 * 60_000;
  const read = (account: string, gws: ReturnType<typeof gwsFor>) =>
    readInbox(account, gws, now, config.home, [], `email-queue-v1.${mailHash(account)}.json`, since);
  const reads = await Promise.all([
    read(support.account, shared),
    owner ? read(owner.account, owner.delegated ? delegated(owner.account) : gwsFor(owner)) : undefined,
  ]);
  const replies = new Set(reads.flatMap(inbox => inbox?.threads.flatMap(t => t.repliedMessageKey ?? []) ?? []));
  const own = new Set([support.account, support.owner, ...support.aliases].map(a => a.toLowerCase()));
  const copies = new Map<string, ChatItem>();
  for (const inbox of reads) {
    if (!inbox) continue;
    for (const thread of inbox.threads) {
      const messageKey = thread.latestMessageKey ?? mailHash(`${inbox.account}\n${thread.latestMessageId}`);
      const urgent = !!thread.urgent && !replies.has(messageKey) && !own.has(mailbox(thread.from) ?? "");
      if (!urgent && (!sameAccount(inbox.account, support.account) || !thread.inInbox)) continue;
      const previous = copies.get(messageKey);
      if (previous) {
        previous.mail!.urgent ||= urgent;
        continue;
      }
      copies.set(messageKey, {
        id: mailHash(`email\n${inbox.account}\n${thread.id}`),
        place: { name: thread.subject.slice(0, 160).trim() || "(No subject)", kind: "thread" },
        from: thread.from.slice(0, 120).trim() || "Unknown sender", at: thread.updatedAt,
        count: 1, unread: thread.unread, mention: true, text: (thread.body ?? "").slice(0, CHAT_TEXT_LIMIT),
        mail: { account: inbox.account, thread: thread.id, messageKey, urgent },
      });
    }
  }
  const items = [...copies.values()].sort((a, b) => Number(b.mail!.urgent) - Number(a.mail!.urgent) || b.at - a.at);
  const complete = reads.every(inbox => inbox?.state === "ok") && items.length <= CHAT_ITEMS_LIMIT;
  return {
    source: "support", emailQueue: true, owner: support.owner, observedAt: now,
    state: complete ? "ok" : "incomplete",
    items: items.slice(0, CHAT_ITEMS_LIMIT),
  };
}

export function startMailQueue(config: Config, site: Site) {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try {
      const response = await fetch(new URL("/api/collector/duties", site.endpoint), {
        headers: site.headers, redirect: "error", signal: AbortSignal.timeout(20_000),
      });
      if (response.ok && (await response.json() as { duties?: unknown }).duties === true)
        await postChatRead(site, await readMailQueue(config));
    } catch {
      // Preserve the last read. Its age marks a stopped or unreachable watcher.
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), 30_000);
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

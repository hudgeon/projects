import type { ChatList, ChatView } from "./chat-model";
import type { Inbox, InboxThread } from "./inbox-model";
import { freshness } from "./model";
// Only a fresh, complete, visible support read can replace a personal copy.
// Subjects, senders, amounts and mailbox-local IDs are never identity evidence.
export function supportCopy(thread: InboxThread, list: ChatList | undefined, now: number): ChatView | undefined {
  if (!thread.latestMessageKey || !list?.reads.some(r => r.source === "support" && r.state === "ok" && !freshness(r.observedAt, now))) return undefined;
  return list.items.find(i => i.source === "support" && i.support?.messageKeys.includes(thread.latestMessageKey!));
}
export function withoutSupportCopies(inbox: Inbox, list: ChatList | undefined, now: number): Inbox {
  return { ...inbox, threads: inbox.threads.filter(t => !supportCopy(t, list, now)) };
}

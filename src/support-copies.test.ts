import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutSupportCopies } from "./support-copies";
import type { ChatList } from "./chat-model";
import type { Inbox } from "./inbox-model";
const now = Date.now(), key = "a".repeat(64);
const inbox: Inbox = { account: "owner@example.com", observedAt: now, state: "ok", threads: [
  { id: "1111111111111111", latestMessageId: "2222222222222222", latestMessageKey: key, subject: "Export", from: "Customer", updatedAt: now, lastSentByMe: false, unread: true, messages: 1 },
  { id: "3333333333333333", latestMessageId: "4444444444444444", latestMessageKey: "b".repeat(64), subject: "Export", from: "Customer", updatedAt: now, lastSentByMe: false, unread: true, messages: 1 },
] };
const support: ChatList = { reads: [{ source: "support", observedAt: now, state: "ok", host: "studio" }], items: [
  { key: "c".repeat(64), id: "d".repeat(64), source: "support", owner: inbox.account, state: "action", place: { name: "Export", kind: "thread" }, from: "Customer", at: now, count: 1, unread: true, mention: true, preview: "Export problem", support: { account: "help@example.com", thread: "5555555555555555", messageKeys: [key], acknowledgment: "sent" } },
] };
test("cc copies collapse across different Gmail IDs; identical subjects with distinct evidence stay distinct", () => {
  assert.deepEqual(withoutSupportCopies(inbox, support, now).threads.map(t => t.id), ["3333333333333333"]);
  assert.equal(inbox.threads.length, 2, "no mailbox data is mutated");
  assert.equal(withoutSupportCopies({ ...inbox, threads: inbox.threads.map(t => ({ ...t, latestMessageKey: undefined })) }, support, now).threads.length, 2);
});
test("stale, incomplete or missing support coverage cannot hide a personal copy", () => {
  for (const state of ["unavailable", "incomplete", "signed-out"] as const) assert.equal(withoutSupportCopies(inbox, { ...support, reads: [{ ...support.reads[0], state }] }, now).threads.length, 2);
  assert.equal(withoutSupportCopies(inbox, support, now + 10 * 60_000).threads.length, 2);
  assert.equal(withoutSupportCopies(inbox, undefined, now).threads.length, 2);
  assert.equal(withoutSupportCopies(inbox, { ...support, items: [] }, now).threads.length, 2);
});

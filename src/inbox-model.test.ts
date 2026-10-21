import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countsOnly,
  currentInbox,
  currentInboxes,
  currentInboxPlaceholders,
  inboxPlaceholdersSchema,
  inboxQueue,
  inboxWithThread,
  snapshotInboxes,
  type Inbox,
  type InboxAction,
} from "./inbox-model";

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Subject ${id}`,
  from: "Sender <sender@example.com>",
  latestMessageId: id.replace(/01$/, "02"),
  updatedAt: 100,
  inInbox: true,
  lastSentByMe: false,
  unread: true,
  messages: 1,
  body: "Private text",
  unsubscribe: { oneClick: true, url: "https://list.example.com/u", mailto: null },
  ...extra,
});
const inbox = (account: string, observedAt: number, threads: Inbox["threads"]): Inbox => ({
  account,
  observedAt,
  state: "ok",
  threads,
});
test("each person's inbox is the newest read of their account; an older collector's one inbox is its owner's", () => {
  const owner1 = inbox("owner@example.com", 100, [thread("aaaaaaaaaa01")]);
  const owner2 = inbox("Owner@example.com", 200, [thread("aaaaaaaaaa01")]);
  const matt = inbox("matt@example.com", 150, [thread("cccccccccc01")]);
  const snapshots = [{ inboxes: [owner1, matt] }, { inbox: owner2 }];
  assert.deepEqual(snapshotInboxes(snapshots[0]), [owner1, matt]);
  assert.deepEqual(snapshotInboxes(snapshots[1]), [owner2]);
  assert.deepEqual(snapshotInboxes({}), []);
  assert.deepEqual(currentInboxes(snapshots), [owner2, matt]);
  assert.equal(currentInbox(snapshots, "owner@example.com"), owner2);
  assert.equal(currentInbox(snapshots, "MATT@example.com"), matt);
  assert.equal(currentInbox(snapshots, "sam@example.com"), undefined);
  assert.equal(currentInbox([snapshots[1]]), owner2, "without an address, the newest inbox of all");
  assert.equal(inboxWithThread(snapshots, "cccccccccc01"), matt);
  assert.equal(inboxWithThread(snapshots, "dddddddddd01"), undefined);
});
test("what everyone sees of another person's inbox counts its threads without showing them", () => {
  const full = inbox("matt@example.com", 150, [
    thread("cccccccccc01"),
    thread("dddddddddd01", { reference: true, inInbox: false, updatedAt: 50 }),
  ]);
  const shared = countsOnly(full);
  assert.deepEqual(
    shared.threads.map((t) => [t.id, t.subject, t.from, t.body, t.unsubscribe, t.inInbox, t.reference, t.latestMessageId, t.updatedAt]),
    [
      ["cccccccccc01", "", "", undefined, undefined, true, undefined, "cccccccccc02", 100],
      ["dddddddddd01", "", "", undefined, undefined, false, true, "dddddddddd02", 50],
    ],
  );
  assert.doesNotMatch(JSON.stringify(shared), /Subject|Sender|Private text|list\.example/);
  const archive: InboxAction = { threadId: "cccccccccc01", account: "owner@example.com", action: "archive", requestedAt: 500, state: "queued", message: null, updatedAt: 500 };
  // The shared copy queues exactly as the full inbox does, so counts agree.
  assert.deepEqual(
    inboxQueue(shared, [], [], [{ ...archive, account: "matt@example.com" }]).map((i) => [i.thread.id, i.state]),
    inboxQueue(full, [], [], [{ ...archive, account: "matt@example.com" }]).map((i) => [i.thread.id, i.state]),
  );
  // Another inbox's request never clears this one's thread; one from before
  // accounts were recorded is applied to the inbox it names by thread.
  assert.equal(inboxQueue(full, [], [], [archive])[0].state, "todo");
  assert.equal(inboxQueue(full, [], [], [{ ...archive, account: "MATT@example.com" }])[0].state, "clearing");
  assert.equal(inboxQueue(full, [], [], [{ ...archive, account: undefined }])[0].state, "clearing");
});

test("placeholder duty scans replace the list, preserve their check time and never become inboxes", () => {
  const older = { host: "first", inboxPlaceholders: { names: ["Ada"], observedAt: 100 } };
  const newer = { host: "second", inboxPlaceholders: { names: ["Sam", "Lee"], observedAt: 200 } };
  assert.equal(currentInboxPlaceholders([newer, older, {}]), newer);
  assert.equal(currentInboxPlaceholders([older, newer]), newer);
  assert.deepEqual(currentInboxes([older, newer] as object[]), []);
  const removed = { inboxPlaceholders: { names: [], observedAt: 300 } };
  assert.equal(currentInboxPlaceholders([older, removed, newer]), removed);
  assert.equal(currentInboxPlaceholders([{}]), undefined);
  assert.equal(inboxPlaceholdersSchema.safeParse(newer.inboxPlaceholders).success, true);
  assert.equal(inboxPlaceholdersSchema.safeParse({ names: ["Ada", "ada"], observedAt: 100 }).success, false);
  assert.equal(inboxPlaceholdersSchema.safeParse({ names: ["ada@example.com"], observedAt: 100 }).success, false);
});

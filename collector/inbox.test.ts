import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInbox } from "./inbox";
import { inboxRows, inboxWithThread } from "../src/inbox-model";
import { assessmentSourceGap } from "../src/work-assessment";
import { issue } from "../tests/work-fixtures";

const account = "owner@example.com";
const conversation = "aaaaaaaaaa000001";
const sent = "aaaaaaaaaa000002";
const reply = "aaaaaaaaaa000003";
const message = (id: string, labels: string[], at: string) => ({
  id,
  internalDate: at,
  labelIds: labels,
  payload: { headers: [{ name: "Subject", value: "Letters" }] },
});
// Gmail as the API sees it: one archived conversation holding the two Sent
// messages a work issue may link by their own IDs.
function gmail(over: { messages?: (id: string) => object } = {}) {
  const calls: { kind: string; params: Record<string, unknown> }[] = [];
  const run = async (args: string[]) => {
    const params = JSON.parse(args.at(-1)!);
    const kind = args.slice(2, 4).join(".");
    calls.push({ kind, params });
    if (args.includes("getProfile")) return JSON.stringify({ emailAddress: account });
    if (kind === "labels.list") return JSON.stringify({ labels: [] });
    if (kind === "threads.list") return JSON.stringify({ threads: [] });
    if (kind === "threads.get") {
      if (params.id !== conversation) throw Error("Requested entity was not found.");
      return JSON.stringify({
        id: conversation,
        historyId: "77",
        messages: [
          message(conversation, ["SENT"], "100"),
          message(sent, ["SENT"], "200"),
          message(reply, ["SENT"], "300"),
        ],
      });
    }
    if (kind === "messages.get") {
      if (over.messages) return JSON.stringify(over.messages(params.id));
      if ([conversation, sent, reply].includes(params.id))
        return JSON.stringify({ threadId: conversation });
      throw Error("Requested entity was not found.");
    }
    throw Error(`Unexpected ${kind}`);
  };
  return { run, calls };
}

test("a work link to one message reads its conversation once, keeps the linked IDs on it and leaves the inbox complete", async () => {
  const { run, calls } = gmail();
  const read = await readInbox(account, run, 1000, undefined, [sent, conversation, reply]);
  assert.equal(read.state, "ok");
  assert.equal(read.threads.length, 1);
  assert.equal(read.threads[0].id, conversation);
  assert.equal(read.threads[0].latestMessageId, reply);
  assert.deepEqual(read.threads[0].linkedAs, [sent, reply]);
  // Only the conversation's ID is asked of a message; no text is read for an
  // archived conversation.
  const lookups = calls.filter((c) => c.kind === "messages.get");
  assert.deepEqual(lookups.map((c) => [c.params.id, c.params.format, c.params.fields]), [
    [sent, "minimal", "threadId"],
    [reply, "minimal", "threadId"],
  ]);
  assert.equal(calls.filter((c) => c.kind === "threads.get" && c.params.id === conversation).length, 1);
});

test("a message link whose conversation is not otherwise linked reads that conversation", async () => {
  const { run } = gmail();
  const read = await readInbox(account, run, 1000, undefined, [sent]);
  assert.equal(read.state, "ok");
  assert.deepEqual(read.threads.map((t) => [t.id, t.inInbox, t.linkedAs]), [[conversation, false, [sent]]]);
});

test("a link Gmail knows neither as a conversation nor as a message stays a failed read", async () => {
  const gone = "aaaaaaaaaa00dead";
  assert.equal((await readInbox(account, gmail().run, 1000, undefined, [gone])).state, "incomplete");
  // A conversation whose own read failed is never passed off as resolved.
  const flaky = gmail({ messages: (id) => ({ threadId: id }) });
  assert.equal((await readInbox(account, flaky.run, 1000, undefined, [gone])).state, "incomplete");
  // A listed inbox thread that fails is not looked up as a message.
  const listed = gmail();
  const run = async (args: string[]) =>
    args.slice(2, 4).join(".") === "threads.list"
      ? JSON.stringify({ threads: [{ id: gone, historyId: "1" }] })
      : listed.run(args);
  assert.equal((await readInbox(account, run, 1000)).state, "incomplete");
  assert.ok(!listed.calls.some((c) => c.kind === "messages.get"));
});

test("linked message IDs are not cached with the conversation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "inbox-"));
  try {
    await readInbox(account, gmail().run, 1000, home, [sent]);
    const cache = await readFile(path.join(home, ".local/share/project-overview/inbox-cache.json"), "utf8");
    assert.ok(cache.includes(conversation));
    assert.ok(!cache.includes(sent));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("work links by message ID find their conversation in the inbox and in assessments", async () => {
  const { run } = gmail();
  const inbox = await readInbox(account, run, 1000, undefined, [sent]);
  const linked = issue(7, {
    emailLinks: [{ threadId: sent, url: `https://mail.google.com/mail/u/0/#all/${sent}`, reviewedMessageId: reply }],
  });
  const [row] = inboxRows(inbox, [linked]);
  assert.equal(row.linked.length, 1);
  assert.equal(row.reviewed, true);
  const snapshot = { collectedAt: 1000, inboxes: [inbox] };
  assert.equal(inboxWithThread([snapshot], sent)?.account, account);
  assert.equal(
    assessmentSourceGap(linked, [snapshot as never], 2000, 2000),
    false,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatReadSchema, type ChatItem } from "../src/chat-model";
import { applyEdit, applyMessage, FYI_MS, KEEP_MS, mentioned, plainText, prune, slackRead, type Conversation } from "./slack";

const person = { email: "owner@example.com", userId: "U1", url: "https://team.example.slack.com/" };
const dm: Conversation = { id: "D1", kind: "im", name: "Sam" };
const ops: Conversation = { id: "C1", kind: "channel", name: "ops" };
const shared: Conversation = { id: "C2", kind: "channel", name: "rollout", shared: true, org: "Customer" };
const at = (seconds: number) => `${seconds}.000100`;

test("a direct message needs its person until they reply there", () => {
  const items = new Map<string, ChatItem>();
  assert.ok(applyMessage(items, person, dm, { user: "U2", ts: at(1000), text: "Got a minute?" }, "Sam", "Got a minute?"));
  assert.ok(applyMessage(items, person, dm, { user: "U2", ts: at(1010), text: "It's about Friday" }, "Sam", "It's about Friday"));
  const item = items.get("D1")!;
  assert.deepEqual(
    [item.place, item.from, item.at, item.count, item.unread, item.mention, item.text],
    [{ name: "Sam", kind: "direct", url: "https://team.example.slack.com/archives/D1/p1010000100" }, "Sam", 1010000, 2, true, true, "It's about Friday"],
  );
  assert.equal(applyMessage(items, person, dm, { user: "U2", ts: at(900), text: "older" }, "Sam", "older"), false, "a late retry of an older message changes nothing");
  assert.ok(applyMessage(items, person, dm, { user: "U1", ts: at(1020), text: "Sure" }, "Owner", "Sure"));
  assert.equal(items.size, 0, "their reply settles it");
});

test("a channel is shown only where it names the person, or is shared with another organisation", () => {
  const items = new Map<string, ChatItem>();
  assert.equal(applyMessage(items, person, ops, { user: "U2", ts: at(1), text: "Deploying now" }, "Jo", "Deploying now"), false, "internal chatter isn't theirs");
  assert.ok(applyMessage(items, person, ops, { user: "U2", ts: at(2), text: "<@U1> can you check?" }, "Jo", "@Owner can you check?"));
  assert.deepEqual([items.get("C1")?.place.name, items.get("C1")?.place.kind, items.get("C1")?.mention], ["#ops", "channel", true]);
  assert.ok(applyMessage(items, person, ops, { user: "U3", ts: at(3), text: "Also this" }, "Kim", "Also this"), "once named, the place stays theirs until they reply");
  assert.equal(items.get("C1")?.mention, true);
  assert.ok(applyMessage(items, person, shared, { user: "U9", ts: at(4), text: "Who joins Friday?" }, "Alex", "Who joins Friday?"));
  const fyi = items.get("C2")!;
  assert.deepEqual([fyi.place, fyi.mention], [{ org: "Customer", name: "#rollout", kind: "channel", shared: true, url: "https://team.example.slack.com/archives/C2/p4000100" }, false]);
  // A thread reply naming the person is its own item, linked to the thread.
  assert.ok(applyMessage(items, person, ops, { user: "U2", ts: at(5), thread_ts: at(2), text: "<@U1|owner> ping" }, "Jo", "@Owner ping"));
  const thread = items.get(`C1:${at(2)}`)!;
  assert.deepEqual([thread.place.kind, thread.place.url], ["thread", `https://team.example.slack.com/archives/C1/p5000100?thread_ts=${at(2)}&cid=C1`]);
});

test("an edit changes the latest message's text, and lapsed items go", () => {
  const items = new Map<string, ChatItem>();
  applyMessage(items, person, dm, { user: "U2", ts: at(10), text: "Teh draft" }, "Sam", "Teh draft");
  assert.ok(applyEdit(items, dm, { user: "U2", ts: at(10), text: "The draft" }, "The draft"));
  assert.equal(items.get("D1")?.text, "The draft");
  assert.equal(applyEdit(items, dm, { user: "U2", ts: at(9), text: "x" }, "x"), false, "only the latest message");
  applyMessage(items, person, shared, { user: "U9", ts: at(10), text: "FYI" }, "Alex", "FYI");
  assert.equal(prune(items, 10_000 + FYI_MS - 1), false);
  assert.ok(prune(items, 10_100 + FYI_MS), "information lapses after a day");
  assert.deepEqual([...items.keys()], ["D1"]);
  assert.ok(prune(items, 10_100 + KEEP_MS), "anything lapses after three days");
  assert.equal(items.size, 0);
});

test("Slack's markup reads as plain text", () => {
  const names = new Map([["U2", "Jo"]]);
  const text = "<@U2> see <#C1|ops> and <https://example.com/a?b=1|the doc> or <https://example.com> &amp; tell <!here> &lt;now&gt; <@U9|kim> <mailto:a@example.com|a@example.com>";
  assert.deepEqual(mentioned(text), ["U2", "U9"]);
  assert.equal(
    plainText(text, (user) => names.get(user)),
    "@Jo see #ops and the doc (https://example.com/a?b=1) or https://example.com & tell @here <now> @kim a@example.com",
  );
});

test("a person's read is bounded, newest first, and valid", () => {
  const items = new Map<string, ChatItem>();
  for (let i = 0; i < 250; i++)
    applyMessage(items, person, { id: `D${i}`, kind: "im", name: `Person ${i}` }, { user: "U2", ts: at(i + 1), text: "hi" }, "Someone", "hi");
  const read = slackRead("owner@example.com", items, 999_999, "ok");
  assert.equal(read.items.length, 200);
  assert.equal(read.items[0].id, "D249");
  assert.ok(chatReadSchema.safeParse(read).success);
  assert.deepEqual(slackRead("owner@example.com", new Map(), 1, "signed-out", "Slack sign-in expired or was revoked").problem, "Slack sign-in expired or was revoked");
});

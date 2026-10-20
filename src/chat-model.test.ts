import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_TEXT_LIMIT,
  chatReadSchema,
  chatState,
  kindLabel,
  placeTitle,
  sharedLabel,
  type ChatMark,
} from "./chat-model";

const owner = "owner@example.com",
  colleague = "colleague@example.com";
const item = { at: 100, mention: false, unread: true };
const mark = (m: Partial<ChatMark>): ChatMark => ({ holder: null, handedBy: null, handedAt: null, doneAt: null, ...m });

test("until the typed check, a direct message or a mention needs its person and anything else unread is for information", () => {
  assert.equal(chatState({ ...item, mention: true }, owner, owner), "action");
  assert.equal(chatState(item, owner, owner), "fyi");
  assert.equal(chatState({ ...item, unread: false }, owner, owner), null, "read in its app and not for them: gone");
  assert.equal(chatState({ ...item, mention: true }, owner, colleague), null, "nobody sees another person's items");
  assert.equal(chatState({ ...item, mention: true }, "Owner@Example.com", owner), "action", "addresses compare without case");
});

test("Done and Hand over hold until a newer message arrives", () => {
  const needs = { ...item, mention: true };
  assert.equal(chatState(needs, owner, owner, mark({ doneAt: 100 })), "done");
  assert.equal(chatState({ ...needs, at: 101 }, owner, owner, mark({ doneAt: 100 })), "action", "a newer message reopens it");
  const handed = mark({ holder: colleague, handedBy: owner, handedAt: 100 });
  assert.equal(chatState(needs, owner, colleague, handed), "action", "handed over, it needs the colleague");
  assert.equal(chatState(item, owner, colleague, handed), "action", "even if it was only for information");
  assert.equal(chatState(needs, owner, owner, handed), "handed");
  assert.equal(chatState(needs, owner, colleague, { ...handed, doneAt: 100 }), "done");
  assert.equal(chatState({ ...needs, at: 101 }, owner, colleague, handed), null, "a newer message goes back to its owner");
  assert.equal(chatState({ ...needs, at: 101 }, owner, owner, handed), "action");
});

test("every row leads with where it was said", () => {
  assert.equal(placeTitle({ org: "Customer", name: "Finance transformation", kind: "group" }), "Customer · Finance transformation");
  assert.equal(placeTitle({ org: "Customer", name: "#rollout", kind: "channel", shared: true }), "#rollout");
  assert.equal(sharedLabel({ org: "Customer", name: "#rollout", kind: "channel", shared: true }), "shared with Customer");
  assert.equal(sharedLabel({ name: "#ops", kind: "channel" }), null);
  assert.equal(placeTitle({ name: "#ops", kind: "channel" }), "#ops");
  assert.equal(kindLabel("slack", { name: "Sam", kind: "direct" }), "direct message");
  assert.equal(kindLabel("teams", { name: "Sam", kind: "direct" }), "1:1 chat");
  assert.equal(kindLabel("teams", { name: "Planning", kind: "group" }), "group chat");
  assert.equal(kindLabel("slack", { name: "#ops", kind: "thread" }), "thread");
});

test("a read is bounded and opens places only by web links", () => {
  const read = (place: object, text = "Hello") => ({
    source: "slack",
    owner,
    observedAt: 1,
    state: "ok",
    items: [{ id: "C1:1.0", place: { name: "#ops", kind: "channel", ...place }, from: "Sam", at: 1, count: 1, unread: true, mention: false, text }],
  });
  assert.ok(chatReadSchema.safeParse(read({ url: "https://example.slack.com/archives/C1" })).success);
  assert.ok(!chatReadSchema.safeParse(read({ url: "javascript:alert(1)" })).success);
  assert.ok(!chatReadSchema.safeParse(read({ url: "slack://channel?id=C1" })).success);
  assert.ok(!chatReadSchema.safeParse(read({}, "x".repeat(CHAT_TEXT_LIMIT + 1))).success);
  assert.ok(!chatReadSchema.safeParse(read({ name: "" })).success);
  assert.ok(!chatReadSchema.safeParse({ ...read({}), owner: "not an address" }).success);
});

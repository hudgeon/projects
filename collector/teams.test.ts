import { test } from "node:test";
import assert from "node:assert/strict";
import { chatReadSchema, type ChatItem } from "../src/chat-model";
import { applyTeams, FYI_MS, KEEP_MS, prune, teamsRead, type TeamsRow } from "./teams";
import { parseRow } from "./teams-chrome";

const row = (over: Partial<TeamsRow> = {}): TeamsRow => ({
  key: "19:aaa",
  name: "Sam Rivers",
  kind: "direct",
  from: "Sam Rivers",
  preview: "Could you send the cost sheet",
  unread: true,
  mention: false,
  ...over,
});

test("a raw Teams row's accessible name becomes a chat row", () => {
  const raw = (over: object) => ({ id: "19:1", label: "", unread: false, mention: false, channel: false, group: false, ...over });
  assert.deepEqual(parseRow(raw({ label: "Sam Rivers, Sam Rivers: Could you send the cost sheet, 2 minutes ago, unread", unread: true })), {
    key: "19:1", name: "Sam Rivers", kind: "direct", url: undefined, from: "Sam Rivers", preview: "Could you send the cost sheet", unread: true, mention: false,
  });
  // A channel row keeps its team/channel name and is marked a channel.
  assert.deepEqual(parseRow(raw({ label: "UK Rollout, Alex: steering call moved to 14:00", channel: true, href: "https://teams.microsoft.com/l/channel/19:abc" })), {
    key: "19:1", name: "UK Rollout", kind: "channel", url: "https://teams.microsoft.com/l/channel/19:abc", from: "Alex", preview: "steering call moved to 14:00", unread: false, mention: false,
  });
  // A group chat is told from the row (avatars/location), not the name text.
  assert.equal(parseRow(raw({ label: "Sam, Priya and Jo", group: true }))?.kind, "group");
  assert.equal(parseRow(raw({ label: "" })), null);
});

test("a 1:1 or group chat needs its person until they reply; a channel only when it mentions them", () => {
  const items = new Map<string, ChatItem>();
  const direct = applyTeams(items, [row()], 1000);
  assert.deepEqual([direct.get("19:aaa")?.mention, direct.get("19:aaa")?.text], [true, "Could you send the cost sheet"]);
  // The person's own latest message settles the chat.
  assert.equal(applyTeams(direct, [row({ from: "You" })], 2000).size, 0);
  // A channel that only sits unread is information; a mention needs them.
  const chan = applyTeams(new Map(), [row({ key: "19:c", kind: "channel", name: "UK Rollout", from: "Alex", mention: false })], 1000);
  assert.deepEqual([chan.get("19:c")?.mention, chan.get("19:c")?.unread], [false, true]);
  assert.equal(applyTeams(new Map(), [row({ key: "19:c", kind: "channel", from: "Alex", unread: false })], 1000).size, 0, "read channel, no mention: not theirs");
  assert.equal(applyTeams(new Map(), [row({ key: "19:c", kind: "channel", from: "Alex", mention: true })], 1000).get("19:c")?.mention, true);
});

test("the same latest message keeps its time; a changed preview is new; a mention stays sticky", () => {
  let items = applyTeams(new Map(), [row()], 1000);
  items = applyTeams(items, [row({ unread: false })], 5000);
  assert.equal(items.get("19:aaa")?.at, 1000, "same preview keeps first-seen time");
  items = applyTeams(items, [row({ preview: "Actually, by Thursday", unread: true })], 9000);
  assert.equal(items.get("19:aaa")?.at, 9000, "a new message resets the time");
  // A channel the person was mentioned in stays theirs on a later non-mention message.
  let chan = applyTeams(new Map(), [row({ key: "19:c", kind: "channel", from: "Alex", mention: true })], 1000);
  chan = applyTeams(chan, [row({ key: "19:c", kind: "channel", from: "Jo", mention: false, preview: "another note" })], 2000);
  assert.equal(chan.get("19:c")?.mention, true);
});

test("information lapses after a day, a chat after three days, and a read is bounded and valid", () => {
  const items = applyTeams(new Map(), [row()], 1000); // a mention (direct)
  const fyi = applyTeams(new Map(), [row({ key: "19:c", kind: "channel", from: "Alex" })], 1000);
  for (const [k, v] of fyi) items.set(k, v);
  assert.equal(prune(items, 1000 + FYI_MS - 1), false);
  assert.equal(prune(items, 1000 + FYI_MS + 1), true, "the channel FYI lapses after a day");
  assert.deepEqual([...items.keys()], ["19:aaa"]);
  assert.equal(prune(items, 1000 + KEEP_MS + 1), true, "the chat lapses after three days");
  const read = teamsRead("owner@example.com", new Map(), 5, "signed-out", "Teams needs you to sign in again on this machine");
  assert.equal(read.source, "teams");
  assert.ok(chatReadSchema.safeParse(read).success);
});

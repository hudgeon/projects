import { test } from "node:test";
import assert from "node:assert/strict";
import { chatReadSchema } from "../src/chat-model";
import { configSchema } from "./config";
import { applyTeams, FYI_MS, KEEP_MS, prune, teamsRead, teamsState, type TeamsRow } from "./teams";
import { EXTRACT, parseRow, type RawRow } from "./teams-chrome";

// Thread ids as Teams puts them in its tree's element ids.
const CHANNEL = "19:abcDEF123channelxyz@thread.tacv2";
const GROUP = "19:0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c@thread.v2";
const ONE = "19:aaaa1111-bbbb-2222-cccc-3333dddd4444_eeee5555-ffff-6666-aaaa-7777bbbb8888@unq.gbl.spaces";
const raw = (over: Partial<RawRow>): RawRow => ({ id: CHANNEL, name: "Support", detail: "", favorite: false, unread: false, mention: false, ...over });
const row = (over: Partial<TeamsRow> = {}): TeamsRow => ({ key: ONE, name: "Sam Rivers", kind: "direct", from: "Sam Rivers", preview: "Could you send the cost sheet", unread: true, mention: false, ...over });

test("a Teams tree row becomes a chat row, its kind from the thread id", () => {
  // A 1:1 chat: its detail line is the preview, then a time.
  assert.deepEqual(parseRow(raw({ id: ONE, name: "Sam Rivers", detail: "Could you send the cost sheet · 9:42 AM", unread: true })), {
    key: ONE, name: "Sam Rivers", kind: "direct", url: "https://teams.cloud.microsoft/", from: "Sam Rivers", preview: "Could you send the cost sheet", unread: true, mention: false, favorite: false,
  });
  // A group chat names the sender; "You:" means the person wrote last.
  const group = parseRow(raw({ id: GROUP, name: "Rollout crew", detail: "Priya: Moved to Thursday · Yesterday" }));
  assert.deepEqual([group?.kind, group?.from, group?.preview], ["group", "Priya", "Moved to Thursday"]);
  assert.equal(parseRow(raw({ id: GROUP, name: "Rollout crew", detail: "You: Thanks all · Mon" }))?.from, "You");
  // A channel shows no preview in the list; a favourite says so.
  const channel = parseRow(raw({ name: "Support", favorite: true, unread: true }));
  assert.deepEqual([channel?.kind, channel?.from, channel?.preview, channel?.favorite], ["channel", "New posts", "", true]);
  assert.equal(parseRow(raw({ name: "  " })), null);
  // The in-page script is a string: it must at least compile.
  assert.doesNotThrow(() => new Function(EXTRACT));
});

test("a chat needs its person until they reply; a channel when it mentions them or is a favourite, while unread", () => {
  const direct = applyTeams(new Map(), [row()], 1000);
  assert.equal(direct.get(ONE)?.mention, true);
  assert.equal(applyTeams(direct, [row({ unread: false })], 2000).get(ONE)?.mention, true, "read but not answered: still theirs");
  assert.equal(applyTeams(direct, [row({ from: "You" })], 3000).size, 0, "their reply settles it");
  const ch = (over: Partial<TeamsRow>) => row({ key: CHANNEL, kind: "channel", name: "Support", from: "New posts", preview: "", ...over });
  const fyi = applyTeams(new Map(), [ch({ unread: true })], 1000).get(CHANNEL);
  assert.deepEqual([fyi?.mention, fyi?.unread], [false, true], "an unread channel is information");
  assert.equal(applyTeams(new Map(), [ch({ unread: true, favorite: true })], 1000).get(CHANNEL)?.mention, true, "an unread favourite needs them");
  assert.equal(applyTeams(new Map(), [ch({ unread: true, mention: true })], 1000).get(CHANNEL)?.mention, true, "an @mention needs them");
  // Once read in Teams, a channel clears: Teams' list carries the state.
  const fav = applyTeams(new Map(), [ch({ unread: true, favorite: true })], 1000);
  assert.equal(applyTeams(fav, [ch({ unread: false, favorite: true })], 2000).size, 0);
});

test("the same message keeps its first-seen time; a new preview or a chat turning unread again is new", () => {
  let items = applyTeams(new Map(), [row()], 1000);
  items = applyTeams(items, [row()], 5000);
  assert.equal(items.get(ONE)?.at, 1000, "same message keeps its time");
  items = applyTeams(items, [row({ unread: false })], 6000);
  assert.equal(items.get(ONE)?.at, 1000, "reading it changes nothing");
  items = applyTeams(items, [row({ unread: true })], 7000);
  assert.equal(items.get(ONE)?.at, 7000, "unread again: a new message under the same preview");
  items = applyTeams(items, [row({ preview: "Actually, by Thursday" })], 9000);
  assert.equal(items.get(ONE)?.at, 9000, "a new preview is a new message");
});

test("information lapses after a day, a chat after three days, and a read is bounded and valid", () => {
  const items = applyTeams(new Map(), [row()], 1000);
  for (const [k, v] of applyTeams(new Map(), [row({ key: CHANNEL, kind: "channel", from: "New posts", preview: "" })], 1000)) items.set(k, v);
  assert.equal(prune(items, 1000 + FYI_MS - 1), false);
  assert.equal(prune(items, 1000 + FYI_MS + 1), true, "the channel lapses after a day");
  assert.deepEqual([...items.keys()], [ONE]);
  assert.equal(prune(items, 1000 + KEEP_MS + 1), true, "the chat lapses after three days");
  const read = teamsRead("owner@example.com", new Map(), 5, "signed-out", "Teams needs you to sign in again on this machine");
  assert.equal(read.source, "teams");
  assert.ok(chatReadSchema.safeParse(read).success);
  // Items keyed by real thread ids are a read the Worker accepts.
  const kinds = [row(), row({ key: GROUP, kind: "group", from: "Priya" }), row({ key: CHANNEL, kind: "channel", from: "New posts", preview: "", favorite: true })];
  const full = teamsRead("owner@example.com", applyTeams(new Map(), kinds, Date.now()), Date.now());
  assert.equal(full.items.length, 3);
  assert.ok(chatReadSchema.safeParse(full).success);
});

test("one read covers a person's Teams organisations, one profile each: a needed sign-in shows, an unreadable profile makes it incomplete", () => {
  assert.deepEqual(teamsState([{ state: "ok" }, { state: "ok" }]), { state: "ok" });
  assert.equal(teamsState([{ state: "ok" }, { state: "unavailable", problem: "Teams' browser could not be reached on this machine" }]).state, "incomplete");
  assert.deepEqual(teamsState([{ state: "unavailable", problem: "first" }, { state: "unavailable", problem: "second" }]), { state: "unavailable", problem: "first" });
  assert.deepEqual(teamsState([{ state: "ok" }, { state: "signed-out", problem: "sign in" }]), { state: "signed-out", problem: "sign in" });
  // A person may connect a profile per organisation; each profile is listed once.
  const base = { host: "studio", root: "/repos", home: "/Users/owner" };
  const first = { account: "owner@example.com", profileDir: "/Users/owner/Library/Projects-Teams" };
  const second = { account: "owner@example.com", profileDir: "/Users/owner/Library/Projects-Teams-2" };
  assert.equal(configSchema.safeParse({ ...base, teams: [first, second] }).success, true);
  assert.equal(configSchema.safeParse({ ...base, teams: [first, { ...first, account: "colleague@example.com" }] }).success, false);
  assert.equal(configSchema.safeParse({ ...base, teams: [first, { ...second, profileDir: first.profileDir.toLowerCase() }] }).success, false, "one folder, two spellings");
});

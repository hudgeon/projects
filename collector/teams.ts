// Microsoft Teams as the signed-in person sees it, read from the Teams web
// chat list on the machine (collector/teams-chrome.ts) — for someone with a
// Teams account in a customer's tenant but no API access to it. The reader
// only reads the list: it never opens a chat, so it never sends a read
// receipt or marks anything read. A chat keeps its latest message from
// someone else until the person replies there or it lapses; Done and Hand
// over are the Worker's. Nothing is ever posted to Teams.
import { createHash } from "node:crypto";
import { clip } from "../src/run-text";
import {
  CHAT_ITEMS_LIMIT,
  CHAT_TEXT_LIMIT,
  type ChatItem,
  type ChatPlace,
  type ChatRead,
} from "../src/chat-model";

// A channel message that only sits unread is information for a day; a chat or
// a mention is kept for three days after its latest message, like Slack.
export const FYI_MS = 86400_000;
export const KEEP_MS = 3 * 86400_000;

// One row of the Teams chat list, as the in-page script normalises it. The
// script reads the list only (collector/teams-chrome.ts); parsing the row
// into an item is here, so it is tested.
export type TeamsRow = {
  // Stable within the tenant: the chat or channel's id from its link.
  key: string;
  // The chat or channel name as shown.
  name: string;
  kind: "channel" | "group" | "direct";
  // The other organisation, for a channel shared with one.
  org?: string;
  // A deep link that opens the chat in Teams.
  url?: string;
  // Who sent the latest message, as shown ("You" when it was the person).
  from: string;
  // The one-line preview Teams shows in the list.
  preview: string;
  unread: boolean;
  // The row carries an @mention marker for the person.
  mention: boolean;
  // The person favourited this chat or channel in Teams.
  favorite?: boolean;
};

const https = (url?: string) => {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};
function place(row: TeamsRow): ChatPlace {
  return {
    ...(row.org ? { org: clip(row.org, 80) } : {}),
    name: clip(row.name, 160),
    kind: row.kind,
    ...(https(row.url) ? { url: https(row.url) } : {}),
  };
}
// What one poll of the chat list changes. A 1:1 or group chat is for the
// person until they reply, when the list shows its preview (which says who
// wrote last); a list without previews cannot say, so such a chat is theirs
// while it is unread. A channel needs them while it is unread and @mentions
// them or is one they favourited, and otherwise sits as information while it
// is unread. Teams' own list carries the state (bold while unread, the @ mark
// until read), so nothing is carried over from the last poll but the time a
// message was first seen. The person's own latest message settles the chat.
// A chat's preview is its text; a channel shows none in the list.
//
// `seen` remembers each previewed chat's latest message (a hash of sender and
// preview, never the text) between polls and is updated in place. A chat
// already read when first seen is history from before the reader looked, not
// a new message: it joins only when its message changes or it turns unread.
export function applyTeams(
  previous: Map<string, ChatItem>,
  rows: TeamsRow[],
  now: number,
  seen: Map<string, string> = new Map(),
): Map<string, ChatItem> {
  const items = new Map<string, ChatItem>();
  const listed = new Set<string>();
  for (const row of rows) {
    const prev = previous.get(row.key);
    const direct = row.kind !== "channel";
    const message = direct && row.preview.trim() ? createHash("sha256").update(`${row.from}\n${row.preview}`).digest("hex").slice(0, 16) : undefined;
    const known = seen.get(row.key);
    if (message) {
      seen.set(row.key, message);
      listed.add(row.key);
    }
    if (/^you$/i.test(row.from.trim())) continue; // the person replied; settled
    if (direct && !message && !row.unread) continue; // no preview: theirs while unread
    if (message && !prev && !row.unread && (known === undefined || known === message)) continue; // history
    const mention = direct || row.mention || (!!row.favorite && row.unread);
    // A read channel that needs nothing from the person is not theirs.
    if (!mention && !row.unread) continue;
    const text = clip(row.preview, CHAT_TEXT_LIMIT);
    // The same latest message keeps its first-seen time, so Done holds until a
    // newer one arrives; a changed preview, or a chat turning unread again, is
    // a new message.
    const same = prev && prev.text === text && prev.mention === mention && (prev.unread || !row.unread);
    const at = same ? prev.at : now;
    items.set(row.key, {
      id: row.key,
      place: place(row),
      from: clip(row.from, 120),
      at,
      count: 1,
      unread: row.unread,
      mention,
      text,
    });
  }
  for (const key of seen.keys()) if (!listed.has(key)) seen.delete(key);
  return items;
}
// What has lapsed: anything three days old, and information a day old.
export function prune(items: Map<string, ChatItem>, now: number) {
  let changed = false;
  for (const [id, item] of items)
    if (now - item.at > KEEP_MS || (!item.mention && now - item.at > FYI_MS))
      changed = items.delete(id) || changed;
  return changed;
}
// How one read across a person's profiles stands, one profile per Teams
// organisation: a profile that needs its sign-in makes the read say so, and one
// that could not be read beside one that could makes the read incomplete.
export function teamsState(parts: { state: ChatRead["state"]; problem?: string }[]): {
  state: ChatRead["state"];
  problem?: string;
} {
  const out = parts.find((p) => p.state === "signed-out");
  if (out) return { state: "signed-out", problem: out.problem };
  const failed = parts.filter((p) => p.state !== "ok");
  if (!failed.length) return { state: "ok" };
  if (failed.length < parts.length) return { state: "incomplete", problem: "One of the Teams organisations could not be read" };
  return { state: failed[0].state, problem: failed[0].problem };
}
export function teamsRead(
  email: string,
  items: Map<string, ChatItem>,
  now: number,
  state: ChatRead["state"] = "ok",
  problem?: string,
): ChatRead {
  return {
    source: "teams",
    owner: email,
    observedAt: now,
    state,
    ...(problem ? { problem } : {}),
    items: [...items.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, CHAT_ITEMS_LIMIT),
  };
}

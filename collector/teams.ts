// Microsoft Teams as the signed-in person sees it, read from the Teams web
// chat list on the machine (collector/teams-chrome.ts) — for someone with a
// Teams account in a customer's tenant but no API access to it. The reader
// only reads the list: it never opens a chat, so it never sends a read
// receipt or marks anything read. A chat keeps its latest message from
// someone else until the person replies there or it lapses; Done and Hand
// over are the Worker's. Nothing is ever posted to Teams.
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
// person; a channel is theirs only when it @mentions them, and otherwise sits
// as information while it is unread. The person's own latest message settles
// the chat. The latest message's preview is its text: the list is never
// opened, so there is nothing fuller to read without a read receipt.
export function applyTeams(
  previous: Map<string, ChatItem>,
  rows: TeamsRow[],
  now: number,
): Map<string, ChatItem> {
  const items = new Map<string, ChatItem>();
  for (const row of rows) {
    const prev = previous.get(row.key);
    if (/^you$/i.test(row.from.trim())) continue; // the person replied; settled
    const direct = row.kind !== "channel";
    const mention = direct || row.mention || !!prev?.mention;
    // A read channel message that never mentioned the person is not theirs.
    if (!mention && !row.unread) continue;
    const text = clip(row.preview, CHAT_TEXT_LIMIT);
    // The same latest message keeps its first-seen time, so Done holds until a
    // newer one arrives; a changed preview is a new message.
    const at = prev && prev.text === text && prev.mention === mention ? prev.at : now;
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

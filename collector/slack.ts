// Slack as each connected person sees it, from the events Slack sends this
// machine's chat watcher (collector/chats.ts): their direct and group
// messages, the channels and threads that mention them, and channels shared
// with other organisations. A place keeps its latest message from someone
// else until the person replies there or it lapses; Done and Hand over are
// the Worker's. Nothing is ever posted or marked read in Slack.
import { clip } from "../src/run-text";
import {
  CHAT_ITEMS_LIMIT,
  CHAT_TEXT_LIMIT,
  type ChatItem,
  type ChatPlace,
  type ChatRead,
} from "../src/chat-model";

const API = "https://slack.com/api/";
// Slack never says when a channel was read, so a shared channel's message
// that doesn't name the person is for information for a day.
export const FYI_MS = 86400_000;
// Anything lapses three days after its latest message.
export const KEEP_MS = 3 * 86400_000;
export class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter = 0,
  ) {
    super(code);
  }
}
// The errors that mean a person's sign-in no longer works.
export const signedOut = (error: unknown) =>
  error instanceof SlackError &&
  ["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"].includes(error.code);
export async function slackApi<T>(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) body.set(key, String(value));
  const response = await fetch(API + method, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429)
    throw new SlackError("ratelimited", Number(response.headers.get("retry-after") ?? 30));
  const result = (await response.json()) as { ok?: boolean; error?: string };
  if (!result.ok) throw new SlackError(result.error ?? `http_${response.status}`);
  return result as T;
}
// A conversation as the watcher knows it. A direct or group message is
// named after the other people in it.
export type Conversation = {
  id: string;
  kind: "im" | "mpim" | "channel";
  name: string;
  shared?: boolean;
  // Who a shared channel is shared with.
  org?: string;
};
export type SlackPerson = {
  email: string;
  userId: string;
  // The workspace's address, as auth.test gives it, for links.
  url: string;
};
// The parts of a message event that matter here, edits already unwrapped.
export type Message = { user: string; ts: string; thread_ts?: string; text: string };
// Who a message's text names, so their names can be looked up first.
export const mentioned = (text: string) =>
  [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
// Slack's markup as plain text: people and channels by name, links with
// their address.
export function plainText(text: string, name: (user: string) => string | undefined) {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, user: string, label?: string) => `@${name(user) ?? label ?? "someone"}`)
    .replace(/<#[CG][A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => `#${label || "a channel"}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label ?? "@a group")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
const millis = (ts: string) => Math.round(Number(ts) * 1000);
function place(person: SlackPerson, convo: Conversation, message: Message, thread?: string): ChatPlace {
  const link = /^https:\/\//.test(person.url)
    ? `${person.url.replace(/\/?$/, "/")}archives/${convo.id}/p${message.ts.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${convo.id}` : ""}`
    : undefined;
  return {
    ...(convo.shared && convo.org ? { org: clip(convo.org, 80) } : {}),
    name: clip(convo.kind === "channel" ? `#${convo.name}` : convo.name, 160),
    kind: convo.kind === "im" ? "direct" : convo.kind === "mpim" ? "group" : thread ? "thread" : "channel",
    ...(convo.shared ? { shared: true } : {}),
    ...(link ? { url: link } : {}),
  };
}
// What one message changes for one person: their own reply settles the
// place; anyone else's becomes its latest message, if it is a place shown to
// them. Returns whether anything changed.
export function applyMessage(
  items: Map<string, ChatItem>,
  person: SlackPerson,
  convo: Conversation,
  message: Message,
  from: string,
  text: string,
) {
  const direct = convo.kind !== "channel";
  const thread = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined;
  const id = thread && !direct ? `${convo.id}:${thread}` : convo.id;
  if (message.user === person.userId) return items.delete(id);
  const names = message.text.includes(`<@${person.userId}>`) || message.text.includes(`<@${person.userId}|`);
  const previous = items.get(id);
  if (previous && previous.at > millis(message.ts)) return false;
  if (!direct && !names && !convo.shared && !previous?.mention) return false;
  items.set(id, {
    id,
    place: place(person, convo, message, thread),
    from: clip(from, 120),
    at: millis(message.ts),
    count: Math.min(999, (previous?.unread ? previous.count : 0) + 1),
    unread: true,
    mention: direct || names || !!previous?.mention,
    text: clip(text, CHAT_TEXT_LIMIT),
  });
  return true;
}
// An edit changes the text of the place's latest message, if it still is.
export function applyEdit(items: Map<string, ChatItem>, convo: Conversation, message: Message, text: string) {
  for (const item of items.values())
    if (item.id.split(":")[0] === convo.id && item.at === millis(message.ts)) {
      item.text = clip(text, CHAT_TEXT_LIMIT);
      return true;
    }
  return false;
}
// What has lapsed: anything three days old, and information a day old.
export function prune(items: Map<string, ChatItem>, now: number) {
  let changed = false;
  for (const [id, item] of items)
    if (now - item.at > KEEP_MS || (!item.mention && now - item.at > FYI_MS)) changed = items.delete(id) || changed;
  return changed;
}
export function slackRead(
  email: string,
  items: Map<string, ChatItem>,
  now: number,
  state: ChatRead["state"] = "ok",
  problem?: string,
): ChatRead {
  return {
    source: "slack",
    owner: email,
    observedAt: now,
    state,
    ...(problem ? { problem } : {}),
    items: [...items.values()].sort((a, b) => b.at - a.at).slice(0, CHAT_ITEMS_LIMIT),
  };
}

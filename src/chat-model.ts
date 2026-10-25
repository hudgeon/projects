import { z } from "zod";

// A machine's read of one person's chat in one source, made with that
// person's own sign-in: each place with something new for them, and its
// latest message cut short. Done and Hand over are kept by the Worker
// (worker/chats.ts); nothing is ever posted, marked read or changed in Slack
// or Teams.
export const CHAT_TEXT_LIMIT = 2000;
export const CHAT_PREVIEW_LIMIT = 140;
export const CHAT_ITEMS_LIMIT = 200;
export const chatSourceSchema = z.enum(["slack", "teams"]);
export type ChatSource = z.infer<typeof chatSourceSchema>;
const time = z.number().int().nonnegative();
const line = (max: number) => z.string().trim().min(1).max(max);
// Only web links open a place; its app takes over from there.
const https = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
// Where something was said. Every row and notice leads with it.
export const chatPlaceSchema = z
  .object({
    // The other organisation: a Teams tenant, or who a Slack channel is
    // shared with.
    org: line(80).optional(),
    // "#ops", a chat's name, a team's channel ("Rollout › General"), or the
    // other person in a direct chat.
    name: line(160),
    kind: z.enum(["channel", "group", "direct", "thread"]),
    // A Slack channel shared with another organisation.
    shared: z.boolean().optional(),
    url: https.optional(),
  })
  .strict();
export const chatItemSchema = z
  .object({
    // Stable for the place, and thread, within its source and person. A Teams
    // thread id carries an @ ("19:…@thread.tacv2").
    id: z.string().regex(/^[A-Za-z0-9_.:@-]+$/).max(200),
    place: chatPlaceSchema,
    from: line(120),
    // The latest message.
    at: time,
    // New since the person last read the place.
    count: z.number().int().min(1).max(999),
    unread: z.boolean(),
    // A direct message, or one that names the person.
    mention: z.boolean(),
    text: z.string().max(CHAT_TEXT_LIMIT),
  })
  .strict();
export const chatReadSchema = z
  .object({
    source: chatSourceSchema,
    // The person whose own sign-in read it.
    owner: z.email().max(254),
    observedAt: time,
    state: z.enum(["ok", "incomplete", "unavailable", "signed-out"]),
    // Why a read is not ok, in a few plain words.
    problem: line(200).optional(),
    items: z.array(chatItemSchema).max(CHAT_ITEMS_LIMIT),
  })
  .strict();
export const chatActionSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["done", "reopen", "hand"]),
    to: z.email().max(254).optional(),
  })
  .strict();
export type ChatPlace = z.infer<typeof chatPlaceSchema>;
export type ChatItem = z.infer<typeof chatItemSchema>;
export type ChatRead = z.infer<typeof chatReadSchema>;
export type ChatAction = z.infer<typeof chatActionSchema>;
// What a person did with an item here: handed it on, or marked it Done.
export type ChatMark = {
  holder: string | null;
  handedBy: string | null;
  handedAt: number | null;
  doneAt: number | null;
};
export type ChatState = "action" | "fyi" | "done" | "handed";
// An item as its person sees it in a list: a preview, never the text.
export type ChatView = Omit<ChatItem, "text"> & {
  key: string;
  source: ChatSource;
  owner: string;
  state: ChatState;
  preview: string;
  // The owner handed it to this person.
  handedTo?: string;
  // This person handed it to the viewer.
  handedBy?: string;
};
export type ChatReadView = Pick<ChatRead, "source" | "observedAt" | "state" | "problem"> & {
  host: string;
  lastHealthyAt?: number;
  problemSince?: number;
};
export type ChatList = { reads: ChatReadView[]; items: ChatView[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// What an item is to the person viewing it, or null when it isn't theirs to
// see. Until the typed check, a direct message or a mention needs its person,
// and anything else unread is for information. Done and Hand over hold until
// a newer message arrives.
export function chatState(
  item: Pick<ChatItem, "at" | "mention" | "unread">,
  owner: string,
  viewer: string,
  mark?: ChatMark,
): ChatState | null {
  const holder =
    mark?.holder && mark.handedAt !== null && item.at <= mark.handedAt
      ? mark.holder
      : null;
  const done = mark?.doneAt != null && item.at <= mark.doneAt;
  if (holder) {
    if (same(viewer, holder)) return done ? "done" : "action";
    return same(viewer, owner) ? "handed" : null;
  }
  if (!same(viewer, owner)) return null;
  if (done) return "done";
  if (item.mention) return "action";
  return item.unread ? "fyi" : null;
}
export const sourceLabel = (source: ChatSource) =>
  source === "slack" ? "Slack" : "Teams";
// The place's name as rows and notices show it: a Teams chat with its
// organisation first, a Slack channel by itself.
export const placeTitle = (place: ChatPlace) =>
  place.org && !place.shared ? `${place.org} · ${place.name}` : place.name;
export function kindLabel(source: ChatSource, place: ChatPlace) {
  if (place.kind === "direct")
    return source === "slack" ? "direct message" : "1:1 chat";
  if (place.kind === "group")
    return source === "slack" ? "group message" : "group chat";
  return place.kind;
}
export const sharedLabel = (place: ChatPlace) =>
  place.shared ? `shared with ${place.org ?? "another organisation"}` : null;
// Items that need the viewer, newest first.
export const chatsToDo = (list: ChatList | undefined) =>
  (list?.items ?? []).filter((item) => item.state === "action");

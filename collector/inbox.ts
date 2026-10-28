import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  INBOX_BODY_LIMIT,
  inboxSchema,
  inboxThreadSchema,
  unsubscribeSchema,
  type Inbox,
} from "../src/inbox-model";
export type Gws = (args: string[]) => Promise<string>;
type Part = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
};
const partSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    body: z
      .object({
        data: z.string().optional(),
        attachmentId: z.string().optional(),
        size: z.number().optional(),
      })
      .optional(),
    parts: z.array(partSchema).max(200).optional(),
  }),
);
const decodeEntity = (entity: string) => {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  const code = entity.match(/^#x([0-9a-f]+)$/i)?.[1];
  const decimal = entity.match(/^#(\d+)$/)?.[1];
  const point = code ? parseInt(code, 16) : decimal ? Number(decimal) : NaN;
  return Number.isFinite(point) && point > 0 && point < 0x110000
    ? String.fromCodePoint(point)
    : (named[entity.toLowerCase()] ?? `&${entity};`);
};
// Email HTML is never rendered: it becomes plain text with line breaks kept.
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) =>
      decodeEntity(entity),
    );
}
// Only the newest message: quoted history and reply chains are left in Gmail.
export function latestOnly(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const quoted = (line: string, index: number) => {
    const trimmed = line.trim();
    const joined = `${trimmed} ${lines[index + 1]?.trim() ?? ""}`;
    return (
      /^On .{4,300}wrote:$/.test(trimmed) ||
      (/^On .{4,200}$/.test(trimmed) && /^On .{4,300}wrote:$/.test(joined)) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed) ||
      /^_{10,}$/.test(trimmed) ||
      (/^From:\s.+/.test(trimmed) &&
        lines
          .slice(index + 1, index + 4)
          .some((next) => /^(Sent|Date):\s/.test(next.trim())))
    );
  };
  const cut = lines.findIndex(quoted);
  const text_ = (cut >= 0 ? lines.slice(0, cut) : lines)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    // Outlook's plain text repeats addresses as <mailto:…> and links as <url>.
    .replace(/<mailto:[^>\s]+>/gi, "")
    .replace(/<(https?:\/\/[^>\s]+)>/gi, " $1")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text_.length > INBOX_BODY_LIMIT
    ? `${text_.slice(0, INBOX_BODY_LIMIT - 1)}…`
    : text_;
}
function findPart(part: Part, type: string, depth = 0): Part | null {
  if (depth > 20) return null;
  if (
    part.mimeType?.toLowerCase() === type &&
    part.body?.data &&
    !part.filename &&
    !part.body.attachmentId
  )
    return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, type, depth + 1);
    if (found) return found;
  }
  return null;
}
function decodePart(part: Part) {
  const bytes = Buffer.from(part.body?.data ?? "", "base64url");
  const type =
    part.headers?.find((h) => h.name.toLowerCase() === "content-type")
      ?.value ?? "";
  return /charset="?(iso-8859-1|windows-1252|latin1)/i.test(type)
    ? bytes.toString("latin1")
    : bytes.toString("utf8");
}
export function messageText(payload: Part) {
  const plain = findPart(payload, "text/plain");
  const html = plain ? null : findPart(payload, "text/html");
  return latestOnly(
    plain ? decodePart(plain) : html ? htmlToText(decodePart(html)) : "",
  );
}
// RFC 2369 List-Unsubscribe, with RFC 8058 one-click only over HTTPS.
export function unsubscribeOptions(headers: Record<string, string>) {
  const value = headers["list-unsubscribe"];
  if (!value) return null;
  const uris = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const url =
    uris.find((uri) => {
      try {
        return new URL(uri).protocol === "https:" && uri.length <= 2000;
      } catch {
        return false;
      }
    }) ?? null;
  const mailto =
    uris.find((uri) => /^mailto:/i.test(uri) && uri.length <= 500) ?? null;
  if (!url && !mailto) return null;
  return unsubscribeSchema.parse({
    oneClick:
      !!url &&
      /List-Unsubscribe\s*=\s*One-Click/i.test(
        headers["list-unsubscribe-post"] ?? "",
      ),
    url,
    mailto: mailto && `mailto:${mailto.slice(7)}`,
  });
}
const refSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{10,40}$/),
  historyId: z.string().optional(),
});
const listSchema = z.object({
  threads: z.array(refSchema).optional(),
  nextPageToken: z.string().optional(),
});
const threadSchema = z.object({
  id: z.string(),
  historyId: z.string().optional(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        internalDate: z.string(),
        labelIds: z.array(z.string()).optional(),
        payload: z
          .object({
            headers: z
              .array(z.object({ name: z.string(), value: z.string() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(2000),
});
// Version 2 caches carry message text; older caches are read again once.
const cacheSchema = z.object({
  version: z.literal(2),
  account: z.email(),
  referenceLabel: z.string().nullable(),
  entries: z
    .array(z.object({ historyId: z.string(), thread: inboxThreadSchema }))
    .max(500),
});
// The account's own gws sign-in on the machine on duty owns Gmail access, and
// must be signed in as that account. The Worker receives metadata only; no
// OAuth credential, snippet or attachment is requested.
export async function readInbox(
  account: string,
  run: Gws,
  now = Date.now(),
  home?: string,
  tracked: string[] = [],
  cacheName = "inbox-cache.json",
): Promise<Inbox> {
  const result: Inbox = { account, observedAt: now, state: "ok", threads: [] };
  const call = async (resource: string, method: string, params: object) =>
    JSON.parse(
      await run([
        "gmail",
        "users",
        ...(resource ? [resource] : []),
        method,
        "--params",
        JSON.stringify(params),
      ]),
    );
  try {
    const profile = await call("", "getProfile", { userId: "me" });
    if (profile.emailAddress?.toLowerCase() !== account.toLowerCase())
      throw Error("Wrong Gmail account");
    const labels = await call("labels", "list", { userId: "me" });
    const referenceLabel = labels.labels?.find(
      (l: { id: string; name: string }) => l.name === "Projects/Reference",
    )?.id;
    const file = home
      ? path.join(home, ".local/share/project-overview", cacheName)
      : null;
    const cached = new Map<
      string,
      z.infer<typeof cacheSchema>["entries"][number]
    >();
    if (file)
      try {
        const raw = await readFile(file, "utf8");
        if (raw.length > 4_000_000) throw Error("Oversized cache");
        const cache = cacheSchema.parse(JSON.parse(raw));
        if (
          cache.account === account &&
          cache.referenceLabel === (referenceLabel ?? null)
        )
          for (const entry of cache.entries) cached.set(entry.thread.id, entry);
      } catch {
        /* A cache miss must read Gmail, never imply no mail. */
      }
    const nextCache: z.infer<typeof cacheSchema>["entries"] = [];
    const ids = new Map<string, string | undefined>();
    let pageToken: string | undefined;
    // Pagination is bounded and explicitly incomplete at the limit, never an
    // apparently empty or fully reviewed inbox after a failed read.
    for (let page = 0; page < 2; page++) {
      const list = listSchema.parse(
        await call("threads", "list", {
          userId: "me",
          q: "in:inbox",
          maxResults: 100,
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      for (const t of list.threads ?? []) ids.set(t.id, t.historyId);
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) result.state = "incomplete";
    const listed = new Set(ids.keys());
    // Linked conversations remain observable after archiving. They have no
    // listing history marker, so always fetch current metadata for them.
    for (const id of tracked) if (!ids.has(id)) ids.set(id, undefined);
    if (ids.size > 500) result.state = "incomplete";
    const refs = [...ids.keys()].slice(0, 500);
    const read = async (id: string, linked: boolean) => {
      const hit = cached.get(id);
      // A fresh Gmail list verifies the exact thread history. No messages
      // need rereading while that history and the label mapping are unchanged.
      if (hit && ids.get(id) === hit.historyId) {
        nextCache.push(hit);
        return hit.thread;
      }
      const t = threadSchema.parse(
        await call("threads", "get", {
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: [
            "Subject",
            "From",
            "List-Unsubscribe",
            "List-Unsubscribe-Post",
          ],
          fields:
            "id,historyId,messages(id,internalDate,labelIds,payload(headers))",
        }),
      );
      if (t.id !== id) throw Error("Wrong thread");
      const messages = t.messages
        .filter((m) => !m.labelIds?.includes("DRAFT"))
        .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      const inInbox = messages.some((m) => m.labelIds?.includes("INBOX"));
      if (!messages.length || (!inInbox && !linked)) return null;
      const latest = messages.at(-1)!;
      const header = (name: string) =>
        latest.payload?.headers?.find(
          (h) => h.name.toLowerCase() === name.toLowerCase(),
        )?.value ?? "";
      // Only threads waiting in the inbox carry their latest message text.
      // A failed text read keeps the thread, uncached, so it is read again.
      let body: string | undefined;
      let complete = true;
      if (inInbox)
        try {
          body = messageText(
            z
              .object({ payload: partSchema })
              .parse(
                await call("messages", "get", {
                  userId: "me",
                  id: latest.id,
                  format: "full",
                  fields: "payload",
                }),
              ).payload,
          );
        } catch {
          complete = false;
        }
      const thread = inboxThreadSchema.parse({
        id,
        inInbox,
        subject: header("Subject").slice(0, 300) || "(No subject)",
        from: header("From").slice(0, 300),
        latestMessageId: latest.id,
        updatedAt: Number(latest.internalDate),
        reference:
          !!referenceLabel && !!latest.labelIds?.includes(referenceLabel),
        lastSentByMe: latest.labelIds?.includes("SENT") ?? false,
        unread: messages.some((m) => m.labelIds?.includes("UNREAD")),
        messages: messages.length,
        ...(body === undefined ? {} : { body }),
        unsubscribe: unsubscribeOptions({
          "list-unsubscribe": header("List-Unsubscribe"),
          "list-unsubscribe-post": header("List-Unsubscribe-Post"),
        }),
      });
      if (t.historyId && complete)
        nextCache.push({ historyId: t.historyId, thread });
      return thread;
    };
    const unfound: string[] = [];
    for (let i = 0; i < refs.length; i += 4) {
      const batch = refs.slice(i, i + 4);
      const reads = await Promise.allSettled(
        batch.map((id) => read(id, tracked.includes(id))),
      );
      reads.forEach((r, j) => {
        if (r.status === "fulfilled") {
          if (r.value) result.threads.push(r.value);
        } else if (listed.has(batch[j])) result.state = "incomplete";
        else unfound.push(batch[j]);
      });
    }
    // A work issue may link one message instead of its conversation; Gmail
    // opens either in the browser. Read the conversation it belongs to and
    // keep the linked ID on it, so the work link still finds it. A link Gmail
    // knows neither way remains a failed read.
    const linkedAs = new Map<string, string[]>();
    for (const id of unfound)
      try {
        const { threadId } = z.object({ threadId: z.string() }).parse(
          await call("messages", "get", {
            userId: "me",
            id,
            format: "minimal",
            fields: "threadId",
          }),
        );
        if (threadId === id) throw Error("Unread thread");
        linkedAs.set(threadId, [...(linkedAs.get(threadId) ?? []), id]);
        if (ids.has(threadId)) continue;
        if (ids.size >= 500) throw Error("Inbox limit");
        ids.set(threadId, undefined);
        const thread = await read(threadId, true);
        if (thread) result.threads.push(thread);
      } catch {
        result.state = "incomplete";
      }
    result.threads = result.threads.map((t) =>
      linkedAs.has(t.id)
        ? { ...t, linkedAs: linkedAs.get(t.id)!.slice(0, 50) }
        : t,
    );
    if (file)
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(
          temp,
          JSON.stringify(
            cacheSchema.parse({
              version: 2,
              account,
              referenceLabel: referenceLabel ?? null,
              entries: nextCache,
            }),
          ),
          { mode: 0o600 },
        );
        await rename(temp, file);
      } catch {
        /* Cache writes affect efficiency, not observed Gmail coverage. */
      }
    return inboxSchema.parse(result);
  } catch {
    return { account, observedAt: now, state: "unavailable", threads: [] };
  }
}

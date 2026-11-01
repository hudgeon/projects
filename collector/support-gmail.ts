import { z } from "zod";
import { messageText, type Gws } from "./inbox";
import { mailHash, messageKey, rfcMessageId } from "./mail-identity";
import type { SupportConfig } from "../src/support-model";
type Payload = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: Payload[] };
type Message = { id: string; internalDate: string; labelIds?: string[]; payload?: Payload };
export type SupportThread = {
  id: string; key: string; subject: string; from: string; to: string | null;
  at: number; body: string; messageId: string | null; messageKeys: string[];
  unread: boolean;
  humanRepliedAt?: number; eligible: boolean;
  acknowledgedAt?: number;
};
const headers = (m: Message) => Object.fromEntries((m.payload?.headers ?? []).map(h => [h.name.toLowerCase(), h.value]));
export function mailbox(value: string) {
  if (/[\r\n]/.test(value)) return null;
  const text = value.trim(), bracketed = /^(?:"[^"\r\n]*"|[^<>@,:;"\r\n]*)\s*<([^<>\s]+)>$/.exec(text);
  const address = bracketed?.[1] ?? text;
  return z.email().safeParse(address).success ? address.toLowerCase() : null;
}
export function automatic(h: Record<string, string>) {
  const from = mailbox(h.from ?? "") ?? "";
  return (!!h["auto-submitted"] && h["auto-submitted"].trim().toLowerCase() !== "no") ||
    !!h["list-id"] || /(?:bulk|list|junk)/i.test(h.precedence ?? "") ||
    /(?:mailer-daemon|postmaster|no[._-]?reply|do[._-]?not[._-]?reply)@/i.test(from) ||
    h["return-path"]?.trim() === "<>" || /multipart\/report/i.test(h["content-type"] ?? "");
}
function isAcknowledgment(message: Message, account: SupportConfig, incoming: Message[]) {
  const h = headers(message);
  if (!message.labelIds?.includes("SENT") || mailbox(h.from ?? "") !== account.account.toLowerCase() ||
    h["auto-submitted"]?.trim().toLowerCase() !== "auto-replied") return false;
  // Gmail can replace a submitted Message-ID. Recover only our own labelled
  // Sent reply, tied to an actual request in this exact mailbox conversation.
  const replyTo = rfcMessageId(h["in-reply-to"] ?? "");
  const original = incoming.find(m => replyTo && rfcMessageId(headers(m)["message-id"] ?? "") === replyTo);
  if (!original || h["x-auto-response-suppress"]?.trim().toLowerCase() !== "all") return false;
  const request = headers(original);
  if (mailbox(h.to ?? "") !== mailbox(request["reply-to"] ?? request.from ?? "")) return false;
  const text = messageText(message.payload ?? {}).replace(/\s+/g, " ").trim();
  return text.startsWith("Automated response from Support Thanks for your email. We understand that ") &&
    text.endsWith("We're looking into it, and a person from our team will respond shortly. Support");
}
export function supportThread(account: SupportConfig, id: string, messages: Message[]): SupportThread | null {
  const own = new Set([account.account, account.owner, ...account.aliases].map(s => s.toLowerCase()));
  const sorted = messages.filter(m => !m.labelIds?.includes("DRAFT") && Number.isFinite(Number(m.internalDate)))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const incoming = sorted.filter(m => {
    const h = headers(m), from = mailbox(h.from ?? "");
    return from && !m.labelIds?.includes("SENT") && !own.has(from) && !automatic(h);
  });
  const latest = incoming.at(-1);
  if (!latest) return null;
  const h = headers(latest), from = mailbox(h.from ?? "")!;
  const human = sorted.filter(m => m.labelIds?.includes("SENT") && !automatic(headers(m))).at(-1);
  const humanRepliedAt = human ? Number(human.internalDate) : undefined;
  const messageId = rfcMessageId(h["message-id"] ?? "");
  const at = Number(latest.internalDate);
  const key = mailHash(`${account.account.toLowerCase()}\n${id}`);
  const receipt = sorted.find(m => isAcknowledgment(m, account, incoming));
  return {
    id, key,
    subject: (h.subject?.replace(/[\r\n]/g, " ").trim() || "Support request").slice(0, 300),
    from, to: h["reply-to"] ? mailbox(h["reply-to"]) : from,
    at, body: messageText(latest.payload ?? {}), messageId,
    unread: latest.labelIds?.includes("UNREAD") ?? false,
    messageKeys: sorted.flatMap(m => messageKey(headers(m)["message-id"] ?? "") ?? []).slice(-200),
    ...(humanRepliedAt === undefined ? {} : { humanRepliedAt }),
    ...(receipt ? { acknowledgedAt: Number(receipt.internalDate) } : {}),
    eligible: !!messageId && at >= Date.parse(account.acknowledgeSince ?? account.since) && !(humanRepliedAt && humanRepliedAt >= at),
  };
}
const call = async (gws: Gws, resource: string, method: string, params: object) => JSON.parse(await gws(["gmail", "users", ...(resource ? [resource] : []), method, "--params", JSON.stringify(params)]));
export async function readSupport(config: SupportConfig, gws: Gws): Promise<{ threads: SupportThread[]; complete: boolean }> {
  const profile = await call(gws, "", "getProfile", { userId: "me" });
  if (profile.emailAddress?.toLowerCase() !== config.account.toLowerCase()) throw Error("Support mailbox identity mismatch");
  const threads: SupportThread[] = [];
  let pageToken: string | undefined, complete = true;
  for (let page = 0; page < 2; page++) {
    const listed = await call(gws, "threads", "list", { userId: "me", q: `{in:inbox after:${Math.floor(Date.parse(config.since) / 1000)}} -in:spam -in:trash -in:drafts`, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    const refs = listed.threads ?? [];
    if (!Array.isArray(refs) || refs.length > 100) throw Error("Invalid support inventory");
    for (const ref of refs) {
      if (!/^[a-f0-9]{10,40}$/.test(ref.id)) { complete = false; continue; }
      try {
        const raw = await call(gws, "threads", "get", { userId: "me", id: ref.id, format: "full", fields: "id,messages(id,internalDate,labelIds,payload)" });
        if (raw.id !== ref.id || !Array.isArray(raw.messages)) throw Error("Invalid thread");
        const thread = supportThread(config, ref.id, raw.messages);
        if (thread) threads.push(thread);
      } catch { complete = false; }
    }
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
  }
  return { threads, complete: complete && !pageToken };
}
export async function sentAcknowledgment(gws: Gws, account: SupportConfig, thread: SupportThread) {
  const result = await call(gws, "threads", "get", { userId: "me", id: thread.id, format: "full", fields: "id,messages(id,internalDate,labelIds,payload)" });
  if (result.id !== thread.id || !Array.isArray(result.messages)) throw Error("Invalid support conversation");
  return supportThread(account, thread.id, result.messages)?.acknowledgedAt !== undefined;
}
export function acknowledgmentRaw(config: SupportConfig, thread: SupportThread, body: string, messageId: string) {
  if (!thread.to || !thread.messageId) throw Error("No safe reply address or Message-ID");
  const subject = `Re: ${thread.subject.replace(/^re:\s*/i, "")}`;
  return Buffer.from([
    `From: Support <${config.account}>`, `To: ${thread.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Message-ID: ${messageId}`, `In-Reply-To: ${thread.messageId}`, `References: ${thread.messageId}`,
    "Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(body).toString("base64"), "",
  ].join("\r\n")).toString("base64url");
}

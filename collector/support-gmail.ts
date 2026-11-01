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
  const receipt = sorted.find(m => m.labelIds?.includes("SENT") && headers(m)["message-id"] === `<projects-support-${key}@${account.account.split("@")[1]}>`);
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
export async function sentAcknowledgment(gws: Gws, messageId: string) {
  const result = await call(gws, "messages", "list", { userId: "me", q: `in:sent rfc822msgid:${messageId}`, maxResults: 2 });
  return Array.isArray(result.messages) && result.messages.length > 0;
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

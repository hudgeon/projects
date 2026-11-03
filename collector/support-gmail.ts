import { messageText, type Gws } from "./inbox";
import { mailbox, mailboxes, mailHash, messageKey, rfcMessageId } from "./mail-identity";
import { mailHeaders as headers, failedRecipients, deliveryReport, replyRecipients, type MailMessage as Message, type ReplyRecipients, type DeliveryReport } from "./mail-delivery";
import type { SupportConfig } from "../src/support-model";
import { supportForward } from "./support-forward";
export type SupportThread = {
  id: string; key: string; subject: string; from: string; recipients: ReplyRecipients | null;
  deliveryHistoryComplete: boolean;
  at: number; body: string; messageId: string | null; messageKeys: string[];
  unread: boolean;
  humanRepliedAt?: number; eligible: boolean;
  acknowledgedAt?: number;
  // Existing drafts are never overwritten or interpreted as a sent reply.
  draftMessages?: string[];
  forwarded?: boolean;
  // The source is read-only; its mailbox-local thread ID is never used to
  // create a draft in the shared mailbox.
  sourceAccount?: string;
};
export function automatic(h: Record<string, string>) {
  const from = mailbox(h.from ?? "") ?? "";
  return (!!h["auto-submitted"] && h["auto-submitted"].trim().toLowerCase() !== "no") ||
    !!h["list-id"] || /(?:bulk|list|junk)/i.test(h.precedence ?? "") ||
    /(?:mailer-daemon|postmaster|no[._-]?reply|do[._-]?not[._-]?reply)@/i.test(from) ||
    h["return-path"]?.trim() === "<>" || /multipart\/report/i.test(h["content-type"] ?? "");
}
export function senderOnlyDraft(message: Message, config: SupportConfig, sender: string) {
  const h = headers(message), to = mailboxes(h.to ?? "");
  return mailbox(h.from ?? "") === config.account.toLowerCase() && to?.length === 1 && to[0] === sender &&
    mailboxes(h.cc ?? "")?.length === 0 && !message.payload?.headers?.some(header => header.name.toLowerCase() === "bcc");
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
  const forward = supportForward(account, original);
  const allowed = replyRecipients(account, forward ? forward.request?.headers ?? {} : headers(original), new Set());
  const to = mailboxes(h.to ?? ""), cc = mailboxes(h.cc ?? "");
  if (!allowed || !to || !cc || !to.length) return false;
  const addresses = new Set([...allowed.to, ...allowed.cc]);
  if (![...to, ...cc].every(address => addresses.has(address))) return false;
  const text = messageText(message.payload ?? {}).replace(/\s+/g, " ").trim();
  const legacy = text.startsWith("Automated response from Support Thanks for your email. We understand that ") &&
    text.endsWith("We're looking into it, and a person from our team will respond shortly. Support");
  const current = h["x-projects-support-receipt"] === "2" && text.startsWith("Automated response from Support Thanks for your email.") &&
    text.endsWith("A person from our team will respond shortly. Support");
  return legacy || current;
}
export function supportThread(account: SupportConfig, id: string, messages: Message[], reports: DeliveryReport[] = []): SupportThread | null {
  const own = new Set([account.account, account.owner, ...account.aliases].map(s => s.toLowerCase()));
  const sorted = messages.filter(m => !m.labelIds?.includes("DRAFT") && Number.isFinite(Number(m.internalDate)))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const incoming = sorted.filter(m => {
    const h = headers(m), from = mailbox(h.from ?? "");
    return from && !m.labelIds?.includes("SENT") && (!own.has(from) || !!supportForward(account, m)) && !automatic(h);
  });
  const latest = incoming.at(-1);
  if (!latest) return null;
  const h = headers(latest), forward = supportForward(account, latest);
  const requestHeaders = forward ? forward.request && !automatic(forward.request.headers) ? forward.request.headers : {} : h;
  const from = mailbox(requestHeaders.from ?? "") ?? mailbox(h.from ?? "")!;
  const human = sorted.filter(m => m.labelIds?.includes("SENT") && !automatic(headers(m))).at(-1);
  const humanRepliedAt = human ? Number(human.internalDate) : undefined;
  const messageId = rfcMessageId(h["message-id"] ?? "");
  const at = Number(latest.internalDate);
  const key = mailHash(`${account.account.toLowerCase()}\n${id}`);
  const receipt = sorted.find(m => isAcknowledgment(m, account, incoming));
  const failures = failedRecipients(sorted, reports);
  return {
    id, key,
    subject: (h.subject?.replace(/[\r\n]/g, " ").trim() || "Support request").slice(0, 300),
    from, recipients: failures.addresses.has(from) || !mailbox(requestHeaders.from ?? "") ? null : { to: [from], cc: [] },
    deliveryHistoryComplete: failures.complete,
    at, body: forward?.request?.body ?? messageText(latest.payload ?? {}), messageId,
    ...(forward ? { forwarded: true } : {}),
    unread: latest.labelIds?.includes("UNREAD") ?? false,
    messageKeys: sorted.flatMap(m => messageKey(headers(m)["message-id"] ?? "") ?? []).slice(-200),
    ...(humanRepliedAt === undefined ? {} : { humanRepliedAt }),
    ...(receipt ? { acknowledgedAt: Number(receipt.internalDate) } : {}),
    draftMessages: messages.filter(m => m.labelIds?.includes("DRAFT")).map(m => m.id),
    eligible: !!messageId && at >= Date.parse(account.draftSince ?? account.since) &&
      (!forward || !!account.forwardSince && at >= Date.parse(account.forwardSince)) && !(humanRepliedAt && humanRepliedAt >= at),
  };
}
const call = async (gws: Gws, resource: string, method: string, params: object) => JSON.parse(await gws(["gmail", "users", ...(resource ? [resource] : []), method, "--params", JSON.stringify(params)]));
export async function readSupport(config: SupportConfig, gws: Gws, reportCache = new Map<string, DeliveryReport>(), newOnly = false): Promise<{ threads: SupportThread[]; complete: boolean }> {
  const profile = await call(gws, "", "getProfile", { userId: "me" });
  if (profile.emailAddress?.toLowerCase() !== config.account.toLowerCase()) throw Error("Support mailbox identity mismatch");
  const threads: SupportThread[] = [], conversations: { id: string; messages: Message[] }[] = [];
  let pageToken: string | undefined, complete = true;
  for (let page = 0; page < 2; page++) {
    const after = `after:${Math.floor(Date.parse(config.since) / 1000)}`;
    const listed = await call(gws, "threads", "list", { userId: "me", q: `${newOnly ? after : `{in:inbox ${after}}`} -in:spam -in:trash -in:drafts`, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    const refs = listed.threads ?? [];
    if (!Array.isArray(refs) || refs.length > 100) throw Error("Invalid support inventory");
    for (const ref of refs) {
      if (!/^[a-f0-9]{10,40}$/.test(ref.id)) { complete = false; continue; }
      try {
        const raw = await call(gws, "threads", "get", { userId: "me", id: ref.id, format: "full", fields: "id,messages(id,internalDate,labelIds,payload)" });
        if (raw.id !== ref.id || !Array.isArray(raw.messages)) throw Error("Invalid thread");
        conversations.push({ id: ref.id, messages: raw.messages });
      } catch { complete = false; }
    }
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) complete = false;
  // With no source conversation there is no reply audience to check. Older
  // unrelated personal DSNs must not make an empty fresh intake incomplete.
  if (newOnly && !conversations.length) return { threads, complete };
  // DSNs may be separate Gmail conversations or land in Spam/Trash. Their
  // subjects locate candidates only; formal MIME evidence and the original
  // Message-ID determine whether a failure belongs to a support conversation.
  const reports: DeliveryReport[] = [], known = new Set(conversations.flatMap(c => c.messages.map(m => m.id)));
  pageToken = undefined;
  for (let page = 0; page < (newOnly ? 20 : 2); page++) {
    const listed = await call(gws, "messages", "list", { userId: "me", q: "{from:mailer-daemon from:postmaster from:MicrosoftExchange from:MailDeliveryDaemon subject:\"Delivery Status Notification\" subject:Undeliverable}", includeSpamTrash: true, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    const refs = listed.messages ?? [];
    if (!Array.isArray(refs) || refs.length > 100) throw Error("Invalid delivery-report inventory");
    for (const ref of refs) {
      if (known.has(ref.id)) continue;
      if (!/^[a-f0-9]{10,40}$/.test(ref.id)) { complete = false; continue; }
      try {
        const cached = reportCache.get(ref.id);
        if (cached) { if (cached.report) reports.push(cached); continue; }
        const raw = await call(gws, "messages", "get", { userId: "me", id: ref.id, format: "full", fields: "id,internalDate,labelIds,payload" });
        if (raw.id !== ref.id) throw Error("Invalid delivery report");
        const dsn = deliveryReport(raw);
        if (dsn.report) {
          reports.push(dsn);
          if (!dsn.complete || !dsn.originals.size) complete = false;
        }
        // Gmail message content is immutable. Cache only complete evidence;
        // every scan still inventories current messages including Spam/Trash.
        if (!dsn.report || dsn.complete && dsn.originals.size) {
          if (reportCache.size >= (newOnly ? 2000 : 200)) reportCache.delete(reportCache.keys().next().value!);
          reportCache.set(ref.id, dsn);
        }
      } catch { complete = false; }
    }
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
  }
  for (const conversation of conversations) {
    const thread = supportThread(config, conversation.id, conversation.messages, reports);
    if (thread) threads.push(thread);
  }
  return { threads, complete: complete && !pageToken };
}
export function acknowledgmentRaw(config: SupportConfig, thread: SupportThread, body: string, messageId: string) {
  if (!thread.recipients || thread.recipients.to.length !== 1 || thread.recipients.to[0] !== thread.from || thread.recipients.cc.length || !thread.messageId)
    throw Error("No safe sender-only reply address or Message-ID");
  const subject = `Re: ${thread.subject.replace(/^re:\s*/i, "")}`;
  return Buffer.from([
    `From: Support <${config.account}>`, `To: ${thread.from}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Message-ID: ${messageId}`, `In-Reply-To: ${thread.messageId}`, `References: ${thread.messageId}`,
    "Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All", "MIME-Version: 1.0",
    "X-Projects-Support-Receipt: 2",
    `X-Projects-Support-Case: ${thread.key}`,
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(body).toString("base64"), "",
  ].join("\r\n")).toString("base64url");
}

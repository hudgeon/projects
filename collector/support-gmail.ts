import { messageText, type Gws } from "./inbox";
import { mailbox, mailboxes, mailHash, messageKey, rfcMessageId } from "./mail-identity";
import { mailHeaders as headers, failedRecipients, deliveryReport, replyRecipients, type MailMessage as Message, type ReplyRecipients, type DeliveryReport } from "./mail-delivery";
import type { SupportConfig } from "../src/support-model";
export type SupportThread = {
  id: string; key: string; subject: string; from: string; recipients: ReplyRecipients | null;
  deliveryHistoryComplete: boolean;
  at: number; body: string; messageId: string | null; messageKeys: string[];
  unread: boolean;
  humanRepliedAt?: number; eligible: boolean;
  acknowledgedAt?: number;
};
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
  const allowed = replyRecipients(account, headers(original), new Set());
  const to = mailboxes(h.to ?? ""), cc = mailboxes(h.cc ?? "");
  if (!allowed || !to || !cc || !to.length) return false;
  const addresses = new Set([...allowed.to, ...allowed.cc]);
  if (![...to, ...cc].every(address => addresses.has(address))) return false;
  const text = messageText(message.payload ?? {}).replace(/\s+/g, " ").trim();
  return text.startsWith("Automated response from Support Thanks for your email. We understand that ") &&
    text.endsWith("We're looking into it, and a person from our team will respond shortly. Support");
}
export function supportThread(account: SupportConfig, id: string, messages: Message[], reports: DeliveryReport[] = []): SupportThread | null {
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
  const failures = failedRecipients(sorted, reports);
  return {
    id, key,
    subject: (h.subject?.replace(/[\r\n]/g, " ").trim() || "Support request").slice(0, 300),
    from, recipients: replyRecipients(account, h, failures.addresses), deliveryHistoryComplete: failures.complete,
    at, body: messageText(latest.payload ?? {}), messageId,
    unread: latest.labelIds?.includes("UNREAD") ?? false,
    messageKeys: sorted.flatMap(m => messageKey(headers(m)["message-id"] ?? "") ?? []).slice(-200),
    ...(humanRepliedAt === undefined ? {} : { humanRepliedAt }),
    ...(receipt ? { acknowledgedAt: Number(receipt.internalDate) } : {}),
    eligible: !!messageId && at >= Date.parse(account.acknowledgeSince ?? account.since) && !(humanRepliedAt && humanRepliedAt >= at),
  };
}
const call = async (gws: Gws, resource: string, method: string, params: object) => JSON.parse(await gws(["gmail", "users", ...(resource ? [resource] : []), method, "--params", JSON.stringify(params)]));
export async function readSupport(config: SupportConfig, gws: Gws, reportCache = new Map<string, DeliveryReport>()): Promise<{ threads: SupportThread[]; complete: boolean }> {
  const profile = await call(gws, "", "getProfile", { userId: "me" });
  if (profile.emailAddress?.toLowerCase() !== config.account.toLowerCase()) throw Error("Support mailbox identity mismatch");
  const threads: SupportThread[] = [], conversations: { id: string; messages: Message[] }[] = [];
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
        conversations.push({ id: ref.id, messages: raw.messages });
      } catch { complete = false; }
    }
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) complete = false;
  // DSNs may be separate Gmail conversations or land in Spam/Trash. Their
  // subjects locate candidates only; formal MIME evidence and the original
  // Message-ID determine whether a failure belongs to a support conversation.
  const reports: DeliveryReport[] = [], known = new Set(conversations.flatMap(c => c.messages.map(m => m.id)));
  pageToken = undefined;
  for (let page = 0; page < 2; page++) {
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
          if (reportCache.size >= 200) reportCache.delete(reportCache.keys().next().value!);
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
export async function sentAcknowledgment(gws: Gws, account: SupportConfig, thread: SupportThread) {
  const result = await call(gws, "threads", "get", { userId: "me", id: thread.id, format: "full", fields: "id,messages(id,internalDate,labelIds,payload)" });
  if (result.id !== thread.id || !Array.isArray(result.messages)) throw Error("Invalid support conversation");
  return supportThread(account, thread.id, result.messages)?.acknowledgedAt !== undefined;
}
export function acknowledgmentRaw(config: SupportConfig, thread: SupportThread, body: string, messageId: string, recipients = thread.recipients) {
  if (!recipients?.to.length || !thread.messageId) throw Error("No safe reply address or Message-ID");
  const subject = `Re: ${thread.subject.replace(/^re:\s*/i, "")}`;
  return Buffer.from([
    `From: Support <${config.account}>`, `To: ${recipients.to.join(", ")}`,
    ...(recipients.cc.length ? [`Cc: ${recipients.cc.join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Message-ID: ${messageId}`, `In-Reply-To: ${thread.messageId}`, `References: ${thread.messageId}`,
    "Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(body).toString("base64"), "",
  ].join("\r\n")).toString("base64url");
}

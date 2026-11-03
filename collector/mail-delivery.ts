import { mailbox, mailboxes, rfcMessageId } from "./mail-identity";
import type { SupportConfig } from "../src/support-model";
export type MailPayload = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; attachmentId?: string; size?: number }; parts?: MailPayload[] };
export type MailMessage = { id: string; internalDate: string; labelIds?: string[]; payload?: MailPayload };
export const mailHeaders = (m: MailMessage): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const name = h.name.toLowerCase();
    result[name] = result[name] === undefined ? h.value : ["to", "cc"].includes(name) ? result[name] + ", " + h.value : "";
  }
  return result;
};
export type ReplyRecipients = { to: string[]; cc: string[] };
export function replyRecipients(account: Pick<SupportConfig, "account" | "aliases">, h: Record<string, string>, failed: ReadonlySet<string>): ReplyRecipients | null {
  const from = mailbox(h.from ?? ""), to = mailboxes(h.to ?? ""), cc = mailboxes(h.cc ?? "");
  if (!from || !to || !cc) return null;
  const seen = new Set([account.account, ...account.aliases].map(value => value.toLowerCase()));
  const keep = (address: string) => {
    if (seen.has(address) || failed.has(address)) return false;
    seen.add(address); return true;
  };
  const recipients = { to: [from, ...to].filter(keep), cc: cc.filter(keep) };
  if (!recipients.to.length && recipients.cc.length) recipients.to.push(recipients.cc.shift()!);
  return recipients.to.length ? recipients : null;
}
const fields = (text: string) => Object.fromEntries(text.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n").flatMap(line => {
  const match = /^([a-z0-9-]+):[ \t]*(.*)$/i.exec(line);
  return match ? [[match[1].toLowerCase(), match[2].trim()]] : [];
}));
function decode(part: MailPayload) {
  const data = part.body?.data;
  if (typeof data !== "string" || data.length > 90_000 || !/^[a-z0-9_+/=-]*$/i.test(data)) return null;
  return Buffer.from(data, "base64url").toString("utf8");
}
function statusText(part: MailPayload, depth = 0): string | null {
  if (depth > 12) return null;
  const chunks = (part.headers ?? []).map(h => h.name + ": " + h.value);
  if (part.body?.data !== undefined) {
    const text = decode(part);
    if (text === null) return null;
    chunks.push("", text);
  } else if (part.body?.attachmentId && !part.parts?.length) return null;
  for (const child of part.parts ?? []) {
    const text = statusText(child, depth + 1);
    if (text === null) return null;
    chunks.push("", text);
  }
  const text = chunks.join("\n");
  return text.length && text.length <= 65_536 ? text : null;
}
export function deliveryReport(message: MailMessage) {
  const root = message.payload, h = mailHeaders(message);
  const report = root?.mimeType === "multipart/report" || /multipart\/report/i.test(h["content-type"] ?? "");
  const failed = new Set<string>(), originals = new Set<string>();
  let complete = true, statuses = 0, outcomes = 0;
  if (report) {
    const replyTo = rfcMessageId(h["in-reply-to"] ?? "");
    if (replyTo) originals.add(replyTo);
  }
  const walk = (part: MailPayload, depth: number) => {
    if (depth > 12) { complete = false; return; }
    const mime = part.mimeType?.toLowerCase();
    if (depth) {
      const nestedId = rfcMessageId(part.headers?.find(h => h.name.toLowerCase() === "message-id")?.value ?? "");
      if (nestedId) originals.add(nestedId);
    }
    if (mime === "message/delivery-status" || mime === "message/global-delivery-status") {
      statuses++;
      const text = statusText(part);
      if (text === null) { complete = false; return; }
      for (const block of text.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)) {
        const f = fields(block);
        const original = rfcMessageId(f["original-message-id"] ?? f["x-original-message-id"] ?? "");
        if (original) originals.add(original);
        if (!f.action && !f["final-recipient"]) continue;
        const action = f.action?.toLowerCase();
        if (!["failed", "delayed", "delivered", "relayed", "expanded"].includes(action) || !/^[245]\.\d{1,3}\.\d{1,3}$/.test(f.status ?? "") || !f["final-recipient"]) {
          complete = false; continue;
        }
        outcomes++;
        if (!["failed", "delayed"].includes(action)) continue;
        let addresses = 0;
        for (const value of [f["original-recipient"], f["final-recipient"]].filter(Boolean)) {
          const recipient = /^(?:rfc822|utf-8)\s*;\s*(.+)$/i.exec(value);
          const address = recipient ? mailbox(recipient[1]) : null;
          if (address) { failed.add(address); addresses++; }
          else complete = false;
        }
        if (!addresses) complete = false;
      }
    }
    if (mime === "message/rfc822" || mime === "text/rfc822-headers" || mime === "message/global") {
      const text = decode(part);
      const id = rfcMessageId(fields(text?.split(/\r?\n\r?\n/, 1)[0] ?? "")["message-id"] ?? "");
      if (id) originals.add(id);
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  if (root) walk(root, 0);
  return { report: report || statuses > 0, failed, originals, complete: complete && (!report || statuses > 0) && (!statuses || outcomes > 0) };
}
export type DeliveryReport = ReturnType<typeof deliveryReport>;
// A failure in another Gmail thread belongs here only when the report's
// attached original Message-ID exactly identifies this conversation.
export function failedRecipients(messages: MailMessage[], reports: DeliveryReport[] = []) {
  const ids = new Set(messages.flatMap(m => rfcMessageId(mailHeaders(m)["message-id"] ?? "") ?? []));
  const failed = new Set<string>();
  let complete = true;
  for (const [items, sameThread] of [[messages.map(deliveryReport), true], [reports, false]] as const)
    for (const dsn of items) {
      if (!dsn.report || (!sameThread && ![...dsn.originals].some(id => ids.has(id)))) continue;
      for (const address of dsn.failed) failed.add(address);
      if (!dsn.complete) complete = false;
    }
  return { addresses: failed, complete };
}

// Inline forwarding is a draft-only operator convenience, never proof of a
// customer's identity. Parse the first complete envelope, not addresses in
// signatures, instructions, attachments or older quoted conversations.
import { latestOnly, messageBody } from "./inbox";
import { mailbox, mailboxes } from "./mail-identity";
import { mailHeaders, type MailMessage } from "./mail-delivery";
import type { SupportConfig } from "../src/support-model";

function isSupportForwarder(config: SupportConfig, from: string) {
  return config.forwarders?.some(address => address.toLowerCase() === from) ?? false;
}
function authenticated(h: Record<string, string>, from: string) {
  // mailHeaders refuses duplicate Authentication-Results. Trust only Gmail's
  // receiver result, with aligned DKIM and DMARC; never a result in the body.
  const auth = h["authentication-results"]?.replace(/\r?\n[ \t]+/g, " ").toLowerCase() ?? "";
  if (!auth.startsWith("mx.google.com;")) return false;
  const domain = from.split("@")[1];
  return auth.split(";").some(part => /^\s*dmarc=pass\b/.test(part) &&
    /\bheader\.from=([^\s;]+)/.exec(part)?.[1] === domain) &&
    auth.split(";").some(part => /^\s*dkim=pass\b/.test(part) &&
      [/\bheader\.i=[^\s@]*@([^\s;]+)/, /\bheader\.d=([^\s;]+)/].some(pattern => pattern.exec(part)?.[1] === domain));
}
function recipients(value: string) {
  // Outlook uses semicolon separators. Preserve quoted names and angle pairs;
  // unsupported group syntax still fails the shared strict address parser.
  let quoted = false, angle = false, text = "";
  for (const c of value) {
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "<") angle = true;
    if (!quoted && c === ">") angle = false;
    text += c === ";" && !quoted && !angle ? "," : c;
  }
  return mailboxes(text);
}
export function supportForward(config: SupportConfig, message: MailMessage) {
  const outer = mailHeaders(message), by = mailbox(outer.from ?? "");
  if (!by || !isSupportForwarder(config, by)) return undefined;
  const text = messageBody(message.payload ?? {}).replace(/\r\n?/g, "\n");
  const lines = text.slice(0, 65_537).split("\n");
  const marker = lines.findIndex(line => /^(?:-{2,}\s*(?:Forwarded message|Original Message)\s*-{2,}|Begin forwarded message:|_{5,})$/i.test(line.trim()));
  // Enabling an address must not reinterpret its earlier ordinary messages
  // or prevent recovery of their already-sent receipts.
  if (marker < 0 && !/^(?:fwd?|fw):/i.test(outer.subject?.trim() ?? "")) return undefined;
  const held = { by, request: null };
  if (!authenticated(outer, by)) return held;
  if (text.length > 65_536) return held;
  if (marker < 0 || marker > 100) return held;
  let i = marker + 1;
  while (lines[i]?.trim() === "") i++;
  const h: Record<string, string> = {};
  let last = "", size = 0, fields = 0;
  for (; i < lines.length && lines[i].trim(); i++) {
    size += lines[i].length;
    if (size > 8000 || ++fields > 40) return held;
    const field = /^\s*(From|Date|Sent|To|Cc|Subject):[ \t]*(.*)$/i.exec(lines[i]);
    if (field) {
      last = field[1].toLowerCase();
      if (h[last] !== undefined) return held;
      h[last] = field[2].trim();
    } else if (/^[ \t]+\S/.test(lines[i]) && last) h[last] += " " + lines[i].trim();
    else return held;
  }
  const from = mailbox(h.from ?? ""), to = recipients(h.to ?? ""), cc = recipients(h.cc ?? "");
  if (!from || !to?.length || !cc || !h.subject || !(h.date || h.sent) ||
    [h.from, h.to, h.cc, h.subject].some(value => /[\p{Cc}]/u.test(value ?? ""))) return held;
  const body = latestOnly(lines.slice(i + 1).join("\n"));
  if (!body) return held;
  return { by, request: { headers: { from, to: to.join(", "), cc: cc.join(", ") }, body } };
}

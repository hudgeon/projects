import { test } from "node:test";
import assert from "node:assert/strict";
import { supportForward } from "./support-forward";
import { supportThread } from "./support-gmail";
import { messageBody, messageText } from "./inbox";
import type { MailMessage } from "./mail-delivery";
import { supportConfigSchema, type SupportConfig } from "../src/support-model";
const at = Date.parse("2026-11-03T00:00:00Z"), id = "1234567890abcdef";
const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [],
  since: "2026-11-01T00:00:00Z", draft: true,
  forwarders: ["owner@example.com", "owner@another.example"], forwardSince: new Date(at).toISOString() };
const auth = "mx.google.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com";
const source = "---------- Forwarded message ---------\nFrom: Customer <customer@example.org>\nDate: Tue, 3 Nov 2026\nSubject: Export\nTo: Owner <owner@example.com>\nCc: Colleague <colleague@example.org>, help@example.com\n\nThe export is empty.\n\nOn Monday, Old <old@example.net> wrote:\n> An older report with other people.";
function message(body = source, extra: Record<string, string> = {}): MailMessage {
  return { id, internalDate: String(at), labelIds: ["INBOX"], payload: { mimeType: "text/plain",
    headers: Object.entries({ From: config.owner, To: config.account, Subject: "Fwd: Export", "Message-ID": "<outer@example.com>", "Authentication-Results": auth, ...extra }).map(([name, value]) => ({ name, value })),
    body: { data: Buffer.from(body).toString("base64url") } } };
}
test("an authenticated owner forward uses the first original envelope and excludes commentary and older quoted people", () => {
  const m = message("Please look into this; cc stranger@example.net.\n\n" + source);
  const forward = supportForward(config, m)!;
  assert.equal(forward.by, config.owner);
  assert.equal(forward.request?.body, "The export is empty.");
  const thread = supportThread(config, id, [m])!;
  assert.equal(thread.forwarded, true);
  assert.equal(thread.from, "customer@example.org");
  assert.equal(thread.body, "The export is empty.");
  assert.equal(thread.messageId, "<outer@example.com>");
  assert.equal(thread.subject, "Fwd: Export");
  assert.deepEqual(thread.recipients, { to: ["customer@example.org"], cc: [] });
  assert.equal(thread.eligible, true);
  assert.equal(supportThread({ ...config, forwardSince: new Date(at + 1).toISOString() }, id, [m])!.eligible, false);
  assert.equal(supportThread({ ...config, forwarders: undefined }, id, [m]), null, "owner forwards remain opt-in");
});
test("an arbitrary forwarder, spoofed authentication and duplicate result headers never qualify an owner forward", () => {
  assert.equal(supportForward(config, message(source, { From: "other@example.com" })), undefined);
  for (const value of ["", "attacker.example; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com",
    auth.replace("dkim=pass", "dkim=fail"), auth.replace("dmarc=pass", "dmarc=fail"),
    auth.replace("header.i=@example.com", "header.i=@attacker.example"), auth.replace("header.from=example.com", "header.from=attacker.example")]) {
    const m = message(source, { "Authentication-Results": value });
    assert.equal(supportForward(config, m)?.request, null);
    assert.equal(supportThread(config, id, [m])!.recipients, null);
  }
  const duplicate = message();
  duplicate.payload!.headers!.push({ name: "Authentication-Results", value: auth });
  assert.equal(supportForward(config, duplicate)?.request, null);
  const alias = message(source, { From: "owner@another.example", "Authentication-Results": auth.replaceAll("example.com", "another.example") });
  assert.equal(supportForward(config, alias)?.request?.headers.from, "customer@example.org");
});
test("ambiguous or incomplete envelopes are held without selecting a later apparently valid envelope", () => {
  for (const body of ["Please read customer@example.org in my signature.",
    source.replace("From: Customer <customer@example.org>", "From: one@example.org, two@example.org"),
    source.replace("Date: Tue, 3 Nov 2026\n", ""), source.replace("Subject: Export", "Subject: Export\nTo: attacker@example.net"),
    source.replace("Cc: Colleague", "Bcc: hidden@example.net\nCc: Colleague"),
    source.replace("Cc: Colleague <colleague@example.org>, help@example.com", "Cc: broken address"),
    source.replace("From: Customer <customer@example.org>", "From: malformed") + "\n\n" + source,
    source + "x".repeat(65_536)]) assert.equal(supportForward(config, message(body))?.request, null);
  const auto = supportThread(config, id, [message(source.replace("customer@example.org", "noreply@example.org"))])!;
  assert.equal(auto.recipients, null);
  assert.equal(supportThread(config, id, [message(source, { "Auto-Submitted": "auto-generated" })]), null);
  assert.equal(supportConfigSchema.safeParse({ ...config, forwardSince: undefined }).success, false);
});
test("Outlook separators and folded recipients identify the original sender without including copied recipients", () => {
  const outlook = "Please investigate.\n________________________________\nFrom: Customer <customer@example.org>\nSent: Tue, 3 Nov 2026\nTo: Owner <owner@example.com>; Other <other@example.org>\nCc: Colleague <colleague@example.org>;\n  Last <last@example.org>\nSubject: Export\n\nThe export is empty.";
  const result = supportThread(config, id, [message(outlook)])!;
  assert.deepEqual(result.recipients, { to: ["customer@example.org"], cc: [] });
  assert.equal(result.body, "The export is empty.");
});
test("normal inbox reads retain quote exclusion and never promote attached message text", () => {
  const m = message();
  assert.equal(messageText(m.payload!), "---------- Forwarded message ---------");
  assert.ok(messageBody(m.payload!).includes("From: Customer"));
  const attachment: MailMessage = { ...m, payload: { ...m.payload, mimeType: "multipart/mixed", body: undefined, parts: [
    { mimeType: "text/plain", body: { data: Buffer.from("Please check the attached message.").toString("base64url") } },
    { mimeType: "message/rfc822", parts: [m.payload!] },
  ] } };
  assert.equal(supportForward(config, attachment)?.request, null);
  attachment.payload!.parts!.shift();
  assert.equal(messageText(attachment.payload!), "");
});
test("enabling a forwarding address preserves ordinary mail, owner exclusions and historical receipt recovery", () => {
  assert.equal(supportThread(config, id, [message("Please check the export.", { Subject: "Export" })]), null, "ordinary owner mail stays excluded");
  const incoming = message("Please check the export.", { From: "owner@another.example", Subject: "Export" });
  const thread = supportThread(config, id, [incoming])!;
  assert.equal(thread.forwarded, undefined);
  assert.equal(thread.from, "owner@another.example");
  const sent = message("Automated response from Support\nThanks for your email. We've received it.\nA person from our team will respond shortly.\nSupport", {
    From: config.account, To: "owner@another.example", "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All",
    "X-Projects-Support-Receipt": "2", "In-Reply-To": "<outer@example.com>", "Message-ID": "<sent@example.com>",
  });
  sent.labelIds = ["SENT"]; sent.internalDate = String(at + 1);
  const recovered = supportThread(config, id, [incoming, sent])!;
  assert.equal(recovered.acknowledgedAt, at + 1);
  assert.equal(recovered.humanRepliedAt, undefined);
});

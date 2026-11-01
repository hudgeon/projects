import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgmentRaw, automatic, mailbox, readSupport, supportThread } from "./support-gmail";
import { messageKey } from "./mail-identity";
import { acknowledgmentText, type SupportConfig } from "../src/support-model";
const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [], since: "2026-11-01T00:00:00Z", acknowledge: true };
const at = Date.parse("2026-11-02T00:00:00Z"), id = "1234567890abcdef";
const message = (when = at, extra: Record<string, string> = {}, sent = false) => ({
  id, internalDate: String(when), labelIds: sent ? ["SENT"] : ["INBOX"],
  payload: { mimeType: "text/plain", headers: Object.entries({ From: sent ? "help@example.com" : "Customer <customer@example.org>", Subject: "Export problem", "Message-ID": "<original@example.org>", ...extra }).map(([name, value]) => ({ name, value })), body: { data: Buffer.from("Our export is empty.").toString("base64url") } },
});
test("support uses the external request, while an automatic acknowledgment never becomes a human reply", () => {
  const first = supportThread(config, id, [message()])!;
  const receiptId = `<projects-support-${first.key}@example.com>`;
  const received = supportThread(config, id, [message(), message(at + 1000, { "Auto-Submitted": "auto-replied", "Message-ID": receiptId }, true)])!;
  assert.equal(received.body, "Our export is empty.");
  assert.equal(received.humanRepliedAt, undefined);
  assert.equal(received.acknowledgedAt, at + 1000);
  assert.deepEqual(received.messageKeys, [messageKey("<original@example.org>"), messageKey(receiptId)]);
  const human = supportThread(config, id, [message(), message(at + 2000, { "Message-ID": "<human@example.com>" }, true)])!;
  assert.equal(human.humanRepliedAt, at + 2000);
  assert.equal(human.eligible, false);
  const followup = supportThread(config, id, [message(), message(at + 2000, {}, true), message(at + 3000, { "Message-ID": "<followup@example.org>" })])!;
  assert.equal(followup.eligible, true);
  assert.equal(followup.at, at + 3000);
});
test("old mail, bounces, lists, automation, malformed recipients and missing Message-IDs cannot trigger replies", () => {
  assert.equal(supportThread(config, id, [message(at - 7 * 86400_000)])!.eligible, false);
  const suppressed: Record<string, string>[] = [{ "auto-submitted": "auto-generated" }, { "list-id": "list" }, { precedence: "bulk" }, { "return-path": "<>" }, { from: "noreply@example.org" }];
  for (const h of suppressed) assert.equal(automatic(h), true);
  assert.equal(supportThread({ ...config, acknowledgeSince: new Date(at + 1).toISOString() }, id, [message()])!.eligible, false);
  assert.equal(supportThread(config, id, [message(at, { "Auto-Submitted": "auto-replied" })]), null);
  assert.equal(supportThread(config, id, [message(at, { "Message-ID": "" })])!.eligible, false);
  assert.equal(supportThread(config, id, [message(at, { "Reply-To": "one@example.org, two@example.org" })])!.to, null);
  assert.equal(mailbox("Name <customer@example.org>"), "customer@example.org");
  for (const header of ["one@example.org, two@example.org", "one@example.org, Two <two@example.org>", "<one@example.org> extra", "https://one@example.org/path", "one@example.org\r\nBcc: other@example.org"]) assert.equal(mailbox(header), null);
  assert.equal(mailbox('"Customer, Example" <customer@example.org>'), "customer@example.org");
  assert.equal(messageKey("invalid"), undefined);
});
test("acknowledgment names the automation, threads as support and replies only to the sender", () => {
  const thread = supportThread(config, id, [message()])!;
  const raw = Buffer.from(acknowledgmentRaw(config, thread, acknowledgmentText("your export is empty"), "<ack@example.com>"), "base64url").toString();
  assert.match(raw, /From: Support <help@example.com>/);
  assert.match(raw, /To: customer@example.org/);
  assert.match(raw, /In-Reply-To: <original@example.org>/);
  assert.match(raw, /Auto-Submitted: auto-replied/);
  assert.doesNotMatch(raw, /^Cc:/m);
  const body = Buffer.from(raw.split("\r\n\r\n")[1].trim(), "base64").toString();
  assert.match(body, /^Automated response from Support/);
  assert.match(body, /person from our team will respond shortly/);
});
test("a wrong mailbox or incomplete Gmail inventory never becomes a clean empty support queue", async () => {
  await assert.rejects(readSupport(config, async () => JSON.stringify({ emailAddress: "another@example.com" })), /identity/);
  const result = await readSupport(config, async args => args.includes("getProfile") ? JSON.stringify({ emailAddress: config.account }) : JSON.stringify({ threads: [], nextPageToken: "more" }));
  assert.equal(result.complete, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgmentRaw, automatic, readSupport, sentAcknowledgment, supportThread } from "./support-gmail";
import type { DeliveryReport } from "./mail-delivery";
import { mailbox, messageKey } from "./mail-identity";
import { acknowledgmentText as draftText, type SupportConfig } from "../src/support-model";
const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [], since: "2026-11-01T00:00:00Z", acknowledge: true };
const acknowledgmentText = (summary: string) => `Automated response from Support\n\nThanks for your email. We understand that ${summary}.\n\nWe're looking into it, and a person from our team will respond shortly.\n\nSupport`;
const at = Date.parse("2026-11-02T00:00:00Z"), id = "1234567890abcdef";
const message = (when = at, extra: Record<string, string> = {}, sent = false) => ({
  id, internalDate: String(when), labelIds: sent ? ["SENT"] : ["INBOX"],
  payload: { mimeType: "text/plain", headers: Object.entries({ From: sent ? "help@example.com" : "Customer <customer@example.org>", Subject: "Export problem", "Message-ID": "<original@example.org>", ...extra }).map(([name, value]) => ({ name, value })), body: { data: Buffer.from("Our export is empty.").toString("base64url") } },
});
test("support uses the external request, while an automatic acknowledgment never becomes a human reply", () => {
  const first = supportThread(config, id, [message()])!;
  const receiptId = `<projects-support-${first.key}@example.com>`;
  const receipt = message(at + 1000, { "Auto-Submitted": "auto-replied", "Message-ID": receiptId, "X-Auto-Response-Suppress": "All", "In-Reply-To": "<original@example.org>", To: "customer@example.org" }, true);
  receipt.payload.body.data = Buffer.from(acknowledgmentText("your export is empty")).toString("base64url");
  const received = supportThread(config, id, [message(), receipt])!;
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
  assert.equal(supportThread(config, id, [message(at, { To: "one@example.org, broken address" })])!.recipients, null);
  assert.deepEqual(supportThread(config, id, [message(at, { "Reply-To": "other@example.org" })])!.recipients, { to: ["customer@example.org"], cc: [] });
  assert.equal(mailbox("Name <customer@example.org>"), "customer@example.org");
  for (const header of ["one@example.org, two@example.org", "one@example.org, Two <two@example.org>", "<one@example.org> extra", "https://one@example.org/path", "one@example.org\r\nBcc: other@example.org"]) assert.equal(mailbox(header), null);
  assert.equal(mailbox('"Customer, Example" <customer@example.org>'), "customer@example.org");
  assert.equal(messageKey("invalid"), undefined);
});
test("acknowledgment names the automation and threads as support", () => {
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
test("reply-all excludes a recipient whose linked delivery report is in a separate Gmail conversation", async () => {
  const reportId = "abcdef0123456789";
  const original = message(at - 1000, { "Message-ID": "<earlier@example.com>" }, true);
  const request = message(at, { To: config.account, Cc: "owner@example.com, lost@example.org" });
  const report = { id: reportId, internalDate: String(at + 1000), payload: { mimeType: "multipart/report", parts: [
    { mimeType: "message/delivery-status", body: { data: Buffer.from("Reporting-MTA: dns; mx.example.com\r\n\r\nFinal-Recipient: rfc822; lost@example.org\r\nAction: failed\r\nStatus: 5.1.1").toString("base64url") } },
    { mimeType: "text/rfc822-headers", body: { data: Buffer.from("Message-ID: <earlier@example.com>\r\n").toString("base64url") } },
  ] } };
  let reportReads = 0;
  const run = async (args: string[]) => {
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    if (args.includes("getProfile")) return JSON.stringify({ emailAddress: config.account });
    if (args[2] === "threads" && args[3] === "list") return JSON.stringify({ threads: [{ id }] });
    if (args[2] === "threads") return JSON.stringify({ id, messages: [original, request] });
    if (args[3] === "list") {
      assert.equal(params.includeSpamTrash, true);
      return JSON.stringify({ messages: [{ id: reportId }] });
    }
    reportReads++;
    return JSON.stringify(report);
  };
  const cache = new Map<string, DeliveryReport>();
  const read = await readSupport(config, run, cache);
  assert.equal(read.complete, true);
  assert.deepEqual(read.threads[0].recipients, { to: ["customer@example.org"], cc: ["owner@example.com"] });
  const raw = Buffer.from(acknowledgmentRaw(config, read.threads[0], acknowledgmentText("the export is empty"), "<ack@example.com>"), "base64url").toString();
  assert.match(raw, /^Cc: owner@example.com\r?$/m);
  assert.doesNotMatch(raw, /lost@example.org/);
  assert.equal((await readSupport(config, run, cache)).complete, true);
  assert.equal(reportReads, 1, "immutable report content is cached while every scan rechecks the inventory");
});
test("Gmail-rewritten Message-IDs reconcile through the actual labelled Sent reply without accepting unrelated mail", async () => {
  const receipt = message(at + 1000, { "Message-ID": "<rewritten@mail.example.com>", "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All", "In-Reply-To": "<original@example.org>", To: "customer@example.org" }, true);
  receipt.payload.body.data = Buffer.from(acknowledgmentText("your export is empty").replaceAll("\n", "\r\n")).toString("base64url");
  const received = supportThread(config, id, [message(), receipt])!;
  assert.equal(received.acknowledgedAt, at + 1000);
  assert.equal(received.humanRepliedAt, undefined);
  const get = async (args: string[]) => {
    assert.deepEqual(args.slice(0, 4), ["gmail", "users", "threads", "get"]);
    assert.equal(JSON.parse(args[args.indexOf("--params") + 1]).id, id);
    return JSON.stringify({ id, messages: [message(), receipt] });
  };
  assert.equal(await sentAcknowledgment(get, config, received), true);
  for (const changed of [{ From: "other@example.com" }, { To: "other@example.org" }, { "In-Reply-To": "<other@example.org>" }, { "Auto-Submitted": "no" }, { "X-Auto-Response-Suppress": "" }]) {
    const unrelated = structuredClone(receipt);
    for (const [name, value] of Object.entries(changed)) unrelated.payload.headers = [...unrelated.payload.headers.filter(h => h.name !== name), { name, value }];
    assert.equal(supportThread(config, id, [message(), unrelated])!.acknowledgedAt, undefined);
  }
  const notice = structuredClone(receipt);
  notice.payload.body.data = Buffer.from("A different automated notice").toString("base64url");
  assert.equal(supportThread(config, id, [message(), notice])!.acknowledgedAt, undefined);
  const notSent = { ...receipt, labelIds: ["INBOX"] };
  assert.equal(supportThread(config, id, [message(), notSent])!.acknowledgedAt, undefined);
  await assert.rejects(sentAcknowledgment(async () => JSON.stringify({ id: "wrong", messages: [message(), receipt] }), config, received), /Invalid support/);
});
test("a wrong mailbox or incomplete Gmail inventory never becomes a clean empty support queue", async () => {
  await assert.rejects(readSupport(config, async () => JSON.stringify({ emailAddress: "another@example.com" })), /identity/);
  const result = await readSupport(config, async args => args.includes("getProfile") ? JSON.stringify({ emailAddress: config.account }) : JSON.stringify({ threads: [], nextPageToken: "more" }));
  assert.equal(result.complete, false);
});
test("the new reviewed receipt is recognized only after send; an unsent draft never becomes delivery or a human reply", () => {
  const reply = message(at + 1000, { From: config.account, To: "customer@example.org", "Message-ID": "<draft@example.com>", "In-Reply-To": "<original@example.org>", "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All", "X-Projects-Support-Receipt": "2" }, true);
  reply.payload.body.data = Buffer.from(draftText({ kind: "other", excerpt: "", area: "other" })).toString("base64url");
  const unsent = { ...reply, labelIds: ["DRAFT"] };
  const pending = supportThread(config, id, [message(), unsent])!;
  assert.equal(pending.acknowledgedAt, undefined);
  assert.equal(pending.humanRepliedAt, undefined);
  assert.deepEqual(pending.draftMessages, [id]);
  const sent = supportThread(config, id, [message(), reply])!;
  assert.equal(sent.acknowledgedAt, at + 1000);
  assert.equal(sent.humanRepliedAt, undefined);
  assert.equal(supportThread({ ...config, draftSince: new Date(at + 1).toISOString() }, id, [message()])!.eligible, false);
});
test("a reviewed draft with an authenticated verification link retains automated attribution after manual send", () => {
  const reply = message(at + 1000, { From: config.account, To: "customer@example.org", "Message-ID": "<draft@example.com>", "In-Reply-To": "<original@example.org>", "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All", "X-Projects-Support-Receipt": "2" }, true);
  reply.payload.body.data = Buffer.from(draftText({ kind: "issue", excerpt: "Our export is empty.", area: "export" }, "https://source.example.com/support-investigation/19464d92-efbc-4117-a280-4c3834125b5c")).toString("base64url");
  const result = supportThread(config, id, [message(), reply])!;
  assert.equal(result.acknowledgedAt, at + 1000);
  assert.equal(result.humanRepliedAt, undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { failedRecipients, deliveryReport, replyRecipients, type MailMessage } from "./mail-delivery";
import { mailboxes } from "./mail-identity";
const data = (text: string) => Buffer.from(text).toString("base64url");
const original: MailMessage = { id: "original", internalDate: "1000", payload: { headers: [{ name: "Message-ID", value: "<request@example.org>" }] } };
const dsn = (reference = "<request@example.org>", status = "Action: failed\r\nStatus: 5.1.1\r\nFinal-Recipient: rfc822; lost@example.org") => ({
  id: "dsn", internalDate: "2000", payload: { mimeType: "multipart/report", parts: [
    { mimeType: "text/plain", body: { data: data("Delivery failed") } },
    { mimeType: "message/delivery-status", body: { data: data("Reporting-MTA: dns; mail.example.com\r\n\r\n" + status) } },
    { mimeType: "text/rfc822-headers", body: { data: data("Message-ID: " + reference + "\r\nFrom: customer@example.org\r\n") } },
  ] },
});
test("reply-all keeps original To/Cc roles, quoted names and the copied owner while removing self, duplicates and failed recipients", () => {
  assert.deepEqual(mailboxes('"Example, Customer" <first@example.org>, second@example.org'), ["first@example.org", "second@example.org"]);
  assert.deepEqual(mailboxes("first@example.org,\r\n second@example.org"), ["first@example.org", "second@example.org"]);
  for (const invalid of ["ok@example.org,", "ok@example.org, bad address", "Group: x@example.org;", 'Unclosed " <x@example.org>', "x@example.org\r\nBcc: other@example.org"])
    assert.equal(mailboxes(invalid), null);
  const recipients = replyRecipients({ account: "help@example.com", aliases: ["alias@example.com"] }, {
    from: "Customer <customer@example.org>", to: 'help@example.com, "Example, First" <first@example.org>, lost@example.org',
    cc: "owner@example.com, FIRST@example.org, alias@example.com, other@example.org",
    "reply-to": "redirect@example.net",
  }, new Set(["lost@example.org"]));
  assert.deepEqual(recipients, { to: ["customer@example.org", "first@example.org"], cc: ["owner@example.com", "other@example.org"] });
  assert.equal(replyRecipients({ account: "help@example.com", aliases: [] }, { from: "customer@example.org", cc: "malformed address" }, new Set()), null);
});
test("delivery failures are per recipient and per exact conversation, including reports in another Gmail thread", () => {
  const failure = dsn();
  assert.deepEqual([...failedRecipients([original, failure]).addresses], ["lost@example.org"]);
  assert.deepEqual([...failedRecipients([original], [deliveryReport(failure)]).addresses], ["lost@example.org"]);
  assert.equal(failedRecipients([original], [deliveryReport(dsn("<different@example.org>"))]).addresses.size, 0);
  const multiple = dsn(undefined, "Final-Recipient: rfc822; good@example.org\r\nAction: delivered\r\nStatus: 2.0.0\r\n\r\nFinal-Recipient: rfc822;\r\n lost@example.org\r\nAction: failed\r\nStatus: 5.1.1");
  assert.deepEqual([...deliveryReport(multiple).failed], ["lost@example.org"]);
  const delayed = dsn(undefined, "Final-Recipient: rfc822; later@example.org\r\nAction: delayed\r\nStatus: 4.2.0");
  assert.deepEqual([...deliveryReport(delayed).failed], ["later@example.org"]);
  assert.equal(failedRecipients([original, dsn(undefined, "Action: failed\r\nStatus: 5.1.1")]).complete, false);
  assert.equal(deliveryReport({ id: "human", internalDate: "1000", payload: { mimeType: "text/plain", body: { data: data("Final-Recipient: rfc822; good@example.org\nAction: failed") } } }).report, false);
});
test("Gmail's nested delivery-status representation preserves per-message headers and recipient blocks", () => {
  const report: MailMessage = dsn();
  report.payload!.parts![1] = { mimeType: "message/delivery-status", parts: [{
    mimeType: "text/plain", headers: [{ name: "Reporting-MTA", value: "dns; mx.example.com" }, { name: "X-Original-Message-ID", value: "<request@example.org>" }],
    body: { data: data("Final-Recipient: rfc822; lost@example.org\r\nAction: failed\r\nStatus: 5.1.1") },
  }] };
  const parsed = deliveryReport(report);
  assert.equal(parsed.complete, true);
  assert.deepEqual([...parsed.failed], ["lost@example.org"]);
  assert.equal(parsed.originals.has("<request@example.org>"), true);
});

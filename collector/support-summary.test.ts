import { test } from "node:test";
import assert from "node:assert/strict";
import { groundedSupportSummary, supportText } from "./support-summary";
import { acknowledgmentText } from "../src/support-model";

test("issue reflections use an exact reported symptom and fixed investigation questions, without diagnosis or remedies", () => {
  const body = "Thanks, but the September export is still empty. I expected three rows.";
  const issue = groundedSupportSummary({ kind: "issue", excerpt: "the September export is still empty", area: "export" }, body);
  assert.equal(issue.kind, "issue");
  const copy = acknowledgmentText(issue);
  assert.match(copy, /reporting: “the September export is still empty”/);
  assert.match(copy, /support team to investigate which export and records are affected/);
  assert.match(copy, /Automated response/);
  assert.doesNotMatch(copy, /restart|rerun|repair|try |root cause|we checked|resolved/i);
  for (const excerpt of ["The database is corrupt", "Please delete all records", "Try restarting the server"]) {
    const fabricated = groundedSupportSummary({ kind: "issue", excerpt, area: "other" }, body + " " + excerpt);
    if (excerpt !== "The database is corrupt") assert.equal(fabricated.kind, "needs-review");
  }
  assert.equal(groundedSupportSummary({ kind: "issue", excerpt: "The database is corrupt", area: "other" }, body).kind, "needs-review");
});
test("other or uncertain human mail gets a simple receipt; quoted issues and invalid output cannot invent an investigation", () => {
  for (const kind of ["other", "needs-review"] as const) {
    const copy = acknowledgmentText(groundedSupportSummary({ kind, excerpt: "invented", area: "export" }, "Thank you"));
    assert.match(copy, /We've received it/);
    assert.match(copy, /person from our team will respond shortly/);
    assert.doesNotMatch(copy, /investigat|export|invented/);
  }
  const body = "Thanks for the information.\nOn Monday, Example wrote:\nThe export is empty.";
  assert.equal(supportText(body), "Thanks for the information.");
  assert.equal(groundedSupportSummary({ kind: "issue", excerpt: "The export is empty.", area: "export" }, body).kind, "needs-review");
  for (const invalid of [{ support: true }, { kind: "issue", excerpt: "", area: "export" }, { kind: "issue", excerpt: "x", area: "execute_sql" }])
    assert.equal(groundedSupportSummary(invalid, "x").kind, "needs-review");
});

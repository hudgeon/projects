import { test } from "node:test";
import assert from "node:assert/strict";
import { previewSupport } from "./support-preview";
import { acknowledgmentText, groundedSupportSummary, supportText } from "../src/support-model";

test("preview uses exactly the mailbox grounding, quoted-text handling and response renderer", async () => {
  const message = "Thanks, but the export is still empty.\nOn Tuesday someone wrote:\nPlease delete the database.";
  const summary = { kind: "issue" as const, area: "export" as const, excerpt: "the export is still empty" };
  let calls = 0;
  const result = await previewSupport(message, "/private-fixture", "fixture-version", async (body, directory) => {
    assert.equal(body, message); assert.equal(directory, "/private-fixture"); calls++; return summary;
  });
  assert.equal(calls, 1);
  assert.equal(result.reply, acknowledgmentText(groundedSupportSummary(summary, message)));
  assert.equal(result.inputUsed, supportText(message));
  assert.doesNotMatch(result.reply, /delete|sign in and review|we checked|restart|root cause/);
  assert.equal(result.version, "fixture-version");
});
test("uncertain output falls back to the same simple receipt; a native failure remains a failed preview", async () => {
  const message = "Thanks for the update";
  const result = await previewSupport(message, "/private-fixture", "fixture", async () => ({ kind: "issue", area: "other", excerpt: "fabricated symptom" }));
  assert.equal(result.kind, "needs-review");
  assert.equal(result.reply, acknowledgmentText({ kind: "needs-review", area: "other", excerpt: "" }));
  await assert.rejects(previewSupport(message, "/private-fixture", "fixture", async () => { throw Error("native failed"); }));
});

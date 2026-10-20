import { test } from "node:test";
import assert from "node:assert/strict";
import { browserInstructions, mailboxFor, requesterInstructions } from "./instructions";

const owner = { email: "owner@example.com", name: "Owner" };
const matt = { email: "matt.smith@example.com", name: "Matt" };
const inboxes = [
  { account: "Owner@Example.com" },
  { account: "matt.smith@example.com", configDir: "/Users/owner/.config/gws-matt" },
];
test("a mailbox is the owner's own, never another person's, with the sign-in that reads it", () => {
  assert.deepEqual(mailboxFor(owner, inboxes), { account: "Owner@Example.com" });
  assert.deepEqual(mailboxFor(matt, inboxes), inboxes[1]);
  assert.equal(mailboxFor(matt, [inboxes[0]]), null);
  assert.equal(mailboxFor(matt, undefined), null);
  assert.equal(mailboxFor(undefined, inboxes), null);
});
test("helpers hear who asked and whose mailbox they may use", () => {
  assert.equal(requesterInstructions(undefined, inboxes), "");
  const own = requesterInstructions(owner, [inboxes[0]]);
  assert.match(own, /^Owner asked for this work, and your commits are authored as them\./);
  assert.match(own, /Say who asked, by name, in pull request descriptions and work-record comments/);
  assert.match(own, /Owner's email is in Owner@Example\.com; use gws for it, which is signed in as that account/);
  const other = requesterInstructions(matt, [inboxes[0]]);
  assert.match(other, /^Matt asked for this work/);
  assert.match(other, /No mailbox is connected for Matt on this machine: gws has no sign-in in this session/);
  assert.doesNotMatch(other, /owner@example\.com/i, "another person's mailbox is never named");
  const connected = requesterInstructions(matt, inboxes);
  assert.match(connected, /Matt's email is in matt\.smith@example\.com; use gws/);
  assert.doesNotMatch(connected, /gws-matt|Owner@Example/, "the sign-in's directory reaches the environment, not the prompt");
});
test("a browser's instructions say how it signs in to Projects", () => {
  const endpoint = "wss://projects.example.com/api/browser/x/cdp";
  assert.match(browserInstructions(endpoint, matt, "owner"), /It starts signed in to Projects as Matt\./);
  assert.match(browserInstructions(endpoint, matt, "not_allowed"), /It cannot sign in to Projects: Matt's address is not allowed to sign in there/);
  for (const text of [browserInstructions(endpoint, matt, "manual"), browserInstructions(endpoint)]) {
    assert.doesNotMatch(text, /signed in to Projects as|cannot sign in/);
    assert.match(text, /Open browser \/ sign in/);
  }
});

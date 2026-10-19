import { test } from "node:test";
import assert from "node:assert/strict";
import { browserInstructions, mailboxFor, requesterInstructions } from "./instructions";

const owner = { email: "owner@example.com", name: "Owner" };
const matt = { email: "matt.smith@example.com", name: "Matt" };
test("a mailbox is the owner's own, never another person's", () => {
  assert.equal(mailboxFor(owner, "Owner@Example.com"), "Owner@Example.com");
  assert.equal(mailboxFor(matt, "owner@example.com"), null);
  assert.equal(mailboxFor(matt, undefined), null);
  assert.equal(mailboxFor(undefined, "owner@example.com"), null);
});
test("helpers hear who asked and whose mailbox they may use", () => {
  assert.equal(requesterInstructions(undefined, "owner@example.com"), "");
  const own = requesterInstructions(owner, "owner@example.com");
  assert.match(own, /^Owner asked for this work, and your commits are authored as them\./);
  assert.match(own, /Say who asked, by name, in pull request descriptions and work-record comments/);
  assert.match(own, /Owner's email is in owner@example\.com; use gws/);
  const other = requesterInstructions(matt, "owner@example.com");
  assert.match(other, /^Matt asked for this work/);
  assert.match(other, /No mailbox is connected for Matt on this machine/);
  assert.doesNotMatch(other, /owner@example\.com/, "another person's mailbox is never named");
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { personInstructions, quickInstructions } from "./master-instructions";

const owner = { email: "owner@example.com", name: "Owner" };
const matt = { email: "matt.smith@example.com", name: "Matt" };
const inboxes = [{ account: "owner@example.com" }];
test("the coordinator is told whose conversation it is", () => {
  assert.equal(personInstructions(undefined), "");
  const text = personInstructions(matt);
  assert.match(text, /This conversation is Matt's \(matt\.smith@example\.com\)/);
  assert.match(text, /"the user" in these instructions is Matt/);
  assert.match(text, /Helpers' commits are authored as Matt/);
  assert.match(text, /pull request descriptions and work-record comments say so/);
});
test("the email lane works in the owner's own mailbox, or says none is connected for them", () => {
  assert.match(quickInstructions({ inboxes, person: owner }), /Owner's email is in owner@example\.com, which the Codex Gmail connector cannot reach; use gws, which is signed in as that account in this session\./);
  const other = quickInstructions({ inboxes, person: matt });
  assert.match(other, /No mailbox is connected for Matt on this machine/);
  assert.match(other, /never using another person's mailbox/);
  assert.doesNotMatch(other, /owner@example\.com/);
  assert.match(quickInstructions({ person: matt }), /No mailbox is connected for Matt/);
  const connected = quickInstructions({ inboxes: [...inboxes, { account: "matt.smith@example.com", configDir: "/Users/owner/.config/gws-matt" }], person: matt });
  assert.match(connected, /Matt's email is in matt\.smith@example\.com/);
  assert.doesNotMatch(connected, /owner@example\.com|gws-matt/);
  // A claim from before people were handed over names the machine's own inbox, as before.
  assert.match(quickInstructions({ inboxes }), /Inbox email is in owner@example\.com/);
  assert.match(quickInstructions({}), /Inbox email is in the configured inbox/);
});

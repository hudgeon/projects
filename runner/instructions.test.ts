import { test } from "node:test";
import assert from "node:assert/strict";
import { browserInstructions, connectorInstructions, helperInstructions, mailboxFor, progressInstructions, requesterInstructions, responseInstructions, workInstructions } from "./instructions";
import { masterInstructions } from "./master-instructions";

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
test("every helper and turn instruction names the person once known, and reads as before until then", () => {
  const named = [connectorInstructions(matt), progressInstructions(matt), responseInstructions(matt), workInstructions("acme/work", 7, matt), helperInstructions("codex", false, matt)].join("\n");
  for (const phrase of ["need Matt's approval of each message", "a progress summary for Matt", "until Matt acts", "Matt sees the first remaining item", "Write summaries for Matt", "Matt reads them in Projects", "what Matt needs", "When Matt has to act", "give Matt a saved draft link", "expand Matt's scope", "Matt's corrections take precedence", "from Matt or ask"])
    assert.ok(named.includes(phrase), phrase);
  assert.doesNotMatch(named, /\bthe user\b|user-facing|User corrections/);
  assert.match(browserInstructions("wss://projects.example.com/api/browser/x/cdp", matt, "manual"), /yourMove asks Matt to use Open browser/);
  const plain = [connectorInstructions(), progressInstructions(), responseInstructions(), workInstructions("acme/work", 7), helperInstructions("claude")].join("\n");
  for (const phrase of ["need the user's approval", "a progress summary for the user", "The user sees the first remaining item", "Write summaries for the user", "The user reads them", "When the user has to act", "expand the user's scope", "User corrections take precedence", "from the user or ask"])
    assert.ok(plain.includes(phrase), phrase);
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
test("helpers follow a Claude background task with Monitor or its output file, with no polling workaround left", () => {
  const text = helperInstructions("claude");
  assert.match(text, /For Claude background tasks, follow output with Monitor or by reading the task's output file, and stop a task with TaskStop\./);
  assert.doesNotMatch(text, /TaskOutput|empty output file|If no status tool is offered/);
});
test("helpers and the master keep searches out of the home folder and ~/Library", () => {
  for (const text of [helperInstructions("claude"), helperInstructions("codex"), helperInstructions("codex", true), masterInstructions()]) {
    assert.match(text, /Never search the whole home folder or ~\/Library/);
    assert.match(text, /Use a skill by its name from your skill list rather than searching for its files\./);
  }
});

test("routine drafts keep source reads and verification in one helper without weakening send approval", () => {
  const text = masterInstructions(owner);
  assert.match(text, /one helper the source read, drafting and saved-draft verification together/);
  assert.match(text, /wording revisions or recipient corrections/);
  assert.match(text, /send still needs Owner's explicit approval of that message/);
});

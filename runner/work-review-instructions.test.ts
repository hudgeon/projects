import { test } from "node:test";
import assert from "node:assert/strict";
import { workReviewInstructions } from "./work-review-instructions";

test("the daily reconciliation records evidence it cannot reach as a gap instead of asking the owner to sign in", () => {
  assert.match(workReviewInstructions, /^This is the owner's daily work-record reconciliation/);
  for (const phrase of [
    "Evidence this conversation cannot reach is a recorded gap, never the owner's job",
    "a page behind a sign-in this browser lacks",
    "leave its dates where they were",
    "Do not set yourMove, end blocked or ask the owner to sign in somewhere, paste a message or fetch evidence",
    "a sign-in made in this browser ends with it, so the next cycle would only ask again",
    "never turn an unreadable source into one",
  ]) assert.ok(workReviewInstructions.includes(phrase), phrase);
  // The owner is asked only for decisions, never for a blocker the cycle could record.
  assert.doesNotMatch(workReviewInstructions, /surface only a concrete blocker/);
  assert.match(workReviewInstructions, /surface only a decision that needs the owner/);
});

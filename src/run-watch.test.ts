import { test } from "node:test";
import assert from "node:assert/strict";
import { statusLine, watchText } from "./run-text";
import { awaitsYou, type Run } from "./run-model";

const MIN = 60_000, now = 10 * 60 * MIN;
test("a wait reads as what it waits on and for how long; signs of a stuck one say which", () => {
  assert.equal(watchText({since: now - 9 * MIN, on: "command", label: "checks"}, now), "Waiting on CI checks · 9 min");
  assert.equal(watchText({since: now - 3 * MIN, on: "command"}, now), "Running a command · 3 min");
  assert.equal(watchText({since: now - 3 * MIN, on: "tool"}, now), "Waiting on a tool call · 3 min");
  assert.equal(watchText({since: now - 2 * MIN, on: "agent"}, now), "No word from the agent · 2 min");
  assert.equal(watchText({since: now - 14 * MIN, on: "command", label: "loop", stuck: "idle", quietSince: now - 23 * MIN}, now), "May be stuck: what it is waiting on has used no CPU for 23 min");
  assert.equal(watchText({since: now - 11 * MIN, on: "agent", stuck: "silent", quietSince: now - 11 * MIN}, now), "May be stuck: no word from the agent for 11 min");
});

test("a conversation that may be stuck says so in its status and waits on the owner", () => {
  const run = {state: "running", generation: 1, messages: [], progress: {seq: 1, state: "running", summary: "Working", children: [], masterSessionId: null,
    live: {actor: "claude", childId: null, at: 1, watch: {since: Date.now() - 12 * MIN, on: "command", stuck: "idle", quietSince: Date.now() - 12 * MIN}}}} as unknown as Run;
  assert.equal(statusLine(run), "What it is waiting on has used no CPU for 12 min", "the row's label already says it may be stuck");
  assert.equal(awaitsYou({state: "running", stuck: true}), true);
  assert.equal(awaitsYou({state: "running", stuck: false}), false);
});

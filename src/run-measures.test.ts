import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitsYou, type Run } from "./run-model";
import { runMeasures } from "./run-measures";
const run = (): Run => ({id: "id", projectId: null, agent: "auto", workIssue: null, owner: "owner@example.com", generation: 1, state: "blocked", createdAt: 1000, updatedAt: 9999, heartbeatAt: 0, progress: null,
  messages: [{id: "request", role: "user", text: "Do this", at: 1000}, {id: "reply", role: "master", text: "Need approval", at: 61000}]});
test("Done history never counts as current work needing its owner", () => {
  assert.equal(awaitsYou({...run(), archivedAt: 80000}), false);
  assert.equal(awaitsYou(run()), true);
});
test("request-to-reply measures use messages, not heartbeat or archival timestamps; follow-ups are not labelled corrections", () => {
  const r = run(); r.archivedAt = 900000;
  assert.equal(runMeasures(r).firstReplyMs, 60000);
  assert.equal(runMeasures(r).latestReplyMs, 60000);
  assert.equal(runMeasures(r).usageObserved, false);
  r.messages.push({id: "approval", role: "user", text: "Approved", at: 71000});
  assert.equal(runMeasures(r).latestReplyMs, null);
  assert.equal(runMeasures(r).followUps, 1);
});

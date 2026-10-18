import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { executeRun } from "./engine";
import type { Progress, RunMessage } from "../src/run-model";
import { result, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("the user's feedback reaches the agent working now, the live view follows it, and the master still reviews it", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [];
  const later: RunMessage = {id: randomUUID(), role: "user", text: "Use the blue button", at: Date.now(), delivery: "queued"};
  let current = [...o.run.messages], masters = 0;
  const delivered: string[] = [];
  o.latestMessages = () => current;
  o.messages = async () => current;
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.changes = async () => ({files: [{path: "src/button.tsx", added: 3, removed: 1}], total: {files: 1, added: 3, removed: 1}, at: Date.now()});
  o.liveChangesMs = 20;
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? {...dispatch(), task: {...dispatch().task!, mode: "change" as const}} : complete;
    opts.onPlan?.([{step: "Make the change", status: "active"}]);
    // Let a progress report carry the live view before the user writes.
    for (let i = 0; i < 100 && !reports.some((r) => r.live?.changes); i++) await new Promise((r) => setTimeout(r, 50));
    return new Promise((resolve) => {
      opts.onSteer?.(async (input) => { delivered.push(input.text); resolve(result); });
      current = [...current, later];
    });
  };
  try {
    await executeRun(o);
    assert.match(delivered[0], /Use the blue button/);
    assert.ok(reports.some((r) => r.steeredMessageIds?.includes(later.id)), "the Worker hears it reached the agent");
    assert.ok(reports.some((r) => r.live?.actor === "claude" && r.live.plan?.[0]?.step === "Make the change" && r.live.changes?.total.files === 1), "the live view shows the plan and changes");
    const last = reports.at(-1)!;
    assert.ok(last.reviewedMessageIds?.includes(later.id), "the master reviewed it at its next decision");
    assert.equal(last.live, undefined, "no live view once work stops");
    assert.equal(masters, 2);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("feedback that reaches the master mid-decision is part of that decision", {timeout: 15000}, async () => {
  const dir = await fixture(), o = engineOptions(dir);
  const later: RunMessage = {id: randomUUID(), role: "user", text: "Make it short", at: Date.now(), delivery: "queued"};
  let current = [...o.run.messages], masters = 0, latest: Progress | undefined;
  o.latestMessages = () => current;
  o.messages = async () => current;
  o.report = async (p) => { latest = structuredClone(p); };
  o.turn = async (opts) => {
    masters++;
    await opts.onSession(randomUUID());
    return new Promise((resolve) => {
      opts.onSteer?.(async () => resolve(complete));
      current = [...current, later];
    });
  };
  try {
    await executeRun(o);
    assert.equal(masters, 1, "no second decision just to reread it");
    assert.ok(latest?.reviewedMessageIds?.includes(later.id));
    assert.equal(latest?.state, "completed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("feedback during a child is reviewed by the same master before completion", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    reports: Progress[] = [];
  let messages = [...o.run.messages],
    masterCount = 0;
  const feedback: RunMessage = {
    id: randomUUID(),
    role: "user",
    text: "Also explain the rollback",
    at: Date.now(),
    delivery: "queued",
  };
  o.messages = async () => structuredClone(messages);
  o.report = async (p) => {
    reports.push(structuredClone(p));
  };
  o.turn = async (opts) => {
    await opts.onSession("master-session");
    if (opts.agent === "claude") {
      messages.push(feedback);
      return result;
    }
    if (++masterCount === 1) return dispatch();
    assert.match(opts.prompt, /Also explain the rollback/);
    assert.equal(opts.sessionId, "master-session");
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(masterCount, 2);
    assert.equal(reports.at(-1)?.state, "completed");
    assert.ok(reports.at(-1)?.reviewedMessageIds?.includes(feedback.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback arriving during a master decision prevents that obsolete dispatch", async () => {
  const dir = await fixture(),
    o = engineOptions(dir);
  let messages = [...o.run.messages],
    calls = 0,
    prepared = false;
  o.messages = async () => structuredClone(messages);
  o.prepare = async () => {
    prepared = true;
    throw Error("obsolete action must not run");
  };
  o.turn = async (opts) => {
    if (++calls === 1) {
      messages.push({
        id: randomUUID(),
        role: "user",
        text: "Just give me the explanation",
        at: Date.now(),
        delivery: "queued",
      });
      return dispatch();
    }
    assert.match(opts.prompt, /NOT been executed/);
    assert.match(opts.prompt, /Just give me the explanation/);
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(calls, 2);
    assert.equal(prepared, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

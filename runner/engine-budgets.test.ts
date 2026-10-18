import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NativeOptions } from "./native";
import { contextConversation, executeRun, savePrivate, MASTER_INPUT_CHAR_LIMIT, HANDOVER_CHAR_LIMIT } from "./engine";
import type { Progress, RunMessage } from "../src/run-model";
import { result, makeRun, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

test("quick work gives the master a light prompt without the repository activity dump", async () => {
  const dir = await fixture(),
    o = engineOptions(dir, {...makeRun(), lane: "quick"});
  o.inboxAccount = "owner@example.com";
  o.workRepo = "acme/work";
  o.activity = [{host: "studio", projects: [{id: "acme/test", sessions: ["ACTIVITY-MARKER"]}]}];
  const prompts: string[] = [];
  o.turn = async (opts) => {
    prompts.push(opts.prompt);
    await opts.onSession(randomUUID());
    return complete;
  };
  try {
    await executeRun(o);
    assert.match(prompts[0], /email lane/);
    assert.match(prompts[0], /owner@example\.com/);
    assert.match(prompts[0], /list's own unsubscribe mechanism/);
    assert.match(prompts[0], /cannot reach; use gws/);
    assert.doesNotMatch(prompts[0], /For a reply|draft helper/);
    assert.doesNotMatch(prompts[0], /ACTIVITY-MARKER|Activity observations/);
    const standard = engineOptions(dir);
    standard.activity = o.activity;
    standard.turn = o.turn;
    await executeRun(standard);
    assert.match(prompts[1], /ACTIVITY-MARKER/, "standard work keeps the activity check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("activity is bounded, published during native work, and ordered with the final receipt", async () => {
  const dir = await fixture(),
    o = engineOptions(dir),
    reports: Progress[] = [];
  let activityDelivered!: () => void;
  let activityFailed!: (error: Error) => void;
  const activityPublished = new Promise<void>((resolve, reject) => {
    activityDelivered = resolve;
    activityFailed = reject;
  });
  o.report = async (p) => {
    await new Promise((r) => setTimeout(r, 10));
    reports.push(structuredClone(p));
    if (p.state === "running" && p.activity?.length === 40) activityDelivered();
  };
  o.turn = async (opts) => {
    assert.match(opts.prompt, /PROJECTS_PROGRESS/);
    for (let i = 0; i < 15; i++)
      opts.onProgress?.({
        done: [`Step ${i}`],
        remaining: ["Verify"],
        blocker: null,
      });
    for (let i = 0; i < 65; i++)
      opts.onActivity?.({ kind: "tool", state: "started" });
    // Wait for delivery, not a fixed margin after the runner's flush interval:
    // a busy CI host can finish the fsync/upload after that margin has elapsed.
    const timeout = setTimeout(
      () =>
        activityFailed(
          Error("Activity was not delivered during the native turn"),
        ),
      15_000,
    );
    try {
      await activityPublished;
    } finally {
      clearTimeout(timeout);
    }
    assert.ok(
      reports.some((p) => p.state === "running" && p.activity?.length === 40),
    );
    opts.onActivity?.({ kind: "tool", state: "finished" });
    return complete;
  };
  try {
    await executeRun(o);
    assert.equal(reports.at(-1)?.state, "completed");
    assert.equal(reports.at(-1)?.activity?.length, 40);
    assert.equal(reports.at(-1)?.activity?.at(-1)?.state, "finished");
    assert.equal(reports.at(-1)?.activity?.at(-1)?.actor, "master");
    assert.equal(reports.at(-1)?.notes?.length, 12);
    assert.ok(
      reports.some((p) => p.state === "running" && p.notes?.length === 12),
    );
    assert.equal(reports.at(-1)?.notes?.at(-1)?.actor, "master");
    assert.ok(reports.every((p, i) => i === 0 || p.seq > reports[i - 1].seq));
    const j = JSON.parse(
      await readFile(path.join(dir, "runs", o.run.id + ".json"), "utf8"),
    );
    assert.deepEqual(j.progress, reports.at(-1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conversation totals its coordinator's and each helper's tokens, and telemetry keeps the counts", async () => {
  const dir = await fixture(), o = engineOptions(dir);
  let last: Progress | undefined, masters = 0;
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") {
      opts.onUsage?.({fresh: 100, cached: 900, output: 10, context: 500});
      opts.onUsage?.({fresh: 200, cached: 1800, output: 20, context: 900});
      return result;
    }
    opts.onUsage?.({fresh: 50, cached: 0, output: 5, context: 50});
    return ++masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    assert.deepEqual(last!.masterUsage, {fresh: 100, cached: 0, output: 10, turns: 2, context: 50});
    assert.deepEqual(last!.children[0].usage, {fresh: 200, cached: 1800, output: 20, turns: 1, context: 900});
    const finished = last!.telemetry!.filter((e) => e.event === "native_finished");
    assert.deepEqual(finished.map((e) => [e.actor, e.freshTokens, e.cachedTokens, e.outputTokens]), [["master", 50, 0, 5], ["claude", 200, 1800, 20], ["master", 50, 0, 5]]);
    // A follow-up's turns add to the same totals.
    await executeRun({...o, run: {...o.run, generation: 2, progress: last!}});
    assert.deepEqual(last!.masterUsage, {fresh: 150, cached: 0, output: 15, turns: 3, context: 50});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("long conversation handovers bound prompt history and retain exact authority on disk", () => {
  const messages: RunMessage[] = Array.from({length: 80}, (_, i) => ({id: randomUUID(), role: "user", text: `${i}: ${"instruction ".repeat(700)}`, at: i}));
  const handoff = contextConversation(messages);
  assert.equal(handoff.userInstructions[0], messages[0]);
  assert.equal(handoff.userInstructions.at(-1), messages.at(-1));
  assert.ok(handoff.omittedUserInstructions > 0);
  assert.ok(handoff.userInstructions.reduce((n, m) => n + m.text.length, 0) <= HANDOVER_CHAR_LIMIT);
});

test("prompt budget rotates across follow-ups without usage reports or replaying children", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [], reports: Progress[] = [];
  const master = randomUUID();
  let masters = 0;
  o.report = async p => { reports.push(structuredClone(p)); };
  o.turn = async opts => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? (masters ? randomUUID() : master));
    if (opts.agent === "claude") return result;
    if (!masters) opts.onUsage?.({fresh: 100, cached: 10, output: 5, context: 0});
    return ++masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    const file = path.join(dir, "runs", `${o.run.id}.coordinator.json`);
    const coordinator = JSON.parse(await readFile(file, "utf8"));
    await savePrivate(file, {...coordinator, inputChars: MASTER_INPUT_CHAR_LIMIT});
    const before = reports.at(-1)!;
    const followUp: RunMessage = {id: randomUUID(), role: "user", text: "Continue within the existing draft-only approval.", at: Date.now()};
    await executeRun({...o, run: {...o.run, generation: 2, progress: before, messages: [...o.run.messages, followUp]}});
    const next = calls.filter(c => c.agent === "codex").at(-1)!;
    assert.equal(next.sessionId, undefined);
    assert.match(next.prompt, /Continue within the existing draft-only approval/);
    assert.match(next.prompt, /Observed fixture HEAD/);
    assert.equal(calls.filter(c => c.agent === "claude").length, 1);
    assert.ok(reports.some(p => p.summary === "Continuing with earlier context."));
    assert.equal(reports.at(-1)!.children[0].sessionId, before.children[0].sessionId);
    assert.equal(reports.at(-1)!.masterUsage!.fresh, 100, "cumulative usage survives rotation");
    assert.ok(JSON.parse(await readFile(file, "utf8")).inputChars < MASTER_INPUT_CHAR_LIMIT);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("more than forty user messages keep bounded durable receipts and resume without old prompt replay", async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [], calls: NativeOptions[] = [];
  o.run.messages = Array.from({length: 65}, (_, i) => ({id: randomUUID(), role: "user", text: `Request ${i}`, at: i}));
  o.report = async p => { reports.push(structuredClone(p)); };
  o.turn = async opts => { calls.push(opts); await opts.onSession(opts.sessionId ?? randomUUID()); return complete; };
  try {
    await executeRun(o);
    assert.ok(reports.every(p => (p.reviewedMessageIds?.length ?? 0) <= 40));
    const acknowledged = new Set(reports.flatMap(p => p.reviewedMessageIds ?? []));
    assert.equal(acknowledged.size, 65);
    assert.equal(reports.at(-1)!.state, "completed");
    // The persisted coordinator must remember beyond its old 400-ID window.
    const file = path.join(dir, "runs", `${o.run.id}.coordinator.json`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    const extras: RunMessage[] = Array.from({length: 450}, (_, i) => ({id: randomUUID(), role: "master", text: `Reply ${i}`, at: i}));
    await savePrivate(file, {...saved, seen: [], through: o.run.messages.length + extras.length});
    assert.ok(saved.seen.length <= 400);
    const fresh: RunMessage = {id: randomUUID(), role: "user", text: "LATEST REQUEST", at: Date.now()};
    await executeRun({...o, run: {...o.run, generation: 2, progress: reports.at(-1)!, messages: [...o.run.messages.map(m => ({...m, delivery: "reviewed" as const})), ...extras, fresh]}});
    assert.match(calls.at(-1)!.prompt, /LATEST REQUEST/);
    assert.doesNotMatch(calls.at(-1)!.prompt, /Request 0|Reply 0/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

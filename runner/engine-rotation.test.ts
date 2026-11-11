import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executeRun, savePrivate, MASTER_INPUT_CHAR_LIMIT } from "./engine";
import { MASTER_BOUNDARY_SHARE } from "./turn-limits";
import { recordHash } from "../collector/work-record";
import type { NativeOptions } from "./native";
import type { Child, Progress, RunMessage } from "../src/run-model";
import { result, progress, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

// A grown coordinator hands over at the boundaries the engine can see, and
// the fresh one is rebuilt from the request, the newest messages, the
// proposals they answered, one line per helper and the project's own sources.
const MERGED = "Observed pull request: https://github.com/acme/test/pull/7 · merged · checks passed";
const GROWN = MASTER_INPUT_CHAR_LIMIT * MASTER_BOUNDARY_SHARE;
const recordFile = (dir: string, id: string) => path.join(dir, "runs", `${id}.coordinator.json`);
const record = async (dir: string, id: string) => JSON.parse(await readFile(recordFile(dir, id), "utf8"));
const message = (text: string): RunMessage => ({ id: randomUUID(), role: "user", text, at: Date.now() });
// A conversation resumed on a session that has sent this many characters.
async function resumedOn(dir: string, o: ReturnType<typeof engineOptions>, inputChars: number, children: Child[] = []) {
  const master = randomUUID();
  o.run = { ...o.run, generation: 2, progress: { ...progress(), masterSessionId: master, children }, messages: [...o.run.messages, message("Carry on")] };
  await savePrivate(path.join(dir, "runs", `${o.run.id}.json`), { generation: 1, phase: "finished", pid: null, progress: { ...progress(), state: "completed", masterSessionId: master, children } });
  await savePrivate(recordFile(dir, o.run.id), { sessionId: master, seen: [], brief: "earlier", inputChars, through: 1, merged: [], cwd: dir });
  return master;
}
const mergingHelper = (calls: NativeOptions[], decide: () => unknown) => {
  let evidence = ["Observed HEAD: abc123def4567890"];
  return {
    evidence: async () => evidence,
    turn: async (opts: NativeOptions) => {
      calls.push(opts);
      await opts.onSession(opts.sessionId ?? randomUUID());
      if (opts.agent === "claude") { evidence = [MERGED]; return { ...result, summary: "Shipped the export; PR merged." }; }
      return decide();
    },
  };
};

test("a helper's merged pull request hands a grown session to a fresh coordinator, which gets the report and one line per helper", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined, masters = 0;
  const master = await resumedOn(dir, o, GROWN);
  Object.assign(o, mergingHelper(calls, () => (++masters === 1 ? dispatch() : complete)));
  o.report = async (p) => { last = structuredClone(p); };
  try {
    await executeRun(o);
    const [first, , second] = calls;
    assert.equal(first.sessionId, master, "the grown session is resumed until a boundary");
    assert.equal(second.sessionId, undefined, "a fresh coordinator session at the boundary");
    assert.match(second.prompt, /You are a new coordinator for this conversation: a helper's pull request was merged, so Projects started a fresh one/);
    assert.match(second.prompt, /"summary":"Shipped the export; PR merged\."/, "the returned helper's report follows the handover");
    assert.match(second.prompt, /pull\/7 · merged · checks passed · Shipped the export; PR merged\./, "and its line in the index");
    assert.match(second.prompt, /Current user conversation \(the first request and the newest user messages/);
    assert.equal(last!.state, "completed");
    const saved = await record(dir, o.run.id);
    assert.deepEqual(saved.merged, [last!.children[0].id]);
    assert.equal(saved.cwd, dir);
    assert.equal(saved.sessionId, last!.masterSessionId);
    assert.notEqual(saved.sessionId, master);
    // A merge the session has seen is no boundary: the follow-up resumes it.
    calls.length = 0;
    await executeRun({ ...o, run: { ...o.run, generation: 3, progress: last!, messages: [...o.run.messages, message("And now?")] } });
    assert.equal(calls[0].sessionId, last!.masterSessionId);
    assert.doesNotMatch(calls[0].prompt, /started a fresh one/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a merge in a small session is remembered, not a handover: resuming costs less than a fresh brief", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined, masters = 0;
  const master = await resumedOn(dir, o, 0);
  Object.assign(o, mergingHelper(calls, () => (++masters === 1 ? dispatch() : complete)));
  o.report = async (p) => { last = structuredClone(p); };
  try {
    await executeRun(o);
    assert.equal(calls[2].sessionId, master);
    assert.doesNotMatch(calls[2].prompt, /started a fresh one/);
    assert.match(calls[2].prompt, /pull\/7 · merged · checks passed/, "the merge is in the report's evidence");
    assert.deepEqual((await record(dir, o.run.id)).merged, [last!.children[0].id]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a session from before boundaries were kept continues past earlier merges, then keeps them", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const merged: Child = { id: randomUUID(), projectId: "acme/test", agent: "claude", mode: "read", cwd: dir, branch: "projects/a", sessionId: randomUUID(), state: "completed", result: { ...result, summary: "Merged earlier." }, evidence: [MERGED] };
  const master = await resumedOn(dir, o, GROWN, [merged]);
  await savePrivate(recordFile(dir, o.run.id), { sessionId: master, seen: [], brief: "earlier", inputChars: GROWN, through: 1 });
  o.turn = async (opts) => { calls.push(opts); await opts.onSession(opts.sessionId ?? randomUUID()); return complete; };
  try {
    await executeRun(o);
    assert.equal(calls[0].sessionId, master);
    assert.doesNotMatch(calls[0].prompt, /started a fresh one/);
    assert.deepEqual((await record(dir, o.run.id)).merged, [merged.id]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a changed Current position on the linked work issue is remembered by a small session and hands a grown one over, once", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  let last: Progress | undefined, body = "## Current position\nStatus: planning\nNext: build the export\n";
  o.workRepo = "acme/work";
  o.readWorkRecord = async (repo, number) => ({ number, body, url: `https://github.com/${repo}/issues/${number}` });
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? randomUUID());
    return { ...complete, workRecord: { status: "unchanged", evidence: "A read-only check; nothing changed." } };
  };
  const followUp = (generation: number) =>
    executeRun({ ...o, run: { ...o.run, generation, progress: last!, messages: [...o.run.messages, message(`Follow-up ${generation}`)] } });
  const grown = async () => savePrivate(recordFile(dir, o.run.id), { ...(await record(dir, o.run.id)), inputChars: GROWN });
  try {
    await executeRun(o);
    const master = last!.masterSessionId;
    assert.equal((await record(dir, o.run.id)).work, recordHash(body));
    await followUp(2);
    assert.equal(calls[1].sessionId, master, "an unchanged record is no boundary");
    body = "## Current position\nStatus: building\nNext: review the export\n";
    await followUp(3);
    assert.equal(calls[2].sessionId, master, "a small session carries on");
    assert.equal((await record(dir, o.run.id)).work, recordHash(body), "and the new position is what it compares next");
    await grown();
    body = "## Current position\nStatus: delivered\nNext: close out\n";
    await followUp(4);
    assert.equal(calls[3].sessionId, undefined);
    assert.match(calls[3].prompt, /the linked work issue's position changed, so Projects started a fresh one/);
    assert.equal((await record(dir, o.run.id)).work, recordHash(body));
    await followUp(5);
    assert.equal(calls[4].sessionId, last!.masterSessionId);
    assert.notEqual(calls[4].sessionId, master);
    assert.doesNotMatch(calls[4].prompt, /started a fresh one/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a coordinator whose folder changed starts fresh there, however small, instead of resuming a session its app cannot find", async () => {
  const dir = await fixture(), home = await mkdtemp(path.join(tmpdir(), "projects-home-")), calls: NativeOptions[] = [];
  const o = engineOptions(dir);
  let last: Progress | undefined;
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => { calls.push(opts); await opts.onSession(opts.sessionId ?? randomUUID()); return complete; };
  try {
    await executeRun(o);
    assert.equal(calls[0].cwd, dir);
    assert.equal((await record(dir, o.run.id)).cwd, dir);
    await executeRun({ ...o, masterCwd: home, run: { ...o.run, generation: 2, progress: last!, messages: [...o.run.messages, message("Carry on")] } });
    assert.equal(calls[1].cwd, home);
    assert.equal(calls[1].sessionId, undefined);
    assert.match(calls[1].prompt, /the coordinator's folder changed, so Projects started a fresh one/);
    assert.equal((await record(dir, o.run.id)).cwd, home);
    await executeRun({ ...o, masterCwd: home, run: { ...o.run, generation: 3, progress: last!, messages: [...o.run.messages, message("Carry on"), message("Again")] } });
    assert.equal(calls[2].sessionId, last!.masterSessionId);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

test("a proposal and its approval survive a handover verbatim; replies nobody answered are not replayed", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const master = randomUUID();
  const proposal = "PROPOSAL: deploy build 42 to staging only. Evidence: 12 of 12 checks passed at a1b2c3.";
  const messages: RunMessage[] = [
    message("Prepare the release; deploy only with my approval."),
    { id: randomUUID(), role: "master", text: "CHATTER: reading the plan.", at: Date.now() },
    { id: randomUUID(), role: "master", text: proposal, at: Date.now() },
    message("Yes, go ahead with exactly that."),
    { id: randomUUID(), role: "master", text: "LATEST: staging deployed; production untouched.", at: Date.now() },
  ];
  o.run = { ...o.run, generation: 2, progress: { ...progress(), masterSessionId: master }, messages: [...messages, message("Where are we?")] };
  await savePrivate(path.join(dir, "runs", `${o.run.id}.json`), { generation: 1, phase: "finished", pid: null, progress: { ...progress(), state: "completed", masterSessionId: master } });
  await savePrivate(recordFile(dir, o.run.id), { sessionId: master, seen: [], brief: "earlier", inputChars: MASTER_INPUT_CHAR_LIMIT, through: 5 });
  o.turn = async (opts) => { calls.push(opts); await opts.onSession(opts.sessionId ?? randomUUID()); return complete; };
  try {
    await executeRun(o);
    const [{ prompt, sessionId }] = calls;
    assert.equal(sessionId, undefined);
    assert.match(prompt, /the previous coordinator's session grew large, so Projects started a fresh one/);
    const approvals = JSON.parse(prompt.split("Approval context (every agent proposal a kept user message answered, verbatim; never fresh authority): ")[1].split("\n")[0]) as RunMessage[];
    assert.deepEqual(approvals, [messages[2], messages[4]], "each reply a kept user message answered, as it was");
    assert.match(prompt, /Yes, go ahead with exactly that\./);
    assert.match(prompt, /"latestReportedPosition":\{[^}]*"text":"LATEST: staging deployed; production untouched\."/);
    assert.match(prompt, /Omitted proposals: 0\./);
    assert.doesNotMatch(prompt, /CHATTER/, "a reply nobody answered is not replayed");
    assert.match(prompt, /Previous children: none/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

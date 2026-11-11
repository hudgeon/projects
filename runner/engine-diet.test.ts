// What a native turn's prompt carries: standing instructions once for each
// session, a brief only when it changed, a returned helper as its summary and
// pointers, and the screenshots a task needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeScreenshots } from "../src/screenshot-model";
import type { NativeOptions } from "./native";
import { executeRun, savePrivate } from "./engine";
import { REPORT_CHARS } from "./child-report";
import { STANDING_APPLY } from "./session-memory";
import type { Child, Progress, RunMessage } from "../src/run-model";
import { result, progress, fixture, complete, dispatch, engineOptions } from "./run-fixtures";

const STANDING = [/Write summaries for the user in Markdown/, /PROJECTS_PROGRESS \{/];
const HELPER = [/Work only on this assigned task/, /Search only inside your working folder/, /Bigger work is recorded in GitHub issues/];
const carries = (prompt: string, patterns: RegExp[]) => patterns.filter((pattern) => pattern.test(prompt)).length;
const browser = { endpoint: "wss://projects.example.com/api/browser/test/cdp", capability: "fixture-scoped-browser-capability", outputDir: "/tmp" };

test("a native session is told its standing instructions once; a resumed turn carries its task and what is new", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  o.workRepo = "acme/work";
  o.run.workIssue = null;
  const master = randomUUID(), helper = randomUUID();
  let last: Progress | undefined, tasks = 0, dispatched = false, grant: typeof browser | undefined, compacts = false;
  o.report = async (p) => { last = structuredClone(p); };
  o.browser = async () => grant;
  o.prepare = async (_project, task, previous) => ({ cwd: dir, branch: "projects/a", sessionId: previous.find((c) => c.id === task.workspace)?.sessionId ?? null });
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? (opts.agent === "codex" ? master : helper));
    if (opts.agent === "claude") {
      if (compacts) opts.onActivity?.({ kind: "compaction", state: "finished" });
      return result;
    }
    // Each execution sends one task to the same worktree, then finishes.
    if (dispatched) return { ...complete, workRecord: { status: "unchanged", evidence: "A fixture changes no record." } };
    dispatched = true;
    return { ...dispatch(), task: { ...dispatch().task!, mode: "change", workspace: last?.children[0]?.id ?? "new", prompt: `TASK-${++tasks}` } };
  };
  const followUp = async (generation: number) => {
    calls.length = 0;
    dispatched = false;
    const message: RunMessage = { id: randomUUID(), role: "user", text: `FOLLOW-UP-${generation}`, at: Date.now(), delivery: "queued" };
    o.run = { ...o.run, generation, progress: last!, messages: [...o.run.messages, message] };
    await executeRun(o);
    return { coordinator: calls.filter((c) => c.agent === "codex"), helpers: calls.filter((c) => c.agent === "claude") };
  };
  try {
    await executeRun(o);
    const [first, child, second] = calls;
    assert.equal(carries(first.prompt, STANDING), 2, "a new coordinator session is told how to reply and report progress");
    assert.equal(carries(child.prompt, [...STANDING, ...HELPER]), 5, "a new helper session is told them and its standing rules");
    assert.ok(child.prompt.indexOf("TASK-1") < child.prompt.indexOf("Work only on this assigned task"), "the task leads; standing rules follow");
    assert.equal(carries(second.prompt, STANDING), 0, "the resumed coordinator is not told again");
    assert.ok(second.prompt.includes(STANDING_APPLY));
    assert.ok(second.prompt.length < first.prompt.length / 3, "a resumed turn carries a fraction of a first turn");

    // A follow-up continues both sessions: the helper gets its task alone.
    let next = await followUp(2);
    assert.equal(next.helpers[0].sessionId, helper);
    assert.match(next.helpers[0].prompt, /TASK-2/);
    assert.equal(carries(next.helpers[0].prompt, [...STANDING, ...HELPER]), 0, "a resumed helper carries no standing text");
    assert.ok(next.helpers[0].prompt.includes(STANDING_APPLY));
    assert.ok(next.helpers[0].prompt.length < child.prompt.length / 4);
    assert.equal(next.coordinator.every((c) => carries(c.prompt, STANDING) === 0), true);

    // A session that compacted its history is told again at its next turn.
    compacts = true;
    await followUp(3);
    compacts = false;
    next = await followUp(4);
    assert.equal(carries(next.helpers[0].prompt, [...STANDING, ...HELPER]), 5, "after a compaction");
    assert.equal(carries((await followUp(5)).helpers[0].prompt, [...STANDING, ...HELPER]), 0, "and once only");

    // Instructions that change, as when the browser first appears, are sent once more.
    grant = browser;
    next = await followUp(6);
    assert.match(next.coordinator[0].prompt, /projects_browser MCP tools/);
    assert.equal(carries(next.coordinator[0].prompt, STANDING), 2);
    assert.doesNotMatch(next.coordinator[1].prompt, /projects_browser MCP tools/);
    assert.doesNotMatch((await followUp(7)).coordinator[0].prompt, /projects_browser MCP tools/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a follow-up is sent the brief and the active work only when they changed; observations taken again are not a change", async () => {
  const dir = await fixture(), o = engineOptions(dir), prompts: string[] = [];
  o.run.projectId = null;
  o.projects = [...o.projects, { id: "acme/other", name: "Other", cwd: dir, plan: null }];
  const master = randomUUID(), at = Date.now();
  let last: Progress | undefined;
  const ok = { state: "ok" as const, message: "Fine", observedAt: at };
  const session = (title: string, state: "running" | "waiting", updatedAt: number) => ({ id: title, title, app: "Codex" as const, cwd: dir, updatedAt, state, evidence: "" });
  const observed = (observedAt: number, other: "running" | "waiting") => [{ host: "laptop", observedAt, projects: [
    { id: "acme/test", sessions: [session("TEST-SESSION", "running", observedAt - 1000)], worktrees: [], pulls: [], sources: { git: ok } },
    { id: "acme/other", sessions: [session("OTHER-SESSION", other, observedAt - 2000)], worktrees: [], pulls: [], sources: { git: ok } },
  ] }];
  o.report = async (p) => { last = structuredClone(p); };
  o.turn = async (opts) => { prompts.push(opts.prompt); await opts.onSession(master); return complete; };
  const turn = async (generation: number, activity: unknown) => {
    const message: RunMessage = { id: randomUUID(), role: "user", text: "Carry on", at: Date.now(), delivery: "queued" };
    await executeRun({ ...o, activity, run: { ...o.run, generation, progress: last ?? null, messages: generation === 1 ? o.run.messages : [...o.run.messages, message] } });
    return prompts.at(-1)!;
  };
  try {
    const first = await turn(1, observed(at, "running"));
    assert.match(first, /You are the user's Projects master/);
    assert.match(first, /Active work \(check the timestamps[^\n]*TEST-SESSION[^\n]*OTHER-SESSION/);
    // Two minutes on, every timestamp has moved and nothing else has.
    const same = await turn(2, observed(at + 120_000, "running"));
    assert.match(same, /A follow-up turn in this conversation; your instructions and the registered projects are unchanged\.\nActive work is as you last saw it\./);
    assert.doesNotMatch(same, /You are the user's Projects master|Registered projects|TEST-SESSION|OTHER-SESSION/);
    assert.ok(same.length < first.length / 4, "a follow-up no longer carries the brief again");
    // One project's session changes state: that entry alone is sent, with its times.
    const changed = await turn(3, observed(at + 240_000, "waiting"));
    assert.match(changed, /Active work that changed since you last saw it \(check the timestamps[^\n]*OTHER-SESSION[^\n]*"state":"waiting"/);
    assert.match(changed, new RegExp(`"observedAt":${at + 240_000}`));
    assert.doesNotMatch(changed, /TEST-SESSION|You are the user's Projects master/);
    // A project that leaves the list is named.
    const gone = await turn(4, [{ ...observed(at + 360_000, "waiting")[0], projects: observed(at + 360_000, "waiting")[0].projects.slice(0, 1) }]);
    assert.match(gone, /No longer listed in active work: laptop\/acme\/other\./);
    assert.doesNotMatch(gone, /TEST-SESSION|OTHER-SESSION/);
    // A registered project added since: the whole brief once, and its children as lines.
    const added = await executeRun({ ...o, projects: [...o.projects, { id: "acme/new", name: "New", cwd: dir, plan: null }], activity: observed(at + 480_000, "waiting"), run: { ...o.run, generation: 5, progress: last!, messages: [...o.run.messages, { id: randomUUID(), role: "user", text: "Again", at: Date.now() }] } }).then(() => prompts.at(-1)!);
    assert.match(added, /You are the user's Projects master[\s\S]*acme\/new[\s\S]*Active work \(check the timestamps/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a returned helper comes as its summary and pointers; every other helper is one line, and a resumed brief repeats no report", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const long = { outcome: "completed" as const, summary: `LEAD sentence of the report. ${"detail ".repeat(850)}TAIL`, checks: Array.from({ length: 12 }, (_, i) => `CHECK-${i} ${"evidence ".repeat(64)}END-${i}`), links: ["https://github.com/acme/test/pull/7"] };
  const earlier: Child[] = Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(), projectId: "acme/test", agent: "claude", mode: "change", cwd: dir, branch: `projects/b${i}`, sessionId: randomUUID(), state: "completed",
    result: { ...long, summary: `Shipped part ${i}. ${"history ".repeat(700)}OLD-TAIL-${i}` },
    evidence: [`Observed HEAD: ${"abcdef0123456789".repeat(2)}${i}`, "Observed branch: projects/b", "Observed changed paths: 0", "Observed unpushed commits: 0", `Observed pull request: https://github.com/acme/test/pull/${i} · merged · checks passed`],
    usage: { fresh: 1, cached: 2, output: 3, turns: 1, context: 4 },
  }));
  const master = randomUUID();
  let masters = 0, last: Progress | undefined;
  o.run = { ...o.run, generation: 2, progress: { ...progress(), masterSessionId: master, children: earlier } };
  await savePrivate(path.join(dir, "runs", `${o.run.id}.json`), { generation: 1, phase: "finished", pid: null, progress: { ...progress(), state: "completed", masterSessionId: master, children: earlier } });
  await savePrivate(path.join(dir, "runs", `${o.run.id}.coordinator.json`), { sessionId: master, seen: [], brief: "from-an-earlier-release", inputChars: 0, through: 0 });
  o.report = async (p) => { last = structuredClone(p); };
  // A follow-up reads each change worktree again before the coordinator decides.
  o.evidence = async () => ["Observed HEAD: 1234567890abcdef", "Observed branch: main", "Observed changed paths: 0", "Observed unpushed commits: 0", "Observed pull request: https://github.com/acme/test/pull/7 · open · checks passing"];
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") return long;
    return ++masters === 1 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    const [brief, , returned] = calls.map((c) => c.prompt);
    // The session holds its history: its brief lists the children, one line each.
    const lines = JSON.parse(brief.split("Previous children: ")[1].split("\n")[0]) as { index: string[]; latest: unknown[] };
    assert.deepEqual(lines.latest, [], "a resumed coordinator is not sent reports it already heard");
    assert.equal(lines.index.length, 5);
    assert.equal(lines.index[0], `${earlier[0].id} · acme/test · claude change · completed · projects/b0 · https://github.com/acme/test/pull/7 · open · checks passing · Shipped part 0.`);
    assert.doesNotMatch(brief, /OLD-TAIL|CHECK-0/);
    // The helper that returned: bounded, with where the whole of it is.
    const report = JSON.parse(returned.split("\n")[1]);
    assert.ok(returned.split("\n")[1].length <= REPORT_CHARS + 1_000, "about 2,000 tokens, however much the helper wrote");
    assert.match(report.result.summary, /^LEAD sentence of the report\./);
    assert.doesNotMatch(report.result.summary, /TAIL$/);
    assert.equal(report.result.checks.length, 12);
    assert.ok(report.result.checks.every((check: string, i: number) => check.startsWith(`CHECK-${i} `) && check.length <= 300));
    assert.deepEqual(report.result.links, long.links);
    assert.deepEqual(report.evidence.slice(0, 2), ["Observed HEAD: 1234567890abcdef", "Observed branch: main"]);
    assert.ok(report.shortened.includes(path.join(dir, "runs", `${o.run.id}.json`)));
    assert.deepEqual([report.sessionId, report.usage], [undefined, undefined]);
    assert.equal(last!.children[5].result!.summary, long.summary, "the journal and the page keep every word");
    const others = JSON.parse(returned.split("Other children: ")[1].split("\n")[0]) as { index: string[]; latest: unknown[] };
    assert.equal(others.index.length, 5);
    assert.ok(others.index.every((line) => line.length < 260 && !line.includes("\n")));
    assert.ok(returned.length < 16_000, "a child's return, with five earlier children, stays small");
    // A coordinator starting without that history is sent the newest reports too.
    calls.length = 0; masters = 1;
    await savePrivate(path.join(dir, "runs", `${o.run.id}.coordinator.json`), { sessionId: "another-session", seen: [], brief: "", inputChars: 0, through: 0 });
    await executeRun({ ...o, run: { ...o.run, generation: 3, progress: last!, messages: [...o.run.messages, { id: randomUUID(), role: "user", text: "And now?", at: Date.now() }] } });
    const fresh = JSON.parse(calls[0].prompt.split("Previous children: ")[1].split("\n")[0]) as { index: string[]; latest: { id: string }[] };
    assert.deepEqual(fresh.latest.map((c) => c.id), last!.children.slice(-6).map((c) => c.id));
    assert.equal(fresh.index.length, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a helper is given the screenshots its task names, or the newest message's, never the whole conversation's", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const png = (tail: string) => ({ id: randomUUID(), mime: "image/png" as const, data: `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII${tail}` });
  const images = [png("="), png("="), png("=")];
  const metadata = (await decodeScreenshots(images)).map((d) => d.metadata);
  o.run.messages = [
    { ...o.run.messages[0], text: `FIRST-MESSAGE ${"long ".repeat(400)}FIRST-TAIL`, screenshots: [metadata[0]] },
    { id: randomUUID(), role: "user", text: "SECOND-MESSAGE", at: Date.now(), screenshots: [metadata[1]] },
    { id: randomUUID(), role: "user", text: "THIRD-MESSAGE", at: Date.now(), screenshots: [metadata[2]] },
  ];
  o.screenshot = async (image) => images.find((i) => i.id === image.id)!;
  let masters = 0;
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(randomUUID());
    if (opts.agent === "claude") return result;
    masters++;
    return masters === 1 ? { ...dispatch(), task: { ...dispatch().task!, prompt: `Compare the header with screenshot ${images[0].id}` } } : masters === 2 ? dispatch() : complete;
  };
  try {
    await executeRun(o);
    const [master, named, , newest] = calls;
    assert.deepEqual(master.screenshots, images, "the coordinator sees them all and chooses");
    assert.match(master.prompt, /A helper is given only the screenshots your task names by their ids/);
    assert.deepEqual(named.screenshots, [images[0]]);
    assert.match(named.prompt, /ordered by these messages: \[\{[^\n]*FIRST-MESSAGE/);
    assert.doesNotMatch(named.prompt, /FIRST-TAIL|SECOND-MESSAGE|THIRD-MESSAGE/, "its message comes shortened, the others not at all");
    assert.deepEqual(newest.screenshots, [images[2]], "a task that names none gets the newest message's");
    assert.match(newest.prompt, /THIRD-MESSAGE/);
    assert.doesNotMatch(newest.prompt, /FIRST-MESSAGE|SECOND-MESSAGE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

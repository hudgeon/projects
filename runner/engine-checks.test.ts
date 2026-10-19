import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executeRun } from "./engine";
import { JEV_MODEL } from "./context";
import type { Progress } from "../src/run-model";
import { result, fixture, complete, dispatch, engineOptions, waitFor } from "./run-fixtures";

test("a second dispatch is checked against the first helper's report, and a helper's progress note is rated, without changing the run", async () => {
  const dir = await fixture(), o = engineOptions(dir), checked: any[] = [];
  let masters = 0, helpers = 0;
  o.contextSelector = {mode: "select", key: async () => "fixture-key", fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.state.brief || body.state.notes) checked.push(body.state);
    return Response.json({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, {type: "noul", noul: 0.5}])), usage: {input_tokens: 50, output_tokens: 0}});
  }};
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") {
      masters++;
      if (masters === 1) return dispatch();
      if (masters === 2) return {...dispatch(), task: {...dispatch().task!, prompt: "Check the inspection again"}};
      return complete;
    }
    if (++helpers === 2) opts.onProgress?.({done: ["Looked again"], remaining: ["Report"], yourMove: null});
    return {...result, summary: helpers === 1 ? "Inspected the project." : "Checked it again."};
  };
  try {
    await executeRun(o);
    await waitFor(async () => (await readdir(path.join(dir, "run-checks")).catch(() => [])).length === 2, 5000);
    const repeat = checked.find((state) => state.brief)!, progress = checked.find((state) => state.notes)!;
    assert.equal(repeat.brief, "Check the inspection again");
    assert.deepEqual(repeat.reports.map((r: {summary: string}) => r.summary), ["Inspected the project."]);
    assert.deepEqual(progress.notes.map((n: {done: string[]}) => n.done), [["Looked again"]]);
    assert.equal(masters, 3, "the checks never changed a decision");
    const receipts = await Promise.all((await readdir(path.join(dir, "run-checks"))).map(async (f) => JSON.parse(await readFile(path.join(dir, "run-checks", f), "utf8"))));
    const journal = JSON.parse(await readFile(path.join(dir, "runs", `${o.run.id}.json`), "utf8"));
    const second = journal.progress.children[1].id;
    assert.deepEqual(receipts.map((r) => [r.kind, r.child]).sort(), [["progress", second], ["repeat", second]], "each receipt names the second helper");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a helper's long command the rules cannot place shows with Jev's label, and only redacted text is sent", async () => {
  const dir = await fixture(), o = engineOptions(dir), reports: Progress[] = [], commands: string[] = [];
  let masters = 0;
  o.limits = {showMs: 20, quietMs: 60_000, idleMs: 60_000, silentMs: 60_000, sampleMs: 10};
  o.report = async (p) => { reports.push(structuredClone(p)); };
  o.contextSelector = {mode: "select", key: async () => "fixture-key", fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.state.command) commands.push(body.state.command);
    // The fifth category is a deploy.
    return Response.json({model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, {type: "noul", noul: body.state.command && i === 4 ? 0.9 : 0.1}])), usage: {input_tokens: 50, output_tokens: 0}});
  }};
  o.turn = async (opts) => {
    await opts.onSession(randomUUID());
    if (opts.agent === "codex") return ++masters === 1 ? dispatch() : complete;
    await opts.onProcess?.(process.pid);
    opts.onActivity?.({kind: "command", state: "started"}, "RELEASE_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 ./scripts/release.sh");
    await waitFor(() => reports.some((p) => p.live?.watch?.label === "deploy"), 10_000);
    return result;
  };
  try {
    await executeRun(o);
    assert.deepEqual(commands, ["RELEASE_TOKEN=[redacted] ./scripts/release.sh"]);
    assert.doesNotMatch(JSON.stringify(reports), /release\.sh|ghp_/, "the command itself never reaches a report");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

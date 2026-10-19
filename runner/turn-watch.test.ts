import { test } from "node:test";
import assert from "node:assert/strict";
import { commandProcesses, cpuSeconds, watchTurn, type ProcessRow } from "./turn-watch";
import type { LiveWatch } from "../src/run-model";

const MIN = 60_000;
test("ps CPU times read as seconds", () => {
  assert.equal(cpuSeconds("0:00.04"), 0.04);
  assert.equal(cpuSeconds("12:34.56"), 754.56);
  assert.equal(cpuSeconds("1:02:03"), 3723);
  assert.equal(cpuSeconds("2-01:00:00"), 176400);
});

test("only what the agent's shells run counts as its commands", () => {
  const rows: ProcessRow[] = [
    {pid: 100, ppid: 1, cpu: 9, name: "claude"},
    {pid: 101, ppid: 100, cpu: 1, name: "node"}, // its browser's MCP server
    {pid: 102, ppid: 100, cpu: 0, name: "zsh"},
    {pid: 103, ppid: 102, cpu: 0, name: "codex"},
    {pid: 104, ppid: 102, cpu: 0, name: "sleep"},
    {pid: 105, ppid: 100, cpu: 0, name: "-zsh"},
    {pid: 106, ppid: 105, cpu: 0, name: "bash"},
    {pid: 107, ppid: 106, cpu: 2, name: "git"},
    {pid: 200, ppid: 1, cpu: 5, name: "codex"}, // someone else's
  ];
  assert.deepEqual(commandProcesses(rows, 100).map((row) => row.pid), [103, 107]);
});

function harness() {
  let clock = 1_000_000, rows: ProcessRow[] = [];
  const shown: (LiveWatch | undefined)[] = [], stuck: string[] = [];
  const w = watchTurn({
    pid: () => 100, now: () => clock, rows: async () => rows,
    limits: {sampleMs: 30_000},
    publish: (watch) => shown.push(watch), stuck: (reason) => stuck.push(reason),
  });
  const at = (minutes: number) => { clock = 1_000_000 + minutes * MIN; };
  const procs = (cpu: number, extra: ProcessRow[] = []) => {
    rows = [{pid: 100, ppid: 1, cpu: 1, name: "claude"}, {pid: 102, ppid: 100, cpu: 0, name: "zsh"}, {pid: 103, ppid: 102, cpu, name: "codex"}, ...extra];
  };
  return {w, at, procs, shown, stuck, start: 1_000_000};
}

test("a long command shows as a wait with its category, and one whose processes use CPU never looks stuck", async () => {
  const {w, at, procs, shown, stuck, start} = harness();
  try {
    procs(0);
    w.activity({kind: "command", state: "started"}, "tests");
    for (let m = 0; m <= 30; m++) { at(m); procs(m); await w.sample(); }
    assert.deepEqual(shown[0], {since: start, on: "command", label: "tests"});
    assert.ok(shown.every((watch) => !watch?.stuck), "busy tests are not stuck");
    assert.deepEqual(stuck, []);
    w.activity({kind: "command", state: "finished"});
    assert.equal(shown.at(-1), undefined, "the wait ends with the command");
  } finally { w.clear(); }
});

test("a wait whose processes use no CPU for ten minutes may be stuck, once per wait", async () => {
  const {w, at, procs, shown, stuck, start} = harness();
  try {
    procs(0);
    w.activity({kind: "command", state: "started"}, "review");
    for (let m = 0; m <= 9; m++) { at(m); await w.sample(); }
    assert.ok(!shown.at(-1)?.stuck);
    at(10); await w.sample();
    assert.deepEqual(shown.at(-1), {since: start, on: "command", label: "review", stuck: "idle", quietSince: start});
    at(12); await w.sample();
    assert.deepEqual(stuck, ["idle"]);
  } finally { w.clear(); }
});

test("a wait loop on a background command that sat idle for ten minutes may be stuck after three quiet minutes", async () => {
  const {w, at, procs, shown, stuck, start} = harness();
  try {
    // The review was started in the background; the agent kept working.
    procs(0);
    for (let m = 0; m <= 11; m++) { at(m); w.touch(); await w.sample(); }
    w.activity({kind: "command", state: "started"}, "loop");
    at(13); await w.sample();
    assert.ok(!shown.at(-1)?.stuck, "two quiet minutes are not enough");
    at(14); await w.sample();
    assert.deepEqual(shown.at(-1), {since: start + 11 * MIN, on: "command", label: "loop", stuck: "idle", quietSince: start});
    assert.deepEqual(stuck, ["idle"]);
  } finally { w.clear(); }
});

test("an agent with no tool call open shows as silent, may be stuck after ten minutes, and nothing is called idle without a process reading", async () => {
  const {w, at, shown, stuck, start} = harness();
  try {
    at(3); await w.sample();
    assert.deepEqual(shown.at(-1), {since: start, on: "agent"});
    at(10); await w.sample();
    assert.deepEqual(shown.at(-1), {since: start, on: "agent", stuck: "silent", quietSince: start});
    assert.deepEqual(stuck, ["silent"]);
  } finally { w.clear(); }
  let clock = 0;
  const blind: (LiveWatch | undefined)[] = [];
  const v = watchTurn({pid: () => 100, now: () => clock, rows: async () => { throw Error("ps failed"); }, publish: (watch) => blind.push(watch), stuck: () => {}});
  try {
    v.activity({kind: "command", state: "started"});
    clock = 20 * MIN; await v.sample();
    assert.equal(blind.at(-1)?.stuck, undefined);
  } finally { v.clear(); }
});

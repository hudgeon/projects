import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryAdmission, parseMemoryPressure, readMemoryPressure, type MemoryPressure } from "./memory-admission";

test("kernel pressure parsing accepts only the known levels", () => {
  assert.deepEqual(["1\n", "2", "4", "0", "", "normal", "secret"].map(parseMemoryPressure),
    ["normal", "warning", "critical", "unknown", "unknown", "unknown", "unknown"]);
});

test("sustained warning pauses starts; recovery needs thirty observed healthy seconds", async () => {
  let at = 0, pressure: MemoryPressure = "normal", reads = 0;
  const changes: string[] = [];
  const admit = memoryAdmission({now: () => at, read: async () => {reads++; return pressure;},
    changed: (state, level) => changes.push(`${state}:${level}`)});
  assert.equal(await admit(), true);
  at = 1000; pressure = "warning";
  assert.equal(await admit(), true);
  assert.equal(reads, 1, "claims share a bounded-rate observation");
  at = 5000; assert.equal(await admit(), true);
  at = 10_000; assert.equal(await admit(), true);
  at = 15_000; assert.equal(await admit(), false);
  pressure = "normal"; at = 20_000; assert.equal(await admit(), false);
  at = 45_000; assert.equal(await admit(), false);
  pressure = "warning"; at = 50_000; assert.equal(await admit(), false);
  pressure = "normal"; at = 55_000; assert.equal(await admit(), false);
  at = 85_000; assert.equal(await admit(), true);
  assert.deepEqual(changes, ["open:normal", "paused:warning", "open:normal"]);
});

test("critical and failed observations pause immediately, including at startup", async () => {
  for (const first of ["critical", "unknown", "throw"] as const) {
    let at = 0;
    const admit = memoryAdmission({now: () => at, read: async () => {
      if (at) return "normal";
      if (first === "throw") throw Error("private diagnostic");
      return first;
    }});
    assert.equal(await admit(), false);
    at = 5000; assert.equal(await admit(), false);
    at = 35_000; assert.equal(await admit(), true);
  }
});

test("a brief warning recovers without pausing; unsupported hosts keep the shared ceiling", async () => {
  let at = 0, pressure: MemoryPressure = "warning";
  const admit = memoryAdmission({now: () => at, read: async () => pressure});
  assert.equal(await admit(), true);
  at = 5000; pressure = "normal"; assert.equal(await admit(), true);
  at = 10_000; pressure = "warning"; assert.equal(await admit(), true);
  at = 15_000; pressure = "unsupported"; assert.equal(await admit(), true);
});

test("the host pressure reader returns a bounded category", async () => {
  assert.ok(["normal", "warning", "critical", "unknown", "unsupported"].includes(await readMemoryPressure()));
});

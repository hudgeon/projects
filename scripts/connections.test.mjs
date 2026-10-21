import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConnections } from "./connections.mjs";

// The installer's connection flags on their own, against a config in memory.
const apply = (config, ...args) => {
  const flags = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]] : []));
  const fail = (message) => {
    throw new Error(message);
  };
  applyConnections(config, { args, flags, expand: (value) => value, fail });
  return config.teams;
};

test("--teams adds a profile for each Teams organisation, and --remove-teams drops one or all of a person's", () => {
  const config = {};
  const first = "/nowhere/Projects-Teams", second = "/nowhere/Projects-Teams-2", other = "/nowhere/Colleague-Teams";
  assert.deepEqual(apply(config, "--teams", `owner@example.com=${first}`), [{ account: "owner@example.com", profileDir: first }]);
  assert.deepEqual(apply(config, "--teams", `owner@example.com=${second}`, "--teams", `colleague@example.com=${other}`), [
    { account: "owner@example.com", profileDir: first },
    { account: "owner@example.com", profileDir: second },
    { account: "colleague@example.com", profileDir: other },
  ]);
  // The same profile again, however its case is written, replaces its entry
  // rather than adding one; removing it matches the same way.
  assert.equal(apply(config, "--teams", `owner@example.com=${second}`).length, 3);
  assert.equal(apply(config, "--teams", `owner@example.com=${second.toLowerCase()}`).length, 3);
  assert.deepEqual(apply(config, "--remove-teams", `owner@example.com=${second.toUpperCase()}`).map((t) => t.profileDir), [first, other]);
  assert.deepEqual(apply(config, "--remove-teams", "Owner@example.com"), [{ account: "colleague@example.com", profileDir: other }]);
  assert.throws(() => apply(config, "--remove-teams", "owner@example.com"), /No Teams profile is connected for owner@example\.com/);
});

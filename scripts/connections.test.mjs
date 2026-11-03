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

test("shared support keeps a real owner, defaults to monitoring only and starts drafts at explicit activation", () => {
  const config = { doppler: { project: "example", config: "dev" } };
  assert.throws(() => apply(config, "--support", "help@example.com"), /support-owner/);
  apply(config, "--support", "help@example.com", "--support-owner", "owner@example.com");
  assert.equal(config.support.acknowledge, false);
  assert.equal(config.inboxAccounts, undefined, "support is not registered as a person");
  config.support.since = "2020-01-01T00:00:00Z";
  assert.throws(() => apply(config, "--draft-support"), /support-users-command/);
  apply(config, "--support-users-command", '["node","/private/users.mjs"]', "--support-user-policy", "all", "--draft-support");
  assert.equal(config.support.acknowledge, false);
  assert.equal(config.support.draft, true);
  assert.equal(config.support.since, "2020-01-01T00:00:00Z", "enabling acknowledgments cannot drop previously monitored inquiries");
  assert.ok(Date.parse(config.support.draftSince) > Date.parse(config.support.since));
  apply(config, "--no-support-drafts");
  assert.equal(config.support.acknowledge, false);
  assert.equal(config.support.draft, false);
  assert.throws(() => apply(config, "--acknowledge-support"), /disabled/);
  apply(config, "--no-support");
  assert.equal(config.support, undefined);
});

test("support forwarding is explicit, draft-only and preserves its activation cutoff on reinstall", () => {
  const config = { doppler: { project: "example", config: "dev" } };
  assert.throws(() => apply(config, "--support-forwarder", "owner@example.com"), /Connect --support/);
  apply(config, "--support", "help@example.com", "--support-owner", "owner@example.com");
  apply(config, "--support-forwarder", "OWNER@example.com");
  const cutoff = config.support.forwardSince;
  assert.deepEqual(config.support.forwarders, ["owner@example.com"]);
  assert.equal(config.support.acknowledge, false);
  assert.equal(config.support.draft, undefined, "forwarding never enables drafts or new access implicitly");
  apply(config, "--support-forwarder", "owner@example.com");
  assert.equal(config.support.forwardSince, cutoff);
  assert.throws(() => apply(config, "--support-forwarder", "owner@example.com", "--support-forward-since", "2000-01-01T00:00:00Z"), /backwards/);
  assert.throws(() => apply(config, "--support-forwarder", "invalid\r\nBcc: bad@example.com"), /addresses/);
  assert.throws(() => apply(config, "--support-forward-since", cutoff), /addresses/);
  apply(config, "--no-support-forwards");
  assert.deepEqual(config.support.forwarders, []);
  assert.equal(config.support.forwardSince, cutoff);
  assert.equal(config.inboxAccounts, undefined);
});

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

test("inbox placeholders reserve names without connecting an account and can be replaced explicitly", () => {
  const config = { inboxAccounts: [{ account: "owner@example.com" }] };
  apply(config, "--add-inbox-placeholder", "Ada", "--add-inbox-placeholder", "Sam");
  apply(config, "--add-inbox-placeholder", "ada");
  assert.deepEqual(config.inboxPlaceholders, ["Ada", "Sam"]);
  assert.deepEqual(config.inboxAccounts, [{ account: "owner@example.com" }]);
  apply(config, "--remove-inbox-placeholder", "ADA", "--add-inbox", "ada@example.com");
  assert.deepEqual(config.inboxPlaceholders, ["Sam"]);
  assert.deepEqual(config.inboxAccounts, [{ account: "owner@example.com" }, { account: "ada@example.com" }]);
  assert.throws(() => apply(config, "--add-inbox-placeholder", "ada@example.com"), /person's name/);
  assert.throws(() => apply(config, "--add-inbox-placeholder"), /person's name/);
});

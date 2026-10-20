import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeEnv, type NativeOptions } from "./native";
import type { InboxLogin } from "../collector/config";
import { executeRun } from "./engine";
import { makeRun, fixture, complete, dispatch, result, engineOptions } from "./run-fixtures";

const matt = { email: "matt.smith@example.com", name: "Matt" };
// A conversation's turns as the engine runs them: the coordinator's, a
// helper's, then the coordinator's again.
async function turns(o: ReturnType<typeof engineOptions>) {
  const calls: NativeOptions[] = [];
  o.turn = async (opts) => {
    calls.push(opts);
    await opts.onSession(opts.sessionId ?? randomUUID());
    if (opts.agent === "claude") return result;
    return calls.length === 1 ? dispatch() : complete;
  };
  await executeRun(o);
  return calls;
}
test("the coordinator and helpers are told whose conversation it is, and every turn carries the author", async () => {
  const dir = await fixture(), o = engineOptions(dir);
  o.person = matt;
  o.inboxes = [{ account: "owner@example.com" }];
  o.browserSignIn = "owner";
  o.browser = async () => ({ endpoint: "wss://projects.example.com/api/browser/x/cdp", capability: "c".repeat(40), outputDir: dir });
  try {
    const [master, helper] = await turns(o);
    assert.match(master.prompt, /This conversation is Matt's \(matt\.smith@example\.com\): "the user" in these instructions is Matt/);
    assert.match(master.prompt, /It starts signed in to Projects as Matt\./);
    assert.match(helper.prompt, /Matt asked for this work, and your commits are authored as them/);
    assert.match(helper.prompt, /No mailbox is connected for Matt on this machine/);
    assert.doesNotMatch(helper.prompt, /owner@example\.com/, "another person's mailbox is never named");
    assert.deepEqual([master.person, helper.person], [matt, matt]);
    assert.deepEqual([master.mailbox, helper.mailbox], [null, null], "no mailbox of Matt's is connected here");
    // A claim from a Worker that hands no person over reads as before.
    const [plainMaster, plainHelper] = await turns(engineOptions(dir));
    assert.doesNotMatch(plainMaster.prompt + plainHelper.prompt, /This conversation is|asked for this work|signed in to Projects as/);
    assert.equal(plainHelper.person, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("the email lane hears whose mailbox it may use", async () => {
  const dir = await fixture(), o = engineOptions(dir, { ...makeRun(), lane: "quick" });
  o.inboxes = [{ account: "owner@example.com" }];
  o.person = matt;
  const prompts: string[] = [];
  o.turn = async (opts) => {
    prompts.push(opts.prompt);
    await opts.onSession(randomUUID());
    return complete;
  };
  try {
    await executeRun(o);
    assert.match(prompts[0], /No mailbox is connected for Matt on this machine/);
    assert.doesNotMatch(prompts[0], /owner@example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("a connected mailbox reaches every turn of its owner's conversation as the gws sign-in", async () => {
  const dir = await fixture(), o = engineOptions(dir);
  const mine = { account: "Matt.Smith@example.com", configDir: "/Users/owner/.config/gws-matt" };
  o.person = matt;
  o.inboxes = [{ account: "owner@example.com" }, mine];
  try {
    const [master, helper] = await turns(o);
    assert.deepEqual([master.mailbox, helper.mailbox], [mine, mine]);
    assert.match(helper.prompt, /Matt's email is in Matt\.Smith@example\.com; use gws/);
    assert.doesNotMatch(helper.prompt, /gws-matt|owner@example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // The environment carries the sign-in: the person's own directory, the
  // machine's default for the owner's account, and none at all for a person
  // whose mailbox is not connected. Without a person, nothing changes.
  const config = (person?: typeof matt, mailbox?: InboxLogin | null) => nativeEnv(undefined, person, mailbox).GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
  assert.equal(config(matt, mine), "/Users/owner/.config/gws-matt");
  assert.equal(config(matt, { account: "matt.smith@example.com" }), undefined);
  assert.equal(config(matt, null), path.join(tmpdir(), "projects-no-mailbox"));
  assert.equal(config(undefined, null), undefined);
  assert.equal(config(matt), undefined);
});

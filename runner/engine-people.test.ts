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
    assert.match(master.prompt, /You are Matt's Projects master\./);
    assert.match(master.prompt, /It starts signed in to Projects as Matt\./);
    assert.match(master.prompt, /Matt reads them in Projects/);
    assert.match(helper.prompt, /Matt asked for this work, and your commits are authored as them/);
    assert.match(helper.prompt, /need Matt's approval of each message/);
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
test("a delegated mailbox reaches its owner's email lane as an hour's token, and a turn that gets none is told so", async () => {
  const mine: InboxLogin = { account: "Matt.Smith@example.com", delegated: true };
  const quick = (mailboxToken?: (account: string) => Promise<string>) => {
    const o = engineOptions(fixtureDir, { ...makeRun(), lane: "quick" });
    o.person = matt;
    o.inboxes = [{ account: "owner@example.com" }, mine];
    o.mailboxToken = mailboxToken;
    const calls: NativeOptions[] = [];
    o.turn = async (opts) => {
      calls.push(opts);
      await opts.onSession(randomUUID());
      return complete;
    };
    return { o, calls };
  };
  const fixtureDir = await fixture();
  try {
    const minted: string[] = [];
    const { o, calls } = quick(async (account) => `tok-${minted.push(account)}`);
    await executeRun(o);
    assert.deepEqual(minted, ["Matt.Smith@example.com"], "a token for the owner's account, minted for this turn");
    assert.deepEqual([calls[0].mailbox, calls[0].mailboxToken], [mine, "tok-1"]);
    assert.match(calls[0].prompt, /Matt's email is in Matt\.Smith@example\.com/);
    assert.doesNotMatch(calls[0].prompt, /tok-1|could not be reached|owner@example\.com/, "the token reaches the environment, not the prompt");
    // The environment carries the token with no sign-in beside it, and
    // nothing when there is no token; a token is only for a delegated mailbox.
    const env = nativeEnv(undefined, matt, mine, "tok-1");
    assert.equal(env.GOOGLE_WORKSPACE_CLI_TOKEN, "tok-1");
    assert.equal(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, path.join(tmpdir(), "projects-no-mailbox"));
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, path.join(tmpdir(), "projects-no-mailbox", "none.json"));
    assert.deepEqual([nativeEnv(undefined, matt, mine).GOOGLE_WORKSPACE_CLI_TOKEN, nativeEnv(undefined, matt, mine).GOOGLE_WORKSPACE_CLI_CONFIG_DIR], [undefined, path.join(tmpdir(), "projects-no-mailbox")]);
    assert.equal(nativeEnv(undefined, matt, { account: "matt.smith@example.com" }, "tok-1").GOOGLE_WORKSPACE_CLI_TOKEN, undefined);
    // The key cannot be read or Google refuses: the turn has no mailbox and hears it.
    const refused = quick(async () => { throw Error("refused"); });
    await executeRun(refused.o);
    assert.deepEqual([refused.calls[0].mailbox, refused.calls[0].mailboxToken], [null, undefined]);
    assert.match(refused.calls[0].prompt, /Matt's mailbox could not be reached for this turn, so gws has no sign-in in this session/);
    // A machine that cannot mint tokens at all reads the same way.
    const none = quick();
    await executeRun(none.o);
    assert.equal(none.calls[0].mailbox, null);
    assert.match(none.calls[0].prompt, /could not be reached for this turn/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

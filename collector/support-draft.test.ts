import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSupportDraft } from "./support-draft";
import { supportThread } from "./support-gmail";
import { mailHash } from "./mail-identity";
import type { AcknowledgmentInput, SupportConfig, SupportSummary } from "../src/support-model";
const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [], since: "2026-01-01T00:00:00Z", acknowledge: true, draft: true };
const id = "1234567890abcdef", at = Date.now();
const incoming = { id, internalDate: String(at), labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: Object.entries({ From: "customer@example.org", To: config.account, Cc: "owner@example.com, outside@example.net", "Message-ID": "<original@example.org>", Subject: "Export" }).map(([name, value]) => ({ name, value })), body: { data: Buffer.from("The export is empty.").toString("base64url") } } };
const thread = supportThread(config, id, [incoming])!;
const summary: SupportSummary = { kind: "issue", excerpt: "The export is empty.", area: "export" };
function fixture() {
  const actions: string[] = [], mutations: string[] = [];
  let raw = "";
  const transport = {
    users: async () => new Set([thread.from, config.owner].map(mailHash)),
    saveToken: async () => {}, summarize: async () => summary,
    ack: async (_t: typeof thread, action: AcknowledgmentInput["action"]) => {
      actions.push(action);
      return action === "reserve" ? { state: "reserved" as const, token: "token" }
        : action === "begin-draft" ? { state: "drafting" as const, draft: true as const }
        : action === "drafted" ? { state: "drafted" as const, draftedAt: at } : null;
    },
    gws: async (args: string[]) => {
      if (args.includes("getProfile")) return JSON.stringify({ emailAddress: config.account });
      if (args[2] === "threads") return JSON.stringify({ id, messages: [incoming] });
      mutations.push(args.slice(0,4).join(" "));
      assert.deepEqual(args.slice(0,4), ["gmail", "users", "drafts", "create"]);
      raw = Buffer.from(JSON.parse(args[args.indexOf("--json") + 1]).message.raw, "base64url").toString();
      return JSON.stringify({ id: "r-review", message: { id: "abcdef0123456789", threadId: id } });
    },
  };
  return { transport, actions, mutations, raw: () => raw };
}
test("a copied registered person cannot qualify an unknown sender, and unavailable qualification never falls back to drafting", async () => {
  const f = fixture();
  assert.equal((await prepareSupportDraft({ ...thread, from: "unknown@example.org" }, config, f.transport)).state, "skipped");
  assert.equal((await prepareSupportDraft({ ...thread, deliveryHistoryComplete: false }, config, f.transport)).state, "failed");
  assert.equal((await prepareSupportDraft(thread, { ...config, draft: false }, f.transport)).state, "off", "legacy acknowledge=true never sends or drafts");
  await assert.rejects(prepareSupportDraft(thread, config, { ...f.transport, users: async () => { throw Error("Directory unavailable"); } }));
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.mutations, []);
});
test("reply-all and sender-only registration apply to the saved draft; never call a send endpoint", async () => {
  const all = fixture();
  assert.equal((await prepareSupportDraft(thread, config, all.transport)).state, "ready");
  assert.match(all.raw(), /^To: customer@example.org\r?$/m);
  assert.match(all.raw(), /^Cc: owner@example.com\r?$/m);
  assert.doesNotMatch(all.raw(), /outside@example.net/);
  const sender = fixture();
  assert.equal((await prepareSupportDraft(thread, { ...config, registeredRecipients: "sender" }, sender.transport)).state, "ready");
  assert.match(sender.raw(), /outside@example.net/);
  assert.deepEqual(sender.mutations, ["gmail users drafts create"]);
});
test("an existing manual draft, changed conversation or wrong mailbox is never overwritten", async () => {
  const existing = fixture();
  assert.equal((await prepareSupportDraft({ ...thread, draftMessages: ["abcdef0123456789"] }, config, existing.transport)).state, "held");
  assert.deepEqual(existing.mutations, []);
  const changed = fixture();
  const result = await prepareSupportDraft(thread, config, { ...changed.transport, gws: async args => args.includes("getProfile") ? changed.transport.gws(args) : JSON.stringify({ id, messages: [incoming, { ...incoming, internalDate: String(at + 1), payload: { ...incoming.payload, headers: incoming.payload.headers.map(h => h.name === "Message-ID" ? { ...h, value: "<new@example.org>" } : h) } }] }) });
  assert.equal(result.state, "stale");
  assert.deepEqual(changed.mutations, []);
  const wrong = fixture();
  await assert.rejects(prepareSupportDraft(thread, config, { ...wrong.transport, gws: async () => JSON.stringify({ emailAddress: "other@example.org" }) }), /identity mismatch/);
  assert.deepEqual(wrong.mutations, []);
});
test("an unavailable or invalid model produces a simple review draft without an invented issue or database observation", async () => {
  const f = fixture();
  const result = await prepareSupportDraft(thread, config, { ...f.transport, summarize: async () => { throw Error("Model unavailable"); } });
  assert.equal(result.triage, "needs-review");
  const text = Buffer.from(f.raw().split("\r\n\r\n")[1].trim(), "base64").toString();
  assert.match(text, /We've received it/);
  assert.doesNotMatch(text, /investigat|database|export|checked/);
});
test("readiness checks the exact stable Gmail draft, rather than any draft in the conversation", async () => {
  const f = fixture(), visible = { ...thread, draftMessages: ["abcdef0123456789"] };
  const transport = { ...f.transport, ack: async () => ({ state: "drafted" as const, draftId: "r-review", requestKey: undefined, draftedAt: at }) };
  const gws = async (args: string[]) => {
    assert.deepEqual(args.slice(0,4), ["gmail", "users", "drafts", "get"]);
    assert.equal(JSON.parse(args[args.indexOf("--params") + 1]).id, "r-review");
    return JSON.stringify({ id: "r-review", message: { id: "abcdef0123456789", threadId: id, labelIds: ["DRAFT"] } });
  };
  assert.equal((await prepareSupportDraft(visible, config, { ...transport, gws })).state, "ready");
  assert.equal((await prepareSupportDraft(visible, config, { ...transport, gws: async () => JSON.stringify({ id: "r-other", message: { id: "abcdef0123456789", threadId: id, labelIds: ["DRAFT"] } }) })).state, "held");
  assert.equal((await prepareSupportDraft(visible, config, { ...transport, gws: async () => { throw Error("Deleted or sent"); } })).state, "held");
  assert.deepEqual(f.mutations, []);
});
test("optional record verification follows registration and fresh mail checks, and adds only a sign-in link to the draft", async () => {
  const f = fixture(), url = "https://source.example.com/support-investigation/19464d92-efbc-4117-a280-4c3834125b5c";
  let calls = 0;
  const investigate = async () => { calls++; assert.deepEqual(f.actions, ["reserve"]); return { state: "awaiting-verification" as const, verificationUrl: url }; };
  await prepareSupportDraft({ ...thread, from: "unknown@example.org" }, config, { ...f.transport, investigate });
  assert.equal(calls, 0);
  assert.equal((await prepareSupportDraft(thread, config, { ...f.transport, investigate })).state, "ready");
  assert.equal(calls, 1);
  const body = Buffer.from(f.raw().split("\r\n\r\n")[1].trim(), "base64").toString();
  assert.ok(body.includes(url)); assert.doesNotMatch(body, /sr_|sd_|database checked|solution|workaround/);
  assert.deepEqual(f.mutations, ["gmail users drafts create"]);
});

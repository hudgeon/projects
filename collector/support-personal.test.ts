import { test } from "node:test";
import assert from "node:assert/strict";
import { personalSupportConfig, personalThread, readPersonalSupport, mergeSupportCopies, personalSupportGws } from "./support-personal";
import { prepareSupportDraft, findSupportDraft } from "./support-draft";
import { supportThread } from "./support-gmail";
import { mailHash } from "./mail-identity";
import { configSchema } from "./config";
import type { MailMessage } from "./mail-delivery";
import type { Acknowledgment, AcknowledgmentInput, SupportConfig, SupportSummary } from "../src/support-model";
const at = Date.now(), id = "1234567890abcdef", target = "abcdef0123456789";
const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [], since: "2026-01-01T00:00:00Z", draft: true,
  personalInbox: { account: "owner@example.com", since: new Date(at - 1000).toISOString() } };
const message = (from = "customer@example.org", original = "<original@example.org>", when = at): MailMessage => ({ id, internalDate: String(when), labelIds: ["INBOX"],
  payload: { mimeType: "text/plain", headers: Object.entries({ From: from, To: config.owner, Cc: "outside@example.net", "Reply-To": "attacker@example.net", Subject: "Export", "Message-ID": original }).map(([name,value]) => ({name,value})),
    body: { data: Buffer.from("The export is empty.").toString("base64url") } } });
const incoming = message();
const personal = personalThread(supportThread(personalSupportConfig(config), id, [incoming])!, config);
const summary: SupportSummary = { kind: "issue", excerpt: "The export is empty.", area: "export" };
const p = (args: string[]) => JSON.parse(args[args.indexOf("--params") + 1]);
test("only a fresh registered From enters support from the owner's explicitly connected inbox", async () => {
  const users = new Set([mailHash("customer@example.org")]);
  const run = async (args: string[]) => {
    if (args.includes("getProfile")) return JSON.stringify({ emailAddress: config.owner });
    if (args[3] === "list") {
      if (args[2] === "messages") return "{}";
      assert.doesNotMatch(p(args).q, /in:inbox/, "no historical inbox backfill");
      return JSON.stringify({ threads: [id, "bbbbbbbbbb000001", "bbbbbbbbbb000002"].map(id => ({ id })) });
    }
    const threadId = p(args).id;
    return JSON.stringify({ id: threadId, messages: [threadId === id ? incoming : threadId.endsWith("1") ? message("unknown@example.net") : message("customer@example.org", "<old@example.org>", at - 2000)] });
  };
  const read = await readPersonalSupport(config, run, async () => users, new Map());
  assert.equal(read.complete, true); assert.equal(read.threads.length, 1);
  assert.deepEqual(read.threads[0].recipients, { to: ["customer@example.org"], cc: [] });
  assert.equal(read.threads[0].sourceAccount, config.owner);
  await assert.rejects(readPersonalSupport(config, async () => JSON.stringify({ emailAddress: "colleague@example.com" }), async () => users, new Map()), /identity mismatch/);
  const machine = configSchema.parse({ host: "studio", home: "/tmp", root: "/tmp", support: config, inboxAccounts: [{ account: "colleague@example.com" }] });
  assert.throws(() => personalSupportGws(machine), /not connected/);
  assert.throws(() => personalSupportConfig({ ...config, personalInbox: { account: "colleague@example.com", since: config.since } }), /not enabled/);
});
test("copy merging requires exact RFC identities and keeps newer personal follow-ups", () => {
  const shared = supportThread(config, target, [incoming])!;
  assert.equal(mergeSupportCopies([shared], [personal]).length, 1);
  const separate = { ...personal, key: "b".repeat(64), messageKeys: [mailHash("different")] };
  assert.equal(mergeSupportCopies([shared], [separate]).length, 2, "same sender/subject is insufficient");
  const newer = { ...personal, at: at + 1, messageId: "<followup@example.org>", messageKeys: [...personal.messageKeys, mailHash("followup")] };
  const merged = mergeSupportCopies([shared], [newer]);
  assert.equal(merged[0].messageId, newer.messageId); assert.equal(merged[0].key, shared.key);
});
test("empty new intake needs no unrelated delivery history; personal DSN coverage extends beyond the shared-mailbox budget", async () => {
  const users = async () => new Set([mailHash(personal.from)]);
  let reportPages = 0, empty = true;
  const gws = async (args: string[]) => {
    if (args.includes("getProfile")) return JSON.stringify({ emailAddress: config.owner });
    if (args[2] === "threads") return JSON.stringify(args[3] === "get" ? { id, messages: [incoming] } : { threads: empty ? [] : [{ id }] });
    reportPages++;
    return JSON.stringify({ messages: [], ...(reportPages < 3 ? { nextPageToken: String(reportPages) } : {}) });
  };
  assert.equal((await readPersonalSupport(config, gws, users, new Map())).complete, true);
  assert.equal(reportPages, 0);
  empty = false;
  assert.equal((await readPersonalSupport(config, gws, users, new Map())).complete, true);
  assert.equal(reportPages, 3);
  reportPages = 0;
  const incomplete = await readPersonalSupport(config, async args => args[2] === "messages" ? JSON.stringify({ messages: [], nextPageToken: "more" }) : gws(args), users, new Map());
  assert.equal(incomplete.complete, false, "exhausted extended coverage still fails closed");
});
function fixture() {
  let receipt: Acknowledgment | null = null, raw = "", creates = 0, models = 0, visible = false, lost = false, sent = false, manual = false;
  let source = incoming, profile = config.account;
  const draft = () => ({ id: "r-review", message: { id: target, threadId: target, internalDate: String(at + 1), labelIds: ["DRAFT"], payload: { headers: Object.entries({
    From: config.account, To: personal.from, "In-Reply-To": personal.messageId!, "X-Projects-Support-Receipt": "2", "X-Projects-Support-Case": manual ? "" : personal.key,
  }).map(([name,value]) => ({name,value})) } } });
  const gws = async (args: string[]) => {
    assert.ok(!args.includes("send") && !args.includes("delete") && !args.includes("update"));
    if (args.includes("getProfile")) return JSON.stringify({ emailAddress: profile });
    if (args[2] === "drafts" && args[3] === "create") {
      creates++; const body = JSON.parse(args[args.indexOf("--json") + 1]);
      assert.equal(body.message.threadId, undefined, "personal IDs never reach the Support writer");
      raw = Buffer.from(body.message.raw, "base64url").toString(); visible = true;
      if (lost) throw Error("Gmail response lost");
      return JSON.stringify(draft());
    }
    if (args[2] === "drafts") return JSON.stringify(args[3] === "get" ? draft() : { drafts: visible ? [{ id: "r-review" }] : [] });
    if (args[3] === "list") assert.match(p(args).q, /to:"customer@example.org"$/);
    if (args[3] === "list") return JSON.stringify({ messages: sent ? [{ id: target }] : [] });
    return JSON.stringify({ ...draft().message, labelIds: ["SENT"] });
  };
  const sourceGws = async (args: string[]) => {
    assert.ok(args.includes("getProfile") || args[2] === "threads" && args[3] === "get", "source mailbox is read-only");
    return JSON.stringify(args.includes("getProfile") ? { emailAddress: config.owner } : { id, messages: [source] });
  };
  const transport = { gws, sourceGws, users: async () => new Set([mailHash(personal.from)]), saveToken: async () => {},
    summarize: async () => { models++; return summary; },
    ack: async (_t: typeof personal, action: AcknowledgmentInput["action"]) => {
      if (action === "reserve") return receipt ??= { state: "reserved", token: "token" };
      if (action === "begin-draft") return receipt = { ...receipt!, state: "drafting", draft: true };
      if (action === "draft-uncertain") return receipt = { ...receipt!, state: "draft-uncertain", draft: undefined };
      if (action === "drafted") return receipt = { state: "drafted", draftId: "r-review", draftedAt: at };
      receipt = null; return null;
    } };
  return { transport, stats: () => ({ creates, models, raw }), set: (v: { lost?: boolean; visible?: boolean; sent?: boolean; manual?: boolean; source?: MailMessage; profile?: string }) => {
    if (v.lost !== undefined) lost = v.lost; if (v.visible !== undefined) visible = v.visible; if (v.sent !== undefined) sent = v.sent;
    if (v.manual !== undefined) manual = v.manual; if (v.source) source = v.source; if (v.profile) profile = v.profile;
  } };
}
test("a personal inquiry creates one sender-only Support draft with RFC threading and normal verification", async () => {
  const f = fixture(); let checks = 0;
  assert.equal((await prepareSupportDraft(personal, config, { ...f.transport, investigate: async () => { checks++; return { state: "awaiting-verification" }; } })).state, "ready");
  assert.equal(checks, 1);
  assert.match(f.stats().raw, /^From: Support <help@example.com>\r?$/m);
  assert.match(f.stats().raw, /^To: customer@example.org\r?$/m);
  assert.match(f.stats().raw, /^In-Reply-To: <original@example.org>\r?$/m);
  assert.doesNotMatch(f.stats().raw, /^Cc:|^Bcc:|attacker@example.net|outside@example.net/m);
  assert.equal((await prepareSupportDraft(personal, config, f.transport)).state, "ready");
  assert.equal(f.stats().creates, 1);
});
test("uncertain detached creation reconciles the exact draft without replay; manual drafts and Sent replies hold", async () => {
  const f = fixture(); f.set({ lost: true });
  assert.equal((await prepareSupportDraft(personal, config, f.transport)).state, "uncertain");
  assert.equal((await prepareSupportDraft(personal, config, f.transport)).state, "ready");
  assert.equal(f.stats().creates, 1);
  for (const state of [{ visible: true, manual: true }, { sent: true }]) {
    const held = fixture(); held.set(state);
    assert.equal((await prepareSupportDraft(personal, config, held.transport)).state, "held");
    assert.deepEqual(held.stats(), { creates: 0, models: 0, raw: "" });
  }
  const wrong = fixture(); wrong.set({ profile: "colleague@example.com" });
  await assert.rejects(prepareSupportDraft(personal, config, wrong.transport), /identity mismatch/);
  const lookalike = fixture(); lookalike.set({ visible: true, manual: true });
  assert.equal(await findSupportDraft(lookalike.transport.gws, config, personal), undefined);
  await assert.rejects(findSupportDraft(lookalike.transport.gws, config, { ...personal, from: "customer@example.org OR in:anywhere" }), /Invalid support sender/);
});
test("changed source, revoked membership, failed sender and incomplete coverage cannot create a draft", async () => {
  const changed = fixture(); changed.set({ source: message(personal.from, "<new@example.org>", at + 1) });
  assert.equal((await prepareSupportDraft(personal, config, changed.transport)).state, "stale");
  const revoked = fixture(); let reads = 0;
  assert.equal((await prepareSupportDraft(personal, config, { ...revoked.transport, users: async () => ++reads === 1 ? new Set([mailHash(personal.from)]) : new Set() })).state, "held");
  const blocked = fixture();
  assert.equal((await prepareSupportDraft({ ...personal, recipients: null }, config, blocked.transport)).state, "skipped");
  assert.equal((await prepareSupportDraft({ ...personal, deliveryHistoryComplete: false }, config, blocked.transport)).state, "failed");
  assert.equal(changed.stats().creates + revoked.stats().creates + blocked.stats().creates, 0);
});

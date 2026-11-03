import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { start, options } from "./miniflare-fixtures";
import type { Portfolio } from "./index";
import { prepareSupportDraft } from "../collector/support-draft";
import { supportThread, type SupportThread } from "../collector/support-gmail";
import type { Acknowledgment, AcknowledgmentInput, SupportConfig, SupportSummary } from "../src/support-model";
import { acknowledgmentText, acknowledgmentInputSchema } from "../src/support-model";
import { mailHash, messageKey } from "../collector/mail-identity";
const owner = "owner@example.com", account = "help@example.com";
const config: SupportConfig = { account, owner, aliases: [], since: "2026-11-01T00:00:00Z", draft: true };
test("durable draft claims survive races, a lost Gmail response and a restart; no action authorizes sending", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-support-")), script = path.join(dir, "worker.mjs");
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const settings = await options(script, dir, { ALLOWED_EMAILS: owner, OWNER_EMAIL: owner, COLLECTOR_TOKEN: "c".repeat(64), RUNNER_TOKEN: "r".repeat(64) });
  let mf = await start(settings);
  const getStore = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  try {
    let store = await getStore();
    const input = (key: string, action: AcknowledgmentInput["action"], token?: string, extra = {}) => ({ key, owner, account, requestKey: key, action, ...(token ? { token } : {}), ...extra });
    const key = "a".repeat(64), first = await store.supportAcknowledgment(input(key, "reserve"), "studio");
    assert.ok(first?.token);
    assert.equal(acknowledgmentInputSchema.safeParse({ ...input(key, "reserve", first.token), action: "begin" }).success, false, "retired send actions are rejected");
    const reservations = await Promise.all([1, 2].map(() => store.supportAcknowledgment(input(key, "begin-draft", first.token), "studio")));
    assert.equal(reservations.filter(r => r?.draft).length, 1);
    assert.equal(await store.supportAcknowledgment(input(key, "drafted", first.token, { draftId: "r-first" }), "laptop"), null);
    await store.supportAcknowledgment(input(key, "drafted", first.token, { draftId: "r-first", triage: "issue" }), "studio");
    const ready = await store.supportAcknowledgment(input(key, "reserve"), "studio");
    assert.equal(ready?.state, "drafted");
    assert.equal(ready?.draftId, "r-first");
    assert.equal(ready?.triage, "issue");
    assert.equal(ready?.token, undefined);
    assert.doesNotMatch(JSON.stringify(ready), /"send":true/);
    const readAt = Date.now();
    await store.publishChats({ source: "support", owner, observedAt: readAt, state: "ok", items: [{ id: key,
      place: { name: "Export", kind: "thread" }, from: "Customer", at: readAt - 1000, count: 1, unread: false, mention: true,
      text: "Private support text", support: { account, thread: "1234567890abcdef", messageKeys: [key], acknowledgment: "off", draft: "ready", draftedAt: readAt } }] }, "studio");
    assert.equal((await store.chatList(owner)).items[0].state, "action", "a draft leaves work waiting for a person");
    assert.equal((await store.chatList("colleague@example.com")).items.length, 0);
    assert.doesNotMatch(JSON.stringify(await store.overview()), /Private support text/);
    await store.publishChats({ source: "support", owner, observedAt: readAt + 1, state: "unavailable", items: [] }, "studio");
    assert.equal((await store.chatList(owner)).items.length, 1);
    const at = Date.now(), id = "1234567890abcdef", from = "customer@example.org", original = "<original@example.org>";
    const summary: SupportSummary = { kind: "issue", excerpt: "The export is empty.", area: "export" };
    const incoming = { id, internalDate: String(at), labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: Object.entries({ From: from, To: account, Cc: owner, Subject: "Export", "Message-ID": original }).map(([name,value]) => ({name,value})), body: { data: Buffer.from(summary.excerpt).toString("base64url") } } };
    const thread = supportThread(config, id, [incoming])!;
    let creates = 0, visible = false, saved: string | undefined;
    const transport = {
      users: async () => new Set([mailHash(from)]),
      ack: async (t: SupportThread, action: AcknowledgmentInput["action"], token?: string, details?: Pick<AcknowledgmentInput, "draftId" | "triage">) => store.supportAcknowledgment(input(t.key, action, token, { requestKey: messageKey(t.messageId!), ...details }), "studio"),
      gws: async (args: string[]) => {
        assert.ok(!args.includes("send"), "no Gmail send endpoint may be called");
        if (args.includes("getProfile")) return JSON.stringify({ emailAddress: account });
        if (args[2] === "drafts" && args[3] === "create") {
          creates++;
          const body = JSON.parse(args[args.indexOf("--json") + 1]);
          assert.equal(body.message.threadId, id);
          const raw = Buffer.from(body.message.raw, "base64url").toString();
          assert.doesNotMatch(raw, /^Cc:|^Bcc:/m, "copied people are never included");
          assert.match(raw, /In-Reply-To: <original@example.org>/);
          throw Error("Response lost after Gmail accepted the draft");
        }
        if (args[2] === "drafts") return JSON.stringify({ drafts: [{ id: "r-recovered", message: { id: "abcdef0123456789", threadId: id } }] });
        return JSON.stringify({ id, messages: [incoming, ...(visible ? [{ id: "abcdef0123456789", internalDate: String(at + 1000), labelIds: ["DRAFT"], payload: {
          mimeType: "text/plain", headers: Object.entries({ From: account, To: from, "In-Reply-To": original, "X-Projects-Support-Receipt": "2" }).map(([name,value]) => ({name,value})),
          body: { data: Buffer.from(acknowledgmentText(summary)).toString("base64url") },
        } }] : [])] });
      },
      summarize: async () => summary,
      saveToken: async (value: string) => { saved = value; },
    };
    assert.equal((await prepareSupportDraft(thread, config, transport)).state, "uncertain");
    assert.equal(creates, 1);
    assert.ok(saved);
    assert.equal((await prepareSupportDraft(thread, config, { ...transport, token: saved })).state, "uncertain");
    assert.equal(creates, 1, "missing evidence is not permission to create another draft");
    visible = true;
    assert.equal((await prepareSupportDraft(thread, config, { ...transport, token: saved })).state, "ready");
    assert.equal(creates, 1);
    assert.equal((await prepareSupportDraft(thread, config, transport)).state, "held", "a deleted or missing draft is never recreated");
    assert.equal((await prepareSupportDraft({ ...thread, messageId: "<followup@example.org>" }, config, transport)).state, "stale", "a later request cannot reuse an earlier draft");
    assert.equal(creates, 1);
    const copyKey = "f".repeat(64), originalKey = messageKey(original)!;
    const copy = input(copyKey, "reserve", undefined, { requestKey: originalKey, messageKeys: [originalKey] });
    assert.equal((await store.supportAcknowledgment(copy, "laptop"))?.draftId, "r-recovered", "a delayed copy on another machine reuses the durable receipt");
    assert.equal((await store.supportAcknowledgment({ ...copy, action: "begin-draft" }, "laptop"))?.draft, undefined, "an alias cannot authorize another Gmail create");
    const nextKey = "d".repeat(64);
    assert.equal((await store.supportAcknowledgment({ ...copy, requestKey: nextKey, messageKeys: [originalKey, nextKey] }, "laptop"))?.requestKey, originalKey, "follow-ups retain the original once-per-conversation draft");
    const distinct = await store.supportAcknowledgment(input("9".repeat(64), "reserve", undefined, { requestKey: "8".repeat(64) }), "studio");
    assert.equal(distinct?.state, "reserved", "distinct inquiries never join by sender or subject");
    assert.equal(await store.supportAcknowledgment({ ...copy, messageKeys: [originalKey, "8".repeat(64)] }, "studio"), null, "conflicting case identities fail closed");
    const other = await store.supportAcknowledgment({ ...copy, key: "7".repeat(64), owner: "colleague@example.com" }, "studio");
    assert.equal(other?.state, "reserved", "copy identities are scoped to the support owner");
    const held = "e".repeat(64), old = await store.supportAcknowledgment(input(held, "reserve"), "studio");
    const moved = await store.supportAcknowledgment(input(held, "reserve"), "laptop");
    assert.ok(moved?.token && old?.token !== moved.token);
    assert.equal(await store.supportAcknowledgment(input(held, "begin-draft", old!.token), "studio"), null);
    assert.equal((await store.supportAcknowledgment(input(held, "begin-draft", moved.token), "laptop"))?.draft, true);
    assert.equal((await store.supportAcknowledgment(input(held, "reserve"), "studio"))?.token, undefined);
    await mf.dispose(); mf = await start(settings); store = await getStore();
    assert.equal((await store.supportAcknowledgment(input(key, "reserve"), "studio"))?.state, "drafted");
    assert.equal((await store.supportAcknowledgment(input(thread.key, "reserve", undefined, { requestKey: messageKey(original) }), "studio"))?.state, "drafted");
    assert.equal((await store.supportAcknowledgment({ ...copy, requestKey: nextKey, messageKeys: [nextKey] }, "laptop"))?.draftId, "r-recovered", "aliases survive the Durable Object restart");
    const post = (authorization: string, body: object) => mf.dispatchFetch("https://example.com/api/support/ack", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(`Bearer ${"c".repeat(64)}`, input(key, "reserve"))).status, 409, "unavailable/stale intake cannot authorize an alias claim");
    await store.publishChats({ source: "support", owner, observedAt: Date.now(), state: "ok", items: [{ id: key, place: { name: "Export", kind: "thread" }, from,
      at: Date.now(), count: 1, unread: true, mention: true, text: "The export is empty.", support: { account, thread: id, messageKeys: [key], acknowledgment: "off", draft: "ready" } }] }, "studio");
    assert.equal((await post(`Bearer ${"c".repeat(64)}`, input(key, "reserve", undefined, { messageKeys: ["0".repeat(64)] }))).status, 409, "unobserved hashes cannot join a different case");
    assert.equal((await post(`Bearer ${"r".repeat(64)}`, input(key, "reserve"))).status, 401);
    assert.equal((await post(`Bearer ${"c".repeat(64)}`, { ...input(key, "reserve"), owner: "stranger@example.com" })).status, 400);
    const allowed = await post(`Bearer ${"c".repeat(64)}`, input(key, "reserve"));
    assert.equal(allowed.status, 200);
    assert.equal(((await allowed.json()) as { receipt: Acknowledgment }).receipt.state, "drafted");
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { start, options } from "./miniflare-fixtures";
import type { Portfolio } from "./index";
import { acknowledgeSupport } from "../collector/support";
import type { SupportThread } from "../collector/support-gmail";
import type { Acknowledgment, AcknowledgmentInput, SupportConfig } from "../src/support-model";
const owner = "owner@example.com", account = "help@example.com";
const config: SupportConfig = { account, owner, aliases: [], since: "2026-11-01T00:00:00Z", acknowledge: true };
test("durable send claims survive races, uncertain delivery and a process restart without replaying mail", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-support-")), script = path.join(dir, "worker.mjs");
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const settings = await options(script, dir, { ALLOWED_EMAILS: owner, OWNER_EMAIL: owner, COLLECTOR_TOKEN: "c".repeat(64), RUNNER_TOKEN: "r".repeat(64) });
  let mf = await start(settings);
  const getStore = async () => { const ns = await mf.getDurableObjectNamespace("PORTFOLIOS"); return ns.get(ns.idFromName("test")) as unknown as Portfolio; };
  try {
    let store = await getStore();
    const input = (key: string, action: AcknowledgmentInput["action"], token?: string) => ({ key, owner, account, action, ...(token ? { token } : {}) });
    const key = "a".repeat(64), first = await store.supportAcknowledgment(input(key, "reserve"), "studio");
    assert.ok(first?.token);
    const reservations = await Promise.all([1, 2].map(() => store.supportAcknowledgment(input(key, "begin", first!.token), "studio")));
    assert.equal(reservations.filter(r => r?.send).length, 1, "only the transition from reserved to sending authorizes transport");
    const wrong = await store.supportAcknowledgment(input(key, "sent", first!.token), "laptop");
    assert.equal(wrong, null, "another machine cannot report the send");
    await store.supportAcknowledgment(input(key, "sent", first!.token), "studio");
    const sent = await store.supportAcknowledgment(input(key, "reserve"), "studio");
    assert.equal(sent?.state, "sent");
    assert.equal(sent?.token, undefined);
    const readAt = Date.now();
    await store.publishChats({ source: "support", owner, observedAt: readAt, state: "ok", items: [{ id: key,
      place: { name: "Export", kind: "thread" }, from: "Customer", at: readAt - 1000, count: 1, unread: false, mention: true,
      text: "Private support text", support: { account, thread: "1234567890abcdef", messageKeys: [key], acknowledgment: "sent", acknowledgedAt: readAt } }] }, "studio");
    assert.equal((await store.chatList(owner)).items[0].state, "action", "an automated receipt leaves the request waiting for a person");
    assert.equal((await store.chatList("colleague@example.com")).items.length, 0, "support metadata and text remain with the authorized owner");
    assert.doesNotMatch(JSON.stringify(await store.overview()), /Private support text/);
    await store.publishChats({ source: "support", owner, observedAt: readAt + 1, state: "unavailable", items: [] }, "studio");
    assert.equal((await store.chatList(owner)).items.length, 1, "a failed support read retains the unresolved request");
    assert.equal((await store.chatList(owner)).reads[0].state, "unavailable");
    const thread: SupportThread = { id: "1234567890abcdef", key: "b".repeat(64), subject: "Export", from: "customer@example.org", to: "customer@example.org", at: Date.now(), body: "The export is empty.", messageId: "<original@example.org>", messageKeys: ["c".repeat(64)], unread: false, eligible: true };
    let sends = 0, delivered = false, saved: string | undefined;
    const transport = {
      ack: async (t: SupportThread, action: AcknowledgmentInput["action"], token?: string) => store.supportAcknowledgment(input(t.key, action, token), "studio"),
      gws: async (args: string[]) => { if (args.includes("send")) { sends++; throw Error("Response lost after Gmail accepted it"); } return JSON.stringify(delivered ? { messages: [{ id: "delivered" }] } : {}); },
      summarize: async () => ({ support: true, summary: "the export is empty" }),
      saveToken: async (value: string) => { saved = value; },
    };
    assert.equal((await acknowledgeSupport(thread, config, transport)).state, "uncertain");
    assert.equal(sends, 1);
    assert.ok(saved);
    assert.equal((await acknowledgeSupport(thread, config, { ...transport, token: saved })).state, "uncertain");
    assert.equal(sends, 1, "a missing Sent result is not permission to retry");
    delivered = true;
    assert.equal((await acknowledgeSupport(thread, config, { ...transport, token: saved })).state, "sent");
    assert.equal(sends, 1, "a later Sent reconciliation records delivery without resending");
    const off = await acknowledgeSupport({ ...thread, key: "d".repeat(64), eligible: false }, config, { ...transport, ack: async () => { throw Error("Old messages must not claim"); } });
    assert.equal(off.state, "skipped");
    // An unstarted reservation can move to the new duty holder. Once sending
    // starts, neither machine obtains a fresh send permission.
    const held = "e".repeat(64), old = await store.supportAcknowledgment(input(held, "reserve"), "studio");
    const moved = await store.supportAcknowledgment(input(held, "reserve"), "laptop");
    assert.ok(moved?.token && old?.token !== moved.token);
    assert.equal(await store.supportAcknowledgment(input(held, "begin", old!.token), "studio"), null);
    assert.equal((await store.supportAcknowledgment(input(held, "begin", moved!.token), "laptop"))?.send, true);
    assert.equal((await store.supportAcknowledgment(input(held, "reserve"), "studio"))?.token, undefined);
    // Restart workerd against the same SQLite files, not a fake in-memory map.
    await mf.dispose();
    mf = await start(settings);
    store = await getStore();
    assert.equal((await store.supportAcknowledgment(input(key, "reserve"), "studio"))?.state, "sent");
    assert.equal((await store.supportAcknowledgment(input(thread.key, "reserve"), "studio"))?.state, "sent");
    const post = (authorization: string, body: object) => mf.dispatchFetch("https://example.com/api/support/ack", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(`Bearer ${"r".repeat(64)}`, input(key, "reserve"))).status, 401);
    assert.equal((await post(`Bearer ${"c".repeat(64)}`, { ...input(key, "reserve"), owner: "stranger@example.com" })).status, 400);
    const allowed = await post(`Bearer ${"c".repeat(64)}`, input(key, "reserve"));
    assert.equal(allowed.status, 200);
    assert.equal(((await allowed.json()) as { receipt: Acknowledgment }).receipt.state, "sent");
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

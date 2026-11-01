import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registeredUsers, readSupportUsers } from "./support-users";
import { mailHash } from "./mail-identity";
import { acknowledgeSupport } from "./support";
import type { SupportThread } from "./support-gmail";
import type { SupportConfig } from "../src/support-model";
test("registered-user evidence is complete and fresh; its isolated command cannot inherit mailbox or service tokens", async () => {
  const now = Date.now(), payload = { complete: true, observedAt: now, hashes: [mailHash("customer@example.org")] };
  assert.equal(registeredUsers(JSON.stringify(payload), now).has(mailHash("customer@example.org")), true);
  for (const changed of [{ complete: false }, { observedAt: now - 60_001 }, { observedAt: now + 5001 }, { hashes: ["not-a-hash"] }])
    assert.throws(() => registeredUsers(JSON.stringify({ ...payload, ...changed }), now));
  const directory = await mkdtemp(path.join(tmpdir(), "support-users-"));
  const before = process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
  process.env.GOOGLE_WORKSPACE_CLI_TOKEN = "must-not-reach-directory";
  try {
    const program = "if(process.env.GOOGLE_WORKSPACE_CLI_TOKEN||process.env.COLLECTOR_TOKEN||process.env.DOPPLER_TOKEN)process.exit(1);process.stdout.write(" + JSON.stringify(JSON.stringify(payload)) + ")";
    assert.equal((await readSupportUsers([process.execPath, "-e", program], directory)).size, 1);
    await assert.rejects(readSupportUsers(undefined, directory), /not connected/);
    await assert.rejects(readSupportUsers([process.execPath, "-e", "process.stdout.write('{}')"], directory), /unavailable/);
  } finally {
    if (before === undefined) delete process.env.GOOGLE_WORKSPACE_CLI_TOKEN; else process.env.GOOGLE_WORKSPACE_CLI_TOKEN = before;
    await rm(directory, { recursive: true, force: true });
  }
});
test("only a registered original sender triggers a claim; reply-all is filtered by registration and known failures before transport", async () => {
  const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [], since: "2026-11-01T00:00:00Z", acknowledge: true };
  const thread: SupportThread = { id: "1234567890abcdef", key: "b".repeat(64), subject: "Export", from: "customer@example.org",
    recipients: { to: ["customer@example.org", "other@example.org"], cc: ["owner@example.com", "outside@example.net"] }, deliveryHistoryComplete: true,
    at: Date.now(), body: "The export is empty.", messageId: "<original@example.org>", messageKeys: [], unread: true, eligible: true };
  let claims = 0, raw = "";
  const transport = {
    users: async () => new Set(["customer@example.org", "owner@example.com"].map(mailHash)),
    ack: async (_thread: SupportThread, action: string) => { claims++; return action === "reserve" ? { state: "reserved" as const, token: "token" } : action === "begin" ? { state: "sending" as const, send: true as const } : { state: "sent" as const, acknowledgedAt: Date.now() }; },
    saveToken: async () => {}, summarize: async () => ({ support: true, summary: "the export is empty" }),
    gws: async (args: string[]) => { raw = Buffer.from(JSON.parse(args[args.indexOf("--json") + 1]).raw, "base64url").toString(); return JSON.stringify({ id: "sent" }); },
  };
  assert.equal((await acknowledgeSupport({ ...thread, from: "unknown@example.org" }, config, transport)).state, "skipped");
  assert.equal(claims, 0, "a registered cc recipient cannot qualify an unknown sender");
  assert.equal((await acknowledgeSupport({ ...thread, deliveryHistoryComplete: false }, config, transport)).state, "failed");
  assert.equal(claims, 0);
  assert.equal((await acknowledgeSupport(thread, config, transport)).state, "sent");
  assert.match(raw, /^To: customer@example.org\r?$/m);
  assert.match(raw, /^Cc: owner@example.com\r?$/m);
  assert.doesNotMatch(raw, /other@example.org|outside@example.net/);
  raw = "";
  assert.equal((await acknowledgeSupport(thread, { ...config, registeredRecipients: "sender" }, transport)).state, "sent");
  assert.match(raw, /outside@example.net/);
});

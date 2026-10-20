import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { configSchema, inboxLogins } from "./config";
import { inboxCacheName, readInboxes } from "./collect";
import { applyInboxActions } from "./inbox-actions";
import type { Inbox } from "../src/inbox-model";

const base = { host: "studio", root: "/repos", home: "/Users/owner" };
test("a machine lists the owner's inbox and each person's, with the sign-in that reads it", () => {
  const matt = { account: "matt@example.com", configDir: "/Users/owner/.config/gws-matt" };
  const config = configSchema.parse({ ...base, inboxAccount: "owner@example.com", inboxAccounts: [matt] });
  assert.deepEqual(inboxLogins(config), [{ account: "owner@example.com" }, matt]);
  assert.deepEqual(inboxLogins(configSchema.parse(base)), []);
  assert.deepEqual(inboxLogins(configSchema.parse({ ...base, inboxAccounts: [matt] })), [matt]);
  // An entry for the owner's own account stands in for the plain one.
  const own = { account: "Owner@example.com", configDir: "/Users/owner/.config/gws" };
  assert.deepEqual(inboxLogins(configSchema.parse({ ...base, inboxAccount: "owner@example.com", inboxAccounts: [own] })), [own]);
  assert.equal(configSchema.safeParse({ ...base, inboxAccounts: [{ account: "a@example.com" }, { account: "A@example.com" }] }).success, false, "each account once");
  assert.equal(configSchema.safeParse({ ...base, inboxAccounts: [{ account: "a@example.com", configDir: "gws-a" }] }).success, false, "an absolute directory");
  assert.equal(configSchema.safeParse({ ...base, inboxAccounts: [{ account: "a@example.com", profile: "a" }] }).success, false);
  // The owner's cache file is the one it always was; others are named without the address.
  assert.equal(inboxCacheName("Owner@example.com", config), "inbox-cache.json");
  assert.match(inboxCacheName("matt@example.com", config), /^inbox-cache\.[a-f0-9]{16}\.json$/);
  assert.doesNotMatch(inboxCacheName("matt@example.com", config), /matt/);
  assert.notEqual(inboxCacheName("matt@example.com", config), inboxCacheName("sam@example.com", config));
});
test("each inbox is read with its own gws sign-in and refused when that sign-in is another account's", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-inboxes-"));
  const bin = path.join(root, "bin"), PATH = process.env.PATH;
  try {
    await mkdir(bin);
    // A gws whose signed-in account depends on its config directory, with an
    // empty inbox behind every account.
    await writeFile(
      path.join(bin, "gws"),
      `#!/bin/sh\ncase "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR" in\n  "") echo '{"emailAddress":"owner@example.com"}' ;;\n  */gws-matt) echo '{"emailAddress":"matt@example.com"}' ;;\n  *) echo '{"emailAddress":"someone@example.com"}' ;;\nesac\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${PATH}`;
    const config = configSchema.parse({
      ...base,
      home: root,
      inboxAccount: "owner@example.com",
      inboxAccounts: [
        { account: "matt@example.com", configDir: path.join(root, "gws-matt") },
        { account: "sam@example.com", configDir: path.join(root, "gws-sam") },
      ],
    });
    const inboxes = await readInboxes(config, null);
    assert.deepEqual(
      inboxes.map((inbox) => [inbox.account, inbox.state, inbox.threads.length]),
      [["owner@example.com", "ok", 0], ["matt@example.com", "ok", 0], ["sam@example.com", "unavailable", 0]],
      "Sam's directory is signed in as someone else, so Sam's inbox is unavailable, never another person's mail",
    );
    const files = (await readdir(path.join(root, ".local/share/project-overview"))).sort();
    assert.deepEqual(files, ["inbox-cache.json", inboxCacheName("matt@example.com", config)].sort(), "each read account caches in its own file");
  } finally {
    process.env.PATH = PATH;
    await rm(root, { recursive: true, force: true });
  }
});
const read = (account: string, ids: string[], at = 1000): Inbox => ({
  account,
  observedAt: at,
  state: "ok",
  threads: ids.map((id) => ({ id, subject: "Subject", from: "Sender", latestMessageId: id.replace(/01$/, "02"), updatedAt: at - 100, inInbox: true, lastSentByMe: false, unread: true, messages: 1 })),
});
test("the machine on duty applies each request in the inbox it names with that account's sign-in", async () => {
  const pending = [
    { threadId: "aaaaaaaaaa01", account: "owner@example.com", action: "archive", requestedAt: 900 },
    { threadId: "cccccccccc01", account: "matt@example.com", action: "archive", requestedAt: 900 },
    { threadId: "dddddddddd01", account: "sam@example.com", action: "archive", requestedAt: 900 },
    { threadId: "bbbbbbbbbb01", action: "archive", requestedAt: 900 },
  ];
  const reports: { threadId: string; state: string; message: string | null }[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET") return response.end(JSON.stringify({ actions: pending }));
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      reports.push(JSON.parse(body));
      response.end(JSON.stringify({ updated: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const used: string[] = [];
  try {
    await applyInboxActions(
      endpoint,
      {},
      [read("owner@example.com", ["aaaaaaaaaa01", "bbbbbbbbbb01"]), read("matt@example.com", ["cccccccccc01"])],
      (account) => account === "sam@example.com" ? null : async (args) => { used.push(`${account}:${JSON.parse(args[args.indexOf("--params") + 1]).id}`); return "{}"; },
      async () => true,
    );
    assert.deepEqual(
      reports.map((r) => [r.threadId, r.state]),
      [["aaaaaaaaaa01", "done"], ["cccccccccc01", "done"], ["dddddddddd01", "queued"], ["bbbbbbbbbb01", "done"]],
    );
    assert.match(reports[2].message!, /not connected on the machine on duty/);
    assert.deepEqual(used, ["owner@example.com:aaaaaaaaaa01", "matt@example.com:cccccccccc01", "owner@example.com:bbbbbbbbbb01"], "a request from before accounts were recorded is the first inbox's");
    // Without a read of an inbox, its requests wait; the other inbox's still go.
    pending.pop();
    reports.length = 0;
    used.length = 0;
    await applyInboxActions(endpoint, {}, [read("matt@example.com", ["cccccccccc01"])], () => async () => "{}", async () => true);
    assert.deepEqual(reports.map((r) => [r.threadId, r.state]), [["aaaaaaaaaa01", "queued"], ["cccccccccc01", "done"], ["dddddddddd01", "queued"]]);
  } finally {
    server.close();
  }
});

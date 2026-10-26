import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { configSchema, inboxLogins } from "./config";
import { inboxCacheName, inboxGws, mailboxes, readInboxes } from "./inbox-logins";
import { GMAIL_MODIFY_SCOPE, GMAIL_READ_SCOPE, NO_MAILBOX_DIR, TOKEN_ENDPOINT } from "./delegation";
import { applyInboxActions } from "./inbox-actions";
import type { Inbox } from "../src/inbox-model";

const base = { host: "studio", root: "/repos", home: "/Users/owner" };
test("a machine lists the owner's inbox and each person's, with the sign-in that reads it or marked delegated", () => {
  const matt = { account: "matt@example.com", configDir: "/Users/owner/.config/gws-matt" };
  const config = configSchema.parse({ ...base, inboxAccount: "owner@example.com", inboxAccounts: [matt] });
  assert.deepEqual(inboxLogins(config), [{ account: "owner@example.com" }, matt]);
  assert.deepEqual(inboxLogins(configSchema.parse(base)), []);
  assert.deepEqual(inboxLogins(configSchema.parse({ ...base, inboxAccounts: [matt] })), [matt]);
  // An entry for the owner's own account stands in for the plain one.
  const own = { account: "Owner@example.com", configDir: "/Users/owner/.config/gws" };
  assert.deepEqual(inboxLogins(configSchema.parse({ ...base, inboxAccount: "owner@example.com", inboxAccounts: [own] })), [own]);
  // An address alone is read by delegation, the owner's included; the marker
  // is derived, never configured, and the key has no place in machine.json.
  assert.deepEqual(
    inboxLogins(configSchema.parse({ ...base, inboxAccount: "owner@example.com", inboxAccounts: [{ account: "ada@example.com" }, matt] })),
    [{ account: "owner@example.com" }, { account: "ada@example.com", delegated: true }, matt],
  );
  assert.deepEqual(inboxLogins(configSchema.parse({ ...base, inboxAccount: "owner@example.com", inboxAccounts: [{ account: "owner@example.com" }] })), [{ account: "owner@example.com", delegated: true }]);
  assert.equal(configSchema.safeParse({ ...base, inboxAccounts: [{ account: "a@example.com", delegated: true }] }).success, false);
  assert.equal(configSchema.safeParse({ ...base, inboxAccounts: [{ account: "a@example.com", key: "{}" }] }).success, false);
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
test("delegated inboxes are read with an hour's token each from the key in Doppler, refused when the profile is another's, and the key reaches no file, log or snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "projects-delegation-"));
  const home = path.join(root, "home"), bin = path.join(root, "bin"), PATH = process.env.PATH;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const client = "inboxes@projects-test.iam.gserviceaccount.com";
  // Google's token endpoint: checks the grant's signature, refuses one person
  // the delegation does not cover, and issues a token naming the subject.
  const minted: [string, string][] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), TOKEN_ENDPOINT);
    const form = new URLSearchParams(init?.body as URLSearchParams);
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"), "signed with the key");
    const { iss, sub, scope } = JSON.parse(Buffer.from(claims, "base64url").toString());
    assert.equal(iss, client);
    minted.push([sub, scope]);
    return sub === "mallory@example.com"
      ? new Response(JSON.stringify({ error: "unauthorized_client", error_description: `Not authorized for ${sub}` }), { status: 401 })
      : new Response(JSON.stringify({ access_token: `tok-${sub}`, expires_in: 3600, token_type: "Bearer" }), { status: 200 });
  });
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => logged.push(line));
  try {
    await mkdir(bin);
    await mkdir(path.join(home, ".local/share/project-overview"), { recursive: true });
    await writeFile(path.join(home, ".local/share/project-overview/doppler-token"), "dp.st.example\n", { mode: 0o600 });
    await writeFile(path.join(root, "key.json"), JSON.stringify({ type: "service_account", project_id: "projects-test", private_key: pem, client_email: client, token_uri: TOKEN_ENDPOINT }));
    // Doppler hands out the key for the right name and token, until told to fail.
    await writeFile(
      path.join(bin, "doppler"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${root}/doppler.log"\n[ "$3" = GMAIL_DELEGATION_KEY ] || exit 1\n[ "$DOPPLER_TOKEN" = dp.st.example ] || exit 1\n[ "\${DOPPLER_DOWN:-}" = 1 ] && exit 1\ncat "${root}/key.json"\n`,
      { mode: 0o755 },
    );
    // A gws whose account comes from the token it was handed, or from its
    // config directory without one; Eve's token answers as someone else.
    await writeFile(
      path.join(bin, "gws"),
      `#!/bin/sh\nprintf '%s\\n' "token=$GOOGLE_WORKSPACE_CLI_TOKEN dir=$GOOGLE_WORKSPACE_CLI_CONFIG_DIR adc=$GOOGLE_APPLICATION_CREDENTIALS doppler=\${DOPPLER_TOKEN:-} $*" >> "${root}/gws.log"\ncase "$GOOGLE_WORKSPACE_CLI_TOKEN" in\n  "") [ -z "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR" ] && echo '{"emailAddress":"owner@example.com"}' || echo '{"emailAddress":"someone@example.com"}' ;;\n  tok-eve@example.com) echo '{"emailAddress":"someone.else@example.com"}' ;;\n  tok-*) echo "{\\"emailAddress\\":\\"\${GOOGLE_WORKSPACE_CLI_TOKEN#tok-}\\"}" ;;\n  *) exit 2 ;;\nesac\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${PATH}`;
    const machine = { ...base, home, doppler: { project: "projects", config: "studio" }, inboxAccount: "owner@example.com" };
    const accounts = ["ada@example.com", "sam@example.com", "eve@example.com", "mallory@example.com"].map((account) => ({ account }));
    const inboxes = await readInboxes(configSchema.parse({ ...machine, inboxAccounts: accounts }), null);
    assert.deepEqual(
      inboxes.map((inbox) => [inbox.account, inbox.state]),
      [["owner@example.com", "ok"], ["ada@example.com", "ok"], ["sam@example.com", "ok"], ["eve@example.com", "unavailable"], ["mallory@example.com", "unavailable"]],
      "the owner by sign-in, Ada and Sam by delegation; Eve's token is another's profile and Mallory is outside the delegation, so neither is anyone's mail",
    );
    assert.deepEqual(minted, accounts.map(({ account }) => [account, GMAIL_READ_SCOPE]), "one read token per delegated account");
    assert.equal((await readFile(path.join(root, "doppler.log"), "utf8")).trim().split("\n").length, 1, "the key is read once per scan");
    const calls = (await readFile(path.join(root, "gws.log"), "utf8")).trim().split("\n");
    assert.ok(calls.some((line) => line.startsWith("token= dir= ")), "the owner's calls use the default sign-in");
    assert.ok(calls.some((line) => line.startsWith(`token=tok-ada@example.com dir=${NO_MAILBOX_DIR} adc=${path.join(NO_MAILBOX_DIR, "none.json")} doppler= `)), "a delegated call has the token and no sign-in, project or credentials of the machine's user");
    assert.ok(!calls.some((line) => line.includes("tok-mallory") || line.includes("dp.st.")), "no call for a refused account; the Doppler token reaches no call");
    assert.match(logged.join("\n"), /"event":"inbox_delegation_failed","reason":"Delegated Gmail access was refused \(unauthorized_client\)\."/);
    for (const leak of ["PRIVATE KEY", "tok-", client, "dp.st."]) {
      assert.ok(!JSON.stringify(inboxes).includes(leak), `${leak} is not in the snapshot`);
      assert.ok(!logged.join("\n").includes(leak), `${leak} is not logged`);
    }
    assert.ok(!logged.join("\n").includes("mallory@"), "a refusal is logged without the account");
    for (const file of await readdir(path.join(home, ".local/share/project-overview"), { recursive: true }))
      assert.ok(!(await readFile(path.join(home, ".local/share/project-overview", file), "utf8").catch(() => "")).includes("PRIVATE KEY"), `${file} holds no key`);
    // An inbox action on a delegated account runs with a token that may change mail.
    minted.length = 0;
    await inboxGws(configSchema.parse({ ...machine, inboxAccounts: accounts }), { account: "ada@example.com", delegated: true }, GMAIL_MODIFY_SCOPE)(["gmail", "users", "getProfile", "--params", "{}"]);
    assert.deepEqual(minted, [["ada@example.com", GMAIL_MODIFY_SCOPE]]);
    // The runner's token is for a mailbox this machine lists as delegated, and
    // no other, however far the key could reach.
    minted.length = 0;
    const runner = mailboxes(configSchema.parse({ ...machine, inboxAccounts: accounts.slice(0, 1) }));
    assert.equal(await runner.mailboxToken("Ada@Example.com"), "tok-ada@example.com");
    assert.deepEqual(minted, [["ada@example.com", GMAIL_MODIFY_SCOPE]]);
    for (const account of ["sam@example.com", "owner@example.com", "stranger@example.com"])
      await assert.rejects(runner.mailboxToken(account), /Not a delegated mailbox on this machine\./, account);
    assert.equal(minted.length, 1, "no grant is signed for an unlisted account");
    minted.length = 0;
    assert.equal(await runner.mailboxToken("ada@example.com", true), "tok-ada@example.com");
    assert.deepEqual(minted, [["ada@example.com", GMAIL_READ_SCOPE]], "reconciliation receives a read-only Gmail grant");
    // Without the key, every delegated inbox is unavailable and the owner's is not.
    process.env.DOPPLER_DOWN = "1";
    logged.length = 0;
    const down = await readInboxes(configSchema.parse({ ...machine, inboxAccounts: accounts.slice(0, 2) }), null);
    assert.deepEqual(down.map((inbox) => [inbox.account, inbox.state]), [["owner@example.com", "ok"], ["ada@example.com", "unavailable"], ["sam@example.com", "unavailable"]]);
    assert.match(logged.join("\n"), /"reason":"GMAIL_DELEGATION_KEY could not be read from this machine's Doppler config\."/);
    assert.ok(!logged.join("\n").includes("ada@"), "the log names no account");
  } finally {
    process.env.PATH = PATH;
    Reflect.deleteProperty(process.env, "DOPPLER_DOWN");
    await rm(root, { recursive: true, force: true });
  }
});

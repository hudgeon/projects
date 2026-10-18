import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nativeTurn, type NativeOptions } from "./native";
import { executeRun } from "./engine";
import { claudeRules, codexConfig, parseMcpList } from "./connectors";
import { result, fixture, complete, dispatch, engineOptions } from "./run-fixtures";
import { fakeBinary } from "./native-fixtures";

test("helpers get the user's connectors read and write, but never email sending, unapproved local servers or account administration", async () => {
  const list = parseMcpList([
    "Checking MCP server health…",
    "",
    "claude.ai Example Docs: https://docs.example.com/mcp - ✔ Connected",
    "claude.ai Example Books: https://books.example.com/mcp - ✔ Connected",
    "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected",
    "plugin:viewer:files: npx -y example-viewer --stdio - ✔ Connected",
    "example-db: /usr/local/bin/example-db mcp start - ✔ Connected",
    "notes: /usr/local/bin/node /x/index.js - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed",
  ].join("\n"));
  assert.deepEqual(list.connectors, ["claude_ai_Example_Docs", "claude_ai_Example_Books", "claude_ai_Gmail"]);
  assert.deepEqual(list.local, ["plugin_viewer_files", "example-db", "notes"]);
  const policy = {localServers: ["example-db"], deniedTools: ["mcp__example-db__drop_database"]};
  const claude = claudeRules(list, policy)!;
  assert.deepEqual(claude.allow, ["mcp__claude_ai_Example_Docs", "mcp__claude_ai_Example_Books", "mcp__claude_ai_Gmail", "mcp__example-db"]);
  assert.deepEqual(claude.deny.slice(0, 2), ["mcp__plugin_viewer_files", "mcp__notes"], "unapproved local servers stay hidden");
  assert.ok(claude.deny.includes("mcp__example-db__drop_database"), "the machine's denied tools stay hidden");
  assert.ok(!claude.deny.includes("mcp__example-db__query"), "the approved server's other tools are allowed");
  assert.deepEqual(claudeRules(list)!.allow.filter((rule) => !rule.startsWith("mcp__claude_ai_")), [], "without a policy no local server is approved");
  for (const tool of ["send_message", "reply", "forward", "send_email", "forward_email"])
    assert.ok(claude.deny.includes(`mcp__claude_ai_Gmail__${tool}`), tool);
  assert.ok(!claude.deny.some((rule) => rule.startsWith("mcp__claude_ai_Example_Books__")), "other connectors keep every tool");
  // Any mail connector, not just Gmail, loses sending.
  assert.ok(claudeRules({connectors: ["claude_ai_Outlook_Mail"], local: []})!.deny.includes("mcp__claude_ai_Outlook_Mail__send_email"));
  assert.ok(codexConfig([{id: "connector_outlook", runtimeName: "Outlook Email"}]).includes("apps.connector_outlook.tools.send_email.enabled=false"));
  assert.equal(claudeRules({connectors: [], local: ["example-db"]}, policy), null, "no connectors listed: keep the browser-only setup");
  const codex = codexConfig([{id: "connector_gmail1", runtimeName: "Gmail"}, {id: "connector_drive", runtimeName: "Google Drive"}]);
  const values = codex.filter((_, i) => i % 2);
  assert.ok(codex.every((arg, i) => i % 2 || arg === "-c"));
  assert.ok(values.includes('apps._default.default_tools_approval_mode="approve"'));
  assert.ok(values.includes("apps.connector_openai_safety_settings.enabled=false"));
  assert.ok(values.includes("apps.connector_openai_plugin_management.enabled=false"));
  for (const tool of ["send_email", "send_draft", "forward_emails", "delete_emails"])
    assert.ok(values.includes(`apps.connector_gmail1.tools.${tool}.enabled=false`), tool);
  assert.ok(!values.some((value) => value.includes("connector_drive")), "other connectors keep every tool");
  assert.ok(!values.some((value) => value.startsWith("mcp_servers.")), "Codex MCP servers keep Codex's own defaults");
  // The native launches carry exactly those rules; without them Claude stays browser-only.
  const dir = await fixture();
  try {
    for (const agent of ["claude", "codex"] as const) for (const granted of [true, false]) {
      const binary = await fakeBinary(dir, agent, "success");
      const capture = path.join(dir, "launch.json");
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("import readline", `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\nimport readline`));
      await nativeTurn({agent, cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: false, signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {}, connectors: granted ? {claude, codex} : undefined});
      const args: string[] = JSON.parse(await readFile(capture, "utf8"));
      if (agent === "claude") {
        assert.equal(args.includes("--strict-mcp-config"), !granted);
        assert.equal(args[args.indexOf("--allowedTools") + 1].includes("mcp__claude_ai_Gmail"), granted);
        if (granted) {
          const denied = args[args.indexOf("--disallowedTools") + 1];
          assert.match(denied, /mcp__claude_ai_Gmail__send_message/);
          assert.match(denied, /mcp__example-db__drop_database/);
          assert.match(denied, /mcp__notes/);
        }
      } else assert.equal(args.includes('apps._default.default_tools_approval_mode="approve"'), granted);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("only helpers get connectors: never the master", async () => {
  const dir = await fixture(), o = engineOptions(dir), calls: NativeOptions[] = [];
  const access = {claude: {allow: ["mcp__claude_ai_Example_Books"], deny: []}, codex: ["-c", "apps._default.enabled=true"]};
  o.connectors = async () => access;
  o.turn = async (opts) => { calls.push(opts); await opts.onSession(randomUUID()); return calls.length === 1 ? dispatch() : calls.length === 2 ? result : complete; };
  try {
    await executeRun(o);
    assert.deepEqual(calls.map((c) => c.connectors === access), [false, true, false]);
    assert.match(calls[1].prompt, /sending, replying and forwarding are switched off/);
    assert.doesNotMatch(calls[0].prompt, /connected accounts/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

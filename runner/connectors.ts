import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nativeEnv } from "./native";

const exec = promisify(execFile);
// The user's connected accounts, as each native app offers them to a helper.
// The user approved helpers reading and writing every connector, except email
// sending, permanent email deletion and account administration. The master and
// read-only recovery get no connector approvals.
export type ConnectorAccess = {
  // Claude permission rules: whole claude.ai connector servers to allow, and
  // tools or local MCP servers to hide (hidden tools are never offered).
  // Null when Claude's connectors could not be listed.
  claude: { allow: string[]; deny: string[] } | null;
  // Codex configuration overrides for its app connectors; null when unknown.
  codex: string[] | null;
};
// Claude Code's tool prefix for an MCP server name.
export const mcpName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
// `claude mcp list` prints "<name>: <target> - <status>"; claude.ai connectors
// are named "claude.ai <Connector>". Everything else is a local MCP server.
export function parseMcpList(raw: string) {
  const connectors: string[] = [],
    local: string[] = [];
  for (const line of raw.split("\n")) {
    const at = line.indexOf(": ");
    if (at <= 0 || !/ - [✔✘!]/.test(line)) continue;
    const name = line.slice(0, at).trim();
    if (name.startsWith("claude.ai ")) connectors.push(mcpName(name));
    else local.push(mcpName(name));
  }
  return { connectors: [...new Set(connectors)], local: [...new Set(local)] };
}
// Any mail connector, by name: sending, replying and forwarding stay with
// the user. The lists cover the tool names mail connectors use; blocking a
// name a connector lacks is harmless. The user's own rule still binds every agent.
const MAIL = /mail|outlook|inbox|exchange/i;
const CLAUDE_BLOCKED = [
  "send_message", "send_email", "send_draft", "reply", "reply_message",
  "reply_to_message", "reply_email", "forward", "forward_email",
  "forward_emails", "forward_message",
];
// Codex mail tools that send or permanently delete email, and connectors that
// administer the account itself.
const CODEX_MAIL_BLOCKED = [
  "send_email", "send_draft", "send_message", "reply_email", "reply_to_email",
  "forward_email", "forward_emails", "delete_email", "delete_emails",
];
const CODEX_ADMIN = ["connector_openai_safety_settings", "connector_openai_plugin_management"];
// From the machine's config: the local MCP servers its owner approved for
// Claude helpers, and further tools to hide from them. Other local servers
// stay hidden unless the machine explicitly grants full execution access.
// Full access also approves configured Codex MCP servers.
export const helperPolicySchema = z.object({
  fullAccess: z.boolean().default(false),
  localServers: z.array(z.string().regex(/^[\w.:-]+$/)).max(50).default([]),
  deniedTools: z.array(z.string().regex(/^mcp__[\w-]+(?:__[\w-]+)?$/)).max(500).default([]),
}).strict().default({fullAccess: false, localServers: [], deniedTools: []});
export type HelperPolicy = { fullAccess?: boolean; localServers: string[]; deniedTools: string[] };
export function claudeRules(
  list: ReturnType<typeof parseMcpList>,
  policy: HelperPolicy = { localServers: [], deniedTools: [] },
) {
  if (!list.connectors.length && !policy.fullAccess) return null;
  const approved = new Set(policy.localServers.map(mcpName));
  const local = list.local.filter((server) => (policy.fullAccess || approved.has(server)));
  return {
    allow: [...list.connectors, ...local].map((server) => `mcp__${server}`),
    deny: [
      ...list.local
        .filter((server) => !(policy.fullAccess || approved.has(server)))
        .map((server) => `mcp__${server}`),
      ...(policy.fullAccess ? [] : policy.deniedTools),
      ...[...list.connectors, ...local]
        .filter((server) => MAIL.test(server))
        .flatMap((server) => CLAUDE_BLOCKED.map((tool) => `mcp__${server}__${tool}`)),
    ],
  };
}
export function codexConfig(apps: { id: string; runtimeName: string }[]) {
  return [
    'apps._default.default_tools_approval_mode="approve"',
    "apps._default.destructive_enabled=true",
    "apps._default.open_world_enabled=true",
    ...CODEX_ADMIN.map((id) => `apps.${id}.enabled=false`),
    ...apps
      .filter((app) => MAIL.test(app.runtimeName) && /^[\w-]+$/.test(app.id))
      .flatMap((app) =>
        CODEX_MAIL_BLOCKED.map((tool) => `apps.${app.id}.tools.${tool}.enabled=false`),
      ),
  ].flatMap((value) => ["-c", value]);
}
async function claudeList() {
  const { stdout } = await exec("claude", ["mcp", "list"], {
    cwd: homedir(),
    env: nativeEnv(),
    timeout: 60_000,
    maxBuffer: 1_000_000,
  });
  return parseMcpList(stdout);
}
// The installed Codex app connectors, from a short-lived app server.
function codexApps(): Promise<{ id: string; runtimeName: string }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: homedir(),
      env: nativeEnv(),
      stdio: "pipe",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Codex app list timed out."));
    }, 30_000);
    let buffer = "";
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.on("error", reject);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: { id?: number; result?: { apps?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "app/installed", params: {} });
        }
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          const data = Array.isArray(message.result?.apps) ? message.result.apps : [];
          resolve(
            data.flatMap((app) =>
              app && typeof app.id === "string" && typeof app.runtimeName === "string"
                ? [{ id: app.id, runtimeName: app.runtimeName }]
                : [],
            ),
          );
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "projects_runner", title: "Projects", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
// Plugin servers need plugin-scoped overrides: creating mcp_servers.<name>
// for one loses its injected transport and prevents the app server starting.
export function codexMcpConfig(servers: {name: string}[], plugins: Map<string, string> = new Map()) {
  return servers.filter(s => /^[\w-]+$/.test(s.name)).flatMap(({name}) => {
    const plugin = plugins.get(name);
    const prefix = plugin ? `plugins.${JSON.stringify(plugin)}.mcp_servers.${name}` : `mcp_servers.${name}`;
    return ["-c", `${prefix}.enabled=true`, "-c", `${prefix}.default_tools_approval_mode="approve"`,
      ...(MAIL.test(name) ? ["-c", `${prefix}.disabled_tools=${JSON.stringify(CODEX_MAIL_BLOCKED)}`] : [])];
  });
}
async function fullCodexConfig() {
  const run = (args: string[]) => exec("codex", args, {
    cwd: homedir(), env: nativeEnv(), timeout: 30_000, maxBuffer: 1_000_000,
  }).then(result => JSON.parse(result.stdout));
  const [servers, catalog] = await Promise.all([run(["mcp", "list", "--json"]), run(["plugin", "list", "--json"])]);
  const plugins = new Map<string, string>();
  for (const plugin of catalog.installed ?? []) {
    const root = plugin.source?.source === "local" ? plugin.source.path :
      path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "plugins/cache", plugin.marketplaceName, plugin.name, plugin.version);
    for (const name of [".mcp.json", "mcp.json"]) {
      const manifest = await readFile(path.join(root, name), "utf8").then(JSON.parse, () => null);
      for (const server of Object.keys(manifest?.mcpServers ?? {})) plugins.set(server, plugin.pluginId);
    }
  }
  return codexMcpConfig(servers, plugins);
}
let cached: { at: number; access: Promise<ConnectorAccess> } | null = null;
// Discovered once an hour. If an app cannot be asked, its helpers keep the
// master's setup (Claude the browser only, Codex its own defaults), which is
// never broader than approved.
export function connectorAccess(policy?: HelperPolicy): Promise<ConnectorAccess> {
  if (cached && Date.now() - cached.at < 3600_000) return cached.access;
  const access = Promise.all([
    claudeList().then((list) => claudeRules(list, policy), () => null),
    Promise.all([codexApps().then(codexConfig), policy?.fullAccess ? fullCodexConfig() : []])
      .then(parts => parts.flat(), () => null),
  ]).then(([claude, codex]) => ({ claude, codex }));
  cached = { at: Date.now(), access };
  return access;
}

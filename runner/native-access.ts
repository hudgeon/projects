// Process-local native execution policy, shared by launch and RPC requests.
import path from "node:path";
import type { NativeOptions } from "./native";

export const fullAccess = (o: Pick<NativeOptions, "readOnly" | "fullAccess">) =>
  !o.readOnly && o.fullAccess === true;
// Codex runs at standard speed only, whatever the machine's own config says:
// Projects never uses fast mode. "default" is Codex's name for that tier.
export const CODEX_TIER = "default";
// A Claude turn's permission mode. Nobody answers a prompt in an unattended
// turn: whatever would ask is denied, Claude is told not to retry it, and the
// tools that ask a person are removed.
export const claudePermissions = (o: Pick<NativeOptions, "readOnly" | "fullAccess">) => [
  "--permission-mode", fullAccess(o) ? "bypassPermissions" : "dontAsk",
  "--permission-prompts", "none",
];

// The built-in tools a Claude turn gets, and the rules that allow them. A
// helper given the user's connectors gets tool search with them: Claude Code
// then names each MCP tool and loads its definition when the turn looks it
// up, where a list without the search sends every definition in every
// request. The search finds only what the turn may see: a denied tool is
// removed before it. It also holds back the built-ins Claude Code defers
// (TaskStop, Monitor). A turn with only this conversation's browser has
// nothing to look up and keeps its list.
// No plan tool is listed: Claude Code's TodoWrite is gone, and its task tools
// add about 2,700 tokens to every request, or sit unseen behind the search.
// The page shows a Claude turn's progress from its PROJECTS_PROGRESS notes.
// A read turn given the web fetches the named hosts: WebFetch is enabled, and
// only domain rules allow it, never a bare one. Claude Code also fetches the
// documentation domains it preapproves itself without asking, and refuses
// every other host in its unattended mode; a deny rule cannot carve those
// out without denying the named hosts too.
export function claudeTools(o: Pick<NativeOptions, "readOnly" | "fullAccess" | "web" | "connectors">) {
  const enabled = fullAccess(o) ? "default" : [
    o.readOnly ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash,TaskStop,Monitor",
    ...(o.connectors?.claude ? ["ToolSearch"] : []),
  ].join(",");
  const web = o.readOnly && o.web?.length ? o.web : [];
  return {
    enabled: [enabled, ...(web.length ? ["WebFetch"] : [])].join(","),
    allowed: [enabled, ...web.map((host) => `WebFetch(domain:${host})`)],
  };
}
export function codexPermissions(o: NativeOptions, thread = false) {
  if (o.readOnly) return thread
    ? { sandbox: "read-only" }
    : { sandboxPolicy: { type: "readOnly", networkAccess: true } };
  if (fullAccess(o)) return thread
    ? { sandbox: "danger-full-access" }
    : { sandboxPolicy: { type: "dangerFullAccess" } };
  return { permissions: "projects_job" };
}
export function codexFilesystem(o: NativeOptions) {
  if (o.readOnly || fullAccess(o)) return [];
  const filesystem = {
    ":root": "read", ":tmpdir": "write", ":slash_tmp": "write",
    [o.cwd]: "write", [path.join(o.cwd, ".git")]: "read",
    [path.join(o.cwd, ".codex")]: "read", [path.join(o.cwd, ".agents")]: "read",
    ...Object.fromEntries((o.writableRoots ?? []).map(root => [root, "write"])),
  };
  const profile = `{${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`;
  return ["-c", `permissions.projects_job.filesystem=${profile}`,
    "-c", "permissions.projects_job.network.enabled=true"];
}

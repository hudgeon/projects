// Process-local native execution policy, shared by launch and RPC requests.
import path from "node:path";
import type { NativeOptions } from "./native";

export const fullAccess = (o: Pick<NativeOptions, "readOnly" | "fullAccess">) =>
  !o.readOnly && o.fullAccess === true;

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

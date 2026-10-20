import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configSchema } from "../collector/config";
import { helperPolicySchema } from "./connectors";
import { contextConfigSchema } from "./context";
import { telemetry } from "../src/telemetry";

const absolute = z.string().refine(path.isAbsolute);
// Every connected machine runs the runner with its own config, the same file
// its collector reads. Its paths default beside it.
export const schema = configSchema
  .extend({
    concurrency: z.number().int().min(1).max(5).default(3),
    // Extra slots only quick work (such as unsubscribes) may use.
    quickConcurrency: z.number().int().min(0).max(5).default(5),
    endpoint: z.url(),
    stateDir: absolute.optional(),
    worktreeRoot: absolute.optional(),
    masterCwd: absolute.optional(),
    // An owner-only file holding this machine's runner token. Without one, a
    // runner-token file beside this config, else RUNNER_TOKEN from the
    // machine's Doppler config.
    tokenFile: absolute.optional(),
    // The selector reads JEV_API_KEY only in this executor's memory. Native
    // agents and the collector never receive it. Off until explicitly enabled.
    context: contextConfigSchema.default({ mode: "off" }),
    // Local MCP servers Claude helpers may use on this machine, and tools to
    // hide from them as Claude permission rules (mcp__server__tool).
    helpers: helperPolicySchema,
  })
  .transform((config) => {
    const base = path.join(config.home, ".local/share/project-overview");
    return {
      ...config,
      stateDir: config.stateDir ?? path.join(base, "runner"),
      worktreeRoot: config.worktreeRoot ?? path.join(base, "worktrees"),
      masterCwd: config.masterCwd ?? config.root,
      // Doppler supplies the token only when no file is named or present.
      tokenFile:
        config.tokenFile ??
        (config.doppler && !existsSync(path.join(base, "runner-token"))
          ? null
          : path.join(base, "runner-token")),
    };
  });
export type Config = z.output<typeof schema>;

// The key paths a config failed on, never its values. An unrecognized key
// names itself, so a config written for a newer bundle than the one running
// (helpers.fullAccess before a runner knew it) shows in the log. A segment
// the owner chose, such as a project id, is replaced by "*".
export function invalidKeys(issues: z.ZodError["issues"]): string[] {
  const segment = (part: PropertyKey) =>
    typeof part === "number" || /^[\w-]+$/.test(String(part)) ? String(part) : "*";
  const keys = new Set<string>();
  for (const issue of issues) {
    const base = issue.path.map(segment);
    const named = issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...base, segment(key)]) : [base];
    for (const key of named) keys.add(key.join(".") || "<root>");
  }
  return [...keys];
}

// The release the installed bundle came from, as the installer recorded it
// beside the bundle; nothing when run from sources.
export function installedRelease(script = process.argv[1] ?? ""): string | undefined {
  try {
    const sidecar = JSON.parse(readFileSync(path.join(path.dirname(script), "release.json"), "utf8"));
    const commit = z.string().regex(/^[0-9a-f]{7,40}$/).parse(sidecar.commit);
    return `${commit.slice(0, 12)}${sidecar.dirty === true ? "-dirty" : ""}`;
  } catch {
    return undefined;
  }
}

// Reads the runner's config. A config it cannot use is logged by key before
// the start fails, so a crash loop is diagnosable from the log alone.
export async function loadConfig(file: string, release = installedRelease()): Promise<Config> {
  const invalid = (configKey: string) =>
    telemetry("runner", "runner_config_invalid", { configKey, release }, "error");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    invalid(error instanceof SyntaxError ? "<syntax>" : "<unreadable>");
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const key of invalidKeys(parsed.error.issues).slice(0, 20)) invalid(key);
    throw parsed.error;
  }
  return parsed.data;
}

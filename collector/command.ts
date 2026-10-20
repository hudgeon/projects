// The subprocesses the collector and runner start: each with a clean
// environment, and one that reads a secret from the machine's Doppler config.
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config";

const exec = promisify(execFile);
export function subprocessEnv() {
  const env = { ...process.env };
  for (const key of [
    "GITHUB_APP_PRIVATE_KEY",
    "DOPPLER_TOKEN",
    "COLLECTOR_TOKEN",
    "RUNNER_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "JEV_API_KEY",
    "TYPESAFE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ])
    delete env[key];
  return env;
}
// One secret from this machine's Doppler config, read with its read-only
// service token. The service token goes only to this call, and the value only
// to the caller: neither enters an environment that outlives it.
export async function machineSecret(
  config: Pick<Config, "home" | "doppler">,
  name: string,
  doppler = "doppler",
) {
  if (!config.doppler) throw Error("This machine names no Doppler config.");
  const base = path.join(config.home, ".local/share/project-overview");
  const file = path.join(base, "doppler-token");
  if ((await stat(file)).mode & 0o077)
    throw Error("The Doppler service token must be readable only by its owner.");
  const token = (await readFile(file, "utf8")).trim();
  if (!token.startsWith("dp.st."))
    throw Error("The Doppler service token is missing.");
  await mkdir(path.join(base, "doppler"), { recursive: true, mode: 0o700 });
  const { stdout } = await exec(
    doppler,
    [
      "secrets",
      "get",
      name,
      "--plain",
      "--config-dir",
      path.join(base, "doppler"),
      "--project",
      config.doppler.project,
      "--config",
      config.doppler.config,
    ],
    {
      timeout: 30_000,
      maxBuffer: 100_000,
      env: { ...subprocessEnv(), DOPPLER_TOKEN: token },
    },
  ).catch(() => {
    throw Error(`${name} could not be read from this machine's Doppler config.`);
  });
  return stdout.trim();
}
export async function command(
  bin: string,
  args: string[],
  cwd?: string,
  env: Record<string, string> = {},
) {
  const { stdout } = await exec(bin, args, {
    cwd,
    timeout: 20_000,
    maxBuffer: 4_000_000,
    env: {
      ...subprocessEnv(),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      ...env,
    },
  });
  return stdout.trimEnd();
}

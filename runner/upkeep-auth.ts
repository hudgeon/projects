import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { UpkeepAuth } from "../src/upkeep-model";
import { nativeEnv } from "./native-env";
import { object } from "./native-events";

function cliOutput(binary: string, args: string[]) {
  return new Promise<{ code: unknown; stdout: string }>((resolve) => {
    execFile(binary, args, {
      cwd: homedir(), env: nativeEnv(), timeout: 15_000,
      killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8",
    }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
  });
}

// Claude Code 2.1.317 fixed auth status exiting before a refresh was saved.
// Older binaries can still run upkeep, without probing their login in a loop.
export async function claudeAuthStatus(binary = "claude"): Promise<UpkeepAuth> {
  const version = await cliOutput(binary, ["--version"]);
  const parts = version.stdout.match(/^(\d+)\.(\d+)\.(\d+) \(Claude Code\)/)?.slice(1).map(Number);
  if (version.code !== 0 || !parts) return "unknown";
  const [major, minor, patch] = parts;
  if (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 317)))) return "unknown";
  // The native CLI owns refresh. Only the readiness category leaves the machine.
  const { code, stdout } = await cliOutput(binary, ["auth", "status", "--json"]);
  try {
    const status = object(JSON.parse(stdout));
    if (code === 0 && status.loggedIn === true && status.authMethod === "claude.ai")
      return "ready";
    if (code === 1 && status.loggedIn === false && status.authMethod === "none")
      return "signed_out";
  } catch {
    // Unrecognized or absent output is not evidence of a sign-out.
  }
  return "unknown";
}

export function upkeepAuth(read = claudeAuthStatus, now = Date.now) {
  let status: UpkeepAuth | undefined, nextCheck = 0, checking = false;
  return () => {
    if (!checking && now() >= nextCheck) {
      checking = true;
      void read().then(
        (result) => { status = result; },
        () => { status = "unknown"; },
      ).finally(() => {
        nextCheck = now() + (status === "signed_out" ? 5 : 60) * 60_000;
        checking = false;
      });
    }
    return status;
  };
}

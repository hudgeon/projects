import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
// The background services: this machine's collector every two minutes, and
// with --chats its chat watcher (collector/chats.ts), kept running; each
// inside its Doppler config when it names one. A dedicated read-only Doppler
// service token keeps them independent of a GUI keychain session.
const base = `${homedir()}/.local/share/project-overview`;
try {
  const file = `${base}/machine.json`;
  // The collector validates the whole config; this reads only its Doppler
  // names, so the service stays small.
  const { doppler } = JSON.parse(readFileSync(file, "utf8")) as {
    doppler?: { project?: unknown; config?: unknown };
  };
  const name = (value: unknown): value is string =>
    typeof value === "string" && /^\w[\w.-]*$/.test(value);
  if (doppler && !(name(doppler.project) && name(doppler.config)))
    throw Error("Invalid Doppler config");
  if (process.argv.includes("--review") || process.argv.includes("--send-daily"))
    throw Error("Daily briefs have been retired");
  const chats = process.argv.includes("--chats");
  const collector = chats
    ? [`${base}/chats.mjs`, file]
    : [`${base}/collector.mjs`, file, ...(process.argv.includes("--snapshot") ? [] : ["--publish", "--closes"])];
  // The watcher runs until it stops; launchd starts it again.
  const options = chats ? ({ stdio: "inherit" } as const) : ({ stdio: "inherit", timeout: 300000 } as const);
  if (!doppler) execFileSync(process.execPath, collector, options);
  else {
    const token = readFileSync(`${base}/doppler-token`, "utf8").trim();
    if (!token.startsWith("dp.st.")) throw Error("Missing service credential");
    mkdirSync(`${base}/doppler`, { recursive: true, mode: 0o700 });
    // Only the secrets each reads; the config also holds the runner's token,
    // which stays out of both environments, and Slack's tokens reach only the
    // watcher.
    const secrets = chats ? "COLLECTOR_TOKEN,SLACK_APP_TOKEN,SLACK_USER_TOKENS" : "COLLECTOR_TOKEN,GITHUB_APP_ID,GITHUB_APP_PRIVATE_KEY";
    execFileSync(
      "doppler",
      ["run", "--config-dir", `${base}/doppler`, "--project", doppler.project as string, "--config", doppler.config as string, "--only-secrets", secrets, "--no-exit-on-missing-only-secrets", "--", process.execPath, ...collector],
      { ...options, env: { ...process.env, DOPPLER_TOKEN: token } },
    );
  }
} catch {
  console.error(
    "Projects background service failed; check credential expiry and source coverage.",
  );
  process.exitCode = 1;
}

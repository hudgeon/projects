import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
// The background service: runs this machine's collector every two minutes,
// inside its Doppler config when it names one. A dedicated read-only Doppler
// service token keeps it independent of a GUI keychain session.
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
  const collector = [
    `${base}/collector.mjs`,
    file,
    ...(process.argv.includes("--snapshot") ? [] : ["--publish", "--closes"]),
  ];
  const options = { stdio: "inherit", timeout: 300000 } as const;
  if (!doppler) execFileSync(process.execPath, collector, options);
  else {
    const token = readFileSync(`${base}/doppler-token`, "utf8").trim();
    if (!token.startsWith("dp.st.")) throw Error("Missing service credential");
    mkdirSync(`${base}/doppler`, { recursive: true, mode: 0o700 });
    // Only the secrets the collector reads; the config also holds the
    // runner's token, which stays out of the collector's environment.
    execFileSync(
      "doppler",
      ["run", "--config-dir", `${base}/doppler`, "--project", doppler.project as string, "--config", doppler.config as string, "--only-secrets", "COLLECTOR_TOKEN,GITHUB_APP_ID,GITHUB_APP_PRIVATE_KEY", "--no-exit-on-missing-only-secrets", "--", process.execPath, ...collector],
      { ...options, env: { ...process.env, DOPPLER_TOKEN: token } },
    );
  }
} catch {
  console.error(
    "Collector service failed; check credential expiry and source coverage.",
  );
  process.exitCode = 1;
}

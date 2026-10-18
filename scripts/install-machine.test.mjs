import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Each test installs a release into a home of its own, with stand-ins for the
// commands the installer runs placed first on PATH.
async function machine(t) {
  const root = await mkdtemp(path.join(tmpdir(), "projects-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "release"), home = path.join(root, "home"), bin = path.join(root, "bin");
  const base = path.join(home, ".local/share/project-overview");
  await mkdir(path.join(release, "scripts"), { recursive: true });
  await mkdir(path.join(release, ".local"));
  await mkdir(base, { recursive: true });
  await mkdir(bin);
  await copyFile(path.join(import.meta.dirname, "install-machine.mjs"), path.join(release, "scripts/install-machine.mjs"));
  for (const bundle of ["collector", "service", "runner", "work-item"])
    await writeFile(path.join(release, ".local", `${bundle}.mjs`), "// bundle\n");
  const install = (args, env = {}, node = []) =>
    promisify(execFile)(process.execPath, [...node, path.join(release, "scripts/install-machine.mjs"), ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } });
  const config = async () => JSON.parse(await readFile(path.join(base, "machine.json"), "utf8"));
  const connect = ["--machine", "laptop", "--endpoint", "https://projects.example.com", "--root", path.join(root, "code")];
  return { root, home, bin, base, install, config, connect };
}
const tokens = { PROJECTS_COLLECTOR_TOKEN: "c".repeat(64), PROJECTS_RUNNER_TOKEN: "r".repeat(64) };

test("the installer keeps a Doppler machine's tokens in Doppler and writes token files only without one", { timeout: 30000 }, async (t) => {
  const { base, bin, install, config, connect } = await machine(t);
  // A Doppler stand-in that lists the names given in NAMES.
  await writeFile(path.join(bin, "doppler"), `#!/bin/sh\nprintf '%s' "$NAMES"\n`, { mode: 0o755 });
  await writeFile(path.join(base, "doppler-token"), "dp.st.example", { mode: 0o600 });
  const args = [...connect, "--no-services"];
  const names = (...list) => JSON.stringify(Object.fromEntries(list.map((name) => [name, {}])));
  await writeFile(path.join(base, "machine.json"), JSON.stringify({ doppler: { project: "projects", config: "laptop" } }), { mode: 0o600 });
  await install(args, { NAMES: names("COLLECTOR_TOKEN", "RUNNER_TOKEN") });
  assert.equal(existsSync(path.join(base, "collector-token")), false);
  assert.equal(existsSync(path.join(base, "runner-token")), false);
  assert.equal((await config()).collectorTokenFile, undefined);
  assert.equal(existsSync(path.join(base, "runner.mjs")), true);
  await assert.rejects(install(args, { NAMES: names("COLLECTOR_TOKEN") }), (e) => e.stderr.includes("Add RUNNER_TOKEN to the Doppler config projects/laptop first."));
  // An existing runner-token file still wins, so only the collector's name is needed.
  await writeFile(path.join(base, "runner-token"), "r".repeat(64), { mode: 0o600 });
  await install(args, { NAMES: names("COLLECTOR_TOKEN") });
  // Without a Doppler config, both tokens are owner-only files, as before.
  await writeFile(path.join(base, "machine.json"), "{}", { mode: 0o600 });
  await rm(path.join(base, "runner-token"));
  await install(args, { NAMES: "", ...tokens });
  for (const file of ["collector-token", "runner-token"]) assert.equal((await stat(path.join(base, file))).mode & 0o777, 0o600);
  assert.equal((await config()).collectorTokenFile, path.join(base, "collector-token"));
});

test("a later run without labels restarts the services under the launchd labels first given", { timeout: 30000 }, async (t) => {
  const { root, home, bin, install, config, connect } = await machine(t);
  // A launchd stand-in that logs each call and knows the jobs it bootstrapped.
  const log = path.join(root, "launchctl.log");
  await writeFile(
    path.join(bin, "launchctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  print) grep -qxF "$2" "${log}.loaded" ;;
  bootstrap) printf '%s/%s\\n' "$2" "$(basename "$3" .plist)" >> "${log}.loaded" ;;
esac
`,
    { mode: 0o755 },
  );
  // The services are installed only on a Mac.
  const mac = ["--import", 'data:text/javascript,Object.defineProperty(process,"platform",{value:"darwin"})'];
  await install([...connect, "--collector-label", "com.example.collector", "--runner-label", "com.example.runner"], tokens, mac);
  const { collectorLabel, runnerLabel } = await config();
  assert.deepEqual([collectorLabel, runnerLabel], ["com.example.collector", "com.example.runner"]);
  await rm(log);
  await install([], {}, mac);
  // The collector's definition is unchanged, so it keeps running; the runner restarts.
  const domain = `gui/${process.getuid()}`;
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    `print ${domain}/com.example.collector`,
    `print ${domain}/com.example.runner`,
    `kill SIGUSR2 ${domain}/com.example.runner`,
  ]);
  assert.deepEqual((await readdir(path.join(home, "Library/LaunchAgents"))).sort(), ["com.example.collector.plist", "com.example.runner.plist"]);
  await assert.rejects(install(["--runner-label", "../runner"], {}, mac), (e) => e.stderr.includes("as launchd labels"));
  assert.equal((await config()).runnerLabel, "com.example.runner");
});

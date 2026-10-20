import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUNDLES = ["collector", "service", "chats", "runner", "work-item"];
// Each test installs a release into a home of its own, with stand-ins for the
// commands the installer runs placed first on PATH: a git that answers for the
// checkout, an npm whose build writes the bundles (stale ones are there
// first), and a launchd that remembers the jobs it was told to bootstrap and
// a pid for each, which a kill or kickstart replaces as a restart would.
async function machine(t) {
  const root = await mkdtemp(path.join(tmpdir(), "projects-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "release"), home = path.join(root, "home"), bin = path.join(root, "bin");
  const base = path.join(home, ".local/share/project-overview");
  const log = path.join(root, "launchctl.log"), state = path.join(root, "launchd");
  await mkdir(path.join(release, "scripts"), { recursive: true });
  await mkdir(path.join(release, ".local"));
  await mkdir(base, { recursive: true });
  await mkdir(bin);
  await mkdir(state);
  for (const script of ["install-machine.mjs", "launchd.mjs"])
    await copyFile(path.join(import.meta.dirname, script), path.join(release, "scripts", script));
  for (const bundle of BUNDLES)
    await writeFile(path.join(release, ".local", `${bundle}.mjs`), "// stale bundle\n");
  await writeFile(path.join(bin, "git"), `#!/bin/sh
case "$*" in
  *"rev-parse HEAD") printf '%s\\n' "${COMMIT}" ;;
  *"status --porcelain"*) printf '%s' "\${DIRTY:-}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  await writeFile(path.join(bin, "npm"), `#!/bin/sh
printf '%s\\n' "$PWD $*" >> "${root}/npm.log"
[ "\${BUILD_FAILS:-}" = 1 ] && exit 1
mkdir -p .local
for bundle in ${BUNDLES.join(" ")}; do printf '// built %s\\n' "\${BUILD_STAMP:-fresh}" > ".local/$bundle.mjs"; done
`, { mode: 0o755 });
  await writeFile(path.join(bin, "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  print) job="${state}/\${2##*/}"; [ -f "$job" ] || exit 113
    if [ -s "$job" ]; then printf '\\tstate = running\\n\\tpid = %s\\n\\tlast exit code = 0\\n' "$(cat "$job")"
      if [ -f "$job.dies" ]; then : > "$job"; fi
    else printf '\\tstate = not running\\n\\tlast exit code = 1\\n'; fi ;;
  bootstrap) label="\${3##*/}"; label="\${label%.plist}"
    case "$label" in *runner*) echo $$ > "${state}/$label" ;; *) : > "${state}/$label" ;; esac ;;
  bootout) rm -f "${state}/\${2##*/}" ;;
  kickstart) echo $$ > "${state}/\${2##*/}" ;;
  kill) job="${state}/\${3##*/}"
    [ -s "$job" ] || { echo "Could not signal service: 3: No process to signal" >&2; exit 3; }
    echo $(( $(cat "$job") + 1 )) > "$job" ;;
esac
`, { mode: 0o755 });
  const install = (args, env = {}, node = []) =>
    promisify(execFile)(process.execPath, [...node, path.join(release, "scripts/install-machine.mjs"), ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } });
  const config = async () => JSON.parse(await readFile(path.join(base, "machine.json"), "utf8"));
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n");
  const connect = ["--machine", "laptop", "--endpoint", "https://projects.example.com", "--root", path.join(root, "code")];
  return { root, home, bin, base, release, state, install, config, calls, connect };
}
const tokens = { PROJECTS_COLLECTOR_TOKEN: "c".repeat(64), PROJECTS_RUNNER_TOKEN: "r".repeat(64) };
// The services are installed only on a Mac.
const mac = ["--import", 'data:text/javascript,Object.defineProperty(process,"platform",{value:"darwin"})'];
const domain = `gui/${process.getuid()}`;

test("the installer builds the bundles from the checkout, records its commit, and installs nothing when the build fails", { timeout: 30000 }, async (t) => {
  const { root, base, release, install, connect } = await machine(t);
  const { stdout } = await install([...connect, "--no-services"], tokens);
  assert.deepEqual((await readFile(path.join(root, "npm.log"), "utf8")).trim().split("\n"), [`${await realpath(release)} run collector:build`], "built in the checkout the installer came from");
  for (const bundle of BUNDLES)
    assert.equal(await readFile(path.join(base, `${bundle}.mjs`), "utf8"), "// built fresh\n", `${bundle} comes from this build, not the stale one`);
  assert.equal((await stat(base)).mode & 0o777, 0o700, "an existing directory is made yours alone");
  const recorded = JSON.parse(await readFile(path.join(base, "release.json"), "utf8"));
  assert.equal(recorded.commit, COMMIT);
  assert.equal(recorded.dirty, false);
  assert.match(stdout, /^Installed 0123456789ab \(was an unrecorded commit\) in /m);
  // A failed build changes nothing: the installed bundles and record stay.
  await assert.rejects(install([...connect, "--no-services"], { ...tokens, BUILD_FAILS: "1" }), (e) => e.stderr.includes("Building the bundles failed; nothing was installed."));
  assert.equal(await readFile(path.join(base, "runner.mjs"), "utf8"), "// built fresh\n");
  assert.equal(JSON.parse(await readFile(path.join(base, "release.json"), "utf8")).commit, COMMIT);
  // A later build from a changed checkout replaces them and says what was there.
  const again = await install([...connect, "--no-services"], { ...tokens, BUILD_STAMP: "later", DIRTY: " M runner/main.ts" });
  assert.equal(await readFile(path.join(base, "runner.mjs"), "utf8"), "// built later\n");
  assert.match(again.stdout, /^Installed 0123456789ab with uncommitted changes \(was 0123456789ab\) in /m);
});

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

test("a later run without labels drains the running runner under the launchd labels first given and reports the new process", { timeout: 30000 }, async (t) => {
  const { home, install, config, calls, connect, state } = await machine(t);
  await install([...connect, "--collector-label", "com.example.collector", "--runner-label", "com.example.runner"], tokens, mac);
  const { collectorLabel, runnerLabel } = await config();
  assert.deepEqual([collectorLabel, runnerLabel], ["com.example.collector", "com.example.runner"]);
  const first = Number(await readFile(path.join(state, "com.example.runner"), "utf8"));
  const before = (await calls()).length;
  const { stdout } = await install([], {}, mac);
  // The collector's definition is unchanged, so it keeps running; the runner
  // is asked to drain, and no job is booted out or started again.
  const later = (await calls()).slice(before);
  assert.deepEqual(later.filter((call) => !call.startsWith("print ")), [`kill SIGUSR2 ${domain}/com.example.runner`]);
  assert.ok(later.includes(`print ${domain}/com.example.collector`));
  assert.match(stdout, new RegExp(`^Runner: running \\(pid ${first + 1}\\) on 0123456789ab\\.$`, "m"));
  assert.deepEqual((await readdir(path.join(home, "Library/LaunchAgents"))).sort(), ["com.example.collector.plist", "com.example.runner.plist"]);
  await assert.rejects(install(["--runner-label", "../runner"], {}, mac), (e) => e.stderr.includes("as launchd labels"));
  assert.equal((await config()).runnerLabel, "com.example.runner");
});

test("a runner job with no process is kickstarted rather than signalled, and one that keeps exiting is reported with where to look", { timeout: 30000 }, async (t) => {
  const { base, install, calls, connect, state } = await machine(t);
  await install(connect, tokens, mac);
  // The runner crashed at start (a config this bundle rejects, say) and
  // launchd is waiting to retry: its job is loaded, but nothing is running.
  const job = path.join(state, "local.projects.runner");
  await writeFile(job, "");
  let before = (await calls()).length;
  const { stdout } = await install([], {}, mac);
  assert.deepEqual((await calls()).slice(before).filter((call) => !call.startsWith("print ")), [`kickstart ${domain}/local.projects.runner`]);
  assert.match(stdout, /^Runner: running \(pid \d+\) on 0123456789ab\.$/m);
  // When the started process exits again, the report says so and names the log.
  await writeFile(job, "");
  await writeFile(`${job}.dies`, "");
  before = (await calls()).length;
  const failing = await install([], {}, mac);
  assert.deepEqual((await calls()).slice(before).filter((call) => !call.startsWith("print ")), [`kickstart ${domain}/local.projects.runner`]);
  assert.match(failing.stdout, new RegExp(`^Runner: not running \\(last exit code 1\\); launchd retries every 30 seconds\\. Look for runner_config_invalid and runner_start_failed in ${path.join(base, "runner-error.log")}\\.$`, "m"));
});

test("--add-inbox connects a person's gws directory, existing and readable by you alone, without touching the rest of machine.json; --remove-inbox drops it", { timeout: 30000 }, async (t) => {
  const { root, home, install, config, connect } = await machine(t);
  const first = await install([...connect, "--no-services", "--inbox", "you@example.com", "--work-repo", "acme/work"], tokens);
  assert.match(first.stdout, /^Inboxes: you@example\.com \(default gws sign-in\)\.$/m);
  const before = await config();
  assert.equal(before.inboxAccounts, undefined, "nothing is written until an inbox is connected");
  const ada = path.join(home, "gws-ada");
  await mkdir(ada, { mode: 0o700 });
  const { stdout } = await install(["--no-services", "--add-inbox", "ada@example.com=~/gws-ada"], tokens);
  const after = await config();
  assert.deepEqual(after.inboxAccounts, [{ account: "ada@example.com", configDir: ada }], "~ is this user's home");
  assert.deepEqual({ ...after, inboxAccounts: undefined }, { ...before, inboxAccounts: undefined }, "the rest of the config is untouched");
  assert.equal(stdout.trim().split("\n").at(-1), `Inboxes: you@example.com (default gws sign-in); ada@example.com (${ada}).`);
  // Adding the same account again points it at another directory rather than listing it twice.
  const moved = path.join(root, "gws-ada-2");
  await mkdir(moved, { mode: 0o700 });
  await install(["--no-services", "--add-inbox", `Ada@Example.com=${moved}`], tokens);
  assert.deepEqual((await config()).inboxAccounts, [{ account: "Ada@Example.com", configDir: moved }]);
  // Refused, changing nothing: a directory others can read, a missing one, a relative one, a malformed entry.
  const shared = path.join(root, "gws-shared");
  await mkdir(shared, { mode: 0o755 });
  for (const [entry, message] of [
    [`bob@example.com=${shared}`, `readable by you alone, like gws's own config directory: chmod 700 ${shared}`],
    [`bob@example.com=${path.join(root, "missing")}`, "does not exist. bob@example.com signs gws in there first"],
    ["bob@example.com=gws-bob", "as an absolute path"],
    [`bob=${moved}`, "Give --add-inbox as person@example.com (read by delegation) or person@example.com=/path"],
  ]) {
    await assert.rejects(install(["--no-services", "--add-inbox", entry], tokens), (e) => e.stderr.includes(message), entry);
    assert.deepEqual((await config()).inboxAccounts, [{ account: "Ada@Example.com", configDir: moved }], entry);
  }
  // The address alone connects an account by delegation; either form replaces the other.
  const delegated = await install(["--no-services", "--add-inbox", "bob@example.com"], tokens);
  assert.deepEqual((await config()).inboxAccounts, [{ account: "Ada@Example.com", configDir: moved }, { account: "bob@example.com" }]);
  assert.equal(delegated.stdout.trim().split("\n").at(-1), `Inboxes: you@example.com (default gws sign-in); Ada@Example.com (${moved}); bob@example.com (delegated).`);
  await install(["--no-services", "--add-inbox", "ada@example.com"], tokens);
  assert.deepEqual((await config()).inboxAccounts, [{ account: "ada@example.com" }, { account: "bob@example.com" }]);
  await install(["--no-services", "--add-inbox", `ada@example.com=${moved}`, "--remove-inbox", "bob@example.com"], tokens);
  assert.deepEqual((await config()).inboxAccounts, [{ account: "ada@example.com", configDir: moved }]);
  const removed = await install(["--no-services", "--remove-inbox", "ada@example.com"], tokens);
  assert.deepEqual((await config()).inboxAccounts, []);
  assert.match(removed.stdout, /^Inboxes: you@example\.com \(default gws sign-in\)\.$/m);
  await assert.rejects(install(["--no-services", "--remove-inbox", "ada@example.com"], tokens), (e) => e.stderr.includes("No inbox is connected for ada@example.com on this machine."));
  assert.deepEqual({ ...(await config()), inboxAccounts: undefined }, { ...before, inboxAccounts: undefined });
});

test("--slack runs the chat watcher from the machine's Doppler config, restarts it with each release, and --no-slack stops it", { timeout: 30000 }, async (t) => {
  const { base, bin, home, install, config, calls, connect } = await machine(t);
  await writeFile(path.join(bin, "doppler"), `#!/bin/sh\nprintf '%s' "$NAMES"\n`, { mode: 0o755 });
  await writeFile(path.join(base, "doppler-token"), "dp.st.example", { mode: 0o600 });
  await writeFile(path.join(base, "machine.json"), JSON.stringify({ doppler: { project: "projects", config: "laptop" } }), { mode: 0o600 });
  const names = (...list) => JSON.stringify(Object.fromEntries(list.map((name) => [name, {}])));
  const machineTokens = ["COLLECTOR_TOKEN", "RUNNER_TOKEN"], all = names(...machineTokens, "SLACK_APP_TOKEN", "SLACK_USER_TOKENS");
  const people = ["--slack", "Owner@example.com,colleague@example.com"];
  await assert.rejects(install([...connect, ...people], { NAMES: names(...machineTokens) }, mac), (e) => e.stderr.includes("Add SLACK_APP_TOKEN and SLACK_USER_TOKENS to the Doppler config projects/laptop first."));
  const { stdout } = await install([...connect, ...people], { NAMES: all }, mac);
  assert.deepEqual((await config()).slack, ["owner@example.com", "colleague@example.com"]);
  const job = path.join(home, "Library/LaunchAgents/local.projects.chats.plist");
  const definition = await readFile(job, "utf8");
  assert.match(definition, /<string>--chats<\/string>/);
  assert.match(definition, /<key>KeepAlive<\/key><true\/>/);
  assert.match(stdout, /^Chat watcher: /m);
  assert.match(stdout, /^Slack: owner@example\.com, colleague@example\.com\.$/m);
  // A release restarts the watcher on its new bundle.
  let before = (await calls()).length;
  await install([], { NAMES: all }, mac);
  assert.ok((await calls()).slice(before).includes(`kickstart -k ${domain}/local.projects.chats`));
  // --no-slack stops it and removes its job; the rest is untouched.
  before = (await calls()).length;
  const stopped = await install(["--no-slack"], { NAMES: names(...machineTokens) }, mac);
  assert.deepEqual((await config()).slack, []);
  assert.equal(existsSync(job), false);
  assert.ok((await calls()).slice(before).includes(`bootout ${domain}/local.projects.chats`));
  assert.match(stopped.stdout, /^Slack: none read\.$/m);
  // Slack's tokens live in a Doppler config, and people are addresses.
  await writeFile(path.join(base, "machine.json"), "{}", { mode: 0o600 });
  await assert.rejects(install([...connect, "--no-services", "--slack", "owner@example.com"], tokens), (e) => e.stderr.includes("give the machine one first"));
  await assert.rejects(install([...connect, "--no-services", "--slack", "owner"], tokens), (e) => e.stderr.includes("Give --slack as person@example.com"));
});

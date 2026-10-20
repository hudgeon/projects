// Connects this machine to a Projects site: builds the collector and runner
// bundles from this checkout, writes the machine's config and tokens, installs
// the bundles with the checkout's commit recorded beside them, and starts both
// as background services. Run it again after each release (after `npm ci`
// when dependencies changed); an existing config and tokens are kept unless
// new values are given, and so are the services' launchd labels. A machine
// whose machine.json names a Doppler config keeps its tokens there, as
// COLLECTOR_TOKEN and RUNNER_TOKEN, and gets no token files. Other people's
// inboxes are connected one at a time with --add-inbox: the address alone
// reads by delegation (the Workspace service account key in that Doppler
// config), or with the gws config directory that person signed in to on this
// machine; --remove-inbox drops one. --slack names the people whose Slack this
// machine's chat watcher reads, each with a user token in that Doppler config
// (docs/slack.md); --no-slack stops it. --teams names the people whose Microsoft
// Teams it reads, each in a Chrome profile on this machine they signed in to
// (docs/teams.md); --no-teams stops it. Every run ends by listing them.
//
// node scripts/install-machine.mjs --machine studio --endpoint https://projects.example.com --root ~/code [--agents claude,codex] [--work-repo owner/repo] [--config-repo owner/repo] [--inbox you@example.com] [--add-inbox person@example.com[=~/.config/gws-person]] [--remove-inbox person@example.com] [--slack person@example.com,...] [--no-slack] [--teams person@example.com=~/Library/Projects-Teams] [--no-teams] [--collector-label label] [--runner-label label] [--hooks] [--new-tokens] [--no-services]
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchd, pause } from "./launchd.mjs";
import { applyConnections } from "./connections.mjs";

const home = homedir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(home, ".local/share/project-overview");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const flags = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]] : []));
const expand = (value) => value?.replace(/^~(?=$|\/)/, home);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const bundles = ["collector", "service", "chats", "runner", "work-item"];
// The bundles are built here, from the checkout as it is, so a release can
// never install ones left by an earlier build. The checkout's commit is kept
// beside them (release.json) and the runner logs it when it starts.
const git = (...command) => {
  try {
    return execFileSync("git", ["-C", repo, ...command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const commit = git("rev-parse", "HEAD"), porcelain = git("status", "--porcelain", "--untracked-files=no");
const release = {
  commit: /^[0-9a-f]{40}$/.test(commit ?? "") ? commit : null,
  dirty: porcelain !== null && porcelain !== "",
  installedAt: new Date().toISOString(),
};
const describe = (r) =>
  r?.commit ? `${r.commit.slice(0, 12)}${r.dirty ? " with uncommitted changes" : ""}` : "an unrecorded commit";
try {
  execFileSync("npm", ["run", "collector:build"], { cwd: repo, stdio: "inherit" });
} catch (error) {
  if (error.code === "ENOENT") fail("npm was not found on PATH; nothing was installed.");
  fail(`Building the bundles failed; nothing was installed. Run \`npm ci\` in ${repo} and try again.`);
}
for (const bundle of bundles)
  if (!existsSync(path.join(repo, `.local/${bundle}.mjs`)))
    fail(`The build left no .local/${bundle}.mjs; nothing was installed.`);

// The config: what was there before, with any new values given.
mkdirSync(base, { recursive: true, mode: 0o700 });
// A directory made before this mode was set is narrowed too: it holds tokens
// and the chat watcher's saved messages.
chmodSync(base, 0o700);
const file = path.join(base, "machine.json");
const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const set = (key, value) => value !== undefined && (config[key] = value);
set("host", flag("machine"));
set("endpoint", flag("endpoint"));
set("root", expand(flag("root")));
set("agents", flag("agents")?.split(",").map((a) => a.trim()));
set("workRepo", flag("work-repo"));
set("configRepo", flag("config-repo"));
set("inboxAccount", flag("inbox"));
// Inbox, Slack and Teams connection flags, in their own module to keep this
// file small. It mutates config and returns the inbox list for the summary.
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const { inboxes } = applyConnections(config, { args, flags, expand, fail });
// Labels given once are kept, so a later run restarts the same launchd jobs
// rather than starting a second collector and runner beside them.
set("collectorLabel", flag("collector-label"));
set("runnerLabel", flag("runner-label"));
config.home = home;
if (!config.doppler) config.collectorTokenFile ??= path.join(base, "collector-token");
config.projects ??= {};
if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(config.host ?? ""))
  fail("Give --machine: the machine id the Machines page showed.");
if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.endpoint ?? ""))
  fail("Give --endpoint: your Projects site, such as https://projects.example.com.");
if (!config.root || !path.isAbsolute(config.root))
  fail("Give --root: the folder that holds your repositories.");
if ([config.collectorLabel, config.runnerLabel].some((label) => label !== undefined && !/^\w[\w.-]*$/.test(label)))
  fail("Give --collector-label and --runner-label as launchd labels, such as com.example.projects-runner.");
const owned = (target, content) => {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
};
owned(file, JSON.stringify(config, null, 2) + "\n");

// Tokens are read without echo and stored owner-only; existing ones stay.
async function hidden(prompt) {
  if (!process.stdin.isTTY)
    fail("Run this in a terminal to paste the machine's tokens.");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const take = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") process.exit(130);
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", take);
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", take);
  });
}
// A token without a file comes from the machine's Doppler config, as the
// collector and runner read it; an existing runner-token file still wins.
const runnerFile = config.tokenFile ?? path.join(base, "runner-token");
const tokens = [
  ["collector", config.collectorTokenFile],
  ["runner", config.doppler && !config.tokenFile && !existsSync(runnerFile) ? undefined : runnerFile],
];
const inDoppler = [
  ...tokens.filter(([, target]) => !target).map(([role]) => `${role.toUpperCase()}_TOKEN`),
  ...(config.slack?.length ? ["SLACK_APP_TOKEN", "SLACK_USER_TOKENS"] : []),
];
if (inDoppler.length) {
  const where = `${config.doppler.project}/${config.doppler.config}`;
  let names = [];
  try {
    const token = readFileSync(path.join(base, "doppler-token"), "utf8").trim();
    mkdirSync(path.join(base, "doppler"), { recursive: true, mode: 0o700 });
    names = Object.keys(
      JSON.parse(
        execFileSync(
          "doppler",
          ["secrets", "--only-names", "--json", "--config-dir", path.join(base, "doppler"), "--project", config.doppler.project, "--config", config.doppler.config],
          { encoding: "utf8", env: { ...process.env, DOPPLER_TOKEN: token } },
        ),
      ),
    );
  } catch {
    fail(`Could not list the Doppler config ${where} with this machine's read-only service token (doppler-token).`);
  }
  const missing = inDoppler.filter((name) => !names.includes(name));
  if (missing.length) fail(`Add ${missing.join(" and ")} to the Doppler config ${where} first.`);
  if (args.includes("--new-tokens")) console.log(`Tokens kept in Doppler are replaced in ${where}.`);
}
for (const [role, target] of tokens) {
  if (!target || (existsSync(target) && !args.includes("--new-tokens"))) continue;
  const value =
    process.env[`PROJECTS_${role.toUpperCase()}_TOKEN`] ??
    (await hidden(`Paste the ${role} token for ${config.host}: `));
  if (!/^\S{32,200}$/.test(value)) fail(`That is not a ${role} token.`);
  owned(target, value);
}

// Bundles, then the background services.
const releaseFile = path.join(base, "release.json");
let previous = null;
try {
  previous = JSON.parse(readFileSync(releaseFile, "utf8"));
} catch {
  /* The first install, or one from before releases were recorded. */
}
for (const bundle of bundles)
  copyFileSync(
    path.join(repo, `.local/${bundle}.mjs`),
    path.join(base, `${bundle}.mjs`),
  );
owned(releaseFile, JSON.stringify(release, null, 2) + "\n");
const installed = `Installed ${describe(release)} (was ${describe(previous)}) in ${base}.`;
// Every inbox this machine reads, the owner's first, as the collector lists them.
const logins = [
  ...(config.inboxAccount && !inboxes.some((known) => same(known.account, config.inboxAccount)) ? [`${config.inboxAccount} (default gws sign-in)`] : []),
  ...inboxes.map((known) => `${known.account} (${known.configDir ?? "delegated"})`),
];
const connected = `Slack: ${config.slack?.length ? config.slack.join(", ") : "none read"}.\nTeams: ${config.teams?.length ? config.teams.map((t) => t.account).join(", ") : "none read"}.\nInboxes: ${logins.length ? logins.join("; ") : "none connected"}.`;
if (args.includes("--hooks"))
  execFileSync(process.execPath, [path.join(repo, "scripts/install-hooks.mjs")], {
    stdio: "inherit",
  });
if (process.platform !== "darwin" || args.includes("--no-services")) {
  console.log(
    `${installed} Run service.mjs every two minutes and keep runner.mjs ${file}${config.slack?.length || config.teams?.length ? " and service.mjs --chats" : ""} running with your service manager.\n${connected}`,
  );
  process.exit(0);
}
// Homebrew removes a versioned node after an upgrade; its opt link stays.
const keg = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/(bin\/node)$/.exec(process.execPath);
const node =
  keg && existsSync(path.join(keg[1], "opt", keg[2], keg[3]))
    ? path.join(keg[1], "opt", keg[2], keg[3])
    : process.execPath;
const searchPath = [path.join(home, ".local/bin"), path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const domain = `gui/${process.getuid()}`;
const { plist, status, loaded, start, stop, restart } = launchd({ base, searchPath, domain });
const services = [
  {
    label: config.collectorLabel ?? "local.projects.collector",
    content: plist(
      config.collectorLabel ?? "local.projects.collector",
      [node, path.join(base, "service.mjs")],
      "  <key>StartInterval</key><integer>120</integer>\n  <key>RunAtLoad</key><true/>",
      "collector",
    ),
    runner: false,
  },
  {
    label: config.runnerLabel ?? "local.projects.runner",
    content: plist(
      config.runnerLabel ?? "local.projects.runner",
      [node, path.join(base, "runner.mjs"), file],
      "  <key>KeepAlive</key><true/>\n  <key>RunAtLoad</key><true/>\n  <key>ThrottleInterval</key><integer>30</integer>\n  <key>ExitTimeOut</key><integer>10</integer>",
      "runner",
    ),
    runner: true,
  },
];
// The chat watcher stays running, and a release restarts it on the new bundle.
const watcher = config.collectorLabel ? `${config.collectorLabel}-chats` : "local.projects.chats";
if (config.slack?.length || config.teams?.length)
  services.push({
    label: watcher,
    content: plist(
      watcher,
      [node, path.join(base, "service.mjs"), "--chats"],
      "  <key>KeepAlive</key><true/>\n  <key>RunAtLoad</key><true/>\n  <key>ThrottleInterval</key><integer>30</integer>",
      "chats",
    ),
    runner: false,
    watcher: true,
  });
const agents = path.join(home, "Library/LaunchAgents");
mkdirSync(agents, { recursive: true });
// The runner's state once launchd has acted: a process started after the
// bundles were copied runs this release; one from before is still draining.
const settled = (label, before) => {
  let now = status(label);
  for (let waited = 0; (now.pid === null || now.pid === before.pid) && waited < 15_000; waited += 500) {
    pause(500);
    now = status(label);
  }
  if (now.pid !== null && now.pid !== before.pid) {
    // A start that fails exits within moments, so a pid that lasts is running.
    pause(2000);
    const again = status(label);
    if (again.pid === now.pid) return `running (pid ${now.pid}) on ${describe(release)}`;
    now = again;
  }
  if (now.pid !== null && now.pid === before.pid)
    return `still the earlier process (pid ${now.pid}) on ${describe(previous)}, which has not exited yet; launchd starts ${describe(release)} when it does`;
  // A clean exit is the drain; launchd holds a restart to one per 30 seconds.
  if (now.exit === "0") return `not running yet; launchd starts ${describe(release)} within its 30-second throttle`;
  return `not running (last exit code ${now.exit ?? "unknown"}); launchd retries every 30 seconds. Look for runner_config_invalid and runner_start_failed in ${path.join(base, "runner-error.log")}`;
};
let runnerState = "";
for (const service of services) {
  const target = path.join(agents, `${service.label}.plist`);
  const changed = !existsSync(target) || readFileSync(target, "utf8") !== service.content;
  if (changed) writeFileSync(target, service.content);
  const before = status(service.label);
  if (!before.loaded) start(target);
  else if (!service.runner && changed) restart(service.label, target);
  else if (service.watcher) execFileSync("launchctl", ["kickstart", "-k", `${domain}/${service.label}`], { stdio: "inherit" });
  else if (service.runner && before.pid === null) {
    // Nothing is running, so there is nothing to drain: a changed definition
    // can be reloaded at once, and otherwise a kickstart runs the new bundle
    // now rather than at launchd's next retry.
    if (changed) restart(service.label, target);
    else execFileSync("launchctl", ["kickstart", `${domain}/${service.label}`], { stdio: "inherit" });
  } else if (service.runner) {
    // The runner exits at once and launchd starts the new bundle, which
    // adopts the conversations' executors: each finishes its current step on
    // the old version, then continues on the new one.
    execFileSync("launchctl", ["kill", "SIGUSR2", `${domain}/${service.label}`], { stdio: "inherit" });
    if (changed)
      console.log(
        `The runner's service definition changed. Once it is idle, run: launchctl bootout ${domain}/${service.label}; sleep 5; launchctl bootstrap ${domain} ${target}`,
      );
  }
  if (service.runner) runnerState = settled(service.label, before);
}
// Nobody's Slack is read any more: the watcher stops and its job goes.
const unused = path.join(agents, `${watcher}.plist`);
if (!config.slack?.length && !config.teams?.length && existsSync(unused)) {
  if (loaded(watcher)) stop(watcher);
  rmSync(unused);
}
const watching = (config.slack?.length || config.teams?.length) ? `\nChat watcher: ${status(watcher).pid ? "running" : "not running yet; launchd retries every 30 seconds"}. Its log is ${path.join(base, "chats.log")}.` : "";
console.log(`${installed}\nRunner: ${runnerState}.${watching}\n${connected}`);
console.log(
  `${config.host} is connected: its collector reports every two minutes and its runner picks up conversations. It needs you logged in after a restart.`,
);

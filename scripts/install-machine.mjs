// Connects this machine to a Projects site: writes its config and tokens, installs
// the collector and runner bundles, and starts both as background services.
// Run it again after each release; an existing config and tokens are kept
// unless new values are given, and so are the services' launchd labels. A
// machine whose machine.json names a Doppler config keeps its tokens there, as
// COLLECTOR_TOKEN and RUNNER_TOKEN, and gets no token files.
//
// node scripts/install-machine.mjs --machine studio --endpoint https://projects.example.com --root ~/code [--agents claude,codex] [--work-repo owner/repo] [--inbox you@example.com] [--collector-label label] [--runner-label label] [--hooks] [--new-tokens] [--no-services]
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(home, ".local/share/project-overview");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const expand = (value) => value?.replace(/^~(?=$|\/)/, home);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
for (const bundle of ["collector", "service", "runner", "work-item"])
  if (!existsSync(path.join(repo, `.local/${bundle}.mjs`)))
    fail("Run `npm ci && npm run collector:build` first.");

// The config: what was there before, with any new values given.
mkdirSync(base, { recursive: true, mode: 0o700 });
const file = path.join(base, "machine.json");
const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const set = (key, value) => value !== undefined && (config[key] = value);
set("host", flag("machine"));
set("endpoint", flag("endpoint"));
set("root", expand(flag("root")));
set("agents", flag("agents")?.split(",").map((a) => a.trim()));
set("workRepo", flag("work-repo"));
set("inboxAccount", flag("inbox"));
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
const inDoppler = tokens.filter(([, target]) => !target).map(([role]) => `${role.toUpperCase()}_TOKEN`);
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
for (const bundle of ["collector", "service", "runner", "work-item"])
  copyFileSync(
    path.join(repo, `.local/${bundle}.mjs`),
    path.join(base, `${bundle}.mjs`),
  );
if (args.includes("--hooks"))
  execFileSync(process.execPath, [path.join(repo, "scripts/install-hooks.mjs")], {
    stdio: "inherit",
  });
if (process.platform !== "darwin" || args.includes("--no-services")) {
  console.log(
    `Installed in ${base}. Run service.mjs every two minutes and keep runner.mjs ${file} running with your service manager.`,
  );
  process.exit(0);
}
// Homebrew removes a versioned node after an upgrade; its opt link stays.
const keg = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/(bin\/node)$/.exec(process.execPath);
const node =
  keg && existsSync(path.join(keg[1], "opt", keg[2], keg[3]))
    ? path.join(keg[1], "opt", keg[2], keg[3])
    : process.execPath;
const xml = (value) =>
  String(value).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
const searchPath = [path.join(home, ".local/bin"), path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const plist = (label, program, extra, log) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
${program.map((p) => `    <string>${xml(p)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([...new Set(searchPath)].join(":"))}</string></dict>
${extra}
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(base, `${log}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(base, `${log}-error.log`))}</string>
</dict></plist>
`;
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
const domain = `gui/${process.getuid()}`;
const loaded = (label) => {
  try {
    execFileSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// launchd refuses a bootstrap ("5: Input/output error") while a job it was
// told to boot out is still exiting, so wait for it to go, then retry briefly.
const start = (target) => {
  for (let attempt = 1; ; attempt++)
    try {
      execFileSync("launchctl", ["bootstrap", domain, target], { stdio: "pipe" });
      return;
    } catch (error) {
      if (attempt === 10) throw error;
      pause(1000);
    }
};
const restart = (label, target) => {
  execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "inherit" });
  for (let waited = 0; loaded(label) && waited < 15_000; waited += 500) pause(500);
  start(target);
};
const agents = path.join(home, "Library/LaunchAgents");
mkdirSync(agents, { recursive: true });
for (const service of services) {
  const target = path.join(agents, `${service.label}.plist`);
  const changed = !existsSync(target) || readFileSync(target, "utf8") !== service.content;
  if (changed) writeFileSync(target, service.content);
  if (!loaded(service.label)) start(target);
  else if (!service.runner && changed) restart(service.label, target);
  else if (service.runner) {
    // The runner exits at once and launchd starts the new bundle, which
    // adopts the conversations' executors: each finishes its current step on
    // the old version, then continues on the new one.
    execFileSync("launchctl", ["kill", "SIGUSR2", `${domain}/${service.label}`], { stdio: "inherit" });
    if (changed)
      console.log(
        `The runner's service definition changed. Once it is idle, run: launchctl bootout ${domain}/${service.label}; sleep 5; launchctl bootstrap ${domain} ${target}`,
      );
  }
}
console.log(
  `${config.host} is connected: its collector reports every two minutes and its runner picks up conversations. It needs you logged in after a restart.`,
);

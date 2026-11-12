// Prints what each native turn is sent: this machine's stored conversations
// replayed through the engine on this checkout's code with stand-in turns
// (scripts/prompt-weight.ts). Calls nothing outside this machine. A change to
// what the runner sends each turn carries its before and after.
// `npm run prompt-weight -- --limit 30` (the default), `--all` or `--json`.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { configSchema } from "../collector/config";
import { registry } from "../runner/workspaces";
import { formatWeight, storedConversations, weigh, weight } from "./prompt-weight";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 30;
const machine = configSchema
  .extend({ stateDir: z.string().optional(), masterCwd: z.string().optional() })
  .parse(JSON.parse(await readFile(path.join(homedir(), ".local/share/project-overview/machine.json"), "utf8")));
const stateDir = machine.stateDir ?? path.join(machine.home, ".local/share/project-overview/runner");
const git = (args: string[]) =>
  promisify(execFile)("git", args, { cwd: path.dirname(import.meta.dirname) }).then(({ stdout }) => stdout.trim());
const code = `${await git(["rev-parse", "--short", "HEAD"])}${(await git(["status", "--porcelain", "--", "runner", "scripts", "src"])) ? " with uncommitted changes" : ""}`;

const stored = (await storedConversations(stateDir)).slice(0, flag("--all") ? undefined : limit);
if (!stored.length) throw Error("No stored conversations to replay on this machine.");
const setup = { projects: await registry(machine), masterCwd: machine.masterCwd ?? machine.root, host: machine.host, workRepo: machine.workRepo, agents: machine.agents };
const log = { info: console.info, warn: console.warn, error: console.error };
const replayed = [];
// The engine logs each step; a replay's steps are not the runner's.
console.info = console.warn = console.error = () => {};
try {
  for (const conversation of stored) replayed.push(await weigh(conversation, setup));
} finally {
  Object.assign(console, log);
}
const report = weight(replayed.filter((turns) => turns !== null), replayed.filter((turns) => turns === null).length);
console.log(flag("--json") ? JSON.stringify(report, null, 2) : formatWeight(report, `Prompt weight on ${machine.host} (code ${code})`));

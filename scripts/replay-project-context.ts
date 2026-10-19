// Replays stored Jev project reviews on this checkout's code and scores them
// against this machine's private labels and the files each turn used. Run on
// a connected machine; see docs/context-selection.md. Prints numbers, review
// ids and paths; unit text appears only when listing units to label.
import { execFile } from "node:child_process";
import { readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { configSchema, machineSecret } from "../collector/collect";
import { savePrivate } from "../runner/engine";
import { contextConfigSchema, JEV_MODEL, keptKey } from "../runner/context";
import { nativeEnv } from "../runner/native";
import { KEEP_FROM } from "../runner/project-context";
import { RECENT_COMMENTS } from "../runner/project-sources";
import { reviewsDir } from "../runner/project-turn";
import { registry } from "../runner/workspaces";
import { format, formatUsage, key, score, type Labels, type Result } from "./project-metrics";
import { evaluationDir, replayReview, storedReviews, type Review } from "./project-replay";

const exec = promisify(execFile);
const REPLAYS = 20;
const HISTORY = 20;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]] : []));
const value = (name: string) => values(name).at(-1);
const words = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.match(/^--(?:review|same|from|limit|width)$/));
const [command = "replay", ...operands] = ["replay", "score", "usage", "unlabelled", "label"].includes(words[0]) ? words : ["replay", ...words];

const machine = configSchema
  .extend({ stateDir: z.string().optional(), context: contextConfigSchema.default({ mode: "off" }) })
  .parse(JSON.parse(await readFile(path.join(homedir(), ".local/share/project-overview/machine.json"), "utf8")));
const stateDir = machine.stateDir ?? path.join(machine.home, ".local/share/project-overview/runner");
const dir = evaluationDir(stateDir);
const labelsFile = path.join(dir, "labels.json");
const labels: Labels = await readFile(labelsFile, "utf8").then(JSON.parse, (error) => {
  if (error.code === "ENOENT") return {};
  throw error;
});
const replaySchema = z.object({ results: z.array(z.any()) }).passthrough();
const replays = async () =>
  (await readdir(dir).catch(() => [] as string[])).filter((n) => /^replay-[\dTZ]+\.json$/.test(n)).sort();
// A saved replay: the named file, else this machine's newest.
async function saved(name = value("--from")) {
  const file = name ? path.resolve(dir, name) : path.join(dir, (await replays()).at(-1) ?? "none");
  return { file, replay: replaySchema.parse(JSON.parse(await readFile(file, "utf8"))) };
}
const reviewIds = (results: Result[], prefix?: string) =>
  results.filter((r) => !prefix || r.id.startsWith(prefix));

if (command === "score") {
  for (const name of operands.length ? operands : [undefined]) {
    const { file, replay } = await saved(name);
    const report = score(replay.results, labels);
    console.log(flag("--json") ? JSON.stringify(report, null, 2) : format(report, `Replay ${path.basename(file)} (${replay.code ?? "code unrecorded"}, ${replay.model ?? JEV_MODEL}, cutoff ${replay.keepFrom ?? KEEP_FROM})`));
  }
} else if (command === "usage") {
  // The selections turns actually received, without calling Jev.
  const results: Result[] = (await storedReviews(stateDir))
    .filter((r) => r.usage && r.recorded)
    .map((r) => ({
      id: r.id,
      projectId: r.projectId,
      reason: "recorded",
      judgeMs: null,
      inputTokens: null,
      considered: r.recorded!.units.map((u, i) => ({ ...u, noul: null, kept: r.recorded!.supplied.includes(i) })),
      usage: r.usage,
    }));
  const { usage } = score(results, {});
  console.log(flag("--json") ? JSON.stringify(usage.replayed, null, 2) : formatUsage("selections turns received", usage.replayed));
} else if (command === "unlabelled") {
  const { file, replay } = await saved();
  const reviews = new Map((await storedReviews(stateDir)).map((r) => [r.id, r]));
  const width = Number(value("--width") ?? 400);
  console.log(`Unlabelled units in ${path.basename(file)}. Label each 2 (on the task's subject), 1 (adjacent: useful context, not the subject) or 0 (off-topic), then record them with: npm run context:replay -- label <id> <index>=<label> ...`);
  for (const result of reviewIds(replay.results, operands[0]) as Result[]) {
    const known = labels[result.id]?.units ?? {};
    const open = result.considered.flatMap((u, i) => (known[key(u)] === undefined ? [[i, u] as const] : []));
    if (!open.length) continue;
    const review = reviews.get(result.id);
    console.log(`\n=== ${result.id} (${result.projectId ?? review?.projectId}, ${open.length} of ${result.considered.length} unlabelled)`);
    if (review)
      console.log(`Task: ${review.task.slice(0, 1_500)}\nInstructions Jev saw: ${JSON.stringify(review.instructions.map((text) => text.slice(0, 300)))}`);
    for (const [i, u] of open)
      console.log(`--- [${i}] noul=${u.noul?.toFixed(2) ?? "-"}${u.kept ? " supplied" : ""} ${u.path}${u.section ? ` :: ${u.section}` : ""}\n    ${(u.text ?? "").slice(0, width).replace(/\n/g, " / ")}`);
  }
} else if (command === "label") {
  const [prefix, ...pairs] = operands;
  const { replay } = await saved();
  const matches = reviewIds(replay.results, prefix) as Result[];
  if (!prefix || matches.length !== 1) throw Error("Name one replayed review by its id or a unique prefix.");
  const [result] = matches;
  const entry = (labels[result.id] ??= { units: {} });
  for (const pair of pairs) {
    const [, index, label] = /^(\d+)=([012])$/.exec(pair) ?? [];
    const unit = result.considered[Number(index)];
    if (!unit) throw Error(`Use <index>=<0|1|2> with an index the replay lists: ${pair}`);
    entry.units[key(unit)] = Number(label);
  }
  await savePrivate(labelsFile, labels);
  // A labelled review joins the gold set, beyond the history's retention.
  const receipt = path.join(reviewsDir(stateDir), `${result.id}.json`);
  const gold = path.join(dir, "reviews", `${result.id}.json`);
  if (!(await readFile(gold).catch(() => null)))
    await readFile(receipt, "utf8").then((text) => savePrivate(gold, JSON.parse(text)), () => {});
  console.log(`${result.id}: ${result.considered.filter((u) => entry.units[key(u)] === undefined).length} of ${result.considered.length} shortlisted units still unlabelled.`);
} else {
  const all = await storedReviews(stateDir);
  const ids = values("--review"),
    same = value("--same");
  const sameIds = same ? new Set((await saved(same)).replay.results.map((r: Result) => r.id)) : null;
  const history = all.filter((r) => r.source === "history" && !labels[r.id]);
  const chosen: Review[] = ids.length
    ? all.filter((r) => ids.some((id) => r.id.startsWith(id)))
    : sameIds
      ? all.filter((r) => sameIds.has(r.id))
      : [
          ...all.filter((r) => r.source !== "history" || labels[r.id]),
          ...(flag("--all") ? history : history.slice(-Number(value("--limit") ?? HISTORY))),
        ];
  if (!chosen.length) throw Error("No stored reviews to replay on this machine.");
  const projects = await registry(machine);
  const jevKey = keptKey(() => machineSecret(machine, "JEV_API_KEY"));
  // Read once before timing, as a running executor keeps it in memory.
  await jevKey().catch(() => {
    throw Error("JEV_API_KEY could not be read from this machine's Doppler config.");
  });
  const issues = new Map<string, Promise<{ title: string; body: string; updatedAt: string; comments: { body: string; createdAt: string }[] }>>();
  const readIssue = async (repo: string, number: number, before: number) => {
    const name = `${repo}#${number}`;
    if (!issues.has(name))
      issues.set(
        name,
        exec("gh", ["issue", "view", String(number), "--repo", repo, "--json", "title,body,updatedAt,comments"], { env: nativeEnv(), timeout: 60_000, maxBuffer: 64_000_000 }).then(({ stdout }) =>
          z.object({ title: z.string(), body: z.string(), updatedAt: z.string(), comments: z.array(z.object({ body: z.string(), createdAt: z.string() })) }).parse(JSON.parse(stdout)),
        ),
      );
    // Today's body, and the comments the review could have seen.
    const issue = await issues.get(name)!;
    return { ...issue, comments: issue.comments.filter((c) => Date.parse(c.createdAt) <= before).slice(-RECENT_COMMENTS) };
  };
  const results = [];
  for (const review of chosen) {
    const repository = projects.find((p) => p.id === review.projectId)?.cwd;
    const result = repository
      ? await replayReview(review, {
          repository,
          selector: { mode: "select", gateway: machine.context.gateway, key: jevKey },
          readIssue,
          signal: AbortSignal.timeout(120_000),
        }).catch((error) => ({ id: review.id, source: review.source, at: review.at, projectId: review.projectId, reason: error instanceof Error && error.name === "TimeoutError" ? "timed_out" : "replay_failed", judgeMs: null, inputTokens: null, considered: [] }))
      : { id: review.id, source: review.source, at: review.at, projectId: review.projectId, reason: "project_missing", judgeMs: null, inputTokens: null, considered: [] };
    results.push(result);
    const kept = result.considered.filter((u) => u.kept);
    console.error(`${result.id} ${result.reason}: ${kept.length} units, ${kept.reduce((n, u) => n + u.endChar - u.startChar, 0)} chars of ${result.considered.length} shortlisted; judge ${Math.round(result.judgeMs ?? 0)} ms`);
  }
  const git = (args: string[]) => exec("git", args, { cwd: import.meta.dirname }).then(({ stdout }) => stdout.trim());
  const code = `${await git(["rev-parse", "--short", "HEAD"])}${(await git(["status", "--porcelain", "--", "runner", "scripts", "src"])) ? " with uncommitted changes" : ""}`;
  const file = path.join(dir, `replay-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}.json`);
  await savePrivate(file, { at: new Date().toISOString(), host: machine.host, code, model: JEV_MODEL, keepFrom: KEEP_FROM, results });
  for (const old of (await replays()).slice(0, -REPLAYS)) await unlink(path.join(dir, old)).catch(() => {});
  const report = score(results, labels);
  console.log(flag("--json") ? JSON.stringify(report, null, 2) : format(report, `Replay ${path.basename(file)} on ${machine.host} (code ${code}, ${JEV_MODEL}, cutoff ${KEEP_FROM})`));
}

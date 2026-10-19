// Replays stored Jev project reviews on this checkout's code and scores them
// against this machine's private labels and the files each turn used, and
// does the same for the shadow run checks (`checks`). Run on a connected
// machine; see docs/context-selection.md. Prints numbers, ids and paths; unit
// and check text appear only when listing what to label.
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
import { BATCH, KEEP_FROM } from "../runner/project-context";
import { RECENT_COMMENTS } from "../runner/project-sources";
import { reviewsDir } from "../runner/project-turn";
import { registry } from "../runner/workspaces";
import { checkDirs, followUp, formatChecks, judgedNames, parseCheck, replayChecks, scoreChecks, storedChecks, type Check, type CheckLabels } from "./check-metrics";
import { format, formatPositions, formatUsage, key, positions, score, type Labels, type Result } from "./project-metrics";
import { evaluationDir, replayReview, storedReviews, type Review } from "./project-replay";

const exec = promisify(execFile);
const REPLAYS = 20;
const HISTORY = 20;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]] : []));
const value = (name: string) => values(name).at(-1);
// Replays may send each shortlist in another order, to measure position effects.
const order = z.enum(["retrieval", "interleaved", "reversed", "shuffled"]).optional().parse(value("--order"));
const batch = z.coerce.number().int().positive().optional().parse(value("--batch"));
const words = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.match(/^--(?:review|same|from|limit|width|kind|order|batch)$/));
const [command = "replay", ...operands] = ["replay", "score", "usage", "unlabelled", "label", "checks", "position"].includes(words[0]) ? words : ["replay", ...words];

const machine = configSchema
  .extend({ stateDir: z.string().optional(), context: contextConfigSchema.default({ mode: "off" }) })
  .parse(JSON.parse(await readFile(path.join(homedir(), ".local/share/project-overview/machine.json"), "utf8")));
const stateDir = machine.stateDir ?? path.join(machine.home, ".local/share/project-overview/runner");
const dir = evaluationDir(stateDir);
const readLabels = (file: string) =>
  readFile(file, "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return {};
    throw error;
  });
const labelsFile = path.join(dir, "labels.json");
const labels: Labels = await readLabels(labelsFile);
const jevKey = keptKey(() => machineSecret(machine, "JEV_API_KEY"));
// Read once before timing, as a running executor keeps it in memory.
const readKey = () =>
  jevKey().catch(() => {
    throw Error("JEV_API_KEY could not be read from this machine's Doppler config.");
  });
const git = (args: string[]) => exec("git", args, { cwd: path.dirname(import.meta.dirname) }).then(({ stdout }) => stdout.trim());
const code = async () => `${await git(["rev-parse", "--short", "HEAD"])}${(await git(["status", "--porcelain", "--", "runner", "scripts", "src"])) ? " with uncommitted changes" : ""}`;
const stamp = () => new Date().toISOString().replace(/[-:]|\.\d+/g, "");
const replaySchema = z.object({ results: z.array(z.any()), order: z.string().optional(), batch: z.number().optional() }).passthrough();
const replays = async () =>
  (await readdir(dir).catch(() => [] as string[])).filter((n) => /^replay-[\dTZ]+\.json$/.test(n)).sort();
// A saved replay: the named file, else this machine's newest.
async function saved(name = value("--from")) {
  const file = name ? path.resolve(dir, name) : path.join(dir, (await replays()).at(-1) ?? "none");
  return { file, replay: replaySchema.parse(JSON.parse(await readFile(file, "utf8"))) };
}
const reviewIds = (results: Result[], prefix?: string) =>
  results.filter((r) => !prefix || r.id.startsWith(prefix));

if (command === "checks") {
  // Shadow run checks: scored as the runner recorded them, replayed with the
  // current questions, listed for labelling without Jev's ratings, labelled.
  const [action = "score", ...rest] = operands;
  const checkLabelsFile = path.join(dir, "check-labels.json");
  const checkLabels: CheckLabels = await readLabels(checkLabelsFile);
  const ofKind = (c: Check) => !value("--kind") || c.kind === value("--kind");
  const stored = (await storedChecks(stateDir, dir)).filter(ofKind);
  const checkReplays = async () => (await readdir(dir).catch(() => [] as string[])).filter((n) => /^checks-replay-[\dTZ]+\.json$/.test(n)).sort();
  const savedChecks = async (name?: string) => {
    const file = name ? path.resolve(dir, name) : path.join(dir, (await checkReplays()).at(-1) ?? "none");
    const replay = z.object({ code: z.string(), model: z.string(), results: z.array(z.any()) }).parse(JSON.parse(await readFile(file, "utf8")));
    return { file, replay, results: replay.results.map((r) => parseCheck(r, r.id, r.source)).filter(ofKind) };
  };
  const unlabelled = (c: Check) => judgedNames(c).some((n) => checkLabels[c.id]?.[n] === undefined);
  if (action === "score") {
    const saved = rest[0] ? await savedChecks(rest[0]) : null;
    const report = scoreChecks(saved?.results ?? stored, checkLabels);
    console.log(flag("--json") ? JSON.stringify(report, null, 2) : formatChecks(report, saved ? `Replay ${path.basename(saved.file)} on ${machine.host} (code ${saved.replay.code}, ${saved.replay.model})` : `Run checks on ${machine.host}, as recorded`));
  } else if (action === "replay") {
    const same = value("--same");
    const sameIds = same ? new Set((await savedChecks(same)).results.map((c) => c.id)) : null;
    const others = stored.filter((c) => !checkLabels[c.id]);
    const chosen = sameIds ? stored.filter((c) => sameIds.has(c.id)) : [...stored.filter((c) => checkLabels[c.id]), ...(flag("--all") ? others : others.slice(-Number(value("--limit") ?? HISTORY)))];
    if (!chosen.length) throw Error("No stored run checks to replay on this machine.");
    await readKey();
    const results = await replayChecks(chosen, { mode: "select", gateway: machine.context.gateway, key: jevKey });
    const file = path.join(dir, `checks-replay-${stamp()}.json`);
    const version = await code();
    await savePrivate(file, { at: new Date().toISOString(), host: machine.host, code: version, model: JEV_MODEL, results });
    for (const old of (await checkReplays()).slice(0, -REPLAYS)) await unlink(path.join(dir, old)).catch(() => {});
    console.log(flag("--json") ? JSON.stringify(scoreChecks(results, checkLabels), null, 2) : formatChecks(scoreChecks(results, checkLabels), `Replay ${path.basename(file)} on ${machine.host} (code ${version}, ${JEV_MODEL})`));
  } else if (action === "unlabelled") {
    const width = Number(value("--width") ?? 400);
    const clip = (texts: string[]) => texts.join("; ").slice(0, width).replace(/\n/g, " / ") || "-";
    console.log("Unlabelled run checks, newest first, without Jev's ratings. Label a repeat check's report 1 if the dispatched helper redid work that report already showed done, else 0; a progress check's sign 1 if it held at the newest note, else 0. Record them with: npm run context:replay -- checks label <id> <report index or sign>=<0|1> ...");
    for (const c of stored.filter((c) => c.judged && unlabelled(c)).slice(-Number(value("--limit") ?? HISTORY)).reverse()) {
      const after = await followUp(stateDir, c);
      console.log(`\n=== ${c.id} (${after?.title ?? "conversation journal gone"})`);
      if ("reports" in c.inputs) {
        console.log(`Brief: ${clip([c.inputs.brief])}`);
        c.inputs.reports.forEach((r, i) => console.log(`[${i}] ${r.state}: ${clip([r.summary])}\n    checks: ${clip(r.checks)}`));
      } else for (const n of c.inputs.notes) console.log(`- ${n.at} done: ${clip(n.done)} | remaining: ${clip(n.remaining)}${n.yourMove ? ` | your move: ${clip([n.yourMove])}` : ""}`);
      const helper = after?.helper;
      console.log(helper ? `Then the helper was ${helper.state}: ${clip([helper.summary ?? "no result"])}\n    checks: ${clip(helper.checks)}` : "Then: the helper is not in the journal.");
      for (const n of after?.later ?? []) console.log(`  later ${new Date(n.at).toISOString()} done: ${clip(n.done)} | remaining: ${clip(n.remaining)}`);
    }
  } else if (action === "label") {
    const [prefix, ...pairs] = rest;
    const matches = stored.filter((c) => prefix && c.id.startsWith(prefix));
    if (matches.length !== 1) throw Error("Name one stored run check by its id or a unique prefix.");
    const [check] = matches;
    const names = judgedNames(check);
    const entry = (checkLabels[check.id] ??= {});
    for (const pair of pairs) {
      const [, which = "", label] = /^([\w-]+)=([01])$/.exec(pair) ?? [];
      const name = /^\d+$/.test(which) ? names[Number(which)] : names.find((n) => n === which);
      if (!name) throw Error(`Use <report index or sign>=<0|1> for something the check judged: ${pair}`);
      entry[name] = Number(label);
    }
    await savePrivate(checkLabelsFile, checkLabels);
    // A labelled check joins the gold set, beyond the receipts' retention.
    const { history, gold } = checkDirs(stateDir, dir);
    if (!(await readFile(path.join(gold, `${check.id}.json`)).catch(() => null)))
      await readFile(path.join(history, `${check.id}.json`), "utf8").then((text) => savePrivate(path.join(gold, `${check.id}.json`), JSON.parse(text)), () => {});
    console.log(`${check.id}: ${names.filter((n) => entry[n] === undefined).length} of ${names.length} judgments still unlabelled.`);
  } else throw Error("Use checks [score [replay file] | replay | unlabelled | label <id> <report index or sign>=<0|1> ...].");
} else if (command === "score") {
  for (const name of operands.length ? operands : [undefined]) {
    const { file, replay } = await saved(name);
    const report = score(replay.results, labels);
    console.log(flag("--json") ? JSON.stringify(report, null, 2) : format(report, `Replay ${path.basename(file)} (${replay.code ?? "code unrecorded"}, ${replay.model ?? JEV_MODEL}, cutoff ${replay.keepFrom ?? KEEP_FROM}, ${replay.batch ?? "all"} per request${replay.order ? `, sent ${replay.order}` : ""})`));
  }
} else if (command === "position") {
  // Ratings by retrieval rank: compare a replay sent in retrieval order with
  // one sent reversed or shuffled.
  for (const name of operands.length ? operands : [undefined]) {
    const { file, replay } = await saved(name);
    console.log(formatPositions(positions(replay.results, labels), `Replay ${path.basename(file)} (${replay.code ?? "code unrecorded"}, ${replay.batch ?? "all"} per request, sent ${replay.order ?? "in retrieval order"})`));
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
  console.log(`Unlabelled units in ${path.basename(file)}, without Jev's ratings so labels are not anchored to them. Label each 2 (on the task's subject), 1 (adjacent: useful context, not the subject) or 0 (off-topic), then record them with: npm run context:replay -- label <id> <index>=<label> ...`);
  for (const result of reviewIds(replay.results, operands[0]) as Result[]) {
    const known = labels[result.id]?.units ?? {};
    const open = result.considered.flatMap((u, i) => (known[key(u)] === undefined ? [[i, u] as const] : []));
    if (!open.length) continue;
    const review = reviews.get(result.id);
    console.log(`\n=== ${result.id} (${result.projectId ?? review?.projectId}, ${open.length} of ${result.considered.length} unlabelled)`);
    if (review)
      console.log(`Task: ${review.task.slice(0, 1_500)}\nInstructions Jev saw: ${JSON.stringify(review.instructions.map((text) => text.slice(0, 300)))}`);
    for (const [i, u] of open)
      console.log(`--- [${i}] ${u.path}${u.section ? ` :: ${u.section}` : ""}\n    ${(u.text ?? "").slice(0, width).replace(/\n/g, " / ")}`);
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
  await readKey();
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
          order,
          batch,
          signal: AbortSignal.timeout(120_000),
        }).catch((error) => ({ id: review.id, source: review.source, at: review.at, projectId: review.projectId, reason: error instanceof Error && error.name === "TimeoutError" ? "timed_out" : "replay_failed", judgeMs: null, inputTokens: null, considered: [] }))
      : { id: review.id, source: review.source, at: review.at, projectId: review.projectId, reason: "project_missing", judgeMs: null, inputTokens: null, considered: [] };
    results.push(result);
    const kept = result.considered.filter((u) => u.kept), { failure, status } = result as Result;
    console.error(`${result.id} ${result.reason}${failure ? ` (${failure}${status ? ` ${status}` : ""})` : ""}: ${kept.length} units, ${kept.reduce((n, u) => n + u.endChar - u.startChar, 0)} chars of ${result.considered.length} shortlisted; judge ${Math.round(result.judgeMs ?? 0)} ms`);
  }
  const version = await code();
  const file = path.join(dir, `replay-${stamp()}.json`);
  await savePrivate(file, { at: new Date().toISOString(), host: machine.host, code: version, model: JEV_MODEL, keepFrom: KEEP_FROM, ...(order ? { order } : {}), batch: batch ?? BATCH, results });
  for (const old of (await replays()).slice(0, -REPLAYS)) await unlink(path.join(dir, old)).catch(() => {});
  const report = score(results, labels);
  console.log(flag("--json") ? JSON.stringify(report, null, 2) : format(report, `Replay ${path.basename(file)} on ${machine.host} (code ${version}, ${JEV_MODEL}, cutoff ${KEEP_FROM}, ${batch ?? BATCH} per request${order ? `, sent ${order}` : ""})`));
}

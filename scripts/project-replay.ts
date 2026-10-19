// Stored project reviews and their replay on current code. A replay clones
// the project with `git clone --shared` at the review's recorded commit; the
// project's own checkout is never changed.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Selector } from "../runner/context";
import { reviewProjectContext } from "../runner/project-context";
import type { SendOrder } from "../runner/project-judge";
import type { Issue } from "../runner/project-sources";
import { reviewsDir, type Usage } from "../runner/project-turn";
import { git } from "../runner/workspaces";
import type { Result, Unit } from "./project-metrics";

const refSchema = z.object({
  path: z.string(),
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),
});
const usageSchema = z.object({
  at: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      read: z.literal(true).optional(),
      changed: z.literal(true).optional(),
      lines: z.array(z.tuple([z.number(), z.number()])).optional(),
    }),
  ),
  outside: z.number(),
  more: z.number(),
}) satisfies z.ZodType<Usage>;
const workIssue = z
  .object({ repo: z.string(), number: z.number().int().positive() })
  .nullish();
// A receipt from runner/project-turn.ts.
const receiptSchema = z.object({
  id: z.string(),
  at: z.number(),
  projectId: z.string(),
  head: z.string().nullable(),
  input: z.object({
    plan: z.string().nullable(),
    task: z.string(),
    query: z.string().optional(),
    instructions: z.array(z.string()),
    workIssue,
  }),
  considered: z.array(refSchema),
  supplied: z.array(z.number().int().nonnegative()),
  usage: usageSchema.optional(),
});
// A turn reconstructed by the October 2026 validation, stored as turns.json.
const seedSchema = z.object({
  id: z.string(),
  at: z.number(),
  actor: z.string(),
  projectId: z.string(),
  head: z.string().nullable(),
  task: z.string(),
  query: z.string().nullish(),
  instructions: z.array(z.string()),
  workIssue,
});
export type Review = {
  id: string;
  source: "history" | "gold" | "seed";
  at: number;
  projectId: string;
  head: string | null;
  // Undefined when unrecorded: the project's metadata at that commit names it.
  plan?: string | null;
  task: string;
  query?: string;
  instructions: string[];
  workIssue?: { repo: string; number: number } | null;
  recorded?: { units: z.infer<typeof refSchema>[]; supplied: number[] };
  usage?: Usage;
};
// The recovery task the runner states; the reconstructed seed held the
// helper's original task in its place.
const RECOVERY =
  "Read-only recovery inspection of the same native session and existing workspace; verify uncertain prior effects without replaying them.";
export function seedReview(value: unknown): Review {
  const turn = seedSchema.parse(value);
  const recovery = /^(read|change): RECOVERY INSPECTION ONLY/.test(turn.task);
  return {
    id: turn.id,
    source: "seed",
    at: turn.at,
    projectId: turn.projectId,
    head: turn.head,
    task: recovery ? RECOVERY : turn.task,
    query: turn.actor === "master" || recovery ? "" : undefined,
    instructions: turn.instructions,
    workIssue: turn.workIssue,
  };
}
export function storedReview(value: unknown, source: "history" | "gold"): Review {
  const r = receiptSchema.parse(value);
  return {
    id: r.id,
    source,
    at: r.at,
    projectId: r.projectId,
    head: r.head,
    ...r.input,
    recorded: { units: r.considered, supplied: r.supplied },
    usage: r.usage,
  };
}
async function receipts(dir: string, source: "history" | "gold") {
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: Review[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort())
    try {
      found.push(storedReview(JSON.parse(await readFile(path.join(dir, name), "utf8")), source));
    } catch {
      /* A receipt from before reviews kept their inputs. */
    }
  return found;
}
// Private evaluation files beside the runner's state.
export const evaluationDir = (stateDir: string) =>
  path.join(stateDir, "jev-evaluation");
// Labelled reviews (the October seed and gold copies of labelled receipts)
// and the runner's history, newest last, each once.
export async function storedReviews(stateDir: string) {
  const dir = evaluationDir(stateDir);
  let seeds: Review[] = [];
  try {
    seeds = z.array(z.unknown()).parse(JSON.parse(await readFile(path.join(dir, "turns.json"), "utf8"))).map(seedReview);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const gold = await receipts(path.join(dir, "reviews"), "gold");
  const history = await receipts(reviewsDir(stateDir), "history");
  const seen = new Set<string>();
  return [...seeds, ...gold, ...history].filter((r) => !seen.has(r.id) && !!seen.add(r.id));
}

// The first and last line of each unit, from its file's text.
function lines(text: string, unit: { startChar: number; endChar: number }): [number, number] {
  const line = (at: number) => text.slice(0, at).split("\n").length;
  return [line(unit.startChar), line(Math.max(unit.startChar, unit.endChar - 1))];
}
export async function replayReview(
  review: Review,
  o: {
    // The project's checkout, cloned and never changed.
    repository: string;
    selector: Selector;
    // The work issue as it stood at the review: comments after it are left out.
    readIssue?: (repo: string, number: number, before: number) => Promise<Issue>;
    // Send the shortlist in another order or batch size, to measure how the
    // request shape moves ratings.
    order?: SendOrder;
    batch?: number;
    signal: AbortSignal;
  },
): Promise<Result & { at: number; source: Review["source"] }> {
  const base = { id: review.id, source: review.source, at: review.at, projectId: review.projectId, judgeMs: null, inputTokens: null, considered: [] as Unit[] };
  if (!review.head) return { ...base, reason: "no_commit" };
  const clone = await mkdtemp(path.join(tmpdir(), "project-replay-"));
  try {
    // Large-file contents are not fetched; evidence never reads them.
    const env = { GIT_LFS_SKIP_SMUDGE: "1" };
    await git(tmpdir(), ["clone", "--quiet", "--shared", "--no-checkout", o.repository, clone], env);
    await git(clone, ["checkout", "--quiet", "--detach", review.head], env);
    let plan = review.plan;
    if (plan === undefined)
      try {
        plan = z.object({ plan: z.string().nullish() }).parse(JSON.parse(await readFile(path.join(clone, ".project-overview.json"), "utf8"))).plan ?? null;
      } catch {
        plan = null;
      }
    const issues = new Map<string, string>();
    let requestBytes: number | null = null,
      fetchMs: number | null = null;
    const send = o.selector.fetch ?? fetch;
    const started = performance.now();
    const view = await reviewProjectContext({
      project: { id: review.projectId, name: review.projectId, cwd: clone, plan },
      task: review.task,
      query: review.query,
      instructions: review.instructions,
      workIssue: review.workIssue ?? undefined,
      readIssue: o.readIssue
        ? async (repo, number) => {
            const issue = await o.readIssue!(repo, number, review.at);
            const url = `https://github.com/${repo}/issues/${number}`;
            issues.set(url, `${issue.title}\n${issue.body}`);
            for (const c of issue.comments ?? []) issues.set(`${url}#comment-${c.createdAt}`, c.body);
            return issue;
          }
        : undefined,
      signal: o.signal,
      selector: {
        ...o.selector,
        // Several batches may be sent: the largest request and the longest fetch.
        fetch: (async (url, init) => {
          requestBytes = Math.max(requestBytes ?? 0, Buffer.byteLength(String(init?.body ?? "")));
          const at = performance.now(),
            response = await send(url, init),
            body = await response.arrayBuffer();
          fetchMs = Math.max(fetchMs ?? 0, performance.now() - at);
          return new Response(body, { status: response.status, headers: response.headers });
        }) as typeof fetch,
      },
      trigger: "project-replay",
      order: o.order,
      batch: o.batch,
    });
    const totalMs = performance.now() - started;
    const texts = new Map<string, string | null>();
    const text = async (name: string) => {
      if (issues.has(name)) return issues.get(name)!;
      if (!texts.has(name))
        texts.set(name, name.includes("://") ? null : await readFile(path.join(clone, name), "utf8").catch(() => null));
      return texts.get(name)!;
    };
    const { receipt, record } = view;
    const considered: Unit[] = [];
    for (const [i, { path: name, section, startChar, endChar, score }] of receipt.considered.entries()) {
      const source = await text(name);
      considered.push({
        path: name,
        ...(section ? { section } : {}),
        startChar,
        endChar,
        score,
        text: source?.slice(startChar, endChar) ?? "",
        noul: record?.probabilities[`keep_${i}`] ?? null,
        kept: receipt.supplied.includes(i),
        ...(source !== null && !name.includes("://") ? { lines: lines(source, { startChar, endChar }) } : {}),
      });
    }
    // The original selection's units, placed by the same commit's text.
    const recorded = review.recorded && {
      supplied: review.recorded.supplied,
      units: await Promise.all(
        review.recorded.units.map(async (u) => {
          const source = u.path.includes("://") ? null : await text(u.path);
          return source === null ? u : { ...u, lines: lines(source, u) };
        }),
      ),
    };
    return {
      ...base,
      reason: receipt.reason,
      strategy: receipt.strategy,
      ...(receipt.failure ? { failure: receipt.failure.kind, ...(receipt.failure.status ? { status: receipt.failure.status } : {}) } : {}),
      judgeMs: record?.durationMs ?? null,
      fetchMs,
      totalMs,
      requestBytes,
      inputTokens: record?.inputTokens ?? null,
      considered,
      ...(recorded ? { recorded } : {}),
      ...(review.usage ? { usage: review.usage } : {}),
    };
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}

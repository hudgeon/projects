import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { telemetry } from "../src/telemetry";
import type { Agent } from "../src/run-model";
import type { ProjectDirectory } from "./workspaces";
import type { Selector } from "./context";
import type { FileTouch } from "./native-events";
import { reviewProjectContext } from "./project-context";
import { hash } from "./project-sources";

// Each review's private receipt is kept, with what it read, so later code
// can replay it; the oldest go first. The turn's file reads and changes
// join it afterwards, as paths and line ranges only.
export const REVIEWS = 1_000;
export const REVIEW_DAYS = 180;
const USED_FILES = 400;
const USED_RANGES = 20;
export const reviewsDir = (stateDir: string) =>
  path.join(stateDir, "project-context", "reviews");
// Receipts are named by their time in milliseconds, so the newest sort last.
async function prune(dir: string, now: number) {
  const names = (await readdir(dir))
    .filter((name) => /^\d{13}-[\w-]+\.json$/.test(name))
    .sort();
  for (const [i, name] of names.entries())
    if (
      i < names.length - REVIEWS ||
      Number(name.slice(0, 13)) < now - REVIEW_DAYS * 86_400_000
    )
      await unlink(path.join(dir, name)).catch(() => {});
}

export type Usage = {
  at: number;
  files: {
    path: string;
    read?: true;
    changed?: true;
    // First and last lines read; absent when the whole file was read.
    lines?: [number, number][];
  }[];
  // Files touched outside the reviewed project, and project files beyond
  // the limit: counted, never named.
  outside: number;
  more: number;
};
// Overlapping and adjacent line ranges, joined.
function joined(ranges: [number, number][]) {
  const result: [number, number][] = [];
  for (const [first, last] of ranges.toSorted((a, b) => a[0] - b[0])) {
    const end = result.at(-1);
    if (end && first <= end[1] + 1) end[1] = Math.max(end[1], last);
    else result.push([first, last]);
  }
  return result;
}
// What a native turn read or changed inside the reviewed project, relative
// to it.
export function usage(roots: string[]) {
  const files = new Map<
    string,
    { read: boolean; changed: boolean; whole: boolean; lines: [number, number][] }
  >();
  let outside = 0,
    more = 0;
  return {
    add(file: FileTouch) {
      const name = roots
        .map((root) => path.relative(root, file.path))
        .find((p) => p && !/^\.\.(?:\/|$)/.test(p) && !path.isAbsolute(p));
      if (!name) return void outside++;
      let entry = files.get(name);
      if (!entry && files.size >= USED_FILES) return void more++;
      if (!entry)
        files.set(name, (entry = { read: false, changed: false, whole: false, lines: [] }));
      if (file.change) entry.changed = true;
      else {
        entry.read = true;
        if (file.lines && entry.lines.length < USED_RANGES)
          entry.lines.push(file.lines);
        else entry.whole = true;
      }
    },
    summary: (): Usage => ({
      at: Date.now(),
      files: [...files].map(([name, e]) => ({
        path: name,
        ...(e.read ? { read: true as const } : {}),
        ...(e.changed ? { changed: true as const } : {}),
        ...(e.read && !e.whole ? { lines: joined(e.lines) } : {}),
      })),
      outside,
      more,
    }),
  };
}

export type ProjectTurn = [
  project: ProjectDirectory | undefined,
  cwd: string,
  task: string,
  actor: string,
  agent: Agent,
  session?: string | null,
  // "" when the task is a role description: the instructions steer retrieval.
  query?: string,
];
// One native turn's project context, reviewed, then cached and receipted
// privately. A view the same native session already received is named, not
// resent.
export async function contextBrief(
  o: {
    stateDir: string;
    run: { id: string; generation: number; workIssue?: number | null };
    host: string;
    workRepo?: string;
    selector?: Selector;
    signal: AbortSignal;
    instructions: string[];
    save: (file: string, value: unknown) => Promise<void>;
  },
  ...[project, cwd, task, actor, agent, session, query]: ProjectTurn
) {
  if (!project || !o.selector || o.selector.mode === "off")
    return {
      prompt: "",
      onFile: (_file: FileTouch) => {},
      remember: async (_session?: string | null) => {},
    };
  const key = hash(JSON.stringify([project.id, cwd, task, o.instructions]));
  const cacheFile = path.join(o.stateDir, "project-context", key + ".json");
  let cached: unknown;
  try {
    cached = JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    /* No reusable review. */
  }
  const review = await reviewProjectContext({
    project,
    cwd,
    task,
    query,
    instructions: o.instructions,
    workIssue:
      o.workRepo && o.run.workIssue
        ? { repo: o.workRepo, number: o.run.workIssue }
        : undefined,
    signal: o.signal,
    selector: o.selector,
    cached,
  });
  if (review.record) await o.save(cacheFile, review.record);
  const at = Date.now(),
    dir = reviewsDir(o.stateDir),
    id = `${at}-${o.run.id.slice(0, 8)}-${actor.slice(0, 8)}`,
    receipt = path.join(dir, `${id}.json`);
  const version = hash(JSON.stringify([key, review.prompt]));
  const sessionFile = (id: string) =>
    path.join(
      o.stateDir,
      "project-context",
      "sessions",
      hash(`${agent}:${id}`) + ".json",
    );
  let reusedInSession = false;
  if (session)
    try {
      reusedInSession =
        JSON.parse(await readFile(sessionFile(session), "utf8")).version ===
        version;
    } catch {
      /* New native context. */
    }
  const saved = {
    id,
    at,
    runId: o.run.id,
    generation: o.run.generation,
    actor,
    agent,
    ...review.receipt,
    record: review.record,
    reusedInSession,
  };
  await o.save(receipt, saved);
  await prune(dir, at).catch(() => {});
  if (review.receipt.failure)
    telemetry(
      "runner",
      "jev_selection_failed",
      {
        runId: o.run.id,
        generation: o.run.generation,
        host: o.host,
        actor: actor === "master" ? "master" : agent,
        childId: actor === "master" ? undefined : actor,
        contextTrigger: "project-turn",
        contextFailure: review.receipt.failure,
      },
      "warn",
    );
  const used = usage(
    [review.receipt.input.root, review.receipt.input.cwd].filter(
      (root): root is string => !!root,
    ),
  );
  return {
    prompt: `${reusedInSession ? "Project context is unchanged from the view already supplied in this native session." : review.prompt}\nPrivate project context receipt: ${receipt}\n`,
    onFile: used.add,
    remember: async (id?: string | null) => {
      if (id) await o.save(sessionFile(id), { version });
      // Evaluation data only: a failed write never holds up the turn.
      await o.save(receipt, { ...saved, usage: used.summary() }).catch(() => {});
    },
  };
}

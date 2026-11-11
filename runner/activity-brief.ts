import { createHash } from "node:crypto";
import { z } from "zod";
import { clip } from "../src/run-text";
import { pullSchema, pushPending, sessionSchema, sourceSchema, worktreeSchema } from "../src/model";

// The portfolio's latest observations, as the master sees them before a decision.
const observationSchema = z.array(
  z.object({
    host: z.string(),
    observedAt: z.number(),
    projects: z.array(
      z.object({
        id: z.string(),
        sessions: z.array(sessionSchema),
        worktrees: z.array(worktreeSchema),
        pulls: z.array(pullSchema),
        sources: z.record(z.string(), sourceSchema),
      }),
    ),
  }),
);
// What the master needs to avoid overlapping work: recent sessions, checkouts
// holding unsaved work, open pull requests and coverage gaps. Clean checkouts,
// old sessions and healthy sources were most of a first turn's input.
export function activityBrief(
  activity: unknown,
  projectId: string | null,
  now = Date.now(),
) {
  const parsed = observationSchema.safeParse(activity);
  if (!parsed.success) return activity;
  return parsed.data.map((o) => ({
    host: o.host,
    observedAt: o.observedAt,
    projects: o.projects
      .filter((p) => !projectId || p.id === projectId)
      .map((p) => {
        // Unsupported sources are permanent and say nothing about this work.
        const gaps = Object.entries(p.sources)
          .filter(([, s]) => s.state === "unavailable")
          .map(([name, s]) => `${name}: ${s.message}`);
        return {
          id: p.id,
          sessions: p.sessions
            .filter(
              (s) =>
                ["running", "waiting"].includes(s.state) ||
                now - s.updatedAt < 24 * 3600_000,
            )
            .map((s) => ({
              app: s.app,
              title: clip(s.title, 120),
              state: s.state,
              updatedAt: s.updatedAt,
              cwd: s.cwd,
            })),
          checkouts: p.worktrees
            .filter(
              (w) =>
                w.changed ||
                w.conflicts ||
                w.error ||
                (pushPending(w) ?? 0) > 0,
            )
            .map((w) => ({
              path: w.path,
              branch: w.branch,
              changed: w.changed,
              conflicts: w.conflicts,
              unpushed: pushPending(w),
              error: w.error,
              ...(w.prunable ? { folderRemoved: true } : {}),
            })),
          pulls: p.pulls.map((pr) => ({
            number: pr.number,
            title: clip(pr.title, 120),
            branch: pr.branch,
            draft: pr.draft,
            checks: pr.checks,
          })),
          ...(gaps.length ? { gaps } : {}),
        };
      })
      .filter(
        (p) =>
          p.id === projectId ||
          p.sessions.length ||
          p.checkouts.length ||
          p.pulls.length ||
          "gaps" in p,
      ),
  }));
}

// What a coordinator's session has seen of the brief: each machine's entry for
// a project, by a hash that leaves out when it was observed or last updated.
// An observation merely taken again is not news.
export type ActivitySeen = Record<string, string>;
type Entry = { host: string; projects: { id: string }[] };
const listed = (brief: unknown): brief is Entry[] =>
  Array.isArray(brief) && brief.every((o) => typeof o?.host === "string" && Array.isArray(o.projects) && o.projects.every((p: unknown) => typeof (p as Entry["projects"][0])?.id === "string"));
const mark = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value, (key, v) => (key === "observedAt" || key === "updatedAt" ? undefined : v)) ?? "")
    .digest("hex")
    .slice(0, 16);
export const activitySeen = (brief: unknown): ActivitySeen =>
  listed(brief) ? Object.fromEntries(brief.flatMap((o) => o.projects.map((p) => [`${o.host}/${p.id}`, mark(p)]))) : { all: mark(brief) };
// The entries that differ from what the session saw, timestamps and all, and
// those no longer listed. A brief in another shape is news as a whole.
export function activityNews(brief: unknown, seen: ActivitySeen) {
  const now = activitySeen(brief);
  const gone = Object.keys(seen).filter((key) => !(key in now));
  if (!listed(brief)) return { changed: seen.all === now.all ? [] : [brief], gone };
  return {
    changed: brief
      .map((o) => ({ ...o, projects: o.projects.filter((p) => seen[`${o.host}/${p.id}`] !== now[`${o.host}/${p.id}`]) }))
      .filter((o) => o.projects.length),
    gone,
  };
}

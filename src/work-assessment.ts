import { z } from "zod";
import { freshness, type Snapshot } from "./model";
import { currentInboxes, isLinkedThread } from "./inbox-model";
import type { Issue } from "./work-model";

// A source refresh is not a review. Only the issue's explicit evidence cutoff
// can establish which observations its Current position has reconciled.
export function evidenceChecked(body: string): number | null {
  const block = body.match(
    /^## Current position\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m,
  )?.[1];
  const value = block?.match(
    /^Evidence checked:\s*(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z)\s*$/m,
  )?.[1];
  const at =
    value && z.iso.datetime().safeParse(value).success
      ? Date.parse(value)
      : NaN;
  return Number.isFinite(at) ? at : null;
}
export type Assessment = { checkedAt: number | null; reason: string | null };
export function workAssessment(
  issue: Issue,
  evidence: {
    emailAttention?: boolean;
    unavailable?: boolean;
    deliveryAt?: number;
    nativePendingAt?: number;
  },
  now: number,
): Assessment {
  const checkedAt = issue.evidenceCheckedAt ?? null;
  const problem = (reason: string) => ({ checkedAt, reason });
  if (evidence.unavailable || issue.updatesState === "unavailable")
    return problem("Current evidence could not be checked.");
  if (!issue.position)
    return problem("No valid current assessment is recorded.");
  if (evidence.emailAttention)
    return problem(
      "New linked email needs reconciliation, including sent replies.",
    );
  if (!checkedAt || checkedAt > now + 60_000)
    return problem(
      "The evidence covered by this assessment has not been recorded.",
    );
  if ((issue.latestUpdate?.at ?? 0) > checkedAt)
    return problem("A newer issue update needs reconciliation.");
  if ((evidence.deliveryAt ?? 0) > checkedAt)
    return problem(
      "New pull request or delivery evidence needs reconciliation.",
    );
  if ((evidence.nativePendingAt ?? 0) > checkedAt)
    return problem("Recent session work has no verified work-record update.");
  const parked =
    ["planned", "deferred"].includes(issue.position.status) || issue.upkeep;
  if (now - checkedAt > (parked ? 7 : 1) * 86400_000)
    return problem("This assessment is due for an evidence review.");
  return { checkedAt, reason: null };
}

export function assessmentSourceGap(
  issue: Issue,
  snapshots: Snapshot[],
  observedAt: number,
  now: number,
) {
  const inboxes = currentInboxes(snapshots);
  return (
    freshness(observedAt, now) ||
    snapshots.some(
      (s) => s.collectedAt > observedAt && s.work?.issues === null,
    ) ||
    !!issue.emailLinks?.some(
      (link) =>
        !inboxes.some(
          (i) =>
            i.state === "ok" &&
            !freshness(i.observedAt, now) &&
            i.threads.some((t) => isLinkedThread(t, link.threadId)),
        ),
    )
  );
}

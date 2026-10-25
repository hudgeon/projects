import React from "react";
import { Link } from "@tanstack/react-router";
import { ago, type Snapshot } from "./model";
import type { RunState, RunSummary } from "./run-model";
import { clip } from "./run-text";
import type { ArchiveEntry } from "./archive-model";
import type { Navigation } from "./navigation";
import { useOwnerLabel } from "./people-view";

export function errorText(error: Error | null) {
  return error?.message === "SIGN_IN"
    ? "Your sign-in expired. Refresh the page to sign in."
    : error?.message;
}
export function projectNames(snapshots: Snapshot[], archives: ArchiveEntry[]) {
  const names = new Map(
    archives
      .filter((a) => a.target.kind === "project")
      .map((a) => [a.projectId!, a.title]),
  );
  for (const snapshot of snapshots
    .slice()
    .sort((a, b) => a.collectedAt - b.collectedAt))
    for (const project of snapshot.projects)
      names.set(project.id, project.name);
  return names;
}
export const runStates: Record<RunState, [label: string, tone: string]> = {
  queued: ["Queued", "working"],
  running: ["Working", "working"],
  cancelling: ["Stopping", "working"],
  completed: ["Ready", "good"],
  blocked: ["Needs you", "warning"],
  failed: ["Failed", "danger"],
  cancelled: ["Stopped", "quiet"],
};
// Things that need the owner first, then results to review, then stopped work.
export const urgency = (state: RunState) =>
  ({ blocked: 0, failed: 0, completed: 1, cancelled: 2 })[
    state as "blocked" | "failed" | "completed" | "cancelled"
  ] ?? 3;
// One conversation in a list, labelled with who started it.
export function ConversationRow({
  run,
  names,
  search,
  selected,
}: {
  run: RunSummary;
  names: Map<string, string>;
  search: Navigation;
  selected?: boolean;
}) {
  const ownerLabel = useOwnerLabel();
  const [label, tone] = run.archivedAt ? ["Done", "quiet"] : run.stuck && !run.needsYou ? ["May be stuck", "warning"] : runStates[run.needsYou ? "blocked" : run.state];
  const projects = run.projectIds ?? (run.projectId ? [run.projectId] : []);
  const meta = [
    ownerLabel(run.owner),
    projects.map((id) => names.get(id) ?? id).join(", "),
    run.workIssue ? `#${run.workIssue}` : "",
    ago(run.updatedAt, Date.now()),
  ].filter(Boolean);
  return (
    <Link
      className="row"
      to="/"
      search={search}
      aria-current={selected ? "true" : undefined}
    >
      <span className={`state-dot tone-${tone}`} aria-hidden="true" />
      <span className="row-text">
        <span className="row-title">{clip(run.title, 90)}</span>
        <span className="row-status">
          <strong className={`state tone-${tone}`}>{label}</strong>
          {run.status ? ` · ${run.status}` : ""}
          {run.remaining ? ` · ${run.remaining} left` : ""}
        </span>
        <span className="row-meta">{meta.join(" · ")}</span>
      </span>
    </Link>
  );
}

import { EvidenceText } from "./work-evidence-text";
import { workAssessment, assessmentSourceGap, type Assessment } from "./work-assessment";
import { AssessmentSummary, AssessmentDetails } from "./work-assessment-view";
import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ago,
  freshness,
  hostName,
  type Project,
  type Session,
  type Snapshot,
  pushPending,
} from "./model";
import {
  currentWork,
  decidedBy,
  isDone,
  historyIssues,
  nextCommitment,
  RECENT_WORK_DAYS,
  type Close,
  type CurrentWork,
  type Issue,
  type WorkAssociation,
} from "./work-model";
import {
  currentInboxes,
  inboxRows,
  inboxWithThread,
  isLinkedThread,
  gmailUrl,
} from "./inbox-model";
import { Restart } from "./restart";
import { awaitsYou, type RunSummary } from "./run-model";
import { plainText } from "./run-text";
import { Composer, ConversationRow, projectNames } from "./run-view";
import { workSearch } from "./navigation";
import type { ArchiveEntry } from "./archive-model";
type Linked = Omit<WorkAssociation, "state"> & {
  host: string;
  stale: boolean;
  title: string | null;
  state: WorkAssociation["state"] | Session["state"];
  at: number;
  live: boolean;
};
type Pull = Project["pulls"][number];
type Checkout = {
  host: string;
  repo: string;
  branch: string;
  changed: number;
  ahead: number | null;
  path: string;
};
export type Row = {
  issue: Issue;
  sessions: Linked[];
  pulls: Pull[];
  checkouts: Checkout[];
  close: Close | undefined;
  done: boolean;
  lastActive: number | null;
  recent: boolean;
  live: boolean;
  emailAttention: boolean;
  assessment?: Assessment;
};
const recentWindow = RECENT_WORK_DAYS * 86400_000;
const onBranch = (branch: string | null): branch is string =>
  branch !== null && !["main", "master"].includes(branch);
// Hook associations joined with the native session seen on that machine, so a
// linked session shows its live title and state, not just the hook's.
export function linkedSessions(snapshots: Snapshot[], now: number): Linked[] {
  return snapshots.flatMap((s) => {
    const stale = freshness(s.collectedAt, now);
    const native = new Map<string, Session>();
    for (const p of s.projects)
      for (const x of p.sessions) native.set(`${x.app}:${x.id}`, x);
    for (const x of s.unassignedSessions ?? [])
      native.set(`${x.app}:${x.id}`, x);
    return (s.work?.associations ?? []).map((a) => {
      const n = native.get(`${a.app}:${a.sessionId}`);
      const at = Math.max(a.updatedAt, n?.updatedAt ?? 0);
      const state = n && n.updatedAt >= a.updatedAt ? n.state : a.state;
      return {
        ...a,
        host: s.host,
        stale,
        title: n?.title ?? null,
        state,
        at,
        live:
          !stale &&
          (state === "running" || state === "waiting") &&
          now - at < 300_000,
      };
    });
  });
}
// Sessions that can still classify themselves: open, recent ones. An ended
// session has no reply left to declare in; resuming it lists it again.
export function unclassified(snapshots: Snapshot[], now: number) {
  return linkedSessions(snapshots, now).filter(
    (a) =>
      a.selection === "unassigned" &&
      a.state !== "ended" &&
      now - a.at < 7 * 86400_000,
  );
}
// GitHub is repository-wide: the freshest good observation per repo.
function currentPulls(snapshots: Snapshot[], now: number) {
  const best = new Map<string, { at: number; pulls: Pull[] }>();
  for (const s of snapshots)
    for (const p of s.projects) {
      const g = p.sources.github;
      if (g.state !== "ok" || freshness(g.observedAt, now)) continue;
      if ((best.get(p.repo)?.at ?? 0) < g.observedAt)
        best.set(p.repo, { at: g.observedAt, pulls: p.pulls });
    }
  return best;
}
export function rows(
  snapshots: Snapshot[],
  work: CurrentWork,
  now: number,
  closes: Close[] = [],
): Row[] {
  const inboxes = currentInboxes(snapshots);
  const emailReview = new Set(
    inboxes.flatMap((inbox) =>
      inboxRows(inbox, work.issues)
        .filter((r) => !r.reviewed)
        .flatMap((r) => r.linked.map((i) => i.number)),
    ),
  );
  const requested = new Map(closes.map((c) => [c.issue, c]));
  const linked = linkedSessions(snapshots, now);
  const pullsByRepo = currentPulls(snapshots, now);
  const checkouts: Checkout[] = snapshots.flatMap((s) =>
    s.projects.flatMap((p) =>
      p.worktrees
        .filter((w) => !w.isPrimary && (w.changed || (pushPending(w) ?? 0)))
        .map((w) => ({
          host: s.host,
          repo: p.repo,
          branch: w.branch,
          changed: w.changed,
          ahead: pushPending(w),
          path: w.path,
        })),
    ),
  );
  return work.issues.map((issue) => {
    const sessions = linked
      .filter((a) => a.issue === issue.number)
      .sort((a, b) => b.at - a.at);
    const branches = new Set(
      sessions
        .filter((a) => a.repo && onBranch(a.branch))
        .map((a) => `${a.repo}:${a.branch}`),
    );
    const pulls = [...pullsByRepo.entries()].flatMap(([repo, g]) =>
      g.pulls.filter(
        (pr) =>
          pr.workIssues?.includes(issue.number) ||
          branches.has(`${repo}:${pr.branch}`),
      ),
    );
    const close = requested.get(issue.number);
    const lastActive =
      Math.max(
        0,
        ...sessions.map((s) => s.at),
        ...pulls.map((p) => p.updatedAt),
      ) || null;
    return {
      issue,
      sessions,
      pulls,
      checkouts: checkouts.filter((c) => branches.has(`${c.repo}:${c.branch}`)),
      close,
      done: isDone(issue, work.observedAt, close),
      lastActive,
      recent: lastActive !== null && now - lastActive <= recentWindow,
      live: sessions.some((s) => s.live),
      emailAttention: emailReview.has(issue.number),
      assessment: workAssessment(issue, {
        emailAttention: emailReview.has(issue.number),
        unavailable: assessmentSourceGap(issue, snapshots, work.observedAt, now),
        deliveryAt: Math.max(0, ...pulls.map(p => p.updatedAt), ...snapshots.flatMap(s => s.projects.flatMap(p => p.latestMerge?.workIssues?.includes(issue.number) ? [p.latestMerge.mergedAt] : []))),
        nativePendingAt: Math.max(0, ...sessions.filter(s => s.recordReview === "unverified").map(s => s.updatedAt)),
      }, now),
    };
  });
}
function SessionLine({ s, now }: { s: Linked; now: number }) {
  const state =
    s.stale || (s.state === "running" && now - s.at > 300_000)
      ? `last known ${s.state}`
      : s.state;
  return (
    <span className="now-line">
      <span
        className={`state-dot tone-${s.live ? "good" : "quiet"}`}
        aria-hidden="true"
      />
      {s.app} on {hostName(s.host)} · {state}
      {onBranch(s.branch) ? ` · ${s.branch}` : ""} · {ago(s.at, now)}
      {decidedBy(s) === "assistant" ? (
        <span className="tag" title={`Linked by ${s.app} from its own reply`}>
          auto
        </span>
      ) : null}
    </span>
  );
}
// Work still attached to an item; Mark done leaves it all untouched.
export function openWork(row: Pick<Row, "pulls" | "checkouts" | "live">) {
  const count = (n: number, one: string, many: string) =>
    n ? `${n} ${n === 1 ? one : many}` : "";
  return [
    count(row.pulls.length, "open PR", "open PRs"),
    count(
      row.checkouts.length,
      "checkout with uncommitted or unpushed changes",
      "checkouts with uncommitted or unpushed changes",
    ),
    row.live ? "a session working now" : "",
  ].filter(Boolean);
}
// Mark done queues the issue; the machine on duty closes it next run.
function CloseControl({ row, now }: { row: Row; now: number }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const request = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/work/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue: row.issue.number }),
      });
      if (!r.ok)
        throw new Error(
          r.status === 401
            ? "Sign in again to mark work done."
            : (await r.text()) || "Mark done is unavailable.",
        );
    },
    onSuccess: () => {
      setConfirming(false);
      return client.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  const c = row.close;
  if (row.done) return null;
  if (c?.state === "queued")
    return (
      <span className="subtle">
        Closing on the next check · requested {ago(c.requestedAt, now)}
        {c.message ? ` · ${c.message}` : ""}
      </span>
    );
  return (
    <span className="close-control">
      {c?.state === "failed" && (
        <span className="error-inline">
          Mark done failed{c.message ? `: ${c.message}` : "."}
        </span>
      )}
      {confirming ? (
        <>
          <span className="subtle">
            Close issue #{row.issue.number} on GitHub?
            {openWork(row).length > 0
              ? ` Still linked: ${openWork(row).join(", ")}; they stay open.`
              : ""}
          </span>
          <button
            className="btn"
            onClick={() => request.mutate()}
            disabled={request.isPending}
          >
            {request.isPending ? "Requesting…" : "Close issue"}
          </button>
          <button className="btn-quiet" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button className="btn-quiet" onClick={() => setConfirming(true)}>
          {c?.state === "failed" ? "Try Mark done again" : "Mark done"}
        </button>
      )}
      {request.error && (
        <span role="alert" className="error-inline">
          {request.error.message}
        </span>
      )}
    </span>
  );
}
export type Agenda =
  "needs" | "active" | "waiting" | "review" | "planned" | "history";
export function agenda(row: Row): Agenda {
  // Closed on GitHub is closed here; new email on it waits in the Inbox.
  if (row.done) return "history";
  if (row.emailAttention) return "review";
  if (["planned", "deferred"].includes(row.issue.position?.status ?? "")) return "planned";
  if (row.assessment?.reason) return "review";
  switch (row.issue.position?.status) {
    case "needs you":
      return "needs";
    case "being worked on":
      return "active";
    case "waiting on someone":
      return "waiting";
    case "planned":
    case "deferred":
      return "planned";
    default:
      return row.live ? "active" : "review";
  }
}
export function agendaOrder(a: Row, b: Row) {
  const rank = (r: Row) =>
    ({ now: 0, next: 1, later: 2 })[r.issue.position?.priority ?? "next"];
  return (
    rank(a) - rank(b) ||
    (a.issue.position?.due ?? "9999").localeCompare(
      b.issue.position?.due ?? "9999",
    ) ||
    a.issue.number - b.issue.number
  );
}
export function outcomeGroup(issue: Issue) {
  return [
    issue.customers.join(" / ") ||
      (issue.area === "personal" ? "Personal" : "Internal"),
    issue.initiative?.title,
  ]
    .filter(Boolean)
    .join(" · ");
}
const sections: Record<Agenda, [label: string, tone: string, rank: number]> = {
  needs: ["Needs you", "warning", 0],
  review: ["To review", "working", 1],
  active: ["In progress", "good", 2],
  waiting: ["Waiting", "quiet", 3],
  planned: ["Later", "quiet", 4],
  history: ["Closed", "quiet", 5],
};
export function WorkCard({
  row,
  now,
  conversations,
  snapshots,
  archives,
  detail = false,
  emailThread,
  earlier = [],
}: {
  detail?: boolean;
  emailThread?: string;
  row: Row;
  now: number;
  conversations: RunSummary[];
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  earlier?: RunSummary[];
}) {
  const [composing, setComposing] = useState<"activity" | "discuss" | null>(
    null,
  );
  const open = detail;
  const navigate = useNavigate({ from: "/" });
  const { issue, pulls, sessions } = row;
  const p = issue.position;
  const assessment = row.assessment ?? workAssessment(issue, { emailAttention: row.emailAttention }, now);
  const [label, tone] = sections[agenda(row)];
  const working = conversations.filter((c) => !awaitsYou(c)).length;
  const ready = conversations.length - working;
  const failing = pulls.filter((pr) => pr.checks === "failing").length;
  const commitment = nextCommitment(issue);
  const signals = [
    row.live ? "Session working now" : "",
    working ? `${working} conversation${working === 1 ? "" : "s"} working` : "",
    ready ? `${ready} conversation${ready === 1 ? "" : "s"} to review` : "",
    row.emailAttention ? "New email" : "",
    failing ? `${failing} PR${failing === 1 ? "" : "s"} failing checks` : "",
    p?.due ? `Due ${p.due}` : "",
    commitment ? `${commitment.date}: ${commitment.what}` : "",
  ].filter(Boolean);
  const names = projectNames(snapshots, archives);
  return (
    <li className={`work-card${open ? " open" : ""}`}>
      <Link
        className="work-card-head"
        to="/"
        search={workSearch(issue.number, emailThread)}
        aria-current={detail ? "page" : undefined}
      >
        <span className="work-card-top">
          <span className={`state-chip tone-${tone}`}>{label}</span>
          {detail ? (
            <h1 className="work-card-title">{issue.title}</h1>
          ) : (
            <span className="work-card-title">{issue.title}</span>
          )}
        </span>
        {!detail && <AssessmentSummary position={p} assessment={assessment} />}
        {!!signals.length && (
          <span className="work-card-signals">{signals.join(" · ")}</span>
        )}
      </Link>
      {open && (
        <div className="work-card-body">
          <p>
            <span className="label">Clients</span>
            {issue.customers.join(", ") || "No client recorded"}
          </p>
          <AssessmentDetails position={p} assessment={assessment} now={now} />
          <div className="actions">
            {!row.done && (
              <>
                <button className="btn" onClick={() => setComposing("discuss")}>
                  Discuss this work
                </button>
                <button
                  className="btn-quiet"
                  onClick={() => setComposing("activity")}
                >
                  Start activity
                </button>
              </>
            )}
            <a href={issue.url} target="_blank" rel="noreferrer">
              Issue #{issue.number}
            </a>
            <CloseControl row={row} now={now} />
          </div>
          {composing && (
            <Composer
              key={composing}
              snapshots={snapshots}
              archives={archives}
              workIssue={issue.number}
              projectId={
                composing === "discuss"
                  ? workRepositoryProject(snapshots, archives)
                  : workProject(issue, snapshots, archives)
              }
              emailThread={emailThread}
              context={
                composing === "discuss"
                  ? {
                      title: `Discuss ${issue.title}`,
                      detail: `Discuss this work: ${issue.url}. Keep its overview, clients, people and commitments current as we agree changes.`,
                    }
                  : emailContext(issue, emailThread, snapshots)
              }
              autoFocus
              placeholder={
                composing === "discuss"
                  ? "What has changed? Who is involved, what is due, or how should this work be combined or split?"
                  : `What should happen next on “${issue.title}”?`
              }
              submitLabel={composing === "discuss" ? "Discuss" : "Start"}
              onCancel={() => setComposing(null)}
              onStarted={(run) => {
                setComposing(null);
                void navigate({
                  to: "/",
                  search: workSearch(issue.number, emailThread, run.id),
                });
              }}
            />
          )}
          <WorkFacts issue={issue} assessment={assessment} />
          {!!(
            historyIssues(issue).length || issue.details?.continuesAs.length
          ) && (
            <div className="work-history">
              {(
                [
                  ["Combined from", issue.details?.combinedFrom],
                  ["Split from", issue.details?.splitFrom],
                  ["Continues as", issue.details?.continuesAs],
                ] as const
              ).map(
                ([title, numbers]) =>
                  !!numbers?.length && (
                    <p key={title}>
                      <span className="label">{title}</span>
                      {numbers.map((n, i) => {
                        const known = currentWork(snapshots)?.issues.find(
                          (item) => item.number === n,
                        );
                        return (
                          <React.Fragment key={n}>
                            {i > 0 && ", "}
                            {known ? (
                              <Link to="/" search={workSearch(n)}>
                                {known.title}
                              </Link>
                            ) : (
                              <a
                                href={issue.url.replace(
                                  /\/issues\/\d+$/,
                                  `/issues/${n}`,
                                )}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Work #{n}
                              </a>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </p>
                  ),
              )}
            </div>
          )}
          {issue.latestUpdate && (
            <details className="fold">
              <summary>Latest supporting update</summary>
              <p className="subtle">
                <a
                  href={issue.latestUpdate.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Latest update
                </a>{" "}
                {ago(issue.latestUpdate.at, now)}:{" "}
                {plainText(issue.latestUpdate.body)}
              </p>
            </details>
          )}
          {issue.updatesState === "unavailable" && (
            <p className="subtle">Latest comments unavailable.</p>
          )}
          {row.checkouts.map((c) => (
            <p className="subtle" key={`${c.host}:${c.path}`} title={c.path}>
              Unsaved work on {hostName(c.host)}: {c.branch} · {c.changed}{" "}
              uncommitted · {c.ahead ?? "unknown"} unpushed
            </p>
          ))}
          {!!conversations.length && (
            <div className="rows">
              {conversations.map((run) => (
                <ConversationRow
                  key={run.id}
                  run={run}
                  names={names}
                  search={workSearch(issue.number, emailThread, run.id)}
                />
              ))}
            </div>
          )}
          {!!earlier.length && (
            <details className="fold">
              <summary>Earlier activity ({earlier.length})</summary>
              <p className="subtle">
                Retained from the previous work. Shared history does not assign
                an activity to a new outcome.
              </p>
              <div className="rows">
                {earlier.map((run) => (
                  <ConversationRow
                    key={run.id}
                    run={run}
                    names={names}
                    search={workSearch(run.workIssue!, undefined, run.id)}
                  />
                ))}
              </div>
            </details>
          )}
          {(!!issue.emailLinks?.length || !!pulls.length) && (
            <ul className="work-links">
              {(issue.emailLinks ?? []).map((link) => {
                const thread = inboxWithThread(snapshots, link.threadId)
                  ?.threads.find((t) => isLinkedThread(t, link.threadId));
                return (<li key={link.threadId}>
                  {link.url ? (
                    <Link to="/" search={{ view: "inbox", email: thread?.id ?? link.threadId }}>
                      {link.subject || thread?.subject || "Email conversation"}
                    </Link>
                  ) : (
                    link.subject || "Email conversation"
                  )}
                  {link.context && (
                    <span className="subtle"> · {link.context}</span>
                  )}
                </li>);
              })}
              {pulls.map((pr) => (
                <li key={pr.url}>
                  <a href={pr.url} target="_blank" rel="noreferrer">
                    PR #{pr.number} {pr.title}
                  </a>
                  <span className="subtle">
                    {" "}
                    · {pr.draft ? "draft · " : ""}
                    {pr.checks === "none" ? "no checks" : `checks ${pr.checks}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {sessions
            .filter((s) => s.live)
            .slice(0, 3)
            .map((s) => (
              <p key={`${s.host}:${s.sessionId}`}>
                <SessionLine s={s} now={now} />{" "}
                <Restart app={s.app} id={s.sessionId} host={s.host} />
              </p>
            ))}
        </div>
      )}
    </li>
  );
}
export function WorkFacts({ issue, assessment }: { issue: Issue; assessment?: Assessment }) {
  if (issue.details === null)
    return (
      <p className="notice">
        Some people, commitments or history could not be read. Check the linked
        issue before relying on this overview.
      </p>
    );
  return (
    <div className="work-facts">
      <section aria-label="People">
        <h2>People</h2>
        {issue.details?.people.length ? (
          <dl>
            {issue.details.people.map((p, i) => (
              <div key={i}>
                <dt>{p.name}</dt>
                <dd>{p.role || "Role not recorded"}</dd>
                <dd className="subtle">
                  Next: {assessment?.reason ? "Reconcile the evidence before acting" : p.next || "No action recorded"}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="subtle">No people recorded yet.</p>
        )}
      </section>
      <section aria-label="Commitments">
        <h2>Commitments</h2>
        {issue.details?.commitments.length ? (
          <ul>
            {issue.details.commitments.map((c, i) => (
              <li key={i}>
                <span className="commitment-date">
                  {c.date ? (
                    <time dateTime={c.date}>{c.date}</time>
                  ) : (
                    "Date unknown"
                  )}
                </span>
                <div>
                  {c.what}
                  <span className="subtle commitment-owner">
                    {c.owner || "Owner unknown"} · {c.state}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtle">No commitments recorded yet.</p>
        )}
      </section>
    </div>
  );
}
// Open work grouped by who it is for and why, the groups that need the owner
// first. Planned and closed work stays folded away.
export function BiggerWork({
  snapshots,
  archives,
  closes,
  conversations,
  now,
}: {
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  closes: Close[];
  conversations: RunSummary[];
  now: number;
}) {
  const [discussing, setDiscussing] = useState(false);
  const navigate = useNavigate({ from: "/" });
  const work = currentWork(snapshots);
  if (!work)
    return (
      <section className="bigger">
        <h2>Bigger work</h2>
        <p className="subtle">
          Work items are unavailable until a machine reads them from GitHub.
        </p>
      </section>
    );
  const all = rows(snapshots, work, now, closes).sort(
    (a, b) =>
      sections[agenda(a)][2] - sections[agenda(b)][2] || agendaOrder(a, b),
  );
  const current = all.filter((r) => sections[agenda(r)][2] < 4);
  const groups = new Map<string, Row[]>();
  for (const row of current)
    groups.set(outcomeGroup(row.issue), [
      ...(groups.get(outcomeGroup(row.issue)) ?? []),
      row,
    ]);
  const byIssue = (number: number) =>
    conversations.filter((c) => c.workIssue === number && !c.archivedAt);
  const card = (row: Row) => (
    <WorkCard
      key={row.issue.number}
      row={row}
      now={now}
      conversations={byIssue(row.issue.number)}
      snapshots={snapshots}
      archives={archives}
    />
  );
  const later = all.filter((r) => agenda(r) === "planned");
  const closed = all.filter((r) => agenda(r) === "history");
  const needs = current.filter((r) => agenda(r) === "needs").length;
  const pending = unclassified(snapshots, now);
  // A failed or stale read must not read as quiet work.
  const degraded =
    freshness(work.observedAt, now) ||
    snapshots.some((s) => s.work?.associationsState !== "ok") ||
    currentInboxes(snapshots).some(
      (inbox) => inbox.state !== "ok" || freshness(inbox.observedAt, now),
    );
  return (
    <section className="bigger" aria-label="Bigger work">
      <div className="bigger-head">
        <h2>Bigger work</h2>
        <span className="subtle">
          {current.length} open{needs ? ` · ${needs} need you` : ""}
        </span>
        <button className="btn-quiet" onClick={() => setDiscussing(true)}>
          Discuss bigger work
        </button>
      </div>
      {discussing && (
        <Composer
          snapshots={snapshots}
          archives={archives}
          projectId={workRepositoryProject(snapshots, archives)}
          autoFocus
          placeholder="Describe new work, or which pieces you want to combine or split."
          submitLabel="Discuss"
          context={{
            title: "Shape bigger work",
            detail: `Help me shape bigger work: create, combine or split the pieces, keeping their overviews, clients, people and commitments current.`,
          }}
          onCancel={() => setDiscussing(false)}
          onStarted={(run) => {
            setDiscussing(false);
            void navigate({ to: "/", search: { view: "today", run: run.id } });
          }}
        />
      )}
      {degraded && (
        <p className="notice" role="status">
          Some sources are stale or unavailable, so sessions or new email may be
          missing here.
          {freshness(work.observedAt, now)
            ? ` Work items last read ${ago(work.observedAt, now).toLowerCase()}.`
            : ""}
        </p>
      )}
      {[...groups].map(([group, items]) => (
        <div className="work-group" key={group}>
          <h3>{group}</h3>
          <ul>{items.map(card)}</ul>
        </div>
      ))}
      {!current.length && <p className="subtle">No open work items.</p>}
      {!!later.length && (
        <details className="fold">
          <summary>
            Later <span className="count">{later.length}</span>
          </summary>
          <ul>{later.map(card)}</ul>
        </details>
      )}
      {!!closed.length && (
        <details className="fold">
          <summary>
            Recently closed <span className="count">{closed.length}</span>
          </summary>
          <ul>{closed.map(card)}</ul>
        </details>
      )}
      {!!pending.length && (
        <details className="fold">
          <summary>
            Sessions without a work item{" "}
            <span className="count">{pending.length}</span>
          </summary>
          <p className="subtle">
            Reply <code>work: #number</code> in a session to link it.
          </p>
          {pending.map((a) => (
            <p key={`${a.host}:${a.sessionId}`} className="subtle">
              {a.app} on {hostName(a.host)} · {a.title ?? a.cwd} ·{" "}
              {ago(a.at, now)}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

// Work may span repositories. Only one explicit, current match is a safe
// default; the coordinator can choose otherwise.
export function workProject(
  issue: Pick<Issue, "repos">,
  snapshots: Snapshot[],
  archives: ArchiveEntry[],
) {
  const matches = new Set(
    snapshots
      .flatMap((s) => s.projects)
      .filter(
        (p) =>
          issue.repos.includes(p.repo) &&
          !archives.some(
            (a) => a.target.kind === "project" && a.projectId === p.id,
          ),
      )
      .map((p) => p.id),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}
export function workRepositoryProject(
  snapshots: Snapshot[],
  archives: ArchiveEntry[],
) {
  const repo = currentWork(snapshots)?.repo;
  return repo ? workProject({ repos: [repo] }, snapshots, archives) : undefined;
}
function emailContext(
  issue: Issue,
  threadId: string | undefined,
  snapshots: Snapshot[],
) {
  if (!threadId) return undefined;
  const inbox = inboxWithThread(snapshots, threadId);
  const thread = inbox?.threads.find((t) => t.id === threadId);
  const link = issue.emailLinks?.find((l) => l.threadId === threadId);
  const url = thread && inbox ? gmailUrl(inbox.account, threadId) : link?.url;
  return url
    ? {
        title: `Activity for ${issue.title}`,
        detail: `Source email: ${url}. Read it only if relevant to this activity; opening it or starting work does not mean its latest message has been reviewed.`,
      }
    : undefined;
}
export function WorkDetail({
  number,
  emailThread,
  ...props
}: {
  number: number;
  emailThread?: string;
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  closes: Close[];
  conversations: RunSummary[];
  now: number;
}) {
  const work = currentWork(props.snapshots);
  const row =
    work &&
    rows(props.snapshots, work, props.now, props.closes).find(
      (r) => r.issue.number === number,
    );
  return (
    <section aria-label="Bigger work details">
      <nav className="breadcrumbs">
        <Link to="/" search={{ view: "today" }}>
          ← Bigger work
        </Link>
      </nav>
      {work && freshness(work.observedAt, props.now) && (
        <p className="notice" role="status">
          Work items last read {ago(work.observedAt, props.now).toLowerCase()};
          this position may be out of date.
        </p>
      )}
      {row ? (
        <ul className="work-detail">
          <WorkCard
            key={number}
            row={row}
            {...props}
            detail
            emailThread={emailThread}
            conversations={props.conversations.filter(
              (c) => c.workIssue === number && !c.archivedAt,
            )}
            earlier={props.conversations.filter(
              (c) =>
                c.workIssue !== null &&
                historyIssues(row.issue).includes(c.workIssue),
            )}
          />
        </ul>
      ) : (
        <p className="notice">
          {work
            ? "This work item is not in the latest inventory. It may be older or unavailable; no new activity has been started."
            : "Work items are unavailable until a machine reads them from GitHub."}
        </p>
      )}
    </section>
  );
}

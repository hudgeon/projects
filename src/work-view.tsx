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
  RECENT_WORK_DAYS,
  type Close,
  type CurrentWork,
  type Issue,
  type WorkAssociation,
} from "./work-model";
import { currentInbox, inboxRows, gmailUrl } from "./inbox-model";
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
};
const recentWindow = RECENT_WORK_DAYS * 86400_000;
const onBranch = (branch: string | null): branch is string =>
  branch !== null && !["main", "master"].includes(branch);
// Hook associations joined with the native session observed on the same machine,
// so a linked session shows its live title and state, not only the hook's.
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
// Sessions that can still classify themselves: open ones, recently active. An
// ended session has no further reply to declare in; resuming it lists it again.
export function unclassified(snapshots: Snapshot[], now: number) {
  return linkedSessions(snapshots, now).filter(
    (a) =>
      a.selection === "unassigned" &&
      a.state !== "ended" &&
      now - a.at < 7 * 86400_000,
  );
}
// GitHub is repository-wide: use the freshest successful observation per repo.
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
  const inbox = currentInbox(snapshots);
  const emailReview = new Set(
    inbox
      ? inboxRows(inbox, work.issues)
          .filter((r) => !r.reviewed)
          .flatMap((r) => r.linked.map((i) => i.number))
      : [],
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
// Work still attached to an item; Mark done leaves all of it untouched.
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
// Mark done queues the issue; the machine on duty closes it on GitHub on its next run.
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
  // Closed on GitHub is closed here; a new email on it waits in the Inbox.
  if (row.done) return "history";
  if (row.emailAttention) return "review";
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
function EvidenceText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\))/g).map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
        return m ? (
          <a key={i} href={m[2]} target="_blank" rel="noreferrer">
            {m[1]}
          </a>
        ) : (
          <React.Fragment key={i}>{part.replace(/\*\*/g, "")}</React.Fragment>
        );
      })}
    </>
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
}: {
  detail?: boolean;
  emailThread?: string;
  row: Row;
  now: number;
  conversations: RunSummary[];
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
}) {
  const [composing, setComposing] = useState(false);
  const open = detail;
  const navigate = useNavigate({ from: "/" });
  const { issue, pulls, sessions } = row;
  const p = issue.position;
  const [label, tone] = sections[agenda(row)];
  const working = conversations.filter((c) => !awaitsYou(c)).length;
  const ready = conversations.length - working;
  const failing = pulls.filter((pr) => pr.checks === "failing").length;
  const signals = [
    row.live ? "Session working now" : "",
    working ? `${working} conversation${working === 1 ? "" : "s"} working` : "",
    ready ? `${ready} conversation${ready === 1 ? "" : "s"} to review` : "",
    row.emailAttention ? "New email" : "",
    failing ? `${failing} PR${failing === 1 ? "" : "s"} failing checks` : "",
    p?.due ? `Due ${p.due}` : "",
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
        <span className="work-card-next">
          {p?.next ? plainText(p.next) : "No next step recorded yet."}
        </span>
        {!!signals.length && (
          <span className="work-card-signals">{signals.join(" · ")}</span>
        )}
      </Link>
      {open && (
        <div className="work-card-body">
          {p?.why && (
            <p>
              <span className="label">Why</span>
              <EvidenceText text={p.why} />
            </p>
          )}
          {p?.position && (
            <p>
              <span className="label">Where it stands</span>
              <EvidenceText text={p.position} />
            </p>
          )}
          {p?.next && (
            <p>
              <span className="label">Next</span>
              <EvidenceText text={p.next} />
            </p>
          )}
          {!p && (
            <p className="subtle">
              No current position has been recorded on this issue.
            </p>
          )}
          {issue.latestUpdate && (
            <p className="subtle clamp">
              <a href={issue.latestUpdate.url} target="_blank" rel="noreferrer">
                Latest update
              </a>{" "}
              {ago(issue.latestUpdate.at, now)}:{" "}
              {plainText(issue.latestUpdate.body)}
            </p>
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
          {(!!issue.emailLinks?.length || !!pulls.length) && (
            <ul className="work-links">
              {(issue.emailLinks ?? []).map((link) => (
                <li key={link.threadId}>
                  {link.url ? (
                    <Link
                      to="/"
                      search={{ view: "inbox", email: link.threadId }}
                    >
                      {link.subject ||
                        currentInbox(snapshots)?.threads.find(
                          (t) => t.id === link.threadId,
                        )?.subject ||
                        "Email conversation"}
                    </Link>
                  ) : (
                    link.subject || "Email conversation"
                  )}
                  {link.context && (
                    <span className="subtle"> · {link.context}</span>
                  )}
                </li>
              ))}
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
          <div className="actions">
            {!row.done && (
              <button className="btn-quiet" onClick={() => setComposing(true)}>
                Start activity
              </button>
            )}
            <a href={issue.url} target="_blank" rel="noreferrer">
              Issue #{issue.number}
            </a>
            <CloseControl row={row} now={now} />
          </div>
          {composing && (
            <Composer
              snapshots={snapshots}
              archives={archives}
              workIssue={issue.number}
              projectId={workProject(issue, snapshots, archives)}
              emailThread={emailThread}
              context={emailContext(issue, emailThread, snapshots)}
              autoFocus
              placeholder={`What should happen next on “${issue.title}”?`}
              onCancel={() => setComposing(false)}
              onStarted={(run) => {
                setComposing(false);
                void navigate({
                  to: "/",
                  search: workSearch(issue.number, emailThread, run.id),
                });
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}
// The bigger picture: open work grouped by who it is for and why, with the
// groups that need the owner first. Planned and closed work stays folded away.
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
  const inbox = currentInbox(snapshots);
  // A failed or stale read must not look like quiet work.
  const degraded =
    freshness(work.observedAt, now) ||
    snapshots.some((s) => s.work?.associationsState !== "ok") ||
    (!!inbox && (inbox.state !== "ok" || freshness(inbox.observedAt, now)));
  return (
    <section className="bigger" aria-label="Bigger work">
      <div className="bigger-head">
        <h2>Bigger work</h2>
        <span className="subtle">
          {current.length} open{needs ? ` · ${needs} need you` : ""}
        </span>
      </div>
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

// Business work may span repositories. Only a single explicit, current match
// is a safe default; the coordinator can choose otherwise.
export function workProject(
  issue: Issue,
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
function emailContext(
  issue: Issue,
  threadId: string | undefined,
  snapshots: Snapshot[],
) {
  if (!threadId) return undefined;
  const inbox = currentInbox(snapshots);
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

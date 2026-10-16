import { InboxView, inboxCount } from "./inbox-view";
import { Machines } from "./machines-view";
import { Restart } from "./restart";
import {
  ProjectConversations,
  useEmailConversations,
  useRuns,
} from "./run-view";
import { awaitsYou } from "./run-model";
import { TodayView } from "./today-view";
import { ArchiveButton, ArchiveView } from "./archive-view";
import {
  isArchived,
  sessionArchived,
  type ArchiveEntry,
} from "./archive-model";
import {
  conversationSearch,
  parseNavigation,
  projectSearch,
} from "./navigation";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Link,
  useSearch,
} from "@tanstack/react-router";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import "@fontsource-variable/public-sans";
import "./style.css";
import {
  ago,
  currentGithub,
  freshness,
  currentQuota,
  lastActivity,
  projectHealth,
  pullConcern,
  pushPending,
  threads,
  type Observation,
  type ProjectHealth,
  hostName,
  machineIdSchema,
  type Snapshot,
  type Session,
} from "./model";
import { overviewQueryOptions } from "./overview-query";
import { NotificationPrompt } from "./notifications";

const verdicts: Record<ProjectHealth["verdict"], [string, string]> = {
  stale: ["Update overdue", "warning"],
  attention: ["Needs a look", "warning"],
  progress: ["In progress", "working"],
  clean: ["Git clean", "good"],
};
function WeeklyQuotas({snapshots}: {snapshots: Snapshot[]}) {
  const now = Date.now();
  return <aside className="weekly-quotas" aria-label="Weekly quota remaining">
    <span className="quota-heading">Weekly remaining</span>
    {(["codex", "claude"] as const).map((provider) => {
      const quota = currentQuota(snapshots, provider);
      const stale = !!quota && freshness(quota.observedAt, now);
      const expired = quota?.state === "ok" && quota.weekly.resetsAt <= now;
      const available = quota?.state === "ok" && !stale && !expired;
      const name = provider === "codex" ? "Codex" : "Claude";
      const reset = quota?.state === "ok" ? new Date(quota.weekly.resetsAt).toLocaleString(undefined, {weekday: "short", hour: "numeric", minute: "2-digit"}) : null;
      const value = available ? `${Math.floor(100 - quota.weekly.usedPercent)}% left` : stale ? "update overdue" : expired ? "awaiting refresh" : "unavailable";
      return <span key={provider} className={`quota-item${available && quota.weekly.usedPercent >= 90 ? " quota-low" : ""}`} title={quota ? `Latest report from ${hostName(quota.host)} · ${new Date(quota.observedAt).toLocaleString()}${reset ? ` · resets ${reset}` : ""}. Subscription limit, not a token balance.` : "Waiting for a machine to report its subscription limit."}>
        <strong>{name}</strong> <span>{value}</span>
        {available && <span className="quota-reset">resets {reset}</span>}
      </span>;
    })}
  </aside>;
}
function group(snapshots: Snapshot[]) {
  const groups = new Map<string, Observation[]>();
  for (const s of snapshots)
    for (const p of s.projects)
      groups.set(p.id, [
        ...(groups.get(p.id) ?? []),
        { project: p, host: s.host, at: s.collectedAt },
      ]);
  return [...groups.values()]
    .map((g) => g.sort((a, b) => b.at - a.at))
    .sort((a, b) => a[0].project.name.localeCompare(b[0].project.name));
}
function Badge({
  children,
  tone = "quiet",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function ProjectRow({
  observations,
  now,
  archives,
  detail = false,
}: {
  observations: Observation[];
  now: number;
  archives: ArchiveEntry[];
  detail?: boolean;
}) {
  const [expanded, setExpanded] = useState(detail);
  const p = observations[0].project;
  const archived = isArchived(archives, { kind: "project", projectId: p.id });
  const health = projectHealth(observations, now);
  const issues = health.concerns;
  const [label, tone] = verdicts[health.verdict];
  const sessions = observations.flatMap((o) =>
    o.project.sessions
      .filter((s) => !sessionArchived(archives, o.host, s.app, s.id))
      .map((s) => ({
        ...s,
        host: o.host,
        stale: freshness(o.at, now),
      })),
  );
  const recent = sessions.filter((s) => now - s.updatedAt < 7 * 86400_000);
  const progress = observations
    .map((o) => o.project.progress)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const latest = observations
    .flatMap((o) => (o.project.latestMerge ? [o.project.latestMerge] : []))
    .sort((a, b) => b.mergedAt - a.mergedAt)[0];
  const github = currentGithub(observations, now);
  const pulls = github?.project.pulls ?? [];
  const work = threads(
    observations.map((o) => ({
      ...o,
      project: {
        ...o.project,
        sessions: o.project.sessions.filter(
          (s) => !sessionArchived(archives, o.host, s.app, s.id),
        ),
      },
    })),
    github,
    now,
  );
  const shown = work.slice(0, 4);
  const old = sessions.length - recent.length;
  return (
    <article className={`project ${expanded ? "expanded" : ""}`}>
      <button
        className="project-summary"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`details-${p.id}`}
      >
        <span className="project-title">
          <span className="project-name">{p.name}</span>
          <span className="repo">{p.repo}</span>
          <Badge tone={tone}>{label}</Badge>
          {archived && <Badge>Archived</Badge>}
        </span>
        <span className="project-progress">
          {work.length ? (
            <span className="threads">
              {shown.map((t) => (
                <span className="thread" key={t.key}>
                  <span className={`thread-dot ${t.tone}`} aria-hidden="true" />
                  <span className="thread-text">
                    <span className="thread-title">{t.title}</span>
                    <span className="subtle">
                      {t.detail} · {ago(t.at, now)}
                    </span>
                  </span>
                </span>
              ))}
              {work.length > shown.length && (
                <span className="subtle">
                  +{work.length - shown.length} more inside
                </span>
              )}
            </span>
          ) : (
            <>
              <span>
                {latest
                  ? `Latest merge: ${latest.title}`
                  : "No project status recorded yet."}
              </span>
              <span className="subtle">
                {latest ? `${ago(latest.mergedAt, now)} · ` : ""}
                {progress.source
                  ? `Plan: ${progress.summary}`
                  : p.description || "Nothing open."}
              </span>
            </>
          )}
        </span>
        <span className="project-state">
          {issues.length > 0 && (
            <span className="subtle issues-inline">{issues.join(" · ")}</span>
          )}
          {health.inProgress.length > 0 && (
            <span className="subtle">
              In progress: {health.inProgress.join(" · ")}
            </span>
          )}
          <span className="subtle">
            {pulls.length} open PR{pulls.length === 1 ? "" : "s"} ·{" "}
            {recent.length} recent session{recent.length === 1 ? "" : "s"}
            {old ? ` + ${old} older` : ""}
          </span>
        </span>
        <span className="disclosure" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>
      <div className="project-actions">
        {!detail && (
          <Link to="/" search={projectSearch(p.id)}>
            Open project →
          </Link>
        )}
        <Link to="/" search={conversationSearch(undefined, p.id)}>
          Conversations
        </Link>
        <Link to="/" search={{ view: "archive", project: p.id }}>
          Archived items
        </Link>
        <ArchiveButton
          target={{ kind: "project", projectId: p.id }}
          archived={archived}
          name={p.name}
        />
      </div>
      {expanded && (
        <div className="project-details" id={`details-${p.id}`}>
          <div className="detail-column">
            <h3>Where things stand</h3>
            <p>{progress.summary}</p>
            {latest && (
              <p>
                Latest merge:{" "}
                <a href={latest.url} target="_blank" rel="noreferrer">
                  {latest.title}
                </a>{" "}
                <span className="subtle">
                  {ago(latest.mergedAt, now)}. Deployment not checked.
                </span>
              </p>
            )}
            {progress.next.length > 0 && (
              <>
                <h4>Next in the plan</h4>
                <ul>
                  {progress.next.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </>
            )}
            {progress.source && (
              <p className="subtle">
                Source:{" "}
                <a
                  href={`https://github.com/${p.repo}/blob/main/${progress.source}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {progress.source}
                </a>
                <br />
                Local file updated {ago(progress.updatedAt, now)}. Plan text is
                not release verification.
              </p>
            )}
            <h3>Repository health</h3>
            {issues.length ? (
              <ul className="issues">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : (
              <p>
                {health.inProgress.length
                  ? "Nothing needs a look."
                  : "No local changes or failed PR checks observed."}
              </p>
            )}
            {health.inProgress.length > 0 && (
              <>
                <h4>In progress</h4>
                <ul>
                  {health.inProgress.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </>
            )}
            {observations.map((o) => (
              <div className="host-detail" key={o.host}>
                <h4>
                  {hostName(o.host)}{" "}
                  <span className="subtle">
                    {ago(o.at, now)}
                    {freshness(o.at, now) ? " · stale" : ""}
                  </span>
                </h4>
                <div className="worktrees">
                  {o.project.worktrees.map((w) => (
                    <div key={w.path} className="worktree">
                      <span title={w.path}>
                        {w.isPrimary ? "Main checkout" : w.branch}
                      </span>
                      <span>
                        {w.prunable
                          ? "Folder removed; Git still lists it"
                          : (w.error ??
                            (w.changed ? `${w.changed} changed` : "Disk clean"))}
                        {pushPending(w) === null
                          ? " · push state unknown"
                          : pushPending(w)
                            ? ` · ${pushPending(w)} unpushed`
                            : ""}
                        {w.behind ? ` · ${w.behind} behind` : ""}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="subtle">
                  {o.project.sources.git.message}{" "}
                  {o.project.sources.github.state !== "ok" &&
                    o.project.sources.github.message}
                </p>
              </div>
            ))}
            <h3>
              Open pull requests <span className="count">{pulls.length}</span>
            </h3>
            {pulls.length ? (
              pulls.map((pr) => (
                <a
                  className="pull"
                  key={pr.url}
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>
                    #{pr.number} {pr.title}
                  </span>
                  <Badge tone={pullConcern(pr) ? "warning" : "quiet"}>
                    {pr.draft ? "Draft · " : ""}
                    {pr.checks === "none" ? "No checks" : pr.checks}
                  </Badge>
                </a>
              ))
            ) : (
              <p className="subtle">
                {!github
                  ? "PR status is unavailable."
                  : "No open pull requests."}
              </p>
            )}
          </div>
          <div className="detail-column">
            <h3>
              Native sessions <span className="count">{sessions.length}</span>
            </h3>
            <p className="subtle">
              Continue work in the original app. Codex lists unarchived tasks;
              Claude lists live local processes.
            </p>
            {recent
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((s) => (
                <NativeSession
                  key={`${s.host}-${s.app}-${s.id}`}
                  session={s}
                  host={s.host}
                  stale={s.stale}
                  now={now}
                />
              ))}
            {!recent.length && <p>No recent sessions observed.</p>}
            {old > 0 && (
              <details className="older">
                <summary>{old} older sessions</summary>
                {sessions
                  .filter((s) => now - s.updatedAt >= 7 * 86400_000)
                  .map((s) => (
                    <NativeSession
                      key={`${s.host}-${s.app}-${s.id}`}
                      session={s}
                      host={s.host}
                      stale={s.stale}
                      now={now}
                    />
                  ))}
              </details>
            )}
            <div className="coverage">
              <h4>Coverage</h4>
              {observations.map((o) => (
                <div key={o.host}>
                  <strong>{hostName(o.host)}</strong>
                  {(["codex", "claude"] as const).map((key) => (
                    <p key={key}>
                      <span className="source-name">{key}</span>{" "}
                      {o.project.sources[key].message}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
function NativeSession({
  session: s,
  host,
  stale,
  now,
}: {
  session: Session;
  host: string;
  stale?: boolean;
  now: number;
}) {
  return (
    <article className="session">
      <div className="session-meta">
        <span>
          {s.app}{" "}
          <span className="subtle">on {hostName(host)}</span>
        </span>
        <Badge
          tone={stale ? "warning" : s.state === "running" ? "good" : "quiet"}
        >
          {stale ? "Last known: " : ""}
          {s.state}
        </Badge>
      </div>
      <p className="session-title">{s.title}</p>
      <span className="subtle">
        {ago(s.updatedAt, now)} · {s.evidence}
      </span>
      <div className="session-actions">
        <Restart app={s.app} id={s.id} host={host} />
        {machineIdSchema.safeParse(host).success && (
          <ArchiveButton
            target={{ kind: "session", host, app: s.app, sessionId: s.id }}
            archived={false}
            name={s.title}
          />
        )}
      </div>
    </article>
  );
}
async function signOut() {
  const r = await fetch("/api/auth/logout", { method: "POST" });
  if (r.ok) {
    client.clear();
    location.reload();
  }
}
function SignIn({ done }: { done: () => void }) {
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${sent ? "verify" : "request"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Too many attempts. Please try again later."
            : sent
              ? "The code is invalid or expired."
              : "Email delivery is unavailable. Please try again later.",
        );
      if (sent) done();
      else setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <h1>Projects</h1>
      <p>A private overview of your work.</p>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            disabled={sent}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {sent && (
          <>
            <p>
              If this address is allowed, a code is on its way. It expires in 10
              minutes.
            </p>
            <label>
              Sign-in code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="refresh" disabled={busy}>
          {busy ? "Please wait…" : sent ? "Sign in" : "Email me a code"}
        </button>
        {sent && (
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode("");
              setError("");
            }}
          >
            Request another code
          </button>
        )}
      </form>
    </main>
  );
}
function Dashboard() {
  const navigation = useSearch({ from: "/" });
  const view = navigation.view;
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const query = useQuery(overviewQueryOptions);
  const current = useRuns(),
    email = useEmailConversations();
  if (query.error?.message === "SIGN_IN")
    return (
      <SignIn
        done={() => {
          // Conversation lists also failed while signed out; reload them all.
          void client.resetQueries();
        }}
      />
    );
  const now = Date.now(),
    snapshots = query.data?.snapshots ?? [];
  const archives = query.data?.archives ?? [];
  const inboxActions = query.data?.inboxActions ?? [];
  const toHandle = inboxCount(snapshots, email.data?.runs, inboxActions, now);
  // Matches Today's "Your move": finished conversations not yet marked Done,
  // and running ones only the owner can unblock.
  const waiting = (
    current.data?.pages.flatMap((page) => page.runs) ?? []
  ).filter(awaitsYou).length;
  const groups = group(snapshots);
  const currentGroups = groups.filter(
    (g) =>
      !isArchived(archives, { kind: "project", projectId: g[0].project.id }),
  );
  const selectedProject = groups.find(
    (g) => g[0].project.id === navigation.project,
  );
  const selectedProjectArchive = archives.find(
    (a) => a.target.kind === "project" && a.projectId === navigation.project,
  );
  const selectedProjectName =
    selectedProject?.[0].project.name ??
    selectedProjectArchive?.title ??
    navigation.project;
  const unassigned = snapshots
    .flatMap((h) =>
      (h.unassignedSessions ?? []).map((s) => ({ ...s, host: h.host })),
    )
    .filter((s) => !sessionArchived(archives, s.host, s.app, s.id))
    .filter((s) =>
      `${s.title} ${s.app}`.toLowerCase().includes(search.toLowerCase()),
    );
  const activity = new Map(
    groups.map((g) => [
      g[0].project.id,
      lastActivity(threads(g, currentGithub(g, now), now)),
    ]),
  );
  // Overdue updates stay in this view: an unverified project is never fine.
  const attention = new Set(
    currentGroups
      .filter((g) =>
        ["stale", "attention"].includes(projectHealth(g, now).verdict),
      )
      .map((g) => g[0].project.id),
  );
  const visible = currentGroups.filter((g) => {
    const p = g[0].project;
    const matches =
      `${p.name} ${p.repo} ${g.flatMap((o) => o.project.sessions.map((s) => s.title)).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase());
    return matches && (filter === "all" || attention.has(p.id));
  });
  const active = visible
    .filter((g) => (activity.get(g[0].project.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (activity.get(b[0].project.id) ?? 0) -
        (activity.get(a[0].project.id) ?? 0),
    );
  const quiet = visible.filter((g) => !(activity.get(g[0].project.id) ?? 0));
  return (
    <>
      <header className="topbar">
        <Link className="brand" to="/" search={{ view: "today" }}>
          <span className="brand-mark" aria-hidden="true">
            ▤
          </span>
          <span className="brand-name">Projects</span>
        </Link>
        <nav className="tabs" aria-label="Views">
          <Link
            to="/"
            search={{ view: "today" }}
            aria-current={view === "today" ? "page" : undefined}
          >
            Today
            {!!waiting && <span className="tab-count">{waiting}</span>}
          </Link>
          <Link
            to="/"
            search={{ view: "inbox" }}
            aria-current={view === "inbox" ? "page" : undefined}
          >
            Inbox
            {toHandle && (toHandle.todo > 0 || !toHandle.complete) && (
              <span
                className="tab-count"
                title={
                  toHandle.complete
                    ? "Emails to handle"
                    : "The inbox read is incomplete or out of date"
                }
              >
                {toHandle.todo || ""}
                {toHandle.complete ? "" : "?"}
              </span>
            )}
          </Link>
          <Link
            to="/"
            search={{ view: "archive" }}
            aria-current={view === "archive" ? "page" : undefined}
          >
            Archive
          </Link>
        </nav>
        <Link className="settings-link" to="/" search={{ view: "health" }} aria-current={view === "health" || view === "project" ? "page" : undefined}>Settings</Link>
        <button className="signout" onClick={signOut}>
          Sign out
        </button>
      </header>
      <WeeklyQuotas snapshots={snapshots} />
      <main className={`view-${view}`}>
        {view === "project" && (
          <h1 className="page-title">{selectedProjectName ?? "Project"}</h1>
        )}
        {query.error && (
          <div role="alert" className="error">
            {query.error.message}
          </div>
        )}
        {view === "today" && <NotificationPrompt />}
        {view === "today" && (
          <TodayView
            snapshots={snapshots}
            archives={archives}
            closes={query.data?.closes ?? []}
            navigation={navigation}
            now={now}
          />
        )}
        {view === "inbox" && (
          <InboxView
            snapshots={snapshots}
            archives={archives}
            actions={inboxActions}
            selectedEmail={navigation.email}
            now={now}
          />
        )}
        {view === "archive" && (
          <ArchiveView
            snapshots={snapshots}
            archives={archives}
            projectId={navigation.project}
          />
        )}
        {view === "project" && navigation.project && (
          <section className="project-page" aria-label="Project details">
            <nav className="breadcrumbs" aria-label="Project navigation">
              <Link to="/" search={{ view: "health" }}>
                ← Settings
              </Link>
              {navigation.run && (
                <Link
                  to="/"
                  search={conversationSearch(
                    navigation.run,
                    navigation.project,
                  )}
                >
                  ← Back to conversation
                </Link>
              )}
            </nav>
            {selectedProjectArchive && (
              <div className="archive-notice">
                This project is archived. Its conversations and files are kept.
                <ArchiveButton
                  target={selectedProjectArchive.target}
                  archived
                  name={selectedProjectArchive.title}
                />
              </div>
            )}
            <ProjectConversations
              snapshots={snapshots}
              archives={archives}
              projectId={navigation.project}
            />
            {selectedProject ? (
              <ProjectRow
                key={navigation.project}
                observations={selectedProject}
                now={now}
                archives={archives}
                detail
              />
            ) : (
              <p className="subtle">
                This project is not in the latest machine inventory. Its saved
                conversations are still available above.
              </p>
            )}
          </section>
        )}
        {view === "health" && (
          <>
            <h1 className="page-title">Settings</h1>
            <Machines
              snapshots={snapshots}
              machines={query.data?.machines ?? []}
              now={now}
            />
            <h2 className="section">Repositories</h2>
            <div className="toolbar">
              <div className="filters" aria-label="Project filters">
                <button
                  className={filter === "all" ? "selected" : ""}
                  onClick={() => setFilter("all")}
                >
                  Current projects <span>{currentGroups.length}</span>
                </button>
                <button
                  className={filter === "attention" ? "selected" : ""}
                  onClick={() => setFilter("attention")}
                >
                  Needs a look <span>{attention.size}</span>
                </button>
              </div>
              <input
                aria-label="Search projects and sessions"
                placeholder="Find a project or session…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {query.isPending ? (
              <div className="empty">Reading project updates…</div>
            ) : !groups.length ? (
              <div className="empty">
                <h2>Waiting for the first update</h2>
                <p>
                  No machine has published a snapshot yet. Projects appear here
                  when one reports.
                </p>
              </div>
            ) : !visible.length ? (
              <div className="empty">No projects match this view.</div>
            ) : (
              <>
                <h2 className="section">
                  Repository activity{" "}
                  <span className="count">{active.length}</span>
                </h2>
                {active.length ? (
                  <div className="list">
                    {active.map((o) => (
                      <ProjectRow
                        key={o[0].project.id}
                        observations={o}
                        now={now}
                        archives={archives}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    Nothing open: no recent sessions, changed checkouts or pull
                    requests.
                  </div>
                )}
                {quiet.length > 0 && (
                  <details className="quiet-list" open={search.length > 0}>
                    <summary>
                      Quiet <span className="count">{quiet.length}</span>
                      <span className="subtle">
                        {" "}
                        · nothing open; last merge and health only
                      </span>
                    </summary>
                    <div className="list">
                      {quiet.map((o) => (
                        <ProjectRow
                          key={o[0].project.id}
                          observations={o}
                          now={now}
                          archives={archives}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
            {unassigned.length > 0 && (
              <details className="unassigned">
                <summary>
                  {unassigned.length} sessions outside these project folders
                </summary>
                <p className="subtle">
                  These tasks started in a shared or untracked directory. They
                  are kept visible without guessing which project they belong
                  to.
                </p>
                {unassigned.map((s) => (
                  <NativeSession
                    key={`${s.host}-${s.app}-${s.id}`}
                    session={s}
                    host={s.host}
                    now={now}
                  />
                ))}
              </details>
            )}
          </>
        )}
        {view === "health" && (
          <footer>
            Snapshots describe what each machine observed.{" "}
            <a href="/agents.md">Guide for Codex & Claude</a>{" "}
            <button className="phone-signout" onClick={signOut}>
              Sign out
            </button>
          </footer>
        )}
      </main>
    </>
  );
}
const root = createRootRoute();
const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  validateSearch: parseNavigation,
  component: Dashboard,
});
const router = createRouter({ routeTree: root.addChildren([index]) });
const client = new QueryClient();
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);

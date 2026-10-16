import React, { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ago, hostName, type Snapshot } from "./model";
import { currentWork } from "./work-model";
import {
  activeRun,
  activityLabel,
  ACTIVITY_LIMIT,
  FALLBACK_AFTER_MS,
  RUNNER_STALE_MS,
  MASTER_TAKEOVER,
  runProjectIds,
  usageTotal,
  type Agent,
  type Child,
  type ProgressUpdate,
  type Run,
  type RunInput,
  type RunMessage,
  type Lane,
  type RunnerHost,
  type RunState,
  type RunSummary,
} from "./run-model";
import {
  clip,
  cleanAgentText,
  describeLink,
  documentLinks,
  doneSoFar,
  headline,
  latestPlan,
  formatTokens,
  runDocuments,
  runTitle,
  tokenLine,
  type DocumentLink,
} from "./run-text";
import { Restart } from "./restart";
import {
  ScreenshotButtons,
  ScreenshotPreviews,
  useScreenshots,
} from "./screenshots";
import { InlineMarkdown, MarkdownContent } from "./review-view";
import {
  api,
  overviewQueryOptions,
  privateQueryPolicy,
} from "./overview-query";
import { isArchived, type ArchiveEntry } from "./archive-model";
import {
  conversationSearch,
  projectSearch,
  type Navigation,
} from "./navigation";


type RunPage = {
  runs: RunSummary[];
  enabled: boolean;
  nextOffset: number | null;
};
export function useRuns(projectId?: string, archived = false) {
  return useInfiniteQuery({
    queryKey: ["runs", projectId ?? null, archived],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        archived: String(archived),
        offset: String(pageParam),
      });
      if (projectId) params.set("projectId", projectId);
      return api<RunPage>(`/api/runs?${params}`);
    },
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    // Done conversations change rarely; current ones show live status.
    ...privateQueryPolicy(archived ? 30_000 : 5000),
  });
}
// Every conversation started from an email, current or Done, for the inbox.
export function useEmailConversations() {
  return useQuery({
    queryKey: ["runs", "email"],
    queryFn: () => api<RunPage>("/api/runs?email=true"),
    ...privateQueryPolicy(15_000),
  });
}
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
  const [label, tone] = runStates[run.needsYou ? "blocked" : run.state];
  const projects = run.projectIds ?? (run.projectId ? [run.projectId] : []);
  const meta = [
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

// Enter sends and Shift+Enter starts a new paragraph. Enter that confirms an
// input method's composition (keyCode 229 in Safari) only confirms the text.
export function sendOnEnter(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  send: () => void,
) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  send();
}

// The master last chosen on this device; Codex until Claude is picked.
const MASTER_KEY = "projects.masterAgent";
function savedMaster(): Agent {
  try {
    return localStorage.getItem(MASTER_KEY) === "claude" ? "claude" : "codex";
  } catch {
    return "codex";
  }
}
function saveMaster(agent: Agent) {
  try {
    localStorage.setItem(MASTER_KEY, agent);
  } catch {
    /* A private window keeps the choice for this form only. */
  }
}

// Start a conversation. Used on Today, under an email and under a work item.
export function Composer({
  snapshots,
  archives,
  initialText = "",
  context,
  projectId: initialProject,
  workIssue: initialIssue,
  emailThread,
  lane: initialLane = "standard",
  autoFocus,
  placeholder = "What needs doing? e.g. Reply to Rob: Thursday works for training",
  submitLabel = "Start",
  onStarted,
  onCancel,
}: {
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  initialText?: string;
  // Fixed framing around the owner's words: a title line first, details last.
  context?: { title: string; detail: string };
  projectId?: string;
  workIssue?: number;
  emailThread?: string;
  lane?: Lane;
  autoFocus?: boolean;
  placeholder?: string;
  submitLabel?: string;
  onStarted?: (run: Run) => void;
  onCancel?: () => void;
}) {
  const client = useQueryClient();
  const current = useRuns();
  const enabled = !!current.data?.pages[0]?.enabled;
  const [text, setText] = useState(initialText),
    [projectId, setProjectId] = useState(initialProject ?? ""),
    [agent, setAgent] = useState<RunInput["agent"]>("auto"),
    [masterAgent, setMasterAgent] = useState<Agent>(savedMaster),
    [issue, setIssue] = useState(initialIssue ? String(initialIssue) : ""),
    [lane, setLane] = useState<Lane>(initialLane),
    [options, setOptions] = useState(false);
  const images = useScreenshots();
  const field = useRef<HTMLTextAreaElement>(null);
  // An ambiguous network response must not create a second conversation.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => setProjectId(initialProject ?? ""), [initialProject]);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 360)}px`;
  }, [text]);
  // Focus once when the composer opens, with the cursor after any prefill.
  useEffect(() => {
    const element = field.current;
    if (!autoFocus || !element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);
  const create = useMutation({
    mutationFn: () => {
      const words = text.trim();
      const input = {
        text: context
          ? [context.title, words, context.detail].filter(Boolean).join("\n\n")
          : words || "Review the attached screenshots.",
        screenshots: images.images,
        projectId: projectId || null,
        agent,
        ...(masterAgent === "claude" ? { masterAgent } : {}),
        workIssue: issue ? Number(issue) : null,
        ...(emailThread ? { emailThread } : {}),
        ...(lane === "quick" ? { lane } : {}),
      };
      const key = JSON.stringify(input);
      if (attempt.current?.key !== key)
        attempt.current = { key, id: crypto.randomUUID() };
      return api<{ run: Run }>("/api/runs", {
        ...input,
        requestId: attempt.current.id,
      });
    },
    onSuccess: async (result) => {
      attempt.current = null;
      setText("");
      images.clear();
      client.setQueryData(["run", result.run.id], result);
      onStarted?.(result.run);
      await client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  // Any connected machine may run the work, so offer projects registered on
  // any of them.
  const projects = [
    ...new Map(
      snapshots
        .flatMap((s) => s.projects)
        .map((p) => [p.id, p] as const),
    ).values(),
  ].filter(
    (p) =>
      p.id === projectId ||
      !isArchived(archives, { kind: "project", projectId: p.id }),
  );
  const issues = currentWork(snapshots)?.issues.filter((i) => i.open) ?? [];
  const chosen = [
    projects.find((p) => p.id === projectId)?.name,
    issue ? `#${issue}` : "",
    agent === "auto" ? "" : agent === "codex" ? "Codex" : "Claude",
    masterAgent === "claude" ? "Claude master" : "",
    lane === "quick" ? "Quick" : "",
  ].filter(Boolean);
  const ready =
    (!!context || !!text.trim() || !!images.images.length) &&
    enabled &&
    !create.isPending &&
    !images.busy;
  return (
    <form
      className="composer"
      onPaste={images.paste}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate();
      }}
    >
      {context && <p className="composer-context">{context.title}</p>}
      <textarea
        ref={field}
        aria-label={context ? context.title : "What needs doing"}
        required={!context && !images.images.length}
        maxLength={8000}
        rows={2}
        value={text}
        placeholder={placeholder}
        disabled={create.isPending}
        enterKeyHint="send"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) =>
          sendOnEnter(event, () => {
            if (ready) create.mutate();
          })
        }
      />
      <ScreenshotPreviews draft={images} disabled={create.isPending} />
      {options && (
        <div className="composer-fields">
          <label>
            Project
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={create.isPending}
            >
              <option value="">Let Projects choose</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Master
            <select
              value={masterAgent}
              onChange={(e) => {
                const next = e.target.value === "claude" ? "claude" : "codex";
                setMasterAgent(next);
                saveMaster(next);
              }}
              disabled={create.isPending}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            Agent
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value as RunInput["agent"])}
              disabled={create.isPending}
            >
              <option value="auto">Claude or Codex</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Work item
            <select
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              disabled={create.isPending}
            >
              <option value="">None</option>
              {issues.map((i) => (
                <option key={i.number} value={i.number}>
                  #{i.number} · {clip(i.title, 70)}
                </option>
              ))}
            </select>
          </label>
          <label className="composer-check">
            <input
              type="checkbox"
              checked={lane === "quick"}
              onChange={(e) => setLane(e.target.checked ? "quick" : "standard")}
              disabled={create.isPending}
            />
            Quick task: own slots, no repository changes
          </label>
        </div>
      )}
      <div className="composer-bar">
        <ScreenshotButtons draft={images} disabled={create.isPending} />
        <button
          type="button"
          className="options-toggle"
          aria-expanded={options}
          onClick={() => setOptions(!options)}
        >
          {chosen.length ? chosen.join(" · ") : "Options"}
        </button>
        <span className="composer-submit">
          {onCancel && (
            <button
              type="button"
              className="btn-quiet"
              onClick={onCancel}
              disabled={create.isPending}
            >
              Cancel
            </button>
          )}
          <button className="btn" type="submit" disabled={!ready}>
            {create.isPending ? "Starting…" : submitLabel}
          </button>
        </span>
      </div>
      {create.error && (
        <p role="alert" className="error">
          {errorText(create.error)}
        </p>
      )}
      {!enabled && current.data && (
        <p className="error">
          The runner is not active, so work cannot start.
        </p>
      )}
    </form>
  );
}

function Time({ at }: { at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {ago(at, Date.now())}
    </time>
  );
}
const agentName = (actor: "master" | "codex" | "claude") =>
  actor === "master" ? "Projects" : actor === "codex" ? "Codex" : "Claude";

// The owner's words stay as typed; only HTTPS links (Markdown or bare) become links.
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(
          /(\[[^\]\n]{1,300}\]\(https:\/\/[^\s)]+\)|https:\/\/[^\s)<>\]"']+)/g,
        )
        .map((part, index) => {
          const markdown = part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
          // A sentence ending after a bare link keeps its punctuation as text.
          const trail = markdown ? "" : (part.match(/[.,;:!?]+$/)?.[0] ?? "");
          const url =
            markdown?.[2] ??
            (part.startsWith("https://")
              ? part.slice(0, part.length - trail.length)
              : null);
          if (!url) return <React.Fragment key={index}>{part}</React.Fragment>;
          const label =
            markdown?.[1] ??
            describeLink(url)?.label ??
            clip(url.replace(/^https:\/\//, ""), 48);
          return (
            <React.Fragment key={index}>
              <a href={url} target="_blank" rel="noreferrer">
                {label}
              </a>
              {trail}
            </React.Fragment>
          );
        })}
    </>
  );
}
function UserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 6;
  return (
    <>
      <p className={`msg-text${long && !open ? " clamp" : ""}`}>
        <LinkedText text={text} />
      </p>
      {long && (
        <button className="link-button" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}
function Message({ run, message }: { run: Run; message: RunMessage }) {
  const agent = message.role === "master";
  return (
    <article className={`msg ${agent ? "msg-agent" : "msg-you"}`}>
      {agent ? (
        <MarkdownContent
          className="run-markdown"
          text={cleanAgentText(message.text)}
        />
      ) : (
        <UserText text={message.text} />
      )}
      {!!message.screenshots?.length && (
        <div className="screenshot-previews sent-screenshots">
          {message.screenshots.map((image, index) => (
            <a
              key={image.id}
              href={`/api/runs/${run.id}/screenshots/${image.id}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open screenshot ${index + 1}`}
            >
              <img
                src={`/api/runs/${run.id}/screenshots/${image.id}`}
                alt={`Screenshot ${index + 1}`}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
      <p className="msg-meta">
        {agent ? "Projects · " : ""}
        <Time at={message.at} />
        {message.delivery &&
          (message.delivery === "reviewed"
            ? " · seen by Projects"
            : message.delivery === "steered"
              ? " · given to the agent at work"
              : activeRun(run.state)
                ? " · waiting for the agent"
                : " · not yet seen")}
      </p>
    </article>
  );
}
function Thread({ run }: { run: Run }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, run.messages.length - 4);
  return (
    <div className="messages">
      {hidden > 0 && (
        <button className="link-button" onClick={() => setAll(true)}>
          Show {hidden} earlier message{hidden === 1 ? "" : "s"}
        </button>
      )}
      {run.messages.slice(hidden).map((message) => (
        <Message key={message.id} run={run} message={message} />
      ))}
    </div>
  );
}
// What is happening now and what is left, from the agents' own notes.
function NowPanel({ run }: { run: Run }) {
  const notes = latestPlan(run);
  // The working agent's own plan, when it is newer than its last note.
  const live = run.state === "running" ? run.progress?.live : undefined;
  const steps =
    live?.plan?.length && live.at >= (notes?.at ?? 0)
      ? live.plan.filter((s) => s.status !== "done").map((s) => s.step)
      : null;
  const plan = steps
    ? { remaining: steps, actor: live!.actor, at: live!.at, yourMove: notes?.yourMove }
    : notes;
  const done = doneSoFar(run);
  const [earlier, setEarlier] = useState(false);
  const step =
    run.state === "queued"
      ? run.host
        ? `Waiting for a free slot on ${hostName(run.host)}.`
        : "Waiting for a machine to pick it up."
      : run.state === "cancelling"
        ? "Stopping. Work so far is kept."
        : (plan?.remaining[0] ??
          (headline(run.progress?.summary ?? "") || "Starting…"));
  const then =
    run.state === "running" ? (plan?.remaining.slice(1, 4) ?? []) : [];
  const changes = live?.changes;
  const last = run.progress?.activity?.at(-1)?.at;
  const due = run.nextUpdateAt;
  const shown = earlier ? done : done.slice(-3);
  return (
    <section className="now" aria-label="Progress now">
      <h3>
        <span className="pulse" aria-hidden="true" /> Now
      </h3>
      {run.state === "running" && plan?.yourMove && (
        <p className="now-blocker">
          <strong>Your move:</strong> <InlineMarkdown text={plan.yourMove} />
        </p>
      )}
      <p className="now-step">
        <InlineMarkdown text={step} />
      </p>
      {!!then.length && (
        <ul className="now-then" aria-label="Then">
          {then.map((item, index) => (
            <li key={index}>
              <InlineMarkdown text={item} />
            </li>
          ))}
          {(plan?.remaining.length ?? 0) > 4 && (
            <li className="subtle">and {plan!.remaining.length - 4} more</li>
          )}
        </ul>
      )}
      {!!changes?.total.files && (
        <details className="now-changes">
          <summary>
            Changes so far: {changes.total.files} file
            {changes.total.files === 1 ? "" : "s"} · +{changes.total.added} −
            {changes.total.removed}
          </summary>
          <ul>
            {changes.files.map((file) => (
              <li key={file.path}>
                <span className="now-file">{file.path}</span>{" "}
                <span className="subtle">
                  +{file.added} −{file.removed}
                </span>
              </li>
            ))}
            {changes.total.files > changes.files.length && (
              <li className="subtle">
                and {changes.total.files - changes.files.length} more
              </li>
            )}
          </ul>
        </details>
      )}
      {!!done.length && (
        <div className="now-done">
          <h4>Done so far</h4>
          <ul>
            {shown.map((item) => (
              <li key={item}>
                <InlineMarkdown text={item} />
              </li>
            ))}
          </ul>
          {done.length > 3 && (
            <button
              className="link-button"
              onClick={() => setEarlier(!earlier)}
            >
              {earlier ? "Show recent only" : `Show all ${done.length}`}
            </button>
          )}
        </div>
      )}
      {run.state === "running" && (
        <p className="subtle">
          {plan ? (
            <>
              {agentName(plan.actor)}’s plan · <Time at={plan.at} />
            </>
          ) : (
            "No plan reported yet"
          )}
          {last ? (
            <>
              {" "}
              · last activity <Time at={last} />
            </>
          ) : null}
          {live?.savedAt ? (
            <>
              {" "}
              · saved to GitHub <Time at={live.savedAt} />
            </>
          ) : null}
          {due
            ? ` · next summary in ${Math.max(1, Math.ceil((due - Date.now()) / 60_000))} min`
            : ""}
        </p>
      )}
    </section>
  );
}
const kinds: Record<DocumentLink["kind"], string> = {
  file: "File",
  pull: "PR",
  issue: "Issue",
  commit: "Commit",
  email: "Email",
  doc: "Doc",
};
export function DocumentList({
  docs,
  limit = 6,
}: {
  docs: DocumentLink[];
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  if (!docs.length) return null;
  return (
    <>
      <ul className="docs">
        {(all ? docs : docs.slice(0, limit)).map((doc) => (
          <li key={doc.url}>
            <a href={doc.url} target="_blank" rel="noreferrer">
              <span className={`doc-kind ${doc.kind}`}>{kinds[doc.kind]}</span>
              <span className="doc-text">
                <span className="doc-label">{doc.label}</span>
                <span className="doc-detail">{doc.detail}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {docs.length > limit && !all && (
        <button className="link-button" onClick={() => setAll(true)}>
          Show all {docs.length}
        </button>
      )}
    </>
  );
}
function ChildView({
  child,
  name,
  runId,
  host,
}: {
  child: Child;
  name: string;
  runId: string;
  host?: RunnerHost;
}) {
  const docs = documentLinks([
    { text: child.result?.summary, urls: child.result?.links },
  ]);
  return (
    <details
      className="child"
      open={child.state === "running" || child.state === "unknown"}
    >
      <summary>
        <strong>{child.agent === "codex" ? "Codex" : "Claude"}</strong> · {name}{" "}
        <span className="subtle">
          {child.state === "unknown" ? "outcome unconfirmed" : child.state} ·{" "}
          {child.mode === "read" ? "looked into it" : "made changes"}
          {child.usage
            ? ` · ${formatTokens(usageTotal(child.usage))} tokens`
            : ""}
        </span>
      </summary>
      {child.result && (
        <MarkdownContent
          className="run-markdown"
          text={cleanAgentText(child.result.summary)}
        />
      )}
      <DocumentList docs={docs} />
      {!!child.result?.checks.length && (
        <details className="checks">
          <summary>Checks reported ({child.result.checks.length})</summary>
          <ul>
            {child.result.checks.map((check, i) => (
              <li key={i}>{cleanAgentText(check)}</li>
            ))}
          </ul>
        </details>
      )}
      {!!child.evidence.length && (
        <details className="checks">
          <summary>Observed afterwards ({child.evidence.length})</summary>
          <ul>
            {child.evidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="subtle">
        <Link to="/" search={projectSearch(child.projectId, runId)}>
          {name}
        </Link>{" "}
        · <span title={child.cwd}>{child.branch || "detached checkout"}</span>
      </p>
      {child.sessionId && child.state !== "running" && (
        <Restart
          app={child.agent === "codex" ? "Codex" : "Claude"}
          id={child.sessionId}
          host={host}
        />
      )}
    </details>
  );
}
function UpdateCard({
  update,
  host,
}: {
  update: ProgressUpdate;
  host?: RunnerHost;
}) {
  const operations = Object.entries(update.operations)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <article className="update">
      <p className="update-time">
        {time(update.from)}–{time(update.to)}
        {update.disconnected
          ? ` · ${host ? hostName(host) : "its machine"} was not reporting`
          : ""}
      </p>
      {update.done.length ? (
        <ul>
          {update.done.map((item) => (
            <li key={item}>
              <InlineMarkdown text={cleanAgentText(item)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle">No finished steps reported in this window.</p>
      )}
      {update.note?.remaining.length && update.state !== "completed" ? (
        <p className="subtle">
          Still to do then:{" "}
          {update.note.remaining.map(cleanAgentText).join(" · ")}
        </p>
      ) : null}
      {(operations || update.failed > 0) && (
        <p className="subtle">
          Activity: {operations || "none"}
          {update.failed ? ` · ${update.failed} retried or failed` : ""}
        </p>
      )}
    </article>
  );
}
function Activity({ run }: { run: Run }) {
  const events = run.progress?.activity ?? [];
  if (!events.length) return null;
  return (
    <details className="activity">
      <summary>
        Activity log ({events.length}
        {events.length === ACTIVITY_LIMIT ? " latest" : ""})
      </summary>
      <ol>
        {events
          .slice()
          .reverse()
          .map((event) => (
            <li key={event.id}>
              <span>
                {agentName(event.actor)} · {activityLabel(event)}
              </span>
              <Time at={event.at} />
            </li>
          ))}
      </ol>
    </details>
  );
}
function ConversationBrowser({ run }: { run: Run }) {
  const status = useQuery({
    queryKey: ["browser", run.id],
    queryFn: () =>
      api<{
        enabled: boolean;
        state: "idle" | "starting" | "ready" | "closing";
        expiresAt: number | null;
      }>(`/api/runs/${run.id}/browser`),
    ...privateQueryPolicy(5000),
  });
  const view = useMutation({
    mutationFn: (readonly: boolean) =>
      api<{ url: string; expiresAt: number }>(
        `/api/runs/${run.id}/browser/view`,
        { readonly },
      ),
    gcTime: 0,
  });
  const reset = view.reset;
  useEffect(() => {
    if (!view.data) return;
    const timer = setTimeout(
      reset,
      Math.max(0, view.data.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view.data, reset]);
  // The browser only matters while an agent has one open.
  if (
    !status.data?.enabled ||
    !["starting", "ready"].includes(status.data.state)
  )
    return null;
  const ready = status.data.state === "ready";
  return (
    <section className="panel" aria-label="Conversation browser">
      <h3>Browser</h3>
      <p className="subtle">
        {ready
          ? `This conversation has its own browser${status.data.expiresAt ? ` until ${new Date(status.data.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Sign in there if the agent asks, then tell it to continue.`
          : "The browser is starting."}
      </p>
      {ready && (
        <div className="actions">
          <button
            className="btn-quiet"
            type="button"
            disabled={view.isPending}
            onClick={() => {
              reset();
              view.mutate(true);
            }}
          >
            Watch
          </button>
          <button
            className="btn-quiet"
            type="button"
            disabled={view.isPending}
            onClick={() => {
              reset();
              view.mutate(false);
            }}
          >
            Open to sign in
          </button>
        </div>
      )}
      {view.isPending && <p role="status">Preparing your browser link…</p>}
      {view.error && <p role="alert">{view.error.message}</p>}
      {ready && view.data && (
        <p>
          <a href={view.data.url} target="_blank" rel="noreferrer">
            Open live browser
          </a>{" "}
          <span className="subtle">This private link expires in a minute.</span>
        </p>
      )}
    </section>
  );
}
export function ConversationPage({
  id,
  snapshots,
  archives,
  back,
  next,
}: {
  id: string;
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  back: Navigation;
  next?: Navigation;
}) {
  const client = useQueryClient();
  const navigate = useNavigate({ from: "/" });
  const enabled = !!useRuns().data?.pages[0]?.enabled;
  const machines = useQuery(overviewQueryOptions).data?.machines ?? [];
  const names = projectNames(snapshots, archives);
  const workRepo = currentWork(snapshots)?.repo;
  const [reply, setReply] = useState("");
  const images = useScreenshots();
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const detail = useQuery({
    queryKey: ["run", id],
    queryFn: () =>
      api<{
        run: Run;
        runners?: Record<string, number>;
      }>(`/api/runs/${id}`),
    ...privateQueryPolicy(3000),
  });
  const run = detail.data?.run;
  const refresh = async (result: { run: Run }) => {
    client.setQueryData(["run", result.run.id], result);
    await client.invalidateQueries({ queryKey: ["runs"] });
  };
  const follow = useMutation({
    mutationFn: () => {
      const input = {
        text: reply.trim() || "Review the attached screenshots.",
        screenshots: images.images,
      };
      const key = `${id}:${JSON.stringify(input)}`;
      if (attempt.current?.key !== key)
        attempt.current = { key, id: crypto.randomUUID() };
      return api<{ run: Run }>(`/api/runs/${id}/message`, {
        ...input,
        requestId: attempt.current.id,
      });
    },
    onSuccess: async (result) => {
      attempt.current = null;
      setReply("");
      images.clear();
      await refresh(result);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<{ run: Run }>(`/api/runs/${id}/cancel`, {}),
    onSuccess: refresh,
  });
  const move = useMutation({
    mutationFn: () => api<{ run: Run }>(`/api/runs/${id}/move`, {}),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api<{ run: Run }>(`/api/runs/${id}/archive`, { archived }),
    onSuccess: async (result) => {
      await refresh(result);
      // Done on an email queues its Gmail archive; show it in the Inbox now.
      if (result.run.emailThread)
        void client.invalidateQueries({ queryKey: ["overview"] });
      if (result.run.archivedAt)
        void navigate({ to: "/", search: next ?? back });
    },
  });
  if (detail.isPending) return <p className="subtle">Loading conversation…</p>;
  if (!run)
    return (
      <p role="alert" className="error">
        {errorText(detail.error) ?? "This conversation was not found."}
      </p>
    );
  const active = activeRun(run.state);
  const [label, tone] = runStates[run.state];
  const stale =
    ["running", "cancelling"].includes(run.state) &&
    (run.connection === "disconnected" ||
      Date.now() - run.heartbeatAt > RUNNER_STALE_MS);
  // Its sessions are on a machine that is away: the owner can continue it on
  // another one that is present. Conversations from before machines were
  // recorded ran on the first machine.
  const runners = detail.data?.runners;
  const present = (machine: string) =>
    Date.now() - (runners?.[machine] ?? 0) < FALLBACK_AFTER_MS;
  const from =
    run.host ?? (!run.movedFrom && run.progress ? machines[0]?.id : undefined);
  const canMove =
    !!from &&
    !!runners &&
    !present(from) &&
    machines.some((m) => m.id !== from && present(m.id));
  const docs = runDocuments(run);
  const children = run.progress?.children ?? [];
  const updates = run.updates ?? [];
  const error = follow.error ?? cancel.error ?? archive.error;
  const answer = run.state === "blocked" || run.state === "failed";
  // The keyboard shortcut submits too, so the button's rules apply here.
  const canSend =
    (!!reply.trim() || !!images.images.length) &&
    !images.busy &&
    enabled &&
    !follow.isPending &&
    run.state !== "cancelling";
  return (
    <article className="convo">
      <nav className="convo-back">
        <Link to="/" search={back}>
          ← Today
        </Link>
      </nav>
      <header className="convo-head">
        <h2>{runTitle(run)}</h2>
        <div className="convo-meta">
          <span className={`state-chip tone-${tone}`}>{label}</span>
          {runProjectIds(run).map((projectId) => (
            <Link
              key={projectId}
              to="/"
              search={projectSearch(projectId, run.id)}
            >
              {names.get(projectId) ?? projectId}
            </Link>
          ))}
          {run.workIssue &&
            (workRepo ? (
              <a
                href={`https://github.com/${workRepo}/issues/${run.workIssue}`}
                target="_blank"
                rel="noreferrer"
              >
                Work #{run.workIssue}
              </a>
            ) : (
              <span>Work #{run.workIssue}</span>
            ))}
          <span className="subtle">
            <Time at={run.updatedAt} />
          </span>
        </div>
        <div className="convo-actions">
          {active ? (
            <button
              className="btn-quiet"
              onClick={() => cancel.mutate()}
              disabled={run.state === "cancelling" || cancel.isPending}
            >
              {run.state === "cancelling" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              className={run.archivedAt ? "btn-quiet" : "btn"}
              onClick={() => archive.mutate(!run.archivedAt)}
              disabled={archive.isPending}
              title={
                run.archivedAt
                  ? "Bring this conversation back to Today"
                  : "Move to Done. A new message brings it back."
              }
            >
              {archive.isPending
                ? "Saving…"
                : run.archivedAt
                  ? "Reopen"
                  : "Done"}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="error">
          {errorText(error)}
        </p>
      )}
      {stale && (
        <p role="status" className="error">
          {run.host ? hostName(run.host) : "Its machine"} isn’t responding.
          Nothing is lost: it resumes this work when it reconnects.
        </p>
      )}
      {canMove && (
        <div className="notice" role="status">
          <p>
            {active
              ? `${hostName(from!)} is away. Continuing on another machine abandons its current step; that machine starts a new coordinator with this conversation and checks GitHub before redoing anything.`
              : `${hostName(from!)} is away, so a follow-up here would wait for it. Another machine can continue it with a new coordinator and this conversation’s history.`}
          </p>
          <button
            className="btn"
            disabled={move.isPending}
            onClick={() => move.mutate()}
          >
            Continue on another machine
          </button>
          {move.error && (
            <p role="alert" className="error">
              {errorText(move.error)}
            </p>
          )}
        </div>
      )}
      {!!run.archivedAt && active && (
        <p className="subtle">
          Marked Done while still working; it continues on{" "}
          {run.host ? hostName(run.host) : "its machine"}.
        </p>
      )}
      <Thread run={run} />
      {active && <NowPanel run={run} />}
      <form
        className="composer followup"
        onPaste={images.paste}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) follow.mutate();
        }}
      >
        <textarea
          aria-label={active ? "Add feedback" : answer ? "Answer" : "Follow up"}
          required={!images.images.length}
          maxLength={8000}
          rows={2}
          value={reply}
          enterKeyHint="send"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(event) => {
            const form = event.currentTarget.form;
            sendOnEnter(event, () => form?.requestSubmit());
          }}
          disabled={follow.isPending || run.state === "cancelling"}
          placeholder={
            active
              ? "Steer the work: the agent working now gets it within seconds. Use Stop for anything urgent."
              : answer
                ? "Answer or redirect…"
                : run.archivedAt
                  ? "Follow up. Sending reopens this conversation."
                  : "Follow up, e.g. make it shorter…"
          }
        />
        <ScreenshotPreviews draft={images} disabled={follow.isPending} />
        <div className="composer-bar">
          <ScreenshotButtons
            draft={images}
            disabled={follow.isPending || run.state === "cancelling"}
          />
          <span className="composer-submit">
            <button className="btn" type="submit" disabled={!canSend}>
              {follow.isPending
                ? "Sending…"
                : active
                  ? "Send feedback"
                  : "Send"}
            </button>
          </span>
        </div>
      </form>
      {!!docs.length && (
        <section className="panel" aria-label="Documents">
          <h3>Documents</h3>
          <DocumentList docs={docs} />
        </section>
      )}
      <ConversationBrowser key={run.id} run={run} />
      {(!!children.length || !!updates.length || !!run.progress) && (
        <details className="convo-details">
          <summary>Details</summary>
          {!!children.length && (
            <section>
              <h4>Delegated work</h4>
              {children.map((child) => (
                <ChildView
                  key={child.id}
                  child={child}
                  runId={run.id}
                  host={child.host ?? run.movedFrom ?? run.host}
                  name={names.get(child.projectId) ?? child.projectId}
                />
              ))}
            </section>
          )}
          {!!updates.length && (
            <section>
              <h4>Five-minute summaries</h4>
              {updates
                .slice()
                .reverse()
                .map((update) => (
                  <UpdateCard
                    key={update.id}
                    update={update}
                    host={run.host}
                  />
                ))}
            </section>
          )}
          <Activity run={run} />
          <p className="subtle">
            {/* The app that coordinated, which differs from the request when
                that app is not signed in on the machine. */}
            Master:{" "}
            {(run.progress ? run.progress.masterAgent : run.masterAgent) ===
            "claude"
              ? "Claude"
              : "Codex"}
            {run.progress?.masterFallback &&
              `, which took over when ${run.progress.masterFallback.from === "claude" ? "Claude" : "Codex"} ${MASTER_TAKEOVER[run.progress.masterFallback.reason]}`}
          </p>
          {tokenLine(run.progress) && (
            <p
              className="subtle"
              title="New tokens are fresh input and output; the rest is earlier context the apps read again from cache."
            >
              {tokenLine(run.progress)}
            </p>
          )}
          {active && (
            <p className="subtle">
              {run.heartbeatAt ? (
                <>
                  {run.host ? hostName(run.host) : "Its machine"} last checked
                  in <Time at={run.heartbeatAt} />.
                </>
              ) : run.host ? (
                `Waiting for ${hostName(run.host)} to check in.`
              ) : (
                "Waiting for a machine to pick it up."
              )}
            </p>
          )}
          {run.progress?.masterSessionId && !active && (
            <p className="subtle">
              Coordinating session:{" "}
              <Restart
                app={run.progress.masterAgent === "claude" ? "Claude" : "Codex"}
                id={run.progress.masterSessionId}
                host={run.host}
              />
            </p>
          )}
        </details>
      )}
    </article>
  );
}

// Conversations for one project, on its page and in the archive.
export function ProjectConversations({
  snapshots,
  archives,
  projectId,
  archived = false,
}: {
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  projectId?: string;
  archived?: boolean;
}) {
  const query = useRuns(projectId, archived);
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? [];
  const names = projectNames(snapshots, archives);
  return (
    <section
      className="project-conversations"
      aria-label={archived ? "Done conversations" : "Project conversations"}
    >
      <div className="section-actions">
        <h2>{archived ? "Done conversations" : "Conversations"}</h2>
        {!archived && (
          <Link to="/" search={conversationSearch(undefined, projectId)}>
            New conversation
          </Link>
        )}
      </div>
      {query.isPending && <p className="subtle">Loading conversations…</p>}
      {query.error && (
        <p role="alert" className="error">
          {errorText(query.error)}
        </p>
      )}
      {!!runs.length && (
        <div className="rows">
          {runs.map((run) => (
            <ConversationRow
              key={run.id}
              run={run}
              names={names}
              search={conversationSearch(
                run.id,
                projectId,
                archived || undefined,
              )}
            />
          ))}
        </div>
      )}
      {query.data && !runs.length && (
        <p className="subtle">
          {archived
            ? "No Done conversations."
            : "No conversations for this project yet."}
        </p>
      )}
      {query.hasNextPage && (
        <button
          className="btn-quiet"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </section>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "./model";
import { currentWork } from "./work-model";
import type { Agent, Lane, Run, RunInput } from "./run-model";
import { clip } from "./run-text";
import { ScreenshotButtons, ScreenshotPreviews, useScreenshots } from "./screenshots";
import { api } from "./overview-query";
import { isArchived, type ArchiveEntry } from "./archive-model";
import { errorText } from "./conversation-row";
import { useRuns } from "./run-queries";

// Enter sends and Shift+Enter starts a new paragraph. A phone or tablet keyboard
// has no Shift+Return, so on touch Return starts a new line and the Send button
// (or Cmd/Ctrl+Enter on an attached keyboard) sends. Enter that confirms an
// input method's composition (keyCode 229 in Safari) only confirms the text.
export const touchTyping = () =>
  typeof matchMedia === "function" &&
  matchMedia("(hover: none) and (pointer: coarse)").matches;
export function sendOnEnter(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  send: () => void,
  touch = touchTyping(),
) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229 ||
    (touch && !event.metaKey && !event.ctrlKey)
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
  placeholder = "What needs doing?",
  submitLabel = "Start",
  onStarted,
  onCancel,
}: {
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  initialText?: string;
  // Source context shown beside the owner's outcome, with its link appended.
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
  const mayInvestigate = !!current.data?.pages[0]?.investigate &&
    !emailThread && initialLane === "standard" && submitLabel === "Start";
  const [text, setText] = useState(initialText),
    [projectId, setProjectId] = useState(initialProject ?? ""),
    [agent, setAgent] = useState<RunInput["agent"]>("auto"),
    [masterAgent, setMasterAgent] = useState<Agent>(savedMaster),
    [issue, setIssue] = useState(initialIssue ? String(initialIssue) : ""),
    [lane, setLane] = useState<Lane>(initialLane),
    [options, setOptions] = useState(false);
  const investigating = lane === "investigate";
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
          ? [words || "Review the attached screenshots.", context.detail].join("\n\n")
          : words || "Review the attached screenshots.",
        screenshots: images.images,
        projectId: projectId || null,
        agent: investigating ? "claude" : agent,
        ...(investigating || masterAgent === "claude" ? { masterAgent: "claude" } : {}),
        workIssue: issue ? Number(issue) : null,
        ...(emailThread ? { emailThread } : {}),
        ...(lane === "standard" ? {} : { lane }),
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
      setLane(initialLane);
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
    issue ? (issues.find(i => i.number === Number(issue))?.title ?? `Work #${issue}`) : "",
    investigating ? "" : agent === "auto" ? "" : agent === "codex" ? "Codex" : "Claude",
    !investigating && masterAgent === "claude" ? "Claude master" : "",
    investigating ? "Investigate" : lane === "quick" ? "Quick" : "",
  ].filter(Boolean);
  const ready =
    (!!text.trim() || !!images.images.length) &&
    (!investigating || !!projectId) &&
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
        required={!images.images.length}
        maxLength={8000}
        rows={2}
        value={text}
        placeholder={placeholder}
        disabled={create.isPending}
        enterKeyHint={touchTyping() ? "enter" : "send"}
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
          {mayInvestigate && (
            <label>
              Mode
              <select
                value={lane}
                onChange={(e) => setLane(e.target.value as Lane)}
                disabled={create.isPending}
              >
                <option value="standard">Standard</option>
                <option value="investigate">Investigate</option>
                <option value="quick">Quick task</option>
              </select>
            </label>
          )}
          <label>
            Repository
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={create.isPending}
            >
              <option value="">{investigating ? "Choose a repository" : "Let Projects choose"}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {!investigating && <label>
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
          </label>}
          {!investigating && <label>
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
          </label>}
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
          {!mayInvestigate && <label className="composer-check">
            <input
              type="checkbox"
              checked={lane === "quick"}
              onChange={(e) => setLane(e.target.checked ? "quick" : "standard")}
              disabled={create.isPending}
            />
            Quick task: own slots, no repository changes
          </label>}
        </div>
      )}
      {investigating && (
        <p className="subtle">One read-only Claude session uses the selected repository, linked work record and attachments.</p>
      )}
      <div className="composer-bar">
        <ScreenshotButtons draft={images} disabled={create.isPending} />
        <button
          type="button"
          className="options-toggle"
          aria-label="Activity options"
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
            {create.isPending ? "Starting…" : investigating ? "Investigate" : submitLabel}
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

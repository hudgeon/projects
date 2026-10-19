import {
  usageTotal,
  type LiveWatch,
  type WaitLabel,
  type Progress,
  type ProgressNote,
  type Run,
  type RunSummary,
} from "./run-model";

// Presentation of agent-written text, shared by the conversation index (Worker)
// and the page. Agent text is shown as written; only protocol residue meant for
// hooks and the runner is removed, and nothing here invents progress.
const RESIDUE =
  /^[ \t]*(?:work:[ \t]*(?:#\d+|none)|PROJECTS_PROGRESS[ \t]+\{.*\})[ \t]*$/gim;
export function cleanAgentText(text: string) {
  return text
    .replace(RESIDUE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function plainText(markdown: string) {
  return cleanAgentText(markdown)
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}
// The first sentence of the first paragraph: agents are asked to lead with it.
export function headline(markdown: string, max = 140) {
  const block =
    cleanAgentText(markdown)
      .split(/\n\s*\n/)
      .find((part) => plainText(part)) ?? "";
  const text = plainText(block);
  return clip(text.match(/^.{10,}?[.!?](?=\s|$)/)?.[0] ?? text, max);
}
// A short first line is already a title, even with "?" inside an email subject;
// a long dictated one is cut at its first sentence.
export function requestTitle(text: string) {
  const line = plainText(text.split("\n").find((part) => part.trim()) ?? "");
  return (line.length <= 80 ? line : headline(line, 80)) || "New conversation";
}
export function runTitle(run: Pick<Run, "progress" | "messages">) {
  return run.progress?.title || requestTitle(run.messages[0]?.text ?? "");
}
type Plan = Pick<Run, "progress" | "updates" | "generation">;
// The agent's most recent progress note for the current turn, if any.
export function latestPlan(run: Plan): ProgressNote | null {
  const notes = run.progress?.notes ?? [];
  if (notes.length) return notes.reduce((a, b) => (b.at >= a.at ? b : a));
  const update = (run.updates ?? [])
    .filter((u) => u.generation === run.generation && u.note)
    .at(-1);
  return update?.note ?? null;
}
export function doneSoFar(run: Plan) {
  const items = [
    ...(run.updates ?? [])
      .filter((u) => u.generation === run.generation)
      .flatMap((u) => u.done),
    ...(run.progress?.notes ?? []).flatMap((note) => note.done),
  ]
    .map(cleanAgentText)
    .filter(Boolean);
  return [...new Set(items)];
}
export function latestResult(run: Pick<Run, "messages" | "progress">) {
  return (
    run.messages.findLast((message) => message.role === "master")?.text ??
    run.progress?.summary ??
    ""
  );
}
// One plain line for lists: what is happening now, or how the turn ended.
const waits: Record<WaitLabel, string> = {
  review: "Waiting on a review",
  checks: "Waiting on CI checks",
  tests: "Running tests",
  build: "Running a build",
  deploy: "Running a deploy",
  git: "Waiting on Git",
  remote: "Waiting on another machine",
  loop: "In a wait loop",
};
const minutes = (at: number, now: number) =>
  Math.max(1, Math.round((now - at) / 60_000));
// What the runner saw of a step that may be stuck, as a sentence's end.
export function stuckSign(watch: LiveWatch, now = Date.now()) {
  const quiet = minutes(watch.quietSince ?? watch.since, now);
  return watch.stuck === "silent"
    ? `no word from the agent for ${quiet} min`
    : `what it is waiting on has used no CPU for ${quiet} min`;
}
// A long wait, or signs of a stuck one, in plain words with the minutes so far.
export function watchText(watch: LiveWatch, now = Date.now()) {
  if (watch.stuck) return `May be stuck: ${stuckSign(watch, now)}`;
  const doing =
    watch.on === "agent"
      ? "No word from the agent"
      : watch.label
        ? waits[watch.label]
        : watch.on === "command"
          ? "Running a command"
          : "Waiting on a tool call";
  return `${doing} · ${minutes(watch.since, now)} min`;
}
export function statusLine(
  run: Pick<Run, "state" | "generation" | "messages" | "progress" | "updates">,
) {
  switch (run.state) {
    case "queued":
      return run.generation > 1
        ? "Follow-up waiting for a free slot"
        : "Waiting for a free slot";
    case "cancelling":
      return "Stopping…";
    case "cancelled":
      return "Work so far is kept.";
    case "running": {
      const watch = run.progress?.live?.watch;
      if (watch?.stuck) {
        const sign = stuckSign(watch);
        return sign[0].toUpperCase() + sign.slice(1);
      }
      const plan = latestPlan(run);
      const next = plan?.yourMove ?? plan?.remaining[0];
      return next
        ? clip(plainText(next), 140)
        : headline(run.progress?.summary ?? "", 140) || "Starting…";
    }
    default:
      return headline(latestResult(run), 140);
  }
}

export type DocumentLink = {
  url: string;
  label: string;
  detail: string;
  kind: "file" | "pull" | "issue" | "commit" | "email" | "doc";
};
// Collateral links named in agent text or results: GitHub files (pinned commit
// or moving branch, said plainly), PRs, issues, commits, Gmail and Google Docs.
export function describeLink(raw: string, label = ""): DocumentLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const name = clip(plainText(label), 90);
  if (url.hostname === "github.com") {
    const [, repo, type, first, ...rest] = url.pathname
      .split("/")
      .filter(Boolean);
    if (!repo || !first) return null;
    if (type === "blob" || type === "tree") {
      let path: string;
      try {
        path = decodeURIComponent(rest.join("/"));
      } catch {
        return null;
      }
      const pinned = /^[0-9a-f]{40}$/i.test(first);
      return {
        url: raw,
        kind: "file",
        label: name || path.split("/").at(-1) || repo,
        detail: `${repo}/${path} · ${pinned ? `saved ${first.slice(0, 7)}` : `latest on ${first}`}`,
      };
    }
    if ((type === "pull" || type === "issues") && /^\d+$/.test(first))
      return {
        url: raw,
        kind: type === "pull" ? "pull" : "issue",
        label: name || `${type === "pull" ? "PR" : "Issue"} #${first}`,
        detail: `${repo} ${type === "pull" ? "PR" : "issue"} #${first}${url.hash.startsWith("#issuecomment") ? " · comment" : ""}`,
      };
    if (type === "commit" && /^[0-9a-f]{7,40}$/i.test(first))
      return {
        url: raw,
        kind: "commit",
        label: name || `Commit ${first.slice(0, 7)}`,
        detail: `${repo} · ${first.slice(0, 7)}`,
      };
    return null;
  }
  if (url.hostname === "mail.google.com") {
    const account = url.searchParams.get("authuser")?.split("@")[1];
    return {
      url: raw,
      kind: "email",
      label: name || "Gmail conversation",
      detail: account ? `Gmail · ${account}` : "Gmail",
    };
  }
  if (["docs.google.com", "drive.google.com"].includes(url.hostname))
    return {
      url: raw,
      kind: "doc",
      label: name || "Google document",
      detail: "Google Drive",
    };
  return null;
}
const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\((https:\/\/[^\s)]+)\)/g;
const BARE_URL = /https:\/\/[^\s)<>\]"']+/g;
export function documentLinks(
  sources: { text?: string; urls?: string[]; bare?: boolean }[],
): DocumentLink[] {
  const found = new Map<string, DocumentLink>();
  const add = (raw: string, label?: string) => {
    const link = describeLink(raw, label);
    // One entry per document: line anchors of the same edition collapse.
    const key = link && (link.kind === "file" ? raw.split("#")[0] : raw);
    if (link && key && !found.has(key)) found.set(key, link);
  };
  for (const source of sources) {
    for (const match of cleanAgentText(source.text ?? "").matchAll(
      MARKDOWN_LINK,
    ))
      add(match[2], match[1]);
    for (const url of [
      ...(source.urls ?? []),
      ...(source.bare ? (source.text?.match(BARE_URL) ?? []) : []),
    ])
      add(url.replace(/[.,;:]+$/, ""));
  }
  return [...found.values()];
}
// Newest result first, then delegated results, then progress notes and history.
export function runDocuments(run: Pick<Run, "messages" | "progress">) {
  const masters = run.messages
    .filter((message) => message.role === "master")
    .reverse();
  return documentLinks([
    ...masters.slice(0, 1).map((message) => ({ text: message.text })),
    ...(run.progress?.summary ? [{ text: run.progress.summary }] : []),
    ...[...(run.progress?.children ?? [])].reverse().map((child) => ({
      text: child.result?.summary,
      urls: child.result?.links,
    })),
    ...(run.progress?.notes ?? []).map((note) => ({
      text: [...note.done, ...note.remaining].join("\n"),
    })),
    ...masters.slice(1).map((message) => ({ text: message.text })),
    ...run.messages
      .filter((message) => message.role === "user")
      .map((message) => ({ text: message.text, bare: true })),
  ]);
}

// Which of the owner's moves a conversation is in. Stopped work is not news.
function move(run: Pick<RunSummary, "state" | "needsYou" | "stuck">) {
  if (run.needsYou || run.state === "blocked") return "Needs you";
  if (run.stuck) return "May be stuck";
  if (run.state === "failed") return "Failed";
  if (run.state === "completed") return "Ready";
  return null;
}
// A notification when an existing conversation newly becomes the owner's move.
// New conversations, Done and Reopen never notify.
export function notice(previous: RunSummary | null, next: RunSummary) {
  const kind = move(next);
  if (!previous || !kind || next.archivedAt || kind === move(previous))
    return null;
  return {
    title: `${kind}: ${clip(next.title, 80)}`,
    body: clip(next.status ?? "", 140),
  };
}

// A token count the way the details show it: 950, 9.9k, 42k, 1.3M, 2B.
export function formatTokens(n: number) {
  const scaled = (value: number, unit: string) =>
    `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`;
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return scaled(n / 1e3, "k");
  if (n < 999_500_000) return scaled(n / 1e6, "M");
  return scaled(n / 1e9, "B");
}
// What a conversation's coordinator and helpers used, when any app reported
// it; new counts fresh input and output, the rest is earlier context read
// again from cache.
export function tokenLine(progress: Progress | null) {
  if (!progress) return null;
  const master = progress.masterUsage;
  const helpers = progress.children.map((child) => child.usage);
  if (!master && !helpers.some(Boolean)) return null;
  const fresh = [master, ...helpers].reduce(
    (n, usage) => n + (usage ? usage.fresh + usage.output : 0),
    0,
  );
  const coordinator = usageTotal(master),
    helping = helpers.reduce((n, usage) => n + usageTotal(usage), 0);
  return `Tokens: ${formatTokens(coordinator + helping)} (${formatTokens(fresh)} new) · coordinator ${formatTokens(coordinator)} · helpers ${formatTokens(helping)}`;
}

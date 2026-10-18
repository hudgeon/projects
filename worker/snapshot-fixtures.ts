// Collector snapshots shared by the Worker's tests.
import { issue } from "../tests/work-fixtures";
import type { Snapshot } from "../src/model";

export const closeSnapshot = (at = Date.now()) => ({
  version: 1,
  host: "studio",
  collectedAt: at,
  projects: [],
  unassignedSessions: [],
  work: {
    issues: [issue(7), issue(8, { open: false })],
    associations: [],
    associationsState: "ok",
  },
});
export const inboxSnapshot = (at = Date.now()) => ({
  ...closeSnapshot(at),
  inbox: {
    account: "owner@example.com",
    observedAt: at,
    state: "ok",
    threads: [
      { id: "aaaaaaaaaa01", subject: "Weekly news", from: "Weekly <news@news.example.com>", latestMessageId: "aaaaaaaaaa02", updatedAt: at - 60_000, inInbox: true, lastSentByMe: false, unread: true, messages: 1, body: "This week: PRIVATE-BODY-MARKER", unsubscribe: { oneClick: true, url: "https://news.example.com/oneclick/unsubscribe/token", mailto: null } },
      { id: "bbbbbbbbbb01", subject: "Contract", from: "Client", latestMessageId: "bbbbbbbbbb02", updatedAt: at - 60_000, inInbox: true, lastSentByMe: false, unread: false, messages: 3, body: "Please sign.", unsubscribe: null },
    ],
  },
});

export function archiveSnapshot(host: "studio" | "laptop", at = Date.now()): Snapshot {
  const source = {state: "ok" as const, message: "Observed", observedAt: at};
  const session = {id: "shared-session", title: "Review this project", app: "Codex" as const, cwd: "/fixture/project", updatedAt: at, state: "idle" as const, evidence: "Native turn completed"};
  return {version: 1, host, collectedAt: at, unassignedSessions: [], projects: [{
    id: "acme/fixture", name: "Fixture", repo: "acme/fixture", description: "", latestMerge: null,
    progress: {summary: "", next: [], completed: 0, total: 0, source: "", updatedAt: null},
    worktrees: [], pulls: [], sessions: [session, {...session, app: "Claude"}],
    sources: {git: source, github: source, codex: source, claude: source},
  }]};
}

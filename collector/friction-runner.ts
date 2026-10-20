import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
// What Projects knows about a native session it ran: whose conversation and
// which helper it was, and the runner's events and Jev progress judgments for
// it, as counts by category. Read from this machine's private runner state.
export type ProjectsLink = {
  runId: string;
  role: "master" | "helper";
  childId?: string;
  mode?: "read" | "change";
  events: Record<string, number>;
};
export const runnerStateDirectory = (home: string) =>
  path.join(home, ".local/share/project-overview/runner");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const EVENTS_KEPT = 40;
const bump = (events: Record<string, number>, key: string) => {
  if (!(key in events) && Object.keys(events).length >= EVENTS_KEPT) return;
  events[key] = (events[key] ?? 0) + 1;
};
// Links by `${App}:${nativeSessionId}`, from the conversation journals and
// the Jev run-check receipts in the runner state directory.
export async function projectsLinks(stateDir: string): Promise<Map<string, ProjectsLink>> {
  const links = new Map<string, ProjectsLink>();
  const byChild = new Map<string, ProjectsLink>();
  let names: string[] = [];
  try {
    names = await readdir(path.join(stateDir, "runs"));
  } catch {
    return links;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let journal: Record<string, unknown>;
    try {
      journal = object(JSON.parse(await readFile(path.join(stateDir, "runs", name), "utf8")));
    } catch {
      continue;
    }
    const progress = object(journal.progress);
    if (!progress.children) continue;
    const runId = name.slice(0, -5);
    const children = Array.isArray(progress.children) ? progress.children.map(object) : [];
    const masterLink: ProjectsLink = { runId, role: "master", events: {} };
    for (const child of children) {
      if (typeof child.sessionId !== "string" || typeof child.id !== "string") continue;
      const app = child.agent === "claude" ? "Claude" : "Codex";
      const link: ProjectsLink = {
        runId,
        role: "helper",
        childId: child.id,
        ...(child.mode === "read" || child.mode === "change" ? { mode: child.mode } : {}),
        events: {},
      };
      if (typeof child.state === "string") bump(link.events, `result:${child.state}`);
      links.set(`${app}:${child.sessionId}`, link);
      byChild.set(child.id, link);
    }
    for (const entry of Array.isArray(progress.telemetry) ? progress.telemetry.map(object) : []) {
      if (typeof entry.event !== "string") continue;
      const key = `${entry.event}${typeof entry.reason === "string" ? `:${entry.reason}` : ""}`;
      const target =
        typeof entry.childId === "string" ? byChild.get(entry.childId) : entry.actor === "master" ? masterLink : undefined;
      if (target) bump(target.events, key);
    }
    if (typeof progress.masterSessionId === "string") {
      const app = progress.masterAgent === "claude" ? "Claude" : "Codex";
      links.set(`${app}:${progress.masterSessionId}`, masterLink);
    }
  }
  // Progress judgments: how often Jev rated a helper as repeating itself or
  // blocked, at the 0.5 the receipts are labelled against.
  let checks: string[] = [];
  try {
    checks = (await readdir(path.join(stateDir, "run-checks"))).filter((n) => n.includes("-progress-"));
  } catch {
    return links;
  }
  for (const name of checks.slice(-1000)) {
    try {
      const receipt = object(JSON.parse(await readFile(path.join(stateDir, "run-checks", name), "utf8")));
      const link = typeof receipt.child === "string" ? byChild.get(receipt.child) : undefined;
      const judged = object(receipt.judged);
      if (!link) continue;
      bump(link.events, "jev:progress_checks");
      for (const sign of ["repeating", "blocked", "waiting"])
        if (typeof judged[sign] === "number" && judged[sign] >= 0.5) bump(link.events, `jev:${sign}`);
    } catch {
      /* A receipt being written; the next scan reads it. */
    }
  }
  return links;
}

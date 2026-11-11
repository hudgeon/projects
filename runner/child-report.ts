// What the coordinator is told about helpers: a helper's report as its
// summary and pointers (checks, links and what the runner observed), bounded,
// and one line for every helper. The whole record stays in the journal.
import type { Child } from "../src/run-model";
import { clip, headline } from "../src/run-text";

// About 2,000 tokens for one report, however much the helper wrote.
export const REPORT_CHARS = 8_000;
const CHECKS_CHARS = 3_000;
const SUMMARY_FLOOR = 1_500;
const OBSERVED_CHARS = 200;

// A report within the bound keeps every word. A longer one keeps its links
// and observations, shortens its checks evenly, then its summary, and says
// where the whole of it is.
export function childReport(child: Child, journal?: string): Omit<Child, "sessionId" | "usage"> & { shortened?: string } {
  const { sessionId: _session, usage: _usage, ...rest } = child;
  const evidence = child.evidence.map((line) => clip(line, OBSERVED_CHARS));
  if (!child.result) return { ...rest, evidence };
  const { summary, checks, links } = child.result;
  const size = (...parts: unknown[]) => JSON.stringify(parts).length;
  const fits = size(summary, checks, links, evidence) <= REPORT_CHARS;
  const each = fits || checks.join("").length <= CHECKS_CHARS ? Infinity : Math.floor(CHECKS_CHARS / checks.length);
  const kept = checks.map((check) => clip(check, each));
  const room = fits ? Infinity : Math.max(SUMMARY_FLOOR, REPORT_CHARS - size(kept, links, evidence));
  const result = { ...child.result, summary: clip(summary, room), checks: kept };
  const shortened = result.summary !== summary || kept.some((check, i) => check !== checks[i]) || evidence.some((line, i) => line !== child.evidence[i]);
  return {
    ...rest,
    result,
    evidence,
    ...(shortened ? { shortened: journal ? `Shortened here; the whole report is in ${journal}` : "Shortened here; the whole report is in this conversation's journal" } : {}),
  };
}

// id · project · app and mode · state · branch · machine · pull request with
// its checks, or HEAD · the report's first sentence.
export function childLine(child: Child) {
  const observed = (label: string) => child.evidence.find((line) => line.startsWith(label))?.slice(label.length);
  const pull = observed("Observed pull request: "),
    head = observed("Observed HEAD: ");
  return [
    child.id,
    child.projectId,
    `${child.agent} ${child.mode}`,
    child.state,
    child.branch,
    child.host ? `on ${child.host}` : "",
    pull?.startsWith("https://") ? clip(pull, 200) : head ? `HEAD ${head.slice(0, 12)}` : "",
    child.result ? headline(child.result.summary, 160) : "no report",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Helpers whose pull request GitHub reported merged: a boundary a coordinator
// session hands over at once it has not seen it.
export const mergedChildren = (children: Child[]) =>
  children
    .filter((child) => child.evidence.some((line) => /^Observed pull request: https:\/\/\S+ · merged\b/.test(line)))
    .map((child) => child.id);

// Every helper's line, and reports for the newest few or for those named.
export function childContext(children: Child[], reports: number | Child[] = 0, journal?: string) {
  if (!children.length) return "none";
  const full = typeof reports === "number" ? (reports ? children.slice(-reports) : []) : reports;
  return JSON.stringify({
    // Every execution survives selection, with where its evidence is.
    index: children.map(childLine),
    [typeof reports === "number" ? "latest" : "retained"]: full.map((child) => childReport(child, journal)),
  });
}

// Conversation-level observations from canonical history and native usage.
// Follow-ups include approvals and new requests; they are not labelled errors.
import type { Run } from "./run-model";
export function runMeasures(run: Run) {
  const requests = run.messages.filter((m) => m.role === "user");
  const replies = run.messages.filter((m) => m.role === "master");
  const latestRequest = requests.at(-1), latestReply = replies.at(-1);
  const usage = [run.progress?.masterUsage, ...(run.progress?.children.map((c) => c.usage) ?? [])];
  const sum = (key: "fresh" | "cached" | "output" | "turns") => usage.reduce((n, u) => n + (u?.[key] ?? 0), 0);
  return {
    firstReplyMs: replies[0] && requests[0] ? Math.max(0, replies[0].at - requests[0].at) : null,
    latestReplyMs: latestReply && latestRequest && latestReply.at >= latestRequest.at ? Math.max(0, latestReply.at - latestRequest.at) : null,
    followUps: Math.max(0, requests.length - 1),
    helpers: run.progress?.children.length ?? 0,
    turns: sum("turns"),
    freshTokens: sum("fresh"), cachedTokens: sum("cached"), outputTokens: sum("output"),
    // Absence of usage is unknown, never a claim of zero consumption.
    usageObserved: usage.some(Boolean),
  };
}
export type RunMeasures = ReturnType<typeof runMeasures>;

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, privateQueryPolicy } from "./overview-query";
import { conversationSearch } from "./navigation";
import { activeRun, type RunSummary } from "./run-model";
import { runStates } from "./conversation-row";
import { ago } from "./model";

import { upkeepOutcomeLabel, upkeepScheduleProblem, type UpkeepScheduleReceipt } from "./upkeep-model";
type UpkeepView = { latest: RunSummary | null; schedule: string; scheduled: UpkeepScheduleReceipt | null; scheduledRun: Pick<RunSummary, "id" | "state" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt"> | null };
// Settings' Upkeep panel: when the weekly cycle runs, how the latest one
// stands, and Run upkeep now (docs/upkeep.md).
export function UpkeepPanel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["upkeep"],
    queryFn: () => api<UpkeepView>("/api/upkeep"),
    ...privateQueryPolicy(30000),
  });
  const start = useMutation({
    mutationFn: () => api<UpkeepView>("/api/upkeep", {}),
    onSuccess: async (value) => {
      client.setQueryData(["upkeep"], value);
      await client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const latest = query.data?.latest ?? null;
  const active = !!latest && activeRun(latest.state);
  const error = start.error || query.error;
  return (
    <section className="execution-settings" aria-label="Upkeep">
      <h2 className="section">Upkeep</h2>
      <p>
        Once a week ({query.data?.schedule ?? "weekly"}) an upkeep conversation
        reads the friction receipts and installed Claude Code and Codex versions
        on your machines and makes at most one guarded change to the agent
        setup. It stays quiet unless it needs a decision.
      </p>
      {query.data && <p className={upkeepScheduleProblem(query.data.scheduled, Date.now()) ? "error" : "subtle"} role="status">
        {upkeepScheduleProblem(query.data.scheduled, Date.now())}
        {query.data.scheduled && <> Scheduled check: {new Date(query.data.scheduled.scheduledAt).toLocaleString()} · {upkeepOutcomeLabel(query.data.scheduled.outcome)}
          {query.data.scheduledRun && <> · <Link to="/" search={conversationSearch(query.data.scheduledRun.id)}>Cycle {query.data.scheduledRun.state}</Link>
            {query.data.scheduledRun.startedAt && ` · started ${new Date(query.data.scheduledRun.startedAt).toLocaleString()}`}
            {!activeRun(query.data.scheduledRun.state) && query.data.scheduledRun.finishedAt && ` · finished ${new Date(query.data.scheduledRun.finishedAt).toLocaleString()}`}
          </>}
        </>}
      </p>}
      {latest && (
        <p>
          Latest:{" "}
          <Link to="/" search={conversationSearch(latest.id)}>
            {latest.title}
          </Link>{" "}
          · {runStates[latest.needsYou ? "blocked" : latest.state][0]} ·{" "}
          {ago(latest.updatedAt)}
          {latest.status ? ` · ${latest.status}` : ""}
        </p>
      )}
      {query.data && !latest && (
        <p className="subtle">No upkeep conversation has run yet.</p>
      )}
      <button
        className="btn"
        disabled={!query.data || active || start.isPending}
        onClick={() => start.mutate()}
      >
        {active ? "Upkeep is running" : start.isPending ? "Starting…" : "Run upkeep now"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error.message === "SIGN_IN" ? "Sign in again to run upkeep." : error.message}
        </p>
      )}
    </section>
  );
}

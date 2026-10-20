import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, privateQueryPolicy } from "./overview-query";
import { conversationSearch } from "./navigation";
import { activeRun, type RunSummary } from "./run-model";
import { runStates } from "./conversation-row";
import { ago } from "./model";

type UpkeepView = { latest: RunSummary | null; schedule: string };
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

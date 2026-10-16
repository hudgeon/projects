import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, privateQueryPolicy } from "./overview-query";
import type { ExecutionSettings, ExecutionSettingsView } from "./codex-metrics";

const duration = (ms: number | null) =>
  ms === null
    ? "—"
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${(ms / 60000).toFixed(1)}m`;
export function ExecutionSettingsPanel() {
  const client = useQueryClient();
  const [shown, setShown] = useState(10);
  const query = useQuery({
    queryKey: ["execution-settings"],
    queryFn: () => api<ExecutionSettingsView>("/api/execution-settings"),
    ...privateQueryPolicy(30000),
  });
  const save = useMutation({
    mutationFn: (settings: ExecutionSettings) =>
      api<ExecutionSettingsView>("/api/execution-settings", settings),
    onMutate: () => client.cancelQueries({ queryKey: ["execution-settings"] }),
    onSuccess: (value) => {
      client.setQueryData(["execution-settings"], value);
    },
  });
  const data = query.data,
    metrics = data?.metrics;
  return (
    <section className="execution-settings" aria-label="Codex speed">
      <h2 className="section">Codex speed</h2>
      <label className="fast-mode-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={data?.codexFast ?? false}
          disabled={!data || query.isError || save.isPending}
          onChange={(e) => save.mutate({ codexFast: e.target.checked })}
          aria-describedby="fast-mode-help"
        />
        <strong>Codex fast mode</strong>
        <span>{data ? (data.codexFast ? "On" : "Off") : "Loading…"}</span>
      </label>
      <p id="fast-mode-help">
        Applies to every Codex coordinator and helper in Projects, across
        machines, from its next turn. Uses more of your allowance; model and
        reasoning stay the same.{" "}
        <a
          href="https://learn.chatgpt.com/docs/agent-configuration/speed"
          target="_blank"
          rel="noreferrer"
        >
          Usage details
        </a>
      </p>
      <p role="status" className="subtle">
        {save.isPending ? "Saving…" : save.isSuccess ? "Saved." : ""}
      </p>
      {(save.error || query.error) && (
        <p role="alert" className="error">
          {(save.error || query.error)?.message === "SIGN_IN"
            ? "Sign in again to view or change Codex speed."
            : "Could not load or save Codex speed. The last shown setting may be out of date."}{" "}
          <button className="btn" onClick={() => void query.refetch()}>
            Refresh
          </button>
        </p>
      )}
      <h3>Is fast mode helping?</h3>
      <p className="subtle">
        Last 30 days, up to 10,000 recorded turns. Comparisons use the requested
        mode and matching model, reasoning, role, machine, fresh/continued
        context, token ranges and cache share. Elapsed time includes tools and
        setup; this is an observation, not a controlled benchmark. Earlier
        unlabelled turns are excluded.
      </p>
      {metrics && (
        <>
          <p>
            {metrics.standard} standard · {metrics.fast} fast · {metrics.failed}{" "}
            failed or interrupted · {metrics.excluded} completed turns excluded
            for retries or missing measurements
          </p>
          {!metrics.cohorts.length && (
            <p>
              No comparable timings yet. New Codex turns will appear here as
              they finish.
            </p>
          )}
          {metrics.cohorts.slice(0, shown).map((c) => (
            <article className="speed-cohort" key={c.label}>
              <p className="subtle">{c.label}</p>
              <div className="speed-pair">
                <div>
                  <strong>Standard</strong>
                  <p>
                    {duration(c.standard.medianMs)} median · {c.standard.count}{" "}
                    turns
                  </p>
                </div>
                <div>
                  <strong>Fast</strong>
                  <p>
                    {duration(c.fast.medianMs)} median · {c.fast.count} turns
                  </p>
                </div>
              </div>
              <p>
                {c.fasterPercent === null
                  ? "Collecting: at least 3 completed turns in each mode are needed for a comparison."
                  : c.fasterPercent === 0
                    ? "The median elapsed times are equal."
                    : `Fast turns had ${Math.abs(c.fasterPercent).toFixed(1)}% ${c.fasterPercent > 0 ? "shorter" : "longer"} median elapsed time in this group.`}
              </p>
              <details>
                <summary>Time to first output</summary>
                <p>
                  From the turn request to its first text chunk; may include
                  reasoning or tool waits. Standard:{" "}
                  {duration(c.standard.firstOutputMs)} (
                  {c.standard.firstOutputCount} measured). Fast:{" "}
                  {duration(c.fast.firstOutputMs)} ({c.fast.firstOutputCount}{" "}
                  measured). The provider may serve a different tier; actual
                  processing tier is not reported here.
                </p>
              </details>
            </article>
          ))}
          {metrics.cohorts.length > shown && (
            <button className="btn" onClick={() => setShown(shown + 10)}>
              Show more groups ({metrics.cohorts.length - shown})
            </button>
          )}
        </>
      )}
    </section>
  );
}

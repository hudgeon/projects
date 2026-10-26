import { workReviewScheduleProblem } from "./work-review-model";
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, privateQueryPolicy } from "./overview-query";
import { conversationSearch } from "./navigation";
import { activeRun, type RunSummary } from "./run-model";
import type { UpkeepScheduleReceipt } from "./upkeep-model";
type View = {
  timeZone: string;
  latest: RunSummary | null;
  schedule: string;
  scheduled: UpkeepScheduleReceipt | null;
};
export function WorkReviewPanel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["work-review"],
    queryFn: () => api<View>("/api/work-review"),
    ...privateQueryPolicy(30000),
  });
  const start = useMutation({
    mutationFn: () => api<View>("/api/work-review", {}),
    onSuccess: async (value) => {
      client.setQueryData(["work-review"], value);
      await client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const latest = query.data?.latest;
  const scheduled = query.data?.scheduled;
  const problem = query.data
    ? workReviewScheduleProblem(
        scheduled ?? null,
        Date.now(),
        query.data.timeZone,
      )
    : null;
  return (
    <section className="execution-settings" aria-label="Work reconciliation">
      <h2 className="section">Work reconciliation</h2>
      <p>
        {query.data?.schedule ??
          "Daily at 07:00 in this deployment's time zone"}
        . Reviews changed work against mail, delivery evidence and commitments,
        and corrects existing records. It stays quiet when nothing needs
        attention.
      </p>
      {problem && (
        <p className="error" role="status">
          {problem}
        </p>
      )}
      <p>
        {scheduled
          ? `Last scheduled check: ${new Date(scheduled.scheduledAt).toLocaleString()} · ${scheduled.outcome}`
          : "No scheduled receipt yet."}
      </p>
      {latest && (
        <p>
          <Link to="/" search={conversationSearch(latest.id)}>
            Latest review
          </Link>{" "}
          · {latest.state}
          {latest.finishedAt &&
            ` · finished ${new Date(latest.finishedAt).toLocaleString()}`}
        </p>
      )}
      <button
        className="btn"
        disabled={
          !query.data ||
          start.isPending ||
          (!!latest && activeRun(latest.state))
        }
        onClick={() => start.mutate()}
      >
        Review work now
      </button>
      {(query.error || start.error) && (
        <p role="alert">{(query.error || start.error)?.message}</p>
      )}
    </section>
  );
}

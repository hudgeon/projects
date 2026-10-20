// The upkeep lane (docs/upkeep.md): the Worker's weekly cron, or Run upkeep
// now in Settings, starts one conversation for the deployment owner in the
// `upkeep` lane, linked to the standing upkeep work issue when the work items
// show one (an open issue labelled `upkeep`). Its brief comes from the runner.
import { telemetry } from "../src/telemetry";
import { currentWork } from "../src/work-model";
import { UPKEEP_CRON, upkeepRequestId, upkeepText, upkeepWeek, type UpkeepStart } from "../src/upkeep-model";
import { deploymentOwner } from "./auth";
import type { Portfolio } from "./index";

export type UpkeepStore = Pick<
  DurableObjectStub<Portfolio>,
  "runnable" | "overview" | "createRun" | "getRun" | "latestRun"
>;
export type UpkeepOutcome =
  | { id: string; started: "started" | "exists" | "active" }
  | { skipped: "no_owner" | "no_machine" | "no_snapshot" };
// Starts a cycle, or finds the one this id already started or the one still
// active. The cron asks with the week's id; Settings asks with a fresh one.
export async function startUpkeep(
  store: UpkeepStore,
  env: Env,
  requestId: string,
  started: UpkeepStart,
  requester?: string,
): Promise<UpkeepOutcome> {
  // The deployment owner's, which Deploy guarantees is set; only the local
  // emulator's placeholder caller stands in for a missing one, so a signed-in
  // address never becomes the owner of upkeep by fallback.
  const owner = deploymentOwner(env) || (requester === "local" ? requester : "");
  if (!owner) return { skipped: "no_owner" };
  if (await store.getRun(requestId)) return { id: requestId, started: "exists" };
  const active = await store.latestRun("upkeep", true);
  if (active) return { id: active.id, started: "active" };
  if (!(await store.runnable())) return { skipped: "no_machine" };
  const snapshots = await store.overview();
  if (!snapshots.length) return { skipped: "no_snapshot" };
  const standing = currentWork(snapshots)?.issues.find((issue) => issue.open && issue.upkeep);
  const run = await store.createRun(
    {
      requestId,
      text: upkeepText(started),
      projectId: null,
      agent: "auto",
      workIssue: standing?.number ?? null,
      lane: "upkeep",
    },
    owner,
  );
  return { id: run.id, started: "started" };
}
// The Worker's weekly trigger: one cycle per ISO week, whenever in the week
// it fires. A cron this Worker does not know starts nothing.
export async function scheduledUpkeep(env: Env, at: number, cron?: string) {
  if (cron && cron !== UPKEEP_CRON) return;
  const store = env.PORTFOLIOS.getByName(env.PORTFOLIO_ID);
  const requestId = await upkeepRequestId(env.PORTFOLIO_ID, upkeepWeek(at));
  const outcome = await startUpkeep(store, env, requestId, "schedule");
  telemetry(
    "worker",
    "upkeep_cycle",
    "skipped" in outcome ? { upkeep: outcome.skipped } : { upkeep: outcome.started, runId: outcome.id },
  );
}

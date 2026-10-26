import { currentWork } from "../src/work-model";
import {
  WORK_REVIEW_CRON,
  WORK_REVIEW_HOUR,
  workReviewDay,
  workReviewText,
} from "../src/work-review-model";
import {
  upkeepRequestId,
  type UpkeepScheduleReceipt,
} from "../src/upkeep-model";
import { deploymentOwner } from "./auth";
import type { UpkeepStore, UpkeepOutcome } from "./upkeep";
import type { Portfolio } from "./index";
export type WorkReviewStore = UpkeepStore &
  Pick<DurableObjectStub<Portfolio>, "upkeepSchedule" | "saveUpkeepSchedule">;
export async function startWorkReview(
  store: WorkReviewStore,
  env: Env,
  requestId: string,
): Promise<UpkeepOutcome> {
  const owner = deploymentOwner(env);
  if (!owner) return { skipped: "no_owner" };
  if (await store.getRun(requestId))
    return { id: requestId, started: "exists" };
  const active = await store.latestRun("review", true);
  if (active) return { id: active.id, started: "active" };
  if (!(await store.runnable())) return { skipped: "no_machine" };
  const work = currentWork(await store.overview());
  if (!work) return { skipped: "no_snapshot" };
  const run = await store.createRun(
    {
      requestId,
      text: workReviewText,
      projectId: null,
      agent: "auto",
      workIssue: null,
      lane: "review",
    },
    owner,
  );
  return { id: run.id, started: "started" };
}
export async function scheduledWorkReview(env: Env, at: number, cron: string) {
  if (cron !== WORK_REVIEW_CRON) return;
  const { day, hour } = workReviewDay(at, env.TIME_ZONE || "UTC");
  if (hour < WORK_REVIEW_HOUR) return;
  const store = env.PORTFOLIOS.getByName(env.PORTFOLIO_ID);
  const requestId = await upkeepRequestId(
    env.PORTFOLIO_ID,
    `work-review:${day}`,
  );
  const receipt: UpkeepScheduleReceipt = {
    kind: "work-review",
    scheduledAt: at,
    observedAt: Date.now(),
    outcome: "checking",
  };
  await store.saveUpkeepSchedule(receipt);
  try {
    const outcome = await startWorkReview(store, env, requestId);
    await store.saveUpkeepSchedule({
      ...receipt,
      observedAt: Date.now(),
      outcome: "skipped" in outcome ? outcome.skipped : outcome.started,
      ...("id" in outcome ? { runId: outcome.id } : {}),
    });
  } catch (error) {
    await store.saveUpkeepSchedule({
      ...receipt,
      observedAt: Date.now(),
      outcome: "failed",
    });
    throw error;
  }
}

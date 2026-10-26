import { scheduledUpkeep } from "./upkeep";
import { scheduledWorkReview } from "./work-review";
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  controller,
  env,
) => {
  await scheduledUpkeep(env, controller.scheduledTime, controller.cron);
  await scheduledWorkReview(env, controller.scheduledTime, controller.cron);
};

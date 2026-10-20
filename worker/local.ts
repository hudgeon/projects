// Local emulator only. Production's entrypoint never imports this file.
import { documentPath, handle, runnerRoutes, secure } from "./index";
import { authorize, deploymentOwner } from "./auth";
import { scheduledUpkeep } from "./upkeep";
export { Portfolio, Conversation } from "./index";
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const response = await handle(
      request,
      env,
      !["127.0.0.1", "localhost"].includes(url.hostname)
        ? null
        : runnerRoutes.has(url.pathname)
          ? await authorize(request, env, false, true)
          // The local person: OWNER_EMAIL when the local config sets it, so a
          // collector's inbox for that address shows here.
          : deploymentOwner(env) || "local",
    );
    // A document keeps production's isolation here too.
    return documentPath.test(url.pathname) ? secure(response, true) : response;
  },
  // wrangler dev's /cdn-cgi/local/scheduled runs the weekly upkeep trigger here.
  async scheduled(controller: ScheduledController, env: Env) {
    await scheduledUpkeep(env, controller.scheduledTime, controller.cron);
  },
} satisfies ExportedHandler<Env>;

// Local emulator only. Production's entrypoint never imports this file.
import { documentPath, handle, runnerRoutes, secure } from "./index";
import { authorize } from "./auth";
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
          : "local",
    );
    // A document keeps production's isolation here too.
    return documentPath.test(url.pathname) ? secure(response, true) : response;
  },
} satisfies ExportedHandler<Env>;

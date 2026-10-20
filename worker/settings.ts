// Settings' routes: Codex speed, shared with every runner, and the upkeep
// lane's Run upkeep now. Only a signed-in person reaches these; a
// conversation browser's sign-in may read them (worker/auth.ts).
import { executionSettingsSchema } from "../src/codex-metrics";
import { UPKEEP_SCHEDULE } from "../src/upkeep-model";
import { readJson } from "./auth";
import { trace } from "./telemetry";
import { startUpkeep, type UpkeepStore } from "./upkeep";
import type { Portfolio } from "./index";

type SettingsStore = UpkeepStore &
  Pick<DurableObjectStub<Portfolio>, "executionSettingsView" | "setExecutionSettings" | "rate">;
export async function settingsRoutes(
  request: Request,
  store: SettingsStore,
  env: Env,
  caller: string,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/execution-settings") {
    if (request.method === "GET") return Response.json(await store.executionSettingsView());
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let input;
    try {
      input = executionSettingsSchema.parse(await readJson(request, 1024));
    } catch {
      return Response.json({ error: "Invalid execution settings" }, { status: 400 });
    }
    await store.setExecutionSettings(input);
    return Response.json(await store.executionSettingsView());
  }
  if (pathname !== "/api/upkeep") return null;
  const view = async () => ({ latest: await store.latestRun("upkeep"), schedule: UPKEEP_SCHEDULE });
  if (request.method === "GET") return Response.json(await view());
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await store.rate(`upkeep:${caller}`, 10, 3600_000)))
    return Response.json({ error: "Try again later." }, { status: 429 });
  // The cycle is the deployment owner's whoever asks for it; a fresh id, so
  // it is a cycle of its own beside the week's scheduled one.
  const outcome = await trace("upkeep.start", {}, () =>
    startUpkeep(store, env, crypto.randomUUID(), "settings", caller),
  );
  if ("skipped" in outcome)
    return Response.json(
      {
        error:
          outcome.skipped === "no_machine"
            ? "Connect a machine before running upkeep."
            : outcome.skipped === "no_snapshot"
              ? "Refresh the project inventory before running upkeep."
              : "This deployment has no owner to run upkeep for.",
      },
      { status: outcome.skipped === "no_snapshot" ? 409 : 503 },
    );
  return Response.json({ ...(await view()), started: outcome.started });
}

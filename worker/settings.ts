import { deploymentOwner } from "./auth";
import { startWorkReview, type WorkReviewStore } from "./work-review";
// Settings' routes: the upkeep lane's Run upkeep now. Only a signed-in
// person reaches it; a conversation browser's sign-in may read it
// (worker/auth.ts).
import { UPKEEP_SCHEDULE } from "../src/upkeep-model";
import { trace } from "./telemetry";
import { startUpkeep, type UpkeepStore } from "./upkeep";
import type { Portfolio } from "./index";

type SettingsStore = WorkReviewStore & Pick<DurableObjectStub<Portfolio>, "rate" | "upkeepSchedule">;
export async function settingsRoutes(
  request: Request,
  store: SettingsStore,
  env: Env,
  caller: string,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!["/api/upkeep", "/api/work-review"].includes(pathname)) return null;
  const review = pathname === "/api/work-review";
  if (review && caller !== deploymentOwner(env) && caller !== "local") return new Response("Forbidden", {status: 403});
  const lane = review ? "review" : "upkeep";
  const view = async () => {
    const scheduled = await store.upkeepSchedule(review ? "work-review" : undefined);
    const run = scheduled?.runId ? await store.getRun(scheduled.runId) : null;
    return { timeZone: env.TIME_ZONE || "UTC", latest: await store.latestRun(lane), schedule: review ? `Daily at 07:00 (${env.TIME_ZONE || "UTC"})` : UPKEEP_SCHEDULE, scheduled,
      scheduledRun: run ? { id: run.id, state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: run.startedAt, finishedAt: run.finishedAt } : null };
  };
  if (request.method === "GET") return Response.json(await view());
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await store.rate(`${lane}:${caller}`, 10, 3600_000)))
    return Response.json({ error: "Try again later." }, { status: 429 });
  // The cycle is the deployment owner's whoever asks for it; a fresh id, so
  // it is a cycle of its own beside the week's scheduled one.
  const outcome = await trace("upkeep.start", {}, () =>
    review ? startWorkReview(store, env, crypto.randomUUID()) : startUpkeep(store, env, crypto.randomUUID(), "settings", caller),
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

import { MESSAGE_REQUEST_BYTES } from "../src/screenshot-model";
import { runListSchema, startInputSchema, type Run } from "../src/run-model";
import { currentWork } from "../src/work-model";
import { deploymentOwner, readJson } from "./auth";
import { runtimeStatus } from "./runtime-status";
import { attributes, trace } from "./telemetry";
import type { Portfolio } from "./index";

export const updatingScreenshots = () => Response.json({error: "Projects is finishing an update. Your screenshot is still in the draft; try sending it again shortly."}, {status: 503});
export const runVisible = (run: Run, caller: string, browser: boolean) =>
  (!browser || !run.emailThread) && (run.lane !== "investigate" || (!browser && run.owner === caller));

export async function runCollection(
  request: Request,
  env: Env,
  store: DurableObjectStub<Portfolio>,
  caller: string,
  browser: boolean,
) {
  const url = new URL(request.url);
  const investigate = !browser && caller === (deploymentOwner(env) || "local");
  if (request.method === "GET") {
    const options = runListSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!options.success) return Response.json({error: "Invalid conversation filter"}, {status: 400});
    const listed = await trace("conversation.list", {}, () => store.listRuns({
      ...options.data, investigationOwner: investigate ? caller : null,
    }));
    const runs = browser ? (options.data.email ? [] : listed.filter((run) => !run.emailThread)) : listed;
    return Response.json({
      runs,
      nextOffset: listed.length === 50 && !options.data.email ? options.data.offset + 50 : null,
      enabled: await store.runnable(),
      investigate,
      runners: await store.runners(),
    });
  }
  if (request.method === "POST") {
    if (!(await store.runnable()))
      return Response.json(
        { error: "Connect a machine before starting conversations." },
        { status: 503 },
      );
    let input;
    try {
      input = startInputSchema.parse(await readJson(request, MESSAGE_REQUEST_BYTES));
    } catch {
      return Response.json({ error: "Invalid conversation" }, { status: 400 });
    }
    // A browser's own sign-in starts no conversation from an email and reads
    // none back through a retry.
    if (browser && input.emailThread)
      return Response.json({ error: "Sign in with your email code to work on email." }, { status: 403 });
    if (input.lane === "investigate" && !investigate)
      return Response.json({ error: "Investigate is available to the signed-in owner." }, { status: 403 });
    const previous = await trace("conversation.read", { runId: input.requestId }, () => store.getRun(input.requestId));
    attributes({ runId: input.requestId });
    if (previous)
      return !runVisible(previous, caller, browser)
        ? Response.json({ error: "Invalid conversation" }, { status: 409 })
        : Response.json({ run: previous });
    if (input.screenshots?.length && !(await runtimeStatus(store, env, input.requestId)).ready)
      return updatingScreenshots();
    // Quick work has its own hourly bound, sized for working through email.
    if (!(await store.rate(input.lane === "quick" ? `quick-runs:${caller}` : `runs:${caller}`, input.lane === "quick" ? 60 : 30, 3600_000)))
      return new Response("Try again later", { status: 429 });
    const snapshots = await store.overview();
    if (!snapshots.length)
      return Response.json(
        { error: "Refresh the project inventory before starting work." },
        { status: 409 },
      );
    if (input.projectId && !snapshots.some((s) => s.projects.some((p) => p.id === input.projectId)))
      return Response.json(
        { error: "Project is not registered on any connected machine." },
        { status: 400 },
      );
    if (
      input.workIssue &&
      !currentWork(snapshots)?.issues.some((i) => i.number === input.workIssue)
    )
      return Response.json({ error: "Unknown work issue." }, { status: 400 });
    try {
      const run = await trace("conversation.create", { runId: input.requestId }, () => store.createRun(input, caller));
      // Another sign-in may have saved this request ID since the check above.
      return !runVisible(run, caller, browser)
        ? Response.json({ error: "Invalid conversation" }, { status: 409 })
        : Response.json({ run });
    } catch {
      return Response.json(
        { error: "Conversation could not be saved. Check the screenshots or active conversation limit." },
        { status: 409 },
      );
    }
  }
  return new Response("Method not allowed", {status: 405});
}

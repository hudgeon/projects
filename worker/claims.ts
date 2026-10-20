// What a runner is handed when it claims: the conversation, whose it is, how
// that machine's conversation browser signs in, the repositories' activity,
// the execution settings and a document waiting to be read.
import { allowed, signsIn } from "./auth";
import { attributes, trace } from "./telemetry";
import type { BrowserSignIn, Lane, RunnerHost } from "../src/run-model";
import type { Portfolio } from "./index";

type ClaimStore = Pick<
  DurableObjectStub<Portfolio>,
  "claimRun" | "personNamed" | "overview" | "leaseDocument" | "executionSettings"
>;
export async function claimed(
  store: ClaimStore,
  env: Env,
  owner: string,
  input: { activeRunIds: string[]; lanes?: Lane[]; documents?: boolean },
  host: RunnerHost,
) {
  const run = await trace("dispatch", {}, async () => {
    const claimed = await store.claimRun(owner, input.activeRunIds, input.lanes, host);
    if (claimed) attributes({ runId: claimed.id, generation: claimed.generation });
    return claimed;
  });
  if (run) attributes({ runId: run.id, generation: run.generation });
  // The person whose conversation it is, by their profile; the claim already
  // names the deployment owner for a conversation from before profiles. The
  // local emulator records no owner at all.
  const person = run?.owner ? await store.personNamed(run.owner) : null;
  // A listed machine signs each browser in as that person, while their
  // address is allowed to sign in; otherwise the browser is told so.
  const browserSignIn: BrowserSignIn = !signsIn(env, host)
    ? "manual"
    : person && allowed(person.email, env)
      ? "owner"
      : "not_allowed";
  const activity = run
    ? (await store.overview()).map((s) => ({
        host: s.host,
        observedAt: s.collectedAt,
        // Daily friction totals and harness versions, for the upkeep lane.
        ...(s.friction ? { friction: s.friction } : {}),
        unassignedSessions: s.unassignedSessions,
        projects: s.projects.map((p) => ({
          id: p.id,
          sessions: p.sessions,
          worktrees: p.worktrees,
          pulls: p.pulls,
          sources: p.sources,
        })),
      }))
    : [];
  // A runner that can fetch documents takes the oldest one waiting.
  const document = input.documents ? await store.leaseDocument(owner) : null;
  return {
    run,
    ...(run ? { person, browserSignIn } : {}),
    activity,
    settings: await store.executionSettings(),
    ...(document ? { document } : {}),
  };
}

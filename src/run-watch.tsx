import { ago } from "./model";
import type { Run } from "./run-model";
import { watchText } from "./run-text";

export function Time({ at }: { at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {ago(at, Date.now())}
    </time>
  );
}
export const agentName = (actor: "master" | "codex" | "claude") =>
  actor === "master" ? "Projects" : actor === "codex" ? "Codex" : "Claude";
// A running turn's status: signs it may be stuck first, then a long wait,
// whose plan is shown, its last activity, its last save and the next summary.
export function NowStatus({
  run,
  plan,
}: {
  run: Run;
  plan?: { actor: "master" | "codex" | "claude"; at: number } | null;
}) {
  const live = run.progress?.live,
    watch = live?.watch;
  const last = run.progress?.activity?.at(-1)?.at;
  const due = run.nextUpdateAt;
  return (
    <>
      {watch?.stuck && (
        <p className="now-blocker" role="status">
          {watchText(watch)}. Nothing has been stopped; Stop ends it, or a
          message reaches it at its next step.
        </p>
      )}
      <p className="subtle">
        {watch && !watch.stuck ? <>{watchText(watch)} · </> : null}
        {plan ? (
          <>
            {agentName(plan.actor)}’s plan · <Time at={plan.at} />
          </>
        ) : (
          "No plan reported yet"
        )}
        {last ? (
          <>
            {" "}
            · last activity <Time at={last} />
          </>
        ) : null}
        {live?.savedAt ? (
          <>
            {" "}
            · saved to GitHub <Time at={live.savedAt} />
          </>
        ) : null}
        {due
          ? ` · next summary in ${Math.max(1, Math.ceil((due - Date.now()) / 60_000))} min`
          : ""}
      </p>
    </>
  );
}

import { ago } from "./model";
import type { Run } from "./run-model";
import { runMeasures } from "./run-measures";
import { tokenLine, watchText } from "./run-text";

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

// Times are wall-clock request-to-reply observations, not agent runtime or acceptance.
export function RunMeasures({ run }: { run: Run }) {
  const m = runMeasures(run);
  const duration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} sec` : `${Math.round(ms / 60_000)} min`;
  return <section aria-label="Conversation measures">
    <h4>Conversation measures</h4>
    <p className="subtle">
      First reply: {m.firstReplyMs === null ? "not yet recorded" : duration(m.firstReplyMs)}
      {m.latestReplyMs !== null && ` · latest request to reply: ${duration(m.latestReplyMs)}`}
      {` · ${m.followUps} follow-up messages · ${m.helpers} helpers`}
      {m.usageObserved && ` · ${m.turns} native turns with usage recorded`}
    </p>
    <p className="subtle">Follow-ups include approvals and new requests. A reply may report a blocker; these measures do not prove delivery or acceptance.</p>
    {tokenLine(run.progress) && <p className="subtle" title="New tokens are fresh input and output; cached tokens are earlier context read again.">{tokenLine(run.progress)}</p>}
  </section>;
}

import { formatTokens } from "../src/run-text";
import type { SteerInput } from "./native";

// A helper turn past its time or tokens is asked to save its work and report,
// and stopped after the grace period; its session is then inspected and the
// master decides. A coordinator turn past its time is stopped and runs again.
export const TURN_LIMITS = {
  helperMs: 90 * 60_000,
  helperTokens: 100_000_000,
  graceMs: 20 * 60_000,
  masterMs: 20 * 60_000,
  checkMs: 30_000,
};
export type TurnLimit = "time_limit" | "token_limit";
// Checks one native turn against its limits until cleared; stop ends the turn.
export function watchLimits(o: {
  limits: typeof TURN_LIMITS;
  helper: boolean;
  started: number;
  spent: () => number;
  steer: () => ((input: SteerInput) => Promise<void>) | null;
  reached: (limit: TurnLimit, elapsed: number) => void;
  stop: () => void;
}) {
  let limit: TurnLimit | null = null,
    askedAt = 0,
    told = false;
  const timer = setInterval(() => {
    const elapsed = performance.now() - o.started,
      spent = o.spent();
    if (!o.helper) {
      if (elapsed <= o.limits.masterMs) return;
      limit = "time_limit";
      o.stop();
      return;
    }
    if (!limit) {
      if (elapsed <= o.limits.helperMs && spent <= o.limits.helperTokens)
        return;
      limit = elapsed > o.limits.helperMs ? "time_limit" : "token_limit";
      askedAt = elapsed;
      o.reached(limit, elapsed);
    }
    // The request goes as soon as the turn can take input, and again if a
    // delivery fails. The grace period runs from the limit either way, so a
    // turn that never takes the request, such as one whose input has closed,
    // is still stopped.
    const steer = o.steer();
    if (!told && steer) {
      told = true;
      steer({
        text: `Projects: this turn has run for ${Math.round(elapsed / 60_000)} minutes and used ${formatTokens(spent)} tokens, past its limit. Finish now: save your work on your branch (push it as a draft if this task allows), then return your structured result saying what is done and what remains. Do not start new long-running steps; the master continues from your report.`,
      }).catch(() => {
        told = false;
      });
    }
    if (elapsed - askedAt > o.limits.graceMs) o.stop();
  }, o.limits.checkMs);
  return { limit: () => limit, clear: () => clearInterval(timer) };
}
// A helper failure that leaves the work for the master to judge. Only the
// runner's own stops (shutdown, cancellation, a lost claim), an unconfirmed
// process stop and broken local state still end the turn.
export const HELPER_FAILURES: ReadonlySet<string> = new Set([
  "time_limit",
  "token_limit",
  "turn_failed",
  "native_exited",
  "invalid_result",
  "protocol_error",
  "native_timeout",
  "native_error",
  "model_busy",
  "turn_limit",
  "context_exceeded",
  "sandbox_error",
  "permission_required",
  "session_rejected",
  "turn_rejected",
  "usage_limit",
  "signed_out",
  "policy_refused",
  "native_unavailable",
]);
// A coordinator turn is read-only, so one that failed can simply run again.
export const MASTER_RETRIES: ReadonlySet<string> = new Set([
  "time_limit",
  "turn_failed",
  "native_exited",
  "invalid_result",
  "protocol_error",
  "native_timeout",
  "native_error",
  "model_busy",
  "context_exceeded",
  "session_rejected",
  "turn_rejected",
  "sandbox_error",
]);
// The session itself cannot take another turn: a new one continues the work.
export const SPENT: ReadonlySet<string> = new Set([
  "context_exceeded",
  "session_rejected",
]);
// The app cannot run any turn now, so its session cannot be inspected either.
export const UNAVAILABLE: ReadonlySet<string> = new Set([
  "usage_limit",
  "signed_out",
  "policy_refused",
  "native_unavailable",
]);

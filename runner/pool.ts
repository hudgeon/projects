import { setTimeout as delay } from "node:timers/promises";
import type { Lane, Run } from "../src/run-model";

// The person whose conversation it is and how its browser signs in come with
// the claim; the executor checks their shape before using them.
export type ClaimedRun = { run: Run; activity: unknown[]; person?: unknown; browserSignIn?: unknown };

// Claims stay serial so a lost reply can retry the same durable reservation.
// Native execution is concurrent; each conversation keeps its own controller,
// journal, master/child IDs, browser capability and completion receipt.
// Every lane shares one ceiling. Memory pressure pauses new starts only;
// active conversations and an updating runner's adopted executors keep running.
export const MAX_CONCURRENCY = 11;
export async function runPool(options: {
  concurrency: number;
  admit?: () => Promise<boolean>;
  signal: AbortSignal;
  // Stop claiming; each conversation returns at its next pause between turns.
  drain?: AbortSignal;
  // Executions already running when the pool starts, such as a previous
  // runner's executor processes: they hold a slot until they finish.
  adopted?: { id: string; lane: Lane; done: Promise<void> }[];
  // Once draining, return without waiting for executions to finish; they
  // run on in their own processes.
  leave?: boolean;
  once?: boolean;
  claim: (activeRunIds: string[], lanes: Lane[]) => Promise<ClaimedRun | null>;
  execute: (claim: ClaimedRun, control: AbortController) => Promise<void>;
  onError: (error: unknown, claim?: ClaimedRun) => void;
  pollMs?: number;
}) {
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > MAX_CONCURRENCY
  )
    throw Error(`Runner concurrency must be between one and ${MAX_CONCURRENCY}.`);
  const active = new Map<string, Promise<void>>();
  const controls = new Set<AbortController>();
  for (const item of options.adopted ?? []) {
    const task = item.done
      .catch(() => {})
      .finally(() => {
        active.delete(item.id);
      });
    active.set(item.id, task);
  }
  const stop = () => {
    for (const control of controls) control.abort("shutdown");
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const waiting = options.drain
    ? AbortSignal.any([options.signal, options.drain])
    : options.signal;
  const pause = () =>
    delay(options.pollMs ?? 2000, undefined, {
      signal: waiting,
    }).catch(() => {});
  let failure: unknown;
  try {
    while (!waiting.aborted) {
      try {
        const admitted = await options.admit?.() ?? true;
        if (waiting.aborted) break;
        const lanes: Lane[] = active.size < options.concurrency && admitted
          ? ["standard", "quick", "upkeep"] : [];
        const claim = await options.claim([...active.keys()], lanes);
        // A shutdown can arrive while the claim is in flight. Leave that saved
        // claim for this same runner's restart, without starting a native turn.
        if (waiting.aborted) break;
        // Empty lanes are a check-in only, even with an older server that
        // returns a recovery reservation. Keep it saved until admission opens.
        if (!lanes.length || !claim) {
          if (options.once) break;
          await pause();
          continue;
        }
        if (active.has(claim.run.id))
          throw Error("The runner received an already active conversation.");
        const control = new AbortController();
        controls.add(control);
        const task = Promise.resolve()
          .then(() => options.execute(claim, control))
          .catch(async (error) => {
            failure = error;
            options.onError(error, claim);
            if (!options.once) await pause();
          })
          .finally(() => {
            active.delete(claim.run.id);
            controls.delete(control);
          });
        active.set(claim.run.id, task);
        if (options.once) break;
      } catch (error) {
        failure = error;
        options.onError(error);
        if (options.once) break;
        await pause();
      }
    }
    if (!(options.leave && options.drain?.aborted && !options.signal.aborted))
      await Promise.all(active.values());
    if (options.once && failure) throw failure;
  } finally {
    options.signal.removeEventListener("abort", stop);
  }
}

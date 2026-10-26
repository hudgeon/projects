// One native turn, the coordinator's or a helper's: its limits, what it waits
// on, feedback, live view, saved worktree copies and receipt.
import { randomUUID } from "node:crypto";
import type { ExecutionEvent } from "../src/telemetry";
import { ACTIVITY_LIMIT, PROGRESS_NOTE_LIMIT, noUsage, type Child } from "../src/run-model";
import { Failure, type NativeOptions, type SteerInput, type TurnUsage } from "./native";
import { liveChanges, saveWorkspace } from "./workspaces";
import { browserInstructions, mailboxFor, mailboxUnavailableInstructions, progressInstructions, stuckInstructions, responseInstructions } from "./instructions";
import { telemetry } from "../src/telemetry";
import { TURN_LIMITS, watchLimits } from "./turn-limits";
import { watchTurn } from "./turn-watch";
import type { Execution } from "./execution";

export async function runTurn(
  x: Execution,
  options: NativeOptions,
  child?: Child,
  checkpoint?: (value: unknown) => void,
  // Feedback for this turn: messages already in its input are excluded;
  // received collects what reached it while it ran.
  steer?: { exclude: string[]; received: string[] },
): Promise<unknown> {
  const {
    o, checks, j, event, failureReason, persist, publish, turn, ranHere, delivery, lastSaved,
    overran, screenshots,
  } = x;
  let timing: Pick<ExecutionEvent, "model" | "effort" | "attempts" | "firstOutputMs"> = {};
  const control = new AbortController();
  const started = performance.now();
  const turnFields = {
    turnId: randomUUID(),
    ...(child ? { childId: child.id } : {}),
    actor: child ? child.agent : ("master" as const),
    ...(child ? {} : { agent: options.agent }),
    mode: options.readOnly ? ("read" as const) : ("change" as const),
    resumed: !!options.sessionId,
  };
  event("native_started", turnFields);
  // The turn's tokens add to its child's, or to the coordinator's, totals.
  const base = (child ? child.usage : j.progress.masterUsage) ?? noUsage();
  let used: TurnUsage = { fresh: 0, cached: 0, output: 0, context: 0 };
  let tokenUsageObserved = false;
  const account = () => {
    const usage = {
      fresh: base.fresh + used.fresh,
      cached: base.cached + used.cached,
      output: base.output + used.output,
      turns: base.turns + 1,
      context: used.context || base.context,
    };
    if (child) child.usage = usage;
    else j.progress.masterUsage = usage;
  };
  account();
  const tokens = () => ({
    freshTokens: used.fresh,
    cachedTokens: used.cached,
    outputTokens: used.output,
  });
  let finished = false;
  let dirty = false,
    update: Promise<void> | null = null,
    updateError: unknown;
  const flush = () => {
    dirty = false;
    return publish("running", j.progress.summary);
  };
  const timer = setInterval(() => {
    if (!dirty || update) return;
    update = flush()
      .catch((error: unknown) => {
        updateError = error;
        control.abort("activity-report-failed");
      })
      .finally(() => {
        update = null;
      });
  }, 3000);
  j.progress.live = {
    actor: child ? child.agent : "master",
    childId: child?.id ?? null,
    at: Date.now(),
  };
  dirty = true;
  // The user's feedback reaches the agent working now; the master still reviews
  // every message at its next decision.
  let steerTurn: ((input: SteerInput) => Promise<void>) | null = null,
    steering: Promise<void> | null = null,
    measuring: Promise<void> | null = null;
  const deliver = async () => {
    if (!steerTurn || !steer) return;
    const fresh = (o.latestMessages?.() ?? []).filter(
      (m) =>
        m.role === "user" &&
        m.delivery !== "reviewed" && m.delivery !== "steered" &&
        !steer.exclude.includes(m.id) &&
        !j.progress.reviewedMessageIds?.includes(m.id) &&
        !j.progress.steeredMessageIds?.includes(m.id),
    );
    for (const message of fresh) {
      try {
        await steerTurn({
          text: `The user sent this while you were working. It steers your current task within its existing authority:\n\n${message.text}`,
          screenshots: await screenshots([message]),
        });
      } catch {
        // The turn ended or cannot take input; the master reads it next.
        return;
      }
      j.progress.steeredMessageIds = [
        ...(j.progress.steeredMessageIds ?? []),
        message.id,
      ].slice(-40);
      steer.received.push(message.id);
      dirty = true;
    }
  };
  const watch = watchLimits({
    limits: { ...TURN_LIMITS, ...o.limits },
    helper: !!child,
    started,
    spent: () => used.fresh + used.cached + used.output,
    steer: () => steerTurn,
    reached: (reason, elapsed) =>
      event("turn_limit_reached", { ...turnFields, durationMs: Math.round(elapsed), ...tokens(), reason }),
    stop: () => control.abort("budget"),
  });
  // What the turn waits on, and whether it may be stuck.
  let pid: number | null = null;
  const stall = watchTurn({
    limits: o.limits,
    label: (command) => checks.label(child?.id ?? "master", command),
    pid: () => pid,
    publish: (watch) => {
      if (!j.progress.live) return;
      j.progress.live = { ...j.progress.live, watch };
      dirty = true;
    },
    stuck: (reason) => {
      event("turn_stuck", { ...turnFields, reason: reason === "idle" ? "commands_idle" : "agent_silent" });
      if (child) steerTurn?.({ text: stuckInstructions(reason) }).catch(() => {});
    },
  });
  const steerTimer =
    steer && o.latestMessages
      ? setInterval(() => {
          steering ??= deliver().finally(() => {
            steering = null;
          });
        }, 2000)
      : null;
  // The branch's changed files and line counts while a change child works.
  const changesTimer =
    child && !options.readOnly
      ? setInterval(() => {
          measuring ??= (o.changes ?? liveChanges)(options.cwd)
            .then((changes) => {
              if (!j.progress.live) return;
              j.progress.live = { ...j.progress.live, changes };
              dirty = true;
            })
            .catch(() => {})
            .finally(() => {
              measuring = null;
            });
        }, o.liveChangesMs ?? 20000)
      : null;
  // The change worktree goes to GitHub every few minutes (private
  // repositories only), so another machine can continue it if this one goes
  // away. Copies that earlier children saved in this worktree give way to
  // this child's.
  let saving: Promise<void> | null = null,
    saveFailing = false;
  const older = j.progress.children
    .filter(
      (c) =>
        c.id !== child?.id &&
        c.mode === "change" &&
        ranHere(c) &&
        c.cwd === options.cwd,
    )
    .map((c) => c.id);
  const saveNow = () =>
    (saving ??= (o.save ?? saveWorkspace)(options.cwd, o.run.id, child!.id, {
      older,
    })
      .then((saved) => {
        saveFailing = false;
        if (!saved) return;
        lastSaved.set(child!.id, saved.at);
        if (j.progress.live) {
          j.progress.live = { ...j.progress.live, savedAt: saved.at };
          dirty = true;
        }
      })
      .catch((error: unknown) => {
        // The work goes on unsaved. Recorded once per failing stretch, so
        // repeated saves cannot crowd other events out of the bounded list.
        if (!saveFailing)
          event("workspace_save_failed", {
            childId: child!.id,
            actor: child!.agent,
            outcome: "failed",
            reason:
              error instanceof Error &&
              error.message.startsWith("Git could not")
                ? "git_failed"
                : "unexpected",
          });
        saveFailing = true;
        dirty = true;
      })
      .finally(() => {
        saving = null;
      }));
  const saveTimer =
    child && !options.readOnly
      ? setInterval(() => void saveNow(), o.saveMs ?? 5 * 60_000)
      : null;
  // A delegated mailbox reaches the turn as an hour's token for its owner.
  // When none can be minted the turn gets no mailbox and is told so, never
  // another person's.
  const connected = mailboxFor(o.person, o.inboxes);
  const mailboxToken = connected?.delegated
    ? await o.mailboxToken?.(connected.account, o.run.lane === "review").catch(() => undefined)
    : undefined;
  const mailbox = connected?.delegated && !mailboxToken ? null : connected;
  if (connected && !mailbox)
    telemetry("runner", "mailbox_unavailable", { runId: o.run.id, generation: o.run.generation }, "warn");
  try {
    await persist();
    const value = await turn({
      ...options,
      fullAccess: o.fullAccess && !options.readOnly,
      onTiming: fields => { timing = {...timing, ...fields}; },
      person: o.person,
      mailbox,
      mailboxToken,
      prompt: `${options.prompt}\n\n${responseInstructions(o.person)}\n\n${progressInstructions(o.person)}${options.browser ? browserInstructions(options.browser.endpoint, o.person, o.browserSignIn) : ""}${connected && !mailbox ? mailboxUnavailableInstructions(o.person) : ""}`,
      signal: AbortSignal.any([options.signal, control.signal]),
      onProcess: async (p) => {
        pid = p;
        await options.onProcess?.(p);
      },
      onActivity: (event, command) => {
        stall.activity(event, command);
        j.progress.activity = [
          ...(j.progress.activity ?? []),
          {
            ...event,
            id: randomUUID(),
            at: Date.now(),
            actor: child ? child.agent : ("master" as const),
            childId: child?.id ?? null,
          },
        ].slice(-ACTIVITY_LIMIT);
        dirty = true;
      },
      onPlan: (plan) => {
        stall.touch();
        if (!j.progress.live) return;
        j.progress.live = { ...j.progress.live, plan, at: Date.now() };
        dirty = true;
      },
      onSteer: (fn) => {
        steerTurn = fn;
      },
      onOverran: () => {
        event("turn_overran", turnFields);
        if (child) overran.add(child.id);
      },
      onUsage: (usage) => {
        stall.touch();
        tokenUsageObserved = true;
        used = usage;
        account();
        dirty = true;
      },
      onProgress: (note) => {
        stall.touch();
        j.progress.notes = [
          ...(j.progress.notes ?? []),
          {
            ...note,
            id: randomUUID(),
            at: Date.now(),
            actor: child ? child.agent : ("master" as const),
            childId: child?.id ?? null,
          },
        ].slice(-PROGRESS_NOTE_LIMIT);
        if (child) checks.progress(child.id, j.progress.notes);
        dirty = true;
      },
    });
    // Save a validated result before waiting for activity/report delivery.
    // A restart can replay this receipt without repeating the native turn.
    checkpoint?.(value);
    finished = true;
    event("native_finished", {
      ...turnFields,
      ...timing,
      ...(options.agent === "codex" ? {tokenUsageObserved} : {}),
      durationMs: Math.round(performance.now() - started),
      ...tokens(),
      outcome: "completed",
    });
    await persist();
    return value;
  } catch (thrown) {
    // A turn the runner stopped at its limit fails with that limit.
    const limit = watch.limit();
    const error =
      control.signal.reason === "budget" && limit && !options.signal.aborted
        ? new Failure(
            limit,
            child
              ? `It ran past its ${limit === "time_limit" ? "time" : "token"} limit and was stopped after being asked to save its work and report.`
              : "The coordinator took too long to decide, so it was stopped.",
          )
        : thrown;
    const reason = failureReason(error);
    if (!finished)
      event("native_finished", {
        ...turnFields,
        ...timing,
        ...(options.agent === "codex" ? {tokenUsageObserved} : {}),
        durationMs: Math.round(performance.now() - started),
        ...tokens(),
        outcome:
          reason === "shutdown" || reason === "cancelled" ? reason : "failed",
        reason,
      });
    throw error;
  } finally {
    watch.clear();
    stall.clear();
    steerTurn = null;
    if (steerTimer) clearInterval(steerTimer);
    if (changesTimer) clearInterval(changesTimer);
    if (saveTimer) {
      clearInterval(saveTimer);
      await saving;
      await saveNow();
    }
    await steering;
    await measuring;
    delete j.progress.live;
    dirty = true;
    clearInterval(timer);
    await update;
    if (updateError) throw delivery(updateError);
    if (dirty)
      await flush().catch((error: unknown) => {
        throw delivery(error);
      });
  }
}

import { DurableObject } from "cloudflare:workers";
import { telemetry } from "../src/telemetry";
import { ConversationBrowser } from "./browser";
import {
  startWindow,
  collectProgress,
  closeWindow,
  type ProgressWindow,
} from "./progress-updates";
import {
  activeRun,
  RUNNER_STALE_MS,
  type Run,
  type RunnerHost,
  type Progress,
  type MessageInput,
} from "../src/run-model";
import {
  decodeScreenshots,
  SCREENSHOTS_PER_CONVERSATION,
  type Screenshot,
  type ScreenshotInput,
} from "../src/screenshot-model";

type Row = {
  id: string;
  payload: string;
  owner: string | null;
  revision: number;
};
export type ConversationRecord = {
  run: Run;
  owner: string | null;
  revision: number;
};
// Execution receipts have their own owner; portfolio snapshots remain observations.
export class Conversation extends DurableObject<Env> {
  private storage: DurableObjectStorage;
  private browser: ConversationBrowser;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = (this.storage = ctx.storage);
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, owner TEXT, updated INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS progress_window (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS screenshots (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, bytes BLOB NOT NULL)",
    );
    this.browser = new ConversationBrowser(
      storage,
      env,
      () => this.record(),
      () => {
        const run = this.record()?.run;
        if (run) this.schedule(run);
      },
    );
  }
  fetch(request: Request) {
    return this.browser.connect(request);
  }
  browserGrant(owner: string, generation: number) {
    return this.browser.grant(owner, generation);
  }
  browserStatus() {
    return this.browser.status();
  }
  browserView(readonly: boolean) {
    return this.browser.liveView(readonly);
  }
  get(id: string): Run | null {
    const row = this.storage.sql
      .exec<Row>("SELECT * FROM agent_runs WHERE id=?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.payload) as Run) : null;
  }
  runtimeVersion() {
    return this.env.CF_VERSION_METADATA?.id ?? "local";
  }
  async initialize(
    run: Run,
    owner: string | null,
    screenshots: ScreenshotInput[] = [],
  ): Promise<ConversationRecord> {
    const decoded = await decodeScreenshots(screenshots);
    const existing = this.record();
    if (existing) {
      if (existing.run.id !== run.id)
        throw Error("Conversation identity mismatch.");
      return existing;
    }
    this.storage.transactionSync(() => {
      if (decoded.length) {
        run.messages[0].screenshots = this.saveScreenshots(decoded);
      }
      this.storage.sql.exec(
        "INSERT INTO agent_runs(id,payload,owner,updated) VALUES(?,?,?,?)",
        run.id,
        JSON.stringify(run),
        owner,
        run.updatedAt,
      );
    });
    this.schedule(run);
    telemetry("conversation", "conversation_created", {
      runId: run.id,
      generation: run.generation,
      state: run.state,
    });
    return this.record()!;
  }
  private saveScreenshots(
    images: Awaited<ReturnType<typeof decodeScreenshots>>,
  ): Screenshot[] {
    const count = this.storage.sql
      .exec<{ n: number }>("SELECT count(*) n FROM screenshots")
      .one().n;
    if (count + images.length > SCREENSHOTS_PER_CONVERSATION)
      throw Error("This conversation has reached its screenshot limit.");
    for (const image of images) {
      // IDs cannot overwrite an image that another message already references.
      this.storage.sql.exec(
        "INSERT INTO screenshots(id,metadata,bytes) VALUES(?,?,?)",
        image.metadata.id,
        JSON.stringify(image.metadata),
        image.bytes,
      );
    }
    return images.map((image) => image.metadata);
  }
  screenshot(
    id: string,
    screenshotId: string,
    owner?: string,
    generation?: number,
  ) {
    const record = this.record();
    if (!record || record.run.id !== id) return null;
    if (
      owner !== undefined &&
      (record.owner !== owner ||
        record.run.generation !== generation ||
        !["running", "cancelling"].includes(record.run.state))
    )
      return null;
    if (
      !record.run.messages.some((message) =>
        message.screenshots?.some((image) => image.id === screenshotId),
      )
    )
      return null;
    const row = this.storage.sql
      .exec<{ metadata: string; bytes: ArrayBuffer }>(
        "SELECT metadata,bytes FROM screenshots WHERE id=?",
        screenshotId,
      )
      .toArray()[0];
    return row
      ? { metadata: JSON.parse(row.metadata) as Screenshot, bytes: row.bytes }
      : null;
  }
  record(): ConversationRecord | null {
    const row = this.storage.sql
      .exec<Row>("SELECT * FROM agent_runs LIMIT 1")
      .toArray()[0];
    return row
      ? {
          run: JSON.parse(row.payload) as Run,
          owner: row.owner,
          revision: row.revision,
        }
      : null;
  }
  private schedule(run: Run) {
    // The storage output gate covers the alarm write as well as the SQL receipt.
    if (
      ["running", "cancelling"].includes(run.state) &&
      run.connection !== "disconnected"
    )
      void this.storage.setAlarm(
        Math.max(
          Date.now() + 1,
          Math.min(
            run.heartbeatAt + RUNNER_STALE_MS,
            run.nextUpdateAt ?? Infinity,
            this.browser.nextAlarm(),
          ),
        ),
      );
    else if (["running", "cancelling"].includes(run.state) && run.nextUpdateAt)
      void this.storage.setAlarm(
        Math.max(
          Date.now() + 1,
          Math.min(run.nextUpdateAt, this.browser.nextAlarm()),
        ),
      );
    else void this.storage.setAlarm(Date.now() + 1000);
  }
  async alarm() {
    const record = this.record();
    if (!record) return;
    const started = Date.now();
    const fields = { runId: record.run.id, generation: record.run.generation };
    try {
      try {
        await this.browser.reconcile();
      } catch {
        // Provider cleanup has its own persisted retry. A provider outage must
        // not prevent five-minute updates, stale-runner detection or indexing.
        telemetry(
          "conversation",
          "browser_failed",
          { ...fields, browserOperation: "close", reason: "unexpected" },
          "warn",
        );
      }
      await this.reconcile(this.record()!);
      telemetry("conversation", "alarm_reconciled", {
        ...fields,
        durationMs: Math.max(0, Date.now() - started),
      });
    } catch (error) {
      telemetry(
        "conversation",
        "alarm_failed",
        {
          ...fields,
          durationMs: Math.max(0, Date.now() - started),
          reason: "unexpected",
        },
        "error",
      );
      throw error;
    }
  }
  private async reconcile(record: ConversationRecord) {
    const monitored = ["running", "cancelling"].includes(record.run.state);
    if (
      monitored &&
      Date.now() - record.run.heartbeatAt >= RUNNER_STALE_MS &&
      record.run.connection !== "disconnected"
    ) {
      // Loss of contact is not evidence that a native process stopped. Keep its owner.
      record.run.connection = "disconnected";
      this.save(record.run);
      telemetry(
        "conversation",
        "runner_disconnected",
        {
          runId: record.run.id,
          generation: record.run.generation,
          heartbeatAgeMs: Math.max(0, Date.now() - record.run.heartbeatAt),
        },
        "warn",
      );
    }
    // This also bootstraps windows for conversations already running at rollout.
    // No browser, heartbeat or agent response is needed to publish a due update.
    if (monitored) this.save(this.record()!.run);
    // Repair a lost directory update even for a terminal -> queued transition.
    // Schedule before I/O so a prolonged failure survives the platform retry cap.
    await this.storage.setAlarm(Date.now() + RUNNER_STALE_MS);
    const sentRevision = this.record()!.revision;
    await this.env.PORTFOLIOS.getByName(this.env.PORTFOLIO_ID).getRun(
      record.run.id,
    );
    const latest = this.record()!;
    const current = latest.run;
    if (["running", "cancelling"].includes(current.state))
      this.schedule(current);
    else if (latest.revision !== sentRevision)
      await this.storage.setAlarm(Date.now() + 1000);
    else if (Number.isFinite(this.browser.nextAlarm()))
      await this.storage.setAlarm(
        Math.max(Date.now() + 1, this.browser.nextAlarm()),
      );
    else await this.storage.deleteAlarm();
  }
  private save(run: Run, owner?: string | null) {
    const previous = this.get(run.id);
    const now = Date.now();
    const row = this.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM progress_window WHERE id=1",
      )
      .toArray()[0];
    let window = row ? (JSON.parse(row.payload) as ProgressWindow) : null;
    const emitted: number[] = [];
    const monitored = ["running", "cancelling"].includes(run.state);
    if (window?.generation !== run.generation) window = null;
    if (!window && monitored) window = startWindow(run, now);
    if (window) {
      const publishUpdate = () => {
        const update = closeWindow(run, window!, now);
        emitted.push(now - update.from);
      };
      if (run.nextUpdateAt && now >= run.nextUpdateAt) publishUpdate();
      collectProgress(
        window,
        previous?.generation === run.generation ? previous.progress : null,
        run.progress,
      );
      if (!monitored) {
        if (window.from < now) publishUpdate();
        window = null;
        run.nextUpdateAt = null;
      }
    }
    this.storage.transactionSync(() => {
      if (window)
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO progress_window(id,payload) VALUES(1,?)",
          JSON.stringify(window),
        );
      else this.storage.sql.exec("DELETE FROM progress_window WHERE id=1");
      if (owner !== undefined)
        this.storage.sql.exec(
          "UPDATE agent_runs SET payload=?,owner=?,updated=?,revision=revision+1 WHERE id=?",
          JSON.stringify(run),
          owner,
          run.updatedAt,
          run.id,
        );
      else
        this.storage.sql.exec(
          "UPDATE agent_runs SET payload=?,updated=?,revision=revision+1 WHERE id=?",
          JSON.stringify(run),
          run.updatedAt,
          run.id,
        );
    });
    this.schedule(run);
    for (const durationMs of emitted)
      telemetry("conversation", "progress_summary_saved", {
        runId: run.id,
        generation: run.generation,
        durationMs,
        state: run.state,
      });
    return run;
  }
  async message(id: string, input: MessageInput): Promise<Run> {
    const decoded = await decodeScreenshots(input.screenshots);
    const run = this.get(id);
    if (!run) throw Error("Conversation not found.");
    if (run.messages.some((m) => m.id === input.requestId)) return run;
    if (run.state === "cancelling")
      throw Error(
        "Wait for its machine to confirm it stopped before sending a follow-up.",
      );
    const reopened = !!run.archivedAt;
    this.storage.transactionSync(() => {
      if (reopened) run.archivedAt = null;
      const screenshots = this.saveScreenshots(decoded);
      run.messages.push({
        id: input.requestId,
        role: "user",
        text: input.text,
        at: Date.now(),
        delivery: "queued",
        ...(screenshots.length ? { screenshots } : {}),
      });
      run.updatedAt = Date.now();
      if (!activeRun(run.state)) this.nextGeneration(run);
      this.save(run);
    });
    if (reopened)
      telemetry("conversation", "conversation_restored", {
        runId: id,
        generation: run.generation,
        state: run.state,
      });
    telemetry("conversation", "feedback_queued", {
      runId: id,
      generation: run.generation,
      messageId: input.requestId,
      state: run.state,
    });
    return run;
  }
  private nextGeneration(run: Run) {
    run.generation++;
    run.state = "queued";
    run.updatedAt = Date.now();
    run.heartbeatAt = 0;
    run.startedAt = run.finishedAt = null;
    run.nextUpdateAt = null;
    delete run.connection;
    run.progress = run.progress
      ? {
          ...run.progress,
          seq: 0,
          summary: "Follow-up queued",
          state: "running",
          notes: [],
        }
      : null;
  }
  archive(id: string, archived: boolean) {
    const run = this.get(id);
    if (!run) throw Error("Conversation not found.");
    if (archived && activeRun(run.state)) return "active" as const;
    if (!!run.archivedAt === archived) return run;
    run.archivedAt = archived ? Date.now() : null;
    this.save(run);
    telemetry(
      "conversation",
      archived ? "conversation_archived" : "conversation_restored",
      {
        runId: id,
        generation: run.generation,
        state: run.state,
      },
    );
    return run;
  }
  // The owner continues a conversation on another machine while its own is
  // away. The away machine's claim is released, never replayed: a step it had
  // in flight is abandoned with an unknown outcome, and the next machine to
  // claim it starts a new coordinator from the conversation's history. A stop
  // already requested stays stopped.
  move(id: string, from: string) {
    const run = this.get(id);
    if (!run) throw Error("Conversation not found.");
    const previousState = run.state;
    if (run.state === "running") this.nextGeneration(run);
    else if (run.state === "cancelling") run.state = "cancelled";
    if (run.progress && previousState === "running")
      run.progress.summary = "Moved; waiting for another machine to start it.";
    run.movedFrom = run.host ?? from;
    run.movedAt = run.updatedAt = Date.now();
    delete run.host;
    delete run.connection;
    this.save(run, null);
    telemetry("conversation", "conversation_moved", {
      runId: id,
      generation: run.generation,
      previousState,
      state: run.state,
    });
    return run;
  }
  cancel(id: string) {
    const run = this.get(id);
    if (!run) throw Error("Conversation not found.");
    const previousState = run.state;
    if (run.state === "queued") { run.state = "cancelled"; run.finishedAt = Date.now(); }
    else if (run.state === "running") run.state = "cancelling";
    run.updatedAt = Date.now();
    this.save(run);
    if (previousState !== run.state)
      telemetry("conversation", "conversation_state_changed", {
        runId: id,
        generation: run.generation,
        previousState,
        state: run.state,
      });
    return run;
  }
  claim(owner: string, host: RunnerHost) {
    // Synchronous SQL has no await boundary between selection and assignment.
    // A lost reply returns the same claim. Stale claims are NEVER reassigned.
    const owned = this.storage.sql
      .exec<Row>(
        "SELECT * FROM agent_runs WHERE owner=? AND json_extract(payload,'$.state') IN ('running','cancelling') ORDER BY updated LIMIT 1",
        owner,
      )
      .toArray()[0];
    if (owned) return JSON.parse(owned.payload) as Run;
    const row = this.storage.sql
      .exec<Row>(
        "SELECT * FROM agent_runs WHERE json_extract(payload,'$.state')='queued' AND (owner IS NULL OR owner=?) ORDER BY updated LIMIT 1",
        owner,
      )
      .toArray()[0];
    if (!row) return null;
    const run = JSON.parse(row.payload) as Run;
    if (run.progress && run.progress.state !== "running")
      this.nextGeneration(run);
    const pendingAt = run.messages
      .filter(
        (m) =>
          m.role === "user" &&
          m.delivery !== "reviewed" &&
          !run.progress?.reviewedMessageIds?.includes(m.id),
      )
      .map((m) => m.at);
    const queueMs = Math.max(
      0,
      Date.now() -
        Math.min(...(pendingAt.length ? pendingAt : [run.updatedAt])),
    );
    run.state = "running";
    run.startedAt ??= Date.now();
    run.finishedAt = null;
    run.connection = "connected";
    run.host = host;
    run.updatedAt = run.heartbeatAt = Date.now();
    this.save(run, owner);
    telemetry("conversation", "conversation_claimed", {
      runId: run.id,
      generation: run.generation,
      queueMs,
      host,
    });
    return run;
  }
  heartbeat(owner: string, id: string, generation: number) {
    const row = this.storage.sql
      .exec<Row>("SELECT * FROM agent_runs WHERE id=?", id)
      .toArray()[0];
    if (!row || row.owner !== owner) return null;
    const run = JSON.parse(row.payload) as Run;
    if (
      run.generation !== generation ||
      !["running", "cancelling"].includes(run.state)
    )
      return null;
    const reconnected = run.connection === "disconnected";
    const heartbeatAgeMs = Math.max(0, Date.now() - run.heartbeatAt);
    run.heartbeatAt = Date.now();
    run.connection = "connected";
    this.save(run);
    if (reconnected)
      telemetry("conversation", "runner_reconnected", {
        runId: id,
        generation,
        heartbeatAgeMs,
      });
    return { cancel: run.state === "cancelling", messages: run.messages };
  }
  report(owner: string, id: string, generation: number, progress: Progress) {
    const row = this.storage.sql
      .exec<Row>("SELECT * FROM agent_runs WHERE id=?", id)
      .toArray()[0];
    if (!row || row.owner !== owner) return false;
    const run = JSON.parse(row.payload) as Run;
    if (run.generation !== generation) return false;
    if (progress.seq <= (run.progress?.seq ?? 0)) return true;
    if (!["running", "cancelling"].includes(run.state)) return false;
    const reviewed = new Set(progress.reviewedMessageIds ?? []);
    // Feedback the runner gave to the agent working at the time.
    const steered = new Set(progress.steeredMessageIds ?? []);
    const previousState = run.state;
    const previousEvents = new Set(
      run.progress?.telemetry?.map((e) => e.id) ?? [],
    );
    const newEvents = (progress.telemetry ?? []).filter((e) => {
      if (previousEvents.has(e.id)) return false;
      previousEvents.add(e.id);
      return true;
    });
    const newlyReviewed = run.messages.filter(
      (m) =>
        (m.delivery === "queued" || m.delivery === "steered") &&
        reviewed.has(m.id),
    );
    const newlySteered = run.messages.filter(
      (m) => m.delivery === "queued" && steered.has(m.id) && !reviewed.has(m.id),
    );
    const reconnected = run.connection === "disconnected";
    const heartbeatAgeMs = Math.max(0, Date.now() - run.heartbeatAt);
    if (
      [...reviewed, ...steered].some(
        (id) => !run.messages.some((m) => m.role === "user" && m.id === id),
      )
    )
      return false;
    for (const message of newlyReviewed) message.delivery = "reviewed";
    for (const message of newlySteered) message.delivery = "steered";
    // Cancellation wins a race with a model's late completion.
    let state: Run["state"] =
      run.state === "cancelling"
        ? progress.state === "running"
          ? "cancelling"
          : progress.state === "completed" || progress.state === "cancelled"
            ? "cancelled"
            : progress.state
        : progress.state;
    if (
      state === "completed" &&
      progress.reviewedMessageIds === undefined &&
      run.messages.some((m) => m.delivery === "queued")
    ) {
      state = "blocked";
      progress = {
        ...progress,
        state: "blocked",
        summary:
          "Your feedback is saved. This older runner cannot confirm feedback delivery; update that machine's runner, then send a follow-up to continue.",
      };
    }
    run.progress =
      state === "cancelled"
        ? {
            ...progress,
            state: "cancelled",
            summary: "Stopped. Existing work and native sessions are retained.",
          }
        : progress;
    run.state = state;
    run.connection = "connected";
    run.updatedAt = run.heartbeatAt = Date.now();
    run.finishedAt = activeRun(state) ? null : run.updatedAt;
    if (!activeRun(state))
      run.messages.push({
        id: `${id}:${generation}:result`,
        role: "master",
        text:
          state === "cancelled"
            ? "Stopped. Existing work and native sessions are retained."
            : progress.summary,
        at: Date.now(),
      });
    // Only confirmed completion is automatically continued. An uncertain native
    // turn, failed gate or cancellation must retain its recovery boundary.
    if (
      state === "completed" &&
      run.messages.some((m) => m.delivery === "queued")
    )
      run.state = "queued";
    this.save(run);
    // Emit only after accepting a newer receipt. An identical report retry must
    // not inflate native timings or feedback counts. Logs remain diagnostic;
    // storage receipts, not telemetry, decide whether work is complete.
    for (const { id: eventId, event, ...fields } of newEvents)
      telemetry("conversation", event, {
        ...fields,
        eventId,
        runId: id,
        generation,
        seq: progress.seq,
      });
    for (const message of newlySteered)
      telemetry("conversation", "feedback_steered", {
        runId: id,
        generation,
        messageId: message.id,
        feedbackMs: Math.max(0, Date.now() - message.at),
      });
    for (const message of newlyReviewed)
      telemetry("conversation", "feedback_reviewed", {
        runId: id,
        generation,
        messageId: message.id,
        feedbackMs: Math.max(0, Date.now() - message.at),
      });
    if (reconnected)
      telemetry("conversation", "runner_reconnected", {
        runId: id,
        generation,
        heartbeatAgeMs,
      });
    if (previousState !== run.state)
      telemetry(
        "conversation",
        "conversation_state_changed",
        {
          runId: id,
          generation,
          previousState,
          state: run.state,
          childCount: progress.children.length,
          conversationAgeMs: Math.max(0, Date.now() - run.createdAt),
        },
        state === "blocked" || state === "failed" ? "warn" : "info",
      );
    return true;
  }
}

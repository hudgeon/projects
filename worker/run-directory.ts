import {
  activeRun,
  EMAIL_RUN_LIMIT,
  QUICK_ACTIVE_LIMIT,
  STANDARD_ACTIVE_LIMIT,
  type Lane,
  runProjectIds,
  type Run,
  type RunnerHost,
  type RunInput,
  type Progress,
  type RunSummary,
  type RunListOptions,
  type MessageInput,
} from "../src/run-model";
import { decodeScreenshots, type ScreenshotInput } from "../src/screenshot-model";
import { latestPlan, runTitle, statusLine } from "../src/run-text";
import type { ConversationRecord } from "./runs";
import type { Machines } from "./machines";
import { deploymentOwner } from "./auth";

// The runner owner (a machine's runner ID) that claimed it, not the person.
type IndexRow = {
  id: string;
  payload: string;
  owner: string | null;
  revision: number;
  seed: string | null;
};
const summary = (run: Run): RunSummary => ({
  id: run.id,
  projectId: run.projectId,
  projectIds: runProjectIds(run),
  archivedAt: run.archivedAt ?? null,
  agent: run.agent,
  state: run.state,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  heartbeatAt: run.heartbeatAt,
  workIssue: run.workIssue,
  emailThread: run.emailThread ?? null,
  lane: run.lane ?? "standard",
  host: run.host,
  owner: run.owner,
  title: runTitle(run),
  status: statusLine(run),
  remaining: activeRun(run.state)
    ? (latestPlan(run)?.remaining.length ?? null)
    : null,
  needsYou: run.state === "running" && !!latestPlan(run)?.yourMove,
  stuck: run.state === "running" && !!run.progress?.live?.watch?.stuck,
});
// Conversations from before people had profiles belong to the deployment owner.
const withOwner = <T extends { owner: string }>(run: T, owner: string): T =>
  run.owner ? run : { ...run, owner };
// The portfolio retains a rebuildable index and runner slots. Each conversation
// is authoritative for its messages, generation, claim and execution receipts.
export class Runs {
  private ready: Promise<void> | undefined;
  private selections: Promise<unknown> = Promise.resolve();
  private readonly deploymentOwner: string;
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private machines: Machines,
    // Told each time a conversation's indexed summary moves forward.
    private changed?: (previous: RunSummary | null, next: RunSummary) => void,
  ) {
    this.deploymentOwner = deploymentOwner(env);
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,owner TEXT,updated INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS conversation_index(id TEXT PRIMARY KEY,payload TEXT NOT NULL,owner TEXT,revision INTEGER NOT NULL,seed TEXT)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runner_slots(owner TEXT PRIMARY KEY,id TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runner_contact(host TEXT PRIMARY KEY,at INTEGER NOT NULL)",
    );
  }
  // Every claim, heartbeat and report counts as the machine being present.
  private contact(host: RunnerHost) {
    this.storage.sql.exec(
      "INSERT INTO runner_contact(host,at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET at=excluded.at",
      host,
      Date.now(),
    );
  }
  private stub(id: string) {
    return this.env.CONVERSATIONS.getByName(
      JSON.stringify([this.env.PORTFOLIO_ID, id]),
    );
  }
  async runtimeVersions(id = "deployment-readiness") {
    return {
      portfolio: this.env.CF_VERSION_METADATA?.id ?? "local",
      conversation: await this.stub(id).runtimeVersion(),
    };
  }
  private remember(record: ConversationRecord) {
    const previous = this.storage.sql
      .exec<{ payload: string; revision: number }>(
        "SELECT payload,revision FROM conversation_index WHERE id=?",
        record.run.id,
      )
      .toArray()[0];
    const run = withOwner(record.run, this.deploymentOwner);
    const next = summary(run);
    this.storage.sql.exec(
      `INSERT INTO conversation_index(id,payload,owner,revision,seed) VALUES(?,?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,owner=excluded.owner,revision=excluded.revision,seed=NULL
      WHERE excluded.revision >= conversation_index.revision`,
      record.run.id,
      JSON.stringify(next),
      record.owner,
      record.revision,
    );
    if (!previous || record.revision >= previous.revision)
      this.changed?.(
        previous ? (JSON.parse(previous.payload) as RunSummary) : null,
        next,
      );
    return run;
  }
  private migrate() {
    return (this.ready ??= (async () => {
      // Copy first, acknowledge, then delete. A lost reply/restart repeats only
      // initialize, which cannot overwrite a conversation that already exists.
      for (const row of this.storage.sql
        .exec<{ id: string; payload: string; owner: string | null }>(
          "SELECT * FROM agent_runs",
        )
        .toArray()) {
        const record = await this.stub(row.id).initialize(
          JSON.parse(row.payload) as Run,
          row.owner,
        );
        this.remember(record);
        this.storage.sql.exec("DELETE FROM agent_runs WHERE id=?", row.id);
      }
      for (const row of this.storage.sql
        .exec<IndexRow>(
          "SELECT * FROM conversation_index WHERE seed IS NOT NULL",
        )
        .toArray()) {
        const seed = JSON.parse(row.seed!) as Run | { run: Run; screenshots: ScreenshotInput[] };
        this.remember(
          await this.stub(row.id).initialize(
            "run" in seed ? seed.run : seed,
            row.owner,
            "run" in seed ? seed.screenshots : [],
          ),
        );
      }
      // Old index summaries omitted projects chosen by the master and the list
      // title/status. Read each authoritative conversation once, then persist
      // its full summary.
      for (const row of this.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM conversation_index WHERE json_type(payload,'$.projectIds') IS NULL OR json_type(payload,'$.status') IS NULL",
        )
        .toArray()) {
        const record = await this.stub(row.id).record();
        if (record) this.remember(record);
      }
    })().catch((error) => {
      this.ready = undefined;
      throw error;
    }));
  }
  private select<T>(action: () => Promise<T>): Promise<T> {
    const result = this.selections.then(action);
    this.selections = result.catch(() => {});
    return result;
  }
  async get(id: string): Promise<Run | null> {
    await this.migrate();
    if (
      !this.storage.sql
        .exec("SELECT id FROM conversation_index WHERE id=?", id)
        .toArray().length
    )
      return null;
    const record = await this.stub(id).record();
    return record ? this.remember(record) : null;
  }
  async list(options: RunListOptions = {}): Promise<RunSummary[]> {
    await this.migrate();
    await this.refreshActive();
    if (options.email)
      return this.storage.sql
        .exec<{ payload: string }>(
          `SELECT payload FROM conversation_index
        WHERE json_extract(payload,'$.emailThread') IS NOT NULL
        ORDER BY json_extract(payload,'$.updatedAt') DESC,id DESC LIMIT ?`,
          EMAIL_RUN_LIMIT,
        )
        .toArray()
        .map((row) => withOwner(JSON.parse(row.payload) as RunSummary, this.deploymentOwner));
    return this.storage.sql
      .exec<{ payload: string }>(
        `SELECT payload FROM conversation_index
      WHERE (COALESCE(json_extract(payload,'$.archivedAt'),0) > 0) = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(conversation_index.payload,'$.projectIds') WHERE value=?))
      ORDER BY (json_extract(payload,'$.state') IN ('queued','running','cancelling')) DESC,
      json_extract(payload,'$.updatedAt') DESC,id DESC LIMIT 50 OFFSET ?`,
        options.archived ? 1 : 0,
        options.projectId ?? null,
        options.projectId ?? null,
        options.offset ?? 0,
      )
      .toArray()
      .map((row) => withOwner(JSON.parse(row.payload) as RunSummary, this.deploymentOwner));
  }
  private async refreshActive() {
    const rows = this.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM conversation_index WHERE json_extract(payload,'$.state') IN ('queued','running','cancelling')",
      )
      .toArray();
    await Promise.all(rows.map((row) => this.get(row.id)));
  }
  // Quick work has its own, larger bound so a run of email replies cannot
  // block bigger work from starting, and bigger work cannot block replies.
  private capacity(lane: Lane) {
    const count = this.storage.sql
      .exec<{ n: number }>(
        "SELECT count(*) n FROM conversation_index WHERE json_extract(payload,'$.state') IN ('queued','running','cancelling') AND COALESCE(json_extract(payload,'$.lane'),'standard')=?",
        lane,
      )
      .one().n;
    if (count >= (lane === "quick" ? QUICK_ACTIVE_LIMIT : STANDARD_ACTIVE_LIMIT))
      throw Error("Too many conversations are already queued or running.");
  }
  create(input: RunInput, owner: string) {
    return this.select(async () => {
      await this.migrate();
      const existing = await this.get(input.requestId);
      if (existing) return existing;
      await decodeScreenshots(input.screenshots);
      await this.refreshActive();
      this.capacity(input.lane ?? "standard");
      const now = Date.now();
      const run: Run = {
        id: input.requestId,
        projectId: input.projectId,
        agent: input.agent,
        ...(input.masterAgent ? { masterAgent: input.masterAgent } : {}),
        workIssue: input.workIssue,
        ...(input.emailThread ? { emailThread: input.emailThread } : {}),
        ...(input.lane === "quick" ? { lane: "quick" as const } : {}),
        owner,
        generation: 1,
        state: "queued",
        createdAt: now,
        updatedAt: now,
        heartbeatAt: 0,
        progress: null,
        messages: [
          { id: input.requestId, role: "user", text: input.text, at: now },
        ],
      };
      // Persist creation intent before crossing objects; an orphan cannot disappear
      // from the queue when the response is lost.
      this.storage.sql.exec(
        "INSERT INTO conversation_index(id,payload,owner,revision,seed) VALUES(?,?,NULL,0,?)",
        run.id,
        JSON.stringify(summary(run)),
        JSON.stringify({ run, screenshots: input.screenshots ?? [] }),
      );
      try {
        return this.remember(await this.stub(run.id).initialize(run, null, input.screenshots));
      } catch (error) {
        this.ready = undefined;
        throw error;
      }
    });
  }
  message(id: string, input: MessageInput) {
    return this.select(async () => {
      const run = await this.get(id);
      if (!run) throw Error("Conversation not found.");
      if (
        !activeRun(run.state) &&
        !run.messages.some((m) => m.id === input.requestId)
      ) {
        await this.refreshActive();
        this.capacity(run.lane ?? "standard");
      }
      await this.stub(id).message(id, input);
      return (await this.get(id))!;
    });
  }
  async screenshot(id: string, screenshotId: string, owner?: string, generation?: number) {
    const image = await this.stub(id).screenshot(id, screenshotId, owner, generation);
    return image ? { metadata: image.metadata, bytes: image.bytes } : null;
  }
  async cancel(id: string) {
    if (!(await this.get(id))) throw Error("Conversation not found.");
    await this.stub(id).cancel(id);
    return (await this.get(id))!;
  }
  async archive(id: string, archived: boolean) {
    if (!(await this.get(id))) return null;
    await this.stub(id).archive(id, archived);
    return this.get(id);
  }
  claim(
    owner: string,
    activeRunIds: string[] = [],
    lanes: Lane[] = ["standard", "quick"],
    host: RunnerHost,
  ): Promise<Run | null> {
    return this.select(async () => {
      await this.migrate();
      this.contact(host);
      const slot = this.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM runner_slots WHERE owner=?",
          owner,
        )
        .toArray()[0];
      // Recovery of this runner's own active claims ignores lanes; new work is
      // taken only in a lane with a free slot on this machine. A conversation
      // stays with the runner that first claimed it, where its native sessions
      // and worktrees live; new ones go to the first machine in order that is
      // present.
      const accepted = [...new Set(lanes)];
      const unclaimed = this.machines.takesNewWork(host) ? 1 : 0;
      const rows = this.storage.sql
        .exec<IndexRow>(
          `SELECT * FROM conversation_index WHERE
        (owner=? AND json_extract(payload,'$.state') IN ('running','cancelling')) OR
        ((owner=? OR (owner IS NULL AND ?)) AND json_extract(payload,'$.state')='queued'
          AND COALESCE(json_extract(payload,'$.lane'),'standard') IN (${accepted.map(() => "?").join(",")}))
        ORDER BY (owner=?) DESC,json_extract(payload,'$.updatedAt')`,
          owner,
          owner,
          unclaimed,
          ...accepted,
          owner,
        )
        .toArray();
      const ids = [
        ...new Set([...(slot ? [slot.id] : []), ...rows.map((row) => row.id)]),
      ];
      for (const id of ids) {
        // A runner acknowledges running conversations in its next serial claim.
        // Do not dispatch them twice. An ambiguous reply is absent from this
        // list, so its durable reservation is retried before taking more work.
        if (activeRunIds.includes(id)) continue;
        // Reserve before RPC. On ambiguous delivery, the same runner visits this
        // same conversation first. The conversation enforces exclusive ownership.
        this.storage.sql.exec(
          "INSERT INTO runner_slots(owner,id) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET id=excluded.id",
          owner,
          id,
        );
        const run = await this.stub(id).claim(owner, host);
        await this.get(id);
        if (run) return run;
        this.storage.sql.exec(
          "DELETE FROM runner_slots WHERE owner=? AND id=?",
          owner,
          id,
        );
      }
      return null;
    });
  }
  // When each machine's runner last called, so the page can offer to
  // continue a conversation whose machine is away on another one.
  runners() {
    return Object.fromEntries(
      this.storage.sql
        .exec<{ host: string; at: number }>("SELECT host,at FROM runner_contact")
        .toArray()
        .map((row) => [row.host, row.at]),
    ) as Record<string, number>;
  }
  // Serialized with claims, so the conversation's machine cannot claim
  // between the check and the move.
  move(id: string): Promise<Run | "machine-present" | null> {
    return this.select(async () => {
      const run = await this.get(id);
      if (!run) return null;
      // Conversations from before machines were recorded ran on the first.
      const host = run.host ?? (run.progress ? this.machines.first() : null);
      if (!host) return run;
      if (!this.machines.runnerAway(host)) return "machine-present";
      await this.stub(id).move(id, host);
      return (await this.get(id))!;
    });
  }
  async heartbeat(
    owner: string,
    id: string,
    generation: number,
    host: RunnerHost,
  ) {
    this.contact(host);
    if (!(await this.get(id))) return null;
    const result = await this.stub(id).heartbeat(owner, id, generation);
    await this.get(id);
    return result;
  }
  async report(
    owner: string,
    id: string,
    generation: number,
    progress: Progress,
    host: RunnerHost,
    recorded?: (progress: Progress) => void,
  ) {
    this.contact(host);
    if (!(await this.get(id))) return false;
    const accepted = await this.stub(id).report(
      owner,
      id,
      generation,
      progress,
    );
    const current = await this.get(id);
    if (accepted && current?.progress) recorded?.(current.progress);
    return accepted;
  }
}

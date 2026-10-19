import { readFile, mkdir, open, unlink, stat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { executionSettingsSchema } from "../src/codex-metrics";
import {
  decodeScreenshots,
  screenshotInputSchema,
} from "../src/screenshot-model";
import { machineSecret } from "../collector/collect";
import {
  laneSchema,
  progressSchema,
  type Lane,
  type Progress,
  type RunMessage,
} from "../src/run-model";
import { executeRun, savePrivate } from "./engine";
import { connectorAccess } from "./connectors";
import { Failure } from "./native";
import { pruneSaved, registry, savedRuns } from "./workspaces";
import { runPool, type ClaimedRun } from "./pool";
import { readDocument } from "./documents";
import { documentJobSchema } from "../src/document-model";
import { installedRelease, loadConfig, type Config } from "./config";
import { telemetry, type TelemetryFields } from "../src/telemetry";

type Route =
  | "/api/runner/claim"
  | "/api/runner/heartbeat"
  | "/api/runner/report"
  | "/api/runner/browser"
  | "/api/runner/screenshot"
  | "/api/runner/document";
type Body = {
  runnerId: string;
  activeRunIds?: string[];
  lanes?: Lane[];
  id?: string;
  generation?: number;
  progress?: Progress;
  screenshotId?: string;
  documents?: boolean;
  lease?: string;
  content?: string;
  failure?: string;
};
// The Worker's runner API. A failure is logged when it starts and at each
// doubling of attempts, and its recovery once, so an outage cannot flood logs.
function client(endpoint: URL, token: string) {
  const failures = new Map<string, { attempt: number; at: number }>();
  return async function post(route: Route, body: Body) {
    const started = performance.now();
    const failureKey = `${route}:${body.id ?? "pool"}`;
    let response: Response | undefined;
    const context: TelemetryFields = {
      route,
      // A document's id is not a conversation's.
      runId: route === "/api/runner/document" ? undefined : body.id,
      generation: body.generation,
      seq: body.progress?.seq,
    };
    try {
      response = await fetch(new URL(route, endpoint), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Failure(
          "report_failed",
          `Runner request failed (${response.status}).`,
        );
      const result = (await response.json()) as Record<string, unknown>;
      const failure = failures.get(failureKey);
      if (failure) {
        telemetry("runner", "runner_request_recovered", {
          ...context,
          attempt: failure.attempt,
          durationMs: Math.max(0, Date.now() - failure.at),
        });
        failures.delete(failureKey);
      }
      return result;
    } catch (error) {
      const failure = failures.get(failureKey) ?? {
        attempt: 0,
        at: Date.now(),
      };
      failure.attempt++;
      failures.set(failureKey, failure);
      if (Number.isInteger(Math.log2(failure.attempt))) {
        const requestId = z
          .uuid()
          .safeParse(response?.headers.get("X-Projects-Request-Id"));
        telemetry(
          "runner",
          "runner_request_failed",
          {
            ...context,
            attempt: failure.attempt,
            durationMs: Math.round(performance.now() - started),
            status: response?.status,
            requestId: requestId.success ? requestId.data : undefined,
            reason: response?.ok
              ? "invalid_response"
              : response
                ? "http_error"
                : "network_error",
          },
          "warn",
        );
      }
      throw error;
    }
  };
}
type Post = ReturnType<typeof client>;
// Tells the owner a conversation needs a look when its execution could not
// set up or report, keeping the native identity, phase and pending receipt
// that recovery needs.
async function needsInspection(
  config: Config,
  post: Post,
  runnerId: string,
  run: ClaimedRun["run"],
) {
  telemetry(
    "runner",
    "runner_needs_inspection",
    { runId: run.id, generation: run.generation },
    "error",
  );
  let previous = run.progress;
  const file = path.join(config.stateDir, "runs", `${run.id}.json`);
  try {
    previous = progressSchema.parse(
      JSON.parse(await readFile(file, "utf8")).progress,
    );
  } catch {
    /* Preserve the remote receipt if local state is unreadable. */
  }
  const progress: Progress = {
    seq: Math.max(previous?.seq ?? 0, run.progress?.seq ?? 0) + 1,
    state: "blocked",
    summary:
      "This machine's runner could not set up or report this turn. Existing work is kept and nothing was repeated.\n\n**Your move:** Send a follow-up to try again.",
    children:
      previous?.children.map((c) =>
        c.state === "running" ? { ...c, state: "unknown" } : c,
      ) ?? [],
    masterSessionId: previous?.masterSessionId ?? null,
  };
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      await post("/api/runner/report", {
        runnerId,
        id: run.id,
        generation: run.generation,
        progress,
      });
      return;
    } catch {
      await delay(3000);
    }
}
// Executes one claimed conversation: its heartbeat, reports, browser and
// screenshots around the engine.
async function executeClaim(o: {
  config: Config;
  endpoint: URL;
  post: Post;
  runnerId: string;
  claim: ClaimedRun;
  control: AbortController;
  drain: AbortSignal;
  stopping: () => boolean;
}) {
  const { config, endpoint, post, runnerId, claim, control } = o;
  const run = claim.run;
  let heartbeatRequest: Promise<void> | null = null;
  let messages = run.messages;
  let codexFast = false;
  const heartbeat = (): Promise<void> => {
    if (heartbeatRequest) return heartbeatRequest;
    heartbeatRequest = (async () => {
      try {
        const result = await post("/api/runner/heartbeat", {
          runnerId,
          id: run.id,
          generation: run.generation,
        });
        if (result.cancel) control.abort("cancelled");
        codexFast = executionSettingsSchema.parse(result.settings ?? {codexFast: false}).codexFast;
        if (Array.isArray(result.messages))
          messages = result.messages as RunMessage[];
      } catch (error) {
        if (error instanceof Error && /\((401|403|409)\)/.test(error.message))
          control.abort("claim-lost");
        // Network failure alone does not transfer a claim to another runner.
        throw error;
      }
    })().finally(() => {
      heartbeatRequest = null;
    });
    return heartbeatRequest;
  };
  await heartbeat();
  const timer = setInterval(() => void heartbeat().catch(() => {}), 10000);
  const report = async (progress: Progress) => {
    // executeRun persists this exact receipt before asking us to send it.
    // Retrying an ambiguous response is idempotent by generation + seq.
    for (;;) {
      try {
        await post("/api/runner/report", {
          runnerId,
          id: run.id,
          generation: run.generation,
          progress,
        });
        return;
      } catch (e) {
        if (
          o.stopping() ||
          (e instanceof Error && /\((400|401|403|409)\)/.test(e.message))
        )
          throw e;
        await delay(3000);
      }
    }
  };
  try {
    const projects = await registry(config);
    const browser = async () => {
      // A transient grant failure delays setup before any native journal
      // phase changes. It cannot turn unstarted work into an uncertain turn.
      for (;;) {
        control.signal.throwIfAborted();
        try {
          const grant = z
            .object({
              capability: z.string().min(32).max(1024),
              expiresAt: z.number().int().positive(),
            })
            .parse(
              await post("/api/runner/browser", {
                runnerId,
                id: run.id,
                generation: run.generation,
              }),
            );
          const browserEndpoint = new URL(`/api/browser/${run.id}/cdp`, endpoint);
          browserEndpoint.protocol = "wss:";
          const outputDir = path.join(config.stateDir, "browser", run.id);
          await mkdir(outputDir, { recursive: true, mode: 0o700 });
          return {
            endpoint: browserEndpoint.href,
            capability: grant.capability,
            outputDir,
          };
        } catch (error) {
          if (error instanceof Error && /\((400|401|403)\)/.test(error.message))
            throw error;
          // Worker rollback or disabled binding: ordinary coding still works.
          if (error instanceof Error && /\((404|409)\)/.test(error.message))
            break;
          await delay(3000);
        }
      }
    };
    await executeRun({
      run,
      projects,
      stateDir: config.stateDir,
      worktreeRoot: config.worktreeRoot,
      masterCwd: config.masterCwd,
      activity: claim.activity ?? [],
      signal: control.signal,
      drain: o.drain,
      host: config.host,
      agents: config.agents,
      connectors: () => connectorAccess(config.helpers),
      fullAccess: config.helpers.fullAccess,
      inboxAccount: config.inboxAccount,
      workRepo: config.workRepo,
      latestMessages: () => messages,
      report,
      codexFast: async () => { await heartbeat(); return codexFast; },
      contextSelector: {
        mode: config.context.mode,
        gateway: config.context.gateway,
        key: () => machineSecret(config, "JEV_API_KEY"),
      },
      browser,
      screenshot: async (image) => {
        const result = await post("/api/runner/screenshot", {
          runnerId,
          id: run.id,
          generation: run.generation,
          screenshotId: image.id,
        });
        const input = screenshotInputSchema.parse(result.screenshot);
        const [decoded] = await decodeScreenshots([input]);
        if (
          input.id !== image.id ||
          input.mime !== image.mime ||
          decoded.metadata.sha256 !== image.sha256
        )
          throw new Failure(
            "screenshot_failed",
            "Screenshot content could not be verified.",
          );
        return input;
      },
      messages: async () => {
        // A temporary outage delays the next decision, not the native
        // conversation's lifetime. Claim loss/cancellation still wins.
        for (;;) {
          control.signal.throwIfAborted();
          try {
            await heartbeat();
            return messages;
          } catch (error) {
            if (
              control.signal.aborted ||
              (error instanceof Error &&
                /\((400|401|403|409)\)/.test(error.message))
            )
              throw error;
            await delay(3000);
          }
        }
      },
    });
  } catch {
    // No raw agent output, prompt, credential or child environment in logs.
    if (!o.stopping()) await needsInspection(config, post, runnerId, run);
  } finally {
    clearInterval(timer);
  }
}
// Each conversation runs in an executor process of its own, so an update can
// restart the runner at once: executors finish their current step on the
// version they started with, then the new runner continues them. An
// executor's file names its process, lane and conversation while it runs.
const executorsDir = (config: Config) => path.join(config.stateDir, "executors");
const executorFile = (config: Config, runId: string) =>
  path.join(executorsDir(config), `${runId}.json`);
const executorEntry = z
  .object({ pid: z.number().int().positive(), lane: laneSchema })
  .strict();
const exec = promisify(execFile);
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
// The live executor for a conversation, if one is running: its file must
// name a process that is still that conversation's executor.
async function liveExecutor(config: Config, runId: string) {
  try {
    const entry = executorEntry.parse(
      JSON.parse(await readFile(executorFile(config, runId), "utf8")),
    );
    if (!alive(entry.pid)) return null;
    const { stdout } = await exec("ps", ["-o", "command=", "-p", String(entry.pid)]);
    return stdout.includes(`--execute ${runId}`) ? entry : null;
  } catch {
    return null;
  }
}
// Resolves once a conversation's executor, which another runner may have
// started, is no longer running.
function exited(config: Config, runId: string) {
  return new Promise<void>((resolve) => {
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void liveExecutor(config, runId).then((entry) => {
        checking = false;
        if (entry) return;
        clearInterval(timer);
        resolve();
      });
    }, 3000);
    // Waiting never keeps an updating runner from exiting.
    timer.unref();
  });
}
// An executor process: takes its claim and the runner token from its parent
// over a pipe, never the environment, and runs that one conversation.
async function executor(config: Config, endpoint: URL, runId: string) {
  const handoff = z
    .object({
      token: z.string().min(32),
      runnerId: z.uuid(),
      claim: z.looseObject({
        run: z.looseObject({ id: z.literal(runId), lane: laneSchema.optional() }),
      }),
    })
    .parse(
      JSON.parse(
        await new Promise<string>((resolve, reject) => {
          let text = "";
          const input = createReadStream("", { fd: 3 });
          input.setEncoding("utf8");
          input.on("data", (chunk) => {
            text += chunk;
          });
          // The pipe is closed before any agent process can start, so no
          // child inherits the token's descriptor.
          input.on("close", () => resolve(text));
          input.on("error", reject);
        }),
      ),
    );
  const claim = handoff.claim as unknown as ClaimedRun;
  await mkdir(executorsDir(config), { recursive: true, mode: 0o700 });
  // One executor per conversation on this machine.
  const file = executorFile(config, runId);
  for (;;) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, lane: claim.run.lane ?? "standard" }),
      );
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await liveExecutor(config, runId)) return;
      await unlink(file).catch(() => {});
    }
  }
  let stopping = false;
  const control = new AbortController(),
    draining = new AbortController();
  const stop = () => {
    stopping = true;
    control.abort("shutdown");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGUSR2", () => draining.abort("drain"));
  try {
    await executeClaim({
      config,
      endpoint,
      post: client(endpoint, handoff.token),
      runnerId: handoff.runnerId,
      claim,
      control,
      drain: draining.signal,
      stopping: () => stopping,
    });
  } finally {
    const entry = await readFile(file, "utf8").catch(() => "");
    if (entry.includes(`"pid":${process.pid},`)) await unlink(file);
  }
}
async function supervise(config: Config, endpoint: URL, configFile: string) {
  // Read once at start; the token never enters the environment.
  let token: string;
  if (config.tokenFile) {
    if ((await stat(config.tokenFile)).mode & 0o077)
      throw Error("Runner token must be readable only by its owner.");
    token = (await readFile(config.tokenFile, "utf8")).trim();
  } else token = await machineSecret(config, "RUNNER_TOKEN");
  if (token.length < 32) throw Error("Runner token is missing.");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(config.stateDir, "runner.pid");
  try {
    const pid = Number(await readFile(lock, "utf8"));
    if (!Number.isInteger(pid) || pid <= 1)
      throw Error("Runner lock needs inspection.");
    if (alive(pid)) throw Error("Another runner is already active.");
    await unlink(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const handle = await open(lock, "wx", 0o600);
  await handle.writeFile(String(process.pid));
  await handle.close();
  const identity = path.join(config.stateDir, "identity.json");
  let runnerId: string;
  try {
    runnerId = z.uuid().parse(JSON.parse(await readFile(identity, "utf8")).id);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    runnerId = randomUUID();
    await savePrivate(identity, { id: runnerId });
  }
  const post = client(endpoint, token);
  const once = process.argv.includes("--once");
  // The executors this runner knows of, by conversation.
  const executors = new Map<string, number>();
  const signal = (name: NodeJS.Signals) => {
    for (const pid of executors.values())
      try {
        process.kill(pid, name);
      } catch {
        /* Already gone. */
      }
  };
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => {
    telemetry("runner", "runner_stopping");
    stopping = true;
    signal("SIGTERM");
    shutdown.abort("shutdown");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // An update asks for a restart: no new work starts here, each executor
  // pauses at its next step, and this process exits for the new bundle,
  // which adopts the executors still running.
  const draining = new AbortController();
  process.on("SIGUSR2", () => {
    if (draining.signal.aborted) return;
    telemetry("runner", "runner_draining");
    draining.abort("drain");
    signal("SIGUSR2");
  });
  telemetry("runner", "runner_started", {
    concurrency: config.concurrency,
    host: config.host,
    release: installedRelease(),
  });
  // Conversations executing here settle their own copies when a turn ends.
  // For every other conversation this machine ran, copies that nothing needs,
  // such as one whose branch landed after the last turn, are removed when the
  // runner starts and then hourly.
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const project of await registry(config))
        for (const runId of await savedRuns(project.cwd).catch(() => [])) {
          if (shutdown.signal.aborted || draining.signal.aborted) return;
          if (executors.has(runId)) continue;
          try {
            const journal = path.join(config.stateDir, "runs", `${runId}.json`);
            const { children } = progressSchema.parse(
              JSON.parse(await readFile(journal, "utf8")).progress,
            );
            await pruneSaved(project, runId, children, config.worktreeRoot, config.host);
          } catch {
            /* Not run here, or unreadable: its copies stay. */
          }
        }
    } catch {
      /* The next sweep tries again. */
    } finally {
      sweeping = false;
    }
  };
  // A previous runner's executors keep their slots until they finish.
  const adopt = (runId: string, pid: number) => {
    executors.set(runId, pid);
    telemetry("runner", "runner_executor_adopted", { runId });
    return exited(config, runId).finally(() => executors.delete(runId));
  };
  await mkdir(executorsDir(config), { recursive: true, mode: 0o700 });
  const adopted: { id: string; lane: Lane; done: Promise<void> }[] = [];
  for (const name of await readdir(executorsDir(config))) {
    const runId = name.replace(/\.json$/, "");
    if (!z.uuid().safeParse(runId).success) continue;
    const entry = await liveExecutor(config, runId);
    if (entry) adopted.push({ id: runId, lane: entry.lane, done: adopt(runId, entry.pid) });
    else await unlink(executorFile(config, runId)).catch(() => {});
  }
  if (!once) {
    void sweep();
    setInterval(() => void sweep(), 3600_000).unref();
  }
  // Executors that end abnormally, by conversation: a third within ten
  // minutes stops automatic restarts and tells the owner.
  const crashes = new Map<string, number[]>();
  const launch = async (claim: ClaimedRun, control: AbortController) => {
    const runId = claim.run.id;
    const running = await liveExecutor(config, runId);
    if (running) return adopt(runId, running.pid);
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], configFile, "--execute", runId],
      { detached: true, stdio: ["ignore", "inherit", "inherit", "pipe"] },
    );
    const pid = child.pid;
    if (!pid) throw Error("Executor did not start.");
    executors.set(runId, pid);
    child.unref();
    const ended = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    const pipe = child.stdio[3] as NodeJS.WritableStream & { unref?: () => void };
    pipe.end(JSON.stringify({ token, runnerId, claim }));
    pipe.unref?.();
    const forward = () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already gone. */
      }
    };
    control.signal.addEventListener("abort", forward, { once: true });
    const code = await ended;
    executors.delete(runId);
    control.signal.removeEventListener("abort", forward);
    if (code === 0 || stopping) return;
    const now = Date.now();
    const recent = [...(crashes.get(runId) ?? []), now].filter(
      (at) => now - at < 10 * 60_000,
    );
    crashes.set(runId, recent);
    if (recent.length >= 3) {
      crashes.delete(runId);
      await needsInspection(config, post, runnerId, claim.run);
    }
  };
  // An HTML edition the owner opened: read it with this machine's GitHub
  // login and hand it over, or say why not. At most two at once, reserved
  // before asking; a stopping or updating runner starts none and abandons
  // any in flight, whose requests expire for the owner to ask again.
  let fetching = 0;
  const stopDocuments = AbortSignal.any([shutdown.signal, draining.signal]);
  const reserve = () => (fetching < 2 && !stopDocuments.aborted ? (fetching++, true) : false);
  const offered = (reserved: boolean, document: unknown) => {
    const job = documentJobSchema.safeParse(document);
    if (!reserved) return;
    if (!job.success || stopDocuments.aborted) return void fetching--;
    void (async () => {
      try {
        const result = await readDocument(job.data, undefined, stopDocuments);
        if (!stopDocuments.aborted)
          await post("/api/runner/document", { runnerId, id: job.data.id, lease: job.data.lease, ...result });
      } catch {
        /* Logged by post without the document. */
      } finally {
        fetching--;
      }
    })();
  };
  // Claims carry documents; a runner with every slot busy is not claiming,
  // so it asks for them on its own. This timer also keeps a full runner
  // running, since its executors are detached.
  const busy = setInterval(() => {
    if (stopDocuments.aborted) return clearInterval(busy);
    if (executors.size < config.concurrency + config.quickConcurrency) return;
    const reserved = reserve();
    if (!reserved) return;
    void post("/api/runner/document", { runnerId }).then(
      (result) => offered(true, result.document),
      () => offered(true, null),
    );
  }, 3000);
  try {
    await runPool({
      concurrency: config.concurrency,
      quickConcurrency: config.quickConcurrency,
      signal: shutdown.signal,
      drain: draining.signal,
      adopted,
      leave: true,
      once,
      claim: async (activeRunIds, lanes) => {
        const reserved = reserve();
        let claim: Record<string, unknown> = {};
        try {
          claim = await post("/api/runner/claim", {
            runnerId,
            activeRunIds,
            lanes,
            documents: reserved,
          });
        } finally {
          offered(reserved, claim.document);
        }
        return claim.run ? (claim as ClaimedRun) : null;
      },
      // Transport failures are logged by post with conversation correlation.
      onError: () => {},
      execute: once
        ? (claim, control) =>
            executeClaim({
              config,
              endpoint,
              post,
              runnerId,
              claim,
              control,
              drain: draining.signal,
              stopping: () => stopping,
            })
        : launch,
    });
  } finally {
    clearInterval(busy);
    await unlink(lock);
  }
}
async function main() {
  const [configFile = "", ...flags] = process.argv.slice(2);
  const config = await loadConfig(configFile);
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(endpoint.hostname)
    )
  )
    throw Error("Runner endpoint requires HTTPS.");
  const execute = flags.indexOf("--execute");
  if (execute < 0) return supervise(config, endpoint, configFile);
  const runId = z.uuid().parse(flags[execute + 1]);
  try {
    await executor(config, endpoint, runId);
  } catch (error) {
    telemetry("runner", "runner_executor_failed", { runId }, "error");
    throw error;
  }
}
main().catch(() => {
  if (!process.argv.includes("--execute"))
    telemetry("runner", "runner_start_failed", { release: installedRelease() }, "error");
  process.exitCode = 1;
});

import { readFile, mkdir, open, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  decodeScreenshots,
  screenshotInputSchema,
} from "../src/screenshot-model";
import { configSchema, machineSecret } from "../collector/collect";
import {
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
import { telemetry, type TelemetryFields } from "../src/telemetry";

const absolute = z.string().refine(path.isAbsolute);
// Every connected machine runs this with its own config, the same file its
// collector reads. Its paths default beside it.
const schema = configSchema
  .extend({
    concurrency: z.number().int().min(1).max(5).default(3),
    // Extra slots only quick work (email replies, unsubscribes) may use.
    quickConcurrency: z.number().int().min(0).max(5).default(5),
    endpoint: z.url(),
    stateDir: absolute.optional(),
    worktreeRoot: absolute.optional(),
    masterCwd: absolute.optional(),
    // An owner-only file holding this machine's runner token. Without one, a
    // runner-token file beside this config, else RUNNER_TOKEN from the
    // machine's Doppler config.
    tokenFile: absolute.optional(),
    // Local MCP servers Claude helpers may use on this machine, and tools to
    // hide from them as Claude permission rules (mcp__server__tool).
    helpers: z
      .object({
        localServers: z.array(z.string().regex(/^[\w.:-]+$/)).max(50).default([]),
        deniedTools: z
          .array(z.string().regex(/^mcp__[\w-]+(?:__[\w-]+)?$/))
          .max(500)
          .default([]),
      })
      .strict()
      .default({ localServers: [], deniedTools: [] }),
  })
  .transform((config) => {
    const base = path.join(config.home, ".local/share/project-overview");
    return {
      ...config,
      stateDir: config.stateDir ?? path.join(base, "runner"),
      worktreeRoot: config.worktreeRoot ?? path.join(base, "worktrees"),
      masterCwd: config.masterCwd ?? config.root,
      // Doppler supplies the token only when no file is named or present.
      tokenFile:
        config.tokenFile ??
        (config.doppler && !existsSync(path.join(base, "runner-token"))
          ? null
          : path.join(base, "runner-token")),
    };
  });
async function main() {
  const config = schema.parse(
    JSON.parse(await readFile(process.argv[2] ?? "", "utf8")),
  );
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(endpoint.hostname)
    )
  )
    throw Error("Runner endpoint requires HTTPS.");
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
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive) throw Error("Another runner is already active.");
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
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => {
    telemetry("runner", "runner_stopping");
    stopping = true;
    shutdown.abort("shutdown");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // An update asks for a restart at the next pause: no new work starts, each
  // conversation saves its place between turns, then the process exits and
  // launchd starts the new bundle. Work still running after twenty minutes
  // stops as on SIGTERM and is recovered from its own native session.
  const draining = new AbortController();
  process.on("SIGUSR2", () => {
    if (draining.signal.aborted) return;
    telemetry("runner", "runner_draining");
    draining.abort("drain");
    setTimeout(stop, 20 * 60_000).unref();
  });
  const failures = new Map<string, { attempt: number; at: number }>();
  async function post(
    route:
      | "/api/runner/claim"
      | "/api/runner/heartbeat"
      | "/api/runner/report"
      | "/api/runner/browser"
      | "/api/runner/screenshot",
    body: {
      runnerId: string;
      activeRunIds?: string[];
      lanes?: Lane[];
      id?: string;
      generation?: number;
      progress?: Progress;
      screenshotId?: string;
    },
  ) {
    const started = performance.now();
    const failureKey = `${route}:${body.id ?? "pool"}`;
    let response: Response | undefined;
    const context: TelemetryFields = {
      route,
      runId: body.id,
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
      // Exponential log suppression preserves first failure and recovery while
      // avoiding an unbounded log flood throughout an extended network outage.
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
  }
  telemetry("runner", "runner_started", {
    concurrency: config.concurrency,
    host: config.host,
  });
  // Conversations executing here settle their own copies when a turn ends.
  // For every other conversation this machine ran, copies that nothing needs,
  // such as one whose branch landed after the last turn, are removed when the
  // runner starts and then hourly.
  const executing = new Set<string>();
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const project of await registry(config))
        for (const runId of await savedRuns(project.cwd).catch(() => [])) {
          if (shutdown.signal.aborted || draining.signal.aborted) return;
          if (executing.has(runId)) continue;
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
  if (!process.argv.includes("--once")) {
    void sweep();
    setInterval(() => void sweep(), 3600_000).unref();
  }
  try {
    await runPool({
      concurrency: config.concurrency,
      quickConcurrency: config.quickConcurrency,
      signal: shutdown.signal,
      drain: draining.signal,
      once: process.argv.includes("--once"),
      claim: async (activeRunIds, lanes) => {
        const claim = await post("/api/runner/claim", {
          runnerId,
          activeRunIds,
          lanes,
        });
        return claim.run ? (claim as ClaimedRun) : null;
      },
      // Transport failures are logged by post with conversation correlation.
      onError: () => {},
      execute: async (claim, control) => {
        const run = claim.run;
        let heartbeatRequest: Promise<void> | null = null;
        let messages = run.messages;
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
              if (Array.isArray(result.messages))
                messages = result.messages as RunMessage[];
            } catch (error) {
              if (
                error instanceof Error &&
                /\((401|403|409)\)/.test(error.message)
              )
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
        const timer = setInterval(
          () => void heartbeat().catch(() => {}),
          10000,
        );
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
                stopping ||
                (e instanceof Error && /\((400|401|403|409)\)/.test(e.message))
              )
                throw e;
              await delay(3000);
            }
          }
        };
        executing.add(run.id);
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
                const browserEndpoint = new URL(
                  `/api/browser/${run.id}/cdp`,
                  endpoint,
                );
                browserEndpoint.protocol = "wss:";
                const outputDir = path.join(config.stateDir, "browser", run.id);
                await mkdir(outputDir, { recursive: true, mode: 0o700 });
                return {
                  endpoint: browserEndpoint.href,
                  capability: grant.capability,
                  outputDir,
                };
              } catch (error) {
                if (
                  error instanceof Error &&
                  /\((400|401|403)\)/.test(error.message)
                )
                  throw error;
                // Worker rollback or disabled binding: ordinary coding still works.
                if (
                  error instanceof Error &&
                  /\((404|409)\)/.test(error.message)
                )
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
            drain: draining.signal,
            host: config.host,
            agents: config.agents,
            connectors: () => connectorAccess(config.helpers),
            inboxAccount: config.inboxAccount,
            workRepo: config.workRepo,
            latestMessages: () => messages,
            report,
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
              "Runner setup or delivery needs inspection. Existing work was retained; automatic replay is disabled.",
            children:
              previous?.children.map((c) =>
                c.state === "running" ? { ...c, state: "unknown" } : c,
              ) ?? [],
            masterSessionId: previous?.masterSessionId ?? null,
          };
          // Do not overwrite the native identity, phase or pending receipt when
          // delivery/setup fails. They are the evidence needed for recovery.
          if (!stopping) await report(progress);
        } finally {
          executing.delete(run.id);
          clearInterval(timer);
        }
      },
    });
  } finally {
    await unlink(lock);
  }
}
main().catch(() => {
  telemetry("runner", "runner_start_failed", {}, "error");
  process.exitCode = 1;
});

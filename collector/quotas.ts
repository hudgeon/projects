import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { quotaSchema, type Quota } from "../src/model";

const exec = promisify(execFile);
const windowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number(),
  resetsAt: z.number().int().positive(),
});
const bucketSchema = z.object({
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
});
export function codexWeekly(input: unknown, observedAt = Date.now()): Quota {
  const response = z
    .object({
      rateLimits: bucketSchema.nullish(),
      rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullish(),
    })
    .parse(input);
  // Other model buckets must not be presented as the main subscription.
  const bucket = response.rateLimitsByLimitId
    ? response.rateLimitsByLimitId.codex
    : response.rateLimits;
  const weekly = [bucket?.primary, bucket?.secondary].find(
    (w) => w?.windowDurationMins === 7 * 24 * 60,
  );
  return weekly
    ? quotaSchema.parse({
        state: "ok",
        observedAt,
        weekly: {
          usedPercent: weekly.usedPercent,
          resetsAt: weekly.resetsAt * 1000,
        },
      })
    : { state: "unavailable", observedAt, reason: "no_weekly_limit" };
}
export function claudeWeekly(input: unknown, observedAt = Date.now()): Quota {
  const response = z
    .object({
      seven_day: z
        .object({
          utilization: z.number().min(0).max(100),
          resets_at: z.string().datetime({ offset: true }),
        })
        .nullish(),
    })
    .parse(input);
  return response.seven_day
    ? quotaSchema.parse({
        state: "ok",
        observedAt,
        weekly: {
          usedPercent: response.seven_day.utilization,
          resetsAt: Date.parse(response.seven_day.resets_at),
        },
      })
    : { state: "unavailable", observedAt, reason: "no_weekly_limit" };
}

// Read-only RPC: no thread or model turn is started. Do not reuse the runner's
// execution transport here: this short-lived process has no execution access.
export function codexLimits(env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let bytes = 0,
      buffer = "",
      settled = false;
    const done = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message: unknown) =>
      child.stdin.write(JSON.stringify(message) + "\n");
    const timer = setTimeout(
      () => done(Error("Quota read unavailable")),
      20_000,
    );
    child.once("error", () => done(Error("Quota read unavailable")));
    child.once("close", () => done(Error("Quota read unavailable")));
    child.stdin.on("error", () => done(Error("Quota read unavailable")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256_000) return done(Error("Quota read unavailable"));
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"),
          line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) return done(Error("Quota read unavailable"));
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
          } else if (message.id === 2)
            return message.error
              ? done(Error("Quota read unavailable"))
              : done(undefined, message.result);
        } catch {
          return done(Error("Quota read unavailable"));
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "projects_quota_reader", version: "1.0.0" },
      },
    });
  });
}

type QuotaFailure = NonNullable<
  Extract<Quota, { state: "unavailable" | "unsupported" }>["reason"]
>;
export class QuotaReadError extends Error {
  constructor(readonly reason: QuotaFailure) {
    super("Quota read unavailable");
  }
}

// Credentials stay on their native machine, in memory for this one HTTPS read.
// Expired logins are left to the native app; no refresh or rotation is attempted.
async function claudeCredentials(home: string, env: NodeJS.ProcessEnv) {
  return process.platform === "darwin"
    ? (
        await exec(
          "/usr/bin/security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { env, timeout: 8000, maxBuffer: 256_000 },
        )
      ).stdout
    : await (async () => {
        const file = path.join(home, ".claude", ".credentials.json");
        const info = await stat(file);
        if (!info.isFile() || info.size > 256_000 || info.mode & 0o077)
          throw Error("Quota read unavailable");
        return readFile(file, "utf8");
      })();
}
export async function claudeLimits(
  home: string,
  env: NodeJS.ProcessEnv,
  io = { credentials: () => claudeCredentials(home, env), request: fetch },
): Promise<unknown> {
  let raw: string;
  try {
    raw = await io.credentials();
  } catch {
    throw new QuotaReadError("login_unavailable");
  }
  const auth = z
    .object({
      claudeAiOauth: z.object({
        accessToken: z.string().min(1),
        expiresAt: z.number(),
      }),
    })
    .parse(JSON.parse(raw)).claudeAiOauth;
  if (auth.expiresAt <= Date.now()) throw new QuotaReadError("login_expired");
  const response = await io.request(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new QuotaReadError(
      response.status === 401
        ? "login_expired"
        : response.status === 429
          ? "rate_limited"
          : "provider_rejected",
    );
  const body = await response.text();
  if (body.length > 64_000) throw Error("Quota read unavailable");
  return JSON.parse(body);
}

export async function readQuotas(
  home: string,
  agents: string[],
  env: NodeJS.ProcessEnv,
  readers = {
    codex: () => codexLimits(env),
    claude: () => claudeLimits(home, env),
  },
) {
  const read = async (provider: "codex" | "claude"): Promise<Quota> => {
    if (!agents.includes(provider))
      return { state: "unsupported", observedAt: Date.now() };
    try {
      return (provider === "codex" ? codexWeekly : claudeWeekly)(
        await readers[provider](),
      );
    } catch (error) {
      return {
        state: "unavailable",
        observedAt: Date.now(),
        reason: error instanceof QuotaReadError ? error.reason : "read_failed",
      };
    }
  };
  const [codex, claude] = await Promise.all([read("codex"), read("claude")]);
  return { codex, claude };
}

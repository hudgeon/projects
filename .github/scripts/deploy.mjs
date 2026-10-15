import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { unstable_readConfig } from "wrangler";
import { requiredSecretNames } from "./wrangler-config.mjs";

export class ReleaseFailure extends Error {
  constructor(reason, retryable = false, status) {
    super(reason);
    this.reason = reason;
    this.retryable = retryable;
    this.status = status;
  }
}

// Only classify explicit API/transport failures, never build, auth or gate errors.
export function commandFailure(output, signal) {
  if (signal) return new ReleaseFailure("command_interrupted");
  const text = stripVTControlCharacters(output);
  const statuses = [
    ...text.matchAll(
      /(?:GET|POST|PUT|PATCH|DELETE) \/accounts\/\S+ -> (\d{3})\b/g,
    ),
  ];
  const status = Number(statuses.at(-1)?.[1]) || undefined;
  if (
    statuses.some(
      (match) =>
        Number(match[1]) >= 400 &&
        Number(match[1]) < 500 &&
        Number(match[1]) !== 429,
    )
  )
    return new ReleaseFailure("command_failed", false, status);
  if (status === 429 || status >= 500)
    return new ReleaseFailure("cloudflare_http", true, status);
  if (
    status === 200 &&
    text.includes("Received a malformed response from the API")
  )
    return new ReleaseFailure("cloudflare_invalid_json", true, status);
  if (
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b/.test(
      text,
    )
  )
    return new ReleaseFailure("cloudflare_transport", true);
  return new ReleaseFailure("command_failed", false, status);
}

export async function retry(
  stage,
  action,
  { sleep = delay, log = console.info, attempts = 4 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    const emit = (event, fields = {}) =>
      log(
        JSON.stringify({
          schemaVersion: 1,
          component: "deployment",
          at: Date.now(),
          event,
          stage,
          attempt,
          durationMs: Date.now() - started,
          ...fields,
        }),
      );
    emit("stage_started");
    try {
      const result = await action();
      emit("stage_completed");
      return result;
    } catch (error) {
      const failure =
        error instanceof ReleaseFailure
          ? error
          : new ReleaseFailure("unexpected_failure");
      emit("stage_failed", { reason: failure.reason, status: failure.status });
      if (!failure.retryable || attempt === attempts) throw failure;
      const waitMs = Math.min(15_000 * 2 ** (attempt - 1), 60_000);
      emit("stage_retry", {
        reason: failure.reason,
        status: failure.status,
        waitMs,
      });
      await sleep(waitMs);
    }
  }
}

function command(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        target.write(chunk);
        tail = (tail + chunk.toString()).slice(-65_536);
      });
    }
    child.on("error", () => reject(new ReleaseFailure("command_start_failed")));
    child.on("close", (code, signal) =>
      code === 0 ? resolve() : reject(commandFailure(tail, signal)),
    );
  });
}

function requireMatch(condition, reason) {
  if (!condition) throw new ReleaseFailure(reason);
}

export async function verifyProduction({
  config,
  versionId,
  tag,
  account,
  token,
  runnerToken,
  fetcher = fetch,
  read = readFile,
  ...retryOptions
}) {
  const worker = encodeURIComponent(config.name);
  const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/`;
  const request = async (
    stage,
    url,
    headers = {},
    json = false,
    validate,
    attempts = 4,
  ) =>
    retry(
      stage,
      async () => {
        let response, text;
        try {
          response = await fetcher(url, {
            headers,
            signal: AbortSignal.timeout(20_000),
            redirect: "error",
          });
          text = await response.text();
        } catch {
          throw new ReleaseFailure("network_error", true);
        }
        if (response.status === 429 || response.status >= 500)
          throw new ReleaseFailure("cloudflare_http", true, response.status);
        if (!json) {
          const result = { response, text };
          validate?.(result);
          return result;
        }
        requireMatch(response.ok, "cloudflare_read_rejected");
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new ReleaseFailure(
            "cloudflare_invalid_json",
            true,
            response.status,
          );
        }
        requireMatch(
          body.success === true && body.result,
          "cloudflare_read_rejected",
        );
        return body.result;
      },
      { ...retryOptions, attempts },
    );
  const api = (stage, resource) =>
    request(
      stage,
      apiRoot + resource,
      { Authorization: `Bearer ${token}` },
      true,
    );
  const deployments = await api(
    "verify_version",
    `scripts/${worker}/deployments`,
  );
  const active = deployments.deployments?.[0]?.versions;
  requireMatch(
    active?.length === 1 &&
      active[0].version_id === versionId &&
      active[0].percentage === 100,
    "deployed_version_mismatch",
  );
  const version = await api(
    "verify_commit",
    `scripts/${worker}/versions/${versionId}`,
  );
  requireMatch(
    version.annotations?.["workers/tag"] === tag,
    "deployed_commit_mismatch",
  );
  const settings = await api("verify_settings", `workers/${worker}`);
  requireMatch(
    settings.subdomain?.enabled === config.workers_dev &&
      settings.subdomain?.previews_enabled === config.preview_urls,
    "subdomain_settings_mismatch",
  );
  const expected = config.observability,
    actual = settings.observability;
  requireMatch(
    actual?.enabled === expected.enabled &&
      actual.redact_query_string === expected.redact_query_string &&
      actual.logs?.enabled === expected.logs.enabled &&
      actual.logs.head_sampling_rate === expected.logs.head_sampling_rate &&
      actual.logs.invocation_logs === expected.logs.invocation_logs &&
      actual.logs.persist !== false &&
      actual.traces?.enabled === expected.traces.enabled &&
      actual.traces.head_sampling_rate === expected.traces.head_sampling_rate &&
      actual.traces.persist !== false,
    "observability_settings_mismatch",
  );
  const secrets = await api("verify_secrets", `scripts/${worker}/secrets`);
  requireMatch(
    Array.isArray(secrets) &&
      JSON.stringify(secrets.map((s) => s.name).sort()) ===
        JSON.stringify([...config.secrets.required].sort()),
    "secret_bindings_mismatch",
  );

  const domain = config.routes.find((r) => r.custom_domain)?.pattern;
  requireMatch(
    typeof domain === "string" && /^[a-z0-9.-]+$/.test(domain),
    "invalid_production_domain",
  );
  const origin = `https://${domain}`;
  const localHtml = await read(
    path.join(config.assets.directory, "index.html"),
    "utf8",
  );
  const asset = localHtml.match(/src="(\/assets\/[A-Za-z0-9_-]+\.js)"/)?.[1];
  requireMatch(asset, "built_asset_missing");
  await request("verify_http", origin, {}, false, (root) => {
    requireMatch(
      root.response.status === 200 &&
        root.response.headers.get("X-Projects-Request-Id"),
      "production_http_mismatch",
    );
    // The control plane can confirm the new version before the public edge
    // serves its HTML. Retry only this bounded rollout mismatch; exact asset
    // bytes, authorization, privacy settings and release gates still must pass.
    if (!root.text.includes(`src="${asset}"`))
      throw new ReleaseFailure("production_html_rollout_pending", true);
  });
  const local = await read(
    path.join(config.assets.directory, asset.slice(1)),
    "utf8",
  );
  await request(
    "verify_asset",
    origin + asset,
    {},
    false,
    ({ response, text }) => {
      if (response.status === 200 && text === local) return;
      // An edge still on the previous version has no file at this hashed
      // path, so the Worker serves the single-page fallback (index.html).
      // Retry only that bounded rollout race; the exact built bytes must
      // still be served.
      if (
        response.status === 200 &&
        response.headers.get("X-Projects-Request-Id") &&
        response.headers.get("Content-Type")?.startsWith("text/html")
      )
        throw new ReleaseFailure("production_asset_rollout_pending", true);
      throw new ReleaseFailure(
        "production_asset_mismatch",
        false,
        response.status,
      );
    },
  );
  const anonymous = await request("verify_auth", origin + "/api/runs");
  const runner = await request(
    "verify_runner_isolation",
    origin + "/api/runs",
    { Authorization: `Bearer ${runnerToken}` },
  );
  requireMatch(
    anonymous.response.status === 401 && runner.response.status === 401,
    "reader_auth_mismatch",
  );
  await request(
    "verify_runtime",
    `${origin}/api/readiness?version=${encodeURIComponent(versionId)}`,
    {},
    false,
    ({ response, text }) => {
      let status;
      try {
        status = JSON.parse(text);
      } catch {
        throw new ReleaseFailure("runtime_invalid_response");
      }
      if (
        response.status !== 200 ||
        status.ready !== true
      )
        throw new ReleaseFailure("runtime_rollout_pending", true);
    },
    8,
  );
  return {
    worker: config.name,
    versionId,
    tag,
    asset,
    tracesSampleRate: actual.traces.head_sampling_rate,
  };
}

async function main() {
  const secretsFile = process.argv[2],
    sha = process.env.GITHUB_SHA;
  requireMatch(
    secretsFile && /^[0-9a-f]{40}$/.test(sha ?? ""),
    "missing_release_identity",
  );
  const config = unstable_readConfig({});
  requireMatch(
    config.name === "project-overview" &&
      process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_API_TOKEN,
    "missing_release_configuration",
  );
  config.secrets = { required: requiredSecretNames() };
  const tag = `sha-${sha.slice(0, 12)}`;
  const temporary = await mkdtemp(
    path.join(process.env.RUNNER_TEMP || tmpdir(), "projects-deploy-"),
  );
  const output = path.join(temporary, "wrangler.ndjson");
  const changed = path.join(temporary, "bindings-changed");
  try {
    const publish = () =>
      retry("deploy", async () => {
        await writeFile(output, "", { mode: 0o600 });
        await command(
          [
            "node_modules/wrangler/bin/wrangler.js",
            "deploy",
            "--secrets-file",
            secretsFile,
            "--tag",
            tag,
            "--durable-objects-code-update-mode",
            "immediate",
          ],
          { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output },
        );
      });
    await publish();
    await retry("reconcile_secrets", () =>
      command([".github/scripts/prune-secrets.mjs", changed]),
    );
    // Pruning is itself a deployment. Publish after it only when it ran, so the
    // receipt below still identifies the exact version checked by the verifier.
    if (
      await readFile(changed).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      await publish();
    const receipt = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast(
        (row) => row.type === "deploy" && row.worker_name === config.name,
      );
    requireMatch(
      receipt?.version_id && /^[0-9a-f-]{36}$/.test(receipt.version_id),
      "missing_deploy_receipt",
    );
    await retry("promote_objects", () =>
      command([
        "node_modules/wrangler/bin/wrangler.js",
        "versions",
        "deploy",
        `${receipt.version_id}@100`,
        "--durable-objects-code-update-mode",
        "immediate",
        "--yes",
      ]),
    );
    const result = await verifyProduction({
      config,
      versionId: receipt.version_id,
      tag,
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      // A well-formed token no machine holds must be refused like no token.
      runnerToken: randomBytes(32).toString("hex"),
    });
    console.info(
      JSON.stringify({
        schemaVersion: 1,
        component: "deployment",
        at: Date.now(),
        event: "release_verified",
        ...result,
        commit: sha,
      }),
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## Verified Projects release\n\nCommit: \`${sha}\`\n\nWorker version: \`${result.versionId}\` (100% traffic)\n\nCode, deployed assets, reader isolation, secret allowlist and observability settings verified. Traces sampled at ${result.tracesSampleRate * 100}%. Use this version in Cloudflare Observability to compare releases.\n`,
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        schemaVersion: 1,
        component: "deployment",
        at: Date.now(),
        event: "release_failed",
        reason:
          error instanceof ReleaseFailure ? error.reason : "unexpected_failure",
      }),
    );
    process.exitCode = 1;
  });
}

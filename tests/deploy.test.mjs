import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  commandFailure,
  retry,
  verifyProduction,
} from "../.github/scripts/deploy.mjs";

const gateway =
  "Received a malformed response from the API\n  POST /accounts/example/workers/scripts/project-overview/subdomain -> 504 Gateway Timeout";
test("release retries transient API failures with backoff and safe attempt logs", async () => {
  let calls = 0;
  const waits = [],
    logs = [];
  const result = await retry(
    "deploy",
    async () => {
      if (++calls < 3)
        throw commandFailure(gateway + " private-token private-payload");
      return "verified";
    },
    {
      sleep: async (ms) => waits.push(ms),
      log: (line) => logs.push(JSON.parse(line)),
    },
  );
  assert.equal(result, "verified");
  assert.deepEqual(waits, [15_000, 30_000]);
  assert.equal(logs.filter((row) => row.event === "stage_failed").length, 2);
  assert.equal(logs.at(-1).event, "stage_completed");
  assert.equal(logs.at(-1).attempt, 3);
  assert.ok(logs.every((row) => row.durationMs >= 0 && row.at > 0));
  assert.doesNotMatch(JSON.stringify(logs), /private-|\/accounts/);
});

test("a persistent API outage cannot produce a successful release", async () => {
  let calls = 0;
  const waits = [],
    logs = [];
  await assert.rejects(
    retry(
      "deploy",
      async () => {
        calls++;
        throw commandFailure(gateway);
      },
      {
        sleep: async (ms) => waits.push(ms),
        log: (line) => logs.push(JSON.parse(line)),
      },
    ),
    /cloudflare_http/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [15_000, 30_000, 60_000]);
  assert.equal(
    logs.some((row) => row.event === "stage_completed"),
    false,
  );
});

test("release never retries authorization, build, configuration or interrupted commands", async () => {
  for (const [output, signal] of [
    ["GET /accounts/example/workers/scripts/test -> 403 Forbidden"],
    ["GET /accounts/example/workers/scripts/test -> 400 Bad Request"],
    ["Authentication error [code: 10000]"],
    ["Build failed: Cannot resolve module"],
    ["Invalid Durable Object migration"],
    [gateway, "SIGTERM"],
    [
      gateway +
        "\nGET /accounts/example/workers/scripts/test -> 401 Unauthorized",
    ],
    [
      "GET /accounts/example/workers/scripts/test -> 401 Unauthorized\n" +
        gateway,
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      retry(
        "deploy",
        async () => {
          calls++;
          throw commandFailure(output, signal);
        },
        {
          sleep: async () => assert.fail("Permanent failure retried"),
          log: () => {},
        },
      ),
    );
    assert.equal(calls, 1);
  }
  assert.equal(
    commandFailure(
      "Received a malformed response from the API\nGET /accounts/example/workers/scripts/test/deployments -> 200 OK",
    ).retryable,
    true,
  );
  assert.equal(
    commandFailure(
      "POST /accounts/example/workers/scripts/test -> 429 Too Many Requests",
    ).retryable,
    true,
  );
  assert.equal(commandFailure("fetch failed: ECONNRESET").retryable, true);
});

const versionId = "8053c135-766a-45f6-b94a-bb841a56c731",
  tag = "sha-84acc962b6a7";
function fixture() {
  const observability = {
    enabled: true,
    redact_query_string: true,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
    traces: { enabled: true, head_sampling_rate: 0.1 },
  };
  const config = {
    name: "project-overview",
    workers_dev: false,
    preview_urls: false,
    observability,
    secrets: { required: ["ONE", "TWO"] },
    routes: [{ custom_domain: true, pattern: "projects.example.com" }],
    assets: { directory: "dist/client" },
  };
  const api = new Map([
    [
      "scripts/project-overview/deployments",
      {
        deployments: [
          { versions: [{ version_id: versionId, percentage: 100 }] },
        ],
      },
    ],
    [
      "scripts/project-overview/versions/" + versionId,
      { annotations: { "workers/tag": tag } },
    ],
    [
      "workers/project-overview",
      {
        subdomain: { enabled: false, previews_enabled: false },
        observability: structuredClone(observability),
      },
    ],
    ["scripts/project-overview/secrets", [{ name: "TWO" }, { name: "ONE" }]],
  ]);
  const requests = [];
  const html = '<script type="module" src="/assets/index-abc.js"></script>';
  const options = {
    config,
    versionId,
    tag,
    account: "example",
    token: "private-api",
    runnerToken: "private-runner",
    sleep: async () => {},
    log: () => {},
    read: async (name) =>
      name.endsWith("index.html") ? html : "built javascript",
    fetcher: async (url, init) => {
      requests.push({ url, init });
      if (url.startsWith("https://api.cloudflare.com/")) {
        assert.equal(init.headers.Authorization, "Bearer private-api");
        const result = api.get(url.split("/accounts/example/workers/")[1]);
        assert.ok(result, "Unexpected API route");
        return Response.json({ success: true, result });
      }
      assert.notEqual(init.headers.Authorization, "Bearer private-api");
      if (url.includes("/api/readiness?")) {
        assert.equal(init.headers.Authorization, undefined, "readiness needs no machine token");
        return Response.json({
          ready: new URL(url).searchParams.get("version") === versionId,
        });
      }
      if (url.endsWith("/api/runs"))
        return new Response("Unauthorized", { status: 401 });
      if (url.endsWith(".js")) return new Response("built javascript");
      return new Response(html, {
        headers: { "X-Projects-Request-Id": "correlation" },
      });
    },
  };
  return { options, api, requests };
}

test("production verification ties the live version to the commit, assets, auth and tracing configuration", async () => {
  const { options, requests } = fixture();
  const logs = [];
  options.log = (line) => logs.push(line);
  const proof = await verifyProduction(options);
  assert.deepEqual(proof, {
    worker: "project-overview",
    versionId,
    tag,
    asset: "/assets/index-abc.js",
    tracesSampleRate: 0.1,
  });
  assert.equal(requests.filter((r) => r.url.endsWith("/api/runs")).length, 2);
  assert.deepEqual(
    requests
      .filter((r) => r.url.endsWith("/api/runs"))
      .map((r) => r.init.headers.Authorization),
    [undefined, "Bearer private-runner"],
    "an unknown machine token is refused like no token",
  );
  assert.doesNotMatch(
    logs.join("\n"),
    /private-api|private-runner|Authorization/,
  );
});

test("production verification rejects stale versions and changed privacy or tracing settings", async () => {
  const cases = [
    [
      (f) =>
        (f.api.get(
          "scripts/project-overview/deployments",
        ).deployments[0].versions[0].version_id = "old"),
      "deployed_version_mismatch",
    ],
    [
      (f) =>
        (f.api.get(
          "scripts/project-overview/versions/" + versionId,
        ).annotations["workers/tag"] = "old"),
      "deployed_commit_mismatch",
    ],
    [
      (f) =>
        (f.api.get("workers/project-overview").subdomain.previews_enabled =
          true),
      "subdomain_settings_mismatch",
    ],
    [
      (f) =>
        (f.api.get("workers/project-overview").observability.traces.enabled =
          false),
      "observability_settings_mismatch",
    ],
    [
      (f) =>
        (f.api.get(
          "workers/project-overview",
        ).observability.redact_query_string = false),
      "observability_settings_mismatch",
    ],
    [
      (f) =>
        f.api.get("scripts/project-overview/secrets").push({ name: "EXTRA" }),
      "secret_bindings_mismatch",
    ],
  ];
  for (const [change, reason] of cases) {
    const f = fixture();
    change(f);
    await assert.rejects(verifyProduction(f.options), new RegExp(reason));
  }
});

test("production verification rejects stale assets and unexpected reader access", async () => {
  for (const [match, response, reason] of [
    [
      (url) => url.endsWith(".js"),
      () => new Response("old javascript"),
      "production_asset_mismatch",
    ],
    [
      (url) => url.endsWith("/api/runs"),
      () => new Response("data"),
      "reader_auth_mismatch",
    ],
  ]) {
    const f = fixture(),
      original = f.options.fetcher;
    f.options.fetcher = (url, init) =>
      match(url) ? response() : original(url, init);
    await assert.rejects(verifyProduction(f.options), new RegExp(reason));
  }
});

test("production reads recover from truncated API JSON without exposing the body", async () => {
  const f = fixture(),
    original = f.options.fetcher,
    logs = [];
  let calls = 0;
  f.options.fetcher = (url, init) =>
    ++calls === 1 ? new Response('{"private-token":') : original(url, init);
  f.options.log = (line) => logs.push(line);
  assert.equal((await verifyProduction(f.options)).versionId, versionId);
  assert.match(logs.join("\n"), /cloudflare_invalid_json/);
  assert.doesNotMatch(logs.join("\n"), /private-token/);
});

test("secret reconciliation retains its deployment marker after an unconfirmed update and retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "projects-prune-"));
  const marker = path.join(directory, "changed");
  try {
    await writeFile(
      path.join(directory, "npx"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const root = process.env.PROJECTS_PRUNE_FIXTURE;
if (process.argv[4] === 'list') {
  console.log(JSON.stringify(fs.existsSync(root + '/removed') ? [] : [{name:'EXTRA_FIXTURE'}]));
} else if (process.argv[4] === 'bulk') {
  const input = fs.readFileSync(0, 'utf8');
  if (input !== JSON.stringify({EXTRA_FIXTURE:null})) process.exit(2);
  fs.writeFileSync(root + '/removed', 'yes');
  console.error('POST /accounts/example/workers/scripts/project-overview/secrets -> 504 Gateway Timeout');
  process.exit(1);
} else process.exit(2);
`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: directory + path.delimiter + process.env.PATH,
      PROJECTS_PRUNE_FIXTURE: directory,
    };
    const run = () =>
      execFileSync(
        process.execPath,
        [".github/scripts/prune-secrets.mjs", marker],
        { env, stdio: "pipe" },
      );
    assert.throws(run);
    assert.equal(await readFile(marker, "utf8"), "changed");
    run(); // The remote mutation took effect before its response was lost.
    assert.equal(await readFile(marker, "utf8"), "changed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production verification waits for HTML rollout but never accepts a persistent mismatch", async () => {
  for (const converges of [true, false]) {
    const f = fixture(),
      original = f.options.fetcher,
      waits = [],
      logs = [];
    let roots = 0;
    f.options.sleep = async (ms) => waits.push(ms);
    f.options.log = (line) => logs.push(line);
    f.options.fetcher = (url, init) => {
      if (
        url === "https://projects.example.com" &&
        (++roots === 1 || !converges)
      )
        return new Response(
          '<script src="/assets/old-private-body.js"></script>',
          { headers: { "X-Projects-Request-Id": "correlation" } },
        );
      return original(url, init);
    };
    if (converges) {
      assert.equal(
        (await verifyProduction(f.options)).asset,
        "/assets/index-abc.js",
      );
      assert.equal(roots, 2);
      assert.deepEqual(waits, [15000]);
    } else {
      await assert.rejects(
        verifyProduction(f.options),
        /production_html_rollout_pending/,
      );
      assert.equal(roots, 4);
      assert.deepEqual(waits, [15000, 30000, 60000]);
    }
    assert.doesNotMatch(
      logs.join("\n"),
      /old-private-body|private-api|private-runner/,
    );
  }
});

test("an unexpected production HTTP response is not classified as HTML rollout", async () => {
  for (const response of [
    () => new Response("html"),
    () => new Response("denied", { status: 403 }),
  ]) {
    const f = fixture(),
      original = f.options.fetcher;
    f.options.sleep = async () =>
      assert.fail("Unexpected HTTP behavior retried");
    f.options.fetcher = (url, init) =>
      url === "https://projects.example.com" ? response() : original(url, init);
    await assert.rejects(
      verifyProduction(f.options),
      /production_http_mismatch/,
    );
  }
});

test("production verification waits for asset rollout but never accepts a persistent fallback", async () => {
  for (const converges of [true, false]) {
    const f = fixture(),
      original = f.options.fetcher,
      waits = [],
      logs = [];
    let assets = 0;
    f.options.sleep = async (ms) => waits.push(ms);
    f.options.log = (line) => logs.push(line);
    f.options.fetcher = (url, init) => {
      // An edge still on the previous version serves its index.html instead.
      if (url.endsWith(".js") && (++assets === 1 || !converges))
        return new Response(
          '<script src="/assets/old-private-body.js"></script>',
          {
            headers: {
              "Content-Type": "text/html",
              "X-Projects-Request-Id": "correlation",
            },
          },
        );
      return original(url, init);
    };
    const later = () =>
      f.requests
        .filter((r) => r.url.startsWith("https://projects.example.com/api/"))
        .map((r) => new URL(r.url).pathname);
    if (converges) {
      assert.equal(
        (await verifyProduction(f.options)).asset,
        "/assets/index-abc.js",
      );
      assert.equal(assets, 2);
      assert.deepEqual(waits, [15000]);
      assert.deepEqual(later(), ["/api/runs", "/api/runs", "/api/readiness"]);
    } else {
      await assert.rejects(
        verifyProduction(f.options),
        /production_asset_rollout_pending/,
      );
      assert.equal(assets, 4);
      assert.deepEqual(waits, [15000, 30000, 60000]);
      assert.deepEqual(later(), []);
    }
    assert.doesNotMatch(
      logs.join("\n"),
      /old-private-body|private-api|private-runner/,
    );
  }
});

test("an unexpected asset response is not classified as rollout", async () => {
  const html = { "Content-Type": "text/html" },
    request = { "X-Projects-Request-Id": "correlation" };
  for (const response of [
    () => new Response("old javascript", { headers: request }),
    () => new Response("<html>", { headers: html }),
    () =>
      new Response("<html>", { status: 404, headers: { ...html, ...request } }),
  ]) {
    const f = fixture(),
      original = f.options.fetcher;
    f.options.sleep = async () =>
      assert.fail("Unexpected asset behavior retried");
    f.options.fetcher = (url, init) =>
      url.endsWith(".js") ? response() : original(url, init);
    await assert.rejects(
      verifyProduction(f.options),
      /production_asset_mismatch/,
    );
  }
});

test("release waits for actual object versions and rejects persistent mixed runtimes", async () => {
  for (const converges of [true, false]) {
    const f = fixture(),
      original = f.options.fetcher,
      waits = [];
    let calls = 0;
    f.options.sleep = async (ms) => waits.push(ms);
    f.options.fetcher = (url, init) => {
      if (url.includes("/api/readiness?") && (++calls < 3 || !converges))
        return calls === 1
          ? new Response("Object is updating", { status: 503 })
          : Response.json({ ready: false });
      return original(url, init);
    };
    if (converges) {
      await verifyProduction(f.options);
      assert.equal(calls, 3);
      assert.deepEqual(waits, [15000, 30000]);
    } else {
      await assert.rejects(
        verifyProduction(f.options),
        /runtime_rollout_pending/,
      );
      assert.equal(calls, 8);
      assert.deepEqual(
        waits,
        [15000, 30000, 60000, 60000, 60000, 60000, 60000],
      );
    }
  }
});

test("runtime verification does not retry a malformed readiness response", async () => {
  for (const response of [() => new Response("Invalid")]) {
    const f = fixture(),
      original = f.options.fetcher;
    f.options.sleep = async () =>
      assert.fail("Permanent readiness failure retried");
    f.options.fetcher = (url, init) =>
      url.includes("/api/readiness?") ? response() : original(url, init);
    await assert.rejects(verifyProduction(f.options), /runtime_invalid_response/);
  }
});

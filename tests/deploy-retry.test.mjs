import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFailure, retry } from "../.github/scripts/deploy.mjs";

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


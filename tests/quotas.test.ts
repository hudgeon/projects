import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  codexWeekly,
  claudeWeekly,
  readQuotas,
  codexLimits,
} from "../collector/quotas";
import {
  currentQuota,
  quotaSchema,
  snapshotSchema,
  freshness,
  type Snapshot,
} from "../src/model";
import { subprocessEnv } from "../collector/collect";

const now = Date.now(),
  reset = now + 86400000;
const week = (usedPercent = 25) => ({
  usedPercent,
  windowDurationMins: 10080,
  resetsAt: Math.floor(reset / 1000),
});
test("weekly limits preserve zero and do not substitute another model bucket or a shorter window", () => {
  assert.deepEqual(
    codexWeekly(
      {
        rateLimits: {
          primary: { ...week(), windowDurationMins: 300 },
          secondary: week(0),
        },
      },
      now,
    ),
    {
      state: "ok",
      observedAt: now,
      weekly: { usedPercent: 0, resetsAt: Math.floor(reset / 1000) * 1000 },
    },
  );
  const selected = codexWeekly(
    {
      rateLimitsByLimitId: { codex: { secondary: week(70) } },
      rateLimits: { secondary: week(5) },
    },
    now,
  );
  assert.equal(selected.state === "ok" && selected.weekly.usedPercent, 70);
  assert.equal(
    codexWeekly(
      {
        rateLimitsByLimitId: { other: { secondary: week() } },
        rateLimits: { secondary: week() },
      },
      now,
    ).state,
    "unavailable",
  );
  assert.equal(
    codexWeekly(
      { rateLimits: { primary: { ...week(), windowDurationMins: 300 } } },
      now,
    ).state,
    "unavailable",
  );
  assert.equal(
    claudeWeekly({ seven_day: null, seven_day_sonnet: { utilization: 3 } }, now)
      .state,
    "unavailable",
  );
  assert.deepEqual(
    claudeWeekly(
      {
        seven_day: {
          utilization: 100,
          resets_at: new Date(reset).toISOString(),
        },
        accessToken: "MUST-NOT-LEAVE",
      },
      now,
    ),
    {
      state: "ok",
      observedAt: now,
      weekly: { usedPercent: 100, resetsAt: reset },
    },
  );
  assert.throws(() =>
    claudeWeekly({ seven_day: { utilization: 101, resets_at: "bad" } }, now),
  );
  assert.throws(() =>
    codexWeekly({ rateLimits: { secondary: week(-1) } }, now),
  );
  assert.equal(
    quotaSchema.safeParse({ state: "ok", observedAt: now }).success,
    false,
  );
});

test("a failed read is isolated and provider payloads and secrets never enter a snapshot", async () => {
  const quotas = await readQuotas(
    "/unused",
    ["codex", "claude"],
    subprocessEnv(),
    {
      codex: async () => ({
        rateLimits: { secondary: week() },
        secret: "MUST-NOT-LEAVE",
      }),
      claude: async () => {
        throw Error("MUST-NOT-LEAVE");
      },
    },
  );
  assert.equal(quotas.codex.state, "ok");
  assert.equal(quotas.claude.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(quotas), /MUST-NOT-LEAVE|secret/);
  const unsupported = await readQuotas("/unused", [], subprocessEnv(), {
    codex: async () => {
      throw Error("must not run");
    },
    claude: async () => {
      throw Error("must not run");
    },
  });
  assert.equal(unsupported.codex.state, "unsupported");
  assert.equal(unsupported.claude.state, "unsupported");
});

test("select one newest report including failures; retain staleness and support older snapshots", () => {
  const make = (
    host: string,
    observedAt: number,
    state: "ok" | "unavailable",
  ): Snapshot => ({
    version: 1,
    host,
    collectedAt: observedAt,
    projects: [],
    unassignedSessions: [],
    quotas: {
      codex:
        state === "ok"
          ? { state, observedAt, weekly: { usedPercent: 25, resetsAt: reset } }
          : { state, observedAt },
      claude: { state: "unavailable", observedAt },
    },
  });
  const old = make("studio", now - 600000, "ok"),
    latest = make("laptop", now, "unavailable");
  assert.deepEqual(currentQuota([old, latest], "codex"), {
    host: "laptop",
    state: "unavailable",
    observedAt: now,
  });
  assert.equal(freshness(currentQuota([old], "codex")!.observedAt, now), true);
  assert.equal(currentQuota([], "codex"), null);
  assert.equal(
    snapshotSchema.safeParse({
      version: 1,
      host: "studio",
      collectedAt: now,
      projects: [],
      unassignedSessions: [],
    }).success,
    true,
  );
  assert.equal(
    snapshotSchema.safeParse(make("studio", now, "ok")).success,
    true,
  );
  assert.equal(
    quotaSchema.safeParse({
      state: "unavailable",
      observedAt: now,
      token: "MUST-NOT-LEAVE",
    }).success,
    false,
  );
  const env = subprocessEnv();
  for (const name of [
    "COLLECTOR_TOKEN",
    "RUNNER_TOKEN",
    "DOPPLER_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ])
    assert.equal(env[name], undefined);
});

test("native quota RPC reads limits without creating a thread or model turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-rpc-")),
    log = path.join(dir, "calls.jsonl");
  await writeFile(
    path.join(dir, "codex"),
    `#!/usr/bin/env node
const fs=require('node:fs'), readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{secondary:${JSON.stringify(week())}}}}));});
`,
    { mode: 0o700 },
  );
  try {
    assert.equal(
      codexWeekly(
        await codexLimits({
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
        }),
      ).state,
      "ok",
    );
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    assert.deepEqual(calls, [
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

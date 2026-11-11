import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  childContext,
  contextConversation,
  contextConfigSchema,
  contextVersion,
  EVIDENCE_CHAR_LIMIT,
  HANDOVER_CHAR_LIMIT,
  JEV_MODEL,
  JEV_INPUT_COST_PER_TOKEN,
  judgeContext,
  keptKey,
  rebuildContext,
  type Selector,
} from "../runner/context";
import type { Child, RunMessage } from "../src/run-model";
import { subprocessEnv } from "../collector/collect";
import { nativeEnv } from "../runner/native";

const message = (role: RunMessage["role"], text: string): RunMessage => ({
  id: randomUUID(),
  role,
  text,
  at: 1,
});
const child = (state: Child["state"] = "completed"): Child => ({
  id: randomUUID(),
  projectId: "example/project",
  agent: "codex",
  mode: "change",
  cwd: "/tmp/owned",
  branch: "owned",
  state,
  sessionId: randomUUID(),
  evidence: ["Observed version a; deployment unverified"],
  result: {
    outcome: "completed",
    summary: "A historical report",
    checks: ["A claimed check"],
    links: [],
  },
});
const fixture = () => ({
  messages: [
    message("user", "Draft only; never send."),
    message("master", "May I save that draft?"),
    message("user", "Yes"),
    message("master", "Latest reported position"),
  ],
  children: Array.from({ length: 8 }, () => child()),
  signal: new AbortController().signal,
});
const responder =
  (
    scores: number[],
    change?: (body: Record<string, unknown>) => unknown,
  ): typeof fetch =>
  async () => {
    const body = {
      model: JEV_MODEL,
      answers: Object.fromEntries(
        scores.map((noul, i) => [`keep_${i}`, { type: "noul", noul }]),
      ),
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    return Response.json(change ? change(body) : body);
  };
// One bounded request of seven questions over the shared transport.
const COUNT = 7;
const judge = (selector: Selector, extra: { cached?: unknown; signal?: AbortSignal; state?: unknown } = {}) =>
  judgeContext({
    version: "v1",
    state: extra.state ?? { task: "Fixture task", instructions: fixture().messages.filter((m) => m.role === "user").map((m) => m.text) },
    questions: Object.fromEntries(
      Array.from({ length: COUNT }, (_, i) => [`keep_${i}`, { type: "noul", instructions: `Keep candidate ${i}?` }]),
    ),
    count: COUNT,
    signal: extra.signal ?? new AbortController().signal,
    selector,
    cached: extra.cached,
    trigger: "project-turn",
  });

test("a handover is rebuilt by fixed rules: the request, the newest user messages, the proposals they answered and one line per helper", () => {
  const f = fixture();
  const view = rebuildContext(f.messages, f.children);
  assert.deepEqual(view.conversation, contextConversation(f.messages));
  assert.deepEqual(view.conversation.userInstructions, [f.messages[0], f.messages[2]]);
  assert.deepEqual(view.conversation.latestReportedPosition, f.messages[3]);
  // The approval's proposal travels with it, verbatim; a reply that no user
  // message answered is not replayed.
  assert.deepEqual(view.approvalContext, [f.messages[1]]);
  assert.equal(view.omittedProposals, 0);
  assert.equal(view.version, contextVersion(f.messages, f.children));
  const children = JSON.parse(view.children) as { index: string[]; latest: unknown[] };
  assert.equal(children.index.length, 8);
  assert.deepEqual(children.latest, [], "no report is replayed; the journal keeps them");
  assert.equal(view.children, childContext(f.children));
  assert.equal(view.sources.length, f.messages.length);
  assert.deepEqual(view.childSources.map((c) => c.id), f.children.map((c) => c.id));
  assert.doesNotMatch(JSON.stringify(view), /A claimed check/, "a report's checks come only from the journal");
});

test("a long history keeps the first request and the newest messages within the handover budget, and counts what it omits", () => {
  const messages: RunMessage[] = [message("user", "The original request.")];
  for (let i = 0; i < 40; i++) {
    messages.push(message("master", `PROPOSAL-${i} ${"evidence ".repeat(1_500)}`));
    messages.push(message("user", `APPROVAL-${i} ${"detail ".repeat(100)}`));
  }
  const view = rebuildContext(messages, []);
  const kept = view.conversation.userInstructions;
  assert.equal(kept[0].text, "The original request.");
  assert.equal(kept.at(-1)!.text, messages.at(-1)!.text, "the newest message is always kept");
  assert.ok(kept.slice(1).reduce((n, m) => n + m.text.length, 0) <= HANDOVER_CHAR_LIMIT);
  assert.ok(view.conversation.omittedUserInstructions > 0);
  assert.equal(kept.length + view.conversation.omittedUserInstructions, 41);
  // Every kept approval's proposal is verbatim, newest first within the
  // evidence budget; the rest are counted, never shortened.
  const proposals = view.approvalContext;
  assert.ok(proposals.length > 0);
  assert.ok(proposals.every((p) => p.text.length > 10_000));
  assert.ok(proposals.reduce((n, m) => n + m.text.length, 0) <= EVIDENCE_CHAR_LIMIT);
  assert.equal(proposals.at(-1)!.text.split(" ")[0], "PROPOSAL-39");
  assert.equal(proposals.length + view.omittedProposals, kept.length - 1);
  assert.equal(view.children, "none");
});

test("gateway requests report priced usage without logging or caching payloads", async () => {
  const gateway = { accountId: "a".repeat(32), gatewayId: "example-gateway" };
  const parsed = contextConfigSchema.parse({ mode: "select", gateway });
  let calls = 0;
  const result = await judge({
    mode: parsed.mode,
    gateway: parsed.gateway,
    key: async () => "test-key",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        url,
        `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/custom-typesafe/v1/systemone`,
      );
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-key");
      assert.equal(headers.get("cf-aig-collect-log"), "true");
      assert.equal(headers.get("cf-aig-collect-log-payload"), "false");
      assert.equal(headers.get("cf-aig-skip-cache"), "true");
      assert.equal(headers.get("cf-aig-max-attempts"), "1");
      assert.equal(headers.get("cf-aig-no-wholesale"), "true");
      assert.deepEqual(JSON.parse(headers.get("cf-aig-custom-cost")!), {
        per_token_in: JEV_INPUT_COST_PER_TOKEN,
        per_token_out: 0,
      });
      assert.equal(JEV_INPUT_COST_PER_TOKEN, 0.000000042);
      const metadata = JSON.parse(headers.get("cf-aig-metadata")!);
      assert.match(metadata.selectionId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(metadata, {
        process: "context-selection",
        trigger: "project-turn",
        worker: "projects-runner",
        model: JEV_MODEL,
        selectionId: metadata.selectionId,
      });
      return responder(Array(COUNT).fill(0.5))(url, init);
    },
  });
  assert.equal(result.reason, null);
  assert.equal(result.record?.transport, "gateway");
  assert.equal(result.record?.inputTokens, 100);
  assert.equal(result.cached, false);
  assert.equal(calls, 1);
});

test("failure diagnostics distinguish bounded nested transport causes without retaining raw errors", async () => {
  const cases = [
    [new DOMException("private timeout", "TimeoutError"), "timeout", undefined],
    [
      new TypeError("private host", {
        cause: Object.assign(new Error("private DNS"), { code: "ENOTFOUND" }),
      }),
      "dns",
      "ENOTFOUND",
    ],
    [
      new TypeError("private address", {
        cause: new AggregateError([
          Object.assign(new Error("private socket"), { code: "ECONNREFUSED" }),
        ]),
      }),
      "connect",
      "ECONNREFUSED",
    ],
    [
      Object.assign(new Error("private certificate"), {
        code: "CERT_HAS_EXPIRED",
      }),
      "tls",
      "CERT_HAS_EXPIRED",
    ],
    [
      Object.assign(new Error("private socket"), { code: "UND_ERR_SOCKET" }),
      "socket",
      "UND_ERR_SOCKET",
    ],
    [
      new TypeError("private token", { cause: { code: "private-code" } }),
      "network",
      undefined,
    ],
  ] as const;
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  for (const [error, kind, code] of [
    ...cases,
    [cyclic, "unexpected", undefined] as const,
  ]) {
    let calls = 0,
      selectionId: string | undefined;
    const result = await judge({
      mode: "select",
      gateway: { accountId: "a".repeat(32), gatewayId: "example" },
      key: async () => "private-key",
      fetch: async (_url, init) => {
        calls++;
        selectionId = JSON.parse(
          new Headers(init?.headers).get("cf-aig-metadata")!,
        ).selectionId;
        throw error;
      },
    });
    assert.equal(result.record, undefined);
    assert.equal(result.reason, "service_failed");
    assert.equal(result.failure?.selectionId, selectionId);
    assert.equal(result.failure?.kind, kind);
    assert.equal(result.failure?.errorCode, code);
    assert.equal(result.failure?.stage, "request");
    assert.equal(result.failure?.transport, "gateway");
    assert.equal(result.failure?.timeoutMs, 8000);
    assert.ok(result.failure!.requestBytes > 0);
    assert.equal(result.failure?.candidateCount, COUNT);
    assert.ok(result.failure!.durationMs >= result.failure!.stageDurationMs);
    assert.equal(calls, 1);
    assert.doesNotMatch(
      JSON.stringify(result.failure),
      /private|cause|stack|message|https?:/,
    );
  }
});

test("HTTP and response diagnostics retain only validated correlation IDs and distinguish parsing from validation", async () => {
  const id = randomUUID(),
    providerId = randomUUID();
  const cases = [
    {
      fetch: async () =>
        new Response("private body", {
          status: 429,
          headers: {
            "cf-aig-log-id": id,
            "x-request-id": providerId,
            "cf-ray": "abcdef0123456789-SYD",
          },
        }),
      kind: "http",
      stage: "response",
      status: 429,
    },
    {
      fetch: async () =>
        new Response("private body", {
          status: 502,
          headers: {
            "cf-aig-log-id": "private token",
            "x-request-id": "private request",
            "cf-ray": "private path",
          },
        }),
      kind: "http",
      stage: "response",
      status: 502,
    },
    {
      fetch: async () => new Response("private malformed JSON"),
      kind: "invalid_json",
      stage: "response",
      status: 200,
    },
    {
      fetch: async () => Response.json({ private: "schema input" }),
      kind: "invalid_schema",
      stage: "validation",
      status: 200,
    },
    {
      fetch: responder([0]),
      kind: "answer_coverage",
      stage: "validation",
      status: 200,
    },
    {
      fetch: async () => {
        const response = new Response();
        response.json = async () => {
          throw Object.assign(new Error("private body stream"), {
            code: "UND_ERR_BODY_TIMEOUT",
          });
        };
        return response;
      },
      kind: "timeout",
      stage: "response",
      status: 200,
    },
  ];
  for (const [i, c] of cases.entries()) {
    const result = await judge({
      mode: "select",
      key: async () => "private-key",
      fetch: c.fetch,
    });
    assert.equal(result.failure?.kind, c.kind);
    assert.equal(result.failure?.stage, c.stage);
    assert.equal(result.failure?.status, c.status);
    assert.equal(result.failure?.gatewayLogId, i === 0 ? id : undefined);
    assert.equal(
      result.failure?.providerRequestId,
      i === 0 ? providerId : undefined,
    );
    assert.equal(
      result.failure?.cfRay,
      i === 0 ? "abcdef0123456789-SYD" : undefined,
    );
    assert.doesNotMatch(
      JSON.stringify(result.failure),
      /private|body stream|schema input/,
    );
  }
  let calls = 0;
  const missingKey = await judge({
    mode: "select",
    key: async () => {
      throw Error("private credential failure");
    },
    fetch: async () => {
      calls++;
      throw Error("must not fetch");
    },
  });
  assert.equal(missingKey.failure?.stage, "key");
  assert.equal(missingKey.failure?.kind, "key_unavailable");
  assert.equal(calls, 0);
});

test("a failed gateway is reported without an unreported direct retry; off never fetches a key", async () => {
  const calls: string[] = [];
  const result = await judge({
    mode: "select",
    gateway: { accountId: "b".repeat(32), gatewayId: "example-gateway" },
    key: async () => "test-key",
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 503 });
    },
  });
  assert.equal(result.record, undefined);
  assert.equal(result.reason, "http_error");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("https://gateway.ai.cloudflare.com/"));
  const off = await judge({
    mode: "off",
    key: async () => {
      throw Error("must not read key");
    },
  });
  assert.equal(off.reason, "disabled");
  assert.equal(off.failure, undefined);
});

test("exact versions cache judgments; a cached record for other questions is not reused", async () => {
  let calls = 0;
  const selector: Selector = {
    mode: "select",
    key: async () => "test-key",
    fetch: (async (...args) => {
      calls++;
      return responder(Array(COUNT).fill(0.5))(...args);
    }) as typeof fetch,
  };
  const first = await judge(selector);
  const second = await judge(selector, { cached: first.record });
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.deepEqual(second.record, first.record);
  const other = await judge(selector, { cached: { ...first.record, version: "v2" } });
  assert.equal(calls, 2);
  assert.equal(other.cached, false);
  const fewer = await judge(selector, { cached: { ...first.record, probabilities: { keep_0: 0.5 } } });
  assert.equal(calls, 3);
  assert.equal(fewer.cached, false);
});

test("an oversized request is never silently shortened; cancellation stops the judgment", async () => {
  const large = await judge(
    {
      mode: "select",
      key: async () => {
        throw Error("must not read key");
      },
    },
    { state: { text: "A".repeat(40_000) } },
  );
  assert.equal(large.reason, "request_too_large");
  assert.equal(large.failure?.stage, "prepare");
  assert.equal(large.failure?.kind, "request_too_large");
  const controller = new AbortController();
  await assert.rejects(
    judge(
      {
        mode: "select",
        key: async () => "test-key",
        fetch: async () => {
          controller.abort();
          throw Error("cancelled");
        },
      },
      { signal: controller.signal },
    ),
    /abort/i,
  );
});

test("gateway configuration accepts identifiers rather than arbitrary upstream URLs", () => {
  assert.equal(contextConfigSchema.parse({}).mode, "off");
  assert.equal(
    contextConfigSchema.parse({
      gateway: {
        accountId: "a".repeat(32),
        gatewayId: "_example-gateway",
      },
    }).gateway?.gatewayId,
    "_example-gateway",
  );
  for (const gateway of [
    { accountId: "https://example.com", gatewayId: "example-gateway" },
    { accountId: "a".repeat(32), gatewayId: "../other" },
    { accountId: "a".repeat(32), gatewayId: "trailing-" },
    { accountId: "a".repeat(32), gatewayId: "two--hyphens" },
    { accountId: "a".repeat(32), gatewayId: "a".repeat(65) },
    {
      accountId: "a".repeat(32),
      gatewayId: "example-gateway",
      endpoint: "https://example.com",
    },
  ])
    assert.equal(
      contextConfigSchema.safeParse({ mode: "select", gateway }).success,
      false,
    );
});

test("selector credentials never enter helper or collector subprocess environments", () => {
  const saved = {
    JEV_API_KEY: process.env.JEV_API_KEY,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  };
  try {
    process.env.JEV_API_KEY = "test-key";
    process.env.TYPESAFE_API_KEY = "test-key";
    for (const env of [nativeEnv(), subprocessEnv()]) {
      assert.equal(env.JEV_API_KEY, undefined);
      assert.equal(env.TYPESAFE_API_KEY, undefined);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an executor reads the selector key once and retries only failed or empty reads", async () => {
  const results = [Error("unavailable"), "", "secret-value"];
  let reads = 0;
  const key = keptKey(async () => {
    const next = results[reads++];
    if (next instanceof Error) throw next;
    return next;
  });
  await assert.rejects(key());
  assert.equal(await key(), "");
  assert.equal(await key(), "secret-value");
  assert.equal(await key(), "secret-value");
  assert.equal(reads, 3);
});

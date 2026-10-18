import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  childContext,
  contextConversation,
  contextConfigSchema,
  contextVersion,
  JEV_MODEL,
  JEV_INPUT_COST_PER_TOKEN,
  selectContext,
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

test("gateway selection reports priced usage without logging or caching conversation payloads", async () => {
  const gateway = { accountId: "a".repeat(32), gatewayId: "example-gateway" };
  const parsed = contextConfigSchema.parse({ mode: "select", gateway });
  let calls = 0;
  const view = await selectContext({
    ...fixture(),
    selector: {
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
          trigger: "coordinator-rotation",
          worker: "projects-runner",
          model: JEV_MODEL,
          selectionId: metadata.selectionId,
        });
        return responder(Array(7).fill(0.5))(url, init);
      },
    },
  });
  assert.equal(view.strategy, "select");
  assert.equal(view.record?.transport, "gateway");
  assert.equal(view.record?.inputTokens, 100);
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
    const view = await selectContext({
      ...fixture(),
      selector: {
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
      },
    });
    assert.equal(view.strategy, "baseline");
    assert.equal(view.reason, "service_failed");
    assert.equal(view.failure?.selectionId, selectionId);
    assert.equal(view.failure?.kind, kind);
    assert.equal(view.failure?.errorCode, code);
    assert.equal(view.failure?.stage, "request");
    assert.equal(view.failure?.transport, "gateway");
    assert.equal(view.failure?.timeoutMs, 8000);
    assert.ok(view.failure!.requestBytes > 0);
    assert.equal(view.failure?.candidateCount, 7);
    assert.ok(view.failure!.durationMs >= view.failure!.stageDurationMs);
    assert.equal(calls, 1);
    assert.doesNotMatch(
      JSON.stringify(view.failure),
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
    const view = await selectContext({
      ...fixture(),
      selector: {
        mode: "select",
        key: async () => "private-key",
        fetch: c.fetch,
      },
    });
    assert.equal(view.failure?.kind, c.kind);
    assert.equal(view.failure?.stage, c.stage);
    assert.equal(view.failure?.status, c.status);
    assert.equal(view.failure?.gatewayLogId, i === 0 ? id : undefined);
    assert.equal(
      view.failure?.providerRequestId,
      i === 0 ? providerId : undefined,
    );
    assert.equal(
      view.failure?.cfRay,
      i === 0 ? "abcdef0123456789-SYD" : undefined,
    );
    assert.doesNotMatch(
      JSON.stringify(view.failure),
      /private|body stream|schema input/,
    );
  }
  let calls = 0;
  const missingKey = await selectContext({
    ...fixture(),
    selector: {
      mode: "select",
      key: async () => {
        throw Error("private credential failure");
      },
      fetch: async () => {
        calls++;
        throw Error("must not fetch");
      },
    },
  });
  assert.equal(missingKey.failure?.stage, "key");
  assert.equal(missingKey.failure?.kind, "key_unavailable");
  assert.equal(calls, 0);
});

test("a failed gateway retains baseline context without an unreported direct retry", async () => {
  const f = fixture();
  const calls: string[] = [];
  const view = await selectContext({
    ...f,
    selector: {
      mode: "select",
      gateway: { accountId: "b".repeat(32), gatewayId: "example-gateway" },
      key: async () => "test-key",
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 503 });
      },
    },
  });
  assert.equal(view.strategy, "baseline");
  assert.equal(view.reason, "http_error");
  assert.equal(view.children, childContext(f.children, 6));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("https://gateway.ai.cloudflare.com/"));
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

test("semantic selection cannot remove instructions, approval proposals, current or uncertain execution", async () => {
  const f = fixture();
  f.children[2].state = "unknown";
  const view = await selectContext({
    ...f,
    selector: {
      mode: "select",
      key: async () => "test-key",
      fetch: responder([0, 0, 0, 0, 0, 0]),
    },
  });
  assert.equal(view.strategy, "select");
  assert.deepEqual(view.conversation, contextConversation(f.messages));
  assert.deepEqual(view.approvalContext, [f.messages[1]]);
  const children = JSON.parse(view.children);
  assert.equal(children.index.length, 8);
  assert.deepEqual(
    children.index.map((c: Child) => c.evidence),
    f.children.map((c) => c.evidence),
  );
  assert.deepEqual(
    children.retained.map((c: Child) => c.id),
    [f.children[2].id, f.children[7].id],
  );
  assert.equal(view.childSources.length, 8);
});

test("older useful and uncertain evidence stays verbatim; only optional clear negatives are omitted", async () => {
  const f = fixture();
  const view = await selectContext({
    ...f,
    selector: {
      mode: "select",
      key: async () => "test-key",
      fetch: responder([0.99, 0.5, 0.05, 0, 0, 0, 0]),
    },
  });
  const children = JSON.parse(view.children);
  assert.deepEqual(children.retained, [
    f.children[0],
    f.children[1],
    f.children[7],
  ]);
  assert.equal(view.selected, 2);
  assert.equal(view.omitted, 5);
});

test("off and shadow modes preserve deterministic evidence; off never fetches a key", async () => {
  const f = fixture();
  const off = await selectContext({
    ...f,
    selector: {
      mode: "off",
      key: async () => {
        throw Error("must not read key");
      },
    },
  });
  const shadow = await selectContext({
    ...f,
    selector: {
      mode: "shadow",
      key: async () => "test-key",
      fetch: responder(Array(7).fill(0)),
    },
  });
  assert.equal(off.children, childContext(f.children, 6));
  assert.equal(shadow.children, off.children);
  assert.equal(shadow.strategy, "shadow");
});

test("incomplete, malformed, wrong-model, HTTP and service failures preserve baseline sources", async () => {
  const f = fixture();
  const fetches: (typeof fetch)[] = [
    responder([0]),
    responder(Array(7).fill(0), (b) => ({ ...b, model: "jev-latest" })),
    responder(Array(7).fill(0), (b) => ({
      ...b,
      answers: { keep_0: { type: "noul", noul: 2 } },
    })),
    async () => new Response("private upstream error", { status: 429 }),
    async () => {
      throw Error("private upstream error");
    },
  ];
  for (const fetch of fetches) {
    const view = await selectContext({
      ...f,
      selector: { mode: "select", key: async () => "test-key", fetch },
    });
    assert.equal(view.strategy, "baseline");
    assert.equal(view.children, childContext(f.children, 6));
    assert.equal(view.sources.length, f.messages.length);
    assert.doesNotMatch(JSON.stringify(view), /test-key|private upstream/);
  }
});

test("exact evidence versions cache judgments and invalidate on corrections or changed execution evidence", async () => {
  const f = fixture();
  let calls = 0;
  const selector = {
    mode: "select" as const,
    key: async () => "test-key",
    fetch: (async (...args) => {
      calls++;
      return responder(Array(7).fill(0.5))(...args);
    }) as typeof fetch,
  };
  const first = await selectContext({ ...f, selector });
  const second = await selectContext({ ...f, selector, cached: first.record });
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  f.messages.push(
    message("user", "Correction: keep the draft pending review."),
  );
  await selectContext({ ...f, selector, cached: first.record });
  assert.equal(calls, 2);
  f.children[0].evidence = ["Version b is observed"];
  assert.notEqual(contextVersion(f.messages, f.children), first.version);
  await selectContext({ ...f, selector, cached: first.record });
  assert.equal(calls, 3);
});

test("oversized context is never silently shortened for Jev; cancellation prevents selection", async () => {
  const f = fixture();
  f.messages[0].text = "A".repeat(40_000);
  const large = await selectContext({
    ...f,
    selector: {
      mode: "select",
      key: async () => {
        throw Error("must not read key");
      },
    },
  });
  assert.equal(large.reason, "request_too_large");
  assert.equal(large.failure?.stage, "prepare");
  assert.equal(large.failure?.kind, "request_too_large");
  assert.equal(large.sources.length, f.messages.length);
  const controller = new AbortController();
  await assert.rejects(
    selectContext({
      ...fixture(),
      signal: controller.signal,
      selector: {
        mode: "select",
        key: async () => "test-key",
        fetch: async () => {
          controller.abort();
          throw Error("cancelled");
        },
      },
    }),
    /abort/i,
  );
});

test("source text is data, question instructions identify candidates without relying on question IDs", async () => {
  const f = fixture();
  const view = await selectContext({
    ...f,
    selector: {
      mode: "select",
      key: async () => "test-key",
      fetch: async (url, init) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(init?.redirect, "error");
        const body = JSON.parse(init!.body as string);
        assert.match(body.questions.keep_0.instructions, /candidates\[0\]/);
        assert.deepEqual(
          body.state.instructions.map((m: RunMessage) => m.text),
          [f.messages[0].text, "Yes"],
        );
        assert.doesNotMatch(JSON.stringify(body), /test-key|\/tmp\/owned/);
        return responder(Array(7).fill(0.5))(url, init);
      },
    },
  });
  assert.equal(view.strategy, "select");
});

test("conversation evidence can be selected before any helper has run", async () => {
  const messages = [
    message("user", "Inspect the saved draft"),
    message("master", "An earlier observation"),
    message("master", "Latest position"),
  ];
  const view = await selectContext({
    messages,
    children: [],
    signal: new AbortController().signal,
    selector: {
      mode: "select",
      key: async () => "test-key",
      fetch: responder([0.5]),
    },
  });
  assert.equal(view.strategy, "select");
  assert.equal(view.supportingEvidence.length, 1);
  assert.deepEqual(JSON.parse(view.children), { index: [], retained: [] });
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

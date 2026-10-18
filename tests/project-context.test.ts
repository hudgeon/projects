import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewProjectContext } from "../runner/project-context";
import { git } from "../runner/workspaces";
import { JEV_MODEL } from "../runner/context";

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "project-context-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(
    path.join(cwd, ".gitignore"),
    ".state/\n.env\n.wip/\nnode_modules/\n",
  );
  await writeFile(
    path.join(cwd, "AGENTS.md"),
    "Drafting only. Publishing requires the owner's approval.\n",
  );
  await writeFile(
    path.join(cwd, "PLAN.md"),
    "The invoice importer must preserve the pipe delimiter and account boundary.\n",
  );
  await writeFile(
    path.join(cwd, "README.md"),
    "The project imports invoices.\n",
  );
  await writeFile(
    path.join(cwd, "src/invoices.ts"),
    'export const delimiter = "|"; // Invoice format\n',
  );
  await writeFile(
    path.join(cwd, "src/weather.ts"),
    'export const weather = "sunny";\n',
  );
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["add", "."]);
  await git(cwd, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "Initial fixture",
  ]);
  return {
    cwd,
    options: {
      project: {
        id: "example/importer",
        name: "Importer",
        cwd,
        plan: "PLAN.md",
      },
      instructions: ["Inspect the invoice delimiter. Draft only."],
      task: "Inspect the invoice importer",
      signal: new AbortController().signal,
    },
  };
}
function selector(
  onRequest?: (body: any, init: RequestInit) => Promise<void> | void,
) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    value: {
      mode: "select" as const,
      gateway: { accountId: "a".repeat(32), gatewayId: "example" },
      key: async () => "fixture-key",
      fetch: (async (_url, init) => {
        calls++;
        const body = JSON.parse(init!.body as string);
        await onRequest?.(body, init!);
        return Response.json({
          model: JEV_MODEL,
          answers: Object.fromEntries(
            body.state.candidates.map((c: { path: string }, i: number) => [
              `keep_${i}`,
              { type: "noul", noul: c.path.includes("weather") ? 0 : 0.9 },
            ]),
          ),
          usage: { input_tokens: 500, output_tokens: 40 },
        });
      }) as typeof fetch,
    },
  };
}

test("a first turn selects project evidence through the priced gateway and retains instructions verbatim", async () => {
  const { cwd, options } = await fixture();
  const mock = selector((body, init) => {
    assert.deepEqual(body.state.userInstructions, options.instructions);
    assert.match(body.state.repositoryInstructions[0].text, /Drafting only/);
    assert.ok(
      body.state.candidates.every(
        (c: { path: string }) => c.path !== "AGENTS.md",
      ),
    );
    const headers = new Headers(init.headers);
    assert.equal(headers.get("cf-aig-collect-log-payload"), "false");
    assert.equal(headers.get("cf-aig-skip-cache"), "true");
    assert.equal(
      JSON.parse(headers.get("cf-aig-metadata")!).trigger,
      "project-turn",
    );
    assert.equal(
      JSON.parse(headers.get("cf-aig-custom-cost")!).per_token_in,
      0.000000042,
    );
  });
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
    });
    assert.equal(view.receipt.strategy, "select");
    assert.equal(view.record?.transport, "gateway");
    assert.match(
      view.prompt,
      /Drafting only\. Publishing requires the owner's approval/,
    );
    assert.match(view.prompt, /pipe delimiter/);
    assert.doesNotMatch(view.prompt, /sunny/);
    assert.equal(view.receipt.coverage, "bounded_excerpts");
    assert.equal(mock.calls, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reviews cache exact inputs and invalidate on task, instruction, dirty-source and inventory changes", async () => {
  const { cwd, options } = await fixture(),
    mock = selector();
  try {
    let view = await reviewProjectContext({ ...options, selector: mock.value });
    const originalHead = await git(cwd, ["rev-parse", "HEAD"]);
    const same = await reviewProjectContext({
      ...options,
      selector: mock.value,
      cached: view.record,
    });
    assert.equal(same.receipt.cached, true);
    assert.equal(mock.calls, 1);
    await writeFile(
      path.join(cwd, "src/invoices.ts"),
      'export const delimiter = ";"; // Changed invoice format\n',
    );
    view = await reviewProjectContext({
      ...options,
      selector: mock.value,
      cached: view.record,
    });
    assert.equal(view.receipt.cached, false);
    assert.equal(
      await git(cwd, ["rev-parse", "HEAD"]),
      originalHead,
      "dirty contents invalidate without a commit",
    );
    assert.match(view.prompt, /Changed invoice format/);
    await writeFile(
      path.join(cwd, "src/invoices.ts"),
      'export const delimiter = ","; // Changed again while still dirty\n',
    );
    view = await reviewProjectContext({
      ...options,
      selector: mock.value,
      cached: view.record,
    });
    await writeFile(
      path.join(cwd, "AGENTS.md"),
      "Drafting only. Also retain the fixture's recovery copy.\n",
    );
    view = await reviewProjectContext({
      ...options,
      selector: mock.value,
      cached: view.record,
    });
    assert.match(view.prompt, /recovery copy/);
    view = await reviewProjectContext({
      ...options,
      task: "Inspect the weather display instead",
      selector: mock.value,
      cached: view.record,
    });
    await writeFile(
      path.join(cwd, "src/invoice-validation.ts"),
      "// Newly added invoice validation\n",
    );
    await reviewProjectContext({
      ...options,
      selector: mock.value,
      cached: view.record,
    });
    assert.equal(mock.calls, 6);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a current work issue is evidence and changed issue contents invalidate a review", async () => {
  const { cwd, options } = await fixture(),
    mock = selector();
  let body = "Inspect invoice allocation only; delivery remains unverified.";
  const readIssue = async () => ({
    title: "Invoice work",
    body,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  try {
    const o = {
      ...options,
      selector: mock.value,
      workIssue: { repo: "example/work", number: 7 },
      readIssue,
    };
    const first = await reviewProjectContext(o);
    assert.match(first.prompt, /delivery remains unverified/);
    assert.ok(
      first.receipt.sources?.some(
        (s) =>
          s.path === "https://github.com/example/work/issues/7" &&
          s.status === "read",
      ),
    );
    body =
      "Current correction: invoice allocation requires an account boundary check.";
    const changed = await reviewProjectContext({ ...o, cached: first.record });
    assert.equal(changed.receipt.cached, false);
    assert.equal(mock.calls, 2);
    assert.match(changed.prompt, /Current correction/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sources changing during Jev selection discard that judgment and retain a fresh baseline", async () => {
  const { cwd, options } = await fixture();
  const mock = selector(async () => {
    await writeFile(
      path.join(cwd, "src/invoices.ts"),
      "// Corrected invoice delimiter is now a semicolon.\n",
    );
  });
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
    });
    assert.equal(view.receipt.reason, "evidence_changed");
    assert.equal(view.receipt.strategy, "baseline");
    assert.equal(view.record, undefined);
    assert.match(view.prompt, /Corrected invoice delimiter/);
    assert.match(view.prompt, /sunny/, "fallback retains optional evidence");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignored secrets, unsafe plan paths, links and binary files never reach Jev or its prompt", async () => {
  const { cwd, options } = await fixture(),
    outside = await mkdtemp(path.join(tmpdir(), "outside-project-"));
  const secret = "PRIVATE-CONTENT-MUST-NOT-LEAVE";
  await writeFile(path.join(cwd, ".env"), secret);
  await writeFile(path.join(outside, "outside.md"), secret);
  await symlink(
    path.join(outside, "outside.md"),
    path.join(cwd, "invoice-linked.md"),
  );
  await writeFile(
    path.join(cwd, "invoice-binary.md"),
    Buffer.from([0, 1, 2, 3]),
  );
  await mkdir(path.join(cwd, "secrets"));
  await writeFile(path.join(cwd, "secrets/invoice.ts"), secret);
  const mock = selector((body) => {
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  });
  try {
    for (const plan of [
      ".env",
      "../outside.md",
      path.join(outside, "outside.md"),
    ]) {
      const view = await reviewProjectContext({
        ...options,
        project: { ...options.project, plan },
        selector: mock.value,
      });
      assert.doesNotMatch(view.prompt, new RegExp(secret));
      assert.ok(
        view.receipt.sources?.some(
          (s) => s.path === "invoice-linked.md" && s.status === "linked_source",
        ),
      );
      assert.ok(
        view.receipt.sources?.some(
          (s) => s.path === "invoice-binary.md" && s.status === "not_text",
        ),
      );
    }
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("nested instructions stay protected and bounded excerpts preserve exact offsets and source hashes", async () => {
  const { cwd, options } = await fixture();
  const text =
    "Unrelated historical description.\n".repeat(100) +
    "Invoice delimiter correction: pipe only.\n" +
    "More unrelated description.\n".repeat(100);
  await writeFile(
    path.join(cwd, "src/AGENTS.md"),
    "Never change the account boundary in this directory.\n",
  );
  await writeFile(path.join(cwd, "src/invoices.ts"), text);
  const mock = selector((body) => {
    for (const c of body.state.candidates.filter(
      (c: { path: string }) => c.path === "src/invoices.ts",
    )) {
      assert.equal(c.text, text.slice(c.startChar, c.endChar));
      assert.match(c.hash, /^[a-f0-9]{64}$/);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 28_000);
  });
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
    });
    assert.match(view.prompt, /Never change the account boundary/);
    assert.match(view.prompt, /Invoice delimiter correction/);
    assert.ok((view.receipt.baselineChars ?? 0) <= 6_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("HTTP and invalid-answer failures retain baseline evidence; cancellation prevents a native-ready review", async () => {
  const { cwd, options } = await fixture();
  try {
    for (const fetch of [
      async () => new Response(null, { status: 503 }),
      async () =>
        Response.json({
          model: JEV_MODEL,
          answers: {},
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
    ]) {
      const view = await reviewProjectContext({
        ...options,
        selector: { mode: "select", key: async () => "fixture-key", fetch },
      });
      assert.equal(view.receipt.strategy, "baseline");
      assert.match(view.prompt, /pipe delimiter/);
      assert.match(view.prompt, /sunny/);
      assert.match(view.prompt, /Drafting only/);
    }
    const controller = new AbortController(),
      mock = selector(() => controller.abort("cancelled"));
    await assert.rejects(
      reviewProjectContext({
        ...options,
        signal: controller.signal,
        selector: mock.value,
      }),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recognizable credentials in normally named source or work issues are excluded in full", async () => {
  const { cwd, options } = await fixture();
  const value =
    "sk" +
    "-" +
    randomUUID().replaceAll("-", "") +
    randomUUID().replaceAll("-", "");
  await writeFile(
    path.join(cwd, "src/invoice-config.ts"),
    `export const provider = '${value}';\n`,
  );
  const mock = selector((body) =>
    assert.ok(!JSON.stringify(body).includes(value)),
  );
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
      workIssue: { repo: "example/work", number: 8 },
      readIssue: async () => ({
        title: "Invoice correction",
        body: `Accidentally included credential ${value}`,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    });
    assert.ok(!view.prompt.includes(value));
    assert.equal(
      view.receipt.sources.filter((s) => s.status === "credential_like_content")
        .length,
      2,
    );
    assert.match(view.prompt, /credential_like_content/);
    assert.match(view.prompt, /Drafting only/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

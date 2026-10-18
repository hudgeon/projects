import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewProjectContext } from "../runner/project-context";
import { git } from "../runner/workspaces";
import { JEV_MODEL, REQUEST_BYTES } from "../runner/context";
import { fixture, selector } from "./project-fixtures";

test("a first turn selects project evidence through the priced gateway and retains instructions verbatim", async () => {
  const { cwd, options } = await fixture();
  const mock = selector((body, init) => {
    assert.deepEqual(body.state.userInstructions, options.instructions);
    assert.equal(
      body.state.repositoryInstructions,
      undefined,
      "protected instructions are not relevance candidates",
    );
    assert.doesNotMatch(JSON.stringify(body), /Drafting only/);
    assert.equal(
      Object.keys(body.questions).length,
      body.state.candidates.length,
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

test("reviews cache what Jev judged and invalidate on task, instruction, dirty-source and new-source changes", async () => {
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
    assert.equal(
      view.receipt.cached,
      true,
      "instructions reach the prompt fresh; Jev never judged them",
    );
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
    assert.equal(mock.calls, 5);
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
    assert.match(
      view.prompt,
      /pipe delimiter/,
      "fallback retains retrieval evidence",
    );
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
  const mock = selector((body) =>
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= REQUEST_BYTES),
  );
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
    });
    assert.match(view.prompt, /Never change the account boundary/);
    assert.match(view.prompt, /Invoice delimiter correction/);
    const evidence = JSON.parse(
      view.prompt.split("offsets are characters): ")[1],
    ) as {
      path: string;
      hash: string;
      startChar: number;
      endChar: number;
      text: string;
    }[];
    for (const e of evidence.filter((e) => e.path === "src/invoices.ts")) {
      assert.equal(e.text, text.slice(e.startChar, e.endChar));
      assert.match(e.hash, /^[a-f0-9]{64}$/);
    }
    assert.ok(
      view.receipt.considered.every((c) => c.endChar - c.startChar <= 1_200),
    );
    assert.ok((view.receipt.baselineChars ?? 0) <= 6_000);
    assert.ok((view.receipt.selectedChars ?? 0) <= 6_000);
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
      assert.equal(
        view.receipt.failure?.stage,
        view.receipt.reason === "http_error" ? "response" : "validation",
      );
      assert.ok(view.receipt.failure?.selectionId);
      assert.match(view.prompt, /pipe delimiter/);
      assert.match(view.prompt, /imports invoices/);
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

test("Jev ranks the shortlist; code supplies the best units at or above the cutoff", async () => {
  const { cwd, options } = await fixture();
  await writeFile(
    path.join(cwd, "PLAN.md"),
    [
      "# Importer plan",
      "## Phase 1: delimiter",
      "The invoice importer must preserve the pipe delimiter. Every exported line keeps its columns in the account's order, and a missing column is an error rather than an empty value.",
      "```sh",
      "# not a heading inside a fence",
      "```",
      "## Phase 2: invoice archive",
      "Archive imported invoice files after a week. The archive keeps the original file name and the import date, and a second import of the same file is refused.",
      "## Phase 3: weather",
      "Show invoice-free weather tiles.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(cwd, "src/invoices.ts"),
    [
      'import { readFile } from "node:fs/promises";',
      "",
      "// Splits one invoice line at the pipe delimiter.",
      "export function splitInvoice(line: string) {",
      "  const parts = line.split(DELIMITER);",
      '  if (parts.length < COLUMNS) throw Error("Missing invoice column");',
      "",
      "  return parts;",
      "}",
      "",
      "export function archiveInvoice(file: string) {",
      `  return readFile(file, "utf8"); // ${"archive ".repeat(40)}`,
      "}",
      "",
    ].join("\n"),
  );
  let sent: { path: string; section?: string; text: string }[] = [];
  const nouls: Record<string, number> = {
    "Phase 1": 0.6,
    splitInvoice: 0.95,
    "Phase 2": 0.4,
    archiveInvoice: 0.2,
  };
  const value = {
    ...selector().value,
    fetch: (async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      sent = body.state.candidates;
      assert.equal(Object.keys(body.questions).length, sent.length);
      for (const [i, q] of Object.values(body.questions).entries())
        assert.match(
          (q as { instructions: string }).instructions,
          new RegExp(`candidates\\[${i}\\]`),
        );
      return Response.json({
        model: JEV_MODEL,
        answers: Object.fromEntries(
          sent.map((c, i) => [
            `keep_${i}`,
            {
              type: "noul",
              noul:
                Object.entries(nouls).find(([k]) =>
                  `${c.section ?? ""} ${c.text}`.includes(k),
                )?.[1] ?? 0.1,
            },
          ]),
        ),
        usage: { input_tokens: 900, output_tokens: 40 },
      });
    }) as typeof fetch,
  };
  try {
    const view = await reviewProjectContext({ ...options, selector: value });
    const evidence = JSON.parse(
      view.prompt.split("offsets are characters): ")[1],
    ) as { text: string }[];
    assert.deepEqual(
      evidence.map((e) => e.text.split("\n")[0]),
      ["// Splits one invoice line at the pipe delimiter.", "# Importer plan"],
      "ranked by probability; units below the cutoff are not supplied",
    );
    assert.equal(view.receipt.selected, 2);
    assert.equal(view.receipt.omitted, sent.length - 2);
    assert.equal(view.receipt.keepFrom, 0.5);
    assert.ok(
      view.receipt.considered.every((c) => typeof c.score === "number"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shadow mode records Jev's ranking but supplies the retrieval baseline", async () => {
  const { cwd, options } = await fixture();
  const mock = selector();
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: { ...mock.value, mode: "shadow" },
    });
    assert.equal(view.receipt.strategy, "shadow");
    assert.ok(view.record);
    assert.equal(view.receipt.selectedChars, view.receipt.baselineChars);
    assert.match(view.prompt, /pipe delimiter/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

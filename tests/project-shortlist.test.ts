import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewProjectContext } from "../runner/project-context";
import { QUESTION_BYTES, REQUEST_BYTES } from "../runner/context";
import { fixture, selector } from "./project-fixtures";

test("the work issue's body sections and newest comments are candidates", async () => {
  const { cwd, options } = await fixture();
  // Candidates arrive over the review's batched requests.
  const sent: { path: string; section?: string }[] = [];
  const mock = selector((body) => {
    sent.push(...body.state.candidates);
  });
  try {
    await reviewProjectContext({
      ...options,
      selector: mock.value,
      workIssue: { repo: "example/work", number: 9 },
      readIssue: async () => ({
        title: "Invoice importer",
        body: "## Current position\nThe delimiter check remains.",
        updatedAt: "2026-01-07T00:00:00Z",
        comments: Array.from({ length: 7 }, (_, i) => ({
          body: `## Status\nInvoice update ${i + 1}.`,
          createdAt: `2026-01-0${i + 1}T00:00:00Z`,
        })),
      }),
    });
    const paths = sent.map((c) => c.path);
    assert.ok(paths.includes("https://github.com/example/work/issues/9"));
    assert.ok(
      paths.includes(
        "https://github.com/example/work/issues/9#comment-2026-01-07T00:00:00Z",
      ),
    );
    assert.ok(
      !paths.includes(
        "https://github.com/example/work/issues/9#comment-2026-01-02T00:00:00Z",
      ),
    );
    const latest = sent.find((c) => c.path.endsWith("01-07T00:00:00Z"));
    assert.equal(latest!.section, "Comment 2026-01-07T00:00:00Z > Status");
    assert.ok(mock.calls >= 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a large project sends 20 to 40 candidates within the documented request limits", async () => {
  const { cwd, options } = await fixture();
  await mkdir(path.join(cwd, "docs"));
  for (let i = 0; i < 30; i++)
    await writeFile(
      path.join(cwd, `docs/invoices-${i}.md`),
      Array.from(
        { length: 4 },
        (_, j) =>
          `## Invoice note ${j}\n${"The invoice importer keeps its delimiter. ".repeat(12)}\n`,
      ).join("\n"),
    );
  let candidates = 0;
  const mock = selector((body) => {
    candidates += body.state.candidates.length;
    const largest = Math.max(
      ...Object.values(body.questions).map((q) =>
        Buffer.byteLength(JSON.stringify(q)),
      ),
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(body.state)) + largest <= QUESTION_BYTES,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= REQUEST_BYTES);
  });
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
    });
    assert.ok(candidates >= 20 && candidates <= 40, String(candidates));
    assert.equal(view.receipt.considered.length, candidates);
    assert.equal(mock.calls, 1, "one request holds the whole shortlist");
    assert.equal(view.record!.batches, 1);
    assert.ok(view.receipt.selectedChars <= 6_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("files a brief names lead the shortlist; only its opening steers retrieval", async () => {
  const { cwd, options } = await fixture();
  await writeFile(
    path.join(cwd, "src/ledger.ts"),
    "export const rows: string[] = [];\n",
  );
  await mkdir(path.join(cwd, "docs"));
  await writeFile(
    path.join(cwd, "docs/display.md"),
    "## Display\nThe weather display uses rounded tiles.\n",
  );
  for (let i = 0; i < 60; i++)
    await writeFile(
      path.join(cwd, `docs/importer-${i}.md`),
      `## Importer note ${i}\n${"The invoice importer reads each invoice line. ".repeat(20)}\n`,
    );
  const paths: string[] = [];
  const mock = selector((body) => {
    paths.push(...body.state.candidates.map((c: { path: string }) => c.path));
  });
  try {
    await reviewProjectContext({
      ...options,
      task: `change: Fix the invoice importer; the row store is src/ledger.ts.\n${"Keep the delivery gates. ".repeat(50)}Check the weather display too.`,
      selector: mock.value,
    });
    assert.ok(
      paths.includes("src/ledger.ts"),
      "a named file is a candidate without matching words",
    );
    assert.ok(
      !paths.includes("docs/display.md"),
      "words past the brief's opening do not steer retrieval",
    );
    assert.ok(paths.length >= 20);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("YAML records are candidates; YAML holding an unquoted secret or in a hidden folder never reaches Jev", async () => {
  const { cwd, options } = await fixture();
  const value = randomUUID().replaceAll("-", "");
  await mkdir(path.join(cwd, "policies"));
  await writeFile(
    path.join(cwd, "policies/answers.yml"),
    [
      "topics:",
      "  - key: invoice-delimiter",
      "    question: Which delimiter does the invoice importer keep?",
      "    answer: The importer keeps the pipe delimiter on every invoice line.",
      "  - key: invoice-archive",
      "    answer: Imported invoice files are archived after a week.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(cwd, "policies/importer.yml"),
    `importer:\n  invoice_api_token: ${value}\n`,
  );
  await mkdir(path.join(cwd, ".github/workflows"), { recursive: true });
  await writeFile(
    path.join(cwd, ".github/workflows/invoices.yml"),
    "name: Invoice importer delimiter check\n",
  );
  let sections: string[] = [];
  const mock = selector((body) => {
    assert.ok(!JSON.stringify(body).includes(value));
    sections = body.state.candidates
      .filter((c: { path: string }) => c.path.endsWith(".yml"))
      .map((c: { path: string; section: string }) => `${c.path}: ${c.section}`);
  });
  try {
    const view = await reviewProjectContext({
      ...options,
      selector: mock.value,
    });
    assert.deepEqual(sections.sort(), [
      "policies/answers.yml: topics > key: invoice-archive",
      "policies/answers.yml: topics > key: invoice-delimiter",
    ]);
    assert.ok(!view.prompt.includes(value));
    assert.ok(
      view.receipt.sources.some(
        (s) =>
          s.path === "policies/importer.yml" &&
          s.status === "credential_like_content",
      ),
    );
    assert.ok(!view.receipt.sources.some((s) => s.path.startsWith(".github")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

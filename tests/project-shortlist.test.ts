import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewProjectContext } from "../runner/project-context";
import { fixture } from "./project-fixtures";

test("only recent work comments enter the shortlist when a current position is present", async () => {
  const { cwd, options } = await fixture();
  try {
    const view = await reviewProjectContext({
      ...options,
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
    const paths = view.receipt.considered.map((c) => c.path);
    assert.ok(!paths.includes("https://github.com/example/work/issues/9"));
    assert.match(view.prompt, /The delimiter check remains/);
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
    const latest = view.receipt.considered.find((c) =>
      c.path.endsWith("01-07T00:00:00Z"),
    );
    assert.equal(latest!.section, "Comment 2026-01-07T00:00:00Z > Status");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a large project's shortlist holds 40 units and what it supplies fits 6,000 characters", async () => {
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
  try {
    const view = await reviewProjectContext(options);
    assert.equal(view.receipt.considered.length, 40, "120 notes match");
    assert.ok(view.receipt.supplied.length > 0);
    assert.ok(view.receipt.suppliedChars <= 6_000);
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
  try {
    const view = await reviewProjectContext({
      ...options,
      task: `change: Fix the invoice importer; the row store is src/ledger.ts.\n${"Keep the delivery gates. ".repeat(50)}Check the weather display too.`,
    });
    const paths = view.receipt.considered.map((c) => c.path);
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

test("YAML records are candidates; YAML holding an unquoted secret or in a hidden folder never reaches the review", async () => {
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
  try {
    const view = await reviewProjectContext(options);
    const sections = view.receipt.considered
      .filter((c) => c.path.endsWith(".yml"))
      .map((c) => `${c.path}: ${c.section}`);
    assert.deepEqual(sections.sort(), [
      "policies/answers.yml: topics > key: invoice-archive",
      "policies/answers.yml: topics > key: invoice-delimiter",
    ]);
    assert.ok(!JSON.stringify(view).includes(value));
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

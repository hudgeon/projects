import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewProjectContext } from "../runner/project-context";
import { git } from "../runner/workspaces";
import { fixture } from "./project-fixtures";

test("a first turn supplies project evidence and retains instructions verbatim", async () => {
  const { cwd, options } = await fixture();
  try {
    const view = await reviewProjectContext(options);
    assert.deepEqual(view.receipt.input.instructions, options.instructions);
    assert.ok(
      view.receipt.considered.every((c) => !c.path.endsWith("AGENTS.md")),
      "protected instructions are not relevance candidates",
    );
    assert.match(
      view.prompt,
      /Drafting only\. Publishing requires the owner's approval/,
    );
    assert.deepEqual(view.sent, {
      "AGENTS.md": view.receipt.sources.find((s) => s.path === "AGENTS.md")!
        .hash,
    });
    assert.match(view.prompt, /pipe delimiter/);
    assert.match(view.prompt, /imports invoices/);
    assert.match(view.prompt, /Use the excerpts that apply to the task/);
    assert.doesNotMatch(view.prompt, /complete plan/);
    assert.doesNotMatch(view.prompt, /sunny/);
    assert.equal(view.receipt.coverage, "bounded_excerpts");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dirty and new sources, the task and changed instructions reach each review fresh, without a commit", async () => {
  const { cwd, options } = await fixture();
  try {
    const first = await reviewProjectContext(options);
    const originalHead = await git(cwd, ["rev-parse", "HEAD"]);
    assert.equal(
      (await reviewProjectContext(options)).view,
      first.view,
      "an unchanged project is the same view",
    );
    await writeFile(
      path.join(cwd, "src/invoices.ts"),
      'export const delimiter = ";"; // Changed invoice format\n',
    );
    const dirty = await reviewProjectContext(options);
    assert.equal(
      await git(cwd, ["rev-parse", "HEAD"]),
      originalHead,
      "dirty contents count without a commit",
    );
    assert.match(dirty.prompt, /Changed invoice format/);
    await writeFile(
      path.join(cwd, "AGENTS.md"),
      "Drafting only. Also retain the fixture's recovery copy.\n",
    );
    const instructed = await reviewProjectContext(options);
    assert.match(instructed.prompt, /recovery copy/);
    assert.notEqual(instructed.view, dirty.view);
    assert.match(
      (
        await reviewProjectContext({
          ...options,
          task: "Inspect the weather display instead",
        })
      ).prompt,
      /sunny/,
    );
    await writeFile(
      path.join(cwd, "src/invoice-validation.ts"),
      "// Newly added invoice validation\n",
    );
    const added = await reviewProjectContext(options);
    assert.ok(
      added.receipt.considered.some(
        (c) => c.path === "src/invoice-validation.ts",
      ),
    );
    assert.match(added.prompt, /Newly added invoice validation/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a current work issue is evidence and its changed contents reach the next review", async () => {
  const { cwd, options } = await fixture();
  let body = "Inspect invoice allocation only; delivery remains unverified.";
  const readIssue = async () => ({
    title: "Invoice work",
    body,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  try {
    const o = {
      ...options,
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
    const changed = await reviewProjectContext(o);
    assert.match(changed.prompt, /Current correction/);
    assert.doesNotMatch(changed.prompt, /delivery remains unverified/);
    assert.notEqual(changed.view, first.view);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an oversized work record supplies its latest position and a real comment link outside its archived body", async () => {
  const { cwd, options } = await fixture();
  const url = "https://github.com/example/work/issues/7";
  let position = "Next: Verify the invoice account with the owner.";
  const review = {
    ...options,
    workIssue: { repo: "example/work", number: 7 },
    readIssue: async () => ({
      title: "Invoice work",
      body: `## Current position\nStatus: being worked on. Reviewed: 2026-01-01.\n${position}\n\n## Superseded position\n${"Old invoice history. ".repeat(8_000)}`,
      updatedAt: "2026-01-01T00:00:00Z",
      comments: [{
        body: "The invoice pipe delimiter still needs review.",
        createdAt: "2026-01-01T00:00:00Z",
        url: `${url}#issuecomment-123`,
      }],
    }),
  };
  try {
    const view = await reviewProjectContext(review);
    assert.equal(view.receipt.workBrief?.status, "read");
    assert.match(view.prompt, /Verify the invoice account with the owner/);
    assert.match(view.prompt, /#issuecomment-123/);
    assert.doesNotMatch(view.prompt, /Old invoice history|#comment-2026/);
    assert.ok(
      !view.receipt.considered.some((c) => c.path === url),
      "the archived body is not a candidate",
    );
    position = "Next: Compare the invoice output with the approved sample.";
    const revised = await reviewProjectContext(review);
    assert.match(revised.prompt, /Compare the invoice output/);
    assert.doesNotMatch(revised.prompt, /Verify the invoice account/);
    assert.notEqual(revised.receipt.workBrief?.hash, view.receipt.workBrief?.hash);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a long active position keeps complete priority fields and reports omitted detail", async () => {
  const { cwd, options } = await fixture();
  const readIssue = async () => ({
    title: "Invoice work",
    body: `## Current position\r\nStatus: needs verification. Reviewed: 2026-01-01.\r\nEvidence checked: 2026-01-01T00:00:00.000Z\r\nPosition: ${"Extra detail. ".repeat(180)}\r\nNext: Owner reviews the pending invoice decision.`,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  try {
    const view = await reviewProjectContext({
      ...options,
      workIssue: { repo: "example/work", number: 7 },
      readIssue,
    });
    assert.equal(view.receipt.workBrief?.status, "partial");
    assert.ok((view.receipt.workBrief?.chars ?? Infinity) <= 2_000);
    assert.match(view.prompt, /Owner reviews the pending invoice decision/);
    assert.match(view.prompt, /Evidence checked: 2026-01-01T00:00:00.000Z/);
    assert.doesNotMatch(view.prompt, /Extra detail/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignored secrets, unsafe plan paths, links and binary files never reach the prompt or receipt", async () => {
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
  try {
    for (const plan of [
      ".env",
      "../outside.md",
      path.join(outside, "outside.md"),
    ]) {
      const view = await reviewProjectContext({
        ...options,
        project: { ...options.project, plan },
      });
      assert.doesNotMatch(JSON.stringify(view), new RegExp(secret));
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
  try {
    const view = await reviewProjectContext(options);
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
    assert.ok(view.receipt.suppliedChars <= 6_000);
    assert.equal(
      view.receipt.suppliedChars,
      evidence.reduce((n, e) => n + e.text.length, 0),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancellation during a review prevents a native-ready review", async () => {
  const { cwd, options } = await fixture();
  const controller = new AbortController();
  try {
    await assert.rejects(
      reviewProjectContext({
        ...options,
        signal: controller.signal,
        workIssue: { repo: "example/work", number: 7 },
        readIssue: async () => {
          controller.abort("cancelled");
          return {
            title: "Invoice work",
            body: "Inspect the invoice delimiter.",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        },
      }),
      (reason) => reason === "cancelled",
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
  try {
    const view = await reviewProjectContext({
      ...options,
      workIssue: { repo: "example/work", number: 8 },
      readIssue: async () => ({
        title: "Invoice correction",
        body: `Accidentally included credential ${value}`,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    });
    assert.ok(!JSON.stringify(view).includes(value));
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

test("code supplies the shortlist's units in retrieval order while each fits the 6,000-character budget", async () => {
  const { cwd, options } = await fixture();
  await mkdir(path.join(cwd, "docs"));
  for (let i = 0; i < 12; i++)
    await writeFile(
      path.join(cwd, `docs/invoice-${i}.md`),
      `## Invoice note ${i}\n${"The invoice importer keeps its delimiter. ".repeat(i % 2 ? 6 : 24)}\n`,
    );
  try {
    const view = await reviewProjectContext(options);
    const { considered, supplied, suppliedChars } = view.receipt;
    let chars = 0;
    const fits = considered.flatMap((c, i) => {
      if (chars + c.endChar - c.startChar > 6_000) return [];
      chars += c.endChar - c.startChar;
      return [i];
    });
    assert.deepEqual(supplied, fits);
    assert.ok(supplied.length < considered.length, "the budget binds");
    assert.equal(suppliedChars, chars);
    const evidence = JSON.parse(
      view.prompt.split("offsets are characters): ")[1],
    ) as { path: string; startChar: number }[];
    assert.deepEqual(
      evidence.map((e) => [e.path, e.startChar]),
      supplied.map((i) => [considered[i].path, considered[i].startChar]),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { named, rank, terms, units } from "../runner/project-units";

const split = (name: string, text: string) => units(name, text, "h", 0);

test("markdown splits at headings outside fences; a heading with no text joins its first subsection", () => {
  const text = [
    "# Plan",
    "## Phase 1",
    "Keep the pipe delimiter in every exported line. ".repeat(5),
    "```sh",
    "# not a heading",
    "```",
    "## Phase 2",
    "Archive imported files after a week. ".repeat(6),
    "",
  ].join("\n");
  const parts = split("PLAN.md", text);
  assert.deepEqual(
    parts.map((u) => u.section),
    ["Plan > Phase 1", "Plan > Phase 2"],
  );
  assert.match(parts[0].text, /^# Plan\n## Phase 1[^]*# not a heading/);
  for (const u of parts)
    assert.equal(u.text, text.slice(u.startChar, u.endChar));
});

test("long sections split at paragraphs within the unit size and keep exact offsets", () => {
  const text =
    "## Notes\n" +
    Array.from({ length: 8 }, (_, i) => `Paragraph ${i} `.repeat(30)).join(
      "\n\n",
    );
  const parts = split("notes.md", text);
  assert.ok(parts.length > 1);
  for (const u of parts) {
    assert.ok(u.text.length <= 1_200);
    assert.equal(u.text, text.slice(u.startChar, u.endChar));
    assert.equal(u.section, "Notes");
  }
});

test("code splits at top-level statements with their comments; imports are dropped", () => {
  const text = [
    'import { a } from "a";',
    "import {",
    "  b,",
    '} from "b";',
    "",
    "// Splits one invoice line at the pipe delimiter.",
    "export function split(line: string) {",
    '  const parts = line.split("|");',
    '  if (parts.length < 3) throw Error("Missing invoice column");',
    "",
    "  return parts;",
    "}",
    "",
    `export const archive = "${"x".repeat(200)}";`,
    "",
  ].join("\n");
  const parts = split("src/split.ts", text);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].text.startsWith("// Splits one invoice line"));
  assert.ok(parts[0].text.endsWith("return parts;\n}"));
  assert.ok(parts.every((u) => !u.text.includes("import")));
});

test("named files match whole paths or file names unique in the project, never fragments", () => {
  const files = [
    "app/lib/evidence-map.ts",
    "app/lib/map.ts",
    "docs/a/PLAN.md",
    "docs/b/PLAN.md",
  ];
  assert.deepEqual(
    [...named("Read app/lib/evidence-map.ts first.", files)],
    ["app/lib/evidence-map.ts"],
  );
  assert.deepEqual(
    [...named("Then map.ts and PLAN.md", files)],
    ["app/lib/map.ts"],
  );
});

test("retrieval scores units by the query's words", () => {
  const pool = [
    ...split("a.md", "## Invoices\nThe invoice importer keeps its delimiter."),
    ...split("b.md", "## Weather\nSunny tiles on the display."),
  ];
  rank(pool, terms("Fix the invoice importer; the invoice delimiter changed."));
  assert.ok(pool[0].score > 0);
  assert.equal(pool[1].score, 0);
});

test("YAML splits into records beneath top-level keys with the comments above them; long records split at lines", () => {
  const answer = (topic: string) =>
    `    answer: >-\n${`      The ${topic} control is reviewed every quarter.\n`.repeat(4)}`;
  const detail = `    detail: ${"Each log stream has an owner who reviews alerts weekly. ".repeat(21)}`;
  const text = [
    "# Answer bank: one answer per topic, reused by every review.",
    "# Each questionnaire maps its own question ids to these topics, in its own order.",
    "version: 2",
    "from: policy-review",
    "",
    "topics:",
    "  # ---- encryption --",
    "  - key: encryption-at-rest",
    answer("encryption at rest"),
    "  - key: access-reviews",
    answer("access review"),
    "  - key: logging",
    "    summary: Logs are retained for a year.",
    detail,
    "",
  ].join("\n");
  const parts = split("policies/answers.yml", text);
  assert.deepEqual(
    parts.map((u) => u.section),
    [
      undefined,
      "topics > key: encryption-at-rest",
      "topics > key: access-reviews",
      "topics > key: logging",
      "topics > key: logging",
    ],
  );
  assert.match(parts[0].text, /from: policy-review$/);
  assert.match(parts[1].text, /^topics:\n {2}# ---- encryption --\n {2}- key/);
  assert.ok(parts[2].text.startsWith("  - key: access-reviews"));
  assert.equal(parts[4].text, detail.trimEnd());
  for (const u of parts) {
    assert.ok(u.text.length <= 1_200);
    assert.equal(u.text, text.slice(u.startChar, u.endChar));
    assert.ok(!u.startChar || text[u.startChar - 1] === "\n");
  }
});

test("YAML records need no blank lines; nested lists stay with their record", () => {
  const text = (lines: (i: number) => string[], head: string[] = []) =>
    [...head, ...[1, 2].flatMap(lines)].join("\n") + "\n";
  const prose = "Describe how vendor access is reviewed and approved. ";
  const sections = (name: string, body: string) =>
    split(name, body).map((u) => u.section);
  assert.deepEqual(
    sections(
      "q.yml",
      text(
        (i) => [
          `  - id: Q-${i}`,
          `    text: ${prose.repeat(3)}`,
          "    choices:",
          "      - yes",
        ],
        ["questions:"],
      ),
    ),
    ["questions > id: Q-1", "questions > id: Q-2"],
  );
  assert.deepEqual(
    sections(
      "controls.yml",
      text((i) => [
        `- id: control-${i}`,
        `  name: ${prose.repeat(3)}`,
        "  items:",
        "  - name: export",
      ]),
    ),
    ["id: control-1", "id: control-2"],
  );
  assert.deepEqual(
    sections(
      "services.yaml",
      text(
        (i) => [`  ledger-${i}:`, `    owner: ${prose.repeat(3)}`],
        ["services:"],
      ),
    ),
    ["services > ledger-1", "services > ledger-2"],
  );
});

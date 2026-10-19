import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeFiles, codexFiles, parseProgressNote } from "./native-events";

test("only bounded explicit progress notes are accepted, never embedded source text", () => {
  const value = {
    done: ["Read the plan"],
    remaining: ["Verify the change"],
    yourMove: "Use Open browser / sign in in this conversation",
  };
  const text = `PROJECTS_PROGRESS ${JSON.stringify(value)}`;
  assert.deepEqual(parseProgressNote(text), value);
  // Notes from sessions started before yourMove still parse.
  const legacy = { done: [], remaining: ["Verify the change"], blocker: null };
  assert.deepEqual(parseProgressNote(`PROJECTS_PROGRESS ${JSON.stringify(legacy)}`), legacy);
  for (const invalid of [
    null,
    `Quoted output: ${text}`,
    `\`\`\`\n${text}\n\`\`\``,
    `${text}\nprivate extra text`,
    "PROJECTS_PROGRESS {broken}",
    `PROJECTS_PROGRESS ${JSON.stringify({ ...value, token: "secret" })}`,
    `PROJECTS_PROGRESS ${JSON.stringify({ ...value, done: ["x".repeat(241)] })}`,
  ])
    assert.equal(parseProgressNote(invalid), null);
});

test("Claude reads and changes become paths and line ranges, never tool input text", () => {
  const cwd = "/work/project";
  assert.deepEqual(claudeFiles("Read", { file_path: "/work/project/src/a.ts", offset: 40, limit: 20 }, cwd), [
    { path: "/work/project/src/a.ts", lines: [40, 59] },
  ]);
  assert.deepEqual(claudeFiles("Read", { file_path: "src/a.ts" }, cwd), [{ path: "/work/project/src/a.ts" }]);
  assert.deepEqual(claudeFiles("Read", { file_path: "/work/project/a.md", limit: 10 }, cwd), [
    { path: "/work/project/a.md", lines: [1, 10] },
  ]);
  assert.deepEqual(
    claudeFiles("Edit", { file_path: "/work/project/src/a.ts", old_string: "private old", new_string: "private new" }, cwd),
    [{ path: "/work/project/src/a.ts", change: true }],
  );
  assert.deepEqual(claudeFiles("Write", { file_path: "/work/project/b.ts", content: "private" }, cwd), [
    { path: "/work/project/b.ts", change: true },
  ]);
  for (const [tool, input] of [
    ["Grep", { pattern: "private", path: "/work/project" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Bash", { command: "cat /work/project/src/a.ts" }],
    ["Read", { file_path: 7 }],
  ] as const)
    assert.deepEqual(claudeFiles(tool, input as Record<string, unknown>, cwd), []);
});

test("Codex command reads and applied patches become paths and line ranges, never commands or diffs", () => {
  const cwd = "/work/project";
  const read = (command: string, file = "src/a.ts", extra = {}) =>
    codexFiles(
      {
        type: "commandExecution",
        status: "completed",
        cwd: "/work/project/src",
        command: `bash -lc "${command}"`,
        aggregatedOutput: "private output",
        commandActions: [{ type: "read", command, name: "a.ts", path: file }],
        ...extra,
      },
      cwd,
    );
  assert.deepEqual(read("sed -n '120,220p' a.ts", "a.ts"), [{ path: "/work/project/src/a.ts", lines: [120, 220] }]);
  assert.deepEqual(read("sed -n 5p /work/project/README.md", "/work/project/README.md"), [
    { path: "/work/project/README.md", lines: [5, 5] },
  ]);
  assert.deepEqual(read("head -n 40 a.ts", "a.ts"), [{ path: "/work/project/src/a.ts", lines: [1, 40] }]);
  assert.deepEqual(read("cat a.ts", "a.ts"), [{ path: "/work/project/src/a.ts" }]);
  assert.deepEqual(read("sed -n '9,3p' a.ts", "a.ts"), [{ path: "/work/project/src/a.ts" }]);
  assert.deepEqual(read("cat a.ts", "a.ts", { status: "declined" }), []);
  assert.deepEqual(
    codexFiles(
      {
        type: "commandExecution",
        status: "completed",
        commandActions: [
          { type: "search", command: "rg private", query: "private", path: "src" },
          { type: "listFiles", command: "ls", path: "src" },
          { type: "unknown", command: "private-command" },
        ],
      },
      cwd,
    ),
    [],
  );
  const patch = (status: string) =>
    codexFiles(
      {
        type: "fileChange",
        status,
        changes: [
          { path: "/work/project/src/b.ts", kind: { type: "update" }, diff: "private diff" },
          { path: "docs/c.md", kind: { type: "add" }, diff: "private text" },
        ],
      },
      cwd,
    );
  assert.deepEqual(patch("completed"), [
    { path: "/work/project/src/b.ts", change: true },
    { path: "/work/project/docs/c.md", change: true },
  ]);
  assert.deepEqual(patch("failed"), []);
  assert.deepEqual(codexFiles({ type: "agentMessage", text: "/work/project/src/a.ts" }, cwd), []);
});

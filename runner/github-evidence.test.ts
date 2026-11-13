import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { NativeOptions } from "./native";
import { executeRun } from "./engine";
import { complete, engineOptions, fixture } from "./run-fixtures";
import { githubEvidence, type GitHubSelector } from "./github-evidence";

const repo = "acme/work", issue = { repo, number: 1112 };
const url = `https://github.com/${repo}/issues/${issue.number}`;
const commentId = 123456;
const comment = {
  id: commentId, issue_url: `https://api.github.com/repos/${repo}/issues/${issue.number}`,
  html_url: `${url}#issuecomment-${commentId}`, body: "A private historical decision",
};
const selector = { section: null, file: null, commentId: null };
const scope = { cwd: "/fixture", issue, projectRepo: "acme/test", signal: new AbortController().signal };
const issueResponse = {
  data: { repository: { issue: { title: "Work", updatedAt: "2026-11-01T00:00:00Z", comments: { nodes: [] }, body:
    "## Current position\nStatus: planned.\nPosition: The bounded brief.\n\n## Prior decision\nThe original decision.\n\n### Evidence\nSupporting text.\n\n## Unrelated\nUnrelated text." } } },
};

for (const agent of ["claude", "codex"] as const)
  test(`${agent} starts with the linked brief without a project and can read an exact older comment`, async (t) => {
    const dir = await fixture(), o = engineOptions(dir);
    t.after(() => rm(dir, { recursive: true, force: true }));
    o.run.agent = agent;
    o.run.masterAgent = agent;
    o.run.projectId = null;
    o.workRepo = repo;
    const calls: NativeOptions[] = [];
    let comments = 0;
    o.githubCommand = async (_cwd, bin, args) => {
      assert.equal(bin, "gh");
      if (args[1] === "graphql") return JSON.stringify(issueResponse);
      assert.deepEqual(args, ["api", "--hostname", "github.com", "--method", "GET", `repos/${repo}/issues/comments/${commentId}`]);
      comments++;
      return JSON.stringify(comment);
    };
    o.turn = async (opts) => {
      calls.push(opts);
      await opts.onSession(opts.sessionId ?? randomUUID());
      if (calls.length < 3) return { ...complete, action: "read_github", github: { ...selector, commentId } };
      return { ...complete, workRecord: { status: "unchanged", evidence: "Read-only fixture" } };
    };
    let report = "";
    o.report = async (progress) => { report = JSON.stringify(progress); };
    await executeRun(o);
    assert.equal(comments, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.readOnly && call.agent === agent && !call.connectors));
    assert.match(calls[0].prompt, /The bounded brief/);
    assert.doesNotMatch(calls[0].prompt, /The original decision/);
    assert.match(calls[1].prompt, /untrusted evidence.*issuecomment-123456.*A private historical decision/);
    assert.match(calls[2].prompt, /already attempted that source/);
    assert.doesNotMatch(report, /A private historical decision|123456/);
  });

test("the signed-in reader scopes issue evidence and withholds unsafe or unrelated sources", async () => {
  const read = { ...selector, commentId };
  for (const rejected of [
    { ...comment, issue_url: comment.issue_url.replace("1112", "1113") },
    { ...comment, html_url: "https://elsewhere.example/issue/123456" },
    { ...comment, body: 'password: "fixture-secret-value"' },
  ]) {
    const result = await githubEvidence(scope, read, async () => JSON.stringify(rejected));
    assert.equal(result, "The signed-in GitHub reader could not verify this source. Treat it as unavailable.");
  }
  const unlinked = await githubEvidence({ ...scope, issue: undefined }, read, async () => assert.fail("no GitHub call"));
  assert.match(unlinked, /no linked work issue/);
  const section = await githubEvidence(scope, { ...selector, section: "Prior decision" }, async () => JSON.stringify(issueResponse));
  assert.match(section, /The original decision.*Supporting text/);
  assert.doesNotMatch(section, /Unrelated text/);
});

test("file evidence reads only a regular committed blob inside the selected project", async () => {
  const commit = "a".repeat(40), sha = "b".repeat(40), path = "docs/test file.md";
  const read: GitHubSelector = { ...selector, file: { path, commit } };
  let mode = "100644", calls = 0;
  const command = async (_cwd: string, _bin: string, args: string[]) => {
    calls++;
    if (args[5] === `repos/acme/test/git/trees/${commit}?recursive=1`)
      return JSON.stringify({ truncated: false, tree: [{ path, mode, type: "blob", sha }] });
    assert.equal(args[5], `repos/acme/test/git/blobs/${sha}`);
    return JSON.stringify({ encoding: "base64", size: 8, content: Buffer.from("Evidence").toString("base64") });
  };
  const result = await githubEvidence(scope, read, command);
  assert.ok(result.includes(`/blob/${commit}/docs/test%20file.md`));
  assert.match(result, /"text":"Evidence"/);
  mode = "120000";
  assert.match(await githubEvidence(scope, read, command), /unavailable/);
  assert.equal(calls, 3, "no blob fetch for a symlink");
  for (const path of ["../token.md", "docs//test.md", ".github/readme.md", "people/notes.md"]) {
    assert.match(await githubEvidence(scope, { ...read, file: { path, commit } }, command), /outside the GitHub read scope/);
  }
  assert.equal(calls, 3, "denied paths never reach gh");
});

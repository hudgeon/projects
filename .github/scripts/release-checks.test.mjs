import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_CHECK, ciPassed } from "./release-checks.mjs";

const run = (name, conclusion, id = 15368) => ({ name, conclusion, app: { id } });

test("a release needs the head's ci check from GitHub Actions, every run of it passed", () => {
  assert.equal(ciPassed([run("ci", "success"), run("queued", "skipped")]), true);
  assert.equal(ciPassed([run("ci", "success"), run("ci", "failure")]), false);
  assert.equal(ciPassed([run("ci", "skipped")]), false);
  assert.equal(ciPassed([run("ci", "success", 1)]), false, "another app's check of the same name");
  assert.equal(ciPassed([run("Validate", "success")]), false);
  assert.equal(ciPassed([]), false);
});

test("the gate's check is the job the CI workflow reports under that name", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const job = workflow.match(new RegExp(`^  ${CI_CHECK}:\\n((?:    .*\\n|\\n)*)`, "m"));
  assert.ok(job, "ci.yml has the job");
  assert.doesNotMatch(job[1], /^    name:/m, "a job name would rename the check");
});

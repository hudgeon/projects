import { test } from "node:test";
import assert from "node:assert/strict";
import { eligible } from "../runner/project-sources";

test("people, legal, HR and personnel records are never eligible; code named for such features is", () => {
  for (const name of [
    "people/jane.md",
    "legal/nda/invoice-nda.md",
    "scripts/legal/send.py",
    "hr/onboarding.ts",
    "policies/human-resources-policy.md",
    "audit/performance-reviews-2026.md",
    "docs/staff-onboarding.md",
    "legal.md",
    "person.md",
  ])
    assert.equal(eligible(name), false, name);
  for (const name of [
    "app/lib/people.server.ts",
    "migrations/0045_personnel_documents.sql",
    "src/server/api/staff.ts",
    "performance_improvements/plan.md",
    "docs/PLAN.md",
  ])
    assert.equal(eligible(name), true, name);
});

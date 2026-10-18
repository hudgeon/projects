import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { credentialLike, eligible } from "../runner/project-sources";

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
    "policies/people-roster.yml",
    "hr/benefits.yaml",
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

test("YAML is eligible outside hidden folders, secret-named paths and lockfiles", () => {
  for (const name of [
    "policies/security-questionnaire.yml",
    "policies/questionnaires/vendor-review.yaml",
    "config/settings.yml",
  ])
    assert.equal(eligible(name), true, name);
  for (const name of [
    ".github/workflows/ci.yml",
    "deploy/.circleci/config.yml",
    "secrets.yml",
    "config/secrets/app.yaml",
    "credentials.yml",
    "tokens.yaml",
    "pnpm-lock.yaml",
  ])
    assert.equal(eligible(name), false, name);
});

test("unquoted YAML secrets are credentials; references, prose and code expressions are not", () => {
  const value = randomUUID().replaceAll("-", "");
  for (const text of [
    `api_token: ${value}\n`,
    `database:\n  password: ${value} # rotated\n`,
    `environment:\n  - DB_PASSWORD=${value}\n`,
    `client_secret: >-\n  ${value}\n`,
    `aws_secret_access_key: ${value}\r\n`,
    `apiVersion: v1\nkind: Secret\ndata:\n  db: ${Buffer.from(value).toString("base64")}\n`,
  ])
    assert.equal(credentialLike(text, "deploy/config.yml"), true, text);
  for (const text of [
    "password: ${DB_PASSWORD}\n",
    "token: $DEPLOY_TOKEN\n",
    "secret: STRIPE_SECRET_KEY\n",
    "client_secret: Kept in the secrets manager and rotated quarterly.\n",
    "token:\n  description: Reads the package registry\n",
    "max_tokens: 4096\n",
  ])
    assert.equal(credentialLike(text, "deploy/config.yml"), false, text);
  assert.equal(
    credentialLike(`const body = {\n  api_token: ${value},\n};\n`, "src/a.ts"),
    false,
  );
});

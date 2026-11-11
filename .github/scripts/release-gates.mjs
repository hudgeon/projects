import { readFileSync } from "node:fs";
import { unstable_readConfig } from "wrangler";
import { requiredSecretNames } from "./wrangler-config.mjs";
import { ciPassed } from "./release-checks.mjs";
const { GH_TOKEN, REPO, SHA, DOPPLER_IDENTITY_ID, SECURITY_REVIEW_BOT_ID } =
  process.env;
if (!DOPPLER_IDENTITY_ID)
  throw Error("Configure the project-scoped Doppler production identity first");
// Whether releases need a security review is committed policy, changed only
// by a reviewed pull request; the repository variable only names the bot whose
// passing "security-review" status counts, or "none" where the policy allows.
const policy = JSON.parse(readFileSync(".github/release-policy.json", "utf8"));
if (!["required", "optional"].includes(policy.securityReview))
  throw Error("Release policy must make the security review required or optional");
if (!/^(\d+|none)$/.test(SECURITY_REVIEW_BOT_ID ?? ""))
  throw Error("Set the SECURITY_REVIEW_BOT_ID repository variable, or none");
if (SECURITY_REVIEW_BOT_ID === "none" && policy.securityReview === "required")
  throw Error("This repository's release policy requires a security review");
const required = requiredSecretNames();
for (const name of ["ALLOWED_EMAILS"])
  if (!required.includes(name))
    throw Error(`Declare ${name} before publishing`);
// Sign-in codes go out through Cloudflare Email Service.
const config = unstable_readConfig({});
for (const name of ["SITE_URL", "OWNER_EMAIL", "EMAIL_FROM"])
  if (!config.vars?.[name]) throw Error(`Declare ${name} before publishing`);
if (!config.send_email?.some((binding) => binding.name === "EMAIL"))
  throw Error("Declare the EMAIL send_email binding before publishing");
async function read(path) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok)
    throw Error(`Release gate lookup failed (${response.status})`);
  return response.json();
}
const prs = await read(`commits/${SHA}/pulls`);
const pr = prs.find(
  (pr) => pr.merged_at && pr.base.ref === "main" && pr.merge_commit_sha === SHA,
);
if (!pr) throw Error("Release must be a reviewed, merged main PR");
const statuses = await read(`commits/${pr.head.sha}/statuses`);

const review = statuses.find((s) => s.context === "security-review");
if (
  SECURITY_REVIEW_BOT_ID !== "none" &&
  (review?.state !== "success" ||
    String(review.creator?.id) !== SECURITY_REVIEW_BOT_ID ||
    review.creator?.type !== "Bot")
)
  throw Error(
    "Required security review has not passed from the configured bot",
  );
const checks = await read(`commits/${pr.head.sha}/check-runs`);
if (!ciPassed(checks.check_runs))
  throw Error("Required GitHub Actions CI has not passed");
console.log("Reviewed PR, CI and release configuration verified");

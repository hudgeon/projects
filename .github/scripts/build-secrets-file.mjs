#!/usr/bin/env node
// Writes the deploy-time secrets file that `wrangler deploy --secrets-file`
// uploads, from `secrets.required` in the wrangler config and the job
// environment that DopplerHQ/secrets-fetch-action injected.
//
// Doppler resolves 33 names into the job env — the 17 the Worker reads, the
// deploy-capable CLOUDFLARE_API_TOKEN the deploy step itself needs, the
// operator-only strings (DATABASE_URL_ADMIN, the local Hyperdrive connection
// strings) and the three DOPPLER_* markers. Only the names in secrets.required
// are written here, so only those reach the Worker.
//
// Usage: node scripts/ci/build-secrets-file.mjs <output-path>
import { writeFileSync } from "node:fs";
import { unstable_readConfig } from "wrangler";
import { ownerAllowed, requiredSecretNames } from "./wrangler-config.mjs";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("usage: build-secrets-file.mjs <output-path>");
}

const required = requiredSecretNames();

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Doppler supplied no value for: ${missing.join(", ")}. ` +
      "Check the name in the wrangler config against the Doppler config, and that " +
      "the service account can read the config it is inherited from.",
  );
}

// This is the first step with both in hand: the owner from the filled-in
// config and the allowlist from Doppler. A list without the owner would
// deploy a site its owner cannot sign in to, so it stops the release here;
// an unset or empty list fails the same way (after the check above, when
// the list is a required secret), never skipping this.
const owner = unstable_readConfig({}).vars?.OWNER_EMAIL;
if (owner && !ownerAllowed(owner, process.env.ALLOWED_EMAILS)) {
  throw new Error(
    "OWNER_EMAIL is not one of ALLOWED_EMAILS: add the deployment owner's address to the Doppler config so they can sign in.",
  );
}

writeFileSync(
  outputPath,
  JSON.stringify(
    Object.fromEntries(required.map((name) => [name, process.env[name]])),
  ),
  { mode: 0o600 },
);

console.log(
  `Wrote ${required.length} secrets to ${outputPath}: ${required.join(", ")}`,
);

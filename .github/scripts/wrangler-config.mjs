import { unstable_readConfig } from "wrangler";
export function requiredSecretNames() {
  const names = unstable_readConfig({}).secrets?.required;
  if (!Array.isArray(names) || !names.length)
    throw Error("Missing secrets.required");
  return names;
}
// Whether the deployment owner can sign in: OWNER_EMAIL, which Deploy writes
// into the config from PROJECTS_OWNER_EMAIL, is one of ALLOWED_EMAILS, which
// Doppler supplies. Compared as the Worker does (worker/auth.ts): trimmed,
// case-insensitive.
export function ownerAllowed(owner, allowedEmails) {
  const address = (owner ?? "").trim().toLowerCase();
  return (
    address !== "" &&
    (allowedEmails ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .includes(address)
  );
}

// Gmail access for a person who never signs in on this machine: a Workspace
// service account with domain-wide delegation stands in for them. Its key
// lives only in the machine's Doppler config and is read into memory for one
// token at a time: a JWT grant naming the person as its subject, signed with
// Node's own crypto and exchanged for an hour's access token limited to the
// scopes below. gws cannot do this itself (0.22.5 has no impersonation), but
// it takes a pre-obtained token, so gws stays the Gmail client. The key can
// reach every mailbox in the domain, so a token is only ever minted for an
// account machine.json lists as delegated (collector/inbox-logins.ts), and
// Google's own grant is checked again by the profile read that follows.
import { createSign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

// What inboxes are read with, what inbox actions and the email lane change
// with, and so the whole list the delegation is authorised for: the Admin
// console entry must match it exactly (docs/self-host.md).
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const DELEGATION_SCOPES = [GMAIL_READ_SCOPE, GMAIL_MODIFY_SCOPE] as const;
// The machine secret holding the service account's key file as Google issued it.
export const DELEGATION_SECRET = "GMAIL_DELEGATION_KEY";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// A delegated gws call runs on the token alone: an empty config directory and
// no application default credentials, so nothing of this machine's user (a
// sign-in, a client project to bill, a quota project) is consulted beside it.
export const NO_MAILBOX_DIR = path.join(tmpdir(), "projects-no-mailbox");
export const delegatedEnv = (token: string) => ({
  GOOGLE_WORKSPACE_CLI_TOKEN: token,
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR: NO_MAILBOX_DIR,
  GOOGLE_APPLICATION_CREDENTIALS: path.join(NO_MAILBOX_DIR, "none.json"),
});
// A signed grant is as good as the token it buys, so it goes to Google's token
// endpoint and nowhere a key file might name instead; the key is the PKCS#8
// PEM Google issues, no other format.
const keySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z
    .string()
    .regex(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\s*$/),
  token_uri: z.literal(TOKEN_ENDPOINT).optional(),
});
export type DelegationKey = z.infer<typeof keySchema>;
// The key as Doppler holds it; anything else is refused without being echoed.
export function parseDelegationKey(raw: string): DelegationKey {
  try {
    return keySchema.parse(JSON.parse(raw));
  } catch {
    throw Error(`${DELEGATION_SECRET} is not a service account key.`);
  }
}
const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// The grant: this key asks for the person's Gmail, at this scope, for an hour.
export function delegationGrant(
  key: DelegationKey,
  subject: string,
  scope: string,
  now = Date.now(),
) {
  const iat = Math.floor(now / 1000);
  const claims = { iss: key.client_email, sub: subject, scope, aud: TOKEN_ENDPOINT, iat, exp: iat + 3600 };
  const signed = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(key.private_key, "base64url")}`;
}
// An access token for the person, or an error naming only Google's error
// code: never the account, the grant or the key.
export async function delegatedToken(
  key: DelegationKey,
  subject: string,
  scope: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: delegationGrant(key, subject, scope, now),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = z
    .object({ access_token: z.string().min(1).optional(), error: z.string().optional() })
    .safeParse(await response.json().catch(() => null)).data;
  if (!response.ok || !body?.access_token) {
    const code = body?.error?.match(/^[a-z_]{1,40}$/)?.[0];
    throw Error(`Delegated Gmail access was refused${code ? ` (${code})` : ""}.`);
  }
  return body.access_token;
}

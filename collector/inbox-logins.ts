// gws as one connected account: a person's own sign-in on this machine, the
// machine's default for the owner's account, or, for a person who never signs
// in here, an hour's delegated token minted for them and handed to gws.
import { createHash } from "node:crypto";
import { sameAccount, trackedThreads, type Inbox } from "../src/inbox-model";
import type { Issue } from "../src/work-model";
import { command, machineSecret } from "./command";
import { inboxLogins, type Config, type InboxLogin } from "./config";
import {
  DELEGATION_SECRET,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READ_SCOPE,
  delegatedEnv,
  delegatedToken,
  parseDelegationKey,
  type DelegationKey,
} from "./delegation";
import { readInbox, type Gws } from "./inbox";

// A sign-in's gws: its own config directory, or the machine's default.
export const gwsFor =
  (login: InboxLogin): Gws =>
  (args) =>
    command(
      "gws",
      args,
      undefined,
      login.configDir ? { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: login.configDir } : {},
    );
// The service account key, read from Doppler once per process and kept in
// memory only; it never enters an environment or a file.
const keys = new WeakMap<object, Promise<DelegationKey>>();
export function delegationKey(config: Pick<Config, "home" | "doppler">) {
  let key = keys.get(config);
  if (!key)
    keys.set(config, (key = machineSecret(config, DELEGATION_SECRET).then(parseDelegationKey)));
  return key;
}
// One token for the account at that scope, minted at the first call. A
// refusal is logged by reason, never by account, and makes every call fail,
// so the inbox reads as unavailable.
export function delegatedGws(account: string, scope: string, key: () => Promise<DelegationKey>): Gws {
  let token: Promise<string> | undefined;
  return async (args) =>
    command(
      "gws",
      args,
      undefined,
      delegatedEnv(
        await (token ??= key()
          .then((k) => delegatedToken(k, account, scope))
          .catch((error: unknown) => {
            console.error(JSON.stringify({ event: "inbox_delegation_failed", reason: error instanceof Error ? error.message : "unknown" }));
            throw error;
          })),
      ),
    );
}
// One delegated gws per account and scope for a config, so a scan's reads
// and its actions each mint one token per account.
const delegated = new WeakMap<object, Map<string, Gws>>();
export function inboxGws(config: Pick<Config, "home" | "doppler">, login: InboxLogin, scope: string): Gws {
  if (!login.delegated) return gwsFor(login);
  let known = delegated.get(config);
  if (!known) delegated.set(config, (known = new Map()));
  const name = `${scope} ${login.account.toLowerCase()}`;
  let gws = known.get(name);
  if (!gws) known.set(name, (gws = delegatedGws(login.account, scope, () => delegationKey(config))));
  return gws;
}
// What the runner hands its conversations: the connected logins, and an
// hour's token for a delegated mailbox at each of its owner's turns. Only an
// account this machine lists as delegated gets one, whatever the key could
// reach; the key is read for each token and kept in the executor's memory only.
export const mailboxes = (config: Config) => ({
  inboxes: inboxLogins(config),
  mailboxToken: async (account: string) => {
    const login = inboxLogins(config).find((l) => sameAccount(l.account, account));
    if (!login?.delegated) throw Error("Not a delegated mailbox on this machine.");
    const key = parseDelegationKey(await machineSecret(config, DELEGATION_SECRET));
    return delegatedToken(key, login.account, GMAIL_MODIFY_SCOPE);
  },
});
// The owner's account keeps the cache file it always had; every other account
// has its own, named without the address. The name only tells a few local
// files apart (ten accounts at most); it is not meant to be collision-proof.
export const inboxCacheName = (account: string, config: Pick<Config, "inboxAccount">) =>
  config.inboxAccount?.toLowerCase() === account.toLowerCase()
    ? "inbox-cache.json"
    : `inbox-cache.${createHash("sha256").update(account.toLowerCase()).digest("hex").slice(0, 16)}.json`;
// Every connected inbox, each read with its own sign-in or delegated token and
// checked against it, for the machine on duty. One account's failure is its own.
export async function readInboxes(
  config: Config,
  issues: Issue[] | null | undefined,
  gws: (login: InboxLogin) => Gws = (login) => inboxGws(config, login, GMAIL_READ_SCOPE),
  now = Date.now(),
): Promise<Inbox[]> {
  const inboxes: Inbox[] = [];
  for (const login of inboxLogins(config))
    inboxes.push(
      await readInbox(
        login.account,
        gws(login),
        now,
        config.home,
        trackedThreads(login.account, issues ?? []),
        inboxCacheName(login.account, config),
      ),
    );
  return inboxes;
}

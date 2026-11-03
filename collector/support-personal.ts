// An explicit owner's connected inbox can feed the existing support pipeline.
// Qualification happens locally before personal text reaches that queue.
import { inboxLogins, type Config } from "./config";
import { delegatedGws, delegationKey, gwsFor } from "./inbox-logins";
import { GMAIL_READ_SCOPE } from "./delegation";
import { readSupport, type SupportThread } from "./support-gmail";
import { mailHash } from "./mail-identity";
import type { DeliveryReport } from "./mail-delivery";
import type { SupportConfig } from "../src/support-model";
export function personalSupportConfig(config: SupportConfig): SupportConfig {
  if (!config.personalInbox || config.personalInbox.account.toLowerCase() !== config.owner.toLowerCase()) throw Error("Personal support intake is not enabled");
  return { ...config, account: config.personalInbox.account, aliases: [...config.aliases, config.account],
    since: config.personalInbox.since, draftSince: config.personalInbox.since, forwarders: [], forwardSince: undefined };
}
export function personalSupportGws(config: Config) {
  const source = config.support?.personalInbox;
  const login = source && inboxLogins(config).find(l => l.account.toLowerCase() === source.account.toLowerCase());
  if (!login || source!.account.toLowerCase() !== config.support!.owner.toLowerCase()) throw Error("Owner inbox is not connected");
  return login.delegated ? delegatedGws(login.account, GMAIL_READ_SCOPE, () => delegationKey(config)) : gwsFor(login);
}
export function personalThread(thread: SupportThread, config: SupportConfig, key?: string): SupportThread {
  return { ...thread, sourceAccount: config.personalInbox!.account,
    key: key ?? mailHash(`${config.account.toLowerCase()}\n${config.personalInbox!.account.toLowerCase()}\n${thread.id}`) };
}
export async function readPersonalSupport(config: SupportConfig, gws: import("./inbox").Gws, directory: () => Promise<ReadonlySet<string>>, reports: Map<string, DeliveryReport>) {
  const read = await readSupport(personalSupportConfig(config), gws, reports, true);
  const users = await directory();
  return { ...read, threads: read.threads.filter(t => t.at >= Date.parse(config.personalInbox!.since) && users.has(mailHash(t.from))).map(t => personalThread(t, config)) };
}
export function mergeSupportCopies(shared: SupportThread[], personal: SupportThread[]): SupportThread[] {
  const result = [...shared];
  for (const thread of personal) {
    const matches = result.map((t, i) => t.messageKeys.some(key => thread.messageKeys.includes(key)) ? i : -1).filter(i => i >= 0);
    if (!matches.length) result.push(thread);
    else if (matches.length === 1) {
      const index = matches[0], existing = result[index];
      result[index] = { ...(thread.at > existing.at ? thread : existing), key: existing.key,
        messageKeys: [...new Set([...existing.messageKeys, ...thread.messageKeys])].slice(-200) };
    } else throw Error("Ambiguous support copies need review");
  }
  return result;
}

// The shared mailbox joins the existing per-person message queue. Reads and
// acknowledgments run only on the machine on duty. Gmail keeps the record;
// Projects stores the latest bounded text, source links and delivery receipts.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import { delegationKey, delegatedGws, gwsFor } from "./inbox-logins";
import { GMAIL_MODIFY_SCOPE, GMAIL_READ_SCOPE } from "./delegation";
import { readSupport, acknowledgmentRaw, sentAcknowledgment, type SupportThread } from "./support-gmail";
import { summarizeSupport } from "./support-summary";
import { readSupportUsers } from "./support-users";
import { mailHash } from "./mail-identity";
import type { DeliveryReport } from "./mail-delivery";
import { acknowledgmentText, type Acknowledgment, type AcknowledgmentInput } from "../src/support-model";
import { CHAT_TEXT_LIMIT, type ChatRead } from "../src/chat-model";
import { gmailUrl } from "../src/inbox-model";
import { postChatRead, type Site } from "./upload";
import type { Gws } from "./inbox";
type Support = NonNullable<Config["support"]>;
type Ack = (thread: SupportThread, action: AcknowledgmentInput["action"], token?: string) => Promise<Acknowledgment | null>;
type SendState = "off" | "pending" | "sent" | "uncertain" | "failed" | "skipped";
// Exported separately so the transport/uncertain-send boundary is exercised
// against a real durable ledger with a controlled Gmail transport.
export async function acknowledgeSupport(thread: SupportThread, config: Support, o: {
  ack: Ack; gws: Gws; summarize: (body: string) => Promise<{ support: boolean; summary: string }>;
  token?: string; saveToken: (token: string) => Promise<void>;
  users: () => Promise<ReadonlySet<string>>;
}): Promise<{ state: SendState; at?: number }> {
  if (thread.acknowledgedAt !== undefined) return { state: "sent", at: thread.acknowledgedAt };
  if (!config.acknowledge) return { state: "off" };
  if (!thread.eligible || !thread.recipients || !thread.body) return { state: "skipped" };
  if (!thread.deliveryHistoryComplete) return { state: "failed" };
  const users = await o.users();
  if (!users.has(mailHash(thread.from))) return { state: "skipped" };
  const keep = (email: string) => config.registeredRecipients === "sender" || users.has(mailHash(email));
  const recipients = { to: thread.recipients.to.filter(keep), cc: thread.recipients.cc.filter(keep) };
  if (!recipients.to.length && recipients.cc.length) recipients.to.push(recipients.cc.shift()!);
  if (!recipients.to.length) return { state: "skipped" };
  const receipt = await o.ack(thread, "reserve", o.token);
  if (!receipt) return { state: "failed" };
  if (receipt.state === "sent") return { state: "sent", at: receipt.acknowledgedAt };
  const messageId = `<projects-support-${thread.key}@${config.account.split("@")[1]}>`;
  if (receipt.state !== "reserved") {
    // A prior attempt crossed the send boundary. Reconcile Sent, never replay.
    if ((receipt.token ?? o.token) && await sentAcknowledgment(o.gws, config, thread)) {
      const sent = await o.ack(thread, "sent", receipt.token ?? o.token);
      return sent?.state === "sent" ? { state: "sent", at: sent.acknowledgedAt } : { state: "uncertain" };
    }
    return { state: "uncertain" };
  }
  if (!receipt.token) return { state: "pending" };
  const summary = await o.summarize(thread.body);
  if (!summary.support) { await o.ack(thread, "release", receipt.token); return { state: "skipped" }; }
  await o.saveToken(receipt.token);
  const raw = acknowledgmentRaw(config, thread, acknowledgmentText(summary.summary), messageId, recipients);
  const begun = await o.ack(thread, "begin", receipt.token);
  if (!begun?.send) return { state: begun?.state === "sent" ? "sent" : "uncertain", at: begun?.acknowledgedAt };
  try {
    const sent = JSON.parse(await o.gws(["gmail", "users", "messages", "send", "--params", JSON.stringify({ userId: "me" }), "--json", JSON.stringify({ threadId: thread.id, raw })]));
    if (typeof sent.id !== "string" || !sent.id) throw Error();
    const recorded = await o.ack(thread, "sent", receipt.token);
    return recorded?.state === "sent" ? { state: "sent", at: recorded.acknowledgedAt } : { state: "uncertain" };
  } catch {
    await o.ack(thread, "uncertain", receipt.token).catch(() => null);
    return { state: "uncertain" };
  }
}
export function startSupport(config: Config, site: Site, stateDir: string) {
  const support = config.support;
  if (!support) return () => {};
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const tokensFile = path.join(stateDir, "support-send-tokens.json");
  const tokens: Record<string, string> = {};
  const skipped = new Map<string, number>();
  const reports = new Map<string, DeliveryReport>();
  const ready = readFile(tokensFile, "utf8").then(text => {
    if (text.length > 100_000) throw Error();
    for (const [key, value] of Object.entries(JSON.parse(text)))
      if (/^[a-f0-9]{64}$/.test(key) && typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)) tokens[key] = value;
  }).catch(() => {});
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(new URL(route, site.endpoint), { headers: site.headers,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error("Support service unavailable");
    return response.json() as Promise<Record<string, unknown>>;
  };
  const tick = async () => {
    await ready;
    let onDuty = false;
    try {
      onDuty = (await request("/api/collector/duties")).duties === true;
      if (!onDuty) return;
      // Fresh short-lived tokens for each scan, rather than an hour's token
      // accidentally cached for the lifetime of this continuous watcher.
      const as = (scope: string) => support.configDir ? gwsFor({ account: support.account, configDir: support.configDir })
        : delegatedGws(support.account, scope, () => delegationKey(config));
      const read = await readSupport(support, as(GMAIL_READ_SCOPE), reports);
      const items: ChatRead["items"] = read.threads.map(thread => ({ id: thread.key,
        place: { name: thread.subject.slice(0, 160), kind: "thread", url: gmailUrl(support.account, thread.id) },
        from: thread.from.slice(0, 120), at: thread.at, count: 1, unread: thread.unread, mention: true, text: thread.body.slice(0, CHAT_TEXT_LIMIT),
        support: { account: support.account, thread: thread.id, messageKeys: thread.messageKeys,
          ...(thread.humanRepliedAt === undefined ? {} : { humanRepliedAt: thread.humanRepliedAt }),
          acknowledgment: thread.acknowledgedAt !== undefined ? "sent" : support.acknowledge ? "pending" : "off",
          ...(thread.acknowledgedAt === undefined ? {} : { acknowledgedAt: thread.acknowledgedAt }) } }));
      const publish = () => postChatRead(site, { source: "support", owner: support.owner, observedAt: Date.now(), state: read.complete ? "ok" : "incomplete", items });
      // Intake reaches its human owner before a model runs. A queue that could
      // not accept the request cannot send a receipt promising a human reply.
      if (await publish() !== 200) return;
      let users: Promise<ReadonlySet<string>> | undefined, usersAt = 0;
      const directory = () => {
        if (!users || Date.now() - usersAt > 30_000) {
          usersAt = Date.now();
          users = readSupportUsers(support.usersCommand, stateDir);
        }
        return users;
      };
      for (const [index, thread] of read.threads.entries()) {
        let sent: Awaited<ReturnType<typeof acknowledgeSupport>> = { state: support.acknowledge ? "pending" : "off" };
        try {
          sent = !read.complete && thread.acknowledgedAt === undefined ? { state: "failed" }
            : skipped.get(thread.key) === thread.at ? { state: "skipped" } : await acknowledgeSupport(thread, support, {
            users: directory,
            ack: async (t, action, token) => (await request("/api/support/ack", { key: t.key, owner: support.owner, account: support.account, action, ...(token ? { token } : {}) })).receipt as Acknowledgment | null,
            gws: as(GMAIL_MODIFY_SCOPE), token: tokens[thread.key],
            saveToken: async token => {
              tokens[thread.key] = token;
              const temporary = `${tokensFile}.${process.pid}.tmp`;
              await writeFile(temporary, JSON.stringify(tokens), { mode: 0o600 });
              await rename(temporary, tokensFile);
            },
            summarize: async body => {
              const summary = await summarizeSupport(body, path.join(stateDir, "support-summary"));
              if (!summary.support) skipped.set(thread.key, thread.at);
              return summary;
            },
          });
        } catch { sent = { state: "failed" }; }
        items[index].support = { ...items[index].support!, acknowledgment: sent.state, ...(sent.at === undefined ? {} : { acknowledgedAt: sent.at }) };
      }
      await publish();
    } catch {
      if (onDuty) await postChatRead(site, { source: "support", owner: support.owner, observedAt: Date.now(), state: "unavailable", problem: "Support mailbox or acknowledgment service unavailable", items: [] });
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), 30_000);
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

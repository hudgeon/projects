// The shared mailbox joins the existing per-person message queue. Reads and
// acknowledgments run only on the machine on duty. Gmail keeps the record;
// Projects stores the latest bounded text, source links and delivery receipts.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import { delegationKey, delegatedGws, gwsFor } from "./inbox-logins";
import { GMAIL_MODIFY_SCOPE, GMAIL_READ_SCOPE } from "./delegation";
import { readSupport } from "./support-gmail";
import { prepareSupportDraft, type DraftOutcome } from "./support-draft";
import { summarizeSupport } from "./support-summary";
import { readSupportUsers } from "./support-users";
import { messageKey } from "./mail-identity";
import type { DeliveryReport } from "./mail-delivery";
import { supportInvestigationViewSchema, supportReceiptSchema, type Acknowledgment } from "../src/support-model";
import { CHAT_TEXT_LIMIT, type ChatRead } from "../src/chat-model";
import { gmailUrl } from "../src/inbox-model";
import { postChatRead, type Site } from "./upload";
function requestMetadata(thread: import("./support-gmail").SupportThread) {
  if (thread.forwarded || !thread.eligible || !thread.deliveryHistoryComplete) return undefined;
  const parsed = supportReceiptSchema.shape.request.safeParse({ key: messageKey(thread.messageId ?? ""), sender: thread.from, audience: thread.recipients });
  return parsed.success ? parsed.data : undefined;
}
export function startSupport(config: Config, site: Site, stateDir: string) {
  const support = config.support;
  if (!support) return () => {};
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const tokensFile = path.join(stateDir, "support-send-tokens.json");
  const tokens: Record<string, string> = {};
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
      const duty = await request("/api/collector/duties");
      onDuty = duty.duties === true;
      if (!onDuty) return;
      // Fresh short-lived tokens for each scan, rather than an hour's token
      // accidentally cached for the lifetime of this continuous watcher.
      const as = (scope: string) => support.configDir ? gwsFor({ account: support.account, configDir: support.configDir })
        : delegatedGws(support.account, scope, () => delegationKey(config));
      const read = await readSupport(support, as(GMAIL_READ_SCOPE), reports);
      const items: ChatRead["items"] = read.threads.map(thread => ({ id: thread.key,
        place: { name: thread.subject.slice(0, 160), kind: "thread", url: gmailUrl(support.account, thread.id) },
        from: `${thread.from}${thread.forwarded ? " (forwarded)" : ""}`.slice(0, 120), at: thread.at, count: 1, unread: thread.unread, mention: true, text: thread.body.slice(0, CHAT_TEXT_LIMIT),
        support: { account: support.account, thread: thread.id, messageKeys: thread.messageKeys,
          ...(requestMetadata(thread) ? { request: requestMetadata(thread) } : {}),
          ...(thread.humanRepliedAt === undefined ? {} : { humanRepliedAt: thread.humanRepliedAt }),
          acknowledgment: thread.acknowledgedAt !== undefined ? "sent" : "off",
          draft: support.draft ? "pending" : "off",
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
        let draft: DraftOutcome = { state: support.draft ? "pending" : "off" };
        try {
          draft = !read.complete && thread.acknowledgedAt === undefined ? { state: "failed" }
            : await prepareSupportDraft(thread, support, {
            users: directory, reports: [...reports.values()],
            ack: async (t, action, token, details) => (await request("/api/support/ack", { key: t.key, owner: support.owner, account: support.account, action, requestKey: messageKey(t.messageId ?? ""), ...(token ? { token } : {}), ...details })).receipt as Acknowledgment | null,
            gws: as(GMAIL_MODIFY_SCOPE), token: tokens[thread.key],
            saveToken: async token => {
              tokens[thread.key] = token;
              const temporary = `${tokensFile}.${process.pid}.tmp`;
              await writeFile(temporary, JSON.stringify(tokens), { mode: 0o600 });
              await rename(temporary, tokensFile);
            },
            summarize: async body => {
              const summary = await summarizeSupport(body, path.join(stateDir, "support-summary"));
              return summary;
            },
            ...(duty.supportInvestigation === true && !thread.forwarded ? { investigate: async (summary: import("../src/support-model").SupportSummary) => {
              let view: import("../src/support-model").SupportInvestigationView;
              try {
                const result = await request("/api/collector/support-investigation", { action: "bootstrap", key: thread.key, owner: support.owner, requestKey: messageKey(thread.messageId!), summary });
                view = supportInvestigationViewSchema.parse(result.investigation);
              } catch { view = { state: "unavailable" }; }
              items[index].support = { ...items[index].support!, investigation: view };
              return view;
            } } : {}),
          });
        } catch { draft = { state: "failed" }; }
        items[index].support = { ...items[index].support!, draft: draft.state, ...(draft.at === undefined ? {} : { draftedAt: draft.at }), ...(draft.triage ? { triage: draft.triage } : {}) };
      }
      await publish();
    } catch {
      if (onDuty) await postChatRead(site, { source: "support", owner: support.owner, observedAt: Date.now(), state: "unavailable", problem: "Support mailbox or draft service unavailable", items: [] });
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), 30_000);
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// Gmail transport for the existing support coordinator. Its only mutation is
// drafts.create. Unknown outcomes are reconciled, never replayed or sent.
import { acknowledgmentRaw, senderOnlyDraft, supportThread, type SupportThread } from "./support-gmail";
import { mailHeaders, type DeliveryReport, type MailMessage } from "./mail-delivery";
import { messageKey, rfcMessageId } from "./mail-identity";
import { mailHash } from "./mail-identity";
import { personalSupportConfig, personalThread } from "./support-personal";
import { supportDestination, findDetachedSupportDraft } from "./support-destination";
import { groundedSupportSummary, pendingSupportSummary } from "./support-summary";
import type { Gws } from "./inbox";
import { acknowledgmentText, type Acknowledgment, type AcknowledgmentInput, type SupportConfig, type SupportSummary, type SupportInvestigationView } from "../src/support-model";
type DraftState = "off" | "pending" | "ready" | "uncertain" | "failed" | "stale" | "held" | "skipped";
export type DraftOutcome = { state: DraftState; at?: number; triage?: SupportSummary["kind"] };
type Ack = (thread: SupportThread, action: AcknowledgmentInput["action"], token?: string, details?: Pick<AcknowledgmentInput, "draftId" | "triage">) => Promise<Acknowledgment | null>;
const params = (gws: Gws, resource: string, method: string, value: object) => gws(["gmail", "users", ...(resource ? [resource] : []), method, "--params", JSON.stringify(value)]).then(JSON.parse);
export async function refreshSupportThread(gws: Gws, config: SupportConfig, thread: SupportThread, reports: DeliveryReport[] = []) {
  const profile = await params(gws, "", "getProfile", { userId: "me" });
  if (profile.emailAddress?.toLowerCase() !== config.account.toLowerCase()) throw Error("Support mailbox identity mismatch");
  const result = await params(gws, "threads", "get", { userId: "me", id: thread.id, format: "full", fields: "id,messages(id,internalDate,labelIds,payload)" });
  if (result.id !== thread.id || !Array.isArray(result.messages)) throw Error("Incomplete support conversation");
  return { thread: supportThread(config, thread.id, result.messages, reports), messages: result.messages as MailMessage[] };
}
export async function findSupportDraft(gws: Gws, config: SupportConfig, thread: SupportThread): Promise<string | undefined> {
  if (thread.sourceAccount) return findDetachedSupportDraft(gws, config, thread);
  const { messages } = await refreshSupportThread(gws, config, thread);
  const ids = messages.filter(message => {
    const h = mailHeaders(message);
    return message.labelIds?.includes("DRAFT") && h["x-projects-support-receipt"] === "2" &&
      rfcMessageId(h["in-reply-to"] ?? "") === thread.messageId && senderOnlyDraft(message, config, thread.from);
  }).map(m => m.id);
  if (!ids.length) return undefined;
  if (ids.length > 1) throw Error("Multiple support drafts need review");
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const list = await params(gws, "drafts", "list", { userId: "me", maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    if (list.drafts !== undefined && !Array.isArray(list.drafts)) throw Error("Invalid draft inventory");
    const found = (list.drafts ?? []).filter((d: { id: string; message?: { id?: string; threadId?: string } }) => ids.includes(d.message?.id ?? "") && d.message?.threadId === thread.id);
    if (found.length === 1 && typeof found[0].id === "string" && /^[\w-]{1,200}$/.test(found[0].id)) return found[0].id as string;
    if (found.length > 1) throw Error("Multiple support drafts need review");
    pageToken = list.nextPageToken;
    if (!pageToken) return undefined;
  }
  throw Error("Incomplete draft inventory");
}
export async function createSupportDraft(gws: Gws, config: SupportConfig, thread: SupportThread, summary: SupportSummary, verificationUrl?: string) {
  const requestKey = messageKey(thread.messageId ?? "");
  if (!requestKey) throw Error("Missing original message identity");
  const messageId = `<projects-support-${thread.key}@${config.account.split("@")[1]}>`;
  const raw = acknowledgmentRaw(config, thread, acknowledgmentText(summary, verificationUrl), messageId);
  const result = JSON.parse(await gws(["gmail", "users", "drafts", "create", "--params", JSON.stringify({ userId: "me" }), "--json", JSON.stringify({ message: { ...(!thread.sourceAccount ? { threadId: thread.id } : {}), raw } })]));
  if (typeof result.id !== "string" || !/^[\w-]{1,200}$/.test(result.id) || typeof result.message?.id !== "string" ||
    !/^[a-f0-9]{10,40}$/.test(result.message.id) || !/^[a-f0-9]{10,40}$/.test(result.message.threadId ?? "") || !thread.sourceAccount && result.message.threadId !== thread.id)
    throw Error("Draft creation could not be confirmed");
  return result.id as string;
}
export async function prepareSupportDraft(thread: SupportThread, config: SupportConfig, o: {
  ack: Ack; gws: Gws; summarize: (body: string) => Promise<SupportSummary>;
  token?: string; saveToken: (token: string) => Promise<void>;
  users: () => Promise<ReadonlySet<string>>; reports?: DeliveryReport[];
  sourceGws?: Gws;
  investigate?: (summary: SupportSummary) => Promise<SupportInvestigationView>;
}): Promise<DraftOutcome> {
  if (thread.acknowledgedAt !== undefined) return { state: "skipped" };
  if (!config.draft) return { state: "off" };
  if (!thread.eligible) return { state: "skipped" };
  if (thread.forwarded && !thread.recipients) return { state: "held", triage: "needs-review" };
  if (!thread.recipients || !thread.body) return { state: "skipped" };
  if (!thread.deliveryHistoryComplete) return { state: "failed" };
  const users = await o.users();
  if (!users.has(mailHash(thread.from))) return { state: "skipped" };
  const recipients = { to: thread.recipients.to.includes(thread.from) ? [thread.from] : [], cc: [] as string[] };
  if (!recipients.to.length) return { state: "skipped" };
  const receipt = await o.ack(thread, "reserve", o.token);
  if (!receipt) return { state: "failed" };
  const requestKey = messageKey(thread.messageId ?? "");
  if (receipt.requestKey && receipt.requestKey !== requestKey) return { state: "stale", triage: receipt.triage };
  if (receipt.state === "drafted") {
    let available = false;
    if (receipt.draftId && (thread.sourceAccount || thread.draftMessages?.length)) {
      try {
        if (thread.sourceAccount && (await params(o.gws, "", "getProfile", { userId: "me" })).emailAddress?.toLowerCase() !== config.account.toLowerCase()) throw Error("Support mailbox identity mismatch");
        const current = await params(o.gws, "drafts", "get", { userId: "me", id: receipt.draftId, format: "metadata", fields: "id,message(id,threadId,labelIds,payload(headers))" });
        available = current.id === receipt.draftId && (!!thread.sourceAccount || current.message?.threadId === thread.id &&
          thread.draftMessages!.includes(current.message.id)) && current.message?.labelIds?.includes("DRAFT") && senderOnlyDraft(current.message, config, thread.from);
      } catch { /* Keep the draft held; failure is never permission to recreate. */ }
    }
    return { state: available ? "ready" : "held", at: receipt.draftedAt, triage: receipt.triage };
  }
  if (receipt.state !== "reserved") {
    // Includes legacy uncertain sends: they cannot turn into new drafts.
    if (["drafting", "draft-uncertain"].includes(receipt.state) && (receipt.token ?? o.token)) {
      const draftId = await findSupportDraft(o.gws, config, thread);
      if (draftId) {
        const recovered = await o.ack(thread, "drafted", receipt.token ?? o.token, { draftId });
        if (recovered?.state === "drafted") return { state: "ready", at: recovered.draftedAt, triage: recovered.triage };
      }
    }
    return { state: receipt.state === "sent" ? "skipped" : "uncertain" };
  }
  if (!receipt.token) return { state: "pending" };
  if (thread.draftMessages?.length) { await o.ack(thread, "release", receipt.token); return { state: "held" }; }
  if (thread.sourceAccount) {
    const target = await supportDestination(o.gws, config, thread);
    if (target.sent || target.drafts.length) { await o.ack(thread, "release", receipt.token); return { state: "held" }; }
  }
  let summary: SupportSummary;
  try { summary = groundedSupportSummary(await o.summarize(thread.body), thread.body); }
  catch { summary = pendingSupportSummary; }
  if (thread.sourceAccount && (!o.sourceGws || thread.sourceAccount !== config.personalInbox?.account)) throw Error("Personal source unavailable");
  const latest = (await refreshSupportThread(thread.sourceAccount ? o.sourceGws! : o.gws,
    thread.sourceAccount ? personalSupportConfig(config) : config, thread, o.reports)).thread;
  const fresh = latest && thread.sourceAccount ? personalThread(latest, config, thread.key) : latest;
  if (!fresh || !fresh.eligible || !fresh.deliveryHistoryComplete || fresh.messageId !== thread.messageId || fresh.from !== thread.from ||
    fresh.body !== thread.body || fresh.forwarded !== thread.forwarded || fresh.acknowledgedAt !== undefined || JSON.stringify(fresh.recipients) !== JSON.stringify(thread.recipients)) {
    await o.ack(thread, "release", receipt.token); return { state: "stale" };
  }
  if (fresh.draftMessages?.length) { await o.ack(thread, "release", receipt.token); return { state: "held" }; }
  if (!(await o.users()).has(mailHash(fresh.from))) { await o.ack(thread, "release", receipt.token); return { state: "held" }; }
  if (thread.sourceAccount) {
    const target = await supportDestination(o.gws, config, fresh);
    if (target.sent || target.drafts.length) { await o.ack(thread, "release", receipt.token); return { state: "held" }; }
  }
  let verificationUrl: string | undefined;
  if (summary.kind === "issue" && !fresh.forwarded && o.investigate) {
    try { verificationUrl = (await o.investigate(summary)).verificationUrl; } catch { /* Receipt drafting remains available. */ }
  }
  await o.saveToken(receipt.token);
  const begun = await o.ack(thread, "begin-draft", receipt.token, { triage: summary.kind });
  if (!begun?.draft) return { state: "uncertain" };
  try {
    const draftId = await createSupportDraft(o.gws, config, { ...fresh, recipients }, summary, verificationUrl);
    const recorded = await o.ack(thread, "drafted", receipt.token, { draftId, triage: summary.kind });
    return recorded?.state === "drafted" ? { state: "ready", at: recorded.draftedAt, triage: summary.kind } : { state: "uncertain" };
  } catch {
    await o.ack(thread, "draft-uncertain", receipt.token).catch(() => null);
    return { state: "uncertain", triage: summary.kind };
  }
}

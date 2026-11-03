// A personal Gmail thread cannot be addressed by ID in the shared mailbox.
// Inspect its drafts/Sent read-only and match actual RFC reply references.
import type { Gws } from "./inbox";
import { senderOnlyDraft, type SupportThread } from "./support-gmail";
import type { SupportConfig } from "../src/support-model";
import { mailHeaders, type MailMessage } from "./mail-delivery";
import { mailbox, messageKey } from "./mail-identity";
const call = async (gws: Gws, resource: string, method: string, params: object) => JSON.parse(await gws(["gmail", "users", ...(resource ? [resource] : []), method, "--params", JSON.stringify(params)]));
export async function supportDestination(gws: Gws, config: SupportConfig, thread: SupportThread) {
  const sender = mailbox(thread.from);
  if (!sender || sender !== thread.from || /["\\]/.test(sender)) throw Error("Invalid support sender");
  const profile = await call(gws, "", "getProfile", { userId: "me" });
  if (profile.emailAddress?.toLowerCase() !== config.account.toLowerCase()) throw Error("Support mailbox identity mismatch");
  const matches = (message: MailMessage) => {
    const h = mailHeaders(message);
    return [h["in-reply-to"] ?? "", ...(h.references?.match(/<[^<>\s]+>/g) ?? [])]
      .some(id => { const key = messageKey(id); return !!key && thread.messageKeys.includes(key); });
  };
  const drafts: { id: string; message: MailMessage }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const list = await call(gws, "drafts", "list", { userId: "me", maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    if (list.drafts !== undefined && (!Array.isArray(list.drafts) || list.drafts.length > 100)) throw Error("Invalid draft inventory");
    for (const ref of list.drafts ?? []) {
      if (typeof ref.id !== "string" || !/^[\w-]{1,200}$/.test(ref.id)) throw Error("Invalid draft identity");
      const draft = await call(gws, "drafts", "get", { userId: "me", id: ref.id, format: "metadata" });
      if (draft.id !== ref.id || !draft.message?.labelIds?.includes("DRAFT")) throw Error("Draft inventory changed");
      if (matches(draft.message)) drafts.push(draft);
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) throw Error("Incomplete draft inventory");
  let sent = false;
  for (let page = 0; page < 2; page++) {
    const list = await call(gws, "messages", "list", { userId: "me", q: `in:sent after:${Math.floor(Date.parse(config.personalInbox!.since) / 1000)} to:"${sender}"`, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    if (list.messages !== undefined && (!Array.isArray(list.messages) || list.messages.length > 100)) throw Error("Invalid Sent inventory");
    for (const ref of list.messages ?? []) {
      if (!/^[a-f0-9]{10,40}$/.test(ref.id ?? "")) throw Error("Invalid Sent identity");
      const message = await call(gws, "messages", "get", { userId: "me", id: ref.id, format: "metadata" });
      if (message.id !== ref.id || !message.labelIds?.includes("SENT")) throw Error("Sent inventory changed");
      if (mailbox(mailHeaders(message).from ?? "") === config.account.toLowerCase() && matches(message)) sent = true;
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) throw Error("Incomplete Sent inventory");
  return { drafts, sent };
}
export async function findDetachedSupportDraft(gws: Gws, config: SupportConfig, thread: SupportThread) {
  const { drafts } = await supportDestination(gws, config, thread);
  const exact = drafts.filter(d => {
    const h = mailHeaders(d.message);
    return senderOnlyDraft(d.message, config, thread.from) && h["x-projects-support-receipt"] === "2" &&
      h["x-projects-support-case"] === thread.key && h["in-reply-to"] === thread.messageId;
  });
  if (exact.length > 1) throw Error("Multiple support drafts need review");
  return exact[0]?.id;
}

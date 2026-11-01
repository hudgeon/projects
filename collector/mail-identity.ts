import { createHash } from "node:crypto";
// Gmail IDs belong to one mailbox. Only an actual RFC Message-ID identifies
// copies across mailboxes; absent/invalid evidence never becomes a guessed key.
export const rfcMessageId = (value: string) => {
  const id = value.trim();
  return id.length <= 500 && /^<[^<>\s]+@[^<>\s]+>$/.test(id) ? id : null;
};
export const mailHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const messageKey = (value: string) => {
  const id = rfcMessageId(value);
  return id ? mailHash(id) : undefined;
};

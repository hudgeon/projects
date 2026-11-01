import { createHash } from "node:crypto";
import { z } from "zod";
export function mailbox(value: string) {
  value = value.replace(/\r?\n[ \t]+/g, " ");
  if (/[\r\n]/.test(value)) return null;
  const text = value.trim(), bracketed = /^(?:"[^"\r\n]*"|[^<>@,:;"\r\n]*)\s*<([^<>\s]+)>$/.exec(text);
  const address = bracketed?.[1] ?? text;
  return z.email().safeParse(address).success ? address.toLowerCase() : null;
}
// Commas in quoted display names are not separators. Unsupported or ambiguous
// syntax refuses the entire recipient list instead of guessing an address.
export function mailboxes(value: string): string[] | null {
  value = value.replace(/\r?\n[ \t]+/g, " ");
  if (!value.trim()) return [];
  if (value.length > 16_000 || /[\r\n]/.test(value)) return null;
  const parts: string[] = [];
  let quote = false, angle = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" || (!quote && /[():;]/.test(c))) return null;
    if (c === '"') quote = !quote;
    else if (!quote && c === "<") { if (angle) return null; angle = true; }
    else if (!quote && c === ">") { if (!angle) return null; angle = false; }
    else if (!quote && !angle && c === ",") { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quote || angle) return null;
  parts.push(value.slice(start));
  if (parts.length > 100) return null;
  const parsed = parts.map(mailbox);
  return parsed.every((item): item is string => item !== null) ? [...new Set(parsed)] : null;
}
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

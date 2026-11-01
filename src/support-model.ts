import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const supportConfigSchema = z.object({
  account: z.email(),
  owner: z.email(),
  aliases: z.array(z.email()).max(10).default([]),
  // Activation is explicit. An installation never acknowledges old mail.
  since: z.iso.datetime(),
  acknowledgeSince: z.iso.datetime().optional(),
  acknowledge: z.boolean().default(false),
  configDir: z.string().startsWith("/").optional(),
  usersCommand: z.array(z.string().min(1).max(2000).refine(s => !/[\x00\r\n]/.test(s))).min(1).max(64).optional(),
  registeredRecipients: z.enum(["all", "sender"]).optional(),
}).strict();
export type SupportConfig = z.infer<typeof supportConfigSchema>;
export const supportReceiptSchema = z.object({
  account: z.email(),
  thread: z.string().regex(/^[a-f0-9]{10,40}$/),
  messageKeys: z.array(hash).max(200),
  humanRepliedAt: z.number().int().nonnegative().optional(),
  acknowledgment: z.enum(["off", "pending", "sent", "uncertain", "failed", "skipped"]),
  acknowledgedAt: z.number().int().nonnegative().optional(),
}).strict();
export const acknowledgmentInputSchema = z.object({
  key: hash,
  owner: z.email(),
  account: z.email(),
  action: z.enum(["reserve", "begin", "sent", "uncertain", "release"]),
  token: z.uuid().optional(),
}).strict();
export type AcknowledgmentInput = z.infer<typeof acknowledgmentInputSchema>;
export type Acknowledgment = {
  state: "reserved" | "sending" | "sent" | "uncertain";
  acknowledgedAt?: number;
  // Only the machine holding an unsent reservation gets the token.
  token?: string;
  send?: true;
};
export const supportSummarySchema = z.object({
  support: z.boolean(),
  summary: z.string().trim().min(1).max(280),
}).strict();
// The policy is product copy, not model output. Only the reported issue varies.
export function acknowledgmentText(summary: string) {
  return `Automated response from Support\n\nThanks for your email. We understand that ${summary.replace(/\s+/g, " ").replace(/[.!?\s]+$/, "")}.\n\nWe're looking into it, and a person from our team will respond shortly.\n\nSupport`;
}

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
  // The only current output mode. The legacy acknowledgment flag never sends.
  draft: z.boolean().optional(),
  draftSince: z.iso.datetime().optional(),
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
  draft: z.enum(["off", "pending", "ready", "uncertain", "failed", "stale", "held", "skipped"]).optional(),
  draftedAt: z.number().int().nonnegative().optional(),
  triage: z.enum(["issue", "other", "needs-review"]).optional(),
}).strict();
export const acknowledgmentInputSchema = z.object({
  key: hash,
  owner: z.email(),
  account: z.email(),
  action: z.enum(["reserve", "begin", "sent", "uncertain", "release", "begin-draft", "drafted", "draft-uncertain"]),
  token: z.uuid().optional(),
  requestKey: hash.optional(),
  draftId: z.string().regex(/^[\w-]{1,200}$/).optional(),
  triage: z.enum(["issue", "other", "needs-review"]).optional(),
}).strict();
export type AcknowledgmentInput = z.infer<typeof acknowledgmentInputSchema>;
export type Acknowledgment = {
  state: "reserved" | "sending" | "sent" | "uncertain" | "drafting" | "drafted" | "draft-uncertain";
  acknowledgedAt?: number;
  draftedAt?: number;
  draftId?: string;
  requestKey?: string;
  triage?: "issue" | "other" | "needs-review";
  // Only the machine holding an unsent reservation gets the token.
  token?: string;
  draft?: true;
};
export const supportSummarySchema = z.object({
  kind: z.enum(["issue", "other", "needs-review"]),
  // An exact excerpt, not an invented diagnosis or a model-written solution.
  excerpt: z.string().trim().max(280),
  area: z.enum(["access", "export", "import", "matching", "reporting", "other"]),
}).strict();
export type SupportSummary = z.infer<typeof supportSummarySchema>;
export const supportQuestions = {
  access: "which step is blocked and how the reported behavior affects your access",
  export: "which export and records are affected, and how the result differs from what you expected",
  import: "which import and records are affected, and where the result differs from what you expected",
  matching: "which records are affected and how the reported matching result differs from what you expected",
  reporting: "which report and period are affected, and what discrepancy you are seeing",
  other: "the behavior you described, its impact, and any details needed to establish what happened",
} as const;
// All instructions, commitments and investigation questions are fixed copy.
// Only an exact, attributed customer excerpt can enter the issue reflection.
export function acknowledgmentText(summary: SupportSummary) {
  const issue = summary.kind === "issue"
    ? ` From your email, we understand you are reporting: “${summary.excerpt}”\n\nWe're asking our support team to investigate ${supportQuestions[summary.area]}.`
    : " We've received it.";
  return `Automated response from Support\n\nThanks for your email.${issue}\n\nA person from our team will respond shortly.\n\nSupport`;
}

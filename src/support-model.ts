import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const supportConfigSchema = z.object({
  account: z.email(),
  owner: z.email(),
  aliases: z.array(z.email()).max(10).default([]),
  // Activation is explicit. An installation never acknowledges old mail.
  since: z.iso.datetime(),
  emailQueue: z.boolean().optional(),
  // The only output mode: unsent drafts for human review.
  draft: z.boolean().optional(),
  draftSince: z.iso.datetime().optional(),
  // Explicit operator addresses; quoted identities never authorize record reads.
  forwarders: z.array(z.email()).max(10).optional(),
  forwardSince: z.iso.datetime().optional(),
  configDir: z.string().startsWith("/").optional(),
  usersCommand: z.array(z.string().min(1).max(2000).refine(s => !/[\x00\r\n]/.test(s))).min(1).max(64).optional(),
  personalInbox: z.object({ account: z.email(), since: z.iso.datetime() }).strict().optional(),
}).strict().refine(s => !s.forwarders?.length || !!s.forwardSince, "Forwarding needs an activation cutoff.")
  .refine(s => !s.personalInbox || s.personalInbox.account.toLowerCase() === s.owner.toLowerCase() &&
    s.personalInbox.account.toLowerCase() !== s.account.toLowerCase(), "Personal intake requires its owner's inbox.");
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
  request: z.object({ key: hash, sender: z.email(), audience: z.object({ to: z.array(z.email()).length(1), cc: z.array(z.email()).length(0) }).strict() }).strict()
    .refine(r => r.audience.to[0].toLowerCase() === r.sender.toLowerCase(), "Only the sending user can receive a support reply.").optional(),
  investigation: z.lazy(() => supportInvestigationViewSchema).optional(),
}).strict();
export const acknowledgmentInputSchema = z.object({
  key: hash,
  owner: z.email(),
  account: z.email(),
  action: z.enum(["reserve", "release", "begin-draft", "drafted", "draft-uncertain"]),
  token: z.uuid().optional(),
  requestKey: hash.optional(),
  messageKeys: z.array(hash).max(200).optional(),
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
export const supportInvestigationViewSchema = z.object({
  state: z.enum(["off", "awaiting-verification", "prepared", "held", "unavailable"]),
  verificationUrl: z.url().max(500).optional(), reviewUrl: z.url().max(500).optional(),
}).strict();
export type SupportInvestigationView = z.infer<typeof supportInvestigationViewSchema>;
export const supportTaskPointerSchema = z.object({
  task: z.uuid(), requestKey: hash, audienceHash: hash, sourceHash: hash, summary: supportSummarySchema,
  state: supportInvestigationViewSchema.shape.state, invalidated: z.boolean().optional(),
}).strict();
export type SupportTaskPointer = z.infer<typeof supportTaskPointerSchema>;
export const pendingSupportSummary: SupportSummary = { kind: "needs-review", excerpt: "", area: "other" };
export function supportText(body: string) {
  return body.slice(0, 4000).split(/\n(?:On .{1,200}wrote:|From:|[-_]{5,}|>)/i)[0].trim();
}
export function groundedSupportSummary(value: unknown, body: string): SupportSummary {
  const parsed = supportSummarySchema.safeParse(value);
  if (!parsed.success) return pendingSupportSummary;
  const summary = parsed.data, normal = (text: string) => text.replace(/\s+/g, " ").trim();
  if (summary.kind !== "issue") return { ...summary, excerpt: "", area: "other" };
  const excerpt = normal(summary.excerpt);
  if (!excerpt || !normal(supportText(body)).includes(excerpt) || /[\p{Cc}<>]/u.test(excerpt) ||
    /(?:^|[.!?]\s+)(?:please|try|you should|you must|run|restart|delete|change|ignore|use|click|send)\b/i.test(excerpt)) return pendingSupportSummary;
  return { ...summary, excerpt };
}
/** Exact, explicitly tagged references only; no broad search or model authority. */
export function supportReferences(body: string) {
  const text = supportText(body), result: Array<{ operation: "invoice_context"; id?: string; reference?: string } | { operation: "receipt_line_context"; id: string }> = [];
  for (const match of text.matchAll(/\binvoice\s+id\s*[:#]\s*([a-z0-9][a-z0-9_./-]{0,199})/gi)) result.push({ operation: "invoice_context", id: match[1] });
  for (const match of text.matchAll(/\binvoice(?:\s+(?:number|ref(?:erence)?))?\s*[:#]\s*([a-z0-9][a-z0-9_./-]{0,199})/gi)) result.push({ operation: "invoice_context", reference: match[1] });
  for (const match of text.matchAll(/\breceipt\s+line(?:\s+id)?\s*[:#]?\s*(\d{1,18})(?!\d)/gi)) result.push({ operation: "receipt_line_context", id: match[1] });
  const unique = [...new Map(result.map(value => [JSON.stringify(value), value])).values()];
  return unique.length <= 2 ? unique : [];
}
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
export function acknowledgmentText(summary: SupportSummary, verificationUrl?: string) {
  const issue = summary.kind === "issue"
    ? ` From your email, we understand you are reporting: “${summary.excerpt}”\n\nWe're asking our support team to investigate ${supportQuestions[summary.area]}.`
    : " We've received it.";
  let verify = "";
  if (summary.kind === "issue" && verificationUrl) {
    try {
      const url = new URL(verificationUrl);
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && /^\/support-investigation\/[a-f0-9-]{36}$/.test(url.pathname))
        verify = `\n\nTo allow a limited check of the records you mentioned, sign in and review this request: ${url.href}`;
    } catch { /* Keep the email-only draft if verification is unavailable. */ }
  }
  return `Automated response from Support\n\nThanks for your email.${issue}${verify}\n\nA person from our team will respond shortly.\n\nSupport`;
}

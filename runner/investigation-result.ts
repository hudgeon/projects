import { z } from "zod";
import { plainText } from "../src/run-text";

const finding = z.object({
  claim: z.string().trim().min(1).max(360),
  sourceIds: z.array(z.number().int().positive()).min(1).max(4),
}).strict();

export const investigationResultSchema = z.object({
  title: z.string().trim().min(1).max(80),
  answer: z.string().trim().min(1).max(1000),
  findings: z.array(finding).max(8),
  lastVerified: finding.nullable(),
  firstUnverified: z.string().trim().min(1).max(400),
}).strict();

export type EvidenceSource = { label: string; url: string | null };

export function investigationReport(
  result: z.infer<typeof investigationResultSchema>,
  sources: EvidenceSource[],
  collectedAt: string,
) {
  const cited = ({ claim, sourceIds }: z.infer<typeof finding>) => {
    const refs = [...new Set(sourceIds)].map((id) => {
      const source = sources[id - 1];
      if (!source) throw Error("The investigation cited an unavailable source.");
      return source.url ? `[${source.label}](${source.url})` : source.label;
    });
    return `${plainText(claim)} (${refs.join(" · ")})`;
  };
  return [
    plainText(result.answer),
    result.findings.length ? result.findings.map((item) => `- ${cited(item)}`).join("\n") : "",
    `**Last verified:** ${result.lastVerified ? cited(result.lastVerified) : "No stage established by the supplied sources."}`,
    `**First unverified:** ${plainText(result.firstUnverified)}`,
    `**Sources collected:** ${collectedAt}. Coverage is limited to the supplied records, repository excerpts and attachments. Individual records and attachments may have earlier cutoffs.`,
  ].filter(Boolean).join("\n\n");
}

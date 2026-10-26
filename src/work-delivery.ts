import { z } from "zod";
export const latestMergeSchema = z
  .object({
    title: z.string().max(500),
    url: z.url().refine((x) => new URL(x).hostname === "github.com"),
    mergedAt: z.number().int().nonnegative(),
    workIssues: z.array(z.number().int().positive()).max(100).optional(),
  })
  .strict()
  .nullable();

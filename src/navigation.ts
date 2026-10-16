import { z } from "zod";

const key = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
const searchSchema = z.object({
  view: z
    .enum(["today", "inbox", "health", "project", "archive"])
    .catch("today"),
  work: z.coerce.number().int().positive().optional().catch(undefined),
  email: z
    .string()
    .regex(/^[a-f0-9]{10,40}$/)
    .optional()
    .catch(undefined),
  project: key.optional().catch(undefined),
  run: z.uuid().optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
});
// Bookmarks to the former work agenda and conversations tabs open Today.
export const parseNavigation = (value: Record<string, unknown>) =>
  searchSchema.parse({
    ...value,
    view: ["work", "conversations"].includes(String(value.view))
      ? "today"
      : value.view,
  });
export type Navigation = z.infer<typeof searchSchema>;
export const projectSearch = (project: string, run?: string): Navigation => ({
  view: "project",
  project,
  run,
});
export const conversationSearch = (
  run?: string,
  project?: string,
  archived?: boolean,
): Navigation => ({ view: "today", run, project, archived });

export const workSearch = (
  work: number,
  email?: string,
  run?: string,
): Navigation => ({ view: "today", work, email, run });

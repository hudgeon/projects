import { z } from "zod";
import { htmlSource } from "./document-model";

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
  // A Slack or Teams item open in Today, by its opaque key.
  chat: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .catch(undefined),
  // The Inbox shows email, one chat source, or everything.
  source: z.enum(["email", "slack", "teams"]).optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
  // An HTML mockup or slide deck open over the view, by its pinned GitHub link.
  doc: z
    .string()
    .max(1000)
    .refine((url) => htmlSource(url) !== null)
    .optional()
    .catch(undefined),
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

export const chatSearch = (chat?: string, project?: string): Navigation => ({
  view: "today",
  chat,
  project,
});
export const workSearch = (
  work: number,
  email?: string,
  run?: string,
): Navigation => ({ view: "today", work, email, run });
// Opens or closes a document over whatever view is showing.
export const withDocument = (
  prev: Partial<Navigation>,
  doc?: string,
): Navigation => ({ ...prev, view: prev.view ?? "today", doc });

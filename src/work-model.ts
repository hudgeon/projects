import { z } from "zod";
import { reviewedVersionsSchema } from "./upkeep-model";
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const label = z.string().min(1).max(200);
const issueNumber = z.number().int().positive();
const githubUrl = z.url().refine((value) => {
  const u = new URL(value);
  return u.protocol === "https:" && u.hostname === "github.com";
});
// Work is current for a few weeks at a time; older linked items are quiet.
export const RECENT_WORK_DAYS = 21;
// A work item is a GitHub issue labelled `work`. Its issue type is the kind of
// work, its milestone the initiative, `customer:` labels who is driving it and
// `repo:` labels the repositories it touches.
const statuses = [
  "needs you",
  "being worked on",
  "waiting on someone",
  "planned",
  "deferred",
  "delivered",
  "cancelled",
  "needs verification",
] as const;
export const positionSchema = z
  .object({
    // "Needs" and a name, as an owner may write it, means it needs you.
    status: z.preprocess(
      (value) =>
        typeof value === "string" &&
        /^needs\s+\S+$/i.test(value) &&
        !(statuses as readonly string[]).includes(value)
          ? "needs you"
          : value,
      z.enum(statuses),
    ),
    reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    why: z.string().max(1000),
    position: z.string().max(1000),
    next: z.string().max(1000),
    priority: z.enum(["now", "next", "later"]).nullable(),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .strict();
export type Position = z.infer<typeof positionSchema>;
// Only the documented Current position block is an assessment. Arbitrary issue
// prose, timestamps and session activity cannot manufacture a business priority.
export function currentPosition(body: string): Position | null {
  const block = body.match(
    /^## Current position\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m,
  )?.[1];
  if (!block) return null;
  const field = (name: string) =>
    block.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1].trim() ?? "";
  const status = field("Status")
    .replace(/\.\s*Reviewed:.*$/i, "")
    .replace(/\.$/, "");
  const reviewed = block.match(/Reviewed:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
  const result = positionSchema.safeParse({
    status,
    reviewed,
    why: field("Outcome / why now").slice(0, 1000),
    position: field("Position").slice(0, 1000),
    next: field("Next").slice(0, 1000),
    priority: field("Priority") || null,
    due: field("Due") || null,
  });
  return result.success ? result.data : null;
}
export const emailLinkSchema = z
  .object({
    threadId: z.string().regex(/^[a-f0-9]{10,40}$/),
    url: z
      .url()
      .max(1000)
      .refine((value) => {
        const u = new URL(value);
        return u.protocol === "https:" && u.hostname === "mail.google.com";
      })
      .optional(),
    subject: z.string().max(300).optional(),
    context: z.string().max(1000).optional(),
    reviewedMessageId: z
      .string()
      .regex(/^[a-f0-9]{10,40}$/)
      .nullable(),
  })
  .strict();
// Explicit Gmail links under Email threads, with the exact last message read.
// Matching a subject or a customer name is never enough to join two threads.
export function emailLinks(body: string): z.infer<typeof emailLinkSchema>[] {
  const section =
    body.match(/^## Email threads\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ??
    "";
  const links = new Map<string, z.infer<typeof emailLinkSchema>>();
  for (const line of section.split("\n")) {
    const url = line.match(/https:\/\/mail\.google\.com\/[^\s)]+/)?.[0];
    if (!url) continue;
    const id = new URL(url).hash.match(
      /^#(?:all|inbox)\/([a-f0-9]{10,40})$/,
    )?.[1];
    if (id)
      links.set(id, {
        threadId: id,
        url,
        subject: line
          .match(/\[([^\]]+)\]\(https:\/\/mail\.google\.com\//)?.[1]
          .slice(0, 300),
        context: line.match(/ · context: (.+)$/i)?.[1].slice(0, 1000),
        reviewedMessageId:
          line.match(/reviewed:\s*([a-f0-9]{10,40})(?![a-f0-9])/i)?.[1] ?? null,
      });
  }
  return [...links.values()].slice(0, 50);
}
// These human-editable sections live on the same issue as Current position.
// Unknown owners/dates stay null; activity never manufactures a commitment.
const day = z.iso.date();
export const workDetailsSchema = z
  .object({
    people: z
      .array(
        z
          .object({
            name: label,
            role: z.string().max(300),
            next: z.string().max(600),
          })
          .strict(),
      )
      .max(30),
    commitments: z
      .array(
        z
          .object({
            date: day.nullable(),
            what: z.string().min(1).max(600),
            owner: label.nullable(),
            state: z.enum(["open", "done", "cancelled"]),
          })
          .strict(),
      )
      .max(50),
    combinedFrom: z.array(issueNumber).max(50),
    splitFrom: z.array(issueNumber).max(50),
    continuesAs: z.array(issueNumber).max(50),
  })
  .strict();
export type WorkDetails = z.infer<typeof workDetailsSchema>;
export function workDetails(body: string): WorkDetails | null {
  const section = (title: string) => {
    const matches = [
      ...body.matchAll(
        new RegExp(
          `^##[ \\t]+${title.replace(/ /g, "[ \\t]+")}[ \\t]*(?:\\r?\\n|$)([\\s\\S]*?)(?=^##[ \\t]+|$(?![\\s\\S]))`,
          "gmi",
        ),
      ),
    ];
    if (matches.length > 1) throw Error("Duplicate work section");
    return matches[0]?.[1].trim() ?? "";
  };
  const table = (title: string, header: string[]) => {
    const lines = section(title)
      .split("\n")
      .filter((line) => line.trim());
    if (!lines.length) return [];
    const cells = (line: string) => {
      if (!line.trim().startsWith("|") || !line.trim().endsWith("|"))
        throw Error("Invalid table");
      return line
        .trim()
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));
    };
    if (
      JSON.stringify(cells(lines[0]).map((s) => s.toLowerCase())) !==
        JSON.stringify(header) ||
      !lines[1] ||
      cells(lines[1]).length !== header.length ||
      !cells(lines[1]).every((s) => /^:?-{3,}:?$/.test(s))
    )
      throw Error("Invalid table header");
    return lines.slice(2).map((line) => {
      const row = cells(line);
      if (row.length !== header.length) throw Error("Invalid table row");
      return row;
    });
  };
  try {
    const history = section("Work history");
    const refs = (name: string) => {
      const lines = history
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
      if (lines.length > 1) throw Error("Duplicate history field");
      const value = lines[0]?.slice(name.length + 1).trim();
      if (!value) return [];
      if (!/^#[1-9]\d*(?:\s*,\s*#[1-9]\d*)*$/.test(value))
        throw Error("Invalid history reference");
      return [...new Set(value.match(/\d+/g)!.map(Number))];
    };
    return workDetailsSchema.parse({
      people: table("People", ["person", "role", "next action"]).map(
        ([name, role, next]) => ({ name, role, next }),
      ),
      commitments: table("Commitments", [
        "date",
        "commitment",
        "owner",
        "state",
      ]).map(([date, what, owner, state]) => ({
        date: date === "unknown" || !date ? null : date,
        what,
        owner: owner === "unknown" || !owner ? null : owner,
        state,
      })),
      combinedFrom: refs("Combined from"),
      splitFrom: refs("Split from"),
      continuesAs: refs("Continues as"),
    });
  } catch {
    // A malformed section must not be presented as an empty, complete record.
    return null;
  }
}
export function historyIssues(issue: Issue) {
  return [
    ...new Set([
      ...(issue.details?.combinedFrom ?? []),
      ...(issue.details?.splitFrom ?? []),
    ]),
  ].filter((n) => n !== issue.number);
}
export function nextCommitment(issue: Issue) {
  return issue.details?.commitments
    .filter((c) => c.state === "open" && c.date)
    .sort((a, b) => a.date!.localeCompare(b.date!))[0];
}
export const issueSchema = z
  .object({
    number: issueNumber,
    title: label,
    body: z.string().max(800),
    url: githubUrl,
    open: z.boolean(),
    kind: label.nullable(),
    initiative: z
      .object({ title: label, capability: z.string().max(400) })
      .strict()
      .nullable(),
    customers: z.array(label).max(20),
    repos: z.array(repo).max(20),
    // The standing upkeep issue, labelled `upkeep`: the record of every
    // upkeep change with its measures (docs/upkeep.md).
    upkeep: z.boolean().optional(),
    // The harness versions its research last reviewed, from the `## Upkeep`
    // section of its body (src/upkeep-model.ts); only the standing issue has it.
    reviewed: reviewedVersionsSchema.optional(),
    updatedAt: z.number().int().nonnegative(),
    position: positionSchema.nullable().optional(),
    details: workDetailsSchema.nullable().optional(),
    emailLinks: z.array(emailLinkSchema).max(50).optional(),
    area: z.enum(["business", "personal", "unassigned"]).optional(),
    latestUpdate: z
      .object({
        body: z.string().max(1200),
        url: githubUrl,
        at: z.number().int().nonnegative(),
      })
      .strict()
      .nullable()
      .optional(),
    updatesState: z.enum(["ok", "unavailable"]).optional(),
  })
  .strict();
export const associationSchema = z
  .object({
    app: z.enum(["Codex", "Claude"]),
    sessionId: key,
    cwd: z.string().max(1000),
    repo: repo.nullable(),
    branch: z.string().max(200).nullable(),
    issue: issueNumber.nullable(),
    selection: z.enum(["unassigned", "confirmed", "untracked"]),
    // Who made the selection. Absent on older records, which the owner made.
    by: z.enum(["user", "assistant"]).optional(),
    state: z.enum(["open", "running", "idle", "ended"]),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if ((a.selection === "confirmed") !== (a.issue !== null))
      ctx.addIssue({ code: "custom", message: "Invalid association" });
    if (a.selection === "unassigned" && a.by)
      ctx.addIssue({ code: "custom", message: "Unassigned has no author" });
  });
export const workSnapshotSchema = z
  .object({
    // The repository whose `work` issues these are. Absent from collectors
    // older than the setting.
    repo: repo.optional(),
    // Open and recently closed work issues; null when this machine could not read
    // GitHub, which is never an empty list.
    issues: z.array(issueSchema).max(600).nullable(),
    associations: z.array(associationSchema).max(2000),
    associationsState: z.enum(["ok", "unavailable"]),
  })
  .strict();
export type Issue = z.infer<typeof issueSchema>;
export type WorkAssociation = z.infer<typeof associationSchema>;
export type WorkSnapshot = z.infer<typeof workSnapshotSchema>;
// Who decided a session's work item: the owner's explicit reply, or the
// assistant's own classification (recorded from its final message, overridable
// by the owner).
export function decidedBy(a: Pick<WorkAssociation, "selection" | "by">) {
  return a.selection === "unassigned" ? null : (a.by ?? "user");
}
// GitHub is not host-local: the newest scan that could read the issues wins.
export type CurrentWork = {
  issues: Issue[];
  observedAt: number;
  repo?: string;
};
export function currentWork(
  snapshots: { collectedAt: number; work?: WorkSnapshot }[],
): CurrentWork | undefined {
  return snapshots
    .flatMap((s) =>
      s.work?.issues
        ? [
            {
              issues: s.work.issues,
              observedAt: s.collectedAt,
              ...(s.work.repo ? { repo: s.work.repo } : {}),
            },
          ]
        : [],
    )
    .sort((a, b) => b.observedAt - a.observedAt)[0];
}
// The work repository named by an issue's own GitHub link.
export function issueRepo(issues: Pick<Issue, "url">[]) {
  const [owner, name] = issues[0]
    ? new URL(issues[0].url).pathname.split("/").slice(1, 3)
    : [];
  return owner && name ? `${owner}/${name}` : undefined;
}
// Mark done: queued in the Worker, then applied by the machine on duty, which closes the
// issue on GitHub and reports back.
export const closeSchema = z
  .object({
    issue: issueNumber,
    requestedAt: z.number().int().positive(),
    state: z.enum(["queued", "done", "failed"]),
    message: z.string().max(200).nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Close = z.infer<typeof closeSchema>;
export const closeReportSchema = closeSchema.omit({ updatedAt: true });
export type CloseReport = z.infer<typeof closeReportSchema>;
export const pendingCloseSchema = closeSchema.pick({
  issue: true,
  requestedAt: true,
});
export type PendingClose = z.infer<typeof pendingCloseSchema>;
// Closed on GitHub, or closed from the overview after that scan was taken; an
// issue reopened later shows as open again.
export function isDone(issue: Issue, observedAt: number, close?: Close) {
  return (
    !issue.open || (close?.state === "done" && observedAt < close.updatedAt)
  );
}

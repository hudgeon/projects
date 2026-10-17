import { z } from "zod";

// HTML mockups and slide decks open inside Projects from one committed edition
// on GitHub: a link pinned to a commit names the repository, commit and file.
// A connected machine reads that edition with its own GitHub login when the
// owner first opens it; the Worker keeps the copy and serves it isolated.
export const MAX_DOCUMENT_BYTES = 5_000_000;
export type HtmlSource = { repo: string; commit: string; path: string };
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
export function htmlSource(raw: string): HtmlSource | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const [lead, owner, name, type, commit, ...rest] = url.pathname.split("/");
  if (lead !== "" || type !== "blob" || !/^[0-9a-f]{40}$/i.test(commit ?? ""))
    return null;
  let segments: string[];
  try {
    segments = rest.map(decodeURIComponent);
  } catch {
    return null;
  }
  const repo = `${owner}/${name}`;
  const path = segments.join("/");
  if (
    !repoPattern.test(repo) ||
    !segments.length ||
    segments.some((s) => !s || s === "." || s === ".." || /[\\\u0000-\u001f\u007f]/.test(s)) ||
    path.length > 400 ||
    !/\.html?$/i.test(path)
  )
    return null;
  return { repo, commit: commit.toLowerCase(), path };
}
export const sourceUrl = (source: HtmlSource) =>
  `https://github.com/${source.repo}/blob/${source.commit}/${source.path.split("/").map(encodeURIComponent).join("/")}`;
// One copy per edition: a commit's file never changes.
export const sourceKey = (source: HtmlSource) =>
  `${source.repo.toLowerCase()}@${source.commit}:${source.path}`;

// What a machine reports when it cannot provide the edition, and what the
// Worker adds when no machine did.
export const documentFailureSchema = z.enum([
  "not_found",
  "too_large",
  "not_html",
  "unavailable",
]);
export type DocumentFailure = z.infer<typeof documentFailureSchema> | "no_machine";
export type DocumentStatus = {
  state: "pending" | "ready" | "failed";
  reason: DocumentFailure | null;
  bytes: number | null;
  fetchedAt: number | null;
  // The isolated copy, for the viewer's frame.
  content: string | null;
};
export const documentRequestSchema = z
  .object({ url: z.string().max(1000), retry: z.boolean().optional() })
  .strict();
const documentId = z.string().regex(/^[a-f0-9]{64}$/);
export const documentJobSchema = z
  .object({
    id: documentId,
    // This lease's own token: a delivery for an earlier lease is refused.
    lease: z.uuid(),
    repo: z.string().regex(repoPattern),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    path: z.string().min(1).max(400),
  })
  .strict();
export type DocumentJob = z.infer<typeof documentJobSchema>;
// A runner asks for a waiting request with only its runnerId, and delivers
// one with its lease.
export const runnerLeaseSchema = z.object({ runnerId: z.uuid() }).strict();
export const runnerDocumentSchema = z
  .object({
    runnerId: z.uuid(),
    id: documentId,
    lease: z.uuid(),
    content: z
      .string()
      .max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
    failure: documentFailureSchema.optional(),
  })
  .strict()
  .refine((input) => (input.content === undefined) !== (input.failure === undefined));
// Rendered HTML is untrusted. Its own opaque origin keeps it away from the
// owner's session, Projects' pages and APIs, and top-level navigation; it may
// run its own inline scripts and styles, use data: images and Google Fonts,
// and open links in a new tab. It cannot fetch, submit forms, frame or load
// other scripts.
export const DOCUMENT_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox";
export const DOCUMENT_CSP = [
  `sandbox ${DOCUMENT_SANDBOX}`,
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

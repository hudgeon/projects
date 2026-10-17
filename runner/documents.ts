import { execFile } from "node:child_process";
import {
  MAX_DOCUMENT_BYTES,
  htmlSource,
  sourceUrl,
  type DocumentJob,
} from "../src/document-model";
import { nativeEnv } from "./native";

type Read = (args: string[], signal?: AbortSignal) => Promise<Buffer>;
const gh: Read = (args, signal) =>
  new Promise((resolve, reject) =>
    execFile(
      "gh",
      args,
      {
        signal,
        encoding: "buffer",
        env: { ...nativeEnv(), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
        timeout: 30_000,
        maxBuffer: MAX_DOCUMENT_BYTES + 1,
      },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(error, { stderr: String(stderr) }))
          : resolve(stdout),
    ),
  );
// One committed HTML edition the owner opened, read with this machine's own
// GitHub login. Nothing is kept here; failures are fixed categories.
export async function readDocument(
  job: DocumentJob,
  read: Read = gh,
  signal?: AbortSignal,
) {
  // Only a file the owner could have linked: no path outside its repository.
  const source = htmlSource(sourceUrl(job));
  if (source?.path !== job.path || source.repo !== job.repo)
    return { failure: "not_found" as const };
  const path = job.path.split("/").map(encodeURIComponent).join("/");
  try {
    const bytes = await read(
      [
        "api",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/${job.repo}/contents/${path}?ref=${job.commit}`,
      ],
      signal,
    );
    if (bytes.length > MAX_DOCUMENT_BYTES) return { failure: "too_large" as const };
    // A binary file is not a page, whatever its name says.
    if (bytes.includes(0)) return { failure: "not_html" as const };
    return { content: bytes.toString("base64") };
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: string };
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return { failure: "too_large" as const };
    if (/HTTP 40[34]\b/.test(stderr ?? "")) return { failure: "not_found" as const };
    return { failure: "unavailable" as const };
  }
}

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { nativeEnv } from "./native";

// Which project files may become evidence, and how they and the work issue
// are read: never through links, never with recognizable credentials.
export const FILE_BYTES = 128_000;
export const RECENT_COMMENTS = 5;
const exec = promisify(execFile);
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// YAML also holds secrets unquoted (`token: abc…`, `- DB_PASSWORD=abc…`): one
// word of 12 or more characters on the key's line or the next. Code's
// unquoted values are expressions, so only YAML is read this way.
// Interpolations and environment variable names, such as `secret:
// STRIPE_KEY`, are references. A Kubernetes Secret's data may sit under any
// key.
const yamlSecret = (text: string) =>
  /^kind:[ \t]*["']?Secret["']?[ \t]*(?:#.*)?$/m.test(text) ||
  [
    ...text.matchAll(
      /^[ \t]*(?:-[ \t]+)?["']?[\w.-]*(?:passw(?:or)?d|secret|token|(?:api|access|secret|private)[_-]?key)["']?[ \t]*(?:=|:(?:[ \t]*[|>][-+\d]*)?)[ \t]*(?:\r?\n[ \t]+)?(?:&\S+[ \t]+)?([^\s"'#]\S{11,})[ \t]*(?:#.*)?$/gim,
    ),
  ].some(
    ([, value]) =>
      !/^(?:\$\{|\$\w+$|process\.env\.|[A-Z][A-Z\d]*(?:_[A-Z\d]+)+$)/.test(
        value,
      ),
  );
// Best-effort exclusion of recognizable credentials supplements path/ignore
// rules. Never redact a value and present the remaining file as complete.
export const credentialLike = (text: string, name = "") =>
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|dp\.st\.[A-Za-z0-9_-]{20,})\b/.test(
    text,
  ) ||
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(text) ||
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(
    text,
  ) ||
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^/\s:@]+:[^/\s@]+@/i.test(
    text,
  ) ||
  [
    ...text.matchAll(
      /["']?(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi,
    ),
  ].some(([, value]) => !/^(?:\$\{|process\.env\.)/.test(value)) ||
  (/\.ya?ml$/i.test(name) && yamlSecret(text));
export type Source = {
  path: string;
  hash: string | null;
  status: string;
  chars?: number;
};
export type Issue = {
  title: string;
  body: string;
  updatedAt: string;
  comments?: { body: string; createdAt: string }[];
};

export async function command(
  cwd: string,
  bin: string,
  args: string[],
  signal: AbortSignal,
) {
  const { stdout } = await exec(bin, args, {
    cwd,
    env: {
      ...nativeEnv(),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    maxBuffer: 4_000_000,
  });
  return stdout;
}

// Never follow repository links into another project or a credential folder.
// Check every component and the opened inode again before using its content.
export async function readSource(
  root: string,
  name: string,
): Promise<{ source: Source; text?: string }> {
  const source: Source = { path: name, hash: null, status: "unavailable" };
  if (
    !name ||
    path.isAbsolute(name) ||
    name.split(/[\\/]/).some((p) => !p || p === "." || p === "..")
  )
    return { source: { ...source, status: "outside_project" } };
  const target = path.join(root, name);
  let handle;
  try {
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        return { source: { ...source, status: "linked_source" } };
    }
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      return { source: { ...source, status: "not_regular" } };
    if (before.size > FILE_BYTES)
      return { source: { ...source, status: "too_large" } };
    const bytes = Buffer.alloc(FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat(),
      named = await lstat(target);
    if (
      bytesRead > FILE_BYTES ||
      before.size !== bytesRead ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      (await realpath(target)) !== target
    )
      return { source: { ...source, status: "source_changed" } };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
    if (text.includes("\0"))
      return { source: { ...source, status: "not_text" } };
    if (credentialLike(text, name))
      return { source: { ...source, status: "credential_like_content" } };
    return {
      source: {
        ...source,
        hash: hash(text),
        chars: text.length,
        status: "read",
      },
      text,
    };
  } catch (error) {
    return {
      source: {
        ...source,
        status:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unavailable",
      },
    };
  } finally {
    await handle?.close();
  }
}

// People, legal, HR and personnel records are never project evidence: their
// folders, documents and YAML data stay out. Code named for such features
// remains.
const personal = (name: string) =>
  /(?:^|\/)(?:people|personnel|hr|human[-_]resources|legal|payroll)\//i.test(
    name,
  ) ||
  (/\.(?:mdx?|ya?ml)$/i.test(name) &&
    /(?:^|[/._-])(?:people|persons?|personnel|staff|employees?|employment|hr|human[-_]resources|payroll|legal|performance[-_]reviews?)(?=[/._-]|$)/i.test(
      name,
    ));
export const eligible = (name: string) =>
  !name
    .split("/")
    .some(
      (p) =>
        p.startsWith(".") ||
        ["node_modules", "vendor", "dist", "build", "coverage"].includes(p),
    ) &&
  !/(?:^|\/)(?:secrets?|credentials?|tokens?)(?:[./_-]|$)/i.test(name) &&
  !personal(name) &&
  // Generated lockfiles carry no project knowledge.
  !/[.-]lock\.ya?ml$/i.test(name) &&
  (/\.(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|py|sql|go|rs|rb|java|kt|css|ya?ml)$/i.test(
    name,
  ) ||
    name === "package.json");
export const instructionFile = (name: string) =>
  /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(name);

// The issue with only its newest comments: a long-running work issue can
// hold hundreds.
export async function fetchIssue(
  root: string,
  repo: string,
  number: number,
  signal: AbortSignal,
): Promise<Issue> {
  const [owner, name] = repo.split("/");
  const found = z
    .object({
      data: z.object({
        repository: z.object({
          issue: z.object({
            title: z.string(),
            body: z.string(),
            updatedAt: z.string(),
            comments: z.object({
              nodes: z.array(
                z.object({ body: z.string(), createdAt: z.string() }),
              ),
            }),
          }),
        }),
      }),
    })
    .parse(
      JSON.parse(
        await command(
          root,
          "gh",
          [
            "api",
            "graphql",
            "-f",
            `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){title body updatedAt comments(last:${RECENT_COMMENTS}){nodes{body createdAt}}}}}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${number}`,
          ],
          signal,
        ),
      ),
    ).data.repository.issue;
  return { ...found, comments: found.comments.nodes };
}

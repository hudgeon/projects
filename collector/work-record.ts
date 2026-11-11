import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import MarkdownIt from "markdown-it";
import {
  currentPosition,
  currentPositionHeadings,
  currentPositionSection,
  WORK_POSITION_CHARS,
} from "../src/work-model";
import { evidenceChecked } from "../src/work-assessment";
import { command } from "./command";

export function recordHash(body: string) {
  const parts = [
    "Current position",
    "People",
    "Commitments",
    "Email threads",
  ].map(
    (name) =>
      body
        .match(
          new RegExp(
            `^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
            "m",
          ),
        )?.[1]
        .trim() ?? "",
  );
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export type WorkRecordRead = { number: number; body: string; url: string };
export type ReadWorkRecord = (
  repo: string,
  number: number,
) => Promise<WorkRecordRead>;
export const readWorkRecord = async (
  repo: string,
  number: number,
  timeout = 3000,
): Promise<WorkRecordRead> => {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw Error("Invalid work identity");
  const value = JSON.parse(
    await command(
      "gh",
      [
        "issue",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "number,body,url",
      ],
      undefined,
      {},
      timeout,
    ),
  );
  if (
    value.number !== number ||
    typeof value.body !== "string" ||
    value.body.length > 200_000 ||
    value.url !== `https://github.com/${repo}/issues/${number}`
  )
    throw Error("Invalid work readback");
  return value;
};
export function workPositionProblem(body: string) {
  const headings = currentPositionHeadings(body);
  if (headings.length !== 1 || body.slice(0, headings[0].index).trim())
    return "Keep exactly one Current position section at the top.";
  const block = currentPositionSection(body)?.trim();
  if (!block || block.length > WORK_POSITION_CHARS)
    return `Current position must contain at most ${WORK_POSITION_CHARS} characters below its heading.`;
  return null;
}

export function replaceWorkPosition(body: string, position: string) {
  const markdown = new MarkdownIt();
  const headings = currentPositionHeadings(body);
  if (
    headings.length > 1 ||
    (headings.length && body.slice(0, headings[0].index).trim())
  )
    throw Error(
      "Resolve misplaced or duplicate Current position headings before replacing it.",
    );
  const block = position.trim();
  if (
    markdown
      .parse(block, {})
      .some((token) =>
        ["heading_open", "fence", "code_block"].includes(token.type),
      )
  )
    throw Error("Supply only the text below the Current position heading.");
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const replacement = `## Current position${newline}${block.replace(/\r?\n/g, newline)}`;
  let end = body.length;
  if (headings.length) {
    const sections = markdown
      .parse(body, {})
      .filter(
        (token) =>
          token.level === 0 &&
          token.type === "heading_open" &&
          ["h1", "h2"].includes(token.tag),
      );
    const first = sections[0];
    if (!first || first.tag !== "h2" || !first.map)
      throw Error(
        "The Current position heading is not a standalone Markdown section.",
      );
    const nextLine = sections[1]?.map?.[0];
    if (nextLine !== undefined) {
      const lineStarts = [
        0,
        ...Array.from(body.matchAll(/\n/g), (m) => m.index + 1),
      ];
      end = lineStarts[nextLine];
      if (!body.startsWith("## ", end))
        throw Error(
          "Normalize the next section to a level-two Markdown heading before replacing Current position.",
        );
    }
    const headingEnd = headings[0].index + headings[0][0].length;
    const nextLiteral = body.slice(headingEnd).search(/^## /m);
    if (nextLiteral !== -1 && headingEnd + nextLiteral !== end)
      throw Error(
        "Resolve ambiguous Markdown headings before replacing Current position.",
      );
  }
  const suffix = headings.length
    ? (body.slice(0, end).match(/\s*$/)?.[0] ?? "") + body.slice(end)
    : body.length
      ? newline + newline + body
      : newline;
  const result =
    (headings.length ? body.slice(0, headings[0].index) : "") +
    replacement +
    suffix;
  const problem = workPositionProblem(result);
  if (problem) throw Error(problem);
  if (!currentPosition(result) || evidenceChecked(result) === null)
    throw Error(
      "Supply a valid Current position with its actual evidence cutoff.",
    );
  return result;
}

export async function writeWorkPosition(
  repo: string,
  number: number,
  expected: string,
  position: string,
  read: ReadWorkRecord = readWorkRecord,
  write = patchWorkBody,
) {
  const before = await read(repo, number);
  if (createHash("sha256").update(before.body).digest("hex") !== expected)
    throw Error(
      "The issue changed. Re-read it before preparing a replacement.",
    );
  const body = replaceWorkPosition(before.body, position);
  if (body !== before.body) await write(repo, number, body);
  if ((await read(repo, number)).body !== body)
    throw Error(
      "Readback differs from the replacement. Inspect the issue before retrying.",
    );
  return before.url;
}

async function patchWorkBody(repo: string, number: number, body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "work-position-"));
  try {
    const payload = path.join(dir, "body.json");
    await writeFile(payload, JSON.stringify({ body }), { mode: 0o600 });
    try {
      await command("gh", [
        "api",
        `repos/${repo}/issues/${number}`,
        "--method",
        "PATCH",
        "--input",
        payload,
        "--silent",
      ]);
    } catch {
      throw Error(
        "GitHub did not confirm the write. Inspect the issue before retrying.",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function verifiedRecord(
  body: string,
  startedAt: number,
  baseline?: string,
  now = Date.now(),
) {
  const checked = evidenceChecked(body);
  return (
    !workPositionProblem(body) &&
    !!currentPosition(body) &&
    checked !== null &&
    checked >= startedAt - 60_000 &&
    checked <= now + 60_000 &&
    (!baseline || recordHash(body) !== baseline)
  );
}

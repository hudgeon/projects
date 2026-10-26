import { createHash } from "node:crypto";
import { currentPosition } from "../src/work-model";
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
export function verifiedRecord(
  body: string,
  startedAt: number,
  baseline?: string,
  now = Date.now(),
) {
  const checked = evidenceChecked(body);
  return (
    !!currentPosition(body) &&
    checked !== null &&
    checked >= startedAt - 60_000 &&
    checked <= now + 60_000 &&
    (!baseline || recordHash(body) !== baseline)
  );
}

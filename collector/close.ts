import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { subprocessEnv } from "./collect";
import { type Gh } from "./work";
import {
  pendingCloseSchema,
  type CloseReport,
  type Issue,
  type PendingClose,
} from "../src/work-model";
// Work writes use this machine's signed-in GitHub CLI, as the
// morning job does; the collector's read-only App token is removed.
export const userGh: Gh = async (args) => {
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    GH_PROMPT_DISABLED: "1",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const { stdout } = await promisify(execFile)("gh", args, {
    env,
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  return stdout;
};
// Mark done closes the issue, and only an issue this scan read as a work item.
export async function applyClose(
  close: PendingClose,
  issues: Issue[],
  repo: string,
  run: Gh,
): Promise<CloseReport> {
  const issue = issues.find((i) => i.number === close.issue);
  if (!issue)
    return { ...close, state: "failed", message: "Not a current work issue." };
  if (issue.open)
    await run([
      "issue",
      "close",
      String(issue.number),
      "--repo",
      repo,
      "--reason",
      "completed",
    ]);
  return { ...close, state: "done", message: null };
}
// The machine on duty's scheduled step: fetch queued requests, apply each,
// report back.
// Without a readable issue list or GitHub, a request stays queued.
export async function applyCloses(
  endpoint: string,
  headers: Record<string, string>,
  issues: Issue[] | null,
  repo: string,
  run: Gh = userGh,
) {
  const url = new URL("/api/closes", endpoint);
  const call = async (init?: RequestInit) => {
    const r = await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw Error(`Close requests failed (HTTP ${r.status})`);
    return r.json();
  };
  const { closes } = z
    .object({ closes: z.array(pendingCloseSchema).max(500) })
    .parse(await call());
  for (const close of closes.slice(0, 5)) {
    let report: CloseReport;
    try {
      if (!issues) throw Error("Work issues unavailable");
      report = await applyClose(close, issues, repo, run);
    } catch {
      report = {
        ...close,
        state: "queued",
        message: "GitHub was unavailable from this machine; retrying.",
      };
    }
    await call({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    console.log(
      JSON.stringify({
        event: "close_reported",
        issue: report.issue,
        state: report.state,
      }),
    );
  }
}

import { command } from "./command";
// Work issues a pull request names: full issue links or OWNER/REPO#N.
export function workIssueRefs(body: string, repo?: string) {
  if (!repo) return [];
  const name = repo.replaceAll(".", "\\.");
  const refs = new RegExp(
    `(?:https://github\\.com/${name}/issues/|${name}#)([1-9]\\d*)`,
    "g",
  );
  return [
    ...new Set(Array.from(body.matchAll(refs), (m) => Number(m[1]))),
  ].slice(0, 100);
}
export async function latestWorkMerge(repo: string, workRepo?: string) {
  const rows = JSON.parse(
    await command("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "title,url,mergedAt,body",
    ]),
  );
  const p = rows[0];
  return p
    ? {
        title: String(p.title).slice(0, 500),
        url: p.url,
        mergedAt: Date.parse(p.mergedAt),
        workIssues: workIssueRefs(String(p.body ?? ""), workRepo),
      }
    : null;
}

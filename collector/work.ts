import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  currentPosition,
  emailLinks,
  workDetails,
  associationSchema,
  issueSchema,
  RECENT_WORK_DAYS,
  type Issue,
  type WorkAssociation,
  type WorkSnapshot,
} from "../src/work-model";
// Runs GitHub CLI and returns stdout.
export type Gh = (args: string[]) => Promise<string>;
export const workDirectory = (home: string) =>
  path.join(home, ".local/share/project-overview/work");
const listed = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    body: z.string(),
    url: z.string(),
    state: z.string(),
    issueType: z.object({ name: z.string() }).nullable(),
    labels: z.array(z.object({ name: z.string() })),
    milestone: z
      .object({ title: z.string(), description: z.string() })
      .nullable(),
    updatedAt: z.string(),
  }),
);
const PAGE = 300;
// Work items are the issues labelled `work` in the configured repository:
// open ones plus those closed in the recent window, so finished work stays
// visible for a while. A full page may be truncated, so it fails rather than
// reporting a partial list.
export async function readIssues(
  run: Gh,
  repo: string,
  now = Date.now(),
): Promise<Issue[]> {
  const [owner, name] = repo.split("/");
  const since = new Date(now - RECENT_WORK_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10);
  const list = async (...filter: string[]) => {
    const rows = listed.parse(
      JSON.parse(
        await run([
          "issue",
          "list",
          "--repo",
          repo,
          "--label",
          "work",
          "--limit",
          String(PAGE),
          "--json",
          "number,title,body,url,state,issueType,labels,milestone,updatedAt",
          ...filter,
        ]),
      ),
    );
    if (rows.length >= PAGE) throw Error("Work issue list may be truncated");
    return rows;
  };
  const rows = [
    ...(await list("--state", "open")),
    ...(await list("--state", "closed", "--search", `closed:>=${since}`)),
  ];
  const updates = new Map<number, Issue["latestUpdate"]>();
  const updateState = new Map<number, "ok" | "unavailable">();
  // last:1 avoids the issue-list CLI's first-page comment truncation. Only a
  // short latest update is published; the issue retains its full history.
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    try {
      const query = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${batch.map((r) => `i${r.number}:issue(number:${r.number}) { comments(last:1) { nodes { body url updatedAt } } }`).join(" ")} } }`;
      const result = JSON.parse(
        await run(["api", "graphql", "-f", `query=${query}`]),
      );
      if (result.errors) throw Error("Comments unavailable");
      for (const r of batch) {
        const comment =
          result.data.repository[`i${r.number}`].comments.nodes[0];
        updates.set(
          r.number,
          comment
            ? {
                body: comment.body
                  .replace(/<!--[\s\S]*?-->/g, "")
                  .trim()
                  .slice(0, 1200),
                url: comment.url,
                at: Date.parse(comment.updatedAt),
              }
            : null,
        );
        updateState.set(r.number, "ok");
      }
    } catch {
      for (const r of batch) updateState.set(r.number, "unavailable");
    }
  }
  return rows.map((raw) => {
    const tagged = (prefix: string) =>
      raw.labels
        .filter((l) => l.name.startsWith(prefix))
        .map((l) => l.name.slice(prefix.length))
        .slice(0, 20);
    return issueSchema.parse({
      number: raw.number,
      title: raw.title.slice(0, 200),
      body: raw.body
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim()
        .slice(0, 800),
      url: raw.url,
      open: raw.state === "OPEN",
      kind: raw.issueType?.name.toLowerCase() ?? null,
      initiative: raw.milestone && {
        title: raw.milestone.title.slice(0, 200),
        capability: raw.milestone.description.slice(0, 400),
      },
      customers: tagged("customer:"),
      ...(raw.labels.some((l) => l.name === "upkeep") ? { upkeep: true } : {}),
      repos: tagged("repo:")
        .filter((name) => /^[\w.-]+$/.test(name))
        .map((name) => `${owner}/${name}`),
      updatedAt: Date.parse(raw.updatedAt),
      position: currentPosition(raw.body),
      details: workDetails(raw.body),
      emailLinks: emailLinks(raw.body),
      area: raw.labels.some((l) => l.name === "personal")
        ? "personal"
        : raw.labels.some(
              (l) =>
                l.name.startsWith("customer:") || l.name.startsWith("repo:"),
            )
          ? "business"
          : "unassigned",
      latestUpdate: updates.get(raw.number) ?? null,
      updatesState: updateState.get(raw.number) ?? "unavailable",
    });
  });
}
// Hook-written associations on this machine. Any unreadable record marks the whole
// set unavailable rather than pretending the readable ones are complete.
export async function readAssociations(home: string) {
  const associations: WorkAssociation[] = [];
  let state: WorkSnapshot["associationsState"] = "ok";
  try {
    const dir = path.join(workDirectory(home), "sessions");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    if (files.length > 2000) throw Error("Association capacity exceeded");
    for (const file of files) {
      try {
        const full = path.join(dir, file);
        if ((await stat(full)).size > 8000)
          throw Error("Association too large");
        associations.push(
          associationSchema.parse(JSON.parse(await readFile(full, "utf8"))),
        );
      } catch {
        state = "unavailable";
      }
    }
  } catch {
    state = "unavailable";
  }
  return { associations, state };
}
export async function readWork(
  home: string,
  run: Gh,
  repo: string,
): Promise<WorkSnapshot> {
  const read = await readAssociations(home);
  return {
    repo,
    issues: await readIssues(run, repo).catch(() => null),
    associations: read.associations,
    associationsState: read.state,
  };
}
// The hooks' offline copy of the work issues. Each machine refreshes its own
// after each scan.
const cached = z.array(issueSchema).max(600);
const cacheFile = (home: string) =>
  path.join(workDirectory(home), "issues.json");
export async function cacheIssues(home: string, issues: unknown) {
  await mkdir(workDirectory(home), { recursive: true, mode: 0o700 });
  const temp = `${cacheFile(home)}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(cached.parse(issues)), { mode: 0o600 });
  await rename(temp, cacheFile(home));
}
export async function readIssueCache(home: string) {
  const info = await stat(cacheFile(home));
  if (info.size > 2_000_000) throw Error("Issue cache too large");
  return {
    issues: cached.parse(JSON.parse(await readFile(cacheFile(home), "utf8"))),
    refreshedAt: Math.floor(info.mtimeMs),
  };
}

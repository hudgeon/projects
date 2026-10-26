import { readFile } from "node:fs/promises";
import { siteHeaders } from "./upload";
import { collect } from "./collect";
import { configSchema, inboxLogins } from "./config";
import { GMAIL_MODIFY_SCOPE } from "./delegation";
import { inboxGws } from "./inbox-logins";
import { applyCloses } from "./close";
import { oneClick, applyInboxActions } from "./inbox-actions";
import { cacheIssues } from "./work";
import { snapshotSchema } from "../src/model";
import { withFriction } from "./friction";
import { locateProject } from "./project-reference";

async function main() {
  const args = process.argv.slice(2),
    file = args.find((x) => !x.startsWith("--"));
  if (!file)
    throw new Error(
      "Usage: npm run collect -- collector/config.local.json [--publish]",
    );
  if (args.includes("--review") || args.includes("--send-daily"))
    throw Error("Daily briefs have been retired");
  const config = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (args.includes("--project")) {
    const id = args[args.indexOf("--project") + 1];
    if (!id || id.startsWith("--")) throw Error("--project requires an exact project ID");
    console.log(JSON.stringify(await locateProject(config, id)));
    return;
  }
  const scan = async (duties = false) => ({
    ...await withFriction(config, await collect(config, { inbox: duties })),
    ...(duties ? { inboxPlaceholders: {
      names: config.inboxPlaceholders, observedAt: Date.now(),
    } } : {}),
  });
  if (!args.includes("--publish")) {
    const snapshot = snapshotSchema.parse(await scan());
    if (snapshot.work?.issues) await cacheIssues(config.home, snapshot.work.issues);
    console.log(JSON.stringify(snapshot));
    return;
  }
  const { endpoint, headers } = await siteHeaders(config);
  const url = new URL("/api/ingest", endpoint);
  // The Worker says which machine is on duty: that one reads the inbox and
  // applies Mark done and inbox requests.
  let duties = false;
  try {
    const response = await fetch(new URL("/api/collector/duties", endpoint), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    duties = response.ok && ((await response.json()) as { duties?: unknown }).duties === true;
  } catch {
    duties = false;
  }
  const snapshot = snapshotSchema.parse(
    await scan(duties),
  );
  const issues = snapshot.work?.issues ?? null;
  // Hooks classify sessions offline against this machine's copy of the work
  // issues.
  if (issues) await cacheIssues(config.home, issues);
  async function publish(data: typeof snapshot) {
    const result = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok) throw new Error(`Publish failed (HTTP ${result.status})`);
    console.log(
      JSON.stringify({
        event: "snapshot_published",
        host: data.host,
        projects: data.projects.length,
        at: data.collectedAt,
      }),
    );
  }
  await publish(snapshot);
  // A failure leaves the requests queued for the next run.
  if (duties && args.includes("--closes")) {
    if (config.workRepo)
      try {
        await applyCloses(endpoint, headers, issues, config.workRepo);
      } catch {
        console.error(
          "Mark done requests unavailable; they stay queued for the next run.",
        );
        process.exitCode = 1;
      }
    // Archive and unsubscribe requests use this scan's own inbox reads, each
    // applied with the sign-in or delegated token of the inbox it names.
    const logins = inboxLogins(config);
    if (logins.length)
      try {
        await applyInboxActions(
          endpoint,
          headers,
          snapshot.inboxes,
          (account) => {
            const login = logins.find((l) => l.account.toLowerCase() === account.toLowerCase());
            return login ? inboxGws(config, login, GMAIL_MODIFY_SCOPE) : null;
          },
          oneClick,
          { issues, repo: config.workRepo },
        );
      } catch {
        console.error(
          "Inbox requests unavailable; they stay queued for the next run.",
        );
        process.exitCode = 1;
      }
  }
}
main().catch(() => {
  console.error(
    "Collection or publication failed. Check configuration, local source access and collector authentication.",
  );
  process.exitCode = 1;
});

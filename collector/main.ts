import { readFile, stat } from "node:fs/promises";
import { collect, gwsFor } from "./collect";
import { configSchema, inboxLogins } from "./config";
import { applyCloses } from "./close";
import { oneClick, applyInboxActions } from "./inbox-actions";
import { cacheIssues } from "./work";
import { snapshotSchema } from "../src/model";
import { withFriction } from "./friction";

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
  if (!args.includes("--publish")) {
    const snapshot = snapshotSchema.parse(await withFriction(config, await collect(config)));
    if (snapshot.work?.issues) await cacheIssues(config.home, snapshot.work.issues);
    console.log(JSON.stringify(snapshot));
    return;
  }
  if (!config.endpoint) throw new Error("Missing endpoint");
  const url = new URL("/api/ingest", config.endpoint);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!local && url.protocol !== "https:")
    throw new Error("Publishing requires HTTPS");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!local) {
    // Each machine has its own upload token, so the Worker knows which is
    // calling.
    const file = config.collectorTokenFile;
    if (file && (await stat(file)).mode & 0o077)
      throw new Error("Collector token must be readable only by its owner");
    const token = file
      ? (await readFile(file, "utf8")).trim()
      : process.env.COLLECTOR_TOKEN;
    if (!token || token.length < 32)
      throw new Error("Collector upload token is not configured");
    headers.Authorization = `Bearer ${token}`;
  }
  // The Worker says which machine is on duty: that one reads the inbox and
  // applies Mark done and inbox requests.
  let duties = false;
  try {
    const response = await fetch(new URL("/api/collector/duties", config.endpoint), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    duties = response.ok && ((await response.json()) as { duties?: unknown }).duties === true;
  } catch {
    duties = false;
  }
  const snapshot = snapshotSchema.parse(
    await withFriction(config, await collect(config, { inbox: duties })),
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
        await applyCloses(config.endpoint, headers, issues, config.workRepo);
      } catch {
        console.error(
          "Mark done requests unavailable; they stay queued for the next run.",
        );
        process.exitCode = 1;
      }
    // Archive and unsubscribe requests use this scan's own inbox reads, each
    // applied with the sign-in of the inbox it names.
    const logins = inboxLogins(config);
    if (logins.length)
      try {
        await applyInboxActions(
          config.endpoint,
          headers,
          snapshot.inboxes,
          (account) => {
            const login = logins.find((l) => l.account.toLowerCase() === account.toLowerCase());
            return login ? gwsFor(login) : null;
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

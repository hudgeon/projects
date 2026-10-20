// Runs the Worker in Miniflare, with the test machines it starts with, for the Worker's tests.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { digest } from "./auth";
import type { Portfolio } from "./index";

// Machines a test connects with known tokens, registered as the site would:
// the first on duty, its runner IDs its conversations' owners.
type TestMachine = { id: string; collector?: string; runner?: string; plainOwner: boolean };
const connecting = new WeakMap<MiniflareOptions, TestMachine[]>();
export async function start(config: MiniflareOptions): Promise<Miniflare> {
  const mf = new Miniflare(config);
  const machines = connecting.get(config) ?? [];
  if (machines.length) {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    await (ns.get(ns.idFromName("test")) as unknown as Portfolio).runnable();
    const sql = await mf.unsafeGetDurableObjectStorage("test", "Portfolio", { name: "test" });
    for (const [position, m] of machines.entries())
      await sql.exec(
        "INSERT INTO machines(id,name,position,collector_hash,runner_hash,plain_owner,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        m.id, m.id[0].toUpperCase() + m.id.slice(1), position,
        m.collector ? digest(m.collector) : null, m.runner ? digest(m.runner) : null,
        m.plainOwner ? 1 : 0, Date.now(),
      );
  }
  return mf;
}
export async function options(
  script: string,
  dir: string,
  all: Record<string, string> = {},
): Promise<MiniflareOptions> {
  const { COLLECTOR_TOKEN, RUNNER_TOKEN, LAPTOP_COLLECTOR_TOKEN, LAPTOP_RUNNER_TOKEN, ...values } = all;
  const machines: TestMachine[] = [
    ...(COLLECTOR_TOKEN || RUNNER_TOKEN ? [{ id: "studio", collector: COLLECTOR_TOKEN, runner: RUNNER_TOKEN, plainOwner: true }] : []),
    ...(LAPTOP_COLLECTOR_TOKEN || LAPTOP_RUNNER_TOKEN ? [{ id: "laptop", collector: LAPTOP_COLLECTOR_TOKEN, runner: LAPTOP_RUNNER_TOKEN, plainOwner: false }] : []),
  ];
  const config: MiniflareOptions = {
    unsafeInspectDurableObjects: true,
    // Lets a test fire the Worker's cron at /cdn-cgi/local/scheduled.
    unsafeTriggerHandlers: true,
    resourcePersistencePath: path.join(dir, "state"),
    workers: [
      {
        config: {
          name: "test",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: await readFile(script, "utf8"),
              },
            },
          },
          env: {
            PORTFOLIO_ID: { type: "text", value: "test" },
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                key,
                { type: "text" as const, value },
              ]),
            ),
            CONVERSATIONS: {
              type: "durable-object",
              worker: "test",
              exportName: "Conversation",
            },
            PORTFOLIOS: {
              type: "durable-object",
              worker: "test",
              exportName: "Portfolio",
            },
          },
          exports: {
            Portfolio: { type: "durable-object", storage: "sqlite" },
            Conversation: { type: "durable-object", storage: "sqlite" },
          },
        },
      },
    ],
  };
  connecting.set(config, machines);
  return config;
}

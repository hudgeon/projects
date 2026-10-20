// How this machine reaches its Projects site: HTTPS unless local, with its
// own collector token, so the Worker knows which machine is calling.
import { readFile, stat } from "node:fs/promises";
import { chatItemSchema, type ChatRead } from "../src/chat-model";
import type { Config } from "./config";

export type Site = { endpoint: string; headers: Record<string, string> };

export async function siteHeaders(config: Pick<Config, "endpoint" | "collectorTokenFile">) {
  if (!config.endpoint) throw new Error("Missing endpoint");
  const url = new URL(config.endpoint);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!local && url.protocol !== "https:")
    throw new Error("Publishing requires HTTPS");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!local) {
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
  return { endpoint: config.endpoint, headers } satisfies Site;
}
// Post one person's chat read for a source, dropping any item that does not
// fit the contract rather than failing the whole read. Returns the HTTP
// status, or null if the request could not be made.
export async function postChatRead(site: Site, read: ChatRead): Promise<number | null> {
  const safe = { ...read, items: read.items.filter((item) => chatItemSchema.safeParse(item).success) };
  try {
    const response = await fetch(new URL("/api/chats/read", site.endpoint), {
      method: "POST",
      headers: site.headers,
      body: JSON.stringify(safe),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    return response.status;
  } catch {
    return null;
  }
}

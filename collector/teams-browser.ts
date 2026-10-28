// Acquire the dedicated Teams browser. A service restart can leave Chrome
// running: launching that profile again only opens another tab and exits.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const TEAMS_URL = "https://teams.cloud.microsoft/";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function teamsPage(profileDir: string): Promise<string | null> {
  try {
    const [savedPort, browserPath] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split("\n");
    const port = Number(savedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath?.startsWith("/devtools/browser/")) return null;
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!version.ok) return null;
    const identity = new URL(((await version.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    // A stale port can belong to a different profile by now. Only reuse the
    // browser whose instance id Chrome wrote into this profile's port file.
    if (identity.protocol !== "ws:" || identity.hostname !== "127.0.0.1" || identity.port !== String(port) || identity.pathname !== browserPath) return null;
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const targets = (await response.json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
    const page = targets.find((t) => t.type === "page" && /teams\.(cloud\.)?microsoft|login\.microsoft/.test(t.url)) ??
      targets.find((t) => t.type === "page");
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

export async function openTeamsBrowser(chrome: string, profileDir: string): Promise<{ child: ChildProcess | null; url: string } | null> {
  const existing = await teamsPage(profileDir);
  if (existing) return { child: null, url: existing };
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(chrome, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    // Loopback only, with no --remote-allow-origins for web origins.
    "--no-first-run",
    "--no-default-browser-check",
    // Keep the list live while covered or the displays sleep, not minimised.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=Translate,IntensiveWakeUpThrottling",
    TEAMS_URL,
  ], { stdio: "ignore", detached: false });
  let failed = false;
  child.once("error", () => { failed = true; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    // Check the endpoint, not just the port file left by an earlier Chrome.
    // Also covers Chrome handing the request to an existing process and exiting.
    const url = await teamsPage(profileDir);
    if (url) return { child: child.exitCode === null && !failed ? child : null, url };
    if (failed || child.exitCode !== null) return null;
  }
  child.kill();
  return null;
}

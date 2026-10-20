import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  addCounts,
  emptyCounts,
  FRICTION_DAYS,
  utcDate,
  type FrictionDay,
  type FrictionSnapshot,
} from "../src/friction-model";
import { claudeRecord, emptyClaudeState, type ClaudeState } from "./friction-claude";
import { codexRecord, emptyCodexState, type CodexState } from "./friction-codex";
import {
  frictionDirectory,
  pruneReceipts,
  RECEIPT_DAYS,
  readReceipts,
  scanTranscripts,
  type Parser,
  type Receipt,
  type Transcript,
} from "./friction-store";
// Each scan brings this machine's friction receipts up to its native
// transcripts and publishes per-day totals and the harness versions seen.
// Nothing from a transcript leaves the machine.
export const claudeParser: Parser<ClaudeState> = {
  app: "Claude",
  empty: emptyClaudeState,
  record: claudeRecord,
  facts: (s) => ({
    cwd: s.cwd,
    version: s.version,
    client: s.client,
    firstAt: s.firstAt ?? null,
    lastAt: s.lastAt ?? null,
  }),
};
export const codexParser: Parser<CodexState> = {
  app: "Codex",
  empty: emptyCodexState,
  record: codexRecord,
  facts: (s) => ({
    cwd: s.cwd,
    version: s.version,
    client: s.client,
    firstAt: s.firstAt ?? null,
    lastAt: s.lastAt ?? null,
  }),
};
// Claude keeps one transcript per session as <project folder>/<session>.jsonl;
// a session's subagents and saved tool results sit in a folder of its own.
export async function claudeTranscripts(home: string): Promise<Transcript[]> {
  const root = path.join(home, ".claude/projects");
  const transcripts: Transcript[] = [];
  for (const folder of await readdir(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    let names: string[] = [];
    try {
      names = await readdir(path.join(root, folder.name));
    } catch {
      continue;
    }
    for (const name of names)
      if (name.endsWith(".jsonl"))
        transcripts.push({ id: name.slice(0, -6), file: path.join(root, folder.name, name) });
  }
  return transcripts;
}
// Codex keeps rollouts by day as sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl.
export async function codexTranscripts(home: string, now: number): Promise<Transcript[]> {
  const root = path.join(home, ".codex/sessions");
  const since = utcDate(now - RECEIPT_DAYS * 86400_000);
  const transcripts: Transcript[] = [];
  const days: string[] = [];
  for (const year of await readdir(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await readdir(path.join(root, year)).catch(() => [] as string[])) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await readdir(path.join(root, year, month)).catch(() => [] as string[]))
        if (/^\d{2}$/.test(day) && `${year}-${month}-${day}` >= since)
          days.push(path.join(root, year, month, day));
    }
  }
  for (const dir of days)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const match = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(name);
      if (match) transcripts.push({ id: match[1], file: path.join(dir, name) });
    }
  return transcripts;
}
// The last fourteen UTC days: each app's sessions last active that day, with
// their counts added.
export function frictionDays(receipts: Receipt[], now: number): FrictionDay[] {
  const since = utcDate(now - (FRICTION_DAYS - 1) * 86400_000);
  const days = new Map<string, FrictionDay>();
  for (const receipt of receipts) {
    if (receipt.lastAt === null) continue;
    const date = utcDate(receipt.lastAt);
    if (date < since || date > utcDate(now)) continue;
    const key = `${date}|${receipt.app}`;
    const day = days.get(key) ?? { date, app: receipt.app, sessions: 0, counts: emptyCounts() };
    day.sessions += 1;
    addCounts(day.counts, receipt.counts);
    days.set(key, day);
  }
  return [...days.values()].sort((a, b) =>
    a.date === b.date ? a.app.localeCompare(b.app) : a.date.localeCompare(b.date),
  );
}
const versionText = (value: unknown) =>
  typeof value === "string" && /^[\w.+-]{1,40}$/.test(value) ? value : undefined;
// Is a release newer than another, by its dotted numbers.
export function newer(release: string, than: string) {
  const parts = (v: string) => v.split(/[.+-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : -1));
  const a = parts(release),
    b = parts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
// The version the newest session of each app ran with, and a newer Codex
// release the app has seen; its record of one can be older than the install.
export function frictionVersions(receipts: Receipt[], codexLatest?: unknown) {
  const newest = (app: Receipt["app"]) =>
    receipts
      .filter((r) => r.app === app && r.version)
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))[0]?.version;
  const claude = versionText(newest("Claude")),
    codex = versionText(newest("Codex")),
    latest = versionText(codexLatest);
  return {
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
    ...(latest && codex && newer(latest, codex) ? { codexLatest: latest } : {}),
  };
}
export const unavailableFriction = (now: number, message: string): FrictionSnapshot => ({
  observedAt: now,
  versions: {},
  days: [],
  state: "unavailable",
  message,
});
export async function collectFriction(
  home: string,
  agents: ("codex" | "claude")[],
  now: number,
): Promise<FrictionSnapshot> {
  const dir = frictionDirectory(home);
  const receipts = new Map(
    (await readReceipts(dir)).map((receipt) => [`${receipt.app}:${receipt.id}`, receipt]),
  );
  let updated = 0,
    waiting = 0,
    failed = 0,
    listed = 0;
  for (const [app, parser, list] of [
    ["claude", claudeParser, () => claudeTranscripts(home)],
    ["codex", codexParser, () => codexTranscripts(home, now)],
  ] as const) {
    if (!agents.includes(app)) continue;
    try {
      const transcripts = await list();
      listed += 1;
      const result = await scanTranscripts(dir, parser as Parser<unknown>, transcripts, receipts, now);
      updated += result.updated;
      waiting += result.waiting;
      failed += result.failed;
    } catch {
      /* A missing app directory: its sessions are not on this machine. */
    }
  }
  if (!listed) return unavailableFriction(now, "Native transcripts are unavailable on this machine.");
  const kept = await pruneReceipts(dir, [...receipts.values()], now);
  let codexLatest: unknown;
  try {
    codexLatest = JSON.parse(await readFile(path.join(home, ".codex/version.json"), "utf8")).latest_version;
  } catch {
    /* Codex has not recorded a release check. */
  }
  const claude = kept.filter((r) => r.app === "Claude").length;
  return {
    observedAt: now,
    versions: frictionVersions(kept, codexLatest),
    days: frictionDays(kept, now),
    state: "ok",
    message: `Receipts for ${kept.length} sessions (${claude} Claude, ${kept.length - claude} Codex); ${updated} updated this scan${waiting ? `, ${waiting} waiting for the next` : ""}${failed ? `, ${failed} unreadable` : ""}.`,
  };
}
// Adds this scan's friction to a snapshot; a failure publishes the rest.
export async function withFriction<T extends object>(
  config: { home: string; agents: ("codex" | "claude")[] },
  snapshot: T,
): Promise<T & { friction: FrictionSnapshot }> {
  const friction = await collectFriction(config.home, config.agents, Date.now()).catch(() =>
    unavailableFriction(Date.now(), "Friction receipts could not be updated this scan."),
  );
  return { ...snapshot, friction };
}

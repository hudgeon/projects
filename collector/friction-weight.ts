import path from "node:path";
import {
  clientKind,
  FRICTION_DAYS,
  utcDate,
  WEIGHT_KEYS,
  type Weight,
  type WeightRow,
  type WeightSource,
} from "../src/friction-model";
import { projectsLinks, runnerStateDirectory } from "./friction-runner";
import { receiptFile, savePrivate, type Receipt } from "./friction-store";
// Session weight from the receipts: each session's start and peak tokens,
// as medians by day, app and the way the session was launched. Only those
// medians and the session counts leave the machine.
export const sessionWeight = (state: { start?: number; peak?: number }) =>
  state.start && state.peak ? { start: state.start, peak: state.peak } : null;
// The file `home doctor` reads: this scan's weight, as the snapshot carries it.
export const weightFile = (dir: string) => path.join(dir, "weight.json");
// A session's role is in the runner's journal only while the conversation
// still names it (a coordinator's is dropped when it hands over), so a role
// seen once is kept on the receipt.
export async function noteRoles(dir: string, home: string, receipts: Receipt[]) {
  if (!receipts.some((receipt) => !receipt.role)) return;
  const links = await projectsLinks(runnerStateDirectory(home));
  for (const receipt of receipts) {
    const link = receipt.role ? undefined : links.get(`${receipt.app}:${receipt.id}`);
    if (!link) continue;
    receipt.role = link.role === "master" ? "coordinator" : "helper";
    await savePrivate(receiptFile(dir, receipt.app, receipt.id), receipt).catch(() => {});
  }
}
// How a session was launched: by the runner (its journal's role, or the
// client name its Codex sessions carry), from a desktop app or in an
// interactive terminal. A scripted run or another client has no source of its
// own and counts only in "all".
export function weightSource(receipt: Receipt): Exclude<WeightSource, "all"> | undefined {
  if (receipt.role) return receipt.role;
  if (receipt.client === "projects_runner") return "projects";
  return clientKind(receipt.client);
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
function rows(receipts: Receipt[]): WeightRow[] {
  const groups = new Map<string, Receipt[]>();
  for (const receipt of receipts)
    for (const source of [weightSource(receipt), "all"] as const) {
      if (!source) continue;
      const key = `${receipt.app}|${source}`;
      groups.set(key, [...(groups.get(key) ?? []), receipt]);
    }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [app, source] = key.split("|") as [Receipt["app"], WeightSource];
      return {
        app,
        source,
        sessions: group.length,
        start: median(group.map((r) => r.weight!.start)),
        peak: median(group.map((r) => r.weight!.peak)),
      };
    })
    .sort((a, b) =>
      a.app === b.app
        ? WEIGHT_KEYS.indexOf(a.source) - WEIGHT_KEYS.indexOf(b.source)
        : a.app.localeCompare(b.app),
    );
}
// The measured sessions of the last fourteen UTC days, each on the day of its
// last activity as the friction totals place it, and of the last seven.
export function weightTotals(receipts: Receipt[], now: number): Weight {
  const since = utcDate(now - (FRICTION_DAYS - 1) * 86400_000),
    week = utcDate(now - 6 * 86400_000),
    today = utcDate(now);
  const byDate = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    if (receipt.lastAt === null || !receipt.weight) continue;
    const date = utcDate(receipt.lastAt);
    if (date < since || date > today) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), receipt]);
  }
  const dates = [...byDate.keys()].sort();
  return {
    days: dates.flatMap((date) => rows(byDate.get(date)!).map((row) => ({ date, ...row }))),
    week: rows(dates.filter((date) => date >= week).flatMap((date) => byDate.get(date)!)),
  };
}

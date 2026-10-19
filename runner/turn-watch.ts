import { execFile } from "node:child_process";
import path from "node:path";
import type { LiveWatch, NativeActivity, WaitLabel } from "../src/run-model";
import { waitLabel } from "./native-events";

// When a turn's wait is shown, and when it may be stuck. These are signs, not
// verdicts: the owner sees them and the helper is told once; nothing is stopped.
export const WATCH_LIMITS = {
  // A tool call or a silence this long is shown as a wait.
  showMs: 2 * 60_000,
  // The agent waiting this long, with no command using CPU, counts as quiet.
  quietMs: 3 * 60_000,
  // Quiet this long, or a command it started idle this long while it waits.
  idleMs: 10 * 60_000,
  // No word from the agent this long, with no tool call open.
  silentMs: 10 * 60_000,
  sampleMs: 30_000,
};
export type ProcessRow = { pid: number; ppid: number; cpu: number; name: string };
// CPU seconds from ps's [[dd-]hh:]mm:ss[.cc].
export function cpuSeconds(value: string) {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return (
    Number(days) * 86400 +
    clock.split(":").reduce((n, part) => n * 60 + Number(part), 0)
  );
}
export function processRows(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) =>
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,time=,comm="],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, out) => {
        if (error) return reject(error);
        resolve(
          out.split("\n").flatMap((line) => {
            const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
            return m
              ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpu: cpuSeconds(m[3]), name: path.basename(m[4]) }]
              : [];
          }),
        );
      },
    ),
  );
}
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
// What the turn's commands run: everything a shell under the agent starts,
// without the shells and sleeps themselves. The agent, and servers it starts
// directly such as its browser's, are not commands.
export function commandProcesses(rows: ProcessRow[], root: number) {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows)
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const found: ProcessRow[] = [];
  const walk = (pid: number, underShell: boolean, depth: number) => {
    if (depth > 64) return;
    for (const row of children.get(pid) ?? []) {
      const shell = SHELLS.has(row.name.replace(/^-/, ""));
      if (underShell && !shell && row.name !== "sleep") found.push(row);
      walk(row.pid, underShell || shell, depth + 1);
    }
  };
  walk(root, false, 0);
  return found;
}
const TOOLS = new Set<NativeActivity["kind"]>(["command", "read", "search", "edit", "tool"]);
// Follows one native turn: its open tool calls, its last word and the CPU its
// commands use. publish gets each change of what to show; stuck is called
// once for each wait that may be stuck; label, when given, is asked once what
// a long command the local rules cannot place waits on.
export function watchTurn(o: {
  pid: () => number | null;
  publish: (watch: LiveWatch | undefined) => void;
  stuck: (reason: NonNullable<LiveWatch["stuck"]>) => void;
  label?: (command: string) => Promise<WaitLabel | undefined>;
  rows?: () => Promise<ProcessRow[]>;
  limits?: Partial<typeof WATCH_LIMITS>;
  now?: () => number;
}) {
  const limits = { ...WATCH_LIMITS, ...o.limits },
    now = o.now ?? Date.now;
  const open: { kind: NativeActivity["kind"]; at: number; label?: WaitLabel; command?: string; asked?: boolean }[] = [];
  // Each command process: CPU seconds, when first seen, when it last used CPU.
  const procs = new Map<number, { cpu: number; seen: number; busy: number }>();
  let said = now(),
    cpuAt = 0,
    sampledAt = 0,
    sampling = false,
    shown = "null",
    told = "";
  const check = () => {
    const t = now(),
      first = open[0];
    let watch: LiveWatch | undefined;
    if (first) {
      const sampled = t - sampledAt <= 2 * limits.sampleMs,
        quiet = Math.max(said, cpuAt);
      // A command it started that has sat idle while the agent waits.
      const idle = [...procs.values()]
        .filter((p) => t - p.seen >= limits.idleMs && t - p.busy >= limits.idleMs)
        .sort((a, b) => a.busy - b.busy)[0];
      const stuckSince = !sampled
        ? null
        : t - quiet >= limits.idleMs
          ? quiet
          : idle && t - quiet >= limits.quietMs
            ? idle.busy
            : null;
      if (o.label && first.command && !first.label && !first.asked && t - first.at >= limits.showMs) {
        first.asked = true;
        void o.label(first.command).then((label) => {
          if (label && open.includes(first)) {
            first.label = label;
            check();
          }
        }, () => {});
      }
      if (stuckSince !== null || t - first.at >= limits.showMs)
        watch = {
          since: first.at,
          on: first.kind === "command" ? "command" : "tool",
          ...(first.label ? { label: first.label } : {}),
          ...(stuckSince !== null ? { stuck: "idle" as const, quietSince: stuckSince } : {}),
        };
    } else if (t - said >= limits.showMs)
      watch = {
        since: said,
        on: "agent",
        ...(t - said >= limits.silentMs ? { stuck: "silent" as const, quietSince: said } : {}),
      };
    const key = JSON.stringify(watch ?? null);
    if (key !== shown) {
      shown = key;
      o.publish(watch);
    }
    const episode = watch?.stuck ? `${watch.stuck}:${watch.since}` : "";
    if (episode && episode !== told) {
      told = episode;
      o.stuck(watch!.stuck!);
    }
  };
  const sample = async () => {
    const root = o.pid();
    if (!root || sampling) return check();
    sampling = true;
    try {
      const rows = await (o.rows ?? processRows)();
      const t = now(),
        live = new Set<number>();
      for (const row of commandProcesses(rows, root)) {
        live.add(row.pid);
        const known = procs.get(row.pid);
        const busy = known && row.cpu - known.cpu >= 0.01;
        if (busy) cpuAt = t;
        procs.set(row.pid, { cpu: row.cpu, seen: known?.seen ?? t, busy: busy ? t : (known?.busy ?? t) });
      }
      for (const pid of procs.keys()) if (!live.has(pid)) procs.delete(pid);
      sampledAt = t;
    } catch {
      // Without a reading nothing is called idle.
    } finally {
      sampling = false;
    }
    check();
  };
  const timer = setInterval(() => void sample(), limits.sampleMs);
  return {
    // A native event: the agent said something, or a tool call started or ended.
    activity(event: NativeActivity, command?: string) {
      said = now();
      if (TOOLS.has(event.kind)) {
        if (event.state === "started")
          open.push({ kind: event.kind, at: said, label: waitLabel(command), command });
        else {
          const i = open.findLastIndex((t) => t.kind === event.kind);
          if (i >= 0) open.splice(i, 1);
        }
      }
      check();
    },
    // Tokens, a progress note or a plan: the agent is still at work.
    touch() {
      said = now();
      check();
    },
    sample,
    clear() {
      clearInterval(timer);
    },
  };
}

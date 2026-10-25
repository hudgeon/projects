import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type MemoryPressure = "normal" | "warning" | "critical" | "unknown" | "unsupported";
const exec = promisify(execFile);
// Kernel pressure covers the whole machine, including native agents, their
// tool processes, the chat browsers and desktop apps. Free RAM alone does not.
export async function readMemoryPressure(): Promise<MemoryPressure> {
  if (process.platform !== "darwin") return "unsupported";
  try {
    const {stdout} = await exec("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"],
      {timeout: 2000, maxBuffer: 1024});
    return parseMemoryPressure(stdout);
  } catch {
    return "unknown";
  }
}
export function parseMemoryPressure(value: string): MemoryPressure {
  switch (value.trim()) {
    case "1": return "normal";
    case "2": return "warning";
    case "4": return "critical";
    default: return "unknown";
  }
}

// Sample at most every five seconds. A warning must persist for ten seconds;
// critical or unreadable pressure pauses immediately. Reopen only after
// thirty seconds of observed normal pressure, so admission does not flap.
export function memoryAdmission(o: {
  read?: () => Promise<MemoryPressure>;
  now?: () => number;
  changed?: (admission: "open" | "paused", pressure: MemoryPressure) => void;
} = {}): () => Promise<boolean> {
  const read = o.read ?? readMemoryPressure, now = o.now ?? (() => performance.now());
  let sampled = -Infinity, warningAt: number | null = null, normalAt: number | null = null;
  let open = true, reported: boolean | undefined;
  return async () => {
    const at = now();
    if (at - sampled < 5000) return open;
    const pressure = await read().catch(() => "unknown" as const);
    sampled = now();
    if (pressure === "unsupported") {
      open = true;
    } else if (pressure === "normal") {
      warningAt = null;
      normalAt ??= sampled;
      if (sampled - normalAt >= 30_000) open = true;
    } else {
      normalAt = null;
      warningAt ??= sampled;
      if (pressure !== "warning" || sampled - warningAt >= 10_000) open = false;
    }
    if (reported !== open) {
      reported = open;
      o.changed?.(open ? "open" : "paused", pressure);
    }
    return open;
  };
}

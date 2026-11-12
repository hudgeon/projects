import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { FailureReason } from "../src/telemetry";
import { object } from "./native-events";

export function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 3000);
  timer.unref();
}
export class NativeStopError extends Error {}
// A failure with a known cause, native or the runner's own: its message is
// what the user reads, its reason the category telemetry keeps.
export class Failure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
  }
}
export function nativeProcessStopped(pid: number | null): boolean {
  if (!pid || pid <= 1) return false;
  // The detached process group too: a shell or tool can outlive it.
  for (const target of [pid, -pid]) {
    try {
      process.kill(target, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  }
  return true;
}
export async function confirmStopped(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolve, reject) => {
    const closed = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("close", closed);
      reject(
        new NativeStopError(
          "An agent process did not confirm it stopped, so nothing else was started. Send a follow-up once it has stopped.",
        ),
      );
    }, 6000);
    child.once("close", closed);
    stopProcess(child);
  });
}
// Only native protocol events are parsed; tool output is drained, never sent.
export function readLines(
  child: ChildProcessWithoutNullStreams,
  receive: (line: Record<string, unknown>) => void,
  fail: (error: Error) => void,
) {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8_000_000) {
      fail(
        new Failure(
          "protocol_error",
          "Native response exceeded the protocol limit.",
        ),
      );
      return;
    }
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        receive(object(JSON.parse(line)));
      } catch {
        fail(
          new Failure(
            "protocol_error",
            "Native session returned an invalid protocol message.",
          ),
        );
      }
    }
  });
  child.on("error", () =>
    fail(
      new Failure(
        "native_unavailable",
        "Native agent could not start. Check its installation and local login.",
      ),
    ),
  );
  child.stdin.on("error", () =>
    fail(Error("Native session input closed unexpectedly.")),
  );
}

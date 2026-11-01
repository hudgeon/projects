import { spawn } from "node:child_process";
import { z } from "zod";
import { nativeEnv } from "../runner/native-env";
const directorySchema = z.object({
  complete: z.literal(true), observedAt: z.number().int().nonnegative(),
  hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
}).strict();
export function registeredUsers(text: string, now = Date.now()) {
  const result = directorySchema.parse(JSON.parse(text));
  if (result.observedAt > now + 5000 || now - result.observedAt > 60_000) throw Error("Stale user directory");
  return new Set(result.hashes);
}
// The operator configures a fixed local command, never email-supplied code or
// arguments. It receives no mailbox, collector, runner or provider credential.
export async function readSupportUsers(command: string[] | undefined, directory: string) {
  if (!command?.length) throw Error("Registered-user source is not connected");
  return new Promise<ReadonlySet<string>>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: directory, env: nativeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let text = "", failed = false;
    const fail = () => { failed = true; child.kill("SIGKILL"); reject(Error("Registered-user directory unavailable")); };
    const timer = setTimeout(fail, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { text += chunk; if (text.length > 1_000_000) fail(); });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", code => {
      clearTimeout(timer);
      if (failed) return;
      try { if (code !== 0) throw Error(); resolve(registeredUsers(text)); }
      catch { reject(Error("Registered-user directory unavailable")); }
    });
  });
}

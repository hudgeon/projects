// launchd, as the machine installer drives it: a job's definition, what
// launchd knows of it, and starting or restarting it.
import { execFileSync } from "node:child_process";
import path from "node:path";

const xml = (value) =>
  String(value).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
export const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function launchd({ base, searchPath, domain }) {
  const plist = (label, program, extra, log) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
${program.map((p) => `    <string>${xml(p)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([...new Set(searchPath)].join(":"))}</string></dict>
${extra}
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(base, `${log}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(base, `${log}-error.log`))}</string>
</dict></plist>
`;
  // What launchd knows of a job: whether it is loaded and, when a process is
  // running, its pid. A loaded job with no pid has exited (or never started)
  // and launchd is between retries.
  const status = (label) => {
    try {
      const print = execFileSync("launchctl", ["print", `${domain}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return {
        loaded: true,
        pid: Number(/^\s*pid = (\d+)$/m.exec(print)?.[1]) || null,
        exit: /^\s*last exit code = (.+)$/m.exec(print)?.[1] ?? null,
      };
    } catch {
      return { loaded: false, pid: null, exit: null };
    }
  };
  const loaded = (label) => status(label).loaded;
  // launchd refuses a bootstrap ("5: Input/output error") while a job it was
  // told to boot out is still exiting, so wait for it to go, then retry briefly.
  const start = (target) => {
    for (let attempt = 1; ; attempt++)
      try {
        execFileSync("launchctl", ["bootstrap", domain, target], { stdio: "pipe" });
        return;
      } catch (error) {
        if (attempt === 10) throw error;
        pause(1000);
      }
  };
  const stop = (label) => {
    execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "inherit" });
    for (let waited = 0; loaded(label) && waited < 15_000; waited += 500) pause(500);
  };
  const restart = (label, target) => {
    stop(label);
    start(target);
  };
  return { plist, status, loaded, start, stop, restart };
}

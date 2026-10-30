// Manual read-only comparison. No installation, schedule, authority/config
// change, snapshot publication, canonical cache update or model call.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readWorkRecord } from "../collector/work-record";
import { rehearseWorkRead } from "../collector/work-rehearsal";
import { WorkServiceClient, workAliasSchema, WorkServiceError } from "../collector/work-service";

async function outsideGit(file: string) {
  if (!path.isAbsolute(file)) throw new WorkServiceError("invalid");
  let resolved = path.dirname(file);
  while (!(await lstat(resolved).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; }))) resolved = path.dirname(resolved);
  for (let dir = await realpath(resolved);; dir = path.dirname(dir)) {
    if (await lstat(path.join(dir, ".git")).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; })) throw new WorkServiceError("invalid");
    if (dir === path.dirname(dir)) break;
  }
}
async function tokenFile(file: string) {
  await outsideGit(file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 100 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new WorkServiceError("invalid");
    const bytes = Buffer.alloc(101), { bytesRead } = await fd.read(bytes);
    const after = await fd.stat();
    if (bytesRead > 100 || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new WorkServiceError("invalid");
    const token = bytes.subarray(0, bytesRead).toString("utf8").trim();
    if (!/^wrt_[A-Za-z0-9_-]{43}$/.test(token)) throw new WorkServiceError("invalid");
    return token;
  } finally { await fd.close(); }
}
async function report(file: string, value: unknown) {
  await outsideGit(file);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await outsideGit(file);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new WorkServiceError("invalid");
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}
async function main() {
  const args = process.argv.slice(2), options = new Map<string, string>();
  const allowed = ["--endpoint", "--token-file", "--repository", "--issue", "--report"];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new WorkServiceError("invalid");
    options.set(args[i], args[i + 1]);
  }
  if (options.size !== allowed.length) throw new WorkServiceError("invalid");
  const alias = workAliasSchema.parse({ host: "github.com", repository: options.get("--repository")?.toLowerCase(), issue: Number(options.get("--issue")) });
  const output = options.get("--report")!;
  // Establish the protected output before using the credential or reading work.
  await report(output, { schema: "projects/work-rehearsal@1", authority: "github", status: "unavailable", checkedAt: new Date().toISOString() });
  const client = new WorkServiceClient(options.get("--endpoint")!, await tokenFile(options.get("--token-file")!));
  const result = await rehearseWorkRead(client, alias, readWorkRecord);
  await report(output, result);
  console.log(`Work rehearsal: ${result.status}. GitHub remains authoritative.`);
}
main().catch(() => {
  // Never reflect HTTP bodies, source text, arguments, credentials or gh output.
  console.error("Work rehearsal unavailable; no canonical work was changed.");
  process.exitCode = 1;
});

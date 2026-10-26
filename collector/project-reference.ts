import path from "node:path";
import { realpath } from "node:fs/promises";
import { discover, type Config } from "./collect";

// Read only repository discovery. No inbox, native session or credential reads.
export async function locateProject(config: Config, id: string) {
  const matches = (await discover(config)).filter(
    (p) =>
      (p.id ??
        p.repo ??
        `local/${path.basename(p.directory).replace(/[^\w.-]/g, "-")}`) === id,
  );
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? "Duplicate project ID; repair repository metadata."
        : "Project ID not found on this machine.",
    );
  const p = matches[0];
  const root = await realpath(config.root);
  const cwd = await realpath(path.resolve(root, p.directory));
  if (!cwd.startsWith(root + path.sep))
    throw Error("Project directory escaped the registered root.");
  return {
    id,
    name: p.name,
    host: config.host,
    cwd,
    repo: p.repo ?? null,
    plan: p.plan ? path.resolve(cwd, p.plan) : null,
    observedAt: Date.now(),
  };
}

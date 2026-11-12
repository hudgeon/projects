import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../runner/workspaces";

// A small committed project for project review tests.
export async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "project-context-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(
    path.join(cwd, ".gitignore"),
    ".state/\n.env\n.wip/\nnode_modules/\n",
  );
  await writeFile(
    path.join(cwd, "AGENTS.md"),
    "Drafting only. Publishing requires the owner's approval.\n",
  );
  await writeFile(
    path.join(cwd, "PLAN.md"),
    "The invoice importer must preserve the pipe delimiter and account boundary.\n",
  );
  await writeFile(
    path.join(cwd, "README.md"),
    "The project imports invoices.\n",
  );
  await writeFile(
    path.join(cwd, "src/invoices.ts"),
    'export const delimiter = "|"; // Invoice format\n',
  );
  await writeFile(
    path.join(cwd, "src/weather.ts"),
    'export const weather = "sunny";\n',
  );
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["add", "."]);
  await git(cwd, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "Initial fixture",
  ]);
  return {
    cwd,
    options: {
      project: {
        id: "example/importer",
        name: "Importer",
        cwd,
        plan: "PLAN.md",
      },
      instructions: ["Inspect the invoice delimiter. Draft only."],
      task: "Inspect the invoice importer",
      signal: new AbortController().signal,
    },
  };
}

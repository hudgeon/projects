import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../runner/workspaces";
import { JEV_MODEL } from "../runner/context";

// A small committed project and a Jev stand-in for project review tests.
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
export function selector(
  onRequest?: (body: any, init: RequestInit) => Promise<void> | void,
) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    value: {
      mode: "select" as const,
      gateway: { accountId: "a".repeat(32), gatewayId: "example" },
      key: async () => "fixture-key",
      fetch: (async (_url, init) => {
        calls++;
        const body = JSON.parse(init!.body as string);
        await onRequest?.(body, init!);
        return Response.json({
          model: JEV_MODEL,
          answers: Object.fromEntries(
            body.state.candidates.map((c: { path: string }, i: number) => [
              `keep_${i}`,
              { type: "noul", noul: c.path.includes("weather") ? 0 : 0.9 },
            ]),
          ),
          usage: { input_tokens: 500, output_tokens: 40 },
        });
      }) as typeof fetch,
    },
  };
}

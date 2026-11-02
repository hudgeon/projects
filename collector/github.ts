import { createSign } from "node:crypto";
import { command } from "./command";
import type { Gh } from "./work";
// An optional read-only GitHub App installed on the account that owns the
// repositories. Installation tokens are restricted further to the selected
// repositories and read scopes. Without one, the signed-in GitHub CLI reads.
export async function githubReaders(repositories: string[], request = fetch) {
  const key = process.env.GITHUB_APP_PRIVATE_KEY,
    id = process.env.GITHUB_APP_ID;
  const groups = new Map<string, string[]>(),
    tokens = new Map<string, string>();
  for (const repo of new Set(repositories.map((r) => r.toLowerCase()))) {
    const owner = repo.split("/")[0];
    groups.set(owner, [...(groups.get(owner) ?? []), repo]);
  }
  if (key && id)
    await Promise.all(
      [...groups.values()].map(async (repos) => {
        try {
          const token = await installationToken(repos, id, key, request);
          for (const repo of repos) tokens.set(repo, token);
        } catch {
          // An unavailable installation affects only its owner's repositories.
        }
      }),
    );
  return (repository: string): Gh => {
    const token = tokens.get(repository.toLowerCase());
    return (args) => {
      if ((key || id) && !token)
        return Promise.reject(Error("GitHub read scope unavailable"));
      return command("gh", args, undefined, token ? { GH_TOKEN: token } : {});
    };
  };
}
async function installationToken(
  repositories: string[],
  id: string,
  key: string,
  request: typeof fetch,
) {
  const now = Math.floor(Date.now() / 1000),
    header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    ),
    payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }),
    ).toString("base64url");
  const message = `${header}.${payload}`,
    signature = createSign("RSA-SHA256").update(message).sign(key, "base64url");
  const headers = {
    Authorization: `Bearer ${message}.${signature}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const r = await request(
    `https://api.github.com/repos/${repositories[0]}/installation`,
    {
      headers,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok) throw Error("GitHub App installation unavailable");
  const installation = (await r.json()) as { id: number };
  const issued = await request(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        repositories: repositories.map((r) => r.split("/")[1]),
        permissions: {
          contents: "read",
          issues: "read",
          pull_requests: "read",
          checks: "read",
          actions: "read",
          statuses: "read",
          metadata: "read",
        },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!issued.ok) throw Error("GitHub read-only token unavailable");
  const result = (await issued.json()) as { token: string };
  if (!result.token) throw Error("GitHub token missing");
  return result.token;
}

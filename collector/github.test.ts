import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { githubReaders } from "./github";
import { readWork } from "./work";
import { latestWorkMerge } from "./work-delivery";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

async function fixture(t: TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "github-readers-"));
  const log = path.join(home, "calls.jsonl");
  const saved = Object.fromEntries(
    [
      "PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
    ].map((name) => [name, process.env[name]]),
  );
  t.after(async () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await rm(home, { recursive: true, force: true });
  });
  process.env.PATH = `${home}${path.delimiter}${process.env.PATH}`;
  process.env.GH_TOKEN = "existing-cli-token";
  process.env.GITHUB_TOKEN = "other-cli-token";
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  await writeFile(
    path.join(home, "gh"),
    `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2);
const observed = { args, token: process.env.GH_TOKEN, privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? null };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(observed) + "\\n");
if (args[0] === "issue") console.log(JSON.stringify(args.includes("closed") ? [] : [{
  number: 7, title: "Work", body: "Context", url: "https://github.com/acme/work/issues/7", state: "OPEN",
  issueType: null, labels: [{name:"work"}], milestone: null, updatedAt: "2026-10-30T00:00:00Z"
}]));
else if (args[0] === "api") console.log(JSON.stringify({data:{repository:{i7:{comments:{nodes:[]}}}}}));
else if (args[0] === "pr") console.log(JSON.stringify([{title:"Delivered", url:"https://github.com/acme/app/pull/1", mergedAt:"2026-10-30T00:00:00Z", body:"Refs acme/work#7"}]));
else console.log(JSON.stringify(observed));
`,
    { mode: 0o700 },
  );
  return {
    home,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function transport(failure?: "lookup" | "issue" | "network") {
  const scopes: {
    installation: string;
    repositories: string[];
    permissions: Record<string, string>;
  }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/installation")) {
      if (url.includes("/personal/") && failure === "network")
        throw Error("private upstream details");
      if (url.includes("/personal/") && failure === "lookup")
        return new Response(null, { status: 404 });
      return Response.json({ id: url.includes("/personal/") ? 2 : 1 });
    }
    const installation = /installations\/(\d+)/.exec(url)![1];
    const body = JSON.parse(String(init?.body));
    scopes.push({ installation, ...body });
    if (installation === "2" && failure === "issue")
      return new Response(null, { status: 422 });
    return Response.json({ token: `installation-${installation}-token` });
  };
  return { request, scopes };
}

test("mixed owners use separate read-only scopes without mutating the process token", async (t) => {
  const f = await fixture(t),
    http = transport();
  const reader = await githubReaders(
    ["Acme/Work", "acme/app", "ACME/WORK", "personal/app"],
    http.request,
  );
  const observed = await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      const repo = i % 2 ? "personal/app" : "acme/work";
      return JSON.parse(await reader(repo)(["repo", "view", repo]));
    }),
  );
  assert.deepEqual(
    observed.map((o) => o.token),
    Array.from({ length: 12 }, (_, i) => `installation-${i % 2 ? 2 : 1}-token`),
  );
  assert.ok(observed.every((o) => o.privateKey === null));
  assert.equal(process.env.GH_TOKEN, "existing-cli-token");
  assert.deepEqual(
    http.scopes.map((s) => [s.installation, s.repositories]).sort(),
    [
      ["1", ["work", "app"]],
      ["2", ["app"]],
    ],
  );
  for (const s of http.scopes)
    assert.deepEqual(s.permissions, {
      contents: "read",
      issues: "read",
      pull_requests: "read",
      checks: "read",
      actions: "read",
      statuses: "read",
      metadata: "read",
    });
  assert.equal((await f.calls()).length, 12);
  await assert.rejects(
    reader("acme/unobserved")(["repo", "view", "acme/unobserved"]),
    /GitHub read scope unavailable/,
  );
});

for (const phase of ["lookup", "issue", "network"] as const)
  test(`an owner's ${phase} failure leaves work and merge reads available under their own token`, async (t) => {
    const f = await fixture(t),
      http = transport(phase);
    const reader = await githubReaders(
      ["personal/app", "acme/work", "acme/app"],
      http.request,
    );
    const [work, denied, merge] = await Promise.all([
      readWork(f.home, reader("acme/work"), "acme/work"),
      readWork(f.home, reader("personal/app"), "personal/app"),
      latestWorkMerge("acme/app", "acme/work", reader("acme/app")),
    ]);
    assert.deepEqual(
      work.issues?.map((i) => i.number),
      [7],
    );
    assert.equal(
      denied.issues,
      null,
      "an unavailable owner is never an empty work list",
    );
    assert.deepEqual(merge?.workIssues, [7]);
    const calls = await f.calls();
    assert.equal(calls.length, 4);
    assert.ok(
      calls.every(
        (call) =>
          call.token === "installation-1-token" && call.privateKey === null,
      ),
    );
    assert.equal(process.env.GH_TOKEN, "existing-cli-token");
    await assert.rejects(
      reader("personal/app")(["repo", "view", "personal/app"]),
      { message: "GitHub read scope unavailable" },
    );
  });

test("a missing half of the App configuration refuses reads instead of using a CLI token", async (t) => {
  await fixture(t);
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  const reader = await githubReaders(["acme/work"], async () => {
    throw Error("must not fetch");
  });
  await assert.rejects(
    reader("acme/work")(["issue", "list"]),
    /GitHub read scope unavailable/,
  );
});

test("without an App the collector keeps the machine's existing CLI authentication", async (t) => {
  await fixture(t);
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  const reader = await githubReaders(
    ["acme/work", "personal/app"],
    async () => {
      throw Error("must not fetch");
    },
  );
  for (const repo of ["acme/work", "personal/app"])
    assert.equal(
      JSON.parse(await reader(repo)(["repo", "view", repo])).token,
      "existing-cli-token",
    );
});

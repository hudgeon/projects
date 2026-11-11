// Copies main's file tree, less the private paths below, to the public
// repository (this checkout's `public` Git remote) as one commit per release,
// so this repository's history and messages stay private. Each commit carries
// the identity set in this checkout's Git config as publish.name and
// publish.email. Refuses to publish while any term listed in the untracked
// file `.git/info/public-deny` (one per line, matched as a whole word in any
// case) appears in a published file's path or text. That check is a safety
// net for known terms, not proof that nothing private remains. Uses this
// machine's signed-in Git credentials; never forces a push.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The organisation's own security review gate and merge arming: synced from
// elsewhere, calling its private workflows, and of no use outside it.
const PRIVATE = [
  ".github/scripts/security-review.mjs",
  ".github/workflows/auto-merge.yml",
  ".github/workflows/security-review.yml",
];

const git = (args, env = {}) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env },
  }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const setting = (key) => {
  try {
    return git(["config", "--get", key]);
  } catch {
    return "";
  }
};

let remote;
try {
  remote = git(["remote", "get-url", "public"]);
} catch {
  fail("Add the public repository first: git remote add public <url>");
}
const denyFile = path.join(
  git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  "info",
  "public-deny",
);
let deny;
try {
  deny = readFileSync(denyFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
} catch {
  deny = [];
}
if (!deny.length)
  fail(`List the terms that must never be published, one per line, in ${denyFile}.`);
const name = setting("publish.name"),
  email = setting("publish.email");
if (!name || !email)
  fail("Set the public commits' identity: git config publish.name <name> and git config publish.email <email>.");
const identity = {
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
};

git(["fetch", "--quiet", "origin", "main"]);
const source = git(["rev-parse", "origin/main"]);
const scratch = mkdtempSync(path.join(tmpdir(), "publish-public-"));
let tree;
try {
  const index = { GIT_INDEX_FILE: path.join(scratch, "index") };
  git(["read-tree", source], index);
  git(["update-index", "--force-remove", "--", ...PRIVATE], index);
  tree = git(["write-tree"], index);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// The licence's copyright line names its holder by design; the rest of the
// licence is checked like any other file.
const LICENSE = "LICENSE";
const word = (term) =>
  new RegExp(`(^|[^\\w])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`, "i");
const named = git(["ls-tree", "-r", "--name-only", tree])
  .split("\n")
  .filter((file) => deny.some((term) => word(term).test(file)));
const grep = spawnSync(
  "git",
  [
    "grep", "--text", "-i", "-w", "-F", "-l",
    ...deny.flatMap((t) => ["-e", t]),
    tree, "--", ".", `:!${LICENSE}`,
  ],
  { encoding: "utf8" },
);
if (grep.status > 1) fail("Could not search the files to publish.");
let licence = "";
try {
  licence = git(["show", `${tree}:${LICENSE}`]);
} catch {
  // No licence to check.
}
const unlicensed = licence
  .split("\n")
  .filter((line) => !/^Copyright \(c\) /i.test(line))
  .join("\n");
const found = [
  ...named,
  ...grep.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(tree.length + 1)),
  ...(deny.some((term) => word(term).test(unlicensed)) ? [LICENSE] : []),
];
// Name the files, never the terms: the list itself is private.
if (found.length)
  fail(`Not published: listed terms appear in ${[...new Set(found)].join(", ")}.`);

let parent;
try {
  git(["fetch", "--quiet", "public", "main"]);
  parent = git(["rev-parse", "FETCH_HEAD"]);
} catch {
  // An empty public repository: this is its first commit. If the fetch failed
  // for another reason, the push below is refused rather than overwriting.
  console.log("No public history found; publishing the first commit.");
}
if (parent && git(["rev-parse", `${parent}^{tree}`]) === tree) {
  console.log("The public copy already matches main.");
  process.exit(0);
}
const message = `Release ${new Date().toLocaleDateString("en-CA")}`;
const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], identity);
git(["push", "--quiet", "public", `${commit}:refs/heads/main`]);
console.log(`Published main ${source.slice(0, 12)} to ${remote.replace(/\/\/[^/@]*@/, "//")}.`);

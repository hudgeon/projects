// Keeps files small enough for coding agents to read and edit whole. Fails
// when work adds a file over 5,000 tokens, counted as bytes/4, or grows one
// that is over, compared with where it left its base (origin/main unless
// named); a file already over may stay the same size or shrink. Checks the
// working tree as `git add --all` would commit it, so it works before a commit
// as well as in CI. Lockfiles, generated or build output and binary assets are
// not checked, nor the security review gate, synced byte for byte from
// elsewhere.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIMIT = 20_000; // bytes: 5,000 tokens at 4 bytes a token
const EXEMPT = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum|[^/]+\.lockb?)$/,
  /^(dist|build|coverage|\.local)\//,
  /\.(min\.js|min\.css|map)$/,
  /^worker-configuration\.d\.ts$/,
  /^\.github\/(scripts\/security-review\.mjs|workflows\/security-review\.yml)$/,
];

const git = (args, env = {}) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const count = (n) => n.toLocaleString("en-US");
const tokens = (bytes) => count(Math.ceil(bytes / 4));

const ref = process.argv[2] || "origin/main";
let base;
try {
  base = git(["merge-base", ref, "HEAD"]).trim();
} catch {
  fail(`No merge base with ${ref}: fetch it, with its history, and try again.`);
}

// Starts from the real index, so only changed files are read again.
const scratch = mkdtempSync(path.join(tmpdir(), "file-sizes-"));
let tree;
try {
  const index = { GIT_INDEX_FILE: path.join(scratch, "index") };
  copyFileSync(
    git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim(),
    index.GIT_INDEX_FILE,
  );
  git(["add", "--all"], index);
  tree = git(["write-tree"], index).trim();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const sizes = (treeish) => {
  const found = new Map();
  for (const entry of git(["ls-tree", "-r", "-l", "-z", treeish]).split("\0")) {
    const match = /^\d+ blob \w+ +(\d+)\t(.+)$/s.exec(entry);
    if (match) found.set(match[2], Number(match[1]));
  }
  return found;
};
const before = sizes(base),
  after = sizes(tree);

// Numstat counts a binary file's lines as "-". A rename leaves the path empty
// and gives the old and new paths as the next two fields.
const fields = git(["diff", "--numstat", "-z", "-M", "--diff-filter=d", base, tree]).split("\0");
const found = [];
for (let i = 0; i < fields.length; i++) {
  const match = /^(-|\d+)\t(?:-|\d+)\t(.*)$/s.exec(fields[i]);
  if (!match) continue;
  const [from, file] = match[2] ? [match[2], match[2]] : [fields[++i], fields[++i]];
  const was = before.get(from),
    size = after.get(file);
  if (match[1] === "-" || EXEMPT.some((pattern) => pattern.test(file))) continue;
  if (size > LIMIT && (was === undefined || size > was))
    found.push(
      `  ${file}: ${tokens(size)} tokens (${count(size)} bytes, ${was === undefined ? "new" : `was ${count(was)}`})`,
    );
}

const at = `${base.slice(0, 12)}, the merge base with ${ref}`;
if (found.length)
  fail(
    [
      `Files over ${tokens(LIMIT)} tokens (bytes/4) that are new or larger than at ${at}:`,
      ...found,
      "",
      "Split them so agents can read and edit each file whole:",
      "- by feature or route, one feature or route to a file;",
      "- helpers stay beside their callers, moving with the code that uses them rather than into a shared utilities file;",
      "- tests go in per-module files next to the code they cover (engine.test.ts beside engine.ts), never one large test file;",
      "- public exports stay stable: the original module re-exports what moved, so importers do not change.",
      "A file already over may stay the same size or shrink. Lockfiles, generated or build output and binary assets are not checked.",
    ].join("\n"),
  );
console.log(`No file over ${tokens(LIMIT)} tokens is new or larger than at ${at}.`);

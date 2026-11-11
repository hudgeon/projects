import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./run-fixtures";
import { sessionMemory } from "./session-memory";

test("what a native session holds outlives its executor, and a compaction forgets it with what that turn sent", async () => {
  const dir = await fixture(), run = "run-1", file = path.join(dir, "runs", `${run}.sessions.json`);
  try {
    const first = sessionMemory(dir, run);
    assert.deepEqual(await first.held("a"), {});
    assert.deepEqual(await first.held(undefined), {}, "a new session holds nothing");
    await first.keep("a", { standing: "s1" });
    await first.keep("a", { view: "v1", instructions: { "AGENTS.md": "h1" } });
    await first.keep("b", { standing: "s1" });
    await first.keep(null, { standing: "never kept" });
    assert.deepEqual(await first.held("a"), { standing: "s1", view: "v1", instructions: { "AGENTS.md": "h1" } });
    assert.equal((await stat(file)).mode & 0o077, 0, "private, beside the journal");
    // The next execution reads what the last one kept.
    const next = sessionMemory(dir, run);
    assert.deepEqual(await next.held("a"), await first.held("a"));
    // The session compacts while its turn runs: nothing that turn sent is held.
    await next.forget("a");
    await next.keep("a", { standing: "s2" });
    assert.deepEqual(await next.held("a"), {});
    assert.deepEqual(await next.held("b"), { standing: "s1" }, "other sessions keep theirs");
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))), ["b"]);
    // Its next turn sends everything again, and that is held.
    await next.keep("a", { standing: "s2" });
    assert.deepEqual(await sessionMemory(dir, run).held("a"), { standing: "s2" });
    // A record that cannot be read means everything is sent once more.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    assert.deepEqual(await sessionMemory(dir, run).held("a"), {});
    await writeFile(file, JSON.stringify({ a: { standing: 7 } }));
    assert.deepEqual(await sessionMemory(dir, run).held("a"), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

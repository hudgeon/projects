import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { registeredUserHashes, connectionEnv } from "./postgres-support-users.mjs";
test("the PostgreSQL reader scopes each customer, requires active membership and returns only unique email hashes", async () => {
  const queries = [];
  const result = await registeredUserHashes(async sql => {
    queries.push(sql);
    return queries.length === 1 ? '["customer-a","customer-b"]' : '["person@example.org"]\n["person@example.org","other@example.org"]\n';
  });
  assert.equal(result.complete, true);
  assert.equal(result.hashes.length, 2);
  assert.ok(result.hashes.includes(createHash("sha256").update("person@example.org").digest("hex")));
  assert.match(queries[1], /SET LOCAL app.current_customer = 'customer-a'/);
  assert.match(queries[1], /WHERE uc.customer_short_name = 'customer-b' AND u.is_active/);
  assert.doesNotMatch(JSON.stringify(result), /person@example.org/);
  await assert.rejects(registeredUserHashes(async sql => sql.includes("ORDER BY id") ? '["customer-a"]' : ""), /Incomplete/);
  await assert.rejects(registeredUserHashes(async sql => sql.includes("ORDER BY id") ? '["customer-a"]' : "[]"), /Empty identity/);
  const env = connectionEnv("postgresql://reader:fake-password@db.example.org/app?sslmode=verify-full", { PATH: "/bin", DATABASE_URL: "must-not-propagate", COLLECTOR_TOKEN: "must-not-propagate" });
  assert.equal(env.PGSSLMODE, "verify-full");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.COLLECTOR_TOKEN, undefined);
  assert.throws(() => connectionEnv("postgresql://reader@db.example.org/app?sslmode=disable"), /Encrypted/);
});
test("the executable uses read-only transactions and tenant context without passing a URL or SQL on the process command line", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "support-pg-")), bin = path.join(directory, "bin"), log = path.join(directory, "queries.txt");
  await mkdir(bin);
  await writeFile(path.join(bin, "psql"), "#!" + process.execPath + "\n" +
    "const fs=require('node:fs');let sql='';process.stdin.on('data',c=>sql+=c);process.stdin.on('end',()=>{fs.appendFileSync(" + JSON.stringify(log) + ",JSON.stringify({sql,args:process.argv.slice(2)})+'\\n');process.stdout.write(sql.includes('ORDER BY id')?'[\"customer-a\"]\\n':'[\"person@example.org\"]\\n')});\n", { mode: 0o700 });
  try {
    const result = await promisify(execFile)(process.execPath, [path.resolve("scripts/postgres-support-users.mjs")], { env: { PATH: bin, DATABASE_URL: "postgresql://reader:fake-password@db.example.org/app?sslmode=require" } });
    assert.equal(JSON.parse(result.stdout).hashes.length, 1);
    const queries = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(queries.length, 2);
    for (const entry of queries) {
      assert.match(entry.sql, /^BEGIN READ ONLY;/);
      assert.match(entry.sql, /ROLLBACK;\n$/);
      assert.doesNotMatch(JSON.stringify(entry.args), /fake-password|SELECT|postgresql/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

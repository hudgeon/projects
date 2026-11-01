// Read-only adapter for an existing users/user_customers/customers registry.
// DATABASE_URL is injected by the operator's scoped credential workflow. Only
// normalized email hashes leave this process; no credential or roster is saved.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const literal = value => {
  if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) throw Error("Invalid customer identity");
  return "'" + value.replaceAll("'", "''") + "'";
};
export async function registeredUserHashes(query) {
  const customers = JSON.parse(await query("SELECT COALESCE(json_agg(id ORDER BY id), '[]'::json) FROM customers;"));
  if (!Array.isArray(customers) || customers.length > 2000) throw Error("Invalid customer inventory");
  const statements = customers.map(customer => {
    const id = literal(customer);
    return "SET LOCAL app.current_customer = " + id + ";\n" +
      "SELECT COALESCE(json_agg(DISTINCT LOWER(BTRIM(u.email))), '[]'::json)\n" +
      "FROM users u JOIN user_customers uc ON uc.user_id = u.id\n" +
      "JOIN customers c ON c.id = uc.customer_short_name\n" +
      "WHERE uc.customer_short_name = " + id + " AND u.is_active;";
  });
  const output = statements.length ? await query(statements.join("\n")) : "";
  const rows = output.trim() ? output.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
  if (rows.length !== customers.length) throw Error("Incomplete user directory");
  const hashes = new Set();
  for (const emails of rows) {
    if (!Array.isArray(emails)) throw Error("Invalid user directory");
    for (const email of emails) {
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error("Invalid registered email");
      hashes.add(createHash("sha256").update(email.trim().toLowerCase()).digest("hex"));
      if (hashes.size > 10_000) throw Error("User directory too large");
    }
  }
  // The identity tables in a regional mirror can exist but be empty. That
  // cannot establish a healthy identity source for a populated installation.
  if (customers.length && !hashes.size) throw Error("Empty identity source");
  return { complete: true, observedAt: Date.now(), hashes: [...hashes].sort() };
}
export function connectionEnv(connection, source = process.env) {
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw Error("Invalid database connection");
  const ssl = url.searchParams.get("sslmode") ?? "verify-full";
  if (!["require", "verify-ca", "verify-full"].includes(ssl)) throw Error("Encrypted database connection required");
  return {
    PATH: source.PATH, HOME: source.HOME, LANG: source.LANG,
    PGHOST: url.hostname, PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: ssl, PGCONNECT_TIMEOUT: "5",
    ...(url.searchParams.has("sslrootcert") ? { PGSSLROOTCERT: url.searchParams.get("sslrootcert") } : {}),
  };
}
async function main() {
  const env = connectionEnv(process.env.DATABASE_URL ?? "");
  const query = sql => new Promise((resolve, reject) => {
    const child = execFile("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { env, timeout: 15_000, maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(Error("User directory query failed")) : resolve(stdout));
    child.stdin.on("error", () => reject(Error("User directory input failed")));
    child.stdin.end("BEGIN READ ONLY;\nSET LOCAL statement_timeout = '10s';\nSET LOCAL standard_conforming_strings = on;\n" + sql + "\nROLLBACK;\n");
  });
  process.stdout.write(JSON.stringify(await registeredUserHashes(query)) + "\n");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => { console.error("Registered-user directory unavailable"); process.exitCode = 1; });

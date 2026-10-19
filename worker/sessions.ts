// Email-code sign-in storage: one-use codes with attempt limits, the sessions
// they open, and the portfolio's rate limits. Hashes only; the Worker checks
// codes and cookies against these (worker/auth.ts).
import { digest, equal, SESSION_SECONDS } from "./auth";

export class Sessions {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, sent INTEGER NOT NULL, attempts INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)",
    );
  }
  rate(key: string, max: number, window: number) {
    const now = Date.now();
    this.storage.sql.exec("DELETE FROM limits WHERE expires <= ?", now);
    const row = this.storage.sql
      .exec<{ count: number }>(
        "INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
        key,
        now + window,
      )
      .one();
    return row.count <= max;
  }
  // One code per address a minute; a new one replaces the last.
  issue(email: string, salt: string, hash: string) {
    const now = Date.now();
    return (
      this.storage.sql
        .exec(
          "INSERT INTO codes(email,salt,hash,expires,sent,attempts) VALUES(?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,expires=excluded.expires,sent=excluded.sent,attempts=0 WHERE codes.sent <= ? RETURNING email",
          email,
          salt,
          hash,
          now + 600_000,
          now,
          now - 60_000,
        )
        .toArray().length === 1
    );
  }
  cancel(email: string, salt: string) {
    this.storage.sql.exec("DELETE FROM codes WHERE email=? AND salt=?", email, salt);
  }
  // Consumes the code and opens the session whose cookie hashes to `hash`.
  verify(email: string, code: string, hash: string) {
    return this.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.storage.sql
        .exec<{ salt: string; hash: string; attempts: number; expires: number }>(
          "SELECT * FROM codes WHERE email=?",
          email,
        )
        .toArray()[0];
      if (!row || row.expires <= now || row.attempts >= 5) return false;
      this.storage.sql.exec("UPDATE codes SET attempts=attempts+1 WHERE email=?", email);
      if (!equal(row.hash, digest(`${row.salt}:${code}`))) return false;
      this.storage.sql.exec("DELETE FROM codes WHERE email=?", email);
      this.storage.sql.exec("DELETE FROM sessions WHERE expires<=?", now);
      this.storage.sql.exec(
        "INSERT INTO sessions(hash,email,expires) VALUES(?,?,?)",
        hash,
        email,
        now + SESSION_SECONDS * 1000,
      );
      return true;
    });
  }
  // Whose sign-in a cookie hash is, while it lasts.
  find(hash: string): string | null {
    return (
      this.storage.sql
        .exec<{ email: string }>(
          "SELECT email FROM sessions WHERE hash=? AND expires>?",
          hash,
          Date.now(),
        )
        .toArray()[0]?.email ?? null
    );
  }
  revoke(hash: string) {
    this.storage.sql.exec("DELETE FROM sessions WHERE hash=?", hash);
  }
}

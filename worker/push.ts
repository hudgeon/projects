// Web Push (RFC 8030) signed with VAPID (RFC 8292) and sent without a payload.
// The device then asks Projects what to show, with the owner's own sign-in, so no
// conversation title, text or ID crosses Apple's, Google's or Mozilla's servers.
import { telemetry } from "../src/telemetry";
const PUSH_HOSTS = [
  "web.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
];
// The Worker posts to stored endpoints, so only the browsers' push services
// qualify; anything else could turn a subscription into a request forger.
export function pushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      value.length <= 1000 &&
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      (PUSH_HOSTS.includes(url.hostname) ||
        /^wns2-[a-z0-9]+\.notify\.windows\.com$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}
type PushKey = { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
function pushKey(secret: string): PushKey {
  const key = JSON.parse(secret) as PushKey;
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y || !key.d)
    throw Error("The push key is not a P-256 private key.");
  return key;
}
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const bytes = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
// Browsers subscribe with the uncompressed public point.
export function vapidPublicKey(secret: string) {
  const key = pushKey(secret);
  return base64url(new Uint8Array([4, ...bytes(key.x), ...bytes(key.y)]));
}
// The subject is this site's address, the contact push services expect.
export async function vapidAuthorization(
  endpoint: string,
  secret: string,
  subject: string,
  now = Date.now(),
) {
  const signer = await crypto.subtle.importKey(
    "jwk",
    { ...pushKey(secret), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const part = (value: object) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signer,
    new TextEncoder().encode(unsigned),
  );
  return `vapid t=${unsigned}.${base64url(new Uint8Array(signature))}, k=${vapidPublicKey(secret)}`;
}
// "gone" means the browser dropped this subscription; forget the device.
export async function sendPush(
  endpoint: string,
  secret: string,
  subject: string,
  fetcher: typeof fetch = fetch,
): Promise<"sent" | "gone" | "failed"> {
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(endpoint, secret, subject),
        TTL: "86400",
        Urgency: "high",
      },
      body: "",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
type Notice = { run: string | null; title: string; body: string };
export type PushEvent = {
  id: string;
  title: string;
  body: string;
  at: number;
  url: string;
};
type PushEnv = { VAPID_PRIVATE_KEY?: string; SITE_URL: string };
// Each person's devices and the notices they fetch. A device belongs to the
// sign-in that subscribed it; a notice to the conversation's owner. Rows from
// before people had profiles name no one and are the deployment owner's.
export class PushDevices {
  constructor(
    private storage: DurableObjectStorage,
    private env: PushEnv,
    private deploymentOwner: string,
    private waitUntil: (work: Promise<unknown>) => void,
  ) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, created INTEGER NOT NULL, used INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS push_events (id TEXT PRIMARY KEY, run TEXT, title TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    for (const table of ["push_devices", "push_events"])
      if (
        !storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray()
          .some((c) => c.name === "email")
      )
        storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN email TEXT`);
  }
  // A device's push URL is a capability: it stays here, never logged or returned.
  // Opening Projects refreshes a device and keeps it with the sign-in that
  // opened it; only a new one gets the test notice, and only that device.
  subscribe(endpoint: string, email: string) {
    const now = Date.now();
    const known =
      this.storage.sql
        .exec("SELECT 1 FROM push_devices WHERE endpoint=?", endpoint)
        .toArray().length > 0;
    this.storage.sql.exec(
      "INSERT INTO push_devices(endpoint,created,used,email) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET used=excluded.used,email=excluded.email",
      endpoint,
      now,
      now,
      email,
    );
    // Ten devices a person, the most recently opened.
    this.storage.sql.exec(
      "DELETE FROM push_devices WHERE COALESCE(email,?)=? AND endpoint NOT IN (SELECT endpoint FROM push_devices WHERE COALESCE(email,?)=? ORDER BY used DESC LIMIT 10)",
      this.deploymentOwner,
      email,
      this.deploymentOwner,
      email,
    );
    if (!known)
      this.notify(
        email,
        {
          run: null,
          title: "Notifications are on",
          body: "Projects will tell you here when a conversation is ready or needs you.",
        },
        [endpoint],
      );
  }
  // A person forgets only their own device.
  unsubscribe(endpoint: string, email: string) {
    this.storage.sql.exec(
      "DELETE FROM push_devices WHERE endpoint=? AND COALESCE(email,?)=?",
      endpoint,
      this.deploymentOwner,
      email,
    );
  }
  // What a woken device shows: its person's notices from the last day, newest first.
  events(email: string): PushEvent[] {
    return this.storage.sql
      .exec<{
        id: string;
        run: string | null;
        title: string;
        body: string;
        at: number;
      }>(
        "SELECT id,run,title,body,at FROM push_events WHERE COALESCE(email,?)=? AND at>? ORDER BY at DESC LIMIT 5",
        this.deploymentOwner,
        email,
        Date.now() - 86400_000,
      )
      .toArray()
      .map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        at: e.at,
        url: e.run ? `/?run=${e.run}` : "/",
      }));
  }
  // Pushes carry nothing; each of the person's devices fetches events() with
  // its own sign-in.
  notify(email: string, event: Notice, endpoints?: string[]) {
    const at = Date.now();
    this.storage.sql.exec(
      "INSERT INTO push_events(id,run,title,body,at,email) VALUES(?,?,?,?,?,?)",
      crypto.randomUUID(),
      event.run,
      event.title,
      event.body,
      at,
      email,
    );
    this.storage.sql.exec(
      "DELETE FROM push_events WHERE at<? OR (COALESCE(email,?)=? AND id NOT IN (SELECT id FROM push_events WHERE COALESCE(email,?)=? ORDER BY at DESC LIMIT 50))",
      at - 86400_000,
      this.deploymentOwner,
      email,
      this.deploymentOwner,
      email,
    );
    const secret = this.env.VAPID_PRIVATE_KEY;
    const targets =
      endpoints ??
      this.storage.sql
        .exec<{ endpoint: string }>(
          "SELECT endpoint FROM push_devices WHERE COALESCE(email,?)=?",
          this.deploymentOwner,
          email,
        )
        .toArray()
        .map((d) => d.endpoint);
    if (!secret || !targets.length) return;
    this.waitUntil(
      Promise.all(
        targets.map(async (endpoint) => {
          const result = await sendPush(endpoint, secret, this.env.SITE_URL);
          if (result === "gone")
            this.storage.sql.exec(
              "DELETE FROM push_devices WHERE endpoint=?",
              endpoint,
            );
          telemetry(
            "worker",
            "notification_sent",
            result === "failed"
              ? { outcome: "failed", reason: "http_error" }
              : { outcome: result === "sent" ? "accepted" : "rejected" },
            result === "failed" ? "warn" : "info",
          );
        }),
      ),
    );
  }
}

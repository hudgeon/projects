import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import {
  gmailUrl,
  pendingInboxActionSchema,
  sameAccount,
  type Inbox,
  type InboxActionReport,
  type PendingInboxAction,
} from "../src/inbox-model";
import { emailLinks, type Issue } from "../src/work-model";
import { userGh } from "./close";
import { unsubscribeOptions, type Gws } from "./inbox";

// RFC 8058 one-click: a fixed POST to the list's own HTTPS endpoint. The link
// comes from an untrusted sender, so it must name a public host, carries no
// cookies or credentials, and redirects are not followed.
export type OneClick = (url: string) => Promise<boolean>;
// Separate lists: BlockList checks IPv4 addresses against IPv6 rules in their
// mapped form, so one list would let ::ffff:0:0/96 block every IPv4 host.
const reserved4 = new BlockList(),
  reserved6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  reserved4.addSubnet(network, prefix, "ipv4");
// Unspecified/loopback, every IPv4-mapped or NAT64 form, unique-local,
// link-local and multicast.
for (const [network, prefix] of [
  ["::", 127],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  reserved6.addSubnet(network, prefix, "ipv6");
export function privateAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? reserved4.check(address, "ipv4")
    : family === 6
      ? reserved6.check(address, "ipv6")
      : true;
}
export function publicHttps(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !url.hostname.includes(".") ||
    /(^|\.)(localhost|local|lan|internal|home|arpa|test)$/i.test(url.hostname)
    ? null
    : url;
}
type Resolve = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;
// The connection's own DNS lookup is the check: every answer must be public,
// so a later answer cannot point the request at a private address.
export function publicLookup(resolve: Resolve = lookup as unknown as Resolve) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (
      error: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) =>
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
        return callback(Error("Unsubscribe host is not public."), []);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
}
export const oneClick: OneClick = (raw) =>
  new Promise((resolve) => {
    const url = publicHttps(raw);
    if (!url) return resolve(false);
    const body = "List-Unsubscribe=One-Click";
    const post = request(
      url,
      {
        method: "POST",
        lookup: publicLookup() as never,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15_000,
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    post.on("timeout", () => post.destroy(Error("Unsubscribe timed out.")));
    post.on("error", () => resolve(false));
    post.end(body);
  });
const messageHeaders = z.object({
  payload: z.object({
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
  }),
});
// Each request names only a thread this scan observed in the owner's own inbox.
// Unsubscribe reads the list headers fresh from Gmail, never from the request.
export async function applyInboxAction(
  action: PendingInboxAction,
  inbox: Inbox,
  run: Gws,
  click: OneClick = oneClick,
): Promise<InboxActionReport> {
  const done = (message: string | null): InboxActionReport => ({
    ...action,
    state: "done",
    message,
  });
  const failed = (message: string): InboxActionReport => ({
    ...action,
    state: "failed",
    message,
  });
  const thread = inbox.threads.find((t) => t.id === action.threadId);
  // A partial read that missed the thread cannot say where it is.
  if (!thread && inbox.state !== "ok")
    return {
      ...action,
      state: "queued",
      message: "Gmail could not be read in full; retrying.",
    };
  const archive = async () => {
    if (!thread?.inInbox) return;
    await run([
      "gmail",
      "users",
      "threads",
      "modify",
      "--params",
      JSON.stringify({ userId: "me", id: action.threadId }),
      "--json",
      JSON.stringify({ removeLabelIds: ["INBOX"] }),
    ]);
  };
  if (action.action === "archive") {
    if (!thread?.inInbox) return done("Already out of the inbox.");
    // Someone wrote after the request: keep the new email in front of the owner.
    if (thread.updatedAt > action.requestedAt && !thread.lastSentByMe)
      return failed("A newer email arrived, so it stays in the inbox.");
    await archive();
    return done(null);
  }
  if (!thread) return failed("This email is no longer in the inbox.");
  const raw = await run([
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({
      userId: "me",
      id: thread.latestMessageId,
      format: "metadata",
      metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post"],
      fields: "payload(headers)",
    }),
  ]);
  const headers = Object.fromEntries(
    (messageHeaders.parse(JSON.parse(raw)).payload.headers ?? []).map((h) => [
      h.name.toLowerCase(),
      h.value,
    ]),
  );
  const options = unsubscribeOptions(headers);
  if (!options?.oneClick || !options.url)
    return failed("This list has no one-click unsubscribe.");
  if (!(await click(options.url)))
    return failed("The list did not accept the one-click unsubscribe.");
  await archive();
  return done("Unsubscribed and archived.");
}

// Store a source reference on the canonical work issue. Always read the current
// body; retries discover the same exact thread instead of appending duplicates.
export async function linkInboxThread(
  action: PendingInboxAction,
  inbox: Inbox,
  issues: Issue[] | null,
  repo: string | undefined,
  gh: (args: string[]) => Promise<string> = userGh,
): Promise<InboxActionReport> {
  const report = (
    state: InboxActionReport["state"],
    message: string,
  ): InboxActionReport => ({ ...action, state, message });
  const thread = inbox.threads.find((t) => t.id === action.threadId);
  if (!issues || !repo || !thread)
    return report("queued", "Inbox or work issues unavailable; retrying.");
  if (!issues.some((i) => i.number === action.issue && i.open))
    return report("failed", "This open work item is no longer available.");
  const fresh = z
    .object({
      body: z.string(),
      state: z.string(),
      labels: z.array(z.object({ name: z.string() })),
    })
    .parse(
      JSON.parse(
        await gh([
          "issue",
          "view",
          String(action.issue),
          "--repo",
          repo,
          "--json",
          "body,state,labels",
        ]),
      ),
    );
  if (fresh.state !== "OPEN" || !fresh.labels.some((l) => l.name === "work"))
    return report("failed", "This issue is no longer open work.");
  if (emailLinks(fresh.body).some((l) => l.threadId === thread.id))
    return report("done", "Linked to bigger work.");
  if (emailLinks(fresh.body).length >= 50)
    return report(
      "failed",
      "This work item already has the maximum email links.",
    );
  // Do not copy sender content or claim any message has been reviewed.
  const line = `- [Email conversation](${gmailUrl(inbox.account, thread.id)})`;
  const heading = /^## Email threads[^\S\r\n]*(?:\r?\n|$)/m;
  const body = heading.test(fresh.body)
    ? fresh.body.replace(heading, `## Email threads\n${line}\n`)
    : `${fresh.body.trimEnd()}\n\n## Email threads\n${line}\n`;
  await gh([
    "issue",
    "edit",
    String(action.issue),
    "--repo",
    repo,
    "--body",
    body,
  ]);
  const saved = z
    .object({ body: z.string() })
    .parse(
      JSON.parse(
        await gh([
          "issue",
          "view",
          String(action.issue),
          "--repo",
          repo,
          "--json",
          "body",
        ]),
      ),
    );
  if (!emailLinks(saved.body).some((l) => l.threadId === thread.id))
    return report(
      "queued",
      "Link not confirmed yet; checking again next scan.",
    );
  return report("done", "Linked to bigger work.");
}

// The machine on duty's scheduled step, beside Mark done: fetch queued
// requests, apply each in the inbox it names with that account's own sign-in,
// report back. Without a fresh read of that inbox a request stays queued; a
// request from before accounts were recorded is the first connected inbox's.
export async function applyInboxActions(
  endpoint: string,
  headers: Record<string, string>,
  inboxes: Inbox[] | undefined,
  login: (account: string) => Gws | null,
  click: OneClick = oneClick,
  work?: { issues: Issue[] | null; repo?: string },
) {
  const url = new URL("/api/inbox/actions", endpoint);
  const call = async (init?: RequestInit) => {
    const r = await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw Error(`Inbox requests failed (HTTP ${r.status})`);
    return r.json();
  };
  const { actions } = z
    .object({ actions: z.array(pendingInboxActionSchema).max(500) })
    .parse(await call());
  for (const action of actions.slice(0, 20)) {
    let report: InboxActionReport;
    const inbox = action.account
      ? inboxes?.find((i) => sameAccount(i.account, action.account!))
      : inboxes?.[0];
    const run = inbox && login(inbox.account);
    try {
      if (!inbox || !run) throw Error("Not connected here");
      if (inbox.state === "unavailable") throw Error("No inbox read");
      report =
        action.action === "link"
          ? await linkInboxThread(
              action,
              inbox,
              work?.issues ?? null,
              work?.repo,
            )
          : await applyInboxAction(action, inbox, run, click);
    } catch {
      report = {
        ...action,
        state: "queued",
        message:
          inbox && run
            ? "The source was unavailable from this machine; retrying."
            : "This mailbox is not connected on the machine on duty; retrying.",
      };
    }
    await call({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    console.log(
      JSON.stringify({
        event: "inbox_action_reported",
        action: report.action,
        state: report.state,
      }),
    );
  }
}

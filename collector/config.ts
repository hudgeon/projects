// One config per machine, for its collector, chat watcher and runner: what it
// observes, where its tokens are, and how the Gmail accounts its inboxes and
// the people whose Slack it reads are signed in.
import path from "node:path";
import { z } from "zod";
import { machineIdSchema } from "../src/telemetry";
import { sameAccount } from "../src/inbox-model";

const absolute = z.string().refine(path.isAbsolute);
// A person's Gmail account this machine reads, and how: with the gws sign-in
// that person made once on this machine (GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<dir>
// gws auth login), or, with no directory, by delegation: the Workspace service
// account in the machine's Doppler config stands in for them
// (collector/delegation.ts), so they never sign in here.
export const inboxLoginSchema = z
  .object({ account: z.email(), configDir: absolute.optional() })
  .strict();
// A login as the collector and runner use it: the entry, marked when it is
// delegated. The owner's plain account, the machine's default sign-in, is
// neither signed in elsewhere nor delegated.
export type InboxLogin = z.infer<typeof inboxLoginSchema> & { delegated?: true };
export const configSchema = z.object({
  // This machine's id, as the site registered it.
  host: machineIdSchema,
  root: absolute,
  home: absolute,
  endpoint: z.url().optional(),
  // An owner-only file holding this machine's collector token. Without one,
  // the token comes from COLLECTOR_TOKEN in the environment, which the
  // background service fills from the Doppler config below.
  collectorTokenFile: absolute.optional(),
  // A Doppler config holding this machine's secrets: its collector and runner
  // tokens and, optionally, a read-only GitHub App. They are read with a
  // read-only service token kept beside this config.
  doppler: z
    .object({
      project: z.string().regex(/^\w[\w.-]*$/),
      config: z.string().regex(/^\w[\w.-]*$/),
    })
    .strict()
    .optional(),
  // The owner's Gmail account, read with the machine's own gws sign-in.
  inboxAccount: z.email().optional(),
  // Other people's: each with the gws sign-in they made on this machine, or
  // by delegation when it names no directory.
  inboxAccounts: z
    .array(inboxLoginSchema)
    .max(10)
    .refine(
      (list) =>
        new Set(list.map((login) => login.account.toLowerCase())).size ===
        list.length,
      "Each inbox account is listed once.",
    )
    .default([]),
  // Whose Slack this machine's chat watcher reads (collector/chats.ts), each
  // with their own user token from SLACK_USER_TOKENS in the Doppler config
  // above, and the app's SLACK_APP_TOKEN for Socket Mode.
  slack: z
    .array(z.email())
    .max(10)
    .refine(
      (list) => new Set(list.map((email) => email.toLowerCase())).size === list.length,
      "Each person is listed once.",
    )
    .default([]),
  // Whose Microsoft Teams this machine's chat watcher reads, each in a Chrome
  // profile on this machine they signed in to once (collector/teams-chrome.ts):
  // one profile per Teams organisation, so a person may have several. Only the
  // list is read; no chat is opened, so no read receipt is sent.
  teams: z
    .array(z.object({ account: z.email(), profileDir: absolute }).strict())
    .max(10)
    // A profile folder once, however its case is written (macOS ignores it).
    .refine((list) => new Set(list.map((t) => t.profileDir.toLowerCase())).size === list.length, "Each profile is listed once.")
    .default([]),
  // Work items are the issues labelled `work` in this repository; without it
  // the overview has no work items or Mark done.
  workRepo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  // The shared configuration repository (global agent rules, skills, hooks
  // and repository templates), which the upkeep lane's changes go to when it
  // is also registered as a project on this machine.
  configRepo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  // The native coding apps signed in on this machine. Conversations use only
  // these.
  agents: z
    .array(z.enum(["codex", "claude"]))
    .min(1)
    .default(["codex", "claude"]),
  projects: z
    .record(
      z.string(),
      z.object({ name: z.string(), plan: z.string().optional() }),
    )
    .default({}),
  exclude: z.array(z.string()).default(["zarchive", "_archive"]),
});
export type Config = z.infer<typeof configSchema>;
// Every inbox this machine reads, the owner's first, each with its sign-in or
// marked delegated. An entry naming the owner's account stands in for the
// plain one, so the owner's own inbox can be delegated too.
export function inboxLogins(config: {
  inboxAccount?: string;
  inboxAccounts?: InboxLogin[];
}): InboxLogin[] {
  const listed = (config.inboxAccounts ?? []).map((login) =>
    login.configDir ? login : { ...login, delegated: true as const },
  );
  const owner = config.inboxAccount;
  return owner && !listed.some((login) => sameAccount(login.account, owner))
    ? [{ account: owner }, ...listed]
    : listed;
}

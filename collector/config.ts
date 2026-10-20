// One config per machine, for its collector and its runner: what it observes,
// where its tokens are, and the Gmail sign-ins its inboxes are read with.
import path from "node:path";
import { z } from "zod";
import { machineIdSchema } from "../src/telemetry";
import { sameAccount } from "../src/inbox-model";

const absolute = z.string().refine(path.isAbsolute);
// A person's Gmail account this machine reads, with the gws sign-in that
// reads it: the config directory that person signed in to once on this
// machine (GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<dir> gws auth login). Without a
// directory, gws's default sign-in, which is the machine owner's.
export const inboxLoginSchema = z
  .object({ account: z.email(), configDir: absolute.optional() })
  .strict();
export type InboxLogin = z.infer<typeof inboxLoginSchema>;
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
  // Other people's, each with the gws sign-in they made on this machine.
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
  // Work items are the issues labelled `work` in this repository; without it
  // the overview has no work items or Mark done.
  workRepo: z
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
// Every inbox this machine reads, the owner's first, each with its sign-in.
// An entry naming the owner's account stands in for the plain one.
export function inboxLogins(config: {
  inboxAccount?: string;
  inboxAccounts?: InboxLogin[];
}): InboxLogin[] {
  const listed = config.inboxAccounts ?? [];
  const owner = config.inboxAccount;
  return owner && !listed.some((login) => sameAccount(login.account, owner))
    ? [{ account: owner }, ...listed]
    : listed;
}

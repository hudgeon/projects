# Gmail delegation for people's inboxes

A Google Workspace service account with domain-wide delegation stands in for
each person whose inbox a machine reads, so connecting someone is adding
their address to that machine: nobody signs in anywhere, and a new hire's
inbox is one installer flag. This is the one-time setup, done by a Workspace
super administrator; [Self-hosting](self-host.md) says where it fits.

The key can read and change every mailbox in your Workspace domain for the
scopes you grant it, so it lives only in the machine's Doppler config, is
read into memory for one hour's token at a time (`collector/delegation.ts`),
and never enters `machine.json`, a snapshot, a log or a prompt. A token is
minted only for an account `machine.json` lists as delegated, at the scope
the use needs (reads with `gmail.readonly`; inbox actions and a
conversation's email lane with `gmail.modify`), and the Gmail profile it
reaches must be that address, so a mismatch or a refusal shows as that inbox
being unavailable, never as another person's mail.

1. In the Google Cloud project your `gws` OAuth client lives in (the Gmail API
   is enabled there), open **IAM & Admin → Service Accounts → Create service
   account**, name it (say `projects-inboxes`), grant it no roles, and note
   its **Unique ID**: the numeric client ID on its details page.
2. **Approval point: a key.** On that account, **Keys → Add key → Create new
   key → JSON**. The download is the only copy of a credential that reaches
   every mailbox; keep it off shared disks and delete it at step 4.
3. **Approval point: delegation.** In the Admin console, **Security → Access
   and data control → API controls → Manage Domain Wide Delegation → Add
   new**: the Unique ID as the client ID, and exactly these two scopes:

   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify
   ```

   They are what the collector reads with and what inbox actions and the
   email lane change with (`DELEGATION_SCOPES` in `collector/delegation.ts`);
   Projects asks for no other. Delegation covers the accounts of your
   Workspace domain only: an address outside it reads as unavailable.
4. **Approval point: the secret.** With your own Doppler login, store the
   downloaded file whole as `GMAIL_DELEGATION_KEY` in the machine's Doppler
   config (the `project` and `config` in its `machine.json`), then delete the
   download:

   ```bash
   doppler secrets set GMAIL_DELEGATION_KEY --project <project> --config <config> < ~/Downloads/<key>.json && rm ~/Downloads/<key>.json
   ```

   The machine's read-only service token already reads that config; the
   collector and runner ask for the key by name and keep nothing of it.
5. Connect each person by address. The installer lists it under
   `inboxAccounts` with no directory, leaves the rest of `machine.json` as it
   is and restarts the runner (the collector reads the file at its next scan):

   ```bash
   node scripts/install-machine.mjs --add-inbox ada@example.com
   ```

   Within two scans the Inbox tab's Everyone list shows their count. An inbox
   the delegation cannot reach stays unavailable, and the collector's log
   says why (`inbox_delegation_failed` with Google's error code, no address).
   That person's conversations draft in their mailbox from their next turn.

To retire the delegation, delete the key in Google Cloud and the secret in
Doppler, or remove the client ID from the Admin console: every delegated
inbox reads as unavailable from the next scan, and conversations are told no
mailbox could be reached. To disconnect one person, run the installer with
`--remove-inbox` for their address.

Limits: a conversation turn's token lasts an hour from the turn's start
(Google's maximum for a signed grant), so a long helper turn that first
touches email after that gets an authentication error from `gws` and reports
it; the email lane is short. Each delegated inbox costs one key read and one
token request per scan, and each turn of its owner's conversations one more.

Before an address exists, reserve a name on each machine that can be on duty:

```bash
node scripts/install-machine.mjs --add-inbox-placeholder Ada
```

Everyone shows that name, 0, and when the machine on duty last checked its
configuration. This is not a Gmail read and gives no sign-in or mailbox access.
Once the address is ready, replace the placeholder explicitly:

```bash
node scripts/install-machine.mjs --remove-inbox-placeholder Ada --add-inbox ada@example.com
```

A connected inbox that fails to read still shows its coverage warning.

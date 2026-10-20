# Microsoft Teams in Projects

For a person who has a Teams account in a customer's Microsoft 365 tenant but
no API access to it, the chat watcher on the always-on machine
(`collector/teams-chrome.ts`) reads their Teams the way they would: in a
browser. It keeps the Teams web app open in a dedicated Chrome profile that the
person signed in to once, and every minute reads the chat list — the names,
unread marks, who sent the latest message and its one-line preview. A 1:1 or
group chat, or a channel that @mentions the person, joins their Today; other
unread channels wait in their Inbox. [Self-hosting](self-host.md) says where
this fits.

The reader only ever reads the chat list. **It never opens a chat**, so it
never sends a read receipt and never marks anything read, and it never posts,
replies or types to anyone. The Teams window on the machine stays on the chat
list.

What leaves Teams is each item's place (the chat or channel name, and the
customer's name for a shared channel) and the list preview of its latest
message, posted to the Worker with the machine's collector token and served
only to its owner (`worker/chats.ts`). The preview is all Teams shows without
opening the chat; "Open in Teams" takes the person to the full thread
themselves. Nothing reaches the overview, snapshots, telemetry or prompts.

Before this is turned on, confirm that reading the customer's Teams this way,
and sending message previews to Projects, is allowed under the agreement with
that customer. This route uses the person's own signed-in account; it does not
ask the customer's administrator for anything. If the customer would instead
approve a read-only app in their tenant, that is steadier than any screen —
raise it with them.

## Setup

1. On the always-on machine, pick a folder for the Teams Chrome profile, yours
   alone, for example `~/Library/Projects-Teams`. Chrome creates it on first
   run; if you make it first, `chmod 700` it.
2. Sign in to Teams in that profile, once:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="$HOME/Library/Projects-Teams" https://teams.microsoft.com/
   ```

   Complete the customer's sign-in and MFA, and leave it on the chat list.
   Close the window when done; the watcher reopens the profile headlessly in
   the background. (The sign-in is a step only you can do: the watcher never
   signs in or types.)
3. Connect it:

   ```bash
   node scripts/install-machine.mjs --teams you@customer.example=$HOME/Library/Projects-Teams
   ```

   It starts the chat watcher as its own background service (shared with Slack
   if that is also connected) and prints `Chat watcher: running`. Its log, with
   counts and never names or text, is `~/.local/share/project-overview/chats.log`.

Within a minute Projects' Inbox shows a Teams filter and "Teams checked just
now"; a chat or a mention appears in its person's Today. If the customer later
forces a fresh sign-in, the read shows as "Teams needs you to sign in again"
for that person alone — repeat step 2. `--no-teams` stops the watcher;
`--teams` with a different profile moves it.

## Limits

- The watcher reads what the Teams web list shows: one-line previews, not full
  message bodies. It cannot read a tenant that blocks the Teams web app in a
  browser (some Conditional Access policies force the desktop app or a managed
  device); if the list never loads, a read-only app in the customer's tenant is
  the alternative.
- Teams web markup changes over time, so the list reader is confirmed against
  the real page on first sign-in and tuned if a release moves things.
- What waits is kept in an owner-only `chats-teams.json` beside `machine.json`,
  so a restart loses nothing; messages from before the watcher first ran are
  not read.

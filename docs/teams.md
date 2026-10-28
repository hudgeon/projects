# Microsoft Teams in Projects

For a person who has a Teams account in a customer's Microsoft 365 tenant but
no API access to it, the chat watcher on the always-on machine
(`collector/teams-chrome.ts`) reads their Teams the way they would: in a
browser. It keeps the Teams web app open in a dedicated Chrome profile that the
person signed in to once, and every minute reads the list of chats and
channels — the names, unread marks, who sent a chat's latest message and its
one-line preview. A 1:1 or group chat joins their Today until they reply in
it; so does an unread channel that @mentions them or that they made a
favourite in Teams. Other unread channels wait in their Inbox for a day. A
chat already read when the reader first sees it is history: it joins only
when a new message arrives. If the person's Teams list hides message previews
(Settings, Chats and channels), nothing says who wrote last, so a chat joins
their Today only while it is unread, and without its text.
[Self-hosting](self-host.md) says where this fits.

The reader only ever reads the list. **It never opens a chat or channel**, so
it never sends a read receipt and never marks anything read, and it never
posts, replies or types to anyone. Teams reopens a conversation whenever it
loads, so within seconds of starting the reader moves its window to the Drafts
view, which opens none. It clicks nothing else but a folded Chats heading, and
Teams' Chat button when the window was left on another view, such as Settings.

What leaves Teams is each item's place (the chat or channel name, and the
customer's name for a shared channel) and, for a chat, the list preview of its
latest message — a channel shows none in the list — posted to the Worker with the machine's collector token and served
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
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="$HOME/Library/Projects-Teams" https://teams.cloud.microsoft/
   ```

   Complete the customer's sign-in and MFA, then quit that Chrome. The watcher
   opens the profile in a Chrome window of its own and keeps it open; leave
   that window be. It can sit behind others and keeps reading while covered or
   while the displays sleep, but not minimised. The sign-in is a step only you
   can do: the watcher never signs in or types.
3. Connect it:

   ```bash
   node scripts/install-machine.mjs --teams you@example.com=$HOME/Library/Projects-Teams
   ```

   The address is the one you sign in to Projects with, not your account in
   the customer's tenant: it says whose Today the items join. It starts the chat watcher as its own background service (shared with Slack
   if that is also connected) and prints `Chat watcher: running`. Its log, with
   counts and never names or text, is `~/.local/share/project-overview/chats.log`.

Within a minute Projects' Inbox shows a Teams filter and "Teams checked just
now"; a chat or a mention appears in its person's Today. If the customer later
forces a fresh sign-in, the read shows as "Teams needs you to sign in again"
for that person alone — repeat step 2. `--no-teams` stops the watcher.

## More than one organisation

Teams shows one organisation at a time, so each organisation a person reads —
their own company's beside a customer's, say — has a profile of its own. Sign
in to the other organisation in a new profile folder (step 2 with, for
example, `~/Library/Projects-Teams-2`), check its profile menu offers to switch
to the first organisation rather than this one, and add it:

```bash
node scripts/install-machine.mjs --teams you@example.com=$HOME/Library/Projects-Teams-2
```

The watcher keeps a Chrome open for each profile and posts one read with
both. After a watcher restart it reconnects to a profile's existing browser,
instead of opening another tab. A saved debugging port counts only when its
browser responds with the same instance id; a missing chat list keeps coverage
unavailable until the list can be read. If one profile needs its sign-in, the
read says so; if one cannot be read, it shows as incomplete.
`--remove-teams you@example.com=<folder>` stops
reading one profile, and `--remove-teams you@example.com` all of that
person's.

## Limits

- The watcher reads what the Teams web list shows: one-line previews, not full
  message bodies. It cannot read a tenant that blocks the Teams web app in a
  browser (some Conditional Access policies force the desktop app or a managed
  device); if the list never loads, a read-only app in the customer's tenant is
  the alternative.
- Teams web markup changes over time. The reader knows the list by its tree of
  folders and conversations, each with its Teams thread id, and an unread one
  by its bold title; if a release moves things, it is tuned against the real
  page.
- What waits is kept in an owner-only `chats-teams-….json` per profile beside
  `machine.json`, so a restart loses nothing; messages from before the watcher
  first ran are not read.

## Coverage in Today

Today shows failed or stale chat reads even when there are no message items.
A successful collector upload does not mean Teams was read successfully. The
Worker retains the last fully successful read time and the start of the
current failure interval; repeated signed-out uploads do not reset them. On
upgrade, historical successful read times are unknown until a healthy read is
observed. Sign in again in the named machine's existing reader profiles to
restore coverage. New Graph permissions remain a separately approved operation.

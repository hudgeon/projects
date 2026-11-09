# Email queue and urgent notices

Run the released installer with `--email-queue` on the duty and fallback
machines. Use the existing Support mailbox and the same owner's connected
inbox. Support mail appears in **Inbox → Email**. The owner's ordinary Gmail
actions remain available. Shared-only rows open the original conversation.

The duty watcher checks both inboxes at 30-second intervals plus Gmail read
time. It uses the ordinary inbox reader's Gmail history cache and looks back
30 minutes for urgent mail that filters routed outside the inbox. Local rules
look for explicit urgency, near deadlines and incident notices. A later human
Sent reply to the sender clears that request. The same RFC Message-ID in both
mailboxes produces one notice. Checks use no model or customer directory.

Recent urgent arrivals get a private notification on the owner's subscribed
Projects devices. The queue indicates incomplete or stale checks. The
five-minute objective is for surfacing a request when the source, watcher and
device are reachable. A person reviews and replies from Gmail.

`--no-email-queue` returns to the standalone Support feed. Drafts require
separate activation. Changing queue mode preserves Gmail drafts and the
existing delivery history.

For an email-only site, set the repository variable `PROJECTS_CHAT_SOURCES`
to `support` and deploy. The checker serves only enabled sources and rejects
new reads from disabled sources. This also hides previously saved reads from
Today and Inbox. An unset variable enables `slack,teams,support`. Stop the
local Slack and Teams readers with `--no-slack --no-teams` on their machines.

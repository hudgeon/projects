# Shared email support

Projects can monitor one shared Gmail mailbox as a support source in Today and
the Inbox. It belongs to a named Projects person; it does not create a support
login or expose another person's private inbox. An intentional Hand over uses
the existing per-item authorization. Gmail remains the conversation record.

## Connect monitoring

On each machine that can take duty, install the released commit with:

```sh
node scripts/install-machine.mjs --support help@example.com --support-owner owner@example.com
```

This uses the machine's existing Workspace delegation, at `gmail.readonly` for
reads and `gmail.modify` only for an enabled acknowledgment. The actual Gmail
profile must be the configured shared address. No key, delegation grant or
OAuth scope is created by this command. If that access is not already approved
and available, prepare the exact operation for the administrator before changing
it. A supported alternative is an existing private Gmail sign-in directory:
add `--support-gws-config /absolute/private/directory`.

The named owner must already be allowed to sign in. A watcher checks every 30
seconds while its machine holds collector duties, independently of the slower
repository scan. Actual latency includes Gmail reads and, for eligible new
inquiries, the installed native model's summary. This is not a guarantee of
instant delivery. Stale, failed and incomplete reads are visible in Projects;
failed support reads retain previously observed unresolved items.

Monitoring includes the existing inbox and conversations updated since
connection. Old inbox requests remain visible but cannot trigger an automatic
receipt. Both source
links are kept when the same message reaches a personal mailbox. The personal
copy is omitted from its actionable list only while an authorized, fresh,
complete support item contains its exact hashed RFC Message-ID. A matching
subject or sender alone never hides an item. A stale or unavailable support
read restores the personal copy. No mail is archived or deleted by deduplication.

## Acknowledgments

They are off until explicitly enabled:

```sh
node scripts/install-machine.mjs --acknowledge-support
```

Enabling records a new activation time and cannot acknowledge earlier mail.
Use the same activation configuration on the fallback machine after enabling;
the durable Worker receipt prevents another machine sending a second receipt
for the same Gmail conversation. Customer rollout requires a controlled
end-to-end test and the separately approved customer announcement.

Before enabling, connect an authoritative registered-user reader:

```sh
node scripts/install-machine.mjs --support-users-command '["/absolute/private/read-active-users"]' --support-user-policy all
```

The fixed local command must return only JSON with `complete: true`, a fresh
millisecond `observedAt`, and `hashes`: SHA-256 hashes of trimmed, lowercase email
addresses for active users with current customer memberships. Evidence older
than one minute, partial reads, a failed command or a missing reader cannot
authorize a send. The reader receives no email-supplied arguments, mailbox token
or Projects service credential. No directory roster is sent to Projects or the
summary model. It is read when a new eligible inquiry needs a receipt.

An installed `support-users.mjs` adapter reads an existing PostgreSQL registry
with `users`, `user_customers` and `customers` tables. Wrap it in your existing
scoped credential workflow, injecting only `DATABASE_URL`. It uses encrypted
connections, read-only transactions, an explicit customer predicate and
transaction-local `app.current_customer` for each customer. The command requires
`psql` on PATH. Use the authoritative identity database; regional mirrors with
empty identity tables cannot qualify users. The adapter saves no roster or
credential and changes no users, memberships or grants.

The actual incoming From mailbox must be registered; a registered person on cc
cannot qualify an unknown sender. The default `all` policy also filters every
reply-all recipient against that directory. `--support-user-policy sender`
requires registration only for the original sender and keeps the other original
recipients subject to the delivery checks below. A Reply-To header cannot
substitute another sender or redirect the receipt.

The agent classifies incoming plain text and summarizes the issue. It runs with
no tools or MCP servers, no mailbox token, and no session persistence. Only the
latest bounded message is supplied; attachments, earlier conversations and
private account data are not available to it. A failed or invalid summary sends
nothing and leaves a visible request for the owner. Bulk mail, automatic
messages, bounces, the mailbox's own mail, previously answered inquiries and
messages without safe reply headers cannot trigger a receipt.

The reply is sent by Gmail from the shared mailbox in the same thread, using
reply-all to the original From, To and Cc addresses after policy filtering.
The support mailbox, its aliases, duplicate addresses and addresses with a
failed or delayed delivery in that conversation are omitted. The copied owner
remains a recipient when eligible. No hidden Bcc recipients are discovered or
added. Malformed recipient lists or incomplete delivery evidence cannot send.

Delivery-status MIME reports identify failed recipients individually. Reports
in another Gmail thread count only when their attached original Message-ID
exactly identifies the support conversation; a shared subject or an unrelated
bounce cannot exclude an address here. The bounded report inventory includes
Spam and Trash; truncated or unreadable evidence leaves work for a person.
See [RFC 3464](https://www.rfc-editor.org/rfc/rfc3464) for the report format.

The fixed copy is:

> Automated response from Support
>
> Thanks for your email. We understand that [reported issue].
>
> We're looking into it, and a person from our team will respond shortly.
>
> Support

`Auto-Submitted: auto-replied` and response suppression headers also identify
the automation. The summary cannot change the sender, recipient, attribution,
commitment or send policy. A receipt is sent once for the support conversation;
later customer messages reopen its work state but do not generate repeated
receipts. Automatic acknowledgments do not change the incoming request time,
count as a human reply or mark work Done.

Before Gmail is called, the collector crosses a durable `reserved → sending`
boundary. Only that transition grants send permission once. Delivery is then
recorded, or stays uncertain if the response is lost. The originating machine
checks Sent in the exact shared-mailbox conversation before recording a recovered
delivery. Gmail may replace the submitted Message-ID, so recognition also checks
the shared sender, original request and reply recipient, automation headers and
fixed acknowledgment copy. A missing receipt is never permission to resend;
a fallback machine does not replay an uncertain send. The journal holds only
reservation tokens and hashes in the private machine state directory.

## Human replies and completion

Open the request's **Open support in Gmail** link and reply from that shared
mailbox, so the message is in its Sent folder and uses the same support sender.
Using only a personal account's send-as alias may not place a copy in the shared
mailbox and therefore does not establish a measured support response here.
Projects separately shows the automated receipt and the last non-automated Sent
reply. Mark Done when the issue is resolved. A later incoming customer message
returns it to the queue. Existing Teams/Slack SLA measurements are unchanged;
support email is not silently included in their historical population.

## Stop or recover

`--no-support-acknowledgments` stops future automatic sends while retaining
monitoring. `--no-support` disconnects the source; its old read becomes visibly
stale and does not suppress personal copies. Neither command deletes Gmail
messages or durable delivery history. Do not delete a delivery record to retry
an uncertain send: reconcile its actual Sent state first. If necessary, a human
can reply in the original thread after checking it.

Verify with synthetic or explicitly approved controlled mail: shared/private
authorization, one request for a cc copy, distinct requests with identical
subjects, no send for a bounce or historical message, automated attribution,
one actual threaded receipt, a human shared-address reply, a later customer
follow-up, uncertain-send recovery and a duty-holder restart. Record observed
latency and actual Gmail/Projects states; local tests alone do not establish a
customer rollout.

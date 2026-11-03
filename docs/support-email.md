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
reads and `gmail.modify` only for enabled draft preparation. The actual Gmail
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
Gmail thread reads allow at most 16 MB of subprocess output for long
conversations; the bounded message text sent to the queue/model is unchanged.
Other command output keeps its 4 MB limit. A still-oversized or unreadable
conversation leaves coverage incomplete and drafts held for review.

Monitoring includes the existing inbox and conversations updated since
connection. Old inbox requests remain visible but cannot trigger an automatic
receipt. Both source
links are kept when the same message reaches a personal mailbox. The personal
copy is omitted from its actionable list only while an authorized, fresh,
complete support item contains its exact hashed RFC Message-ID. A matching
subject or sender alone never hides an item. A stale or unavailable support
read restores the personal copy. No mail is archived or deleted by deduplication.

## Drafts for review

They are off until explicitly enabled:

```sh
node scripts/install-machine.mjs --draft-support
```

Enabling records `draftSince` and cannot prepare replies to earlier mail.
Use the same activation configuration on the fallback machine. Only the machine
on duty prepares drafts, with a durable reservation for each conversation.
Automatic sends are disabled, including for old enabled configurations;
`--acknowledge-support` is refused. Review and send each draft yourself in the
shared mailbox. Enabling drafts is never approval to send them. Customer
announcements and channel retirement remain separate decisions.

Before enabling, connect an authoritative registered-user reader:

```sh
node scripts/install-machine.mjs --support-users-command '["/absolute/private/read-active-users"]' --support-user-policy all
```

The fixed local command must return only JSON with `complete: true`, a fresh
millisecond `observedAt`, and `hashes`: SHA-256 hashes of trimmed, lowercase email
addresses for active users with current customer memberships. Evidence older
than one minute, partial reads, a failed command or a missing reader cannot
authorize a draft. The reader receives no email-supplied arguments, mailbox token
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

The agent classifies bounded incoming plain text as an issue, other human mail
or needing review. It runs with no tools or MCP servers, no mailbox token and
no session persistence. It selects an exact factual symptom excerpt for an issue;
the renderer supplies the investigation questions. It cannot propose a solution,
workaround or diagnosis. General questions, administrative requests, ideas and
thanks without a problem get a simple receipt. Thanks plus a continuing problem
is an issue. Ambiguous, invalid or unavailable classification falls back to a
simple receipt and visible human triage, provided all deterministic draft
checks pass. It never suppresses or resolves work.

Only the latest bounded message is supplied; quoted history is excluded.
Attachments, earlier conversations and private account data are not available
to this draft preparer. It cannot claim a database check. Protected reads
require a separate verified-user authorization interface; registration alone
does not authorize customer-data access. Bulk mail, automatic
messages, bounces, the mailbox's own mail, previously answered inquiries and
messages without safe reply headers cannot trigger a receipt.

The reply is saved as an unsent Gmail draft in the shared mailbox and original
thread, using
reply-all to the original From, To and Cc addresses after policy filtering.
The support mailbox, its aliases, duplicate addresses and addresses with a
failed or delayed delivery in that conversation are omitted. The copied owner
remains a recipient when eligible. No hidden Bcc recipients are discovered or
added. Malformed recipient lists or incomplete delivery evidence cannot create a draft.
The conversation and mailbox identity are checked again after classification.
Existing drafts are never overwritten; a later customer follow-up makes the
old draft visibly stale instead of creating another one. Review the current
conversation and recipients before manually sending. No draft update, deletion
or send endpoint is called by this workflow.

Delivery-status MIME reports identify failed recipients individually. Reports
in another Gmail thread count only when their attached original Message-ID
exactly identifies the support conversation; a shared subject or an unrelated
bounce cannot exclude an address here. The bounded report inventory includes
Spam and Trash; truncated or unreadable evidence leaves work for a person.
See [RFC 3464](https://www.rfc-editor.org/rfc/rfc3464) for the report format.

For an issue, the draft explicitly says it is automated, reflects an exact
attributed symptom from the email, and says what the support team is being
asked to investigate. The human queue accepts the incoming request before
preparation starts; no draft claims that a person has started work or that the
problem is fixed. A person will respond shortly, with no invented deadline.
Other eligible human mail gets only a short received/response-soon draft.

`Auto-Submitted: auto-replied`, suppression headers and a version marker identify
the automation even when a person later sends the reviewed draft. Sent recovery
recognizes both the released acknowledgment and the new format. The model
cannot change the sender, recipient, attribution, commitment or delivery mode.
A draft never counts as a sent receipt, human response or resolution.

Before Gmail is called, the collector crosses a durable `reserved → drafting`
boundary. Only that transition permits one `drafts.create`. The draft's stable
ID, original-message hash, triage label and preparation time are recorded, never
its body. A lost response leaves creation uncertain. The originating machine
reconciles the exact marked draft in that Gmail conversation against the draft
inventory, and records it without creating another. A missing, edited, sent or
deleted draft is never permission to recreate it. Another machine cannot replay
an uncertain creation. The private local journal retains reservation tokens
only; neither those tokens nor raw email reach telemetry.

## Owner-forwarded requests

An operator may explicitly enable draft preparation for new inline forwards
from their own addresses, using the same cutoff on every duty machine:

```sh
node scripts/install-machine.mjs --support-forwarder owner@example.com --support-forwarder owner@another.example --support-forward-since 2026-11-03T00:00:00.000Z
```

This changes no mailbox access or customer grants. The configured address must
be the actual outer From sender, and Gmail's receiver Authentication-Results
must show aligned DKIM and DMARC passes. Body headers and an unconfigured
sender cannot opt into forwarding. Existing incoming-mail/automatic-message
exclusions still apply. A future reinstall keeps the cutoff; it cannot move
backwards. `--no-support-forwards` stops forwarding drafts without changing
ordinary support intake or existing drafts.
The receiver-only authentication boundary follows [RFC 8601](https://www.rfc-editor.org/rfc/rfc8601.html#section-5);
encapsulated/body authentication assertions are never trusted.

The parser accepts the first complete English Gmail/Outlook/Apple inline
forward envelope: From, To, optional Cc, Subject and Date/Sent. It derives
reply-all from those headers only, keeping the existing original-sender
registration and per-conversation failed-recipient checks. It ignores the
forwarder's commentary, Reply-To, signatures and older participants; it does
not union every address mentioned in the chain. Unsupported/ambiguous headers,
attachment-only forwards or unverifiable forwarding are held for human review.
The newest original message body goes to the same bounded, tool-free classifier
and issue/other renderer; older quoted history stays excluded.

Drafts stay in the support mailbox's forwarding conversation with the outer
subject and Message-ID, preserving durable draft reservations, stale-followup
handling and uncertain-creation recovery. The original participants are visible
in To/Cc for the reviewer. No send, draft overwrite, deletion or hidden Bcc
expansion is added. A forward before activation is never backfilled. Quoted
Message-IDs are not used for cross-mailbox deduplication.

A forwarded identity is context for an email-only draft, never verified customer
identity. Forwarded requests publish no protected-check request metadata, create
no consent/record task and include no verification link or database observation.
Genuine direct mail and its separately verified/consented record checks retain
their existing boundary. Selecting an address from a forward grants no access.

## Authorised record checks

This optional connection is absent by default. After the deployment owner
approves the exact access grant, configure both `PROJECTS_SUPPORT_SERVICE` and
`PROJECTS_SUPPORT_URL` and use the normal Deploy workflow. It binds only the
customer application's private `SupportRead` entrypoint with platform-controlled
`caller: projects` props. Deploy verifies the target and entrypoint; collector
duties also probes the private health contract before offering verification.
An arbitrary HTTP header, email instruction or request field cannot set these
props. No database role, credential or Gmail scope is added.

For an eligible issue, the initial email-only draft can include a task link.
The link carries no bearer grant: the original sender must sign in normally
to the customer application and consent to one account, the exact task and its
immutable reply-all audience. A copied person cannot consent as the sender.
Every remaining recipient needs current access to the requested records. One
unknown or unauthorised recipient holds the entire protected brief. A normal
registered-user directory check alone never permits record access.

A support reviewer uses **Prepare record checks** in Projects after consent.
Machines cannot invoke that action. Only exact, explicitly tagged invoice
IDs/references or receipt-line IDs in the latest unquoted email are eligible;
more than two distinct references or no exact references holds preparation.
The adapter cannot submit SQL, choose an account/role, search broadly or read
attachments. The customer application limits consent to ten minutes, 20 calls
and 25 total returned records, and refreshes current access for each read.

Projects receives readiness metadata and an authenticated **Review record
checks** link. It never receives the grant, financial facts or protected reply
body. The human review page regenerates stored observations and fixed
investigation questions inside the source application, intersecting the human
reviewer's access as well as the sender's and every recipient's. Changed facts
or access hold the entire brief. It proposes no diagnosis, fix or workaround.
No protected content enters a Gmail draft, native coding conversation or model
cache. This release adds no protected-email send transport; all automatic sends
remain disabled.

Projects retains only the task ID, source/audience hashes, the email-only symptom
and workflow state in its existing receipt ledger. A newer incoming sender,
message, body or recipient list holds and permanently invalidates the old task.
It never silently drops a copied recipient, reuses an old consent or overwrites
the existing Gmail draft. Follow-ups remain for human review. Rejected older
source reads cannot invalidate current tasks. An unavailable connection leaves
the neutral email draft and visible support work available.

To disconnect, remove both optional variables and run the normal Deploy
workflow. This removes the binding and verification links while retaining mail,
draft receipts and work history. Existing task grants expire within ten minutes
and can also be withdrawn through their authenticated consent page.

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

`--no-support-drafts` stops future draft preparation while retaining
monitoring. Automatic sends stay disabled. `--no-support` disconnects the source; its old read becomes visibly
stale and does not suppress personal copies. Neither command deletes Gmail
messages or durable delivery history. Do not delete a receipt record to retry
uncertain creation: check the exact Drafts and Sent state first. If necessary,
a human can reply in the original thread after checking it.

Verify with synthetic or explicitly approved controlled mail: shared/private
authorization, one request for a cc copy, distinct requests with identical
subjects, no send for a bounce or historical message, automated attribution,
one actual threaded draft, issue/other/uncertain copy, a human shared-address
reply, a later customer follow-up, uncertain-draft recovery and a duty-holder
restart. Verify no Gmail send endpoint is called. Record observed
latency and actual Gmail/Projects states; local tests alone do not establish a
customer rollout.

## Internal paste-and-preview

The optional private application connection also serves explicit internal
preview jobs from its authenticated, company-scoped preview page. The chat
watcher polls separately from Gmail, only while its machine holds collector
duties. `collector/support-preview.ts` calls the existing `summarizeSupport`,
`groundedSupportSummary` and `acknowledgmentText` owners; it has no mailbox
client, record tools or persistent model session. The installed release hash
identifies the response version. Native failures remain failed previews.

`/api/collector/support-preview` accepts only strict poll/finish messages from
the collector on duty, through the existing private `SupportRead` binding's
`/preview/poll` and `/preview/finish` protocol. The customer application owns
authentication, current company access, temporary expiry, private saved cases,
conditional claims and human feedback. Projects neither stores cases in its
portfolio nor makes a support source, work item, consent grant, Gmail draft,
receipt or deduplication entry. Only bounded pasted text and its initial
response cross this path; customer-record readers and financial facts are
unavailable. Feedback does not alter or train the model. No new binding or
credential is required.

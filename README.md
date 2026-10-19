# Projects

Projects is a private site for running your software work from a phone or a
desktop. It shows the repositories on your machines, with their checkouts,
native Claude Code and Codex sessions, pull requests and health, and it runs
**conversations**: you state an outcome, a master agent plans it, hands the work
to native Claude Code or Codex sessions on one of your machines, checks the
evidence and reports back. Everything runs with your own logins and
subscriptions on machines you own; the site holds no GitHub, model or mailbox
credential.

To run your own copy, see [Self-hosting](docs/self-host.md).

## Views

- **Today** is where you work: start a conversation, clear what is waiting on
  you (**Your move**: needs an answer, failed, ready to review, stopped, or
  running but waiting on a step only you can take), follow what is running
  (**Working**) and keep the bigger work in view. On a phone a selected
  conversation takes the screen; on a desktop it opens beside the queue.
- **Inbox** (optional) lists email waiting on you. Linked work opens directly
  in Today; unlinked email can be linked to existing work or start a standalone
  activity. Previewing, linking or starting work never marks a message reviewed.
- **Settings** holds your name, Codex speed, timing comparisons, machines and repository diagnostics: add a machine, set
  their order, replace tokens or remove one. Existing repository bookmarks work.
- **Archive** keeps what you marked Done or archived, with Reopen and Restore.

Bigger work has bookmarkable details with its position, source emails and
activities. Start activity uses the same composer as Today with the work issue
selected; a repository is selected only for one clear registered match. The
work issue stays canonical on GitHub, including explicitly linked email threads.
Link requests use the existing inbox queue and the machine on duty's GitHub login.

The selected view, work item, email, project, conversation and archive filter
are URL search parameters, so reloads, bookmarks and browser Back work.

## How it works

A React single-page app (TanStack Router and Query) polls a TypeScript
Cloudflare Worker every 30 seconds. The Worker keeps one SQLite Durable Object
per portfolio owner, holding snapshots, machines, archives, sessions,
notifications and queued requests, and one per conversation,
holding its messages, claim, receipts, progress, screenshots and browser.

Each connected machine runs two background services:

- the **collector** publishes a snapshot every two minutes: repositories,
  worktrees, native sessions, pull requests, work items (with `workRepo` set)
  and, on the machine on duty, the inbox;
- the **runner** claims conversations over outbound HTTPS and runs the native
  sessions for them.

Native transcripts, prompts and tool output never leave the machine.

Projects are selected by GitHub repository identity, not folder. Discovery
follows reorganisations, and a repository opts in with a `.project-overview.json`
file (a stable id, display name and canonical plan; see
[the agent guide](public/agents.md)) or by name in the machine's config. Each
snapshot replaces that machine's previous one. Observation times are scan-start
times, so a slower, older scan cannot overwrite newer work, and a failed
discovery publishes nothing rather than declaring projects gone.

## Machines

The owner adds a machine in Settings by naming it. The site shows its
id and two tokens once: a **collector** token, which can only upload that
machine's snapshot and exchange queued requests, and a **runner** token, which
can only claim, heartbeat and report conversations. The Worker stores only token
hashes; **Replace tokens** issues new ones and **Remove** revokes both at once
and drops the machine's snapshot. Machine tokens never reach a session route,
and each machine's runner IDs map to conversation owners of its own, so one
machine can never act on another's claim.

Machines are ordered. The first machine heard from in the last five minutes is
**on duty**: it reads the inbox and applies Mark done and inbox actions. Every collector asks the Worker whether it is on
duty before each scan, so exactly one machine applies each request. New
conversations go to the first machine whose runner called in the last two
minutes (an idle runner claims every two seconds and a busy one heartbeats
every ten, so a restart or short network drop hands nothing over).
A conversation stays on the machine that claimed it, where its native sessions,
journal and worktrees live.

While a conversation's machine is away and another is present, the conversation
offers **Continue on another machine**. That releases the claim without
replaying anything: a step in flight is abandoned with an unknown outcome under
a new generation, so the away machine's late reports are refused, and the next
machine to claim it starts a new coordinator from the conversation's history.
Its earlier native sessions are never resumed, and the coordinator checks GitHub
before repeating any change.

Work in progress follows the conversation through GitHub, for **private
repositories only**. Every five minutes while a change child works, and when
each of its turns ends, the runner saves the worktree to the ref
`refs/projects/wip/<conversation>/<child>` (never a branch, so it starts no
checks), built in a private index so the agent's own index is untouched. A
repository GitHub does not confirm as private is never saved, because anyone
who can read a repository can list and fetch such refs. Ignored files are never
saved; a changed file over 5 MB or that looks like a credential (`.env*`,
`.dev.vars`, `.npmrc`, SSH and other keys, names with credential, secret or
token) keeps its committed version, or stays local when new. Pushes run the
repository's own hooks. Copies are removed once GitHub has the work or its
branch has landed, decided from what GitHub lists rather than process memory.
Continuing a child's workspace on another machine recreates it from the newest
copy (or the pushed branch, when newer) as uncommitted changes on the same
branch and tells the new session how recent that copy is.

Each machine has one `~/.local/share/project-overview/machine.json` for its
collector and runner, written by `scripts/install-machine.mjs`:

| Field | Meaning |
| --- | --- |
| `host` | The machine id the site showed. |
| `endpoint` | The site's URL. |
| `root`, `home` | The folder holding your repositories, and your home folder. |
| `agents` | The apps signed in on this machine (`claude`, `codex`); conversations never start another. |
| `collectorTokenFile`, `tokenFile` | Owner-only files holding the two tokens, for a machine without `doppler`. With `doppler` and neither file, the tokens come from that config. |
| `workRepo` | Optional: the repository whose issues labelled `work` are work items. |
| `inboxAccount` | Optional: the Gmail account read through `gws`. |
| `helpers` | Optional: `localServers` (local MCP servers Claude helpers may use) and `deniedTools` (tools to hide from them). |
| `doppler` | Optional: a Doppler `project`/`config` holding the machine's `COLLECTOR_TOKEN` and `RUNNER_TOKEN` and, optionally, a read-only GitHub App, read with the read-only service token in `doppler-token` (mode 600). The collector runs with only its own token and the App's secrets; the runner reads its token once at start and keeps it out of every environment. |
| `concurrency`, `quickConcurrency` | Standard conversations at once (1–5, default 3) and extra quick-work slots (0–5, default 5). |

## Conversations

The top of each signed-in view shows the weekly subscription allowance left
for Codex and Claude, with the reported reset time: provider-reported
percentages, not estimated token balances, read by each collector from its
native login without starting a model turn. The newest machine's report is
used once, never added across machines; its source and read time are on the
indicator. A missing or failed read is unavailable, a read older than five
minutes is overdue, and an elapsed reset waits for a new read.

Codex uses the native app-server's read-only `account/rateLimits/read` method,
selecting its seven-day subscription window; Claude uses the native login's
OAuth usage endpoint. Credentials stay on the machine and in memory for that
HTTPS read; only allowlisted percentages and timestamps leave it. The collector
refreshes no expired credentials, changes no login and enables no extra usage.
A missing, expired or inaccessible login shows unavailable, as does an upstream
change to the Claude endpoint, a native-client interface rather than a public
API contract, until the reader is updated.

Each conversation gives a **master** an outcome. The master is Codex unless you
choose Claude in the composer (remembered per device); on a machine without
Codex it is Claude. When its app declines the conversation, reaches its usage
limit, is signed out or fails twice in a row, the other app takes over for the
rest of the conversation, and its details say why. It is read-only and makes one structured decision at a
time: dispatch a child, finish, or ask you for a material decision. A child is
a native Claude Code or Codex session: **change** children work in their own
Git worktree from current `origin/main`; **read** children answer questions and
change nothing. Implementation goes straight to one change child, which
investigates as part of the work. A follow-up reuses its worktree; its session
continues only while it is small, and a review of a change always gets a fresh
one, which starts from the earlier report. Child results resume the same
master, which is sent only what it has not seen; once its own session grows
large, a fresh master takes over with the full brief. Native agents use their
existing sign-ins; there is no hosted agent runtime or inbound tunnel. The
claim names whose conversation it is: agents address them by name, helpers'
commits are authored as them (pushed with the machine's login), and PRs and
work-record comments say who asked.

Context follows the task rather than the age of its conversation. The master
can set `resetContext: true` on a decision when the task changes materially,
a correction invalidates its assumptions, or repeated attempts revive an old
mistake. Its next decision starts fresh once the current one is accepted;
running work is never interrupted. It can also set `task.freshSession: true`
to give a helper a fresh session in the same owned worktree. Small direct
revisions can continue their existing session.

A fresh master receives the user's original instructions and corrections,
the latest reported position and the existing child evidence, never a replay
of every earlier agent answer. Reports remain claims to verify; user authority
is preserved separately. The exact exchange stays in a private local context
file for read-only reference: a short approval is checked against the original
request before acting, not guessed from a handoff. Helper briefs carry the
current objective, applicable constraints and approvals, source evidence, open
questions and acceptance checks. Repository instructions and canonical plans
stay in their files and are read when relevant. This applies the task-scoped
handoff advice in [Context Engineering Is Knowing When to Start Over](https://every.to/also-true-for-humans/why-i-start-a-new-thread-in-claude-every-time)
without discarding saved work, approval boundaries or recovery journals.

Optional Jev context selection (off by default) runs in the conversation's
executor: it trims older detail from fresh coordinator handovers and ranks
project evidence before each coordinator, helper and recovery turn.
[docs/context-selection.md](docs/context-selection.md) covers its modes, key,
gateway, diagnostics, retrieval, caching and validation.

When a child returns, the runner adds current evidence: HEAD, branch, changed
paths, commits not yet pushed, and the branch's pull request with its checks.
Change work is assigned end to end to one helper, with follow-ups in its owned
worktree for fixes and remaining delivery. Independent review and capability
changes can still require another helper. Before reporting completion after a
change child, the master must account for checks, review, merge, deployment,
visual verification and required machine sync for the **current request**. Each
gate has specific evidence or a reason it does not apply; missing or pending
gates go back to the master without replaying work. Draft-only
requests end at a verified saved draft. The final delivery record stays in the
private local journal, not telemetry or portfolio snapshots. This makes the master's
assessment explicit without attesting external systems or replacing the
repository's release gates.

The master checks evidence before declaring anything complete: a native turn
ending proves no tests, merge or deployment, and nothing here invents progress
or verification. Repository instructions own setup, checks and delivery.

- **Feedback** can be sent while queued or running. It reaches the agent at
  work within seconds (Codex through `turn/steer`, Claude through its stream
  input) and the master still reviews it at its next decision. **Stop work**
  cancels; cancellation recalls no effect already performed.
- **Progress**: agents emit bounded `PROJECTS_PROGRESS` notes; the conversation
  shows a **Now** panel (the step in progress, what follows, what is done), the
  working agent's own plan, and for a change child the branch's changed files
  with line counts. Five-minute updates are saved by the conversation's alarm,
  survive browser closure and never repeat old work as new.
- **Results** start with one plain sentence (the conversation's status line),
  at most four short bullets, and a **Your move:** line when you must act.
  Documents named in results, notes or messages are listed with their saved
  edition. `src/run-text.ts` owns this presentation and only removes protocol
  residue.
- **Pages**: an HTML mockup or slide deck linked at a saved commit opens
  inside Projects, full screen over the current view, from the documents list
  or the link itself; **Source** keeps the GitHub copy a tap away. The first
  machine whose runner calls next reads that edition with its own GitHub login,
  and the Worker keeps it (up to 5 MB, the 30 most recently opened). The commit is the version: nothing is republished. The page runs its
  own scripts in an opaque origin (sandbox and `DOCUMENT_CSP` in
  `src/document-model.ts`), so its slide controls, notes and clicks work but it
  cannot reach your session, Projects' pages or APIs, the network or the top
  window; inline code, `data:` images and Google Fonts load, nothing else. Only
  repositories a machine reports open, and a request no machine answers within
  a minute says so.
- **Screenshots** can be pasted or added to messages (on an iPhone, with the
  Paste button); the browser re-encodes and bounds them and both master and
  children receive them.
- **Typing**: Enter sends and Shift+Enter starts a new line; on a phone,
  Return starts a new line and Send sends.
- **Quick work** (email replies, unsubscribes) has its own slots and lighter
  prompts, so it never waits behind long work.
- **Bounds**: ten active standard and thirty active quick conversations, 30 and
  60 starts an hour, 120 follow-ups per owner per hour, 24 children per conversation, 12 master
  decisions a turn. At a safe native turn boundary the coordinator rotates when
  reported context exceeds 250,000 tokens or recorded prompt input reaches
  128,000 characters (including when native usage is unavailable). The chat,
  machine claim, children and worktrees remain the same, and rotation resets
  session context, not cumulative usage.

Permissions: a Codex change child uses a named permission profile for its
worktree and Git directories, with network access and no interactive
approvals; the primary checkout stays read-only. A Claude change child has
Read/Glob/Grep/Edit/Write/Bash; a read child and the master only inspect. The
master and read-only recovery get only this conversation's browser. Helpers
also get the machine's connected accounts, read and write: Claude allows every
claude.ai connector plus the local MCP servers in the machine's
`helpers.localServers`, hiding other local servers and `helpers.deniedTools`;
Codex approves its app connectors but disables account administration. Sending,
replying to and forwarding email stay off in both, so email stays a draft until
you approve each message. Codex's macOS sandbox cannot start a local browser,
so local browser checks go to a Claude child. These are trusted-user sessions
with access to the machine's existing tools and logins, not a sandbox for
untrusted users.

Recovery: each dispatch is journalled locally before it runs. A runner restart
keeps its claim; once the old process has exited and the workspace is verified,
the same child session is resumed **read-only** to reconcile what finished; the
master decides what remains. A helper turn that fails is reconciled the same
way at once; when its session cannot continue (out of room, say), the master
gets the worktree's state and continues it in a fresh session. A request the
runner refused leaves the helper's result standing, as evidence, and a failed
coordinator turn runs again. Failures reach you only after the master
has had its say, or after four in a row in one turn. Turn limits, and how a
helper's turn ends at its result, are in [docs/run-health.md](docs/run-health.md).
Uncertain writes are never replayed. Each conversation runs in its own executor process, so a release
restarts runners at once with `SIGUSR2`: the runner exits for the new bundle,
which adopts the executors still running; each finishes its current step on
the version it started with, saves its place and exits, and the new runner
continues it. `SIGTERM` still stops everything; that work recovers as above.

### Conversation browsers

Native sessions use the pinned Playwright MCP client over CDP with the Worker's
Cloudflare Browser Run binding. Before each turn the runner exchanges its claim
for a short-lived browser capability signed by the conversation; each WebSocket
handshake checks it with the current claim, generation and heartbeat. The
browser starts on first use and can reach only `BROWSER_HOSTS`: the site plus
any exact hosts in `PROJECTS_BROWSER_HOSTS` (docs/self-host.md). Read sessions
navigate and wait; change children may also click, type and capture. The
conversation page offers **Watch browser** and **Open browser / sign in**
(one-minute links for the signed-in owner). Browsers close after five idle
minutes or thirty in all; no Cloudflare credential reaches a machine.

On machines listed in `PROJECTS_BROWSER_SIGN_IN`, each new browser starts
signed in as the conversation's owner, while their address is allowed; else
it is not, and the agents are told. The Worker sets the cookie itself over
its own CDP connection before the runner's opens; no runner route returns it.
The session belongs to that browser alone: only its hash is kept, it ends when
the browser closes or the provider ends it (checked every five minutes), on
Sign out, when the machine is removed or a Deploy drops it from the list, or
when the conversation continues on another machine, and it cannot connect or
change machines, change execution settings, open Live View, read or act on
email, or subscribe to notifications. The machine's runner drives that browser,
so while it lives the runner can act through it, and could read its cookie over
CDP, within those limits: narrower than signing the browser in by hand, which
leaves it a seven-day session without them.

## Work items (optional)

With `workRepo` set, a work item is a GitHub issue labelled `work` in that
repository: its type is the kind of work, its milestone the initiative,
`customer:` labels who drives it and `repo:` labels the repositories it
touches. There is no second backlog. Every machine with `workRepo` set reads
open issues and those closed in the last three weeks on each scan and keeps its
own copy for its hooks; Projects shows the newest successful read, and a failed
or truncated read is unavailable, never an empty list. **Bigger work** on Today
groups them by customer and initiative, with each item's status, next step and
signals (conversations, new email, failing checks, due date), parsed from an
optional **Current position** block in the issue body.

**Discuss bigger work** starts a conversation about new work or combining and
splitting existing outcomes. **Discuss this work** on a work item keeps that
issue selected and defaults to the registered work repository. People have
roles and next actions; commitments name what is due, its date and its owner.
Unknown dates and owners remain explicit. The current overview stays concise;
supporting updates and earlier activities remain available below it.

The existing native change helper maintains the canonical issue at meaningful
checkpoints and before finishing linked work, respecting read-only requests and
the owner's corrections. A standard coordinator with a configured work repository
must account for the record as updated, unchanged (with a reason), or pending.
Pending or missing assessments prevent completion. This is the coordinator's
readback assessment, not independent GitHub certification or background monitoring.
Collectors publish the saved record on their next scan; source timestamps remain
visible. No new GitHub credential or issue-writing access is added to the Worker.

Combining produces one continuing issue with a shared outcome, preserving
clients, people, commitments, source links and prior history. Only after the
continuing record and reciprocal links are verified are predecessors closed as
superseded, not delivered. Splitting allocates those facts to distinct outcomes
and retains links to the source. Conversations keep their original association;
earlier activities are shown as history, not silently assigned to a new outcome.
Older issues outside the collector's window remain accessible through their
GitHub links. The human-editable section format is in [agents.md](public/agents.md).

**Mark done** stores only the issue number; the machine on duty closes the
issue with its signed-in GitHub CLI on its next run and reports back. The
Worker holds no GitHub credential and pull requests are never merged or closed.

`npm run hooks:install` (or the installer's `--hooks`) adds Claude and Codex
hooks that link each session to a work item: the assistant classifies an
unlinked session and records `work: #123` or `work: none` on its final reply's
last line; your own `work:` reply always wins. Associations stay on the machine
and never include prompts or transcripts. Codex asks you to trust the hooks
once.

## Inbox (optional)

With `inboxAccount` set, the machine on duty reads up to 200 inbox threads as
metadata through its existing `gws` login, and the latest non-draft message of
each as bounded plain text (quoted history removed, at most 4,000 characters).
Text lives only in the latest snapshot, is stripped from the overview and is
read one thread at a time; it never enters telemetry or prompts. If the machine on duty cannot confirm its duty before a scan, its last
read stays for up to fifteen minutes, with its age shown. Linked work opens
inside Today, where **Start activity** preselects that work item. Unlinked
email can be linked to open work or start a standalone activity. Only a source
link enters the request, never the email text. **Done** finishes the activity;
archiving its source email is a separate explicit action. **Archive** and
**Unsubscribe** follow the Mark done pattern; unsubscribe uses RFC 8058
one-click only, to a public HTTPS host checked on the connection's own DNS
lookup, and otherwise starts a conversation. A conversation's email lane uses
its owner's mailbox only when that is this `inboxAccount`; anyone else's is
told no mailbox is connected for them yet.

The retired daily brief returns Gone without sending mail; its records stay.

## Notifications

A conversation becoming its owner's move (Ready, Needs you or Failed) sends a
Web Push notification to that person's devices. Pushes carry no payload: a
device fetches its person's notices with its own session, so no title or text
crosses a push service. The Worker posts only to those services and forgets
devices reported gone. On an iPhone, notifications need Projects on the
Home Screen.

## Evidence and limits

- Git is read without optional locks: no fetch, reset, clean or checkout.
  Ahead/behind uses the cached upstream and says so.
- Codex: unarchived native tasks, not necessarily open windows. Claude: session
  records plus a live matching process; old status is open, not running.
- A failing draft PR is in progress, and so is a changed or unpushed checkout
  while a session in that worktree is recent; otherwise it needs a look, as do
  failing ready PRs, conflicts and unreadable state. Unpushed means commits only
  that machine holds. A worktree Git cannot reach is unverified, never clean. A
  stale observation never downgrades a concern.
- Progress is attributed plan text, checkbox counts or the latest merge; a merge
  is not proof of deployment. Nothing invents percentages.
- GitHub is read through each machine's signed-in `gh`, or a short-lived,
  read-only GitHub App token limited to the observed repositories.
- Discovery ignores hidden folders, symlinks, `zarchive` and `_archive`; limits
  fail closed or show explicit incomplete coverage.

## Security

- **Sign-in**: email codes sent through Cloudflare Email Service to allowlisted
  addresses only. Codes expire after ten minutes, allow five attempts and are
  consumed once; issuance is rate-limited. Only salted code hashes and session
  hashes are stored. Sessions last seven days, logout revokes them, cookies are
  Secure, HttpOnly, SameSite=Strict and host-only, and every browser write must
  be same-origin.
- **People**: every allowed address is a person with a profile, named from the
  address until set in Settings. A conversation belongs to whoever started it
  (older ones to the deployment owner); everyone sees everyone's, and its
  machine is told who, never telemetry.
- **Machines** authenticate with their own tokens, stored as hashes; collector
  and runner tokens reach only their own routes and never read the overview.
- **Pages** are untrusted HTML: served only to the signed-in owner, framed only
  by Projects, sandboxed without same-origin, top navigation, forms or network.
  Links may open in a new tab, outside Projects.
- **Whoever can sign in can act on your machines** with your logins and
  connected accounts, so keep `ALLOWED_EMAILS` to yourself.
- **Telemetry** (`src/telemetry.ts`) is a runtime-validated allowlist of fixed
  categories, ids, counts and durations: no prompts, summaries, email
  addresses, native session ids, paths, commands, tool output, exception text
  or credentials.

## Observability

Cloudflare Observability for the Worker holds production logs and traces.
Custom spans cover requests, authentication, conversation reads and writes,
dispatch, heartbeat and report; responses carry `X-Projects-Request-Id` for
finding the matching log. The runner journals a bounded window of timing events
(`native_started`/`native_finished` sharing a `turnId`, workspace preparation,
recovery, master decisions) and reports them with its receipts; they correlate
by conversation, generation and event id. Logs are diagnostic, not an execution
ledger. Logs are kept at 100%, traces sampled at 10%, and routine successful
polls at 1%.

Settings has an owner-wide **Codex fast mode** switch, initially off. Every
Projects Codex coordinator/helper reads it before its next turn, including
resumes and recovery; an active turn is not interrupted. The native app-server
receives explicit `fast` or `default` service tiers, without changing model or
reasoning. Claude and sessions outside Projects are unaffected. Fast mode uses
more allowance; see [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed).

The same page compares labelled Codex turns from the last 30 days (up to 10,000).
The portfolio retains deduplicated canonical completion receipts independently
of the conversation's bounded event window. It records requested speed, resolved
model/effort, attempts, token counts, elapsed time and first text latency when
observed. Comparisons match role, read/change, new/continued, machine, input/output
token bands and cache share. At least three completed single-attempt turns per
mode are required for a median percentage; failures, missing measurements and
earlier unlabelled turns do not become a standard-mode baseline. Total time
includes native startup and tool work; first output can include reasoning/tool
waits. These are workload observations, not a controlled benchmark or proof of
the provider's actual processing tier. No synthetic timings enter production.

## Development

Node 24 or newer:

```sh
npm ci
npm run dev:api
npm run dev
```

The preview runs at http://127.0.0.1:5278 against a local Worker on port 8798
(`worker/local.ts`, loopback only, never used in production). Locally you are
the owner: add a machine in Settings, then point a local
`machine.json` at `http://127.0.0.1:8798` and run `npm run collect -- <config>`
or `npm run runner -- <config>`.

Checks: `npm run` typecheck, test, build, collector:build and
file-sizes:check, and `npm audit --audit-level=high`.

## Releases

CI runs the checks on every pull request. A release is a reviewed, merged pull
request and a manual **Deploy** workflow run on `main`, which:

1. fills `wrangler.jsonc` (which holds placeholders) with the deployment's
   identity from the `PROJECTS_*` repository variables (docs/self-host.md);
2. checks the merged pull request, CI and, when
   `.github/release-policy.json` requires it, a passing `security-review`
   status from the bot named by `SECURITY_REVIEW_BOT_ID`;
3. fetches secrets from Doppler through a project-scoped OIDC identity and
   uploads only `secrets.required` (`ALLOWED_EMAILS`, `VAPID_PRIVATE_KEY`),
   removing any other Worker secret;
4. deploys with immediate Durable Object code updates and verifies the live
   version, its commit, assets, settings, secret allowlist, that unknown tokens
   are refused, and that every object runs the new version.

Transient Cloudflare failures retry with backoff; anything else stops the
release. After a deploy that changes the machine bundles, run
`node scripts/install-machine.mjs` from a checkout of the released commit on
each connected machine: it builds the bundles there, keeps the config and
tokens, and drains or starts the runner. A machine that is away gets the
release when it returns.

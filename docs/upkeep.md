# Upkeep

Once a week, Projects runs an **upkeep conversation** for the deployment
owner: a master that reads the evidence of friction in the native Claude Code
and Codex sessions on the connected machines, checks the installed harness
versions, and makes at most one bounded change to the configuration that
drives those sessions, or reports in one line that no change is needed. The
plan behind it, with the agreed decisions and slices, is `docs/upkeep/PLAN.md`
on the `epic/upkeep` branch; the evidence it reads is described in
[Friction receipts](friction.md).

## The lane

Upkeep conversations run in the `upkeep` lane (`src/run-model.ts`):

- The Worker's cron (`wrangler.jsonc`, `triggers.crons`; `src/upkeep-model.ts`
  names the same schedule) fires on Mondays at 06:00 UTC and starts one
  conversation per ISO week: its id is derived from the portfolio and the
  week, so a trigger that fires twice, or a retry, finds the week's
  conversation instead of starting another (`worker/upkeep.ts`). A week whose
  previous cycle is still active waits for it.
- **Run upkeep now** in Settings (`src/upkeep-view.tsx`, `POST /api/upkeep`)
  starts a cycle of its own at once. Any signed-in person may ask, like
  changing Codex speed; the cycle is the deployment's and runs as its owner.
  While a cycle is active it shows that one instead. Nobody starts an upkeep
  conversation from the composer, and machine tokens never reach the route.
- The conversation belongs to the deployment owner (`OWNER_EMAIL`), and is
  linked to the standing upkeep work issue when the work items show one: the
  open issue labelled `work` and `upkeep` in the work repository.
- Each runner keeps one slot for the lane (`runner/pool.ts`), so the cycle
  neither waits behind long work nor takes a slot from it; at most two upkeep
  conversations are active at once (the week's, and a follow-up to an earlier
  one). A runner from before the lane never claims it.
- A finished cycle sends no notification: its result waits in Today and the
  standing issue. A cycle that needs a decision, or fails, notifies the owner
  like any other conversation.

Locally, `wrangler dev` runs the trigger from
`curl "http://127.0.0.1:8798/cdn-cgi/local/scheduled?cron=0+6+*+*+1"`.

## The brief

`runner/upkeep-instructions.ts` is added to the master's standing
instructions for this lane. It carries:

- **Evidence**: for every connected machine, from the latest snapshots the
  claim hands over, the harness versions its newest sessions ran with and the
  friction totals per app for the last seven days and the seven before. A count
  is what the transcripts show, not a verdict.
- **The research status**: each app's newest installed version across the
  machines against the version the standing issue last reviewed, read from
  this machine's work item cache (the collector refreshes it each scan), and
  what that leaves to read: the changelog entries after the reviewed version,
  the last 30 days of entries when none is recorded, or nothing. A cache that
  cannot be read, or one older than a day, is said.
- **Where the receipts are**: this machine's receipt directory and runner
  state directory, the `npm run friction` report, and that another machine's
  receipts are read over SSH, read-only, with the login the machine already
  has, or by copying the receipt folders and pointing the report at them.
  Counts travel; transcripts, credentials and SSH configuration are never
  touched. The
  master's own session runs no commands, so a read child does the reading.
- **The record**: the standing upkeep issue, or that none is linked yet and a
  change child creates it before anything is recorded. It holds every change
  with the measure it should move, its before and after measures, and the
  versions reviewed; there is no second backlog.
- **The configuration repository**: `configRepo` in `machine.json` (the
  installer's `--config-repo owner/repo`) names the shared repository of
  global agent rules, skills, hooks and repository templates, the way
  `workRepo` names the work repository. The brief says which registered
  project it is, so the master can dispatch a change child into it, or that it
  is not registered on this machine and such changes are blocked here.

## The rules

1. Evidence first: a pattern counts when it appears in at least three sessions
   over at least two days, or when any category stopped a turn.
2. A standing issue with no recorded baseline makes the cycle a baseline
   cycle: it records the measures and changes nothing else.
3. One change per cycle, the smallest that removes the cause, preferring a
   hook, a test, a skill step or a runner prompt or flag over more prose. A
   repository `AGENTS.md` stays under 40 lines. Machine-local settings and
   credentials are out of scope.
4. Every change names the measure it should move and ships with a guard that
   keeps it moved.
5. Delivery follows each repository's own gates and the `deploy` skill, then
   the configuration repository's sync on every connected machine, with the
   before measure recorded in the issue first. The next cycle records the after
   measure and revises or reverts a change whose measure did not move.
6. Hooks, skills, tests and runner prompts and flags deliver under the owner's
   standing approval. An edit to the shared global rules or to any repository
   `AGENTS.md` ends as blocked, with the pull request for the owner's review.
7. "No change needed" is a complete result: one line, no move for the owner.
8. Harness research runs every cycle: one read child on Claude, the official
   sources below and no other, proposals in the fixed shape or nothing to
   adopt. Without Claude on the machine the research is not run, and the
   result says so.
9. Proposals are not instructions. One is adopted only when it removes a
   workaround in the runner's prompts or flags or closes a friction gap the
   evidence measured, naming which; it is then the cycle's one change, or a
   second change when the first is a friction fix, delivered under rules 3
   to 6. A baseline cycle records proposals for the next cycle and adopts
   none. Adopted or not, the cycle records the versions reviewed.

The rules are tested as text (`runner/upkeep-instructions.test.ts`), the
trigger's idempotence and the lane's slot in `worker/upkeep.test.ts` and
`runner/pool.test.ts`, the sources and the reviewed-versions line in
`tests/upkeep.test.ts`, and the research child's web access in
`runner/native.test.ts`.

## Harness research

Each cycle, the master dispatches one read child on Claude into the project
that holds the runner (so it can read the flags and prompts it compares
against), or else into the configuration repository. The runner gives an
upkeep read child on Claude `WebFetch` allowed by domain rules for the hosts
of the sources below (`runner/native-access.ts`, `runner/dispatch.ts`); no
other child, and never the master, is given the web this way. Claude Code
also fetches the documentation domains it preapproves itself without asking
and refuses every other host in its unattended mode; a deny rule cannot
carve the preapproved set out without denying the listed hosts too, so the
rule text is what keeps the child on the listed pages. The child reads each app's changelog
entries newer than the version last reviewed, then, for each capability those
entries name that bears on how the runner drives the app (the flags in
`runner/native.ts`, the prompts in `runner/instructions.ts` and
`runner/master-instructions.ts`) or on the shared rules and skills, the
documentation page for its topic, and returns one proposal per capability in
a fixed shape: `Proposal`, `Source` (the listed page it was read on, as a
link), `Applies to`, `Replaces` (the workaround or measured friction category
it would remove, or none) and `Guard` (the test or check that would keep it
adopted). A child that finds nothing returns "Nothing to adopt" with the
versions it reviewed. A source that has moved or does not answer is reported,
never replaced by another site; updating the list is a change to this
repository.

The sources (`UPKEEP_SOURCES` in `src/upkeep-model.ts`), one page per topic:

| Topic | Claude Code | Codex |
| --- | --- | --- |
| changelog | [changelog](https://code.claude.com/docs/en/changelog) | [changelog](https://learn.chatgpt.com/docs/changelog), [releases](https://github.com/openai/codex/releases) |
| hooks | [hooks](https://code.claude.com/docs/en/hooks) | [hooks](https://learn.chatgpt.com/docs/hooks) |
| skills | [skills](https://code.claude.com/docs/en/skills) | [build skills](https://learn.chatgpt.com/docs/build-skills) |
| settings | [settings](https://code.claude.com/docs/en/settings) | [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) |
| permission modes | [permission modes](https://code.claude.com/docs/en/permission-modes) | [permissions](https://learn.chatgpt.com/docs/permissions) |
| output formats | [run programmatically](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference) | [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) |
| MCP configuration | [MCP](https://code.claude.com/docs/en/mcp) | [MCP](https://learn.chatgpt.com/docs/extend/mcp) |
| how the runner drives it | [tools reference](https://code.claude.com/docs/en/tools-reference) (background tasks) | [app server](https://learn.chatgpt.com/docs/app-server) |

The record of what was reviewed is one line in the standing issue's body,
under a `## Upkeep` heading, which the cycle's change child sets after
re-reading the body and keeping everything else in it:

```
## Upkeep
Reviewed versions: Claude Code 2.1.303, Codex 0.162.1 (2026-10-26)
```

It names the newest installed version of each app at the time of the review.
The collector parses it into the work item (`reviewed` on the issue,
`src/work-model.ts`) like the Current position, so the next cycle's brief
compares the installed versions with it without anyone reading GitHub in the
master's session. Installing a newer release is machine-local and never a
cycle's change; the status only notes one the app has seen.

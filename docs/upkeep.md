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

The rules are tested as text (`runner/upkeep-instructions.test.ts`), the
trigger's idempotence and the lane's slot in `worker/upkeep.test.ts` and
`runner/pool.test.ts`.

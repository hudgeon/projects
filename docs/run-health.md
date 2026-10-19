# Run health

How a conversation's native turns end, so none runs on unseen.

## Turn limits

`runner/turn-limits.ts` checks every native turn. A helper turn past 90
minutes or 100M tokens is asked to save its work and report, and is stopped
and inspected 20 minutes later if it has not. The grace period runs from the
limit whether or not the request reached the turn, so one that can no longer
take input is still stopped. A coordinator turn past 20 minutes is stopped and
runs again.

## A helper's turn ends at its result

Claude keeps a helper's process running while any command it left in the
background goes on, then starts a turn of its own when that command finishes,
which nobody reads. So `runner/native.ts` gives a Claude process 30 seconds
after its result to exit. One still running is stopped with its process
group, which also stops the commands it left running. The first result stands
and later ones are ignored. The master's evidence for that helper says it was
stopped, and the runner records a `turn_overran` event (categories only, as
for every execution event).

Helpers are told how to wait (`runner/instructions.ts`):

- run anything over two minutes, such as a review, a test suite, a deploy or
  CI, in the background with its input closed (`< /dev/null`), and check on it
  with short commands that show its progress;
- wait on the process ID they started, never a name search: `pgrep -f`
  matches the waiting loop's own command line, so that loop never ends;
- treat a command with no new output and no CPU use for five minutes as
  stuck, and stop it;
- stop or finish every background command before returning a result.

## Waits and signs of a stuck step

`runner/turn-watch.ts` follows each native turn: the tool calls it has open,
when the agent last said anything (tokens, a progress note, a plan), and,
every 30 seconds, the CPU time of the processes its commands run (whatever a
shell under the agent starts, without the shells and sleeps themselves; the
agent and the servers it starts directly, such as its browser's, are not
commands). It publishes `live.watch`, times and categories only:

- a tool call open for two minutes shows as a wait, with what a command waits
  on as a category the runner reads from the command on its own machine
  (a review, CI checks, tests, a build, a deploy, Git, another machine or a
  wait loop); the command itself never leaves the machine;
- the agent silent for two minutes with no tool call open shows as "no word";
- **may be stuck**, `idle`: a tool call open while nothing the commands run
  has used CPU and the agent has said nothing for 10 minutes, or for 3 minutes
  while a command it started earlier has sat idle for 10 (a wait loop on a
  review waiting for input, say);
- **may be stuck**, `silent`: no tool call open and no word for 10 minutes.

Nothing is called idle without a process reading. A sign is not a verdict and
nothing is stopped: the conversation shows "May be stuck" with what was seen,
it joins the owner's move until the step moves again, the owner gets one push
notification for it, the runner records `turn_stuck` (reason `commands_idle`
or `agent_silent`), and a helper is told once, at its next step, to stop
anything waiting for input or say what it is waiting on. Stop ends the turn as
usual.

## Jev shadow checks

`runner/run-checks.ts` asks the machine's Jev selector (see
[context-selection.md](context-selection.md)) two kinds of yes/no question
whenever context selection is on (`select` or `shadow`), and only records the
answers:

- before each dispatch, for each finished helper (up to eight), whether its
  report already answers everything the new brief asks for;
- at each helper progress note, whether that helper's recent notes (up to six)
  show it progressing, repeating steps, waiting on something outside its own
  work, or blocked.

Jev sees the brief, the helpers' summaries and checks, and the notes' done,
remaining and your-move lists; never commands, tool output, paths, sessions
or evidence lines (owner's approval, 19 October 2026). Requests use context
selection's key, gateway, request limits and failure diagnostics, tagged
process `run-checks` with trigger `dispatch-check` or `progress-check`. Each
judgment is a private receipt in the runner state's `run-checks/` (newest
1,000) with the helper it concerns, its inputs, probabilities, tokens and
latency, never in snapshots or telemetry; logs count `jev_check_judged` and record `jev_selection_failed`
with these triggers. Nothing acts on a judgment: the master and the owner see
no difference until labelled conversations validate a threshold, as the 0.5
cutoff was validated for project review. `npm run context:replay -- checks`
labels and scores them (see the quality loop in
[context-selection.md](context-selection.md)).

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
- follow a Claude background task with Monitor or by reading its output
  file, and stop it with TaskStop;
- query the exact CI/deploy run directly, with bounded polling and network
  requests, and stop at success, failure or cancellation;
- wait on the process ID they started, never a name search: `pgrep -f`
  matches the waiting loop's own command line, so that loop never ends;
- inspect local commands with no new output or CPU use for five minutes;
  remote CI/deployment needs a remote status check before calling it stuck;
- stop or finish every background command before returning a result.

After a read-only recovery inspection, the inspected session is retired from
execution reuse. Its report and owned worktree remain available; a fresh
session continues any changes. Follow-up briefs target the remaining gaps:
when only the work record is unfinished, they update and read back that record
without repeating already verified delivery.

## Waits and signs of a stuck step

`runner/turn-watch.ts` follows each native turn: the tool calls it has open,
when the agent last said anything (tokens, a progress note, a plan), and,
every 30 seconds, the CPU time of the processes its commands run (whatever a
shell under the agent starts, without the shells and sleeps themselves; the
agent and the servers it starts directly, such as its browser's, are not
commands). It publishes `live.watch`, times and categories only:

- a tool call open for two minutes shows as a wait, with what a command waits
  on as a category (a review, CI checks, tests, a build, a deploy, Git,
  another machine or a wait loop) from local rules on the command; only the
  category reaches the overview;
- the agent silent for two minutes with no tool call open shows as "no word";
- **may be stuck**, `idle`: a tool call open while nothing the commands run
  has used CPU and the agent has said nothing for 10 minutes, or for 3 minutes
  while a command it started earlier has sat idle for 10 (a wait loop on a
  review waiting for input, say);
- **may be stuck**, `silent`: no tool call open and no word for 10 minutes.

Nothing is called idle without a process reading. A sign is not a verdict and
nothing is stopped: the conversation shows "May be stuck" with what was seen,
it joins its owner's move until the step moves again, the conversation's owner
gets one push notification for it, the runner records `turn_stuck` (reason
`commands_idle` or `agent_silent`), and a helper is told once, at its next
step, to stop anything waiting for input or say what it is waiting on. Stop
ends the turn as usual.

## Current work and conversation measures

The coordinator's dispatch choices are limited to repositories registered on
its machine and the available helper apps, within the conversation's selected
scope. If the runner rejects the coordinator's dispatch decision, Projects
shows that it is retrying the handoff; no helper started for that decision.

Today and the canonical conversation index distinguish current conversations
from Done history. Local runner journals keep the last execution result and
are not the current-work list. Reviews must reconcile the live current and
Done lists by conversation ID before reporting blockers. Done labels historical
results as Done, removes them from waiting counts, and refuses queued, running
or stopping work until its machine confirms it stopped. Sending a new message
explicitly reopens a finished conversation.

Conversation Details and list summaries carry request-to-first-reply and
latest-request-to-reply time, follow-up messages, helper count, native turns
with reported usage, and fresh/cached/output tokens. Reply times come from
message timestamps, not archival or heartbeat timestamps. Follow-ups include
approvals and new requests, so they are not automatically classified as
corrections or failures. Replies may report blockers; completion and customer
acceptance still require their own evidence. Historical usage coverage may be
partial. These measures do not clip cumulative session counts to a day.

A coordinator's session is sent its brief and the active work once. A
follow-up sends the brief again only when its instructions or its project
changed, and only the active-work entries that changed; an
observation merely taken again is not a change. Reply, progress and browser
instructions, and a helper's standing rules, reach a native session once, and
again after it compacts or they change. Routine
drafts delegate source reading, drafting and saved-draft verification together;
wording revisions reuse the same helper and verified facts where appropriate.

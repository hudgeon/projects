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

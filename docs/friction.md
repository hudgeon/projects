# Friction receipts

What the native Claude Code and Codex sessions on a machine ran into, counted
on that machine by fixed rules, so the upkeep work in `docs/upkeep` (on its
epic branch) has evidence rather than impressions. Nothing from a transcript
leaves the machine.

## What is counted

`collector/friction-claude.ts` and `collector/friction-codex.ts` project each
transcript record onto these categories (`src/friction-model.ts`):

| Category | Claude Code | Codex |
| --- | --- | --- |
| prompts | user messages that are not tool results | `UserMessage` items |
| tool calls | `tool_use` blocks | command, file change, MCP and other tool items |
| failed commands | Bash results marked as errors | commands that failed or exited non-zero |
| failed tool calls | other tool results marked as errors | other tool items that failed |
| denied tool uses | a rejected permission decision, or a denial in the result | items declined |
| hook blocks | a hook blocking a tool call | — |
| hook failures | stop-hook errors, hooks exiting non-zero | — |
| tool misuse | the tool refusing its own misuse (unread file, oversized read, invalid input) | — |
| API errors | `api_error` records (each retry is one) | `error` events |
| compactions | compaction boundaries | compaction items |
| repeated commands | a command run a third time in one session | the same |
| interruptions | interrupted tool calls | aborted turns |

A count is what the transcript shows, not a verdict on whose fault it was: a
failed command may be a test that correctly failed. The categories are the
evidence; thresholds and what to do about them belong to the upkeep cycle.

## Session weight

Each parser also reads how many tokens each model call carried: for Claude Code
a top-level call's input with what it read from and wrote to the cache
(subagent calls apart), for Codex the last call's input as each `token_count`
event reports it. A session's **start** is its first call and its **peak** its
largest. `collector/friction-weight.ts` turns these into medians by day, app
and source, the way a session was launched:

| Source | How it is known |
| --- | --- |
| desktop app | the session's client names a desktop app |
| Projects coordinators, Projects helpers | the runner's journal named the session as one; kept on the receipt once seen, since a journal forgets a coordinator that handed over |
| Projects, role not recorded | a Codex session the runner started that no journal named while the collector looked |
| command line | everything else, scripted `-p` runs included |
| all sessions | every measured session of the app |

A session with no model call has no weight and is not in the medians. A
session counts on the day of its last activity, as its friction does, so a
long session's start can be days older than its row. A receipt written before
weight was read is counted again from the start of its transcript, within the
scan's budget, so a machine's first hours on a new collector show medians of
the sessions read so far.

## Receipts

Each session has one receipt under the machine's state directory,
`friction/<app>/<session id>.json`, mode 0600: the counts, the app version the
session ran, its client (desktop, CLI or SDK), its folder, first and last
activity, its start and peak tokens, its role when Projects ran it, the bytes
of the transcript already counted and the parser's carry-over. Each scan (`collector/friction.ts`, run from the collector's entry
point) lists the transcripts (`~/.claude/projects/*/*.jsonl` and
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), reads only the bytes each one
appended since its receipt, newest first, within a budget of 60 files and
64 MB a scan, and leaves the rest for the next scan two minutes later. A
transcript that shrank is counted afresh. Receipts of sessions idle for 90 days
are removed once they are that old themselves, and transcripts not touched in
that long are never read.

Each scan also writes `friction/weight.json` there, mode 0600: the weight
medians exactly as the snapshot carries them, with the time of the scan. It is
what `home doctor`, or any local check, reads without signing in to anything.

`collector/friction-runner.ts` links a session Projects ran to its
conversation and helper from the runner's journals, with the runner's events
for it (hand-backs, stuck and overrun turns, limits) and how often Jev rated
the helper repeating itself or blocked, as counts.

## What leaves the machine

The snapshot's `friction` field (`frictionSnapshotSchema`) carries, for the
last fourteen UTC days, each app's sessions last active that day and their
counts added, the versions the newest session of each app ran with, and a
newer Codex release when the app itself has seen one. Its `weight` carries, by
app and source, the number of measured sessions and their median start and
peak tokens: a row for each of those days, and the same over the last seven.
Settings shows the versions, a seven-day friction line and the seven-day
weight under each machine, with each day's weight behind it. Each machine's
numbers are its own sessions, as its own collector last sent them: they are
not added across machines, and a machine that is asleep or away shows what it
last sent, marked with how long ago. No session id, folder, command, prompt or
output is in it.

## Reading a machine

```sh
npm run friction -- --since 7d --top 10
```

prints the machine's per-day totals by app, each app's total, the seven-day
session weight, and the sessions
with the most friction, each with its id (to open the transcript), folder name,
version, client and, when Projects ran it, the conversation, helper and events.
`--dir` and `--state` point it at copied receipt and runner-state folders.

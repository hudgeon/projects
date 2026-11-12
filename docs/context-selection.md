# Context selection

Code chooses each turn's context; no model judges it. Project review runs
locally in the conversation's executor before each coordinator, helper and
recovery turn, and a fresh coordinator's handover is rebuilt by fixed rules
(below). TypeSafe's Jev rated the shortlist until November 2026. Of 178 turns
that went on to read or change project files, its selection held one of those
files in 82 and retrieval order in 85, so it was removed.

`runner/context.ts` owns the rebuilt handover. `runner/project-context.ts`
owns project review, `runner/project-turn.ts` its receipts and wiring into
turns, `runner/project-sources.ts` which files may be read and how, and
`runner/project-units.ts` natural units and their ranking.

A handover is rebuilt by code alone: the exact first and newest user
instructions within 8,000 characters, each agent reply one of them answered
(verbatim, newest first within 24,000 characters), the latest reported
position and one line for every child (who, where, its state and branch, the
pull request or commit observed and its report's first sentence). The linked
work issue's Current position and the plan it points to reach the fresh
coordinator through the project review below. Earlier agent replies and
helper reports are not replayed: the conversation's private context file and
its index name every message and the journal that keeps every report. A kept
proposal never grants permission or proves delivery. Omitted
instructions/proposals still require reading the exact source before acting;
the rebuild never deletes a source or alters native session history.

A selected project's first turn has project evidence even with no conversation
history. Before a coordinator turn the runner reviews the selected project (or
the most recent child's project); a conversation choosing its first project
still routes from the registry. Before a helper starts, review uses its actual
prepared workspace. Recovery inspection remains read-only.

A linked issue's `Current position` is retained separately before applying
the full-body size limit. The agent receives up to 2,000 characters of this
section, its issue link and source status. An over-budget section keeps
complete fields, prioritising status, the evidence cutoff and the next
action, and is marked partial. The private receipt records its hash and
length. To investigate history or omitted detail, use the issue link to read the relevant sections or exact
comments and verify the date and any superseding decision.

Project review splits every eligible text source (markdown, code, YAML and
`package.json`) into natural units: markdown sections at headings, YAML
records (list items and nested blocks at column 0 or one level beneath a
top-level key, each with the comments directly above it and labelled by its
key; other top-level lines start a unit after a blank line, as in code),
code's top-level statements (imports dropped), and the linked work issue's
five newest comments. A work issue without a `Current position` still
contributes eligible body sections. Recent comments carry their GitHub
links. Small neighbours merge and long units split at
paragraphs, then lines, up to 1,200 characters each; a YAML value is cut only
where its line is longer than that. BM25
ranks the units by the brief's opening 1,000 characters (a brief states its
subject first; delivery wording follows) and the user's instructions. The work
issue, the plan and files the brief names lead with up to four units each, and
no source supplies more than eight. The best 40 units form the shortlist the
receipt indexes; code supplies the best of them, in retrieval order, within
the 6,000-character budget. Repository instructions are retained separately
and are never dropped for relevance. An instruction file the turn's own app
loads (the `AGENTS.md` of its working folder and of the folders above it, up to 32 KiB) is named, not sent: a
helper's in its workspace, a coordinator's where it runs. The agent is told to
read any named file it does not hold, should an app stop loading it (both
did in November 2026: Claude Code 2.1.304, Codex 0.162.1). Any other is sent
once to a native session, and again only when it changes or the session
compacts its history. The review records
full-file hashes, character offsets, retrieval scores and missing/partial
coverage; it is a bounded relevance selection, not a code review or proof of
completion. Agents read applicable repository instructions. For routine work
they use headings or search to locate the plan sections governing the task
and read those ranges. A narrow evidence check can finish at the verified
original. A task spanning the whole plan can require reading it in full.
Older evidence is retrieved by source link for a specific question, with
the dated original and any relevant superseding decision checked before citation.
People, legal, HR and personnel folders, documents and YAML files,
hidden folders (including `.github`) and ignored files, secret-named paths,
generated lockfiles, recognizable credential content, links outside the
project and binary content are not supplied. In YAML, recognizable credentials
also include unquoted password, secret, token and API, access or private key
values of 12 or more characters on the key's line or the next
(interpolations and environment variable names are references), and
Kubernetes Secret manifests; code is not checked this way because its unquoted
values are expressions. A credential-like file is excluded in full. Oversized
or unavailable sources remain explicit gaps.

An unchanged view already supplied to the same native session is referenced
without reinserting its text; fresh native sessions, and one that compacted
its history, receive the view. What each session holds is kept beside the
conversation's journal. Project receipts live under the runner state
directory's `project-context/reviews/` (Quality loop below) and never enter
portfolio snapshots or telemetry. Feedback arriving during review discards
the stale action; a prepared workspace survives an update without replaying
work. Source failures keep retrieval pointers. Cancellation during review
starts no native turn.

Each handover keeps a private index beside the conversation's context file:
a source-version hash, its messages and helpers, and the journal that keeps
every report.

## Quality loop

Every project review keeps its own private receipt in the runner state
directory's `project-context/reviews/`, named by its time; the newest 1,000
within 180 days are kept. The receipt records what the review read (the task,
retrieval query, the instructions retrieval used, project, plan, workspace,
commit and linked work issue) and what it did: the considered and supplied
units. After the native turn it served, the receipt also records the project
files that turn read or changed, as relative paths and the line ranges read;
never file text, commands or output. Claude reports them through its Read,
Edit and Write tools, Codex through its own parse of each command and its
applied patches; files read by other shell commands are not seen. Files
outside the project are only counted. A change to retrieval can be measured
against what turns used.

`npm run prompt-weight` measures everything a native turn is sent, not the
review alone. It replays this machine's stored conversations (their messages,
helpers and reports as recorded) through the engine with stand-in native
turns, on the checkout's code, and prints the prompt characters per native
turn, for new and resumed coordinator and helper sessions (`--limit N`, the
newest 30 by default, or `--all`). It starts no agent or worktree, calls no
GitHub, and links no work issue. A change to what the runner sends each turn
carries its before and after.

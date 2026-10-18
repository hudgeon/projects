# Context selection

Optional Jev context selection runs locally in the conversation's executor.
Conversation-history selection runs when a fresh coordinator is about to start;
project-context review is checked before each coordinator, helper and recovery
turn. Set `context.mode` in the
machine config to `select`, `shadow` (evaluate without changing the prompt),
or `off` (the default). The executor reads `JEV_API_KEY` from that machine's
Doppler config through its existing read-only service token the first time it
needs it and keeps it in memory for its lifetime; a failed read is retried at
the next selection. No key enters the Worker, collector, agent environment or
repository. Enabling a new
consumer requires the deployment owner's credential and data-scope approval.

For AI Gateway cost reporting, set `context.gateway` to an object with the
deployment's `accountId` (32 lowercase hexadecimal characters) and `gatewayId`.
In that account, configure the custom provider with slug `typesafe` and base
URL `https://api.typesafe.ai`. Requests use its native `/v1/systemone` path,
tagged as process `context-selection`, trigger `coordinator-rotation` for
conversation handovers or `project-turn` for project reviews, and worker
`projects-runner`. The pinned model's input-token rate is supplied as custom
pricing; output tokens are free. Payload logging, gateway caching and retries
are disabled for these requests; usage/cost metadata remains available. The
existing provider key stays in executor memory. If the gateway fails, context
falls back to the deterministic view without retrying the provider directly.
With no gateway configured, requests use the direct TypeSafe endpoint.

Failed Jev selections retain a bounded `failure` diagnostic in the private
project receipt or conversation `.view.json` and emit `jev_selection_failed`
in the runner's structured logs. It distinguishes key access, request, response
body and validation stages, with total/stage timings, the eight-second request
deadline, request size, candidate count, HTTP status, and allowlisted network
error codes (including nested causes). Timeouts, DNS, connections, TLS, sockets,
invalid JSON/schema and missing answers have separate categories. A generated
`selectionId` also goes into gateway metadata, allowing correlation even when
the client receives no response. Validated gateway log IDs, UUID request IDs
and Cloudflare Ray IDs are retained when returned. Diagnostics contain no
prompts, source text, key values, URLs, raw exceptions or response bodies;
unknown codes and malformed IDs are discarded. User cancellation still
propagates without a misleading failure log or a fallback native turn.

`runner/context.ts` owns the deterministic conversation view and shared Jev
transport. `runner/project-context.ts` owns project review and its wiring into
turns, `runner/project-sources.ts` which files may be read and how, and
`runner/project-units.ts` natural units and their ranking.

For handovers, code retains exact original/recent user instructions, their preceding proposal
exchanges when they fit, the latest position and every child's execution and
evidence index. Jev judges only optional older agent replies and completed
child reports, keeping selected text verbatim. The latest child and unresolved
children keep their full reports. A probability never grants permission or
proves delivery. Omitted instructions/proposals still require reading the
exact source before acting; the selector never deletes a source or alters
native session history.

A selected project's first turn has project evidence even with no conversation
history. Before a coordinator turn the runner reviews the selected project (or
the most recent child's project); a conversation choosing its first project
still routes from the registry. Before a helper starts, review uses its actual
prepared workspace. Recovery inspection remains read-only.

Project review splits every eligible text source (markdown, code, YAML and
`package.json`) into natural units: markdown sections at headings, YAML
records (list items and nested blocks at column 0 or one level beneath a
top-level key, each with the comments directly above it and labelled by its
key; other top-level lines start a unit after a blank line, as in code),
code's top-level statements (imports dropped), and the linked work issue's
body sections and five newest comments. Small neighbours merge and long units split at
paragraphs, then lines, up to 1,200 characters each; a YAML value is cut only
where its line is longer than that. BM25
ranks the units by the brief's opening 1,000 characters (a brief states its
subject first; delivery wording follows) and the user's instructions. The work
issue, the plan and files the brief names lead with up to four units each, and
no source supplies more than eight. Code packs 20–40 candidates into one Jev
request, one Noul question per unit over shared state: the task, the original
and newest instructions up to 8,000 characters with the task, and the
candidates. Repository instructions are retained separately, outside the
request, and are never removal candidates. Code supplies the units Jev rates
at or above 0.5, best first, within the 6,000-character budget; shadow mode and
failures supply the retrieval order within the same budget. The review records
full-file hashes, character offsets, retrieval scores and missing/partial
coverage; it is a bounded relevance selection, not a code review or proof of
completion. Agents still read applicable instructions and the complete relevant
plan. People, legal, HR and personnel folders, documents and YAML files,
hidden folders (including `.github`) and ignored files, secret-named paths,
generated lockfiles, recognizable credential content, links outside the
project and binary content are not supplied. In YAML, recognizable credentials
also include unquoted password, secret, token and API, access or private key
values of 12 or more characters on the key's line or the next
(interpolations and environment variable names are references), and
Kubernetes Secret manifests; code is not checked this way because its unquoted
values are expressions. A credential-like file is excluded in full. Oversized
or unavailable sources remain explicit gaps.

The 0.5 cutoff was validated on 15 real project turns from two machines,
replayed at their recorded commits and labelled by hand (October 2026). At
0.5, 90% of supplied units were relevant to the task (25% for the previous
keyword windows), giving about 2.5 times as much relevant text per turn in
fewer characters; lower cutoffs added mostly off-topic units and higher ones
dropped relevant ones. With the key in memory, the Jev call took a median of
0.4 seconds, against 1.8 seconds when each call read the key from Doppler.

Before each turn, the task, instructions, model/policy, workspace and the
judged units' exact text and offsets validate the private cached judgment.
Repository instructions, source gaps and edits elsewhere in the project reach
the prompt fresh without a new judgment. A changed input causes a new gateway
review. An unchanged view
already supplied to the same native session is referenced without reinserting
its text; fresh native sessions receive the view. Project receipts live beside
the private run journal; cache records live under its state directory's
`project-context/`. They never enter portfolio snapshots or telemetry. Feedback
or changed sources arriving during review discard the stale selection/action;
a prepared workspace survives an update without replaying work. Service or
source failures retain deterministic evidence and retrieval pointers.
Cancellation during review starts no native turn.

Each handover keeps a private full source index and selection receipt beside
the conversation's context file. They record a source-version hash, exact model,
raw probabilities, usage, latency and transport; changed evidence invalidates cached
judgments. The model is pinned to `jev-1.14.0`; optional handover detail is
omitted only at relevance probability at most 0.05, validated on the synthetic
evaluation. Requests are checked against the model's documented limits (64k
tokens per request, 32k for the state with any one question), counting UTF-8
bytes as an upper bound on tokens. An oversized request is never silently
abridged. Missing credentials, invalid
or incomplete answers, timeouts and service failures use the deterministic
handover and preserve retrieval. Cancellation still stops the turn.

To repeat the synthetic evaluation, inject the approved evaluation key as
`API_KEY` or `TYPESAFE_API_KEY` and run
`npm run context:evaluate -- --live`. Add `--machine` to use the machine's
existing key and configured gateway. The command writes
`.wip/jev-context-evaluation.json` with retained-evidence coverage, character counts, actual API input/output
tokens and latency, and estimated cost at the documented model rate. These
measurements do not establish production savings or native-agent accuracy;
those need ordinary-use measurement. No customer history is used by this script.

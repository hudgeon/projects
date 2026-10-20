# Codex speed

Settings has an owner-wide **Codex fast mode** switch, initially off. Every
Projects Codex coordinator/helper reads it before its next turn, resumes and
recovery included; an active turn is not interrupted. The app-server receives
explicit `fast` or `default` service tiers, with model and reasoning unchanged.
Claude and sessions outside Projects are unaffected. Fast mode uses more
allowance; see [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed).

The same page compares labelled Codex turns from the last 30 days (up to
10,000): deduplicated completion receipts the portfolio keeps apart from the
conversation's bounded event window, with requested speed, resolved
model/effort, attempts, token counts, elapsed time and first text latency when
observed. Comparisons match role, read/change, new/continued, machine, token
bands and cache share, and need at least three completed single-attempt turns
per mode for a median percentage; failures, missing measurements and earlier
unlabelled turns never become a standard-mode baseline. Total time includes
native startup and tool work; first output can include reasoning/tool waits.
These are workload observations, not a benchmark or proof of the provider's
processing tier. No synthetic timings enter production.

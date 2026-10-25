# Session capacity

Every runner has one shared ceiling, `concurrency` in `machine.json`: 1–11
conversations, default 9. Standard, quick and upkeep work can use any free
place. There are no reserved places or extra pools. Lane labels still choose
the appropriate instructions and preserve compatibility with older runners;
they do not imply memory cost or grant priority. Existing queue order is kept.
Each conversation runs one native turn at a time, with its tools and helpers.

Nine preserves the former default total (3 standard, 5 extra quick and 1
upkeep), while allowing standard sessions to use that entire capacity. Tune
the ceiling against representative workloads; it is a ceiling, not a promise
that the machine can sustain that many heavy tasks.

On macOS the runner checks the kernel's system-wide memory pressure at most
every five seconds. This includes other apps, Teams browsers and the whole
agent/tool process trees, rather than only the runner's memory or free RAM.
Ten seconds of warning pressure pauses new starts; critical pressure or an
unreadable observation pauses them immediately. Thirty seconds of observed
normal pressure reopens admission. Running work is never cancelled to reclaim
memory. Healthy work may fill the pool again, up to the ceiling.

The runner continues checking in and serving opened documents while full or
paused. Empty offered lanes do not recover a saved reservation or start work;
the same reservation remains available when admission reopens. Executors
adopted across an update count against the shared ceiling, including when an
older runner left more running than the new ceiling permits.

Local runner logs record `runner_admission_changed` with `admission` (`open`
or `paused`) and a bounded `memoryPressure` category. No process commands,
paths, transcript content or raw OS errors enter these events or snapshots.
On other operating systems the shared ceiling still applies; logs report
`unsupported` and there is no automatic pressure protection.

Older configs with `quickConcurrency` remain readable: the shared ceiling is
the old `concurrency` (default 3) plus `quickConcurrency` plus 1 for upkeep.
To adopt the new format, set `concurrency` to that total and remove
`quickConcurrency`. With neither field the shared default is 9. Configuration
changes take effect at runner restart; an update keeps existing executions.

This admission guard limits additional load; it does not fix a leaking process
or stop a running task whose memory grows. Compare pressure, swap growth and
idle baselines over ordinary use before claiming a performance improvement.

---
name: install-machine
description: Use right after a deploy whose release changes the collector or runner bundles, to install them on each connected machine.
---

# Install the released bundles on a machine

Run `node scripts/install-machine.mjs` from a checkout of the released commit on each connected machine.

- It builds the bundles from that checkout, records the commit in `release.json` beside them, keeps the machine's config and tokens, and sends a running runner `SIGUSR2`: it restarts at once while each executor finishes its current step on the old version; a stopped runner is kickstarted.
- It prints what is installed and whether the runner runs on it; a runner that keeps exiting logs `runner_config_invalid` with the rejected key.
- The owner's standing approval covers this restart; do not wait for idle.
- A machine that is away gets the release on return.

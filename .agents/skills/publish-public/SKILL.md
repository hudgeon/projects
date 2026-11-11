---
name: publish-public
description: Use after a verified Deploy to copy main's tree to the public remote with scripts/publish-public.mjs.
---

# Publish the public copy

`node scripts/publish-public.mjs` copies main's tree, less the security-review gate files (synced from elsewhere), to the `public` remote as one commit.

- It needs `publish.name`/`publish.email` in Git config and the untracked `.git/info/public-deny` list, refusing while a listed term appears.
- A checkout without them leaves publishing to one that has them.
- The two delivery callers (`.github/workflows/ci.yml`, `auto-merge.yml`) are published and name `receipting/agent-config`; a deny list that holds that organisation's name refuses the publish.

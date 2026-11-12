# Projects

A private overview of the owner's repositories across their connected machines, with Mark done, optional inboxes, and master conversations that delegate native Claude Code and Codex work to those machines. Today is where people work, on phone and desktop: keep it minimal and plain.

## Read first

- `README.md`: architecture, machines and `machine.json`, evidence limits, security, development, releases. `docs/self-host.md`: running a fork.
- `docs/agents/access.md`: machines and duty, sign-in, people, machine tokens, conversation browsers, claims.
- `docs/agents/work-and-messages.md`: work items, inboxes, Slack and Teams, shared support.
- `docs/agents/conversations.md`: conversation ownership and recovery, the `upkeep` lane.
- Skills in `.agents/skills/`: `publish-public` (the public copy), `install-machine` (bundles on each connected machine).

## Commands

- Check `npm run typecheck`, `npm test`, `npm run build`, `npm run collector:build`, `npm run file-sizes:check`, `npm audit --audit-level=high`. Preview ports 5278/8798.

## Invariants

- `src/model.ts` owns the snapshot contract and health meanings. `collector/collect.ts` owns native source reads. Never infer clean/complete from a failed, truncated or stale observation.
- Codex unarchived task != running task or open app window. Claude process != current turn. Preserve evidence and coverage labels.
- Source project progress from canonical plans and GitHub. Do not invent progress percentages or create a second backlog.
- No auth bypass in production.
- Mark done and inbox linking queue only issue/thread IDs; the Worker holds no GitHub credential. The machine on duty closes work or adds the exact email link with its signed-in `gh`; any App token stays read-only. Linking never marks a message reviewed. Inbox Archive/Unsubscribe/link are requests only the inbox's owner makes (`worker/inbox.ts`), applied with that account's `gws` sign-in on the machine on duty; one-click unsubscribe only to public HTTPS hosts. Done on an activity never archives email.
- Runtime secrets stay in Doppler; never store transcripts, tool outputs, credentials or diffs in snapshots.
- Deployment identity is configuration: repository variables that Deploy writes into `wrangler.jsonc` (which holds placeholders), and each machine's `machine.json`. Code, tests, docs and agent-facing prompts name no owner, organisation, domain, repository, machine or connected tool; forks follow docs/self-host.md. The one exception, `.github/workflows/auto-merge.yml`, calls the organisation's shared arming workflow by name and is left out of the public copy.
- This code is public. Keep customer names, real contacts, credentials and other private data out of every file, tests included.
- Push notifications go to the conversation owner's devices, carry no payload and go only to browser push services; devices fetch the notice with their own session.
- `src/run-text.ts` owns how agent text is shown (titles, status lines, documents); it only removes protocol residue and never invents progress or verification.
- `collector/friction*.ts` derives friction from native transcripts by fixed local rules. Receipts (counts, versions, cwd, session ids) stay in the machine's state directory; snapshots carry only per-day totals by app, median start and peak tokens by app and source, and the versions seen. Never let transcript text, commands, paths or output into a field that leaves the machine.
- `src/telemetry.ts` owns safe logging/receipt fields; `worker/telemetry.ts` owns Cloudflare spans. Keep prompts, native output, paths and raw exceptions out of telemetry. Preserve correlation IDs and sampling labels; logs never prove execution success.
- Project names and canonical plan links belong in repository-local `.project-overview.json`; identity must survive path moves. See public/agents.md. Snapshot replacement removes moved/deleted entries without deleting native sessions.

## Delivery

- Merging: a PR that is not a draft is armed by the review App and merged by main's merge queue once `ci` and `security-review` pass; keep a PR a draft to hold it.
- Production release: a merged PR with `ci` passed (plus the security review when `.github/release-policy.json` requires it; `.github/scripts/release-checks.mjs`), then manual Deploy on main with project-scoped Doppler OIDC. Runtime secrets stay limited to secrets.required.
- After each verified Deploy, publish the public copy (`publish-public`). When a release changes the collector or runner bundles, install them on each connected machine right after the deploy (`install-machine`).

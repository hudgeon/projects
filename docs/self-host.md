# Self-hosting Projects

Projects is a private site you run on your own Cloudflare account. It shows your
repositories and lets you start conversations from a phone or desktop. The
actual work runs on one or more machines you own: a master agent hands each
task to Claude Code or Codex sessions there, and those sessions use your own
logins and subscriptions. The site never holds a GitHub, model or mailbox credential.

This repository receives one commit per release. Nothing in it names a
deployment: your copy supplies its own values below. It is MIT licensed.

## What you need

- A domain on Cloudflare DNS, and a Cloudflare account for the Worker, its
  Durable Objects, Browser Rendering and Email Service. Check Cloudflare's
  current plan limits for those products.
- A GitHub account or organisation for your copy of this repository.
- A Doppler account for runtime secrets and deployment.
- At least one machine that stays on and signed in, with Node 24, Git, the
  GitHub CLI (`gh`, signed in), and Claude Code and/or Codex signed in. Claude
  alone is enough. The installer sets up background services on macOS; other
  systems run the same two scripts with their own service manager.

## 1. Name your deployment

The repository names no deployment: `wrangler.jsonc` holds placeholders, and
the Deploy workflow fills in your route and vars from these GitHub Actions
variables on your copy of the repository.

| Variable | Meaning |
| --- | --- |
| `PROJECTS_HOST` | Your site's host name, such as `projects.example.com`, on a domain in your Cloudflare account. |
| `PROJECTS_PORTFOLIO` | Any stable short name for your portfolio; changing it later starts empty. |
| `PROJECTS_OWNER_EMAIL` | The owner's address. Sign-in uses `ALLOWED_EMAILS`; conversation browsers on machines in `PROJECTS_BROWSER_SIGN_IN` start signed in as this address, which must also be allowed. |
| `PROJECTS_EMAIL_FROM` | The sender for sign-in codes, on a domain set up in step 2. |
| `PROJECTS_TIME_ZONE` | Legacy daily-brief setting, retained for deployment compatibility; no longer affects the workspace. |
| `PROJECTS_BROWSER_HOSTS` | Optional. Exact host names, comma separated, that conversation browsers may reach besides your site, such as `mockups.example.net`; at most ten, no wildcards. Unset, browsers reach only your site. |
| `PROJECTS_BROWSER_SIGN_IN` | Optional. Machine IDs, comma separated, whose conversation browsers start signed in to your site, so their agents never wait for you to enter a code; at most ten. Each browser gets its own session, which ends when that browser closes; it cannot change machines, open other browsers, read or act on email, or change how agents run. Removing the machine in Settings revokes its browsers at once; removing its ID does so at the next Deploy. Unset, every browser signs in by hand. |
| `SECURITY_REVIEW_BOT_ID` | The id of a bot whose passing `security-review` status each release needs, or `none`. `none` needs `"securityReview": "optional"` in `.github/release-policy.json`, changed by a reviewed pull request. |

## 2. Set up email sign-in

Sign-in codes go out through Cloudflare Email Service (the `EMAIL` binding).
Choose one:

- **Free, any plan:** in Cloudflare Email Routing, enable routing for a
  subdomain such as `notify.example.com`, then add and verify each address in
  `ALLOWED_EMAILS` as a destination address. Cloudflare sends to verified
  addresses at no cost. Use a subdomain so mail to your main domain is
  untouched.
- **Any recipient (Workers Paid):** onboard the sending domain to Email Sending
  (`npx wrangler email sending enable notify.example.com`). Recipients then need
  no verification.

Set `EMAIL_FROM` to an address on that domain, such as `projects@notify.example.com`.

## 3. Create secrets in Doppler

Create a project named `project-overview` with a `prod` config holding:

- `ALLOWED_EMAILS`: comma-separated addresses that may sign in.
- `VAPID_PRIVATE_KEY`, for push notifications:
  `node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(({kty,crv,x,y,d})=>console.log(JSON.stringify({kty,crv,x,y,d})))"`
- `CLOUDFLARE_API_TOKEN` (Workers deploy rights) and `CLOUDFLARE_ACCOUNT_ID`.

Machines need no Doppler access: the collector reads GitHub through each
machine's signed-in `gh`. To use a read-only GitHub App instead, put
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in a Doppler config, add
`"doppler": {"project": "…", "config": "…"}` to the machine's `machine.json`,
and store a read-only service token for that config in
`~/.local/share/project-overview/doppler-token` (mode 600). The same config
can also hold the machine's tokens (step 5).

## 4. Deploy from GitHub

1. Push your copy of the repository to GitHub.
2. In Doppler, create a service account identity for GitHub OIDC with read
   access to `project-overview/prod` only, limited to your repository, its `main`
   branch and a `production` environment.
3. In the repository, create the `production` environment and set the Actions
   variable `DOPPLER_IDENTITY_ID` to that identity.
4. Set the variables from step 1.
5. Merge a pull request with CI passing, then run the **Deploy** workflow on
   `main`. It checks the merged pull request, CI and, unless
   `SECURITY_REVIEW_BOT_ID` is `none`, that bot's review before deploying, then
   verifies the live version.

## 5. Connect each machine

On the site's **Projects** page, name a machine under **Machines**. The site
shows its id and two tokens once: a collector token, which only uploads what
the machine observes, and a runner token, which runs conversations. Then, in a
checkout of this repository on that machine:

```bash
npm ci && npm run collector:build
```

```bash
node scripts/install-machine.mjs --machine studio --endpoint https://projects.example.com --root ~/code --agents claude
```

It asks for the two tokens without echoing them, writes the machine's config
to `~/.local/share/project-overview/machine.json` and its tokens beside it,
readable only by you, installs the bundles, and starts the collector and
runner as background services. Run it again after each release; the config
and tokens are kept. Options:

- `--agents`: the apps signed in on this machine, such as `claude` or
  `claude,codex`. Conversations never start an app that is not listed.
- `--work-repo owner/repo` (optional): a repository whose issues labelled
  `work` are your work items. Without it, work items and Mark done are off.
- `--inbox you@example.com` (optional): a Gmail account read through `gws`.
  Email replies also expect a `compose-email` skill in the work repository.
- `--collector-label`, `--runner-label` (optional): launchd labels for the two
  services, when they should differ from the defaults. They are kept in
  `machine.json`, so later runs restart the same services.
- `--hooks`: also link Claude and Codex sessions to work items.
- `--new-tokens`: replace the stored tokens after **Replace tokens** on the
  site.

To keep the two tokens in Doppler instead of files, store them as
`COLLECTOR_TOKEN` and `RUNNER_TOKEN` in the machine's Doppler config (step 3)
before installing. The installer then checks both names are there and writes no
token files. The collector runs with only its own token and the GitHub App's
secrets, and the runner reads its token once at start. A token file that
already exists, or that `machine.json` names, still takes precedence. Replace
tokens in Doppler after **Replace tokens**, then restart the runner.

Helpers can use the apps' connectors, except to send email. To also let Claude
helpers use local MCP servers you already run, list their names under
`helpers.localServers` in `machine.json`, and any of their tools to withhold
under `helpers.deniedTools`; then run the installer again.

An explicitly trusted execution machine can set `helpers.fullAccess: true`.
Its change helpers get Claude's complete installed native toolset and
`bypassPermissions`, or Codex's `danger-full-access` with approvals disabled.
All configured local MCP servers are enabled and approved; Claude's local
server/tool filter is removed. This grants local filesystem, network and
native tool access beyond the assigned worktree. It uses existing logins;
it does not create credentials or make an expired login work. The coordinator
and recovery inspections remain read-only. Email sending still needs the
owner's explicit message approval; connector send tools stay withheld. Task
scope, customer/financial approvals and required release checks still apply.
Set it back to false and restart the runner to restore restricted sessions;
existing executors finish their current step before adopting the change.

Repositories under `--root` opt in with a `.project-overview.json` file (see
`public/agents.md`), or by name under `projects` in `machine.json`. Machines
are ordered on the Machines page: the first one heard from recently holds the
shared duties and takes new conversations, and a conversation stays on the
machine that started it unless you continue it elsewhere while that machine is
away. The services need you logged in after a restart.

## 6. Use it

Open your site, sign in with an allowlisted address, and start a conversation.
In the composer choose Claude as the master once; the site remembers it on each
device, and a machine without Codex runs Claude regardless.

Whoever can sign in can run code on your machines with your logins, so keep
`ALLOWED_EMAILS` to yourself.

Weekly usage shows each provider's reported subscription allowance remaining.
The bar is the percentage consumed; its marker is the share of the seven-day
window elapsed, calculated from that provider's reset time. Ahead of weekly pace
means consuming faster than an even weekly budget; behind means slower. The gap
is in percentage points (pp), not a forecast or a provider-enforced daily limit.
Stale, expired or unavailable readings have no pace gauge.

Claude usage reads the machine's existing Claude Code login without refreshing
credentials. If it reports an expired or unavailable login, open Claude Code on
the named machine and renew its login there. Rejected requests and rate limits
have separate labels. Older collectors may still report only “unavailable”.

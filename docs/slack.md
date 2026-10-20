# Slack in Projects

A Slack app made for your own workspace lets the chat watcher on your
always-on machine (`collector/chats.ts`) read each connected person's Slack
as them. It reads their direct and group messages, channel messages and
threads that mention them, and channels shared with other organisations.
What needs someone joins their Today, and everything else waits in their
Inbox under Slack. It never posts, reacts or marks anything read.
[Self-hosting](self-host.md) says where this fits.

Messages arrive over Socket Mode, an outbound connection from the machine,
so Slack needs no address for Projects. The app's token and each person's
user token live only in the machine's Doppler config. They are read into the
watcher's memory and never enter `machine.json`, a snapshot, a log or a
prompt. The Worker gets each person's read with the machine's collector
token: a 140-character preview for the list, and the latest message cut to
2,000 characters for whoever holds the item.

Keep the app's distribution off. An app used only in its own workspace keeps
Slack's normal rate limits, while distributed apps outside the Marketplace
have tighter ones.

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New
   App → From a manifest**, pick your workspace, and paste:

   ```json
   {
     "display_information": {
       "name": "Projects",
       "description": "Shows the Slack messages that need you in Projects. Reads only; never posts."
     },
     "oauth_config": {
       "scopes": {
         "user": [
           "channels:history", "groups:history", "im:history", "mpim:history",
           "channels:read", "groups:read", "im:read", "mpim:read",
           "users:read", "team:read"
         ]
       }
     },
     "settings": {
       "event_subscriptions": {
         "user_events": ["message.channels", "message.groups", "message.im", "message.mpim"]
       },
       "org_deploy_enabled": false,
       "socket_mode_enabled": true,
       "token_rotation_enabled": false
     }
   }
   ```

2. **Approval point: the app's token.** Under **Basic Information → App-Level
   Tokens**, generate a token with the `connections:write` scope. It starts
   `xapp-`.
3. **Approval point: your user token.** Under **OAuth & Permissions**, choose
   **Install to Workspace** and allow it. Copy the **User OAuth Token**; it
   starts `xoxp-`.
4. Each other person whose Slack is read: add them under **Collaborators**.
   They open the app themselves, install it the same way, and copy their own
   User OAuth Token. Nobody reads anyone else's Slack: each token is that
   person's own sign-in.
5. In the always-on machine's Doppler config (the one its `machine.json`
   names), add `SLACK_APP_TOKEN` (the `xapp-` token) and `SLACK_USER_TOKENS`,
   a JSON object of each person's address and token:

   ```json
   {"you@example.com": "xoxp-…", "colleague@example.com": "xoxp-…"}
   ```

6. On that machine, from a checkout of the released commit:

   ```sh
   node scripts/install-machine.mjs --slack you@example.com,colleague@example.com
   ```

   It refuses until both secrets exist. It then starts the watcher as its own
   background service and prints `Chat watcher: running`. Its log, with
   counts and never names or text, is `~/.local/share/project-overview/chats.log`.

Within seconds of a new message, Projects' Inbox shows a Slack filter and
"Slack checked just now"; a direct message or mention appears in its person's
Today. A revoked token shows as "Slack needs you to sign in again" for that
person alone: they install the app again, and their new token replaces the
old one in `SLACK_USER_TOKENS`. The watcher reads its tokens when it starts,
so run the installer again after changing them. `--slack` with fewer people
stops reading the others; `--no-slack` stops the watcher.

Messages from before the watcher first started are not read; a restart keeps
what was waiting (`chats-slack.json` beside `machine.json`, owner-only).

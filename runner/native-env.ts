// What a native process is given in its environment: the machine's own
// logins and nothing of the runner's, plus whose work it does.
import { tmpdir } from "node:os";
import path from "node:path";
import type { Person } from "../src/people-model";
import type { InboxLogin } from "../collector/config";
import type { NativeOptions } from "./native";

// The runner credential, Doppler credentials and provider API keys never reach
// a coding process; native tools use the machine's own logins.
export function nativeEnv(browser?: NativeOptions["browser"], person?: Person, mailbox?: InboxLogin | null): NodeJS.ProcessEnv {
  // Wrangler adds the Worker's bindings to ProcessEnv; no native process has them.
  const env = Object.fromEntries(
    [
      "HOME",
      "PATH",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TERM",
      "SSH_AUTH_SOCK",
      "CODEX_HOME",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
  ) as NodeJS.ProcessEnv;
  // A change sandbox cannot write ~/.cache, so uv (the work repository's
  // email draft helper, for one) caches in the temporary directory.
  env.UV_CACHE_DIR = path.join(tmpdir(), "projects-uv-cache");
  // Commits are authored as the conversation's owner; the committer and push
  // credentials stay the machine's.
  if (person) {
    env.GIT_AUTHOR_NAME = person.name;
    env.GIT_AUTHOR_EMAIL = person.email;
  }
  // gws runs as the owner's own Gmail sign-in: the directory it lives in, or
  // an empty one when no mailbox of theirs is connected here, so nobody's
  // email is handled from another person's account.
  if (mailbox?.configDir) env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = mailbox.configDir;
  else if (person && mailbox === null)
    env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = path.join(tmpdir(), "projects-no-mailbox");
  if (browser) {
    env.PLAYWRIGHT_MCP_CDP_ENDPOINT = browser.endpoint;
    env.PLAYWRIGHT_MCP_CDP_HEADERS = `Authorization: Bearer ${browser.capability}`;
  }
  return env;
}

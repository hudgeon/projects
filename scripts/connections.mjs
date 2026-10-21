// The machine installer's inbox, Slack and Teams connection flags, kept here
// so install-machine.mjs stays small. Mutates `config` from the flags and
// returns the inbox list for the summary. Nothing is written until every
// entry is valid; `fail` exits.
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export function applyConnections(config, { args, flags, expand, fail }) {
  // Other people's inboxes: each a Gmail account read by delegation (the
  // address alone) or with the gws config directory that person signed in to
  // on this machine, which must be theirs to read and yours alone to see.
  // --add-inbox lists or changes one; --remove-inbox drops it.
  const inboxes = Array.isArray(config.inboxAccounts) ? [...config.inboxAccounts] : [];
  const connect = (login) => {
    const i = inboxes.findIndex((known) => same(known.account, login.account));
    if (i === -1) inboxes.push(login);
    else inboxes[i] = login;
  };
  for (const entry of flags("add-inbox")) {
    const [, account, dir] = /^([^\s@=]+@[^\s@=]+\.[^\s@=]+)(?:=(.+))?$/.exec(entry ?? "") ?? [];
    if (!account) fail("Give --add-inbox as person@example.com (read by delegation) or person@example.com=/path/to/their/gws/config/directory.");
    if (dir === undefined) {
      connect({ account });
      continue;
    }
    const configDir = expand(dir);
    if (!path.isAbsolute(configDir)) fail(`Give ${account}'s gws config directory as an absolute path (or under ~).`);
    let info;
    try {
      info = statSync(configDir);
    } catch {
      fail(`${configDir} does not exist. ${account} signs gws in there first: see docs/self-host.md, Connect a person's inbox.`);
    }
    if (!info.isDirectory()) fail(`${configDir} is not a directory.`);
    if (info.uid !== process.getuid() || info.mode & 0o077)
      fail(`${configDir} must be yours and readable by you alone, like gws's own config directory: chmod 700 ${configDir}`);
    connect({ account, configDir: path.resolve(configDir) });
  }
  for (const account of flags("remove-inbox")) {
    const i = inboxes.findIndex((known) => account && same(known.account, account));
    if (i === -1) fail(`No inbox is connected for ${account ?? "that account"} on this machine.`);
    inboxes.splice(i, 1);
  }
  if (inboxes.length > 10) fail("At most ten inboxes can be connected on one machine.");
  if (flags("add-inbox").length || flags("remove-inbox").length) config.inboxAccounts = inboxes;

  // Names reserved before their mailbox exists. No address or login is added.
  const placeholders = [...(config.inboxPlaceholders ?? [])];
  for (const value of flags("add-inbox-placeholder")) {
    const name = value?.trim();
    if (!name || name.length > 60 || /[\p{Cc}<>@]/u.test(name))
      fail("Give --add-inbox-placeholder as a person's name, up to 60 characters.");
    if (!placeholders.some((known) => same(known, name))) placeholders.push(name);
  }
  for (const name of flags("remove-inbox-placeholder")) {
    const i = placeholders.findIndex((known) => name && same(known, name.trim()));
    if (i === -1) fail("No inbox placeholder has that name on this machine.");
    placeholders.splice(i, 1);
  }
  if (placeholders.length > 10) fail("At most ten inbox placeholders can be listed.");
  if (flags("add-inbox-placeholder").length || flags("remove-inbox-placeholder").length)
    config.inboxPlaceholders = placeholders;

  // The people whose Slack the chat watcher reads: --slack sets the list,
  // --no-slack empties it, and otherwise it stays as it was.
  const slack = flags("slack").flatMap((value) => (value ?? "").split(",")).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (slack.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail("Give --slack as person@example.com, or several separated by commas.");
  if (slack.length) config.slack = [...new Set(slack)];
  if (args.includes("--no-slack")) config.slack = [];
  if (config.slack?.length && !config.doppler) fail("The chat watcher reads Slack's tokens from the machine's Doppler config; give the machine one first.");

  // The people whose Teams the chat watcher reads, each in a Chrome profile on
  // this machine they sign in to once: one per Teams organisation, so a second
  // --teams for the same person adds a profile. The profile is theirs to read
  // and yours alone to see; Chrome creates it on first run. --remove-teams
  // person stops all of theirs, person=dir just that one; --no-teams stops it.
  let teams = Array.isArray(config.teams) ? [...config.teams] : [];
  for (const entry of flags("teams")) {
    const [, account, dir] = /^([^\s@=]+@[^\s@=]+\.[^\s@=]+)=(.+)$/.exec(entry ?? "") ?? [];
    if (!account) fail("Give --teams as person@example.com=/path/to/their/Chrome/profile/directory.");
    const profileDir = expand(dir);
    if (!path.isAbsolute(profileDir)) fail(`Give ${account}'s Teams profile directory as an absolute path (or under ~).`);
    if (existsSync(profileDir)) {
      const info = statSync(profileDir);
      if (!info.isDirectory()) fail(`${profileDir} is not a directory.`);
      if (info.uid !== process.getuid() || info.mode & 0o077)
        fail(`${profileDir} must be yours and readable by you alone: chmod 700 ${profileDir}`);
    }
    const profile = { account, profileDir: path.resolve(profileDir) };
    // macOS folders ignore case, so two spellings of one folder are one profile.
    const i = teams.findIndex((t) => same(t.profileDir, profile.profileDir));
    if (i === -1) teams.push(profile);
    else teams[i] = profile;
  }
  for (const entry of flags("remove-teams")) {
    const [, account, dir] = /^([^=]+)(?:=(.+))?$/.exec(entry ?? "") ?? [];
    const gone = teams.filter((t) => account && same(t.account, account) && (!dir || same(t.profileDir, path.resolve(expand(dir)))));
    if (!gone.length) fail(`No Teams profile is connected for ${entry ?? "that account"} on this machine.`);
    teams = teams.filter((t) => !gone.includes(t));
  }
  if (teams.length > 10) fail("At most ten Teams profiles can be connected on one machine.");
  if (flags("teams").length || flags("remove-teams").length) config.teams = teams;
  if (args.includes("--no-teams")) config.teams = [];

  return { inboxes };
}

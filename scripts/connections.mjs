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

  // A shared support address belongs to its queue owner, not a new person.
  // Sending is a separate explicit opt-in, and activation never backfills mail.
  const support = flags("support").at(-1);
  if (support !== undefined) {
    const owner = flags("support-owner").at(-1) ?? config.support?.owner;
    const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value ?? "");
    if (!validEmail(support) || !validEmail(owner)) fail("Give --support as a mailbox address and --support-owner as its Projects owner.");
    if (!config.doppler && !flags("support-gws-config").length) fail("Support needs the machine's Doppler delegation or --support-gws-config.");
    const old = config.support?.account?.toLowerCase() === support.toLowerCase() ? config.support : undefined;
    config.support = { ...old, account: support.toLowerCase(), owner: owner.toLowerCase(), aliases: old?.aliases ?? [], since: old?.since ?? new Date().toISOString() };
    const dir = flags("support-gws-config").at(-1);
    if (dir) {
      const configDir = expand(dir);
      if (!path.isAbsolute(configDir)) fail("Support's Gmail sign-in directory must be absolute.");
      const info = statSync(configDir);
      if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) fail("Support's Gmail sign-in directory must belong to you and be readable by you alone.");
      config.support.configDir = configDir;
    }
  }
  const usersCommand = flags("support-users-command").at(-1);
  if (usersCommand !== undefined) {
    if (!config.support) fail("Connect --support before its registered-user source.");
    let parsed;
    try { parsed = JSON.parse(usersCommand); } catch { fail("Give --support-users-command as a JSON command array."); }
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 64 ||
      parsed.some(value => typeof value !== "string" || !value.length || value.length > 2000 || /[\x00\r\n]/.test(value)))
      fail("Give --support-users-command as a JSON command array.");
    config.support.usersCommand = parsed;
  }
  const personalInbox = flags("support-personal-inbox").at(-1), personalSince = flags("support-personal-since").at(-1);
  if (personalInbox !== undefined || personalSince !== undefined) {
    if (!config.support || !personalInbox || !same(personalInbox, config.support.owner) || same(personalInbox, config.support.account) ||
      !inboxes.some(l => same(l.account, personalInbox)) && !same(config.inboxAccount ?? "", personalInbox))
      fail("Personal support intake requires its owner's existing inbox.");
    const cutoff = personalSince ?? config.support.personalInbox?.since ?? new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cutoff) || !Number.isFinite(Date.parse(cutoff)) ||
      config.support.personalInbox?.since && Date.parse(cutoff) < Date.parse(config.support.personalInbox.since)) fail("Give a UTC personal-intake cutoff that does not move backwards.");
    config.support.personalInbox = { account: personalInbox.toLowerCase(), since: cutoff };
  }
  if (args.includes("--no-support-personal-inbox") && config.support) delete config.support.personalInbox;
  const forwarders = flags("support-forwarder");
  const forwardSince = flags("support-forward-since").at(-1);
  if (forwarders.length || forwardSince !== undefined) {
    if (!config.support || !forwarders.length || forwarders.length > 10 ||
      forwarders.some(value => typeof value !== "string" || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value)))
      fail("Connect --support and give up to ten --support-forwarder addresses.");
    const addresses = [...new Set(forwarders.map(value => value.toLowerCase()))];
    const sameForwarders = JSON.stringify([...addresses].sort()) === JSON.stringify([...(config.support.forwarders ?? [])].sort());
    const cutoff = forwardSince ?? (sameForwarders ? config.support.forwardSince : undefined) ?? new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cutoff) || !Number.isFinite(Date.parse(cutoff)))
      fail("Give --support-forward-since as a UTC ISO timestamp.");
    // A release reinstall cannot silently rewind the forwarding cutoff.
    if (config.support.forwardSince && Date.parse(cutoff) < Date.parse(config.support.forwardSince))
      fail("The support forwarding cutoff cannot move backwards.");
    config.support.forwarders = addresses;
    config.support.forwardSince = cutoff;
  }
  if (args.includes("--no-support-forwards") && config.support) config.support.forwarders = [];
  if (args.includes("--acknowledge-support")) fail("Automatic support sends are disabled. Use --draft-support for review in Gmail.");
  // Remove retired send/reply-all controls while preserving actual receipts.
  if (config.support) for (const key of ["acknowledge", "acknowledgeSince", "registeredRecipients", "replyAudience"]) delete config.support[key];
  if (args.includes("--no-email-queue") && config.support) delete config.support.emailQueue;
  if (args.includes("--draft-support")) {
    if (!config.support) fail("Connect --support before enabling drafts.");
    if (config.support.emailQueue) fail("Turn off --email-queue before enabling drafts.");
    if (!config.support.usersCommand?.length) fail("Connect --support-users-command before enabling drafts.");
    if (!config.support.draft) config.support.draftSince = new Date().toISOString();
    config.support.draft = true;
  }
  if (args.includes("--no-support-drafts") && config.support) config.support.draft = false;
  if (args.includes("--email-queue")) {
    if (!config.support) fail("Connect --support before selecting the email queue.");
    if (!inboxes.some(login => same(login.account, config.support.owner)) && !same(config.inboxAccount ?? "", config.support.owner))
      fail("The email queue needs the support owner's existing inbox.");
    config.support.emailQueue = true;
    config.support.draft = false;
    delete config.support.personalInbox;
    config.support.forwarders = [];
  }
  if (args.includes("--no-support")) delete config.support;

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

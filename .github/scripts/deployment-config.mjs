#!/usr/bin/env node
// Fills this checkout's wrangler.jsonc with the deployment's identity from
// repository variables, so the repository itself names no deployment. Runs in
// the Deploy job only; what it writes is never committed.
import { readFileSync, writeFileSync } from "node:fs";

const {
  PROJECTS_HOST: host = "",
  PROJECTS_PORTFOLIO: portfolio = "",
  PROJECTS_OWNER_EMAIL: owner = "",
  PROJECTS_EMAIL_FROM: from = "",
} = process.env;
// Optional: an unset repository variable arrives empty.
const timeZone = process.env.PROJECTS_TIME_ZONE || "UTC";
// Optional: exact host names, comma separated, that conversation browsers may
// reach besides the site itself. No wildcards, schemes, ports or paths.
const browserHosts = process.env.PROJECTS_BROWSER_HOSTS || "";
const extraHosts = browserHosts
  ? browserHosts.split(",").map((entry) => entry.trim())
  : [];
const exactHost =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
for (const [name, value, valid] of [
  ["PROJECTS_HOST", host, /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)],
  ["PROJECTS_PORTFOLIO", portfolio, /^[\w-]{1,64}$/.test(portfolio)],
  ["PROJECTS_OWNER_EMAIL", owner, email.test(owner)],
  ["PROJECTS_EMAIL_FROM", from, email.test(from)],
  ["PROJECTS_TIME_ZONE", timeZone, validZone(timeZone)],
  [
    "PROJECTS_BROWSER_HOSTS",
    browserHosts,
    extraHosts.length <= 10 && extraHosts.every((entry) => exactHost.test(entry)),
  ],
])
  if (!valid)
    throw Error(
      `Set the ${name} repository variable${value ? " to a valid value" : ""}; see docs/self-host.md.`,
    );

// wrangler.jsonc allows comments and trailing commas; JSON does not.
function json(text) {
  let out = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/")
      while (i < text.length && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) throw Error("Unterminated comment in wrangler.jsonc");
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
const config = json(readFileSync("wrangler.jsonc", "utf8"));
config.routes = [{ pattern: host, custom_domain: true }];
config.vars = {
  ...config.vars,
  PORTFOLIO_ID: portfolio,
  SITE_URL: `https://${host}`,
  BROWSER_HOSTS: [...new Set([host, ...extraHosts])].join(","),
  OWNER_EMAIL: owner,
  EMAIL_FROM: from,
  TIME_ZONE: timeZone,
};
writeFileSync("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
console.log(`Configured the deployment for ${host}.`);

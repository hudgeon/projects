// What .github/scripts/deployment-config.mjs leaves beside the identity it fills in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("the deployment keeps the weekly upkeep trigger beside the identity it fills in", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "projects-config-"));
  try {
    await writeFile(path.join(directory, "wrangler.jsonc"), await readFile("wrangler.jsonc", "utf8"));
    execFileSync(
      process.execPath,
      [path.resolve(".github/scripts/deployment-config.mjs")],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          PROJECTS_HOST: "projects.example.com",
          PROJECTS_PORTFOLIO: "example",
          PROJECTS_OWNER_EMAIL: "owner@example.com",
          PROJECTS_EMAIL_FROM: "sign-in@notify.example.com",
        },
        stdio: "pipe",
      },
    );
    const config = JSON.parse(await readFile(path.join(directory, "wrangler.jsonc"), "utf8"));
    assert.deepEqual(config.triggers, { crons: ["0 18 * * 5", "30 * * * *"] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the optional support connection is absent by default, exact when configured, and refuses partial/insecure configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "projects-support-config-"));
  const run = async extra => {
    await writeFile(path.join(directory,"wrangler.jsonc"), await readFile("wrangler.jsonc","utf8"));
    execFileSync(process.execPath,[path.resolve(".github/scripts/deployment-config.mjs")],{cwd:directory,env:{PATH:process.env.PATH,
      PROJECTS_HOST:"projects.example.com",PROJECTS_PORTFOLIO:"example",PROJECTS_OWNER_EMAIL:"owner@example.com",PROJECTS_EMAIL_FROM:"sign-in@notify.example.com",...extra},stdio:"pipe"});
    return JSON.parse(await readFile(path.join(directory,"wrangler.jsonc"),"utf8"));
  };
  try {
    assert.deepEqual((await run({})).services,[]);
    const enabled=await run({PROJECTS_SUPPORT_SERVICE:"support-source",PROJECTS_SUPPORT_URL:"https://support-source.example.com"});
    assert.deepEqual(enabled.services,[{binding:"SUPPORT_READER",service:"support-source",entrypoint:"SupportRead",props:{caller:"projects"}}]);
    assert.equal(enabled.vars.SUPPORT_APP_URL,"https://support-source.example.com");
    for(const extra of [{PROJECTS_SUPPORT_SERVICE:"source"},{PROJECTS_SUPPORT_URL:"https://source.example.com"},{PROJECTS_SUPPORT_SERVICE:"source",PROJECTS_SUPPORT_URL:"http://source.example.com"}]) await assert.rejects(run(extra));
  } finally {await rm(directory,{recursive:true,force:true});}
});

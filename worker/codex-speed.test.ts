import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { digest, token } from "./auth";
import type { Portfolio } from "./index";
import { randomUUID } from "node:crypto";
import type { Progress } from "../src/run-model";
import { start, options } from "./miniflare-fixtures";

test("Codex speed is owner-only, durable, shared with runners and metrics are deduplicated", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"projects-speed-")), script=path.join(dir,"worker.mjs");
  await build({entryPoints:["worker/index.ts"],bundle:true,format:"esm",platform:"browser",external:["cloudflare:workers","node:*"],outfile:script});
  const runner="r".repeat(64), collector="c".repeat(64), secondRunner="s".repeat(64), origin="https://example.com";
  const config=await options(script,dir,{RUNNER_TOKEN:runner,COLLECTOR_TOKEN:collector,LAPTOP_RUNNER_TOKEN:secondRunner,ALLOWED_EMAILS:"owner@example.com"});
  let mf=await start(config);
  const getStore=async()=>{const ns=await mf.getDurableObjectNamespace("PORTFOLIOS");return ns.get(ns.idFromName("test")) as unknown as Portfolio;};
  try {
    let db=await getStore(); const salt=token(), cookie=token();
    await db.issue("owner@example.com",salt,digest(`${salt}:123456`)); await db.verify("owner@example.com","123456",digest(cookie));
    const user={Cookie:`__Host-projects=${cookie}`,Origin:origin};
    const post=(route:string,body:unknown,headers:Record<string,string>=user)=>mf.dispatchFetch(origin+route,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
    for(const headers of [{},{Authorization:`Bearer ${runner}`},{Authorization:`Bearer ${collector}`}] as Record<string,string>[]) {
      assert.equal((await mf.dispatchFetch(origin+"/api/execution-settings",{headers})).status,401);
      assert.equal((await post("/api/execution-settings",{codexFast:true},{Origin:origin,...headers})).status,401);
    }
    assert.equal((await db.executionSettings()).codexFast,false);
    assert.equal((await post("/api/execution-settings",{codexFast:true},{Cookie:user.Cookie})).status,403);
    assert.equal((await post("/api/execution-settings",{codexFast:true,extra:1})).status,400);
    assert.equal((await post("/api/execution-settings",{codexFast:true})).status,200);
    for(const credential of [runner,secondRunner]) {
      const claim=await (await post("/api/runner/claim",{runnerId:randomUUID(),activeRunIds:[]},{Authorization:`Bearer ${credential}`})).json() as {settings:{codexFast:boolean}};
      assert.equal(claim.settings.codexFast,true);
    }
    const run=await db.createRun({requestId:randomUUID(),text:"Inspect",projectId:null,agent:"auto",workIssue:null}, "owner@example.com");
    const runId=run.id;
    const owner=randomUUID(); await db.claimRun(owner,[],undefined,"studio");
    const event={id:randomUUID(),at:Date.now(),event:"native_finished" as const,actor:"master" as const,agent:"codex" as const,codexFast:true,model:"model-a",effort:"high",mode:"read" as const,resumed:false,attempts:1,tokenUsageObserved:true,durationMs:1000,freshTokens:200,cachedTokens:0,outputTokens:100,outcome:"completed" as const};
    const report:Progress={seq:1,state:"running",summary:"Progress",children:[],masterSessionId:null,telemetry:[event]};
    assert.equal(await db.reportRun(randomUUID(),run.id,1,report,"studio"),false);
    assert.equal((await db.executionSettingsView()).metrics.retained,0);
    assert.equal(await db.reportRun(owner,run.id,1,report,"studio"),true);
    assert.equal(await db.reportRun(owner,run.id,1,report,"studio"),true);
    assert.equal(await db.reportRun(owner,run.id,1,{...report,seq:2},"studio"),true);
    assert.equal(await db.reportRun(owner,run.id,1,{...report,telemetry:[{...event,id:randomUUID()}]},"studio"),true);
    assert.equal((await db.executionSettingsView()).metrics.fast,1);
    await mf.dispose(); mf=await start(config); db=await getStore();
    assert.equal((await db.executionSettings()).codexFast,true);
    assert.equal((await db.executionSettingsView()).metrics.fast,1);
    await post("/api/execution-settings",{codexFast:false});
    const heartbeat=await (await post("/api/runner/heartbeat",{runnerId:owner,id:runId,generation:1},{Authorization:`Bearer ${runner}`})).json() as {settings:{codexFast:boolean}};
    assert.equal(heartbeat.settings.codexFast,false,"existing claimed conversations receive the new preference");
  } finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});

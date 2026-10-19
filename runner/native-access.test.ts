import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile, writeFile, rm} from "node:fs/promises";
import path from "node:path";
import {nativeTurn} from "./native";
import {fixture, engineOptions, dispatch, result, complete} from "./run-fixtures";
import {executeRun} from "./engine";
import {fakeBinary} from "./native-fixtures";
import {claudeRules, codexMcpConfig, helperPolicySchema} from "./connectors";

test("machine full access reaches native launch and both Codex RPC permission boundaries; inspections stay restricted", async () => {
  const dir = await fixture();
  try {
    for (const agent of ["claude", "codex"] as const) for (const readOnly of [false, true]) {
      const binary = await fakeBinary(dir, agent, "success"), capture = path.join(dir, "launch.json"), requests = path.join(dir, "requests.jsonl");
      let source = await readFile(binary, "utf8");
      source = source.replace("import readline", `import {writeFileSync,appendFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));\nwriteFileSync(${JSON.stringify(requests)},'');\nimport readline`)
        .replaceAll("const m=JSON.parse(line);", `const m=JSON.parse(line);appendFileSync(${JSON.stringify(requests)},JSON.stringify(m)+'\\n');`);
      await writeFile(binary, source);
      await nativeTurn({agent, cwd:dir, prompt:"Inspect", schema:{type:"object"}, readOnly, fullAccess:true,
        signal:AbortSignal.timeout(5000), binaries:{[agent]:binary}, onSession:async()=>{}});
      const args: string[] = JSON.parse(await readFile(capture,"utf8"));
      if (agent === "claude") {
        assert.equal(args[args.indexOf("--permission-mode")+1],readOnly?"dontAsk":"bypassPermissions");
        assert.equal(args[args.indexOf("--tools")+1],readOnly?"Read,Glob,Grep,TodoWrite":"default");
        assert.equal(args.includes("--strict-mcp-config"),readOnly);
        assert.equal(args.includes("--allowedTools"),readOnly);
      } else {
        assert.ok(!args.some(a=>a.includes("permissions.projects_job")));
        const messages=(await readFile(requests,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
        const start=messages.find(m=>m.method==="thread/start").params;
        const turn=messages.find(m=>m.method==="turn/start").params;
        assert.equal(start.approvalPolicy,"never");
        assert.equal(start.sandbox,readOnly?"read-only":"danger-full-access");
        assert.deepEqual(turn.sandboxPolicy,readOnly?{type:"readOnly",networkAccess:true}:{type:"dangerFullAccess"});
        assert.equal(turn.permissions,undefined);
      }
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("full access approves configured local servers without removing email send restrictions", () => {
  assert.equal(helperPolicySchema.parse({}).fullAccess,false);
  const policy=helperPolicySchema.parse({fullAccess:true,deniedTools:["mcp__db__write" ]});
  const rules=claudeRules({connectors:["claude_ai_Mail"],local:["db","local_mail"]},policy)!;
  assert.ok(rules.allow.includes("mcp__db"));
  assert.ok(!rules.deny.includes("mcp__db__write"));
  assert.ok(rules.deny.includes("mcp__claude_ai_Mail__send_email"));
  assert.ok(rules.deny.includes("mcp__local_mail__send_email"));
  assert.deepEqual(claudeRules({connectors:[],local:["db"]},policy),{allow:["mcp__db"],deny:[]});
  const config=codexMcpConfig([{name:"db"}]);
  assert.ok(config.includes("mcp_servers.db.enabled=true"));
  assert.ok(config.includes('mcp_servers.db.default_tools_approval_mode="approve"'));
  const plugin = codexMcpConfig([{name:"docs"}],new Map([["docs","files@market"]]));
  assert.ok(plugin.includes('plugins."files@market".mcp_servers.docs.enabled=true'));
  assert.ok(!plugin.some(arg=>arg.startsWith("mcp_servers.docs")), "do not shadow a plugin transport");
});


test("the executor gives full access only to change turns, never its coordinator", async () => {
  const dir=await fixture(), o=engineOptions(dir), access: unknown[]=[];
  o.fullAccess=true;
  o.turn=async opts=>{
    access.push(opts.fullAccess);
    if (access.length===1) {const decision=dispatch(); decision.task!.mode="change"; return decision;}
    return access.length===2?result:complete;
  };
  try {await executeRun(o); assert.deepEqual(access,[false,true,false]);}
  finally {await rm(dir,{recursive:true,force:true});}
});

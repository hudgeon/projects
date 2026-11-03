import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { options, start } from "./miniflare-fixtures";
import { token, digest } from "./auth";
import type { Portfolio } from "./index";
import type { ChatList, ChatRead } from "../src/chat-model";
import { acknowledgmentText, supportReferences } from "../src/support-model";

const owner="owner@example.com", other="other@example.com", mailbox="help@example.com", customer="sender@example.com";
const root="a".repeat(64), requestKey="c".repeat(64), task="19464d92-efbc-4117-a280-4c3834125b5c";
const summary={kind:"issue" as const,excerpt:"The export is empty.",area:"export" as const};
test("only trusted fresh intake creates verification links; protected preparation returns metadata, survives restart and invalidates changed mail",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"support-investigation-")), script=path.join(dir,"worker.mjs");
  await build({entryPoints:["worker/index.ts"],bundle:true,format:"esm",platform:"browser",external:["cloudflare:workers","node:*"],outfile:script});
  const settings=await options(script,dir,{ALLOWED_EMAILS:`${owner},${other}`,OWNER_EMAIL:owner,COLLECTOR_TOKEN:"c".repeat(64),RUNNER_TOKEN:"r".repeat(64),SUPPORT_APP_URL:"https://source.example.com"});
  settings.workers![0].config!.env!.SUPPORT_READER={type:"worker",worker:"reader",exportName:"SupportRead",props:{caller:"projects"}};
  settings.workers!.push({config:{name:"reader",compatibilityDate:"2026-09-14",compatibilityFlags:["nodejs_compat"],exports:{SupportRead:{type:"worker"}},manifest:{mainModule:"reader.mjs",modules:{"reader.mjs":{type:"esm",contents:`
    import {WorkerEntrypoint} from 'cloudflare:workers';
    let verified=false,prepared=false,invalidated=false;const calls=[];
    export class SupportRead extends WorkerEntrypoint {
      async fetch(request){
        if(this.ctx.props.caller!=='projects')return new Response(null,{status:404});
        const path=new URL(request.url).pathname,body=await request.json();calls.push({path,keys:Object.keys(body)});
        if(path==='/health')return Response.json({policy:'support-grant-v1'});
        if(path==='/bootstrap')return invalidated?new Response(null,{status:404}):Response.json({task:'${task}',path:'/support-investigation/${task}',state:prepared?'prepared':verified?'verified':'awaiting-verification'});
        if(path==='/claim'&&verified)return Response.json({result:{token:'sr_'+'a'.repeat(64),expiresAt:new Date(Date.now()+600000).toISOString(),operations:['invoice_context']}});
        if(path==='/prepare-review'&&request.headers.get('Authorization')==='Bearer sr_'+'a'.repeat(64)){prepared=true;return Response.json({result:{prepared:true}});}
        if(path==='/invalidate'){invalidated=true;return Response.json({result:true});}
        return new Response(null,{status:404});
      }
    }
    export default {async fetch(request){const path=new URL(request.url).pathname;if(path==='/verify')verified=true;return Response.json({calls,verified,prepared,invalidated});}};
  `}}}}});
  let mf=await start(settings);
  const storeFor=async()=>{const ns=await mf.getDurableObjectNamespace("PORTFOLIOS");return ns.get(ns.idFromName("test")) as unknown as Portfolio;};
  const post=(body:{action:string;[key:string]:unknown},headers:Record<string,string>,pathname=body.action==="bootstrap"?"/api/collector/support-investigation":"/api/support/investigation")=>mf.dispatchFetch("https://example.com"+pathname,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const collector={Authorization:`Bearer ${"c".repeat(64)}`};
  const incoming=(at:number,extra:object={}):ChatRead=>({source:"support",owner,observedAt:at,state:"ok",items:[{id:root,place:{name:"Export",kind:"thread"},from:customer,at:at-1000,count:1,unread:true,mention:true,
    text:"The export is empty. Invoice ID: inv-test",support:{account:mailbox,thread:"1234567890abcdef",messageKeys:[requestKey],acknowledgment:"off",draft:"pending",request:{key:requestKey,sender:customer,audience:{to:[customer],cc:[]}}},...extra}]});
  try {
    let store=await storeFor();
    const signIn=async(email:string)=>{const salt=token(),value=token();assert.ok(await store.issue(email,salt,digest(`${salt}:123456`)));assert.ok(await store.verify(email,"123456",digest(value)));return{Cookie:`__Host-projects=${value}`,Origin:"https://example.com"};};
    const me=await signIn(owner),them=await signIn(other);
    const at=Date.now();await store.publishChats(incoming(at),"studio");
    const bootstrap={action:"bootstrap",key:root,owner,requestKey,summary};
    assert.equal((await post(bootstrap,collector)).status,200);
    assert.equal((await (await post(bootstrap,collector)).json() as {investigation:{state:string}}).investigation.state,"held","no draft reservation means no task");
    await store.supportAcknowledgment({action:"reserve",key:root,owner,account:mailbox,requestKey},"studio");
    const copied=incoming(at+1);
    copied.items[0].support!.request!.audience.cc=[owner];
    await store.publishChats(copied,"studio");
    assert.equal((await(await post(bootstrap,collector)).json() as {investigation:{state:string}}).investigation.state,"held","old stored reply-all metadata cannot bootstrap a protected request");
    await store.publishChats(incoming(at+2),"studio");
    const boot=await(await post(bootstrap,collector)).json() as {investigation:{state:string;verificationUrl:string}};
    assert.equal(boot.investigation.state,"awaiting-verification");
    assert.equal(boot.investigation.verificationUrl,`https://source.example.com/support-investigation/${task}`);
    const duties=await mf.dispatchFetch("https://example.com/api/collector/duties",{headers:collector});
    assert.equal((await duties.json() as {supportInvestigation:boolean}).supportInvestigation,true,"the real service-binding props reach the entrypoint");
    const list=await store.chatList(owner),key=list.items[0].key;
    assert.equal((await post({action:"prepare",key},collector)).status,403,"a machine cannot bypass the human route's same-origin check");
    assert.equal((await post({action:"prepare",key},collector,"/api/collector/support-investigation")).status,403,"intake cannot trigger customer-record reads");
    assert.equal((await post({action:"prepare",key},{Cookie:me.Cookie})).status,403,"a human write requires the same origin");
    assert.equal((await post({action:"prepare",key},them)).status,404,"another person's session cannot use this source");
    assert.equal((await post({action:"prepare",key,customer:"other",role:"admin"},me)).status,400);
    const reader=await mf.getWorker("reader");await reader.fetch("https://fixture.internal/verify");
    const result=await post({action:"prepare",key},me),text=await result.text();
    assert.equal(result.status,200);assert.equal(JSON.parse(text).investigation.state,"prepared");
    assert.doesNotMatch(text,/sr_|amount|invoice_context|PRIVATE_DB_FACT|"body"/);
    const called=await(await reader.fetch("https://fixture.internal/calls")).json() as {calls:{path:string}[]};
    assert.equal(called.calls.filter(c=>c.path==="/prepare-review").length,1);
    assert.equal(called.calls.some(c=>["/read","/prepare","/authorize","/consume"].includes(c.path)),false);
    const pointer=await store.supportInvestigation(root,owner);
    assert.equal(pointer?.state,"prepared");assert.doesNotMatch(JSON.stringify(pointer),/sr_|PRIVATE_DB_FACT/);
    assert.equal((await store.publishChats({...incoming(at-1),items:[]},"studio")).accepted,false);
    assert.equal((await store.supportInvestigation(root,owner))?.state,"prepared","a rejected older read cannot revoke a current task");
    await mf.dispose();mf=await start(settings);store=await storeFor();
    assert.equal((await store.chatList(owner)).items[0].support?.investigation?.state,"prepared");
    assert.equal((await store.chatList(other)).items.length,0);
    const followup=incoming(at+3,{support:{account:mailbox,thread:"1234567890abcdef",messageKeys:[requestKey,"d".repeat(64)],acknowledgment:"off",draft:"stale",request:{key:"d".repeat(64),sender:"new@example.com",audience:{to:["new@example.com"],cc:[]}}}});
    await store.publishChats(followup,"studio");
    const held=await(await post({action:"prepare",key},me)).json() as {investigation:{state:string;reviewUrl?:string}};
    assert.equal(held.investigation.state,"held");assert.equal(held.investigation.reviewUrl,undefined);
    assert.equal((await store.supportInvestigation(root,owner))?.invalidated,true);
    const pointerText=JSON.stringify((await store.chatList(owner)).items[0].support?.investigation);
    assert.doesNotMatch(pointerText,/reviewUrl|verificationUrl/);
    assert.equal((await(await post({...bootstrap,requestKey:"d".repeat(64)},collector)).json() as {investigation:{state:string}}).investigation.state,"held","an old message key remaining in the conversation cannot qualify the new sender");
  } finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});

test("reference extraction ignores quoted history, arbitrary SQL and bulk requests; verification links never become bearer links",()=>{
  assert.deepEqual(supportReferences("The export is empty. Invoice ID: inv-test\nOn Monday someone wrote:\nInvoice # hidden"),[{operation:"invoice_context",id:"inv-test"}]);
  assert.deepEqual(supportReferences("Invoice #A Invoice #B Invoice #C"),[]);
  assert.deepEqual(supportReferences("SELECT * FROM invoices"),[]);
  assert.deepEqual(supportReferences("Receipt line 123"),[{operation:"receipt_line_context",id:"123"}]);
  assert.match(acknowledgmentText(summary,`https://source.example.com/support-investigation/${task}`),/sign in and review this request/);
  for(const url of [`https://source.example.com/support-investigation/${task}?token=secret`,`javascript:alert(1)`])assert.doesNotMatch(acknowledgmentText(summary,url),/token=|javascript:|sign in and review this request/);
  assert.doesNotMatch(acknowledgmentText({kind:"other",excerpt:"",area:"other"},`https://source.example.com/support-investigation/${task}`),/sign in and review/);
});

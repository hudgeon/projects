// Fake Claude and Codex command lines for the runner's tests.
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function fakeBinary(dir: string, agent: string, mode: string) {
  const file = path.join(dir, `${agent}-${mode}.mjs`);
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from 'node:readline';
import {spawn as spawnBackground} from 'node:child_process';
import {writeFileSync as writePid} from 'node:fs';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const mode=${JSON.stringify(mode)};
const note='PROJECTS_PROGRESS '+JSON.stringify({done:['Inspected the project'],remaining:['Run checks'],blocker:null});
if(process.env.RUNNER_TOKEN || process.env.DOPPLER_TOKEN || process.env.OPENAI_API_KEY)process.exit(8);
if(${JSON.stringify(agent)}==='codex') {
  let turns=0;
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);if(!m.method)return;
    if(m.method==='initialize')send({id:m.id,result:{}});
    if(m.method==='thread/resume'&&mode==='refuseResume'){send({id:m.id,error:{code:-32600,message:'refused'}});return;}
    if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'test-session',status:{type:'idle'}}}});
    if(m.method==='thread/unarchive')send({id:m.id,error:{code:-32600,message:'no archived rollout found'}});
    if(m.method==='thread/archive')send({id:m.id,result:{}});
    if(m.method==='turn/steer'){
      if(m.params.expectedTurnId!=='turn'){send({id:m.id,error:{code:-32600,message:'no active turn'}});return;}
      send({id:m.id,result:{turnId:'turn'}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({summary:'Connected '+m.params.input[0].text})}}});
      send({method:'turn/completed',params:{threadId:'test-session',turn:{status:'completed'}}});
      return;
    }
    if(m.method==='turn/start'&&mode==='steer'){
      send({id:m.id,result:{turn:{id:'turn'}}});
      send({method:'turn/started',params:{threadId:'test-session',turn:{id:'turn'}}});
      send({method:'turn/plan/updated',params:{threadId:'test-session',turnId:'turn',explanation:null,plan:[{step:'Read the code',status:'completed'},{step:'Make the change',status:'inProgress'},{step:'Run checks',status:'pending'}]}});
      return;
    }
    if(m.method==='turn/start'){
      send({id:m.id,result:{turn:{id:'turn'}}});
      turns++;
      if((mode==='busy'&&turns===1)||mode==='busyActed'||mode==='usage'||mode==='unauthorized'||mode==='contextWindowExceeded'||mode==='sandboxError'||mode==='novel'){
        if(mode==='busyActed')send({method:'item/started',params:{threadId:'test-session',item:{type:'commandExecution'}}});
        send({method:'turn/completed',params:{threadId:'test-session',turn:{status:'failed',error:{message:'x',codexErrorInfo:mode==='usage'?'usageLimitExceeded':mode==='novel'?'somethingNew':mode.startsWith('busy')?'serverOverloaded':mode}}}});
        return;
      }
      if(mode==='exit')process.exit(0);if(mode==='hang')return;
      if(mode==='files'){
        send({method:'item/completed',params:{threadId:'test-session',item:{type:'commandExecution',status:'completed',cwd:process.cwd(),command:"sed -n '2,4p' notes.md",aggregatedOutput:'private-output',commandActions:[{type:'read',command:"sed -n '2,4p' notes.md",name:'notes.md',path:'notes.md'}]}}});
        send({method:'item/completed',params:{threadId:'test-session',item:{type:'fileChange',status:'completed',changes:[{path:process.cwd()+'/src/b.ts',kind:{type:'update'},diff:'private-diff'}]}}});
      }
      send({method:'turn/started',params:{threadId:'test-session',turn:{id:'turn'}}});
      send({method:'item/started',params:{threadId:'foreign-session',item:{type:'fileChange'}}});
      send({method:'item/started',params:{threadId:'test-session',item:{type:'reasoning',content:['private-reasoning']}}});
      send({method:'item/completed',params:{threadId:'foreign-session',item:{type:'agentMessage',phase:'commentary',text:note}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'reasoning',text:note}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'commentary',text:'ordinary private commentary'}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'commentary',text:note}}});
      send({method:'item/started',params:{threadId:'test-session',item:{type:'commandExecution',command:'secret-command',arguments:{token:'private-token'}}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'commandExecution',status:'completed',aggregatedOutput:'private-output'}}});
      if(mode==='approval')send({id:101,method:'item/commandExecution/requestApproval',params:{}});
      const breakdown=(input,cached,output)=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:0});
      send({method:'thread/tokenUsage/updated',params:{threadId:'foreign-session',turnId:'turn',tokenUsage:{total:breakdown(99999,0,99999),last:breakdown(99999,0,99999),modelContextWindow:1}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'test-session',turnId:'turn',tokenUsage:{total:breakdown(5000,3000,200),last:breakdown(2000,1000,100),modelContextWindow:475000}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'test-session',turnId:'turn',tokenUsage:{total:breakdown(9000,6000,300),last:breakdown(4000,3000,100),modelContextWindow:475000}}});
      send({method:'item/completed',params:{threadId:'test-session',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({summary:'Connected'})}}});
      send({method:'turn/completed',params:{threadId:'test-session',turn:{status:mode==='failed'?'failed':'completed'}}});
    }
  });
} else {
  let lines=0;
  const finish=extra=>send({type:'result',subtype:mode==='maxTurns'?'error_max_turns':mode==='execution'?'error_during_execution':'success',is_error:mode==='execution',structured_output:mode==='maxTurns'||mode==='execution'?undefined:{summary:'Connected'+extra},permission_denials:mode==='approval'?[{tool_name:'Bash'}]:[],num_turns:2,usage:{input_tokens:15,cache_creation_input_tokens:1200,cache_read_input_tokens:1000,output_tokens:95},modelUsage:{'model-a':{inputTokens:9015,cacheCreationInputTokens:91200,cacheReadInputTokens:801000,outputTokens:7095,contextWindow:1000000}}});
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);
    if(++lines>1){if(mode==='steer')finish(' '+m.message.content[0].text);return;}
    if(mode==='exit')process.exit(0);if(mode==='hang'){setInterval(()=>{},1000);return;}
    // A resumed session can first report a turn that never ran, with the
    // whole session's per-model totals.
    if(mode==='stale')send({type:'result',subtype:'success',is_error:false,num_turns:0,usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0},modelUsage:{'model-a':{inputTokens:5000,cacheCreationInputTokens:90000,cacheReadInputTokens:800000,outputTokens:7000}}});
    send({type:'system',subtype:'init',session_id:'test-session'});
    send({type:'assistant',message:{id:'msg-1',usage:{input_tokens:10,cache_creation_input_tokens:1000,cache_read_input_tokens:0,output_tokens:50},content:[{type:'thinking',thinking:'private-reasoning'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'secret-command'}}]}});
    send({type:'assistant',message:{id:'msg-2',usage:{input_tokens:5,cache_creation_input_tokens:200,cache_read_input_tokens:1000,output_tokens:30},content:[{type:'thinking',thinking:note},{type:'text',text:'ordinary private commentary'},{type:'text',text:note}]}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'private-output'}]}});
    if(mode==='files')for(let i=0;i<2;i++)send({type:'assistant',message:{id:'msg-3',content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:process.cwd()+'/notes.md',offset:2,limit:3}},{type:'tool_use',id:'edit-1',name:'Edit',input:{file_path:process.cwd()+'/src/b.ts',old_string:'private-old',new_string:'private-new'}}]}});
    // Reports, then runs on with a background command and a later turn of its own.
    if(mode==='linger'){finish('');const bg=spawnBackground(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writePid('background.pid',String(bg.pid));setTimeout(()=>send({type:'result',subtype:'success',is_error:false,structured_output:{summary:'Later'},num_turns:1,usage:{}}),20);setInterval(()=>{},1000);return;}
    if(mode==='steer'){send({type:'assistant',message:{content:[{type:'tool_use',id:'todo-1',name:'TodoWrite',input:{todos:[{content:'Read the code',status:'completed',activeForm:'Reading'},{content:'Make the change',status:'in_progress',activeForm:'Changing'},{content:'Run checks',status:'pending',activeForm:'Checking'}]}}]}});return;}
    finish('');
  });
}

`,
    { mode: 0o700 },
  );
  return file;
}

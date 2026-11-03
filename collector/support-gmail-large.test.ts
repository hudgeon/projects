import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { command } from "./command";
import { readSupport } from "./support-gmail";
import { INBOX_BODY_LIMIT } from "../src/inbox-model";
import type { SupportConfig } from "../src/support-model";

test("a large older Gmail conversation does not make a readable new support request incomplete; other output stays bounded", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "support-large-thread-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); await mkdir(bin);
  const executable = path.join(bin, "gws");
  await writeFile(executable, `#!${process.execPath}
const args=process.argv.slice(2), p=JSON.parse(args[args.indexOf('--params')+1]??'{}');
if(p.id==='oversized'){process.stdout.write('x'.repeat(17_000_000));}
else if(args[2]==='getProfile')console.log(JSON.stringify({emailAddress:'help@example.com'}));
else if(args[2]==='threads'&&args[3]==='list')console.log(JSON.stringify({threads:[{id:'aaaaaaaaaa000001'},{id:'aaaaaaaaaa000002'}]}));
else if(args[2]==='messages')console.log(JSON.stringify({messages:[]}));
else{
 const large=p.id==='aaaaaaaaaa000001';
 const message={id:p.id,internalDate:String(Date.now()),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:Object.entries({From:'customer@example.org',To:'help@example.com',Subject:large?'Long conversation':'New request','Message-ID':'<'+p.id+'@example.org>'}).map(([name,value])=>({name,value})),body:{data:Buffer.from(large?'x'.repeat(3_100_000):'The export is empty.').toString('base64url')}}};
 console.log(JSON.stringify({id:p.id,messages:[message]}));
}
`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = (args: string[]) => command("gws", args, root, env);
  const config: SupportConfig = { account: "help@example.com", owner: "owner@example.com", aliases: [], since: "2026-01-01T00:00:00Z", acknowledge: false, draft: true };
  const result = await readSupport(config, run);
  assert.equal(result.complete, true);
  assert.equal(result.threads.length, 2);
  assert.ok(result.threads[0].body.length <= INBOX_BODY_LIMIT, "the native/queue body budget remains unchanged");
  assert.equal(result.threads[1].body, "The export is empty.");
  assert.equal(result.threads[1].eligible, true);
  await assert.rejects(run(["gmail", "users", "drafts", "get", "--params", JSON.stringify({ id: "aaaaaaaaaa000001" })]), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  await assert.rejects(run(["gmail", "users", "threads", "get", "--params", JSON.stringify({ id: "oversized" })]), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
});

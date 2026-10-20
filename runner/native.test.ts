import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeTurn, nativeEnv, browserTools, hiddenBrowserTools, NativeBusyError, type NativeOptions } from "./native";
import { outputSchema } from "./engine";
import { childResultSchema, type NativeActivity, type ProgressNoteInput, type LivePlanStep } from "../src/run-model";
import { result, fixture } from "./run-fixtures";
import { fakeBinary } from "./native-fixtures";

test("feedback reaches a running Codex or Claude turn, and each reports its own plan", async () => {
  const dir = await fixture();
  try {
    for (const agent of ["codex", "claude"] as const) {
      const binary = await fakeBinary(dir, agent, "steer");
      const plans: LivePlanStep[][] = [];
      const value = await nativeTurn({
        agent, cwd: dir, prompt: "Change it", schema: {type: "object"}, readOnly: false,
        signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {},
        onPlan: (steps) => plans.push(steps),
        onSteer: (steer) => { setTimeout(() => void steer({text: "Use the blue button"}), 50); },
      });
      assert.deepEqual(value, {summary: "Connected Use the blue button"}, agent);
      assert.deepEqual(plans.at(-1), [{step: "Read the code", status: "done"}, {step: "Make the change", status: "active"}, {step: "Run checks", status: "pending"}], agent);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("native browser credentials travel through environment and read sessions cannot interact", async () => {
  const dir = await fixture();
  const browser = {endpoint: "wss://projects.example.com/api/browser/test/cdp", capability: "fixture-scoped-browser-capability", outputDir: path.join(dir, "artifacts")};
  try {
    for (const agent of ["codex", "claude"] as const) for (const readOnly of [true, false]) {
      const binary = await fakeBinary(dir, agent, "success");
      const capture = path.join(dir, "launch.json");
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("import readline", `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2), endpoint:process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT, header:process.env.PLAYWRIGHT_MCP_CDP_HEADERS, author:[process.env.GIT_AUTHOR_NAME, process.env.GIT_AUTHOR_EMAIL, process.env.GIT_COMMITTER_NAME]}));\nimport readline`));
      await nativeTurn({agent, cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly, browser, person: {email: "matt.smith@example.com", name: "Matt Smith"}, signal: AbortSignal.timeout(5000), binaries: {[agent]: binary}, onSession: async () => {}});
      const launch = JSON.parse(await readFile(capture, "utf8"));
      assert.equal(launch.endpoint, browser.endpoint);
      assert.deepEqual(launch.author, ["Matt Smith", "matt.smith@example.com", null], "commits are authored as the person; the committer stays the machine's");
      assert.equal(launch.header, `Authorization: Bearer ${browser.capability}`);
      assert.doesNotMatch(JSON.stringify(launch.args), /fixture-scoped-browser-capability|Authorization/);
      const toolConfiguration = agent === "claude" ? launch.args[launch.args.indexOf("--allowedTools") + 1]
        : launch.args.find((arg: string) => arg.startsWith("mcp_servers.projects_browser.enabled_tools="));
      assert.match(toolConfiguration, /browser_navigate/);
      assert.equal(toolConfiguration.includes("browser_snapshot"), !readOnly);
      assert.equal(toolConfiguration.includes("browser_take_screenshot"), !readOnly);
      assert.equal(toolConfiguration.includes("browser_click"), !readOnly);
      assert.doesNotMatch(toolConfiguration, /browser_evaluate|browser_run_code|browser_cookie|browser_file_upload/);
      if (agent === "codex") {
        const approvals = launch.args.filter((arg: string) => arg.includes(".approval_mode="));
        assert.deepEqual(approvals, browserTools(readOnly).map(tool => `mcp_servers.projects_browser.tools.${tool}.approval_mode="approve"`));
        assert.ok(!launch.args.some((arg: string) => arg.includes("default_tools_approval_mode")));
      } else {
        const denied = launch.args[launch.args.indexOf("--disallowedTools") + 1].split(",");
        const upstream = [...(await readFile("node_modules/@playwright/mcp/README.md", "utf8")).matchAll(/^- \*\*(browser_[a-z_]+)\*\*/gm)].map(match => match[1]);
        assert.ok(upstream.length > 50);
        for (const tool of upstream) assert.equal(denied.includes(`mcp__projects_browser__${tool}`), !browserTools(readOnly).includes(tool), `pinned tool visibility: ${tool}`);
        assert.deepEqual(hiddenBrowserTools(readOnly).map(tool => `mcp__projects_browser__${tool}`), denied);
      }
      assert.match(JSON.stringify(launch.args), /@playwright\/mcp@0.0.83/);
      // Every Claude session, change helpers included, gets only this browser:
      // The user's own connectors would be refused unattended and fail the turn.
      if (agent === "claude") {
        const enabled = launch.args[launch.args.indexOf("--tools") + 1].split(",");
        const allowed = toolConfiguration.split(",");
        for (const tool of ["Bash", "TaskOutput", "TaskStop"]) {
          assert.equal(enabled.includes(tool), !readOnly, tool);
          assert.equal(allowed.includes(tool), !readOnly, tool);
        }
        assert.ok(launch.args.includes("--strict-mcp-config"), `strict MCP when readOnly=${readOnly}`);
        assert.deepEqual(Object.keys(JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]).mcpServers), ["projects_browser"]);
      }
    }
    assert.equal(nativeEnv(browser).RUNNER_TOKEN, undefined);
    assert.equal(nativeEnv(browser).DOPPLER_TOKEN, undefined);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test("native adapters require confirmed results, refuse approvals and stop on cancellation", async () => {
  const dir = await fixture();
  try {
    for (const agent of ["codex", "claude"] as const) {
      for (const mode of ["success", "exit", "approval", "hang"]) {
        const binary = await fakeBinary(dir, agent, mode);
        let session = "";
        const activity: NativeActivity[] = [];
        const notes: ProgressNoteInput[] = [];
        const o: NativeOptions = {
          agent,
          cwd: dir,
          prompt: "No tools",
          schema: { type: "object" },
          readOnly: true,
          signal: AbortSignal.timeout(mode === "hang" ? 200 : 5000),
          binaries: { [agent]: binary },
          onSession: async (id) => {
            session = id;
          },
          onActivity: (event) => {
            activity.push(event);
          },
          onProgress: (note) => notes.push(note),
        };
        if (mode === "success") {
          assert.deepEqual(await nativeTurn(o), { summary: "Connected" });
          assert.ok(session);
          assert.deepEqual(notes, [
            {
              done: ["Inspected the project"],
              remaining: ["Run checks"],
              blocker: null,
            },
          ]);
          assert.deepEqual(
            activity.filter((e) => e.kind !== "response"),
            [
              { kind: "turn", state: "started" },
              { kind: "command", state: "started" },
              { kind: "command", state: "finished" },
              { kind: "turn", state: "finished" },
            ],
          );
          assert.doesNotMatch(
            JSON.stringify(activity),
            /private-|secret-|foreign/,
          );
        } else if (mode === "approval") {
          // The runner refuses what was not granted and keeps the turn's
          // result; only the kind of request is reported.
          const refused: string[][] = [];
          assert.deepEqual(
            await nativeTurn({ ...o, onRefused: (kinds) => refused.push(kinds) }),
            { summary: "Connected" },
          );
          assert.deepEqual(refused, [["command"]], agent);
        } else await assert.rejects(nativeTurn(o));
      }
    }
    // The child environment is intentionally a small allowlist, not a copy of
    // the service's environment or its Worker credential.
    assert.equal(nativeEnv().RUNNER_TOKEN, undefined);
    assert.equal(nativeEnv().DOPPLER_TOKEN, undefined);
    assert.equal(nativeEnv().OPENAI_API_KEY, undefined);
    assert.equal(nativeEnv().GIT_AUTHOR_EMAIL, undefined, "no person, no author");
    const person = {email: "matt.smith@example.com", name: "Matt Smith"};
    assert.deepEqual([nativeEnv(undefined, person).GIT_AUTHOR_NAME, nativeEnv(undefined, person).GIT_AUTHOR_EMAIL, nativeEnv(undefined, person).GIT_COMMITTER_EMAIL], ["Matt Smith", "matt.smith@example.com", undefined]);
    assert.equal(nativeEnv().UV_CACHE_DIR, path.join(tmpdir(), "projects-uv-cache"), "uv can cache inside a change sandbox");
    assert.equal(
      JSON.stringify(outputSchema(childResultSchema)).includes(
        '"format":"uri"',
      ),
      false,
    );
    assert.equal(
      childResultSchema.safeParse({
        ...result,
        links: ["https://evil.example/result"],
      }).success,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex archives only verified threads and restores one before resuming", async () => {
  const dir = await fixture();
  try {
    const requests = async (mode: string, sessionId?: string) => {
      const binary = await fakeBinary(dir, "codex", mode);
      const log = path.join(dir, `${mode}-${sessionId ?? "new"}.log`);
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("const m=JSON.parse(line);", `const m=JSON.parse(line);if(m.id!==undefined&&m.method)appendFileSync(${JSON.stringify(log)},m.method+'\\n');`).replace("import readline", "import {appendFileSync} from 'node:fs';\nimport readline"));
      const turn = nativeTurn({agent: "codex", cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly: true, sessionId, signal: AbortSignal.timeout(5000), binaries: {codex: binary}, onSession: async () => {}});
      if (mode === "success" || mode === "approval") assert.deepEqual(await turn, {summary: "Connected"});
      else await assert.rejects(turn);
      return (await readFile(log, "utf8")).trim().split("\n");
    };
    assert.deepEqual(await requests("success"), ["initialize", "thread/start", "turn/start", "thread/archive"]);
    // Codex rejects unarchiving a thread that was never archived; resume proceeds.
    assert.deepEqual(await requests("success", "test-session"), ["initialize", "thread/unarchive", "thread/resume", "turn/start", "thread/archive"]);
    assert.deepEqual(await requests("failed", "test-session"), ["initialize", "thread/unarchive", "thread/resume", "turn/start"]);
    // A turn that reported after a refused request is verified too.
    assert.deepEqual(await requests("approval", "test-session"), ["initialize", "thread/unarchive", "thread/resume", "turn/start", "thread/archive"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each agent reports the files its turn read or changed as paths and line ranges only", async () => {
  const dir = await fixture();
  try {
    for (const agent of ["codex", "claude"] as const) {
      const files: unknown[] = [];
      await nativeTurn({agent, cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly: false, signal: AbortSignal.timeout(5000), binaries: {[agent]: await fakeBinary(dir, agent, "files")}, onSession: async () => {}, onFile: file => files.push(file)});
      // The fake agents name files under their own resolved working directory.
      const real = await realpath(dir);
      assert.deepEqual(files, [{path: path.join(real, "notes.md"), lines: [2, 4]}, {path: path.join(real, "src/b.ts"), change: true}], agent);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a busy model's turn runs again only when it had not acted yet", async () => {
  const dir = await fixture();
  try {
    const turn = async (mode: string, sessionId?: string) =>
      nativeTurn({agent: "codex", cwd: dir, prompt: "Inspect", schema: {type: "object"}, readOnly: true, sessionId, retryDelayMs: 5, signal: AbortSignal.timeout(5000), binaries: {codex: await fakeBinary(dir, "codex", mode)}, onSession: async () => {}});
    assert.deepEqual(await turn("busy"), {summary: "Connected"}, "nothing ran, so the same turn ran again");
    await assert.rejects(turn("busyActed"), (e: unknown) => e instanceof NativeBusyError && e.acted, "a turn that already ran a command is not repeated");
    await assert.rejects(turn("usage"), /usage limit is reached/);
    await assert.rejects(turn("refuseResume", "test-session"), /could not open the session/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("native turns report their tokens as each app counts them", async () => {
  const dir = await fixture();
  try {
    for (const [agent, sessionId, expected] of [
      // Codex reports running thread totals: this turn is their growth.
      ["codex", "test-session", {fresh: 2000, cached: 4000, output: 200, context: 4000}],
      // Claude's result counts this turn; its per-model totals span the
      // session and are not used. Context is the last request's.
      ["claude", undefined, {fresh: 1215, cached: 1000, output: 95, context: 1205}],
    ] as const) {
      const reports: unknown[] = [];
      await nativeTurn({agent, cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: true, sessionId, signal: AbortSignal.timeout(5000), binaries: {[agent]: await fakeBinary(dir, agent, "success")}, onSession: async () => {}, onUsage: (usage) => reports.push(usage)});
      assert.deepEqual(reports.at(-1), expected, agent);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a resumed Claude session's stale zero-turn result is neither the turn's result nor its tokens", async () => {
  const dir = await fixture();
  try {
    const reports: unknown[] = [];
    let steerable = false;
    const value = await nativeTurn({agent: "claude", cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: true, sessionId: "test-session", signal: AbortSignal.timeout(5000), binaries: {claude: await fakeBinary(dir, "claude", "stale")}, onSession: async () => {}, onUsage: (usage) => reports.push(usage), onSteer: () => { steerable = true; }});
    assert.deepEqual(value, {summary: "Connected"}, "the prompt's own turn decides the result");
    assert.ok(steerable);
    assert.ok(reports.every((usage) => (usage as {cached: number}).cached <= 1000), "the session's earlier turns are never counted");
    assert.deepEqual(reports.at(-1), {fresh: 1215, cached: 1000, output: 95, context: 1205});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("Codex fast mode explicitly overrides new and resumed threads, including off", async () => {
  const dir = await fixture();
  try {
    for (const fast of [true, false]) for (const sessionId of [undefined, "test-session"]) {
      const binary = await fakeBinary(dir,"codex","success"), log = path.join(dir,"speed.log");
      await writeFile(log, "");
      let source = await readFile(binary,"utf8");
      source = source.replace("import readline", "import {appendFileSync} from 'node:fs';\nimport readline")
        .replace("const m=JSON.parse(line);", `const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');`)
        .replace("result:{thread:{id:'test-session',status:{type:'idle'}}}", "result:{model:'model-a',reasoningEffort:'high',thread:{id:'test-session',status:{type:'idle'}}}")
        .replace("if(mode==='exit')", "send({method:'item/agentMessage/delta',params:{threadId:'test-session',delta:'x'}});if(mode==='exit')");
      await writeFile(binary,source);
      const timing: Record<string,unknown> = {};
      await nativeTurn({agent:"codex",cwd:dir,prompt:"Inspect",schema:{type:"object"},readOnly:true,sessionId,codexFast:fast,signal:AbortSignal.timeout(5000),binaries:{codex:binary},onSession:async()=>{},onTiming:fields=>Object.assign(timing,fields)});
      const requests = (await readFile(log,"utf8")).trim().split("\n").map(s=>JSON.parse(s));
      assert.equal(requests.find(r=>r.method===(sessionId?"thread/resume":"thread/start")).params.serviceTier,fast?"fast":"default");
      const start = requests.find(r=>r.method==="turn/start");
      assert.equal(start.params.serviceTier,fast?"fast":"default");
      assert.equal(start.params.serviceTierForTurn,fast?"fast":"default");
      assert.equal(timing.model,"model-a"); assert.equal(timing.effort,"high"); assert.equal(timing.attempts,1);
      assert.equal(typeof timing.firstOutputMs,"number");
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("a Claude turn whose process runs on after its result is stopped with what it left running, and keeps that result", async () => {
  const dir = await fixture();
  try {
    let overran = 0;
    const value = await nativeTurn({agent: "claude", cwd: dir, prompt: "Work", schema: {type: "object"}, readOnly: false, signal: AbortSignal.timeout(5000), binaries: {claude: await fakeBinary(dir, "claude", "linger")}, onSession: async () => {}, onOverran: () => overran++, resultExitMs: 200});
    assert.deepEqual(value, {summary: "Connected"}, "a later turn of its own never replaces the result");
    assert.equal(overran, 1);
    const pid = Number(await readFile(path.join(dir, "background.pid"), "utf8"));
    const running = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && running(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(running(), false, "the command it left in the background was stopped with it");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("a Claude read turn given the web fetches the named hosts only, through domain rules; without it, or in a change turn, there is no web tool", async () => {
  const dir = await fixture();
  try {
    for (const [readOnly, web] of [[true, ["code.claude.com", "learn.chatgpt.com"]], [true, undefined], [false, ["code.claude.com"]]] as const) {
      const binary = await fakeBinary(dir, "claude", "success");
      const capture = path.join(dir, "launch.json");
      const source = await readFile(binary, "utf8");
      await writeFile(binary, source.replace("import readline", `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2)}));\nimport readline`));
      await nativeTurn({agent: "claude", cwd: dir, prompt: "Research", schema: {type: "object"}, readOnly, web: web && [...web], signal: AbortSignal.timeout(5000), binaries: {claude: binary}, onSession: async () => {}});
      const launch = JSON.parse(await readFile(capture, "utf8"));
      const tools = launch.args[launch.args.indexOf("--tools") + 1].split(",");
      const allowed = launch.args[launch.args.indexOf("--allowedTools") + 1].split(",");
      const given = readOnly && web ? [...web] : [];
      assert.equal(tools.includes("WebFetch"), given.length > 0, `tools when readOnly=${readOnly}, web=${web}`);
      assert.ok(!tools.includes("WebSearch") && !allowed.includes("WebFetch") && !allowed.includes("WebSearch"), "a bare rule would allow every host");
      assert.deepEqual(allowed.filter((rule: string) => rule.startsWith("WebFetch(")), given.map((host) => `WebFetch(domain:${host})`));
      assert.equal(tools.includes("Bash"), !readOnly);
    }
  } finally {await rm(dir, {recursive: true, force: true});}
});

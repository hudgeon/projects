import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { savePrivate } from "./engine";
import type { Progress } from "../src/run-model";
import { makeRun, progress, deferred, fixture, waitFor } from "./run-fixtures";

test("an update restarts the runner at once, and the new runner adopts the conversation still executing", {timeout: 90000}, async () => {
  const dir = await fixture();
  const root = path.join(dir, "root"), stateDir = path.join(dir, "state");
  await mkdir(root, {recursive: true});
  const token = "fixture-runner-token-".padEnd(48, "x"), tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, token, {mode: 0o600});
  const run = makeRun();
  // Its turn already finished here: the executor only delivers the receipt.
  await savePrivate(path.join(stateDir, "runs", `${run.id}.json`), {generation: 1, phase: "finished", pid: null, progress: {...progress(), state: "completed", summary: "Done"}});
  const hold = deferred(), held = deferred();
  const claims: string[][] = [], reports: Progress[] = [], auth = new Set<string>();
  let claimed = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}");
    auth.add(req.headers.authorization ?? "");
    const reply = (value: unknown) => { res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(value)); };
    if (req.url === "/api/runner/claim") {
      claims.push(input.activeRunIds ?? []);
      if (!claimed) { claimed = true; return reply({run, activity: []}); }
      return reply({});
    }
    if (req.url === "/api/runner/heartbeat") { held.resolve(); await hold.promise; return reply({cancel: false, messages: run.messages}); }
    if (req.url === "/api/runner/report") { reports.push(input.progress); return reply({}); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(dir, "machine.json");
  await writeFile(config, JSON.stringify({host: "studio", root, home: dir, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile, stateDir, worktreeRoot: path.join(dir, "worktrees"), masterCwd: root, agents: ["claude"]}));
  const start = () => spawn(process.execPath, ["--import", "tsx", "runner/main.ts", config], {stdio: "ignore"});
  const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const file = path.join(stateDir, "executors", `${run.id}.json`);
  const running: ChildProcess[] = [];
  try {
    const first = start();
    running.push(first);
    await held.promise;
    const executor: number = JSON.parse(await readFile(file, "utf8")).pid;
    assert.notEqual(executor, first.pid, "the conversation runs in its own process");
    const firstExit = exited(first);
    first.kill("SIGUSR2");
    assert.equal(await firstExit, 0, "the runner exits at once for the update");
    assert.doesNotThrow(() => process.kill(executor, 0), "its executor keeps running");
    const before = claims.length;
    const second = start();
    running.push(second);
    await waitFor(() => claims.slice(before).some((active) => active.includes(run.id)));
    assert.equal(JSON.parse(await readFile(file, "utf8")).pid, executor, "no second executor started");
    hold.resolve();
    await waitFor(async () => !(await stat(file).catch(() => null)));
    assert.equal(reports.at(-1)?.state, "completed", "the adopted executor delivered its receipt");
    assert.deepEqual([...auth], [`Bearer ${token}`], "the executor got the runner token through its pipe");
    const seen = claims.length;
    await waitFor(() => claims.length > seen + 1 && !claims.at(-1)!.includes(run.id), 15000);
    const secondExit = exited(second);
    second.kill("SIGTERM");
    assert.equal(await secondExit, 0);
  } finally {
    hold.resolve();
    for (const child of running) child.kill("SIGTERM");
    server.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test("a runner fetches documents the owner opened through claims, and on its own while every slot is busy", {timeout: 60000}, async () => {
  const dir = await fixture();
  const root = path.join(dir, "root"), stateDir = path.join(dir, "state"), bin = path.join(dir, "bin");
  await mkdir(root, {recursive: true});
  await mkdir(bin, {recursive: true});
  // This machine's GitHub CLI, answering with the committed page.
  await writeFile(path.join(bin, "gh"), "#!/bin/sh\nprintf '<!doctype html><p>Page</p>'\n", {mode: 0o755});
  const token = "fixture-runner-token-".padEnd(48, "x"), tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, token, {mode: 0o600});
  const run = makeRun();
  await savePrivate(path.join(stateDir, "runs", `${run.id}.json`), {generation: 1, phase: "finished", pid: null, progress: {...progress(), state: "completed", summary: "Done"}});
  const job = (n: number) => ({id: String(n).repeat(64), lease: randomUUID(), repo: "acme/fixture", commit: "0123456789abcdef0123456789abcdef01234567", path: "mockups/screens.html"});
  const first = job(1), second = job(2);
  const hold = deferred();
  const claims: {documents?: boolean}[] = [], polls: unknown[] = [], delivered: {id: string; lease: string; content?: string}[] = [];
  let claimed = false, offered = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}");
    const reply = (value: unknown) => { res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(value)); };
    if (req.url === "/api/runner/claim") {
      claims.push(input);
      if (!claimed) { claimed = true; return reply({run, activity: [], document: first}); }
      return reply({});
    }
    if (req.url === "/api/runner/document") {
      if (!input.id) { polls.push(input); if (offered) return reply({}); offered = true; return reply({document: second}); }
      delivered.push(input);
      return reply({accepted: true});
    }
    if (req.url === "/api/runner/heartbeat") { await hold.promise; return reply({cancel: false, messages: run.messages}); }
    if (req.url === "/api/runner/report") return reply({});
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(dir, "machine.json");
  await writeFile(config, JSON.stringify({host: "studio", root, home: dir, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile, stateDir, worktreeRoot: path.join(dir, "worktrees"), masterCwd: root, agents: ["claude"], concurrency: 1, quickConcurrency: 0}));
  const runner = spawn(process.execPath, ["--import", "tsx", "runner/main.ts", config], {stdio: "ignore", env: {...process.env, PATH: `${bin}:${process.env.PATH}`}});
  try {
    await waitFor(() => delivered.length === 2, 30000);
    assert.equal(claims[0].documents, true, "a new runner says it can fetch documents");
    assert.deepEqual(delivered.map((d) => [d.id, d.lease]), [[first.id, first.lease], [second.id, second.lease]]);
    for (const d of delivered) assert.equal(Buffer.from(d.content!, "base64").toString(), "<!doctype html><p>Page</p>");
    assert.ok(polls.length >= 1, "a full runner asked on its own");
    assert.equal(claims.length, 1, "it did not claim while full");
    assert.equal(runner.exitCode, null, "a full runner keeps running");
  } finally {
    hold.resolve();
    runner.kill("SIGTERM");
    server.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test("a stopping runner abandons a document read at once and delivers nothing", {timeout: 60000}, async () => {
  const dir = await fixture();
  const root = path.join(dir, "root"), bin = path.join(dir, "bin"), started = path.join(dir, "started");
  await mkdir(root, {recursive: true});
  await mkdir(bin, {recursive: true});
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\ntouch ${started}\nexec sleep 30\n`, {mode: 0o755});
  const tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "fixture-runner-token-".padEnd(48, "x"), {mode: 0o600});
  const job = {id: "3".repeat(64), lease: randomUUID(), repo: "acme/fixture", commit: "0123456789abcdef0123456789abcdef01234567", path: "deck.html"};
  const delivered: unknown[] = [];
  let offered = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = (value: unknown) => { res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(value)); };
    if (req.url === "/api/runner/claim") { if (offered) return reply({}); offered = true; return reply({document: job}); }
    if (req.url === "/api/runner/document") { delivered.push(JSON.parse(body)); return reply({accepted: true}); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = path.join(dir, "machine.json");
  await writeFile(config, JSON.stringify({host: "studio", root, home: dir, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile, stateDir: path.join(dir, "state"), worktreeRoot: path.join(dir, "worktrees"), masterCwd: root, agents: ["claude"]}));
  const runner = spawn(process.execPath, ["--import", "tsx", "runner/main.ts", config], {stdio: "ignore", env: {...process.env, PATH: `${bin}:${process.env.PATH}`}});
  try {
    await waitFor(async () => !!(await stat(started).catch(() => null)), 30000);
    const exit = new Promise<number | null>((resolve) => runner.once("exit", (code) => resolve(code)));
    const at = Date.now();
    runner.kill("SIGTERM");
    assert.equal(await exit, 0);
    assert.ok(Date.now() - at < 5000, "the read did not hold the runner");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(delivered, [], "nothing delivered after stopping");
  } finally {
    runner.kill("SIGKILL");
    server.close();
    await rm(dir, {recursive: true, force: true});
  }
});

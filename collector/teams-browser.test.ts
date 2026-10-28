import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTeamsBrowser, teamsPage } from "./teams-browser";

async function profile(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "teams-browser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const page = (url: string, socket: string) => ({ type: "page", url, webSocketDebuggerUrl: socket });
async function endpoint(t: TestContext, dir: string, targets: unknown[], status = 200) {
  const server = createServer((request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(request.url === "/json/version"
      ? { webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/kept` }
      : targets));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  await writeFile(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/kept\n`);
  return port;
}

test("a restarted watcher reuses the signed-in browser on every reconnect without launching another tab", async (t) => {
  const dir = await profile(t);
  const socket = "ws://127.0.0.1/devtools/page/teams";
  await endpoint(t, dir, [page("about:blank", "other"), page("https://teams.cloud.microsoft/", socket)]);
  // A launch would fail. The browser survived the watcher, so no executable
  // should run, nor should the watcher claim ownership of that process.
  for (let restart = 0; restart < 3; restart++)
    assert.deepEqual(await openTeamsBrowser(path.join(dir, "must-not-launch"), dir), { child: null, url: socket });
});

test("a browser waiting for sign-in is reused, with its current page preserved", async (t) => {
  const dir = await profile(t);
  const socket = "ws://127.0.0.1/devtools/page/sign-in";
  await endpoint(t, dir, [page("https://login.microsoftonline.com/", socket)]);
  assert.deepEqual(await openTeamsBrowser("must-not-launch", dir), { child: null, url: socket });
});

test("a stale port file is replaced by a new browser's responding endpoint", async (t) => {
  const dir = await profile(t);
  const old = await endpoint(t, dir, [], 503);
  const executable = path.join(dir, "chrome");
  // Stand in for Chrome's process boundary: accept its profile flag, start
  // DevTools, write its chosen port and stay alive until the owner stops it.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const dir = process.argv.find(a => a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
const server = http.createServer((req, res) => res.end(JSON.stringify(req.url === '/json/version' ? {webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/devtools/browser/new'} : [{type:'page',url:'https://teams.cloud.microsoft/',webSocketDebuggerUrl:'ws://127.0.0.1/devtools/page/new'}])));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(dir+'/DevToolsActivePort', server.address().port+'\\n/devtools/browser/new\\n'));
`);
  await chmod(executable, 0o700);
  const opened = await openTeamsBrowser(executable, dir);
  t.after(() => opened?.child?.kill());
  assert.ok(opened?.child);
  assert.equal(opened.url, "ws://127.0.0.1/devtools/page/new");
  assert.notEqual(Number((await readFile(path.join(dir, "DevToolsActivePort"), "utf8")).split("\n")[0]), old);
  assert.equal(await teamsPage(dir), opened.url);
});

test("a missing browser executable is unavailable without an unhandled spawn error", async (t) => {
  const dir = await profile(t);
  assert.equal(await openTeamsBrowser(path.join(dir, "missing"), dir), null);
});

test("a malformed saved port and an endpoint with no pages are not a running browser", async (t) => {
  const dir = await profile(t);
  for (const port of ["0", "65536", "not-a-port"]) {
    await writeFile(path.join(dir, "DevToolsActivePort"), port);
    assert.equal(await teamsPage(dir), null);
  }
  await endpoint(t, dir, [{ type: "service_worker", url: "https://teams.cloud.microsoft/", webSocketDebuggerUrl: "worker" }]);
  assert.equal(await teamsPage(dir), null);
});

test("a saved port reused by a different browser instance is not this profile", async (t) => {
  const dir = await profile(t);
  const port = await endpoint(t, dir, [page("https://teams.cloud.microsoft/", "other-profile")]);
  await writeFile(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/old\n`);
  assert.equal(await teamsPage(dir), null);
});

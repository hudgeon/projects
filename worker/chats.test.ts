import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { browserMay, digest, token } from "./auth";
import type { Portfolio } from "./index";
import type { ChatList } from "../src/chat-model";
import { start, options } from "./miniflare-fixtures";

const owner = "owner@example.com",
  colleague = "colleague@example.com";
const secret = "PRIVATE-TEXT-MARKER";
const read = (observedAt: number, at = observedAt - 60_000, extra: object = {}) => ({
  source: "slack",
  owner,
  observedAt,
  state: "ok",
  items: [
    { id: "D1", place: { name: "Sam", kind: "direct", url: "https://example.slack.com/archives/D1" }, from: "Sam", at, count: 2, unread: true, mention: true, text: `${"Could you look at this please ".repeat(6)}${secret}` },
    { id: "C1", place: { name: "#ops", kind: "channel" }, from: "Jo", at: at - 1000, count: 1, unread: true, mention: false, text: "Release notes are posted" },
    { id: "C2", place: { org: "Customer", name: "#rollout", kind: "channel", shared: true }, from: "Alex", at: at - 2000, count: 1, unread: false, mention: false, text: "Already read in Slack" },
  ],
  ...extra,
});

test("each person's Slack and Teams items: the newest read wins, lists carry no text, and Done and Hand over hold until a newer message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "projects-chats-")), script = path.join(dir, "worker.mjs");
  await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"], outfile: script });
  const origin = "https://example.com", collector = `Bearer ${"c".repeat(64)}`, runner = `Bearer ${"r".repeat(64)}`;
  const mf = await start(await options(script, dir, { ALLOWED_EMAILS: `${owner}, ${colleague}`, OWNER_EMAIL: owner, COLLECTOR_TOKEN: "c".repeat(64), RUNNER_TOKEN: "r".repeat(64) }));
  const get = (route: string, headers: Record<string, string>) => mf.dispatchFetch(origin + route, { headers });
  const post = (route: string, body: unknown, headers: Record<string, string>) =>
    mf.dispatchFetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const signIn = async (email: string) => {
    const ns = await mf.getDurableObjectNamespace("PORTFOLIOS");
    const db = ns.get(ns.idFromName("test")) as unknown as Portfolio, salt = token(), value = token();
    assert.ok(await db.issue(email, salt, digest(`${salt}:123456`)));
    assert.ok(await db.verify(email, "123456", digest(value)));
    return { Cookie: `__Host-projects=${value}`, Origin: origin };
  };
  const list = async (as: Record<string, string>) => (await (await get("/api/chats", as)).json()) as ChatList;
  const states = (l: ChatList) => l.items.map((i) => [i.place.name, i.state]);
  try {
    const me = await signIn(owner), them = await signIn(colleague);
    const now = Date.now();
    assert.deepEqual(await (await post("/api/chats/read", read(now), { Authorization: collector })).json(), { accepted: true });
    // Only the person's own items, previews and never the text, nothing cached.
    const response = await get("/api/chats", me);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(secret));
    const mine = JSON.parse(body) as ChatList;
    assert.deepEqual(states(mine), [["Sam", "action"], ["#ops", "fyi"]], "read in Slack and not for them: not listed");
    assert.match(mine.items[0].preview, /^Could you look at this please/);
    assert.deepEqual(mine.reads.map((r) => [r.source, r.state, r.host]), [["slack", "ok", "studio"]]);
    assert.deepEqual((await list(them)).items, [], "nobody lists another person's items");
    const key = mine.items[0].key;
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(await (await get("/api/overview", me)).text(), new RegExp(secret), "the overview carries no chat");
    // One item's text, only to whoever holds it.
    const text = await get(`/api/chats/${key}`, me);
    assert.equal(text.headers.get("Cache-Control"), "no-store");
    assert.match(((await text.json()) as { text: string }).text, new RegExp(secret));
    assert.equal((await get(`/api/chats/${key}`, them)).status, 404);
    for (const machine of [collector, runner]) {
      assert.equal((await get("/api/chats", { Authorization: machine })).status, 401, "machine tokens never list");
      assert.equal((await get(`/api/chats/${key}`, { Authorization: machine })).status, 401, "nor read text back");
    }
    assert.equal((await post("/api/chats/read", read(now + 1000), { Authorization: runner })).status, 401, "only a collector posts reads");
    // The newest read per source and person wins; a stale or foreign one is refused.
    assert.equal((await post("/api/chats/read", read(now - 1000), { Authorization: collector })).status, 409);
    assert.equal((await post("/api/chats/read", read(now + 1000, now, { owner: "stranger@example.com" }), { Authorization: collector })).status, 400);
    assert.equal((await post("/api/chats/read", read(now - 3600_000), { Authorization: collector })).status, 400);
    assert.equal((await post("/api/chats/read", read(now + 1000), them)).status, 401, "a signed-in session posts no reads");
    // Done holds until a newer message.
    const act = (as: Record<string, string>, input: object) => post("/api/chats/act", { key, ...input }, as);
    assert.equal((await act(them, { action: "done" })).status, 404, "only its holder changes it");
    assert.deepEqual(states((await (await act(me, { action: "done" })).json()) as ChatList)[0], ["Sam", "done"]);
    assert.equal((await post("/api/chats/read", read(now + 1000, now - 60_000), { Authorization: collector })).status, 200);
    assert.deepEqual(states(await list(me))[0], ["Sam", "done"], "the same message again keeps Done");
    assert.equal((await post("/api/chats/read", read(now + 2000, now - 30_000), { Authorization: collector })).status, 200);
    assert.deepEqual(states(await list(me))[0], ["Sam", "action"], "a newer message reopens it");
    // Hand over: the colleague holds it, with its text, until a newer message.
    assert.equal((await act(me, { action: "hand", to: "stranger@example.com" })).status, 400);
    assert.equal((await act(me, { action: "hand" })).status, 400);
    const handed = (await (await act(me, { action: "hand", to: colleague })).json()) as ChatList;
    assert.deepEqual([handed.items[0].state, handed.items[0].handedTo], ["handed", colleague]);
    const theirs = await list(them);
    assert.deepEqual(theirs.items.map((i) => [i.key, i.state, i.handedBy]), [[key, "action", owner]]);
    assert.equal(theirs.reads.length, 0, "the owner's reads stay the owner's");
    assert.equal((await get(`/api/chats/${key}`, them)).status, 200);
    assert.equal((await act(me, { action: "done" })).status, 404, "the owner can only take it back");
    assert.deepEqual(states((await (await act(them, { action: "done" })).json()) as ChatList), [["Sam", "done"]]);
    assert.deepEqual(states(await list(me))[0], ["Sam", "handed"]);
    assert.deepEqual(states((await (await act(me, { action: "hand", to: owner })).json()) as ChatList)[0], ["Sam", "action"], "taken back");
    assert.equal((await get(`/api/chats/${key}`, them)).status, 404);
    assert.equal((await post("/api/chats/act", { key: "x", action: "done" }, me)).status, 400);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conversation browser's sign-in cannot reach anyone's chat", () => {
  assert.equal(browserMay("/api/chats", "GET"), false);
  assert.equal(browserMay(`/api/chats/${"a".repeat(64)}`, "GET"), false);
  assert.equal(browserMay("/api/chats/act", "POST"), false);
  assert.equal(browserMay("/api/chats/read", "POST"), false);
});

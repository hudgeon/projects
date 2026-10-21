import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTRACT, parseRow, rawSchema } from "./teams-chrome";
import { applyTeams, type TeamsRow } from "./teams";

// A small stand-in for the browser DOM, with only what the in-page script uses
// (attribute selectors, closest, children, text, clicks and an inherited font
// weight), so the script runs here against a copy of Teams' left-pane tree.
let clicked: El[] = [];
class Text {
  nodeType = 3;
  constructor(public nodeValue: string) {}
}
class El {
  nodeType = 1;
  parentElement: El | null = null;
  childNodes: (El | Text)[];
  constructor(public tag: string, private attrs: Record<string, string>, kids: (El | string)[]) {
    this.childNodes = kids.map((kid) => (typeof kid === "string" ? new Text(kid) : kid));
    for (const kid of this.children) kid.parentElement = this;
  }
  get children() {
    return this.childNodes.filter((n): n is El => n instanceof El);
  }
  get id() {
    return this.attrs.id ?? "";
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  click() {
    clicked.push(this);
  }
  get innerText(): string {
    const parts = this.childNodes.map((n) => (n instanceof El ? n.innerText : n.nodeValue));
    return this.tag === "div" ? parts.filter(Boolean).join("\n") : parts.join("");
  }
  matches(selector: string) {
    return selector.split(",").some((one) => matchOne(this, one.trim()));
  }
  closest(selector: string) {
    for (let el: El | null = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }
  querySelectorAll(selector: string) {
    const found: El[] = [];
    const walk = (el: El) => {
      for (const kid of el.children) {
        if (kid.matches(selector)) found.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
function matchOne(el: El, selector: string) {
  const m = /^([a-z]*)((?:#[\w-]+)?)((?:\[[^\]]+\])*)$/i.exec(selector);
  if (!m) throw new Error(`The stand-in DOM does not support ${selector}`);
  if ((m[1] && m[1] !== el.tag) || (m[2] && el.id !== m[2].slice(1))) return false;
  for (const [, name, op, quoted, bare] of m[3].matchAll(/\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|([^\]]*)))?\]/g)) {
    const value = el.getAttribute(name);
    const want = quoted ?? bare ?? "";
    if (value === null || (op === "=" && value !== want) || (op === "^=" && !value.startsWith(want))) return false;
  }
  return true;
}
const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (El | string)[]) => new El(tag, attrs, kids);
const fontWeight = (el: El) => {
  for (let e: El | null = el; e; e = e.parentElement) {
    const weight = /font-weight:\s*(\d+)/.exec(e.getAttribute("style") ?? "");
    if (weight) return weight[1];
  }
  return "400";
};
function run(host: string, body: El) {
  clicked = [];
  const evaluate = new Function("document", "location", "getComputedStyle", `return ${EXTRACT}`);
  return rawSchema.parse(evaluate(h("html", {}, body), { host }, (el: El) => ({ fontWeight: fontWeight(el) })));
}

// Teams' tree as the real page draws it (ids and names made up): folder
// headings hold their rows in a nested group, a row's thread id sits in its test
// id, tree value and title id, and an avatar's initials are bold.
const CHANNEL = "19:abcDEF123channelxyz@thread.tacv2";
const ONE = "19:aaaa1111-bbbb-2222-cccc-3333dddd4444_eeee5555-ffff-6666-aaaa-7777bbbb8888@unq.gbl.spaces";
const GROUP = "19:0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c@thread.v2";
const TEAM = "19:fedcba987teamxyz@thread.tacv2";
const PLATFORM = "19:platform555teamxyz@thread.tacv2";
const NESTED = "19:releases777channel@thread.tacv2";
const VALUE = "OneGQL_SystemDefinedConversationFolder|tenant~person";
const OPEN = (id: string) => `{"observed":{"names":["${id}","LeftRailSelectedItem"]}}`;
const folder = (type: string, label: string, value: string, expanded: string, ...rows: El[]) =>
  h("div", { role: "treeitem", "aria-level": "1", "aria-expanded": expanded, "data-item-type": type, "data-conversation-folder": "true", "data-fui-tree-item-value": value },
    h("div", {}, h("span", {}, label)),
    h("div", { role: "group" }, ...rows));
const row = (level: string, attrs: Record<string, string>, ...kids: El[]) =>
  h("div", { role: "treeitem", "aria-level": level, ...attrs }, h("div", {}, ...kids));
const avatar = (initials: string) => h("span", { role: "img", id: "avatar-r1", style: "font-weight: 600" }, h("span", { "aria-hidden": "true" }, initials));
const title = (kind: string, id: string, name: string, bold = false) =>
  h("span", { id: `title-${kind}-list-item-${id}`, ...(bold ? { style: "font-weight: 700" } : {}) }, name);
function teamsPage(open: "channel" | "drafts") {
  const drafts = row("2", { "data-item-type": "slice", "data-testid": "slice-list-item-slice-drafts", ...(open === "drafts" ? { "data-tabster": OPEN("drafts") } : {}) }, h("span", {}, "Drafts"));
  const chats = folder("chats", "Chats", `${VALUE}~RecentChats`, "false",
    row("2", { "data-item-type": "chat", "data-testid": `chat-list-item-${ONE}` },
      avatar("SR"), h("div", {}, title("chat", ONE, "Sam Rivers")), h("div", {}, h("span", {}, "Could you send the cost sheet")), h("div", {}, h("span", {}, "9:42 AM"))),
    row("2", { "data-item-type": "chat", "data-testid": `chat-list-item-${GROUP}` },
      h("div", {}, title("chat", GROUP, "Rollout crew", true)), h("div", {}, h("span", {}, "Priya: Moved to Thursday"))));
  const tree = h("div", { role: "tree", "data-tid": "simple-collab-dnd-rail" },
    folder("quick-views", "Quick views", `${VALUE}~QuickViews`, "true",
      row("2", { "data-item-type": "slice", "data-testid": "slice-list-item-slice-activities-mentions" }, h("span", {}, "Mentions")), drafts),
    folder("custom-folder", "Favorites", "OneGQL_UserDefinedConversationFolder|tenant~person~Favorites", "true",
      row("2", { "data-item-type": "channel", "data-testid": `favorite-channel-list-item-${CHANNEL}`, ...(open === "channel" ? { "data-tabster": OPEN(CHANNEL) } : {}) },
        avatar("SU"), title("channel", CHANNEL, "Support", true), h("div", { id: `time-channel-list-item-${CHANNEL}` }))),
    chats,
    folder("teams-and-channels", "Teams and channels", `${VALUE}~TeamsAndChannels`, "true",
      // The favourite is its team's own channel: the same thread id, read once.
      row("2", { "data-item-type": "team", "aria-expanded": "false", "data-testid": "list-item-teams-and-channels", "data-fui-tree-item-value": `${VALUE}/OneGQL_Team|${CHANNEL}` }, title("team", CHANNEL, "Support")),
      row("2", { "data-item-type": "team", "aria-expanded": "false", "data-testid": "list-item-teams-and-channels", "data-fui-tree-item-value": `${VALUE}/OneGQL_Team|${TEAM}` }, title("team", TEAM, "Operations", true)),
      h("div", { role: "treeitem", "aria-level": "2", "aria-expanded": "true", "data-item-type": "team", "data-fui-tree-item-value": `${VALUE}/OneGQL_Team|${PLATFORM}` },
        h("div", {}, title("team", PLATFORM, "Platform", true)),
        h("div", { role: "group" }, row("3", { "data-item-type": "channel", "data-testid": `channel-list-item-${NESTED}` }, title("channel", NESTED, "Releases")))),
      row("2", { "data-fui-tree-item-value": "fuiTreeItemValue-r2b" }, h("span", {}, "See all your teams"))));
  return { tree, drafts, chats };
}

test("the in-page script reads only conversation rows, each by its own thread id", () => {
  const page = teamsPage("channel");
  const read = run("teams.cloud.microsoft", page.tree);
  assert.deepEqual([read.signedIn, read.listed], [true, true]);
  // No heading, quick view, unfolded team or id-less row; the favourite's team
  // shares its id and is read once; a nested channel is its own row.
  assert.deepEqual(read.rows.map((r) => [r.id, r.name]), [
    [CHANNEL, "Support"],
    [ONE, "Sam Rivers"],
    [GROUP, "Rollout crew"],
    [TEAM, "Operations"],
    [NESTED, "Releases"],
  ]);
  const byId = new Map(read.rows.map((r) => [r.id, r]));
  assert.deepEqual([byId.get(CHANNEL)?.favorite, byId.get(CHANNEL)?.unread], [true, true], "a favourite with a bold title");
  assert.equal(byId.get(ONE)?.unread, false, "a bold avatar is no unread mark");
  assert.equal(byId.get(ONE)?.detail, "Could you send the cost sheet · 9:42 AM", "initials are not the preview");
  assert.equal(byId.get(NESTED)?.favorite, false);
  // Teams had reopened the favourite: the script moved to Drafts and unfolded
  // Chats, and clicked nothing else.
  assert.deepEqual(clicked, [page.drafts, page.chats]);
  const rows = read.rows.map(parseRow).filter((r): r is TeamsRow => r !== null);
  const items = applyTeams(new Map(), rows, 1000);
  assert.deepEqual([...items.keys()], [CHANNEL, ONE, GROUP, TEAM]);
  assert.deepEqual([items.get(CHANNEL)?.mention, items.get(TEAM)?.mention, items.get(GROUP)?.from], [true, false, "Priya"]);
});

test("the in-page script leaves a page with nothing open alone, and tells a sign-in prompt from a sign-in hop", () => {
  const page = teamsPage("drafts");
  run("teams.cloud.microsoft", page.tree);
  assert.deepEqual(clicked, [page.chats]);
  const state = (host: string, body: El) => {
    const read = run(host, body);
    return [read.signedIn, read.listed];
  };
  assert.deepEqual(state("login.microsoftonline.com", h("body", {}, h("input", { type: "password" }))), [false, false]);
  assert.deepEqual(state("login.microsoftonline.com", h("body", {})), [true, false]);
  assert.deepEqual(state("teams.cloud.microsoft", h("body", {})), [true, false]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentPosition, emailLinks, type Position } from "../src/work-model";
import { inboxQueue, inboxRows, inboxSchema, trackedThreads, type Inbox } from "../src/inbox-model";
import { parseNavigation } from "../src/navigation";
import { htmlToText, latestOnly, messageText, readInbox, unsubscribeOptions } from "../collector/inbox";
import { privateAddress, publicHttps, publicLookup } from "../collector/inbox-actions";
import { agenda, agendaOrder, rows, type Row } from "../src/work-view";
import { sendOnEnter } from "../src/run-view";
import { revealAction } from "../src/screenshots";
import { awaitsYou } from "../src/run-model";
import type { KeyboardEvent } from "react";
import { readIssues } from "../collector/work";
import { issue } from "./work-fixtures";
import { hostHealth, type Snapshot } from "../src/model";
const pos = (status: Position["status"]): Position => ({
  status,
  reviewed: "2026-09-26",
  why: "Customer commitment",
  position: "Unfulfilled",
  next: "Verify — Sam; Monday",
  priority: null,
  due: null,
});
const row = (over: Partial<Row> = {}): Row => ({
  issue: issue(1),
  sessions: [],
  pulls: [],
  checkouts: [],
  close: undefined,
  done: false,
  lastActive: null,
  recent: false,
  live: false,
  emailAttention: false,
  ...over,
});
const thread = {
  id: "abcdef123456",
  subject: "Request",
  from: "Client",
  latestMessageId: "abcdef123457",
  updatedAt: 100,
  lastSentByMe: false,
  unread: false,
  messages: 2,
};
const inbox: Inbox = {
  account: "owner@example.com",
  observedAt: 100,
  state: "ok",
  threads: [thread],
};
test("only an explicit bounded Current position assessment controls the agenda", () => {
  assert.equal(
    currentPosition("Status: being worked on. Reviewed: 2026-09-26."),
    null,
  );
  assert.deepEqual(
    currentPosition(
      "## Current position\nStatus: waiting on someone. Reviewed: 2026-09-26.\nOutcome / why now: Customer commitment\nPosition: Unfulfilled\nNext: Verify — Sam; Monday\n## Old scope\nNext: wrong",
    ),
    pos("waiting on someone"),
  );
  assert.equal(
    currentPosition(
      "## Current position\nStatus: probably done. Reviewed: 2026-09-26.",
    ),
    null,
  );
  assert.equal(agenda(row({ done: true, recent: true })), "history");
  assert.equal(agenda(row({ recent: true })), "review");
  assert.equal(agenda(row({ live: true })), "active");
  for (const [status, section] of [
    ["needs you", "needs"],
    ["being worked on", "active"],
    ["waiting on someone", "waiting"],
    ["planned", "planned"],
    ["deferred", "planned"],
    ["delivered", "review"],
    ["cancelled", "review"],
  ] as const)
    assert.equal(
      agenda(row({ issue: issue(1, { position: pos(status) }) })),
      section,
    );
  // A new email on closed work belongs to the Inbox, not the open work list.
  assert.equal(agenda(row({ done: true, emailAttention: true })), "history");
});
test("business priority and deadlines outrank noisy session recency", () => {
  const earlier = row({
    issue: issue(1, { position: { ...pos("needs you"), due: "2026-09-27" } }),
  });
  const later = row({
    issue: issue(2, { position: { ...pos("needs you"), due: "2026-10-02" } }),
    recent: true,
    lastActive: Date.now(),
  });
  assert.ok(agendaOrder(earlier, later) < 0);
  assert.ok(
    agendaOrder(
      row({
        issue: issue(3, {
          position: { ...pos("needs you"), priority: "now" },
        }),
      }),
      earlier,
    ) < 0,
  );
});
test("email links are explicit; a new inbound or outbound message invalidates every linked assessment", () => {
  const link = {
    threadId: thread.id,
    reviewedMessageId: thread.latestMessageId,
  };
  assert.deepEqual(
    emailLinks(`Arbitrary https://mail.google.com/mail/u/0/#all/${thread.id}`),
    [],
  );
  assert.deepEqual(
    emailLinks(
      `## Email threads\n- [Request](https://mail.google.com/mail/u/?authuser=owner@example.com#all/${thread.id}) · reviewed: ${thread.latestMessageId}\n## Other\n- https://mail.google.com/mail/u/0/#all/abcdef999999`,
    ),
    [
      {
        ...link,
        subject: "Request",
        context: undefined,
        url: `https://mail.google.com/mail/u/?authuser=owner@example.com#all/${thread.id}`,
      },
    ],
  );
  const linked = issue(1, { emailLinks: [link] });
  assert.equal(inboxRows(inbox, [linked])[0].reviewed, true);
  assert.equal(
    inboxRows(inbox, [
      linked,
      issue(2, { emailLinks: [{ ...link, reviewedMessageId: null }] }),
    ])[0].reviewed,
    false,
  );
  for (const lastSentByMe of [false, true])
    assert.equal(
      inboxRows(
        {
          ...inbox,
          threads: [
            { ...thread, lastSentByMe, latestMessageId: "abcdef999999" },
          ],
        },
        [linked],
      )[0].reason,
      "New message to review",
    );
  assert.equal(
    inboxRows(inbox, [issue(1, { title: thread.subject })])[0].linked.length,
    0,
  );
  assert.equal(
    inboxRows(inbox, [{ ...linked, open: false }])[0].linked.length,
    1,
  );
  // Only the latest message's bounded text travels; no snippet, attachment or
  // other content field is representable.
  assert.equal(
    inboxSchema.safeParse({
      ...inbox,
      threads: [{ ...thread, body: "x".repeat(4001) }],
    }).success,
    false,
  );
  assert.equal(
    inboxSchema.safeParse({
      ...inbox,
      threads: [{ ...thread, snippet: "NEVER UPLOAD" }],
    }).success,
    false,
  );
});
const account = "owner@example.com";
const message = (id: string, labels: string[] = [], at = "100") => ({
  id,
  internalDate: at,
  labelIds: labels,
  payload: {
    headers: [
      { name: "Subject", value: "Subject" },
      { name: "From", value: "Client" },
    ],
  },
});
test("inbox reads thread metadata plus only the latest message's text, paginated, deduplicated and account-bound; draft saves are not customer replies", async () => {
  const calls: string[][] = [];
  const result = await readInbox(account, async (args) => {
    calls.push(args);
    const params = JSON.parse(args.at(-1)!);
    if (args.includes("getProfile"))
      return JSON.stringify({ emailAddress: account });
    if (args.includes("labels")) return JSON.stringify({ labels: [] });
    if (args.includes("list"))
      return JSON.stringify(
        params.pageToken
          ? { threads: [{ id: thread.id }] }
          : { threads: [{ id: thread.id }], nextPageToken: "next" },
      );
    if (args.includes("messages")) {
      // One full read of the newest non-draft message: its text, nothing else.
      assert.deepEqual([params.id, params.format, params.fields], [thread.latestMessageId, "full", "payload"]);
      return JSON.stringify({ payload: { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Thanks — Thursday works.\n\nOn Mon, 12 Oct 2026, Client wrote:\n> old").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from("<p>ignored</p>").toString("base64url") } },
      ] } });
    }
    assert.equal(params.format, "metadata");
    assert.ok(!params.fields.includes("body"));
    assert.ok(params.metadataHeaders.includes("List-Unsubscribe"));
    return JSON.stringify({
      id: thread.id,
      messages: [
        message(thread.id, ["INBOX"]),
        message(thread.latestMessageId, ["SENT"], "200"),
        message("abcdef999999", ["DRAFT"], "300"),
      ],
    });
  });
  assert.equal(result.state, "ok");
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].latestMessageId, thread.latestMessageId);
  assert.equal(result.threads[0].lastSentByMe, true);
  assert.equal(result.threads[0].body, "Thanks — Thursday works.");
  assert.equal(result.threads[0].unsubscribe, null);
  assert.equal(calls.length, 6);
  const wrong = await readInbox(account, async () =>
    JSON.stringify({ emailAddress: "other@example.com" }),
  );
  assert.equal(wrong.state, "unavailable");
  assert.deepEqual(wrong.threads, []);
});
test("failed thread reads and inbox limits remain incomplete, never a clean inbox", async () => {
  const run = async (args: string[]) => {
    if (args.includes("getProfile"))
      return JSON.stringify({ emailAddress: account });
    if (args.includes("labels")) return JSON.stringify({ labels: [] });
    if (args.includes("list"))
      return JSON.stringify({
        threads: [{ id: thread.id }],
        nextPageToken: "still-more",
      });
    throw Error("Unavailable");
  };
  assert.equal((await readInbox(account, run)).state, "incomplete");
  assert.equal(
    (
      await readInbox(account, async () => {
        throw Error("Offline");
      })
    ).state,
    "unavailable",
  );
});
test("latest comment reads use the tail, retain body assessments and disclose failed comment coverage", async () => {
  const raw = {
    number: 1,
    title: "Issue",
    body: "## Current position\nStatus: needs Sam. Reviewed: 2026-09-26.\nNext: Release verification",
    url: "https://github.com/acme/work/issues/1",
    state: "OPEN",
    issueType: null,
    labels: [],
    milestone: null,
    updatedAt: "2026-09-26T00:00:00Z",
  };
  const gh = async (args: string[]) => {
    if (args[0] === "api") {
      assert.match(args.at(-1)!, /comments\(last:1\)/);
      return JSON.stringify({
        data: {
          repository: {
            i1: {
              comments: {
                nodes: [
                  {
                    body: "Deployment failed",
                    url: raw.url + "#issuecomment-1",
                    updatedAt: raw.updatedAt,
                  },
                ],
              },
            },
          },
        },
      });
    }
    return JSON.stringify(args.includes("closed") ? [] : [raw]);
  };
  const [read] = await readIssues(gh, "acme/work");
  assert.equal(read.position?.status, "needs you");
  assert.equal(read.latestUpdate?.body, "Deployment failed");
  const [failed] = await readIssues(
    async (a) => (a[0] === "api" ? Promise.reject(Error("offline")) : gh(a)),
    "acme/work",
  );
  assert.equal(failed.updatesState, "unavailable");
  assert.equal(failed.position?.status, "needs you");
});

test("a reference label belongs to the reviewed message and never suppresses linked work", () => {
  const reference = { ...inbox, threads: [{ ...thread, reference: true }] };
  assert.equal(inboxRows(reference, [])[0].reason, "Reference only");
  assert.equal(inboxRows(reference, [])[0].reviewed, true);
  assert.equal(
    inboxRows(reference, [
      issue(1, {
        emailLinks: [{ threadId: thread.id, reviewedMessageId: null }],
      }),
    ])[0].reason,
    "New message to review",
  );
  assert.equal(inboxRows(inbox, [])[0].reviewed, false);
});

test("unchanged Gmail history reuses metadata; a new message or reference-label mapping forces a reread", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "projects-inbox-"));
  let history = "1",
    reads = 0,
    texts = 0,
    failText = false,
    label = "label-1",
    messageId = thread.latestMessageId;
  const run = async (args: string[]) => {
    if (args.includes("getProfile"))
      return JSON.stringify({ emailAddress: account });
    if (args.includes("labels"))
      return JSON.stringify({
        labels: [{ id: label, name: "Projects/Reference" }],
      });
    if (args.includes("list"))
      return JSON.stringify({
        threads: [{ id: thread.id, historyId: history }],
      });
    if (args.includes("messages")) {
      texts++;
      if (failText) throw Error("timeout");
      return JSON.stringify({ payload: { mimeType: "text/plain", body: { data: Buffer.from(`Text ${messageId}`).toString("base64url") } } });
    }
    reads++;
    return JSON.stringify({
      id: thread.id,
      historyId: history,
      messages: [message(messageId, ["INBOX", label])],
    });
  };
  try {
    for (let i = 0; i < 2; i++) {
      const read = await readInbox(account, run, 100, home);
      assert.equal(read.state, "ok");
      assert.equal(read.threads[0].body, `Text ${thread.latestMessageId}`, "cached text is reused");
    }
    assert.deepEqual([reads, texts], [1, 1]);
    history = "2";
    messageId = "abcdef999999";
    assert.equal(
      (await readInbox(account, run, 200, home)).threads[0].latestMessageId,
      messageId,
    );
    assert.deepEqual([reads, texts], [2, 2]);
    label = "label-2";
    await readInbox(account, run, 300, home);
    assert.deepEqual([reads, texts], [3, 3]);
    // A failed text read keeps the thread and coverage, and is read again next time.
    history = "3";
    failText = true;
    const partial = await readInbox(account, run, 400, home);
    assert.deepEqual([partial.state, partial.threads[0].body], ["ok", undefined]);
    failText = false;
    assert.equal((await readInbox(account, run, 500, home)).threads[0].body, "Text abcdef999999");
    assert.deepEqual([reads, texts], [5, 5]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("archived linked threads stay observable and safe issue context stays with the reviewed message", async () => {
  const tracked = "1a0e4e371b1329ef";
  const result = await readInbox(account, async (args) => {
    if (args.includes("getProfile")) return JSON.stringify({emailAddress: account});
    if (args.includes("labels")) return JSON.stringify({labels: []});
    if (args.includes("list")) return JSON.stringify({threads: []});
    return JSON.stringify({id: tracked, messages: [{id: "1a0e639d91d4cbde", internalDate: "1234", labelIds: [], payload: {headers: [{name: "Subject", value: "Recovery confirmation"}]}}]});
  }, 2000, undefined, [tracked]);
  assert.equal(result.state, "ok");
  assert.equal(result.threads[0].inInbox, false);
  assert.equal(result.threads[0].latestMessageId, "1a0e639d91d4cbde");
  const links = emailLinks(`## Email threads\n- [Recovery](https://mail.google.com/mail/u/0/#all/${tracked}) · reviewed: 1a0e639d91d4cbde · context: Neil reran the script; Sam to verify received files.`);
  assert.equal(links[0].subject, "Recovery");
  assert.match(links[0].context!, /Sam to verify/);
});

test("only the inbox's own account is tracked; other mailboxes are outside coverage, not failures", () => {
  const own = "1a0e4e371b1329ef", other = "1a0e4e371b1329aa", indexed = "1a0e4e371b1329bb", path = "1a0e4e371b1329cc", ownPath = "1a0e4e371b1329dd";
  const linked = issue(9, {emailLinks: [
    {threadId: own, url: `https://mail.google.com/mail/u/?authuser=Owner%40Example.com#all/${own}`, reviewedMessageId: null},
    {threadId: other, url: `https://mail.google.com/mail/u/?authuser=other%40elsewhere.example#all/${other}`, reviewedMessageId: null},
    {threadId: indexed, url: `https://mail.google.com/mail/u/1/#all/${indexed}`, reviewedMessageId: null},
    {threadId: path, url: `https://mail.google.com/mail/u/other@elsewhere.example/#all/${path}`, reviewedMessageId: null},
    {threadId: ownPath, url: `https://mail.google.com/mail/u/owner%40example.com/#all/${ownPath}`, reviewedMessageId: null},
  ]});
  assert.deepEqual(trackedThreads("owner@example.com", [linked]), [own, indexed, ownPath]);
});

test("each email shows whether a conversation is handling it, handled it or it still needs the user", () => {
  const at = (n: number) => ({ createdAt: n, updatedAt: n });
  const conversation = (id: string, over: Record<string, unknown>) => ({ id, emailThread: thread.id, archivedAt: null, state: "running" as const, ...at(150), ...over });
  const state = (runs: ReturnType<typeof conversation>[], over: Partial<typeof thread> = {}) =>
    inboxQueue({ ...inbox, threads: [{ ...thread, ...over }] }, [], runs)[0].state;
  assert.equal(state([]), "todo");
  assert.equal(state([conversation("a", {})]), "handling");
  assert.equal(state([conversation("a", { state: "blocked" })]), "handling", "the user answers in the conversation");
  assert.equal(state([conversation("a", { state: "failed" })]), "todo", "a failed attempt leaves the email to handle");
  assert.equal(state([conversation("a", { state: "cancelled" })]), "todo");
  assert.equal(state([conversation("a", { state: "completed", archivedAt: 160 })]), "handled", "Done after the latest message");
  assert.equal(state([conversation("a", { state: "completed", archivedAt: 160 })], { updatedAt: 200 }), "todo", "they wrote again afterwards");
  assert.equal(state([conversation("a", { state: "completed", archivedAt: 160 })], { updatedAt: 200, lastSentByMe: true }), "handled", "the user's own reply");
  assert.equal(state([conversation("old", { archivedAt: 120, ...at(110) }), conversation("new", { ...at(170) })]), "handling", "the newest conversation wins");
  assert.equal(state([conversation("a", { emailThread: "fedcba654321" })]), "todo", "joined by thread ID only");
});

test("an email that has left the inbox leaves the queue, though its work item still follows it", () => {
  const archived = { threadId: thread.id, action: "archive" as const, requestedAt: 150, state: "done" as const, message: null, updatedAt: 160 };
  const queue = (over: Partial<Inbox["threads"][number]>) =>
    inboxQueue({ ...inbox, threads: [{ ...thread, ...over }] }, [], [], [archived]).map((item) => item.state);
  assert.deepEqual(queue({ inInbox: true }), ["clearing"], "until a read sees it archived");
  assert.deepEqual(queue({ inInbox: false }), [], "archived in Gmail");
  assert.deepEqual(queue({}), ["clearing"], "an older collector's read keeps its threads");
  const linked = issue(9, { emailLinks: [{ threadId: thread.id, reviewedMessageId: null }] });
  assert.equal(inboxRows({ ...inbox, threads: [{ ...thread, inInbox: false }] }, [linked])[0].reviewed, false, "its work item still sees the unread message");
});

test("the latest message becomes plain text without quoted history or rendered HTML", () => {
  assert.equal(latestOnly("Sounds good.\r\n\r\nOn Mon, 12 Oct 2026 at 10:10, Rob Smith <\nrob@example.com> wrote:\n> earlier"), "Sounds good.");
  assert.equal(latestOnly("Yes.\n\nFrom: Rob\nSent: Monday\nSubject: Re: plan\nolder"), "Yes.");
  assert.equal(latestOnly("Top\n> quoted line\nBottom\n________________\nOutlook history"), "Top\nBottom");
  assert.equal(latestOnly("x".repeat(5000)).length, 4000);
  assert.equal(latestOnly("Email events@example.org<mailto:events@example.org> or book here<https://example.org/rsvp>"), "Email events@example.org or book here https://example.org/rsvp");
  assert.equal(htmlToText("<style>p{}</style><p>Hello&nbsp;<b>there</b> &amp; you&#33;</p><script>alert(1)</script><ul><li>One</li></ul>").trim(), "Hello there & you!\n• One");
  const encode = (text: string) => Buffer.from(text).toString("base64url");
  assert.equal(messageText({ mimeType: "multipart/related", parts: [
    { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "x", size: 10 } },
    { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: encode("<div>Only HTML</div>") } }] },
  ] }), "Only HTML", "attachments are never read; HTML is converted, not rendered");
});

test("unsubscribe options come from the list headers; one-click needs RFC 8058 over HTTPS", () => {
  assert.deepEqual(unsubscribeOptions({ "list-unsubscribe": "<mailto:leave@list.example?subject=unsubscribe>, <https://list.example/u/123>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" }), { oneClick: true, url: "https://list.example/u/123", mailto: "mailto:leave@list.example?subject=unsubscribe" });
  assert.equal(unsubscribeOptions({ "list-unsubscribe": "<https://list.example/u/123>" })?.oneClick, false, "a link alone needs a person or a conversation");
  assert.deepEqual(unsubscribeOptions({ "list-unsubscribe": "<http://list.example/u>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" }), null);
  assert.equal(unsubscribeOptions({}), null);
});

test("one-click unsubscribe reaches only public HTTPS hosts, checked on the connection's own lookup", async () => {
  assert.equal(publicHttps("https://list.example/u")?.hostname, "list.example");
  for (const url of ["http://list.example/u", "https://192.168.1.10/u", "https://[::1]/u", "https://router.lan/u", "https://localhost/u", "https://user:pass@list.example/u", "https://list.example:8443/u", "not a url"])
    assert.equal(publicHttps(url), null, url);
  for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.0.1", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "64:ff9b::a00:1", "not-an-ip"])
    assert.equal(privateAddress(address), true, address);
  for (const address of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
    assert.equal(privateAddress(address), false, address);
  // The address used to connect is the one that is checked: any private answer fails.
  const lookupWith = (addresses: string[]) =>
    new Promise<string>((resolve) =>
      publicLookup((_host, _options, callback) => callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))))(
        "list.example", {}, (error, address) => resolve(error ? "blocked" : String(address)),
      ),
    );
  assert.equal(await lookupWith(["93.184.216.34"]), "93.184.216.34");
  assert.equal(await lookupWith(["93.184.216.34", "10.0.0.5"]), "blocked");
  assert.equal(await lookupWith([]), "blocked");
});

test("old work agenda and conversation links open Today", () => {
  assert.deepEqual(parseNavigation({ view: "work" }), { view: "today" });
  assert.deepEqual(parseNavigation({ view: "conversations", run: "6f1d1b9a-6a39-4c43-9a6b-2b7c3e5e2f10", archived: true }), { view: "today", run: "6f1d1b9a-6a39-4c43-9a6b-2b7c3e5e2f10", archived: true });
  assert.deepEqual(parseNavigation({ view: "unknown" }), { view: "today" });
  assert.equal(parseNavigation({ view: "health" }).view, "health");
});
const press = (key: string, extra: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean; keyCode?: number; touch?: boolean } = {}) => {
  let sent = 0, prevented = false;
  sendOnEnter(
    {
      key,
      shiftKey: !!extra.shiftKey,
      metaKey: !!extra.metaKey,
      ctrlKey: !!extra.ctrlKey,
      keyCode: extra.keyCode ?? 13,
      nativeEvent: { isComposing: !!extra.isComposing },
      preventDefault: () => { prevented = true; },
    } as unknown as KeyboardEvent<HTMLTextAreaElement>,
    () => sent++,
    ...(extra.touch === undefined ? [] : [extra.touch]),
  );
  return [sent, prevented];
};
test("Enter sends a message; Shift+Enter and input-method Enter do not", () => {
  assert.deepEqual(press("Enter"), [1, true]);
  assert.deepEqual(press("Enter", { metaKey: true }), [1, true]);
  assert.deepEqual(press("Enter", { shiftKey: true }), [0, false], "Shift+Enter keeps the new paragraph");
  assert.deepEqual(press("Enter", { isComposing: true }), [0, false]);
  assert.deepEqual(press("Enter", { keyCode: 229 }), [0, false]);
  assert.deepEqual(press("a"), [0, false]);
  assert.deepEqual(press("Enter", { touch: false }), [1, true]);
});
test("Return on a phone keyboard starts a new line instead of sending", () => {
  assert.deepEqual(press("Enter", { touch: true }), [0, false], "the textarea inserts the new line");
  assert.deepEqual(press("Enter", { touch: true, shiftKey: true }), [0, false]);
  assert.deepEqual(press("Enter", { touch: true, metaKey: true }), [1, true], "an attached keyboard still sends");
  assert.deepEqual(press("Enter", { touch: true, ctrlKey: true }), [1, true]);
  assert.deepEqual(press("Enter", { touch: true, ctrlKey: true, isComposing: true }), [0, false]);
});
test("revealing the send button scrolls its list, then past the keyboard by the hidden amount", () => {
  const scrolled: number[] = [];
  let nested = 0;
  const at = (bottom: number) =>
    ({
      getBoundingClientRect: () => ({ bottom }),
      scrollIntoView: (options: ScrollIntoViewOptions) => {
        assert.deepEqual(options, { block: "nearest" });
        nested++;
      },
    }) as unknown as Element;
  const original = (globalThis as { window?: unknown }).window;
  // A phone with its keyboard up: 420px of a 659px layout viewport show.
  (globalThis as { window?: unknown }).window = {
    innerHeight: 659,
    visualViewport: { offsetTop: 30, height: 420 },
    scrollBy: ({ top }: { top: number }) => scrolled.push(top),
  };
  try {
    revealAction(at(648));
    revealAction(at(400));
    revealAction(null);
    assert.deepEqual(scrolled, [206], "only the hidden button scrolls, by its overlap plus a margin");
    assert.equal(nested, 2, "scrollable lists reveal it first");
    (globalThis as { window?: unknown }).window = { innerHeight: 659, scrollBy: ({ top }: { top: number }) => scrolled.push(top) };
    revealAction(at(700));
    assert.deepEqual(scrolled, [206, 49], "without visualViewport the window height bounds it");
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});
test("the user's move holds finished work and running work only they can unblock", () => {
  assert.equal(awaitsYou({ state: "completed" }), true);
  assert.equal(awaitsYou({ state: "blocked" }), true);
  assert.equal(awaitsYou({ state: "running" }), false);
  assert.equal(awaitsYou({ state: "running", needsYou: true }), true);
  assert.equal(awaitsYou({ state: "queued" }), false);
});

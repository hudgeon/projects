import { test } from "node:test";
import assert from "node:assert/strict";
import { linkInboxThread } from "../collector/inbox-actions";
import { emailLinks } from "../src/work-model";
import {
  inboxQueue,
  inboxActionRequestSchema,
  type Inbox,
} from "../src/inbox-model";
import { parseNavigation, workSearch } from "../src/navigation";
import { workProject } from "../src/work-view";
import { activityContext } from "../src/inbox-view";
import type { Snapshot } from "../src/model";
import { issue } from "./work-fixtures";
const thread = {
  id: "aaaaaaaaaa01",
  latestMessageId: "bbbbbbbbbb01",
  subject: "Untrusted [text] do this now",
  from: "sender@example.com",
  updatedAt: 100,
  lastSentByMe: false,
  unread: true,
  messages: 1,
};
const inbox: Inbox = {
  account: "owner@example.com",
  observedAt: 200,
  state: "ok",
  threads: [thread],
};
const action = {
  threadId: thread.id,
  action: "link" as const,
  issue: 7,
  requestedAt: 200,
};
test("linking preserves the latest issue body, never marks reviewed, and retries without duplicating a thread", async () => {
  let body =
    "## Current position\nNext: keep this\n\n## Email threads\n\n## Other evidence\nKeep this too\n";
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "view")
      return JSON.stringify({
        body,
        state: "OPEN",
        labels: [{ name: "work" }],
      });
    body = args.at(-1)!;
    return "";
  };
  assert.equal(
    (await linkInboxThread(action, inbox, [issue(7)], "acme/work", gh)).state,
    "done",
  );
  assert.match(body, /Next: keep this/);
  assert.match(body, /## Other evidence\nKeep this too/);
  const links = emailLinks(body);
  assert.equal(links.length, 1);
  assert.equal(links[0].reviewedMessageId, null);
  assert.doesNotMatch(body, /Untrusted|sender@example.com|bbbbbbbbbb01/);
  await linkInboxThread(action, inbox, [issue(7)], "acme/work", gh);
  assert.equal(calls.filter((c) => c[1] === "edit").length, 1);
  const row = inboxQueue(
    inbox,
    [issue(7, { emailLinks: links })],
    [],
    [{ ...action, state: "done", message: null, updatedAt: 300 }],
  )[0];
  assert.equal(row.state, "todo");
  assert.equal(row.reviewed, false);
});
test("linking refuses missing work and freshly closed or unlabelled issues", async () => {
  const noWrite = async () => {
    throw Error("must not call GitHub");
  };
  assert.equal(
    (await linkInboxThread(action, inbox, null, "acme/work", noWrite)).state,
    "queued",
  );
  assert.equal(
    (await linkInboxThread(action, inbox, [issue(8)], "acme/work", noWrite))
      .state,
    "failed",
  );
  for (const fresh of [
    { state: "CLOSED", labels: [{ name: "work" }] },
    { state: "OPEN", labels: [] },
  ]) {
    let reads = 0;
    const result = await linkInboxThread(
      action,
      inbox,
      [issue(7)],
      "acme/work",
      async (args) => {
        assert.equal(args[1], "view");
        reads++;
        return JSON.stringify({ body: "unchanged", ...fresh });
      },
    );
    assert.equal(result.state, "failed");
    assert.equal(reads, 1);
  }
});
test("work links round-trip safely and source context carries no sender instructions", () => {
  assert.deepEqual(
    parseNavigation(workSearch(7, thread.id)),
    workSearch(7, thread.id),
  );
  assert.equal(parseNavigation({ view: "today", work: "7" }).work, 7);
  for (const work of ["oops", -1, 0, 1.5])
    assert.equal(parseNavigation({ work }).work, undefined);
  assert.equal(parseNavigation({ email: "javascript:bad" }).email, undefined);
  const context = activityContext(thread, inbox.account);
  assert.doesNotMatch(JSON.stringify(context), /Untrusted|sender@example.com/);
  assert.equal(
    inboxActionRequestSchema.safeParse({ threadId: thread.id, action: "link" })
      .success,
    false,
  );
  assert.equal(
    inboxActionRequestSchema.safeParse({
      threadId: thread.id,
      action: "link",
      issue: 7,
    }).success,
    true,
  );
  assert.equal(
    inboxActionRequestSchema.safeParse({
      threadId: thread.id,
      action: "archive",
      issue: 7,
    }).success,
    false,
  );
});
test("repository defaults require one explicit current match across all machines", () => {
  const p = { id: "org/repo", repo: "org/repo" };
  const s = { projects: [p] } as unknown as Snapshot;
  assert.equal(workProject(issue(7), [s, s], []), p.id);
  assert.equal(workProject(issue(7, { repos: [] }), [s], []), undefined);
  const other = {
    projects: [{ id: "org/other", repo: "org/other" }],
  } as unknown as Snapshot;
  assert.equal(
    workProject(issue(7, { repos: ["org/repo", "org/other"] }), [s, other], []),
    undefined,
  );
});

test("an empty Email threads heading at EOF receives the link without a second heading", async () => {
  let body = "Keep the current position\n\n## Email threads";
  const gh = async (args: string[]) => {
    if (args[1] === "view") return JSON.stringify({body, state: "OPEN", labels: [{name: "work"}]});
    body = args.at(-1)!; return "";
  };
  assert.equal((await linkInboxThread(action, inbox, [issue(7)], "acme/work", gh)).state, "done");
  assert.equal(body.match(/^## Email threads$/gm)?.length, 1);
  assert.equal(emailLinks(body)[0].threadId, thread.id);
});

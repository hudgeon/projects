import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  childContext,
  contextConversation,
  contextVersion,
  EVIDENCE_CHAR_LIMIT,
  HANDOVER_CHAR_LIMIT,
  rebuildContext,
} from "../runner/context";
import type { Child, RunMessage } from "../src/run-model";
import { subprocessEnv } from "../collector/collect";
import { nativeEnv } from "../runner/native";

const message = (role: RunMessage["role"], text: string): RunMessage => ({
  id: randomUUID(),
  role,
  text,
  at: 1,
});
const child = (state: Child["state"] = "completed"): Child => ({
  id: randomUUID(),
  projectId: "example/project",
  agent: "codex",
  mode: "change",
  cwd: "/tmp/owned",
  branch: "owned",
  state,
  sessionId: randomUUID(),
  evidence: ["Observed version a; deployment unverified"],
  result: {
    outcome: "completed",
    summary: "A historical report",
    checks: ["A claimed check"],
    links: [],
  },
});
const fixture = () => ({
  messages: [
    message("user", "Draft only; never send."),
    message("master", "May I save that draft?"),
    message("user", "Yes"),
    message("master", "Latest reported position"),
  ],
  children: Array.from({ length: 8 }, () => child()),
});

test("a handover is rebuilt by fixed rules: the request, the newest user messages, the proposals they answered and one line per helper", () => {
  const f = fixture();
  const view = rebuildContext(f.messages, f.children);
  assert.deepEqual(view.conversation, contextConversation(f.messages));
  assert.deepEqual(view.conversation.userInstructions, [f.messages[0], f.messages[2]]);
  assert.deepEqual(view.conversation.latestReportedPosition, f.messages[3]);
  // The approval's proposal travels with it, verbatim; a reply that no user
  // message answered is not replayed.
  assert.deepEqual(view.approvalContext, [f.messages[1]]);
  assert.equal(view.omittedProposals, 0);
  assert.equal(view.version, contextVersion(f.messages, f.children));
  const children = JSON.parse(view.children) as { index: string[]; latest: unknown[] };
  assert.equal(children.index.length, 8);
  assert.deepEqual(children.latest, [], "no report is replayed; the journal keeps them");
  assert.equal(view.children, childContext(f.children));
  assert.equal(view.sources.length, f.messages.length);
  assert.deepEqual(view.childSources.map((c) => c.id), f.children.map((c) => c.id));
  assert.doesNotMatch(JSON.stringify(view), /A claimed check/, "a report's checks come only from the journal");
});

test("a long history keeps the first request and the newest messages within the handover budget, and counts what it omits", () => {
  const messages: RunMessage[] = [message("user", "The original request.")];
  for (let i = 0; i < 40; i++) {
    messages.push(message("master", `PROPOSAL-${i} ${"evidence ".repeat(1_500)}`));
    messages.push(message("user", `APPROVAL-${i} ${"detail ".repeat(100)}`));
  }
  const view = rebuildContext(messages, []);
  const kept = view.conversation.userInstructions;
  assert.equal(kept[0].text, "The original request.");
  assert.equal(kept.at(-1)!.text, messages.at(-1)!.text, "the newest message is always kept");
  assert.ok(kept.slice(1).reduce((n, m) => n + m.text.length, 0) <= HANDOVER_CHAR_LIMIT);
  assert.ok(view.conversation.omittedUserInstructions > 0);
  assert.equal(kept.length + view.conversation.omittedUserInstructions, 41);
  // Every kept approval's proposal is verbatim, newest first within the
  // evidence budget; the rest are counted, never shortened.
  const proposals = view.approvalContext;
  assert.ok(proposals.length > 0);
  assert.ok(proposals.every((p) => p.text.length > 10_000));
  assert.ok(proposals.reduce((n, m) => n + m.text.length, 0) <= EVIDENCE_CHAR_LIMIT);
  assert.equal(proposals.at(-1)!.text.split(" ")[0], "PROPOSAL-39");
  assert.equal(proposals.length + view.omittedProposals, kept.length - 1);
  assert.equal(view.children, "none");
});

test("TypeSafe keys never enter helper or collector subprocess environments", () => {
  const saved = {
    JEV_API_KEY: process.env.JEV_API_KEY,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  };
  try {
    process.env.JEV_API_KEY = "test-key";
    process.env.TYPESAFE_API_KEY = "test-key";
    for (const env of [nativeEnv(), subprocessEnv()]) {
      assert.equal(env.JEV_API_KEY, undefined);
      assert.equal(env.TYPESAFE_API_KEY, undefined);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

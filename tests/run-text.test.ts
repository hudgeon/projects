import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  cleanAgentText,
  describeLink,
  doneSoFar,
  formatTokens,
  headline,
  requestTitle,
  runDocuments,
  runTitle,
  statusLine,
  tokenLine,
} from "../src/run-text";
import type { ProgressNote, Run } from "../src/run-model";

const sha = "b5770401ccdfab0c56a7f3b8a71e959f3bb6edaa";
const note = (
  at: number,
  done: string[],
  remaining: string[],
  yourMove: string | null = null,
): ProgressNote => ({
  id: randomUUID(),
  at,
  actor: "codex",
  childId: null,
  done,
  remaining,
  yourMove,
});
function run(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    projectId: null,
    agent: "auto",
    workIssue: null,
    generation: 1,
    state: "completed",
    createdAt: 1,
    updatedAt: 2,
    heartbeatAt: 2,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        text: "Reply to Rob about “Re: November plan”\nGmail thread: https://mail.google.com/mail/u/?authuser=owner%40example.com#all/1a1324eccd4e4489\nSay Thursday works.",
        at: 1,
      },
    ],
    progress: null,
    ...overrides,
  };
}

test("agent protocol residue never reaches the user, but the agent's own words do", () => {
  const text =
    'Created the [draft](https://mail.google.com/mail/u/#all/1a1324eccd4e4489). Nothing was sent.\n\nwork: none\nPROJECTS_PROGRESS {"done":[],"remaining":[],"blocker":null}\nwork: #1112';
  assert.equal(
    cleanAgentText(text),
    "Created the [draft](https://mail.google.com/mail/u/#all/1a1324eccd4e4489). Nothing was sent.",
  );
  assert.equal(
    cleanAgentText("We discussed work: #12 in the email."),
    "We discussed work: #12 in the email.",
    "only a standalone declaration line is residue",
  );
});

test("headlines lead with the agent's first plain sentence", () => {
  assert.equal(
    headline(
      "**The plan is ready to review.** The UK still needs samples.\n\n- Detail",
    ),
    "The plan is ready to review.",
  );
  assert.equal(headline("## Where things stand\n\nBody"), "Where things stand");
  assert.equal(
    headline(
      "Created and verified a [new Gmail draft](https://mail.google.com/x) for Sam and Alex. Nothing was sent.\n\nwork: none",
    ),
    "Created and verified a new Gmail draft for Sam and Alex.",
  );
  const long = headline("word ".repeat(80), 60);
  assert.ok(long.length <= 60 && long.endsWith("…"));
  assert.equal(
    headline("e.g. a short one."),
    "e.g. a short one.",
    "a sentence needs some length before it ends",
  );
});

test("conversation titles prefer the master's label, else the request's first line", () => {
  const r = run();
  assert.equal(
    requestTitle(r.messages[0].text),
    "Reply to Rob about “Re: November plan”",
  );
  assert.equal(runTitle(r), "Reply to Rob about “Re: November plan”");
  assert.equal(
    runTitle({
      ...r,
      progress: {
        seq: 1,
        state: "running",
        title: "Reply to Rob",
        summary: "",
        children: [],
        masterSessionId: null,
      },
    }),
    "Reply to Rob",
  );
  assert.equal(
    requestTitle(
      "Lets go through the reporting work. show me a link to the latest project plan and lets go through it.",
    ),
    "Lets go through the reporting work.",
  );
  assert.equal(requestTitle("   \n\n"), "New conversation");
  assert.equal(
    requestTitle("Reply to Rob about “Are we on? Thursday plan”\n\nSay yes."),
    "Reply to Rob about “Are we on? Thursday plan”",
    "a short first line is kept whole",
  );
});

test("status lines say what is happening now or how the turn ended, without inventing progress", () => {
  const progress = {
    seq: 1,
    state: "running" as const,
    summary: "Asked Codex to draft the reply.\n\nwork: #943",
    children: [],
    masterSessionId: null,
  };
  assert.equal(statusLine(run({ state: "queued" })), "Waiting for a free slot");
  assert.equal(
    statusLine(run({ state: "queued", generation: 2 })),
    "Follow-up waiting for a free slot",
  );
  assert.equal(
    statusLine(run({ state: "running", progress })),
    "Asked Codex to draft the reply.",
  );
  const planned = {
    ...progress,
    notes: [
      note(
        10,
        ["Read the thread"],
        ["Draft a three-sentence reply", "Save it in Gmail"],
      ),
      note(5, [], ["Old step"]),
    ],
  };
  assert.equal(
    statusLine(run({ state: "running", progress: planned })),
    "Draft a three-sentence reply",
  );
  assert.equal(
    statusLine(
      run({
        state: "running",
        progress: {
          ...planned,
          notes: [note(11, [], ["Wait"], "Sign in to Gmail on the Studio")],
        },
      }),
    ),
    "Sign in to Gmail on the Studio",
  );
  // Older notes named any obstacle as a blocker, often one being worked around.
  assert.equal(
    statusLine(
      run({
        state: "running",
        progress: {
          ...planned,
          notes: [
            {
              ...note(11, [], ["Check the vendor documents"]),
              blocker: "The unbound case offers no actions",
            },
          ],
        },
      }),
    ),
    "Check the vendor documents",
  );
  assert.equal(
    statusLine(
      run({
        messages: [
          ...run().messages,
          {
            id: randomUUID(),
            role: "master",
            text: "Drafted the reply. **Your move:** send it.\n\nwork: none",
            at: 3,
          },
        ],
      }),
    ),
    "Drafted the reply.",
  );
  assert.equal(statusLine(run({ state: "cancelled" })), "Work so far is kept.");
  assert.deepEqual(
    doneSoFar(
      run({
        state: "running",
        progress: planned,
        updates: [
          {
            id: "u",
            generation: 1,
            from: 0,
            to: 1,
            done: ["Read the thread", "Found the email"],
            note: null,
            operations: {},
            failed: 0,
            state: "running",
            disconnected: false,
          },
          {
            id: "old",
            generation: 0,
            from: 0,
            to: 1,
            done: ["Previous turn"],
            note: null,
            operations: {},
            failed: 0,
            state: "completed",
            disconnected: false,
          },
        ],
      }),
    ),
    ["Read the thread", "Found the email"],
    "deduplicated, current turn only",
  );
});

test("documents name the saved edition plainly and collapse anchors of the same file", () => {
  const pinned = `https://github.com/acme/projects/blob/${sha}/README.md#L12`;
  assert.deepEqual(describeLink(pinned, "Projects **README**"), {
    url: pinned,
    kind: "file",
    label: "Projects README",
    detail: `projects/README.md · saved ${sha.slice(0, 7)}`,
  });
  assert.equal(
    describeLink(
      "https://github.com/acme/work/blob/main/plans/client%20plan.md",
    )?.detail,
    "work/plans/client plan.md · latest on main",
  );
  assert.equal(
    describeLink(
      "https://github.com/acme/work/issues/1112#issuecomment-1",
    )?.detail,
    "work issue #1112 · comment",
  );
  assert.equal(
    describeLink("https://github.com/acme/projects/pull/37")
      ?.label,
    "PR #37",
  );
  assert.equal(
    describeLink(
      "https://mail.google.com/mail/u/?authuser=owner%40example.com#all/1a1324eccd4e4489",
      "Draft reply to Rob",
    )?.detail,
    "Gmail · example.com",
  );
  assert.equal(
    describeLink(
      "https://github.com/acme/projects/actions/runs/1",
    ),
    null,
    "check runs are evidence, not documents",
  );
  assert.equal(describeLink("http://github.com/a/b/blob/main/x.md"), null);
  assert.equal(
    describeLink("https://user:secret@github.com/a/b/blob/main/x.md"),
    null,
  );
  const docs = runDocuments(
    run({
      messages: [
        ...run().messages,
        {
          id: randomUUID(),
          role: "master",
          text: `Saved the [plan](${pinned}) and the [same plan again](${pinned.replace("#L12", "#L40")}).`,
          at: 3,
        },
      ],
      progress: {
        seq: 1,
        state: "completed",
        summary: "",
        masterSessionId: null,
        children: [
          {
            id: randomUUID(),
            projectId: "acme/work",
            agent: "codex",
            mode: "change",
            cwd: "/x",
            branch: "b",
            sessionId: null,
            state: "completed",
            evidence: [],
            result: {
              outcome: "completed",
              summary: "Done",
              checks: [],
              links: [
                "https://github.com/acme/projects/pull/37",
                "https://github.com/acme/projects/pull/37",
              ],
            },
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    docs.map((d) => d.label),
    ["plan", "PR #37", "Gmail conversation"],
  );
});

test("token counts read plainly, and a conversation's line splits coordinator from helpers", () => {
  assert.deepEqual([950, 9_940, 42_000, 999_499, 1_300_000, 650_000_000, 1_900_000_000].map(formatTokens), ["950", "9.9k", "42k", "999k", "1.3M", "650M", "1.9B"]);
  const usage = (fresh: number, cached: number, output: number) => ({fresh, cached, output, turns: 1, context: 0});
  const progress = {seq: 1, state: "running" as const, summary: "", masterSessionId: null, masterUsage: usage(3_000_000, 5_000_000, 200_000), children: [
    {id: "00000000-0000-4000-8000-000000000001", projectId: "acme/app", agent: "claude" as const, mode: "change" as const, cwd: "/w", branch: "b", sessionId: null, state: "completed" as const, result: null, evidence: [], usage: usage(5_000_000, 630_000_000, 800_000)},
    {id: "00000000-0000-4000-8000-000000000002", projectId: "acme/app", agent: "codex" as const, mode: "read" as const, cwd: "/w", branch: "main", sessionId: null, state: "completed" as const, result: null, evidence: []},
  ]};
  assert.equal(tokenLine(progress), "Tokens: 644M (9M new) · coordinator 8.2M · helpers 636M");
  assert.equal(tokenLine({...progress, masterUsage: undefined, children: []}), null);
  assert.equal(tokenLine(null), null);
});

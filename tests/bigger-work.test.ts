import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readIssues } from "../collector/work";
import {
  historyIssues,
  issueSchema,
  nextCommitment,
  workDetails,
} from "../src/work-model";
import { WorkFacts, workRepositoryProject } from "../src/work-view";
import type { Snapshot } from "../src/model";
import { issue } from "./work-fixtures";

const body = `## Current position
Status: waiting on someone. Reviewed: 2026-10-17.
Outcome / why now: Complete one pilot for two clients.
Position: Scope agreed; waiting for source data.
Next: Alex to confirm the date.

## People
| Person | Role | Next action |
| --- | --- | --- |
| Alex | Delivery lead | Confirm the date |
| Sam | Client \\| finance | |

## Commitments
| Date | Commitment | Owner | State |
| --- | --- | --- | --- |
| unknown | Confirm the pilot target | Alex | open |
| 2026-10-21 | Supply source data | unknown | open |
| 2026-10-19 | Earlier target cancelled by owner | Sam | cancelled |
| 2026-10-18 | Scope agreed | Alex | done |

## Work history
Combined from: #11, #12, #11
Split from: #8

## Evidence
Keep the source records.
`;

test("canonical work details survive collector parsing with clients, unknowns and history", async () => {
  const raw = {
    number: 20,
    title: "Shared pilot",
    body,
    url: "https://github.com/acme/work/issues/20",
    state: "OPEN",
    issueType: null,
    labels: [
      { name: "work" },
      { name: "customer:North" },
      { name: "customer:South" },
    ],
    milestone: null,
    updatedAt: "2026-10-17T00:00:00Z",
  };
  const [collected] = await readIssues(
    async (args) =>
      args[0] === "api"
        ? JSON.stringify({
            data: { repository: { i20: { comments: { nodes: [] } } } },
          })
        : JSON.stringify(args.includes("open") ? [raw] : []),
    "acme/work",
  );
  const parsed = issueSchema.parse(JSON.parse(JSON.stringify(collected)));
  assert.deepEqual(parsed.customers, ["North", "South"]);
  assert.equal(
    parsed.position?.position,
    "Scope agreed; waiting for source data.",
  );
  assert.deepEqual(parsed.details?.people[1], {
    name: "Sam",
    role: "Client | finance",
    next: "",
  });
  assert.equal(parsed.details?.commitments[0].date, null);
  assert.equal(parsed.details?.commitments[1].owner, null);
  assert.equal(
    nextCommitment(parsed)?.date,
    "2026-10-21",
    "completed/cancelled dates are not outstanding",
  );
  assert.deepEqual(historyIssues(parsed), [11, 12, 8]);
  assert.equal(parsed.details?.continuesAs.length, 0);
});

test("invalid details are unavailable rather than partial, and older snapshots remain valid", () => {
  assert.equal(issueSchema.safeParse(issue(7)).success, true);
  assert.deepEqual(workDetails("Unstructured history"), {
    people: [],
    commitments: [],
    combinedFrom: [],
    splitFrom: [],
    continuesAs: [],
  });
  for (const invalid of [
    body.replace("2026-10-21", "2026-02-30"),
    body.replace("| open |", "| finished |"),
    body.replace("#11, #12, #11", "https://github.com/other/work/issues/11"),
    body.replace("Combined from: #11, #12, #11", "Combined from: #0"),
    body +
      "\n## People\n| Person | Role | Next action |\n| --- | --- | --- |\n",
    body + "\n##   people  \n",
    body.replace("Split from: #8", "combined from: #3"),
    body.replace("| --- | --- | --- |", "| --- |"),
    body.replace("| Sam | Client \\| finance | |", "| Sam | Missing a cell |"),
    body.replace("Confirm the date", "x".repeat(601)),
  ])
    assert.equal(workDetails(invalid), null);
});

test("human-edited heading case and spacing preserve the same work details", () => {
  assert.deepEqual(workDetails(body.replace("## People", "##   people  ").replace("## Work history", "## work   HISTORY").replace("Combined from:", "combined from:")), workDetails(body));
  assert.equal(workDetails("## People")?.people.length, 0);
});

test("split and combined sources retain explicit successor references without self history", () => {
  const details = workDetails(
    "## Work history\nCombined from: #20, #11\nContinues as: #21, #22\n",
  );
  assert.deepEqual(details?.continuesAs, [21, 22]);
  assert.deepEqual(historyIssues(issue(20, { details })), [11]);
  assert.deepEqual(
    workDetails("## Work history\nSplit from: #20\n")?.splitFrom,
    [20],
  );
});

test("people and commitments render unknowns and safely escape source text", () => {
  const item = issue(20, {
    details: workDetails(body.replace("| Alex |", "| <script>alert(1)</script> |")),
  });
  const html = renderToStaticMarkup(
    React.createElement(WorkFacts, { issue: item }),
  );
  assert.match(html, /Date unknown/);
  assert.match(html, /Owner unknown/);
  assert.match(html, /No action recorded/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(
    renderToStaticMarkup(
      React.createElement(WorkFacts, { issue: issue(7, { details: null }) }),
    ),
    /could not be read/,
  );
});

test("work discussions default to the registered work repository, not the implementation repo", () => {
  const snapshot = {
    collectedAt: 1,
    projects: [
      { id: "work", repo: "acme/work" },
      { id: "app", repo: "acme/app" },
    ],
    work: {
      repo: "acme/work",
      issues: [issue(7)],
      associations: [],
      associationsState: "ok",
    },
  } as unknown as Snapshot;
  assert.equal(workRepositoryProject([snapshot], []), "work");
  assert.equal(
    workRepositoryProject(
      [{ ...snapshot, projects: snapshot.projects.slice(1) }],
      [],
    ),
    undefined,
  );
});

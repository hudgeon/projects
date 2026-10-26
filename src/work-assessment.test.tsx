import { snapshotSchema } from "./model";
import { inboxSnapshot } from "../worker/snapshot-fixtures";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  evidenceChecked,
  workAssessment,
  assessmentSourceGap,
} from "./work-assessment";
import { AssessmentSummary, AssessmentDetails } from "./work-assessment-view";
import { issue } from "../tests/work-fixtures";
const now = Date.UTC(2026, 9, 26, 4);
const position = {
  status: "waiting on someone" as const,
  reviewed: "2026-10-26",
  why: "Finish acceptance",
  position: "Reply drafted",
  next: "Send the old draft",
  priority: null,
  due: null,
};
const fresh = () =>
  issue(7, { position, evidenceCheckedAt: now - 1000, updatesState: "ok" });
test("evidence cutoff is explicit, valid, bounded and independent of GitHub refresh", () => {
  assert.equal(
    evidenceChecked(
      "## Current position\nEvidence checked: 2026-10-26T04:00:00.000Z\n",
    ),
    now,
  );
  assert.equal(
    evidenceChecked("## Other\nEvidence checked: 2026-10-26T04:00:00.000Z"),
    null,
  );
  assert.equal(
    evidenceChecked(
      "## Current position\nEvidence checked: 2026-02-30T04:00:00.000Z",
    ),
    null,
  );
  assert.equal(workAssessment(fresh(), {}, now).reason, null);
  assert.match(
    workAssessment(issue(7, { position, updatedAt: now }), {}, now).reason!,
    /not been recorded/,
  );
  assert.match(
    workAssessment({ ...fresh(), evidenceCheckedAt: now + 120000 }, {}, now)
      .reason!,
    /not been recorded/,
  );
  assert.match(
    workAssessment(
      { ...fresh(), evidenceCheckedAt: now - 2 * 86400000 },
      {},
      now,
    ).reason!,
    /due/,
  );
  assert.equal(
    workAssessment(
      {
        ...fresh(),
        position: { ...position, status: "deferred" },
        evidenceCheckedAt: now - 2 * 86400000,
      },
      {},
      now,
    ).reason,
    null,
  );
});
test("new sent mail, issue comments, PR evidence and unverified native work invalidate Next", () => {
  const reasons = [
    workAssessment(fresh(), { emailAttention: true }, now),
    workAssessment(
      {
        ...fresh(),
        latestUpdate: {
          body: "Already sent",
          url: "https://github.com/acme/work/issues/7#issuecomment-1",
          at: now,
        },
      },
      {},
      now,
    ),
    workAssessment(fresh(), { deliveryAt: now }, now),
    workAssessment(fresh(), { nativePendingAt: now }, now),
    workAssessment(fresh(), { unavailable: true }, now),
  ];
  for (const assessment of reasons) {
    assert.ok(assessment.reason);
    const summary = renderToStaticMarkup(
      <AssessmentSummary position={position} assessment={assessment} />,
    );
    const detail = renderToStaticMarkup(
      <AssessmentDetails
        position={position}
        assessment={assessment}
        now={now}
      />,
    );
    assert.ok(!summary.includes(position.next));
    assert.ok(!detail.includes(position.next));
    assert.match(summary, /Needs reconciliation/);
    assert.match(detail, /Last recorded position/);
  }
});

test("failed newer reads and missing, stale or incomplete linked mail never certify a current assessment", () => {
  const snapshot = snapshotSchema.parse(inboxSnapshot(now));
  const linked = {
    ...fresh(),
    emailLinks: [
      {
        threadId: "bbbbbbbbbb01",
        url: "https://mail.google.com/mail/u/0/#all/bbbbbbbbbb01",
        reviewedMessageId: "bbbbbbbbbb02",
      },
    ],
  };
  assert.equal(assessmentSourceGap(linked, [snapshot], now, now), false);
  assert.equal(assessmentSourceGap(linked, [], now, now), true);
  assert.equal(
    assessmentSourceGap(
      linked,
      [{ ...snapshot, inbox: { ...snapshot.inbox!, state: "incomplete" } }],
      now,
      now,
    ),
    true,
  );
  assert.equal(
    assessmentSourceGap(
      linked,
      [
        {
          ...snapshot,
          inbox: { ...snapshot.inbox!, observedAt: now - 3600000 },
        },
      ],
      now,
      now,
    ),
    true,
  );
  assert.equal(
    assessmentSourceGap(
      fresh(),
      [
        {
          ...snapshot,
          collectedAt: now + 1,
          work: { ...snapshot.work!, issues: null },
        },
      ],
      now,
      now,
    ),
    true,
  );
});

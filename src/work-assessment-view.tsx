import React from "react";
import { ago } from "./model";
import { plainText } from "./run-text";
import { EvidenceText } from "./work-evidence-text";
import type { Position } from "./work-model";
import type { Assessment } from "./work-assessment";

export function AssessmentSummary({
  position: p,
  assessment: a,
}: {
  position: Position | null | undefined;
  assessment: Assessment;
}) {
  return (
    <>
      {p?.position && (
        <span className="work-card-overview">
          {a.reason ? "Last recorded: " : ""}
          {plainText(p.position)}
        </span>
      )}
      <span className="work-card-next">
        {a.reason
          ? `Needs reconciliation: ${a.reason}`
          : p?.next
            ? plainText(p.next)
            : "No next step recorded yet."}
      </span>
    </>
  );
}
export function AssessmentDetails({
  position: p,
  assessment: a,
  now,
}: {
  position: Position | null | undefined;
  assessment: Assessment;
  now: number;
}) {
  return (
    <>
      {p?.why && (
        <p>
          <span className="label">Outcome</span>
          <EvidenceText text={p.why} />
        </p>
      )}
      {p?.position && (
        <p>
          <span className="label">Last recorded position</span>
          <EvidenceText text={p.position} />
        </p>
      )}
      <p>
        <span className="label">Next</span>
        {a.reason ? (
          `Reconcile the evidence before acting. ${a.reason}`
        ) : p?.next ? (
          <EvidenceText text={p.next} />
        ) : (
          "No next step recorded yet."
        )}
      </p>
      <p className="subtle">
        {a.checkedAt
          ? `Evidence checked ${ago(a.checkedAt, now)}`
          : "Evidence review not verified"}
        {p ? ` · assessment dated ${p.reviewed}` : ""}
      </p>
    </>
  );
}

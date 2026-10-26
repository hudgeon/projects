import {
  readWorkRecord,
  recordHash,
  verifiedRecord,
  type ReadWorkRecord,
} from "../collector/work-record";
import type { MasterDecision } from "../src/run-model";

// The runner reads GitHub independently of the coordinator's prose. The
// baseline survives checkpoints in the execution; retries never edit an issue.
export type WorkBaseline = { startedAt: number; hash?: string };
export async function workRecordGate(
  repo?: string,
  issue?: number | null,
  read: ReadWorkRecord = readWorkRecord,
  saved?: WorkBaseline,
) {
  const startedAt = saved?.startedAt ?? Date.now();
  let baseline = saved?.hash;
  if (!saved && repo && issue)
    try {
      baseline = recordHash((await read(repo, issue)).body);
    } catch {
      /* Completion cannot certify an unreadable baseline. */
    }
  const verify = async (decision: MasterDecision, changed = false) => {
    if (
      repo &&
      issue &&
      changed &&
      decision.action === "complete" &&
      decision.workRecord?.status === "unchanged"
    )
      return "A linked change turn cannot finish with an unchanged work record. Reconcile and verify the canonical Current position, or report the blocker.";
    if (
      !repo ||
      decision.action !== "complete" ||
      decision.workRecord?.status !== "updated"
    )
      return null;
    const urls = [
      ...decision.workRecord.evidence.matchAll(
        /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?=[#\s).,]|$)/g,
      ),
    ];
    const ids = [
      ...new Set(
        decision.workRecord.issues ??
          urls.filter((m) => m[1] === repo).map((m) => Number(m[2])),
      ),
    ];
    if (!ids.length || ids.length > 50 || (issue && !ids.includes(issue)))
      return "workRecord must link the exact canonical work issue(s) updated, including this conversation's linked issue.";
    if (issue && !baseline)
      return "The runner could not read the original work record. Report the readback blocker; do not certify it updated.";
    try {
      for (const id of ids) {
        const actual = await read(repo, id);
        if (
          !verifiedRecord(
            actual.body,
            startedAt,
            id === issue ? baseline : undefined,
          )
        )
          return `Work issue #${id} has no verified fresh Current position change. Reconcile the evidence, set Evidence checked to the actual UTC cutoff, write the canonical record and read it back. A comment or an assertion is insufficient.`;
      }
      return null;
    } catch {
      return "Independent work-record readback failed. Report the concrete blocker; do not certify the record updated.";
    }
  };
  return Object.assign(verify, {
    baseline: { startedAt, ...(baseline ? { hash: baseline } : {}) },
  });
}

# Keeping Bigger work current

GitHub work issues remain the canonical records. A fresh collector snapshot only means the sources were read; it does not establish that an issue's assessment reconciles those sources.

Each Current position has `Evidence checked: YYYY-MM-DDTHH:mm:ss.sssZ`, the actual UTC cutoff through which relevant comments, linked incoming **and sent** mail, PR/deployment evidence and commitments were reviewed. Existing exact `reviewed: MESSAGE_ID` email markers continue to identify the non-draft message actually read. Do not move the cutoff over unavailable evidence, stamp a fresh date without a review, or treat a delivery comment as an updated assessment.

Bigger work suppresses the old Next instruction when mail, newer issue comments, observed linked PR/merge evidence, unverified native work, source gaps or review age require reconciliation. It labels the position as last recorded. The evidence cutoff is displayed separately from the assessment date. Active assessments are due daily; planned/deferred and standing upkeep records weekly. These limits prompt review; they do not prove the business work is late or incomplete. Evidence coverage is bounded by the collector; a missing event never certifies delivery.

## At a work checkpoint

Projects reads the linked issue before execution and retains a hash of its assessment, people, commitments and email markers across execution checkpoints. A linked change turn cannot complete as `unchanged`. For `workRecord: updated`, return the exact issue numbers in `issues` (or exact canonical URLs in evidence). The runner independently reads every claimed issue and verifies a valid, fresh assessment; for the linked issue it also requires the canonical record to differ from its baseline. Readback failure is a blocker, not success. Read-only answers may remain unchanged.

The native Codex/Claude Stop hook performs a bounded independent read of the linked issue against its prompt-time baseline. Missing, unchanged, unreadable or old records remain unverified in the collector and trigger reconciliation. The hook does not turn a read-only request into permission to edit records. Old hook/collector receipts without these fields remain readable but cannot establish fresh review.

These checks verify a persisted record and its declared evidence cutoff, not the truth of an agent's interpretation or customer acceptance. Source links and substantive verification remain necessary.

## Daily reconciliation

A Worker trigger at half past each hour starts one `review` conversation per local day at 05:30 in the deployment's `TIME_ZONE`, or on a later hourly retry if no machine/inventory was available. A deterministic request ID prevents duplicate work after repeated delivery or uncertain creation. An earlier active review prevents overlap. It uses the existing native runner, owner attribution, recovery and shared memory/capacity admission; older runners do not claim the reserved lane.

The brief in `runner/work-review-instructions.ts` directs one existing change helper to reconcile changed/due records using complete relevant evidence, preserve concurrent edits and history, and read back corrections. It does not authorize code, deployment, credential, access, financial, customer-send or calendar changes, or closing/combining work without separate specific authority. Gmail grants for review are read-only. A machine with only an ordinary gws login supplies no mailbox to this lane, rather than exposing a broader grant; report that coverage gap.

Settings shows the latest scheduled invocation receipt and separate review execution state, including skips/failures and missed checks. The owner can use Review work now. Scheduled receipts live separately from weekly upkeep. An unchanged completion sends no push; corrections, failures and required decisions can notify. No second backlog, daily report file or customer automation is created.

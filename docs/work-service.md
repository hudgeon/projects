# Retained-work service rehearsal

GitHub issues in the configured `workRepo` remain authoritative. This manual
adapter reads the optional retained-work service; it never substitutes its
records for `Issue`, `WorkSnapshot`, hook/offline caches, runner verification,
Mark done, mail linking or upkeep. It installs no schedule and changes no
machine configuration, work selection or Jev request/policy/model.

The service is deployed independently. Its versioned `/api/work/v1` contract
returns only explicitly granted rehearsal records, attributed source metadata
and exact pinned source excerpts. `collector/work-service.ts` owns transport,
bounds and validation; `collector/work-rehearsal.ts` compares a qualified alias
with the existing independent GitHub reader. These modules are necessary
because a retained assessment/source is not a GitHub issue or a saved canonical
assessment. No credentials are put on the Projects Worker.

After the owner approves the specific endpoint, record scopes, consumer and
expiry, supply its credential in an owner-only file outside Git. The command
does not provision that access. Do not use an existing GitHub, collector,
runner, email or shared integration token. Use a separate service credential
per machine, with exact per-record grants and a short expiry.

```sh
npm run work:rehearse -- \
  --endpoint https://context.example.com \
  --token-file /private/work-read-token \
  --repository example/work --issue 7 \
  --report /private/work-rehearsal/receipt.json
```

Both the token and report must be outside Git, with the token mode 0600 and
report directory mode 0700. Reports are mode 0600 and contain private retained
assessment data. Standard output contains only a status; failures contain no
source text, raw provider errors or token. HTTP is allowed only on loopback
for isolated tests; production requires HTTPS. Redirects, embedded URL
credentials, endpoint paths/queries, oversized/non-JSON responses, changed
authority/schema, stale network receipts and invalid source/record identities
are refused. Requests have a ten-second deadline and one MB response limit.

The adapter enumerates all pages within one fixed source append boundary,
up to 1,000 pages; exceeding that bound is unavailable, never success. It
retains gap counts and reports provider-limited coverage. `exactBodyObserved`
means that an edition with the canonical URL and original body digest was
observed anywhere in that retained history; it does not mean a current import
or complete history. GitHub is read independently again after enumeration;
a moving body leaves the comparison unavailable. A record with no saved
assessment remains null. A matching source or exact assessment hash cannot
certify the canonical assessment; every report says `reconciledAssessment:
false`. Denied/offline/failed reads are distinct from a successful not-captured
result and never become an empty canonical work list or successful close.
Before reading, the command replaces its output with a dated unavailable
receipt so failure cannot leave an old success presented as current.

The reusable client also validates exact excerpt source/hash/byte ranges,
UTF-8 length and excerpt digest. Nothing is sent to a model. The later
Overview/Decisions/Timeline/Sources UI, protected context receipts and labelled
Jev replays remain separate slices. Direct native chats remain outside the
Projects selector. Content-authority milestones must precede work-authority
activation, with final source reconciliation, all writer/client fencing,
both-machine acceptance and post-write recovery proved separately.

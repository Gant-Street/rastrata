# Production workload acceptance proposal

Status: G0 in progress, 2026-09-05. This is an agent-authored engineering proposal,
not approved product limits, executed workload evidence or a production verdict.
The [readiness plan](../../../docs/reference/production-ledger.md#production-readiness-plan)
owns G0–G5; this document makes its business assumptions and decisions reviewable.
No new accounting semantics, hash contract or cloud resources are authorized here.

## Proposed business profiles

These are synthetic design targets, not competitor measurements or claims about
typical customers. Use the entire matrix to challenge the architecture; do not
silently drop the inventory or multi-currency profile to obtain a passing release.
Ten years is an evaluation horizon, not permission to expire older books or retries.

| Profile, per book | Monthly business volume | Target live population, independently exercised | Ten-year base retained outcomes |
|---|---|---|---:|
| Service | 5,000 credit sales, 2,000 credit purchases, 3,000 taxed cash transactions, 8,400 payment events | 500 accounts, 1,000 dimension members, 15,000 open items, 200 active schedules | 2,352,989 |
| Inventory | 50,000 credit sales, 10,000 credit purchases, 5,000 taxed cash transactions, 72,000 payment events; 30,000 receiving lines and 150,000 issue lines | 1,000 accounts, 10,000 dimension members, 120,000 open items, 100,000 live lots, 2,000 active schedules | 39,329,784 |
| Multi-currency | 20,000 credit sales, 5,000 credit purchases, 2,000 taxed cash transactions, 30,000 payment events; ten remeasurement requests | 2,000 accounts, 20,000 dimension members, 60,000 open items, 5,000 active schedules, ten currencies | 7,773,840 |
| Consolidation book | One compilation from 20 separately pinned source books with 2,000 balance observations each; ten other journals | 2,000 accounts, 20,000 dimension members; source books exercise the operational profiles separately | 1,562 |

The reproducible arithmetic and full minor-event counts live in
[`workload-plan.ts`](../scripts/workload-plan.ts). Run from the repository root:

```sh
bun run --cwd packages/ledger plan:workloads
```

The calculator emits base and 2x volume scenarios, command-kind totals, distinct
retained rejections, retry attempts, matched bank lines and byte sensitivities.
It uses integer arithmetic and labels every output `proposal-not-executed`.
Its unit tests verify counting, not accounting correctness, throughput or capacity.
It does **not** yet generate a dated stream of valid production commands.

Base totals include 120 monthly closes, 40 quarterly reopen/reclose pairs, ten
configuration changes, one activation, corrections and the listed capability events.
Additional distinct retainable rejections equal ceil(2% of committed commands).
Retries equal ceil(10% of all retained outcomes), add load but no new Oseq entries,
and must include very old successful and rejected commands. Authentication failures,
invalid envelopes and overload responses are separate load, not retained outcomes.

Payment counts are planning assumptions allowing partial settlement, not evidence
that a particular schedule leaves the required open-item population. Actual generators
must establish and verify all populations without over-settlement or impossible dates.
Population preconditioning, imported history and any added setup commands must be
counted separately and included in storage totals; they cannot be hidden from timing
or passed off as covered by these base counts. Fixed-population volume doubling is
a diagnostic slice; a separate campaign doubles live population and tests skew.

## Business events, canonical effects and ownership

| Event | Current kernel command / ledger obligation | Application responsibility / caveat |
|---|---|---|
| Credit sale or purchase | `recognizeOpenItem` contains its resolved journal and open-item effect in one commit | Document creation, approval and policy-resolved amounts; never post the same journal again merely to create AR/AP |
| Receipt or payment | `applySettlement` with exact allocations and resolved payment journals; generated realized FX where applicable | Matching and payment initiation; a payment can settle multiple items or partially settle one, so payments, allocations and journals are different counts |
| Taxed cash transaction | `postTaxedTransaction` over the complete multi-line transaction | Jurisdictional policy selection needs its own reviewed evidence; a synthetic test tax is not a production tax rule |
| Stock receiving line | `postJournal` with acquisition lot operations | Use a separately represented receiving/clearing event when a supplier bill was already recognized; do not debit inventory twice |
| Stock issue line | `postInventoryTransaction` with lot disposal and cost effects | Fulfilment and invoice linkage; quantity, value, selected lots and costs need independent expected results |
| Cost correction / write-down | `recostProvisionalInventory`, `adjustInventoryValue` | Do not delete or rewrite original cost history; choose concrete method/policy variants in fixtures |
| Scheduled expense or income | `createAllocationSchedule`, `recognizeScheduledAllocation`, `reviseAllocationSchedule` | Establish source postings and schedule lineage; exercise revision/disposal as well as routine recognition |
| Currency remeasurement | `postCurrencyRemeasurement` | Provide governed evidence and a complete selected population; ten requests does not mean ten positions |
| Group reporting | `compileConsolidation` against pinned source observations | Gather consistent source cutoffs, ownership and policy evidence; no distributed cross-book posting transaction is implied |
| Correction / close / reopen | `correctJournal`, `closePeriod`, `reopenPeriod`, `replaceConfiguration` | Approvals and workflow UI; unchanged historical effects, fiscal authority and exact report populations remain ledger/kernel obligations |
| Matched bank statement line | No new accounting command merely because an existing payment is matched | Bank ingestion and reconciliation live above the ledger; previously unrecorded charges or receipts are separate accounting events |
| Reports, export and audit | Pinned cutoffs, complete paginated history and exact population-dependent calculations | Presentation and delivery live above the ledger; completeness cannot be replaced by a page limit |

The mappings above are **not** a proof of complete business workflow atomicity.
The current command union has no general atomic multi-command envelope; for example,
recognizing a receivable and issuing stock use different commands. G1 must distinguish
legitimately separate business events from effects that must publish together, specify
failure/retry behavior for the former, and resolve any missing same-event atomicity
before claiming invoice-plus-inventory workflow conformance. Do not invent a second
accounting engine or assume an application SQL transaction spans Durable Objects.

## Required campaign dimensions and evidence

1. Generate 2026–2035 inclusive with real month lengths and leap days. Record seeds,
   deterministic generation version, per-month event/command counts, amounts, expected
   postings, selected policies and exact balances/populations. Redistribute volume for
   seasonality rather than silently multiplying annual totals. A 120-event soak is not
   a volume test. Setup cost, active measurement and cleanup are separate timed phases.
2. At fixed live population and payload, sweep 10k/100k/1m/10m histories and each
   profile's full base/2x totals. Independently vary open items, lots, account/dimension
   cardinality, hot-account skew and selected population per request. Include cache
   misses and old-ID retries. A per-request limit is not a book-wide capacity target.
3. Proposed ordinary document widths: 2, 10 and 100 lines, with varying dimension and
   evidence widths. Test each configured byte/node/line limit at minus one, exactly
   the limit and plus one. Record actual journal counts, posting counts and encoded
   bytes from execution; neither is inferred from command counts. Split postings and
   generated FX can make these quantities differ substantially.
4. Exercise a one-year backfill alongside current-date traffic and month-end readers,
   plus the readiness plan's offered-load and overload campaigns. Backfill's target is
   <=24 hours while ordinary traffic meets its approved SLO; backfill records count
   toward the resulting history, and closed-period policy cannot be bypassed. This is
   a proposal, not permission to run an expensive remote load test.
5. Proposed population-wide budgets at the largest accepted profile: close or
   remeasurement <=5 minutes; consolidation <=15 minutes; complete history export
   and full audit each <=60 minutes. Use bounded steps where necessary, preserve the
   pinned population through every step, and include all durable work in the timer.
   These do not relax exact-head recovery or authorize partial financial publication.
6. Report monthly cost per book at steady state and at peaks: gateway/DO requests,
   active duration, SQL/index reads and writes, stored current/history/checkpoint bytes,
   R2 operations/storage if selected, backup verification, restore and maintenance.
   State shared allowances and account totals, not only marginal per-book prices.
   No cost forecast is credible until the access pattern and actual byte sizes exist.

## Capacity and design blockers found before implementation

- At hypothetical 1,024 bytes per retained outcome, the inventory base needs
  **40,273,698,816 bytes** for outcomes alone. This excludes indexes, current state,
  manifests, checkpoints and independent backup copies. It is a sensitivity calculation,
  not a measured encoding or a lower bound. The documented paid SQLite DO limit is
  [10 GB, measured in decimal bytes](https://developers.cloudflare.com/durable-objects/platform/limits/)
  (rechecked 2026-09-05). Even the 256-byte sensitivity slightly exceeds that limit.
  A compact all-in-one SQLite representation is not automatically a viable solution.
- Retaining one DO as posting authority does not require every historical byte to
  remain in its SQLite database. G1 must compare a measured single-database design,
  verified external immutable history with bounded indexes, and another storage
  placement if necessary. R2 is a candidate, not an approved archive design: moving
  payloads alone does not solve indefinitely growing retry indexes or active state.
  The [six-layout local index experiment](../../../docs/reference/reviews/ledger-capacity-2026-09-05.md#follow-up-permanent-retry-index-layout-experiment)
  keeps a minimal SQL locator plus external history worth investigating; its
  extrapolations do not close capacity, integrity or safe-growth gates.
- `hashBookState`, protocol validation and durable codecs currently require complete
  growing aggregates. SQL indexes cannot remove that kernel work. Any revised state
  access/hash/verification boundary must preserve accounting semantics through an
  explicit reviewed version mapping, not silently weaken validation.
- `ACCOUNTING_LIMITS.maxBasisEvents` is 10,000 and the current basis projection checks
  a complete snapshot population. Large cash/accrual reports need a specified complete
  incremental computation or another reviewed design; pagination alone is not proof.
  Inventory's 10,000 selected-layer bound is distinct from the proposed 100,000 live
  lots. Test fragmented hot pools as well as many small pools; arbitrary splitting
  can change weighted averages, rounding, valuation selection or completeness.
- Historical authenticity, exact old receipts, startup readiness and damage detection
  must be designed together with external history. There is no atomic SQLite-plus-R2
  transaction assumed here. Define crash behavior before/after object upload and local
  reference publication, orphan handling, verified cutoffs and unavailable dependencies.

These are G1 obligations, not reasons to quietly reduce the business profiles or
start application development around the snapshot prototype.

## R2 backup direction and feedback decisions

The owner asked whether R2 could hold backups. **Yes:** independent means outside
the book's restore set; it does not inherently require a different cloud provider.
R2 is the candidate to evaluate, with no bucket/account provisioning approved yet.

| Placement | Intended protection | Remaining limitation |
|---|---|---|
| R2 in the production account, outside the restored DO | Controlled database rollback/loss when the bucket and restore authority survive | Common account administration/access remains a failure domain |
| R2 in a separately administered Cloudflare account | Additional credential/account separation if privileged identities and recovery access are genuinely separated | Still shares Cloudflare as provider; cross-account access and restoration must be tested |
| Another provider or offline copy | Additional provider separation | More operations, key management, cost and restore complexity; not required merely to make progress |

[R2 durability](https://developers.cloudflare.com/r2/reference/durability/) does not
prevent deletion or imply continuous availability. Evaluate
[bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) and
[bucket-scoped credentials](https://developers.cloudflare.com/r2/api/tokens/), preserving
recovery access to encrypted data and keys. Do not claim locks resist an administrator
who can alter their configuration. An archive used as the only canonical history
copy is not also an independent backup just because it is stored in R2.

Open decisions, without blocking safe local analysis:

| Decision | Proposed direction | Approval / evidence still needed |
|---|---|---|
| Business envelope | All four profiles above, 10-year base plus 2x growth exercises | Owner review of business rates and live populations; refine against prospective customers when available |
| Service targets | Existing latency/load/recovery proposals plus the population-wide budgets above | Freeze workload definitions and numbers before accepting performance evidence; identify alert/incident owner before release |
| Disaster recovery point | Ordinary modeled crashes lose no acknowledged outcomes; async backup exposes a separate, measured possible-loss window | Owner must choose acceptable disaster RPO; a proposed <=5-minute backup lag is not zero-loss account-disaster protection |
| Backup placement / retention | Evaluate R2 first; separate administration recommended for account-loss scope; never delete canonical history to satisfy backup retention | Account separation, region/residency, retention duration, key custody and restore authority need review before provisioning |
| Campaign spending | Continue bounded local design/calculator tests only | Remote campaign resource list, spend ceiling, authorization and cleanup before load/restore tests |
| Workflow atomicity / large reports | Close the explicit design gaps above before runtime redesign | Concrete cases, model updates and accounting/integrity review; no implied authorization to change financial semantics |

## Focused reference cross-check

The existing [source register](../../../docs/reference/source-register.md) pins the
revisions; all six submodule identities were rechecked without updating them. This
is a narrow workload/design review, not a fresh holistic accounting audit or imported
benchmark result. No reference scripts were run or source copied into the product.

| Inspected reference | Useful lesson / limit |
|---|---|
| `references/hledger/tools/generatejournal.hs` | Varies transaction count, account count/depth, commodity/price forms and Unicode names; synthetic journals do not establish company lifecycle or cloud durability |
| `references/ledger/benchmark/gen_benchmark.py` | Reproducible mixed two/three/four-posting transactions and commodity trades; fixed 50k-posting data is not ten years of business volume |
| `references/beancount/tools/benchmark.py` | Compares pinned revisions with warm-up, repeated runs and disabled cache; its checkout/build commands are not safe to run against our dirty workspace |
| `references/bigcapital/packages/server/src/modules/PaymentReceived/commands/PaymentReceivedGLEntries.ts` | A payment has its own ledger entries, receivable allocation context and currency handling; do not count every invoice/payment as a generic two-posting cash sale |
| `references/bigcapital/packages/server/src/modules/InventoryCost/commands/InventoryCostGLStorage.service.ts` | Cost entries have separate correction work; our immutable history must account for corrections without copying mutable deletion/rewrite behavior |
| `references/tigerbeetle/docs/coding/reliable-transaction-submission.md` | Stable client-persisted IDs across network/client restarts; retries are attempts, not automatically new events. This does not import TigerBeetle's durability guarantees |

G0 remains open: the calculator verifies proposed arithmetic only. Dated production
command generation, independent expected accounting results, exact payload manifests,
business/SLO approval and the bounded product-expectations cross-check still need
completion. G1 analysis may proceed, but no runtime representation change is approved
by this document's existence or its passing calculator tests.

# Durable book ledger

An initial internal persistence layer around `@rastrata/kernel`, targeting one
SQLite-backed Cloudflare Durable Object per book. **Not production-ready.**
The [ledger contract](../../docs/reference/production-ledger.md) owns requirements,
acceptance cases, implementation tradeoffs, and remaining work.

The internal `IndexedLedgerOwner` can explicitly select
`INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT` as its final constructor argument for a new
book. This profile supports authenticated latest inventory positions as well as
immutable ownership identities. Its default remains the older group profile;
switching profiles on an existing book fails and performs no migration. See the
[state-access contract](spec/state-access-contract.md) for the remaining indexed
admission and startup limitations. This owner is not enabled in the deployed app.

`ProductionLedger` exposes explicit `provision`, typed `execute`, and verified
`read`/`readAt` operations. `readAt` selects an exact retained-outcome cutoff while
still verifying the entire retained history; returned snapshots include the
verified, immutable book scope. `SqliteBookStorage` accepts the Durable Object's actual ID and
its structural SQL/transaction/durability interface. Tenant/book authorization and
strict public request decoding must happen outside this trusted, in-process API.
The in-process command snapshot also enforces the kernel's exact durable schema
before storage access. Bad canonical hashes and foreign-book requests cannot claim
a retained identity; ordinary valid accounting rejections remain durable. See the
[admission integrity review](spec/design-review.md#command-admission-and-retained-protocol-integrity).

The default `LEDGER_FORMAT` preserves the original full-snapshot representation.
New local books may explicitly select `COMPACT_LEDGER_FORMAT` as the third
`ProductionLedger` constructor argument, with a complete
tenant/book/object/namespace/generation scope. It stores individual outcomes with
full-head and chunk manifest commitments. There is no automatic history upgrade.
Both formats independently reexecute every retained command during recovery and
compare the entire resulting record and final head. Compact payloads reduce
storage repetition but do not make full-history execution scalable.
No application WAL, checkpoint or background publisher exists. A per-owner verified
replay cache now avoids reexecuting an unchanged prefix only after rereading and
fingerprinting **every** persisted record. New suffixes, cold startup and historical
reads retain kernel replay; validation and durability failures invalidate the cache.
This is not lazy recovery or bounded history access. See the
[verified replay review](spec/design-review.md#verified-replay-prefix-memoization).

An internal logical-map candidate supports physical-independent roots and
conditional insert/replace/delete. It is not an enabled ledger format or a
replacement for kernel state hashing. Its independent tests and 10,000-row
microbenchmark expose both bounded path work and significant retained-node storage
cost; see the [candidate review](spec/design-review.md#logical-map-candidate-and-measurements).

New compact books can opt into `SqliteIndexedBookStorage` in place of the bare
`SqliteBookStorage`. It atomically provisions canonical/index/page metadata, then
checks both index populations after complete canonical verification and publishes derived
roots with actual outcomes. Both logical partitions currently use the same SQLite
store. This is not remote cold storage, bounded startup or indexed kernel execution;
all original capacity limits remain. Supply trusted full book identity, authority
fence/pending state and epoch-millisecond clock, never request-supplied authority.
Call `maintain` for bounded inactive-construction metadata cleanup; it deletes no
page bytes. Existing bare/older books are refused, not migrated. See the
[owner integration review](spec/design-review.md#indexed-sqlite-owner-integration).
Existing identity hits now reread their exact canonical outcome through a bounded,
full-head-checked SQLite fetch using a previously verified complete record hash.
This does not remove full-history verification or create an authenticated scalable
locator index; see the [source-fetch review](spec/design-review.md#bounded-canonical-source-fetch-and-late-corruption).
An internal source-row candidate now reconstructs exact legacy collection rows from
one verified outcome and checks their separate logical-row commitments. It includes
retained intent hashes and replacement lot snapshots, but is not an indexed
evaluator. See the
[source-row review](spec/design-review.md#authenticated-outcome-row-resolution).
New indexed books may additionally opt into the final constructor option
`{ sourceCatalog: true }`. This separately identified candidate storage profile
publishes logical row roots and source-locator roots atomically with each outcome.
It fully audits the catalog and source rows on recovery, still uses full legacy
evaluation, and keeps all old nodes. Opening an existing book with the wrong option
is refused; no migration is performed. See the
[atomic catalog review](spec/design-review.md#atomic-source-catalog-publication).
After full verification (for example `await ledger.read()`), that opt-in storage
owner can issue `openCurrentRowReader()`. Its `read(collection, ordinal)` resolves
exact tagged rows or authenticated absence; always `close()` the reader. Publication,
expiry, authority changes, corruption or uncertainty invalidate the handle. This
is an internal current-view access port, not historical MVCC or a public authorized
query API. See the [pinned-row review](spec/design-review.md#pinned-current-row-access).
`readTyped(collection, ordinal)` additionally decodes an authenticated row using
the kernel's existing schema and returns exact numeric classes. It has the same
lease, head, close and failure rules as the raw reader; it does not establish a
complete command read set. See the [typed-row review](spec/design-review.md#typed-kernel-row-boundary).

`readBookBasis()` returns the verified scalar book header, current configuration,
opening boundary and last committed financial revision. The three selected rows
are authenticated through the current source catalog. Retained rejections do not
advance the financial clock. This is a common read basis, not complete admission:
current period closure, outstanding FX obligations and command-specific reads are
still required. See the [basis review](spec/design-review.md#pinned-common-book-basis).
`readAdmissionFacts(command)` now folds current period closure and outstanding FX
reversal obligations through source-verified groups at that same head. It returns
facts, not an admission decision: retry/input/timeline ordering and command-specific
checks are not bypassed. See the [admission-facts review](spec/design-review.md#pinned-period-and-fx-admission-facts).

`readCommand(commandId)` adds a book-scoped semantic lookup to that same internal
reader. It verifies both permanent identity partitions, resolves a hit to its
authenticated retained result, and checks the raw book/command IDs. Missing pages
or source bytes are errors, not unused IDs. This includes committed and rejected
results but does not replace the service's retry-input comparison or evaluator.
See the [command-lookup review](spec/design-review.md#pinned-command-identity-reads).

`readJournalIdentity("journal" | "posting", id)` similarly resolves an immutable
journal or posting with its parent journal and effect lineage. It authenticates
the retained result, creating revision and exact journal collection row; it never
equates their different sequence numbers. See the
[journal-lookup review](spec/design-review.md#pinned-journal-and-posting-identity-reads).

`readAccountingIdentity(family, id)` returns a typed immutable accounting effect
from its authenticated creating revision. It covers the thirteen accounting-effect
families, not mutable lots or derived balances/status. Its source commitment is the
revision row; it does not invent an accounting collection ordinal. See the
[accounting-lookup review](spec/design-review.md#pinned-immutable-accounting-identity-reads).

`readLotIdentity(family, id)` locates a legacy lot/holding/allocation's stable
position from its creating revision, then authenticates the **current** row and
raw identity. It never substitutes creation-time quantities for current holdings.
Depleted holdings remain present. See the
[lot-lookup review](spec/design-review.md#pinned-current-lot-identity-reads).

`readOwnedInventoryPools(command)` reads complete original source pools for owned
issue operations, preserving depleted holdings and canonical row order. Policy
resolution failure is distinct from proven empty stock. It reuses authenticated
account groups and current lots, but does not establish selected ownership,
same-command overlays, managed money scopes or complete indexed admission. Its
10,000-row / 32 MiB source-read bounds are prototype limits, not business capacity.

The internal owner's explicit money-group profile adds `readInventoryMoneyScope`
and `readInventorySourceJournal`. It authenticates persistent ownership and exact
posted balances across stock units; zero balance is distinct from absent history.
Journal-group descriptors maintain exact sums atomically and must match a complete
canonical-source rebuild. Subsequent summary reads fetch no historical journal rows,
but owner startup still verifies full history. Older profiles reject these queries;
there is no automatic migration or production application switch.
See the [money-scope audit](spec/design-review.md#authenticated-money-scope-summaries-and-inventory-controls--2026-09-07).

Grouped queries are under construction. The opt-in source owner now atomically
publishes a companion directory for seven canonical grouping predicates, with
conditional member updates and complete canonical rebuild verification. A new
ownership-group profile on the internal indexed owner adds an eighth predicate
over revisions touching a holding, and `readInventoryPosition` proves its latest
after-position without enumerating earlier group members. The older seven-group
profile does not answer that query. The source owner's existing
owner marker explicitly rejects older row-only and four-group owners; no automatic migration is
enabled. `reader.openGroup(kind, values, limit?, maxRowBytes?)` now issues an
owner-local forward-only cursor: call `next()` until `complete`, processing every
page, and close the reader. Every delivered member is source-verified against the
same live view. Count and canonical-row-byte limits apply; failures invalidate the
context. The final page alone is not the entire group or a complete command read
set. See the [grouped-read review](spec/design-review.md#pinned-source-verified-semantic-group-reads)
and the
[group-catalog review](spec/design-review.md#atomic-semantic-group-companion-catalog).

Schedule/revision/tax workflows now have direct indexed-owner replay and identity
conformance tests. They also expose an unresolved legacy schedule-rounding case:
a terminal schedule can leave a cent in its posted source account. See the
[workflow review](spec/design-review.md#indexed-accounting-workflows-and-a-schedule-completion-counterexample).
Passing legacy-characterization tests do not close that production accounting gap.
Explicitly opted-in new cumulative policies now have plan-enforcing command,
codec, revision/termination and indexed-owner recovery tests. No automatic
conversion of existing schedules is enabled; see the
[versioned integration review](spec/design-review.md#explicit-cumulative-policy-command-integration).

The indexed owner also has disposable local SQLite process-kill tests at seven
publication boundaries for both committed termination and retained rejection,
plus a competing-owner termination test. See the
[crash evidence](spec/design-review.md#cumulative-workflow-process-kill-and-concurrency-evidence).
This verifies local SIGKILL recovery, not Cloudflare failure behavior or power loss.

`src/outcome-payload.ts` now evaluates and verifies one command, its original
result and optional financial revision using the shared kernel codec. It is now
used by the explicitly selected compact storage path. The opt-in `bun run probe:outcome-payload` compares
payload bytes for 100 cash sales in in-memory SQLite and verifies exact replay;
it is not a durable-storage or deployed-capacity benchmark. See the
[outcome evidence](spec/design-review.md#single-outcome-payload-and-shared-schema-hardening).
For integrated SQLite/runtime verification and the failed 10,000-sale capacity
target, see the [compact ledger evidence](spec/design-review.md#integrated-compact-ledger-format).

`src/index-control.ts` is a new internal SQLite metadata component for the indexed
target: canonical/index transaction participation, frozen prefixes, cutover and
durability reconciliation. The opt-in indexed storage owner wires it into
`ProductionLedger`; the low-level control is not a public accounting API.
It requires an owner-verified canonical anchor and independently
verified index populations. It now includes durable reader/construction leases,
with accounting-path root verification in the indexed owner, but no merge scheduler
or page reclamation.
Its dedicated SQLite tests do not establish full ledger
conformance. See the [component evidence](spec/design-review.md#sqlite-index-control-component).

The [pin registry](spec/design-review.md#durable-index-pin-registry) captures exact
views, uses non-reusable server-issued IDs and rejects expiry/clock rollback.
The pin/page cutover integration test uses a synthetic canonical anchor; the
bare accounting adapter does not maintain indexed views. The opt-in indexed owner
does, with real canonical anchors and source-population checks.

`src/identity-audit.ts` provides an internal, small-book identity audit oracle. It
derives permanent IDs and their first outcome sequence from real replay-verified
kernel results and checks an enumerated population entry by entry. It does not
authenticate index pages, implement a bounded rebuild, or change the posting path.
See the [identity audit evidence](spec/design-review.md#canonical-identity-audit-oracle).

`src/index-pages.ts` adds an internal candidate page codec, full-tree verifier and
canonical-population audit. Pages have separate physical locations and digests;
the verifier checks exact fetched bytes, child ranges, counts and identity Oseq.
Tests exercise Bun and local workerd. Durable page storage,
trusted view selection, pins and publication are **not** provided by this module.
See the [page verification evidence](spec/design-review.md#authenticated-index-page-candidate).

`src/index-page-store.ts` supplies an internal, append-only SQLite page store with
full-graph verification before root-descriptor retention. It refuses location
overwrites and waits for durability confirmation. Local workerd tests now recover
actual stored pages after runtime replacement. Retaining a descriptor is **not**
selecting an active accounting view; the indexed owner provides selection and pin
integration. Page reclamation and remote cold storage remain open. See the
[storage evidence](spec/design-review.md#durable-sqlite-derived-page-store).

`src/index-view-audit.ts` compares both pinned hot/cold partitions with actual
historical accounting identities, original outcome sequences, the complete
snapshot-ledger head and persisted book scope. It checks pin liveness through I/O.
This remains a small-book audit, not indexed posting or scalable recovery; see the
[partition evidence](spec/design-review.md#pinned-partition-and-historical-cutoff-audit).

That module also opens an audited pinned index reader. After full canonical and
population verification, individual key lookups authenticate bounded paths in
both partitions. Missing required pages and expired pins fail; results are only
outcome locators, not raw-identity or posting admission. The accounting execution
path does not yet use these lookups. See the
[lookup evidence](spec/design-review.md#authenticated-point-and-absence-lookups).

The audited reader also streams complete half-open hash-key ranges across both
pinned partitions, merging entries in order and checking liveness between batches.
Required-page loss is an error; only terminal completion establishes the full
range. This supplies read infrastructure, not account/date query schemas, indexed
kernel evaluation or resumable business commands. See the
[range evidence](spec/design-review.md#authenticated-range-traversal).

Index insertion can now prepare immutable replacement pages along one path,
including leaf/branch splits. A full physical-layout audit establishes a balanced
tree before bounded updates; old roots remain unchanged. This is preparation only:
globally fresh location allocation, canonical identity resolution, cross-partition
admission and atomic publication with accounting still belong to unfinished owner
integration. See the
[update evidence](spec/design-review.md#bounded-copy-on-write-insertion).

New page stores can explicitly select `initialize("allocated")`: reservations and
writes then require a live construction pin in the same SQLite transaction.
Physical locations include the trusted fence generation and a durable increasing
counter; abandoned locations are not recycled. Legacy page stores are not silently
upgraded. Full canonical/index publication and protected-root reclamation remain
open. See the [allocation evidence](spec/design-review.md#fenced-physical-location-allocation).

Canonical storage can now participate in index control's single SQLite transaction
through an active, same-store token. Tests publish real committed and rejected
outcomes with prepared fixture roots, and verify rollback and uncertain replies.
This is a guarded integration port, not the complete indexed accounting adapter;
see [atomic publication evidence](spec/design-review.md#shared-canonical-and-index-transaction).

Prepared publication now requires a durable registration binding the exact live
construction, input view, target-head commitment and fully verified root. Selection
consumes that registration and pin atomically with canonical/index writes. The
expanded control schema has a new format identifier and does not migrate older
prototype controls. Canonical membership admission and complete protected-root
reclamation still remain open; see the
[prepared-publication evidence](spec/design-review.md#prepared-root-publication-admission).

Construction tracking now records every reserved location before a page is written,
including abandoned/unwritten allocations. Bounded batches verify an exact captured
prefix and allocation watermark under a live pin. Release, expiry and publication
queue resumable tracking/reservation cleanup; cleanup never deletes page bytes or
lowers allocation high-water. The new `rastrata-index-control-tracked-v1` schema
rejects older prototype controls without migration. This is per-construction
tracking, not the global reference barrier or permission to reclaim pages. See the
[tracking evidence](spec/design-review.md#construction-location-tracking-and-metadata-cleanup).

`src/outcome-identities.ts` derives newly introduced identities from a canonical
outcome payload. Existing hits must resolve to matching original raw identities;
only repeated lot snapshots may retain an earlier creation locator. The accounting
publication fixture now uses this derivation, not a hard-coded identity list.
Source-history authentication, both-partition owner integration and indexed kernel
evaluation remain prerequisites, not guarantees of structural projection. See the
[source-admission evidence](spec/design-review.md#canonical-outcome-identity-derivation).

| Directory | Responsibility |
|---|---|
| `src/` | Record framing, SQLite transactions, serialization, and recovery |
| `test/` | SQLite fault injection and real local Workers-runtime integration |
| `spec/` | Ledger SysML, executable design cases and reference/audit decisions |
| `scripts/` | Package-owned design verification tooling |

From this directory:

```sh
bun run typecheck
bun run test
```

Root `bun run check` includes these tests. Kernel coverage/mutation gates continue
to measure the kernel only; no 100% ledger coverage claim is made.

`bun run probe:capacity` is an opt-in local capacity investigation, not a fast test
or Cloudflare load test. It writes raw evidence under root `coverage/ledger-capacity/`
and exits nonzero when the evaluation target is not reached. See the
[measured production-capacity blockers](../../docs/reference/reviews/ledger-capacity-2026-09-05.md).
`bun run probe:compact-capacity` runs the same workload and 10,000-sale target
against the explicitly selected compact format, capturing source identities,
worker output and the fail-closed target assessment under the same evidence root.
The [ledger model](spec/README.md) defines the target design; prototype implementation
does not yet satisfy the entire model. `bun run check:spec` verifies design cases and
`bun run check:syside` validates the model and its imported kernel in the editor workspace.

The Miniflare harness persists SQLite across replacement workerd instances and
compares output with direct Bun kernel execution. Its fixture-only HTTP handler
is **not a public API or deployable gateway**. Runtime replacement is graceful;
abrupt termination, remote durability, restore, and capacity testing remain open.
No Cloudflare account is needed and no deployment occurs.

The separate [development app](../../apps/ledger-acceptance/README.md) provides an authenticated,
synthetic-only remote smoke deployment. Its evidence does not close the model's
remaining production-runtime obligations.

Only the test TypeScript configuration uses `skipLibCheck` for defects in the
pinned Miniflare declaration bundle. Production declarations and all our source
and test code retain strict checking. Bun's bundle target is `node` solely to keep
the native crypto import intact for Workers' compatibility layer, not to adopt
Node as the runtime or package manager.

# Kernel state-access audit

Status: G1 design input, 2026-09-05. This is a source-reviewed dependency inventory
and an implementation contract proposal, **not** an implemented indexed kernel,
proof of complete read sets, or permission to change historical accounting results.
The existing SysML complete-recovery obligations still apply. Physical indexing,
incremental integrity, bounded startup and migration remain design gates.

The audit follows `evaluateBookCommand`, its calculation/admission/source-closure
helpers, `validateBookEffectTopology`, `commitBookIntent` and canonical hashes.
It distinguishes semantic dependencies from whole-array representation costs.
The old evaluator remains the bounded comparison oracle, except where a separately
reviewed correctness defect is demonstrated; its output is not infallible.

## Common dependencies and order

Update, 2026-09-07: the internal indexed owner now reuses a verified warm aggregate
under exact head/view/catalog and authority checks. Explicit audit, cold recovery
and uncertain sessions still require complete replay. This removes repeated owner
replay, **not** the whole-state kernel dependencies inventoried below. See the
[implementation review](design-review.md#verified-warm-execution-and-asynchronous-outcome-outbox--2026-09-07).

Quantity-only inventory admission now has a shared coordinate-validation primitive
in `journal.ts`: book/functional commodity, accounting date, account, units commodity
and analytic members, with explicit requirements from the resolved booking policy.
Ordinary journal admission uses the same account/commodity/member checks. The
standalone wrapper validates the complete supplied chart; it is neither an indexed
read-set implementation nor a trusted policy resolver. It must not manufacture a
posting ID to consult posting-specific dimension overrides. Opening/period checks,
quantity/ownership authority, command topology, CAS and durable outcomes remain
separate obligations. ACC-039.8 is still pending; this primitive enables no new
command or execution profile by itself.

`PostOwnedInventoryTransactionCommand` now has a bounded full-state implementation
as the eighteenth runtime command: ordered acquisition/issue groups, optional real
journals, strict command/effect codecs, canonical effects and replayed projections.
It is not an indexed evaluator or an enabled production inventory profile. Indexed
admission must authenticate the complete policy pool,
selected positions/anchor origins, applicable booking policy and required members,
all permanent identity absences, and managed-money-scope presence/absence at one
head. The scope is account/functional commodity/dimensions across units commodities,
not merely the stock's units commodity, and persists after depletion. Derived
same-command successors are evaluated in explicit operation order. No layer amounts,
anchor budgets or replacement source snapshots are accepted as client authority.
First ownership must prove zero existing posted balance in the complete scope, or
use verified adoption. No-lot balances and exhausted-stock residuals are not absence.

Canonical ownership effects retain quantity allocations and after-positions inside
their complete immutable revision rows. Source review established that no duplicate
twenty-fifth canonical collection is necessary: `inventoryOwnershipEffects` is a
strictly checked revision alias, not independent authority. Both full projections
first verify this alias against revision history; delta/source mappers retain the
complete creating revision plus ordinary lot-state changes. Existing profile tags,
all 24 collections and legacy bytes remain unchanged. Dropping ownership from the
revision changes its committed row; deleting only the materialization fails decoding.

The internal indexed owner now publishes and recovers acquisition/issue effects,
permanent operation/anchor/movement/reference IDs and quantity-allocation IDs under
the existing same-transaction protocol. Quantity allocations share the permanent
legacy allocation namespace but not its posting-linked row shape. A legacy snapshot
cannot repeat an ID first created as an owned allocation. `readInventoryIdentity`
authenticates immutable origins through their actual retained-result and revision
rows, preserving Oseq versus financial revision. It does not return latest positions
or establish complete selection/managed-scope groups. Indexed command admission,
sparse lot changes, migration, other ownership transitions and capacity remain open.

The internal owner's explicit `INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT` profile now
adds `inventoryRevisionsByHolding` over immutable revision rows, without another
canonical collection. Each touching revision is one group member, even for several
same-command movements. `readInventoryPosition` authenticates the greatest revision
through the group's right spine, chooses its greatest matching artifact ordinal,
joins the current holding and exact original anchor, and checks kernel ownership
arithmetic. It returns owned, unowned or absent distinctly and retains depleted
ownership. Unsupported profiles and unavailable/stale evidence fail closed. The
read confirms the live head before and after the synchronous source join; its
temporary mathematical read context is not returned as admission authority.

The new group profile has its own directory/hash domain and is selected explicitly
for a new internal owner. Both older profiles retain their existing byte semantics;
ownership queries on them reject instead of proving false absence. Reopening a book
with a different profile fails without migration. Full-history startup still applies.
The last-member map proof reads at most 257 nodes, independent of unrelated history,
but source-row retrieval and owner startup have their separate costs. Whole-command
admission remains required; original source-pool and managed-money readers are now
composed for owned preparation below, behind a full-state common-admission bridge.
They are not yet a sparse whole-command evaluator or publication capability.

`readOwnedInventoryPools(command)` snapshots an owned command before any await,
binds it to the pinned current configuration and returns original source pools for
issue operations only. Reads are deduplicated by policy ID/version/full content
hash and units commodity, with the original operation array indices retained. A
missing, ambiguous or hash-mismatched policy returns `unresolvedPolicy` with null
entries and account evidence, distinct from a proven empty resolved pool. Resolved
means identity/hash resolution, not temporal, capability or derivation admission.

This dependency deliberately differs from `readInventoryCostFacts`: it exhausts
`holdingsByAccount` for every distinct selected policy account and preserves depleted
holdings. The existing owned selector validates and budgets those rows before
selecting nonzero layers. Each account source is scanned once, including unrelated
commodities; each matching lot is authenticated once. Final entries retain global
canonical holding-ordinal order and exact holding/lot source ordinals and hashes.
Account receipts distinguish total scanned population from the matching commodity
population. Stable group commitments, exact page consumption, raw predicates,
current source identities and live head confirmation are required. No partial pool
is returned on failure. All indexed group profiles support this existing predicate.

This is a candidate read boundary with a 10,000 scanned/output-row limit and a
32 MiB budget for unique encoded holding/lot sources, not a business-capacity target
or a retention cutoff. Read deduplication does not waive the kernel's repeated
operation work accounting. Retained holding scans, selected position/anchor joins,
same-command acquisition/issue overlays, managed-money-scope proofs, complete
indexed admission and sparse publication remain separate obligations. Legacy stock
appearing in a pool is not ownership adoption. No kernel mathematics, execution
profile or historical bytes changed for this reader.

`readInventoryMoneyScope(scope)` now returns independently authenticated ownership
presence and exact posted money for book/account/functional commodity/dimensions,
across units commodities. It distinguishes unmanaged from zero balance and retains
ownership after depletion. A nonempty zero-balance journal group retains its
descriptor and population. A scope can be unmanaged with a nonzero posted balance
and no holdings; that does not permit first ownership. The kernel's opening-balance
guard remains required. Scope inputs are snapshotted without invoking accessors,
analytic set order is normalized explicitly, and the raw key enforces sorted unique
members plus a 1 MiB UTF-8 budget before hashing. Missing or foreign source authority
retires the reader, never becomes unmanaged or zero.

The explicit `INDEXED_MONEY_GROUP_CATALOG_FORMAT` internal-owner profile adds
`inventoryRevisionsByMoneyScope`, `inventoryRevisionsBySourceJournal` and
`journalsByMoneyScope`, preserving older profiles' exact predicates and domains.
Switching existing catalogs is refused without migration. Scope/source-journal
groups retain each matching immutable revision once. `readInventorySourceJournal`
authenticates a latest matching source revision; unreferenced does not imply the
requested journal exists or is absent. References from both original anchors and
journal-linked movements persist after depletion.

Journal scope descriptors commit an exact rational `postedBalance` alongside the
complete journal-member root/count. Every matching posting contributes its actual
posted decimal money exactly once, regardless of units or cost basis. Publication
applies new-minus-old contributions atomically with canonical/source/group changes;
source verification independently rebuilds sums and exact membership from canonical
rows. Rehashing a false summary is not sufficient to pass that verification. Empty
group removal requires zero; a nonempty zero sum remains present. A descriptor hash
alone is not source authority, nor is this a new canonical accounting collection.

After complete source audit, balance lookup traverses the bounded directory and
fetches no historical journal rows. Tests demonstrate unchanged node reads at 1,
4 and 16 journals in a fixed two-scope directory; they do not establish enterprise
capacity or end-to-end latency. Full-history owner startup/admission, archive
integration and migration remain separate. These readers are original-source
dependencies: full command admission still must join selected positions/anchors,
live unowned stock, identities, periods/policies, ordinary-command scope guards,
same-command overlays and final publication CAS. No kernel math changed here.

`readPostingReferenceUsage(id)` supplies a separate cross-feature dependency:
inventory-only `readInventoryIdentity("postingReference", id)` absence does not
prove that an allocation, settlement, tax or other canonical accounting artifact
has not already used the ID. The explicit reference-group profile extends money
coverage with `postingReferenceRevisionsById`. It projects only committed accounting
effect values (all thirteen append-only variants) and ownership anchor/movement
references, never proposals or rejected commands. Each revision is one member per
ID. A latest witness proves usage, not a unique reference definition or creation
locator. Revisions of an allocation schedule retain original source occupancy.
Unsupported profiles reject even absence queries. Full bidirectional source audit,
raw predicate/source-row validation and live head checks remain mandatory. This
read is not yet wired into a complete indexed owned-command admission context.

`preparePinnedOwnedInventory` now composes these dependencies into the same
`prepareBookOwnedInventory` command-specific kernel stage used by full-state
evaluation. Before these reads, it now calls the owner's pinned `evaluateAdmission`
bridge, which runs `evaluateBookCommandAdmission` over the COMPLETE recovered state
and protocol. This is the exact common prefix used by `evaluateBookCommand`: retries,
input/scope/version/time, financial identity, profile history, full-state hash,
expected revision, configuration and global obligations. A replay or rejection
returns a distinct finished evaluation without command-specific indexed inventory
reads or publication (full-state integrity checking still traverses canonical state);
live-head checks also bracket those finished evaluations. The bridge does not
pretend that a partial header or a matching digest proves full-state integrity.
On continuation, preparation supplies original pools/positions/dates, identity facts, period and
journal admission inputs, managed balances and complete acquisition-account checks.
Shared kernel code handles pending same-command identities and working inventory
successors. Quantity-allocation occupancy authenticates either legacy or owned
creation evidence without forcing one record shape onto the other. The preparation
returns exact journals, ownership effects, new lots and changed holdings—not an
intent, receipt or publication capability. The full-state wrapper still serializes
its historical whole `lotState` replacement unchanged.

The composition snapshots input before awaiting, validates command/head/raw identity
bindings, and confirms the live head before and after synchronous compilation. Its
callback context never escapes and is retired after use; any infrastructure failure
retires the reader. This is an eager original-source read set, not selected-row-only
I/O: candidate limits are 80,000 explicit point reads, 10,000 acquisition-account
holding rows and 32 MiB retained source payloads (duplicates conservatively charged).
These are not a peak-memory or business-capacity guarantee. Common admission is now
enforced through the full-state bridge, not a scalable read-set implementation.
Sparse admission, scalar state authority, sparse canonical effects and publication
CAS remain distinct unfinished integration gates.

The explicit state/head framing candidate now lives in `indexed-book-state.ts`.
It is separate from the existing full-projection oracle and every enabled storage
profile. `rastrata-indexed-book-state-v1` binds the exact scalar header plus a
closed, sorted catalog of all 24 ordinal collection roots. It excludes redundant
current-configuration aliases: future readers must derive those from the actual
authenticated configuration row selected by the header, never trust a hash alone.
`rastrata-indexed-book-head-v1` binds physical scope, independent outcome/financial
counters and full hash metadata without changing economic collection domains.
Neither codec is a substitute for complete source verification or command admission.

Root populations/ordinals are uint64; scalar header counters remain exact integers
with a 64-decimal-digit encoding bound. Nonempty collection roots must declare
ordinal endpoints 1 and count, and revision/journal/configuration/opening/retention
counts must agree with the header. Reachable nodes, payloads, configuration hashes,
ordinal closure and accounting semantics still need verification. A correctly
framed digest can refer to missing or inadmissible data. Framing limits (64 KiB
header, 256 KiB state record, 128 KiB head) are representation bounds, not measured
book capacity. Existing 1,000-outcome/whole-state recovery limits are unchanged.

The legacy bridge **input oracle** revalidates the entire original aggregate,
preserves exact row encodings and rebuilds these new roots. It neither installs a
profile nor declares old/new state hashes equivalent. Small-book tests compare
path-copy appends against independent full rebuilds; complete indexed command
evaluation, effects/deltas, storage publication, historical migration and startup
policy remain separate gates. See the [framing review](design-review.md#explicit-indexed-state-and-head-framing).

`prepareIndexedBookOutcome` now compiles a separately admitted new commit or
retained rejection into a complete new catalog, ordered canonical row changes and
reachable new COW nodes, without writes. Commit records come from the shared
kernel constructor; the supplied full financial predecessor must match its actual
current revision-root leaf. All effect variants have an exhaustive projection
mapping. Legacy lot snapshots replace all three lot collections; they are not
silently treated as append-only or sparse. Original historical outcomes remain
unchanged. Rejection reasons/result hashes remain independently evaluated inputs.

This compiler is **not** an indexed evaluator, retry-identity gate or publication
authority. It does not update physical identity/source indexes or replace full-head
and fence CAS. Current candidate limits are 10,000 rows per replacement, 30,000
changed rows and 16 MiB staged logical-node bytes, plus the existing outcome codec
limit. Source, limit or framing failure returns no partial candidate and performs
no writes. Complete source admission, sparse inventory effects, publication and
full business-scale measurement remain open; small path-read tests do not close G1.

The owner may supply a copied, closed three-field preparation budget that only
narrows those hard limits. Zero is allowed as a refusal budget; equal usage passes
and exceeding a bound returns no candidate. Budget failures are operational, never
retained accounting rejections. The conformance tests now require every current
`BookEffect` variant to occur in an assigned actual admitted command stream, fold
every ordered row write against independent legacy wire subtrees, and compare all
final rows/roots with the full engine. Raw deletion mechanics remain untrusted:
a correctly hashed fabricated deletion intent is rejected by canonical admission.

`indexed-outcome-record.ts` adds separate `rastrata-indexed-outcome-v1` framing
and exact projection replay. Its acyclic chain binds the exact prior full head,
resulting state commitment and hash of original outcome bytes; the resulting head
then contains that chain hash. Decoding checks complete scope/actual object, Oseq,
financial/configuration/posting continuity and original result/revision mathematics.
The closed envelope is bounded to 4 MiB UTF-8; this is not an increased outcome
codec or storage capacity limit. Existing compact/archive formats are unchanged.

Projection replay authenticates the financial predecessor and all changed paths,
then compares the entire resulting state and original outcome byte-for-byte. A
counter-compatible state paired with another command, or a rewritten earlier
retained row, can pass framing but must fail this replay. Neither layer reruns
accounting admission, proves a rejection reason, establishes permanent-ID absence,
or authorizes a durable receipt. No adapter/profile is enabled by this work.

All eighteen command variants inherit these dependencies. An indexed evaluator
cannot implement only the command-specific row in the next table.

The new-format `IndexedLedgerOwner.openCurrentRowReader()` now connects its fully
replayed accounting state, authenticated source/group catalogs and both identity
partitions to the same reader implementation used by the compact owner. Each
profile supplies its actual full head and source/hash domains; no legacy head is
fabricated for the indexed format. Every queued operation confirms before and
after delivery, and any failure retires all methods/cursors of that context.
Opening still performs complete recovery and retains the bounded full-state
bridge. This does not implement command read-set admission or scalable startup.

The publication producer now uses `prepareAdmittedOutcome` to compile the actual
kernel intent or retained rejection against prior authenticated logical roots,
instead of serializing/rebuilding the complete resulting book for that candidate.
It snapshots both decision and financial predecessor, checks live owner authority
around old-node reads and delivery, and rejects any change in the exact previously
validated catalog/anchor bytes—not merely their stored digest fields. It then
decodes and reprojects the serialized outcome through the existing delta path;
both passes use the same compiler. The owner requires exact kernel outcome bytes
and retains atomic canonical/source/group/identity publication, durability checks,
and complete kernel replay with independent whole-state root reconstruction before
acknowledgement.
This removes one publication-time whole-book rebuild, not full-state evaluation,
full-history startup, whole-lot replacement or per-receipt recovery. No profile,
effect encoding, canonical hash or historical receipt changes.

1. **Retained identity first:** look up the original command/result by book and
   stable command ID, recompute the complete input hash and compare all hash fields.
   Exact retries return the original revision, diagnostics and times before checking
   today's expected revision or accounting admission. Missing/unverified storage is
   not evidence of a new ID. A digest locator must also verify the original raw ID;
   a hash collision or conflicting pointer fails closed, never creates a second result.
   The internal `readCommand` context now implements authenticated command-ID
   presence/absence plus raw-identity-bound retained-row resolution. The full-state
   evaluator now delegates retry/input/scope/protocol/timeline checks to shared
   `evaluateBookCommandProtocol`. A conformance harness supplies pinned retained
   rows and the latest financial revision; it does not execute or publish an
   indexed command. Null means explicit absence, unresolved evidence throws, and
   neither `continue` nor `finished` establishes a complete command read set or a
   durable receipt. Exact retries do not request today's financial chronology.
2. **New-command admission:** supplied input hash and command book must first match;
   otherwise the rejection is unretained and cannot poison durable protocol or claim
   an identity. The service checks exact durable command shape after bounded copying,
   before storage access. Then check protocol version, supplied chronology against the last
   committed financial revision, book/financial identity and activation identity,
   complete state integrity, expected revision, fiscal calendar and configuration.
   The current evaluator validates both periods and configuration for every new
   command. A validated immutable configuration cache needs a verified version/root,
   not a caller-supplied `valid` flag. Retained rejections do not move the financial
   revision's committed time; substituting the latest outcome's time changes behavior.
   `readBookBasis()` now supplies the owner-verified scalar header and source-verified
   current configuration, original opening boundary and latest financial revision.
   It proves row 1 absent for a zero-revision book and uses configuration revision
   plus one as the configuration ordinal, not an outcome or book revision. This
   common read boundary does not establish current period closure, outstanding FX
   obligations or a complete command read set. See the [basis review](design-review.md#pinned-common-book-basis).
   `readActivationIdentity(boundaryId)` now resolves the original committed
   activation through the permanent boundary-ID index, retained outcome and
   creating revision. Its identity hash and original configuration are not today's
   active configuration. Absence is scoped to the requested ID, not a proof that
   the book has no activation; the complete recovered basis supplies that context.
   Shared `validateBookFinancialIdentity` and `validateBookConfiguration` apply
   unchanged semantic checks to these complete inputs. Full-state hashing remains
   between identity checks and expected-revision/configuration admission. Neither
   helper establishes source authenticity, integrity of the complete state, or an
   admissible command on its own.
3. **Book-wide outstanding FX obligation:** before dispatch, the evaluator finds the
   first unreversed unrealized result earlier than the command date whose matching
   current currency policy requires reversal, except the original being reversed
   by this command. This is not limited to accounts touched by the new journal.
   Preserve retained insertion order for deterministic diagnostics. Configuration
   replacement can change this predicate's policy lookup: an index must account for
   that dependency, not simply mark a result once when it was originally posted.
   `readAdmissionFacts(command)` now exhausts source-verified unrealized-by-policy
   and reversal-by-original groups, using the first matching current currency
   policy and selecting the lowest canonical result ordinal across groups. It also
   folds complete period-transition groups for current configured periods. This
   preserves the guard's semantics but is not constant-cost evaluation or a
   complete command read set. See the [admission-facts review](design-review.md#pinned-period-and-fx-admission-facts).
   The full-state evaluator and grouped reader now share
   `requiresRemeasurementReversal` for eligibility. Policy-array selection,
   complete reversal absence and minimum canonical ordinal remain explicit
   caller obligations. `validateBookGlobalAdmission` preserves specialized
   command opening checks before the overdue lookup, followed by command dispatch.
   A null overdue result means proven absence for this command, not missing data.
   Neither helper proves source completeness or creates a commit intent.
4. **Journal admission:** every supplied/generated journal checks globally permanent
   journal IDs and posting IDs, including all journals prepared in this same command;
   full policy/quantization/dimension admission and exact fiscal resolution still run.
   Posting identity is book-wide, not scoped to the new journal or accounting period.
   The full-state evaluator now delegates these journal-local checks to the shared
   kernel `prepareBookJournal` primitive. Its explicit `BookJournalReadContext`
   accepts complete configuration and synchronous present/absent identity and
   open/closed period facts; unresolved values throw rather than imply absence.
   A ledger conformance harness supplies authenticated pinned reads and compares
   exact candidates/diagnostics with canonical command execution. This is not an
   indexed command evaluator: it cannot establish global admission, assign order
   authoritatively, authorize a closed-period override or publish a commit intent.
   The full-state adapter still overlays journals already prepared in the same
   command. A future indexed adapter must preserve that overlay and all other
   command-specific closure, head/fence and publication checks.
   Fiscal selection itself is shared as `resolveBookAccountingPeriod`: a complete
   validated period catalog, synchronous closure lookup, date and activity kind
   suffice; no journal or posting is required. Existing journal diagnostic text
   and paths remain unchanged for retained-receipt replay. The indexed conformance
   harness exercises this same primitive before close, after close and after a
   reopen that supersedes dependent closes without reopening their periods.
   This extraction does **not** admit quantity-only inventory commands or prove
   their opening-boundary, identity, source-closure, authorization or CAS checks.
   Its closed-period mode remains reserved for separately governed command paths.
5. **Accounting effects and source closure:** effect identities are unique within
   their type family, including pending effects. Canonical posting references bind
   book, journal, effect key, posting ID and complete content hash. A same-command
   journal may satisfy a reference; a caller's copied posting is not authority.
   The pinned journal/posting identity reader now resolves immutable canonical
   source rows and parent journal/effect lineage without scanning history during
   that lookup. Reference-hash/effect-key matching, pending same-command effects,
   and complete accounting source closure still belong to the evaluator.
   **Reproduced legacy exception (2026-09-07):** the private posting resolver
   deduplicates all current/prepared journals using `journalId + ":" + effectKey`.
   Distinct pairs `("a", "b:c:journal:0")` and `("a:b", "c:journal:0")` alias;
   the later journal hides the earlier source before exact reference checks run.
   The raw-identity indexed reader correctly finds both. Therefore substituting
   that reader directly changes canonical admission and retained-rejection replay.
   Complete legacy read sets currently include this unrelated-journal dependency;
   collision-free prospective semantics and governed compatibility must remove
   it explicitly. It must not be modeled as safe source absence or fixed by
   rejecting colon-bearing IDs globally. See the [executable counterexample and
   compatibility experiment](design-review.md#canonical-posting-reference-delimiter-alias-and-replay-compatibility).
   New books may explicitly select `structural-source-identity-v1` in their hashed
   genesis configuration. This selects structural coordinates in the existing
   whole-book evaluator; it does not enable indexed evaluation. Reader admission
   must authenticate the configuration selection, never infer it from the SQLite
   representation or caller flags. Existing books require the explicit monotonic
   `executionProfileAdoption` configuration payload to opt in. History preceding
   that committed transition retains the legacy dependency above, including
   rejected outcomes; exact retries never switch profiles. Configuration replacement
   without the payload preserves selection. Inventory ownership is unchanged.
6. **Publication:** reevaluation, effect topology and immutable ownership currently
   protect `commitBookIntent` from forged/stale/mutable drafts. A new read context
   must preserve those guarantees, including negative reads, until complete-head
   CAS. A financial-revision-only CAS misses a competing retained rejection.
   Shared `prepareBookCommitRecords` now constructs exact revision/retained-result/
   response records from an admitted intent and the financial predecessor's book,
   revision and complete chain hash. The canonical commit path uses it after its
   existing reevaluation/topology checks; it retains the original hash preimages.
   This removes historical-array dependence from record construction only. A valid
   intent hash does not prove economic admission, and the helper neither applies
   state effects nor authenticates a read context or changes recovery semantics.

Source anchors: kernel `book.ts` functions `evaluateBookCommand`, `evaluateBookCommandProtocol`, `prepareJournal`, `prepareBookJournal`,
`prepareAccountingCalculation`, `validateAccountingSourceClosure`,
`validateBookEffectTopology`, `commitBookIntent`; `accounting.ts` functions
`validateAccountingEffectAdmission`, `accountingEffectExists`.

## Command-specific dependencies

“Complete” means all matches at one verified cutoff, including an empty result;
it does not require one unbounded in-memory array. Proposed summaries below require
rebuild equivalence and atomic maintenance. They are not implemented shortcuts.
All effects in a row publish together with one result, not as independently posted
pages. Every generated journal additionally inherits common journal admission.

The inventory pool dependency now has a pinned read implementation:
`readInventoryCostFacts(command)` uses complete current configuration, exhausts
nonzero holdings by each policy account and requested commodity, and joins each
distinct lot through authenticated current identity reads. It returns exact layers
and compact holding/lot source receipts, never copied historical collections.
Empty groups are resolved explicitly; missing lots/pages are not absence. The
kernel's layer-count limit is enforced before returning any partial population.
The actual group and lot reads remain in one owner queue operation with final
live-context confirmation. `inventoryCostLayersMatch` shares exact population
comparison with canonical execution. Temporal/capability/derivation admission,
costing, disposal identities, generated journals, lot effects and publication are
still separate obligations. No full indexed inventory evaluator is claimed.

| Command | Required canonical reads beyond the common contract | Atomic changes / scaling boundary |
|---|---|---|
| `activateBook` | Configuring status, absence of opening boundary, selected opening journal and optional lot dependencies | Activation pins financial identity/configuration/boundary; optional opening journal and lot effects. Migration opening is not a second activation path |
| `postJournal` | Opening-date boundary; optional acquisition/disposal/transfer dependencies below | One journal plus optional lot effects; ordinary no-lot posting does not semantically need every old journal body |
| `correctJournal` | Exact original journal, absence of a prior correction, original period status, optional lot dependencies | Exact reversal or admitted supersession plus correction link and optional lot effects. Original journal remains immutable |
| `closePeriod` | Target period/open status, unused close-package ID, total prior closes for target (including superseded), complete ordered journal-hash population, current configuration and prior revision-chain hash | Optional closing journal, immutable close package and close transition. Existing `LedgerCutoff` hashes every journal through the posting cutoff, not only this period |
| `reopenPeriod` | Target closed status; complete currently unsuperseded close packages whose configured period end is at/after target end; latest current target close and exact closing journal if present | Reopen transition supersedes the complete selected close set; optional exact closing reversal and correction. Latest transition determines period closure, while supersession determines close-package currency: these are distinct projections |
| `replaceConfiguration` | Expected configuration revision; maximum accounting date of **all** canonical journals; candidate complete periods/chart/policies and old active snapshot | Prospective configuration revision with old/new snapshots. Maintain maximum date from canonical journals, including closing/correction journals; do not approximate with last insertion date |
| `postInventoryTransaction` | Selected inventory policy; **all nonzero holdings** in its pools for the requested commodity, joined to acquisition lots, exactly compared to supplied layers; selected lot-operation references | Cost journal, optional provisional layer, optional lot effects. Current calculator limits the full supplied layer population to 10k; merely passing its first page changes costing/admission |
| `postOwnedInventoryTransaction` | Explicit source-identity profile; complete policy pools; exact original anchors/current positions; permanent operation/anchor/movement/reference/allocation IDs; managed money-scope presence and zero opening balance or verified adoption | Ordered acquisition/issue groups, optional real journals, complete ownership inside the revision row, and current whole lot-state replacement. Indexed storage, immutable origins, latest positions, source pools and managed-scope/balance dependencies exist separately; complete sparse admission does not |
| `recostProvisionalInventory` | Original provisional layer with retained policy/source; sum of all previous recost source quantities for that layer; one open regular period | Recost effect and journal only for nonzero adjustment. Exact cumulative recost quantity can be a maintained summary; recost request sources remain bounded/validated |
| `adjustInventoryValue` | Selected value and linked cost policies; allocated lots/holdings; **all holdings per allocated lot** to prove fully disposed status; validation of the entire supplied lot/holding population | Journal, adjustment and updated lot state. Algorithm 1.0.1 scopes live targets without hiding other accounts; 1.0.0 preserves historical admission. Depleted holdings cannot simply disappear |
| `recognizeOpenItem` | Unused open-item ID and exact canonical recognition posting/date (often supplied in same command) | Recognition journal and immutable open item. Scope, denomination and exact booked basis close over the source |
| `applySettlement` | Selected open items and original recognition postings; complete prior allocation totals per item; active remeasurement by source; unique settlement/allocation IDs; exact supplied payment postings and selected FX/quantization policy | All payment/FX journals, settlement and allocation edges. Track pending allocations within this command as well as prior totals. Settled items and source references remain retrievable |
| `postCurrencyRemeasurement` | For measurement: exact source posting, all open items bound to that source and all their settlement allocations, absence of active unrealized result. For reversal: original result, absence of prior reversal and exact original generated journal; current and retained policy fields as used by the evaluator | One generated journal and result/reversal. Source carrying quantity and value use exact allocated-open-side totals, not payment-side totals; reverse exact original postings |
| `createAllocationSchedule` | Selected allocation policy, unused schedule ID, exact original source posting/basis | Immutable schedule only; installments/usage input have their own bounds. Subsequent recognition uses the policy retained in the schedule |
| `recognizeScheduledAllocation` | Exact schedule/installment and retained policy; applicable supersession; absence of recognition by both ID and `(schedule, ordinal)` | Journal and recognition; zero-valued/fully allocated edge behavior remains the kernel's rule, not inferred from a balance cache |
| `reviseAllocationSchedule` | Original schedule/source, **complete exact prior recognition-ID set** and installment amounts/dates, absence of prior revision, selected prospective policy, successor-ID absence where applicable | Immutable revision plus optional successor, adjustment journal and disposal completion journal. A recognized-total scalar alone cannot validate supplied prior IDs or missed earlier installments |
| `postTaxedTransaction` | Selected complete tax policies and artifacts; permanent determination/journal/posting identity checks | One resolved multi-line journal plus determination. Calculation is request-local, but rounding groups span the complete transaction; current 100-line bound cannot be bypassed by independent page calculations |
| `compileConsolidation` | Selected complete consolidation policy/artifacts; supplied pinned source observations/ownership/valuation evidence; permanent compilation/journal/posting identity checks | Compilation and generated journal; no implicit access to or write transaction across source books. Large input population needs a reviewed pinned calculation, not silent source omission |

### Lot operation and reporting cross-cuts

`prepareLotState` currently copies every lot, holding and allocation and hashes the
complete resulting arrays. Semantic dependencies are narrower but not uniformly
point reads: acquisition needs unused lot/holding IDs; disposal needs every selected
holding and its lot plus permanent allocation-ID absence; transfer also reads the
complete destination-account holding population before preserving/coalescing lot
identity, plus book-wide permanent identity absence for every newly created
destination. Destination-account absence is insufficient: source IDs, IDs in other
accounts, depleted IDs, and earlier same-command acquisitions cannot be reused.
Continuity requires distinct source/destination accounts; the two result populations
must not alias. Operations within one command see earlier operations' changes. Retained
allocation references and drained holdings remain audit evidence.

The lot-operation overlay must also track consumed journal posting IDs. Every
acquisition/disposal uses one distinct posting and a transfer uses two; the same
posting cannot fund a second effect. Selected source holdings must match the
canonical posting's book/account/commodity, with destination commodity continuity.
Supplied transfer basis annotations must equal the allocated historical basis with
the appropriate sign. Do not substitute quantized book value for historical basis
or erase separate valuation allowance. These are accounting checks, not properties
that an authenticated identity lookup establishes by itself.

Inventory costing layer inputs still express historical basis. For journal
measurement, each selected holding additionally supplies its authenticated current
valuation allowance and quantity: the consumed allowance is proportional to the
allocated quantity. The generated inventory/expense amounts use carrying value;
cost-basis annotations remain historical basis. Therefore `readInventoryCostFacts`
alone is not a complete issuance read set; selected full holding rows are required.
An acquisition cannot introduce a positive allowance, negative carrying amount,
or an incoherent basis-plus-allowance total. Historical issue validation recomputes
the generated journal, including its governed quantization and dimensions.

The current reader now resolves point identities for lots/holdings/allocations.
For this legacy profile, acquisition appends positions, disposal/transfer replaces
existing holding positions (appending only new destinations), and inventory value
adjustment maps the existing positions. The first-creation snapshot therefore
provides a position, **not a current value**: the reader authenticates that position
from the current catalog and rechecks raw identity. This is not a complete pool or
destination-holding range, and a future reordered/deleted-row profile needs an
explicit current-ID mapping. See the [lot-lookup review](design-review.md#pinned-current-lot-identity-reads).

The first closed grouped-query predicates are holdings by lot (including depleted),
holdings by account (including depleted, as transfer destination selection requires),
nonzero holdings by account/commodity (inventory costing), and recognitions by
schedule (complete historical recognition population). Membership uses canonical
insertion ordinals, not hash ordering of raw IDs. The projection and conditional
membership deltas are implemented with independent full-state comparisons; bounded
authenticated logical range pages are also implemented. The opt-in owner now
publishes a durable companion group directory in the canonical/source/identity
transaction, with full canonical rebuild comparison before readiness. Its new
owner marker rejects older row-only and four-group owners; source-catalog v1 bytes and financial
commitments remain unchanged. Owner-issued forward-only cursors now deliver ordered,
source-verified member pages with count and canonical-row-byte limits. They share
the owner queue, live pin and both captured catalogs; raw predicates are rechecked.
An exhausted cursor proves traversal, not that an external consumer used every
page: complete command read-set assembly/evaluation remains open. See the
[grouped-read review](design-review.md#pinned-source-verified-semantic-group-reads) and the
[group-catalog review](design-review.md#atomic-semantic-group-companion-catalog).

The admission profile adds transitions by period, unrealized results by policy ID
and reversals by original result ID. These are immutable-history groups: reversing
a result does not delete it from its unrealized group. Current-policy flags are
resolved during the read, so configuration replacement cannot leave a stale
reversal-required marker. Period closure is the last matching transition's kind;
superseding a close package for a later period does not itself reopen that period.

`projectAccountingBasis` is outside the command union but inside the accounting
foundation. It currently validates contiguous complete journals through the posting
cutoff, the entire accounting-effect snapshot, configuration/policy membership,
exact source posting references and one-to-one classification of the pinned source
population. Settlement-ratio treatment additionally requires the complete matching
allocation-ID set and settlement graph. The 10k-event guard is not permission to
produce a partial report. A paged replacement must prove population completion and
preserve exact total/residual and deterministic ordering semantics before publication.

## Prospective inventory posted-carrying ownership

Status: typed prospective ownership model and tested arithmetic, **not an
executable inventory profile**. ACC-039.7/8/9 are explicitly design-pending in
the semantic trace manifest and block its completeness gate. The existing
fractional-issue defect and legacy conversion remain open. No current command,
row codec, policy discriminator or state hash has been switched to this design.

The source of truth for posted carrying value must be actual canonical inventory
postings attributed to a holding, not a fresh quantization of its exact remaining
basis plus allowance. Two acquisitions with exact cost 0.015 and booked cost 0.02
each illustrate the difference: their posted budget is 0.04, while independently
quantizing the combined exact cost 0.03 produces 0.03. A transfer or coalescing
operation must not lose that already-booked cent.
This is an aggregate-value illustration, not permission to merge distinct lots:
different acquisition lot IDs retain separate holdings. Actual coalescing requires
the same stable lot as well as matching account, currency and dimension coordinates.

| Candidate | Consequence | Decision |
| --- | --- | --- |
| Round each exact issue independently | Three issues of 8/3 post 8.01 in total | Reject as the completion rule |
| Reconstruct posted carrying value as Q(current exact carrying) | Can erase or invent a cent after acquisition/coalescing; does not prove old postings | Reject as a source of authority |
| Set every account balance to Q(its aggregate exact inventory) after each command | Couples unrelated holdings and document postings; requires complete account/dimension population and explicit adjustment ownership | Not the selected holding-local design |
| Carry an authenticated posted budget with each holding and consume it cumulatively | Preserves original postings and permits bounded touched-holding reads; requires explicit anchors and transitions | Selected prospective direction |

### Minimal state and arithmetic

An immutable posted-carrying anchor must bind the book, holding, account, units
commodity, functional commodity, canonical dimension selection, positive anchor
quantity, nonnegative **posted** carrying budget P, complete quantization policy,
creating financial effect/ordinal and predecessor transition. An active projection
needs only that anchor identity, cumulative consumed quantity and its verified
cumulative posted consumption; immutable movements remain audit history. Existing
exact lot basis and allowance remain separate and are not derived from P.

For a fixed anchor quantity Q0 and cumulative consumed quantities c0 <= c1 <= Q0,
use fractions f0=c0/Q0 and f1=c1/Q0. The posted reduction is
`Qpolicy(P*f1) - Qpolicy(P*f0)`. With P already representable in the pinned policy,
complete depletion consumes P exactly. The exact economic quantity, basis and
allowance allocation remains separately recorded, along with its difference from
the posted amount. This difference is not falsely represented as the residual of
independently rounding that economic allocation.

`quantizeCumulativePostedShare` implements only this arithmetic. It rejects
negative/unrepresentable budgets, unsupported rounding modes/scales, and fractions
outside their monotonic [0,1] domain. It copies the policy into immutable output.
It does not establish source authenticity, sequencing, accounting admission,
idempotency, dimensions, or an inventory-policy opt-in. The SysML
`CumulativePostedShare` item has the same explicit boundary.

The typed model separates three artifacts:

- `InventoryPostedAnchor`: immutable ownership epoch with complete coordinate,
  positive quantity, actual nonnegative posted budget, full quantization policy,
  inventory-policy hash, creating origin and complete predecessor/source references.
- `InventoryPostedPosition`: current keyed projection containing its anchor
  reference, cumulative consumed quantity/posted amount, and creating movement's
  origin locator. Remaining quantity and posted amount are derived, not additional
  independently writable balances. A depleted position retains its original
  positive-quantity anchor; no zero-quantity anchor is created.
- `InventoryPostedMovement`: immutable canonical after-image and before-position
  reference, exact allocation, accounting date/period, cumulative proof and signed
  posted amount. It is an abstract base with distinct journal-linked and
  quantity-only variants. The latter cannot contain a fabricated posting reference.

Anchors and movements are immutable logical rows; positions are derived keyed rows.
An `InventoryOwnershipEffect` contains the complete **touched set**, not copies of
the entire holding or movement population. Full snapshot collections in SysML
describe logical state, not permission to rewrite complete arrays on each command.
Each immutable reference includes a stable ID, full hash, book and creating effect/
ordinal/revision locator. Required current rows and anchors need authenticated point
lookups; costing and coalescing still require complete groups. Fan-in populations
and encoded artifact sizes remain bounded; overflow fails the whole command rather
than truncating source evidence. Large workflows require the existing separately
designed atomic job mechanism, not hidden partial commits.

The runtime now defines the anchor, coordinate, position and bounded reference
types in `inventory-ownership.ts`. `prepareInventoryPostedReduction` checks one
already-selected exact allocation against a supplied holding and its cumulative
posted position, returning immutable before/after data, a signed posted reduction
and the separate economic difference. It checks full artifact hashes, matching
coordinates, bounded source populations, reference structure/order, representable
budget and the cumulative consumption equation. It uses the historical pinned
quantizer, never the current exact carrying amount as a replacement posted budget.
Its hash functions do not authenticate sources or authorize creation/adoption.

This planner is **not yet called by `BookCommand`**. Its `monetaryKind` classifies
the later assembly obligation; a `journalLinked` reduction does not yet contain a
posting reference, and neither classification is a committed movement. Complete
source attribution, current-position origin resolution, costing-method selection,
period/authorization/identity/CAS checks, actual journal linkage, ownership effects,
strict codecs, projection and replay remain required. Foreign-basis holdings are
rejected here rather than treating their economic allocations as functional money;
the governed valuation path for those allocations remains to be implemented.
ACC-039.7/8/9 remain release-blocking design-pending requirements.

`prepareInventoryPostedReductionGroup` now recomputes the complete supplied
operation group's reductions and constructs hash-bound journal-linked or
quantity-only movement variants. It sorts members by canonical holding ID, assigns
their origin ordinals, checks distinct local identities and one posting coordinate,
and verifies the real inventory posting's command/revision/date/period, journal
hash, signed money, units, historical basis and dimension set. Shared posting money
equals the sum of individual shares, not each share independently. Posting units
and historical basis include **all** members, including zero-money ones; only
nonzero members carry the actual canonical posting reference. An all-zero group
forbids that inventory posting link, but does not imply that other command effects
need no journal. Foreign/opposite coordinates cannot cancel into one group.

This assembler is still outside `BookCommand`. A supplied journal hash is not
proof of durable existence or command authorization. The caller must admit the
journal, authenticate the historical positions/anchors, prove complete operation
membership, prevent a posting from being claimed by multiple groups and preserve
canonical operation order. The assembler does not itself establish those facts,
create an `InventoryOwnershipEffect`, persist a movement, or implement transfer-in.

`prepareInventoryReductionEffect` now assembles a reduction-only ownership effect
over complete supplied original touched rows and ordered operations. It prevents
cross-group posting/reference reuse, duplicate allocation/movement identities and
inconsistent same-ID journal sources. Original rows must predate the candidate
revision and are supplied once per holding; the constructor maintains an internal
holding/position overlay, so subsequent operations consume its computed after-images.
It assigns contiguous artifact ordinals across groups and retains both monetary
and quantity-only movement arrays in the effect hash. Final holding/position
projections are returned separately in canonical holding-ID order. A failure
returns no partial effect and does not mutate the supplied original rows.

This producer creates no new anchors and supports neither same-command source
adoption nor inbound/value-adjustment transitions. Its local identity checks do
not prove fresh IDs against the book's complete historical populations, and an
exact touched set is not proof of complete costing selection. Source authentication,
policy/period/authorization admission and durable publication are not responsibilities
of this reduction-only helper. The new full-state command evaluator supplies policy,
period and canonical state/codec/replay integration for acquisition and issue, and the
internal indexed owner publishes those complete revisions. Indexed admission read sets
and the other ownership transitions remain open. A constructed helper effect alone
is not a committed accounting transition.

The standalone ownership artifact codec now covers anchors, positions, reduction
movements and reduction-only effects. Its versioned envelope shares the existing
exact-value encoding, caps the complete UTF-8 packet at 1 MiB, rejects unknown
fields and noncanonical bytes, and checks full content hashes and intrinsic
arithmetic/reference relationships. Decoded records are immutable. Reduction
effect decoding checks contiguous ordinals and internal after-position chains;
quantity-only records cannot carry a posting reference.

This closes transport validation for these four prospective artifact families,
not canonical persistence or source authentication. A self-consistent packet can
still name a nonexistent historical predecessor or omit an operation from the
real command. Referenced source lookup, complete command replay and accounting
admission remain mandatory. Canonical command integration now carries ownership
effects in revision/outcome rows and verifies their optional BookState projection;
the standalone envelope supplies none of that authority. ACC-039.7/8/9 remain pending.

`InventoryOwnershipReadContext` now specifies the trusted, pinned original-source
reads needed by reduction evaluation. `resolveInventoryOwnershipSources` obtains
each current holding and position, the exact referenced anchor, and the immutable
origin after-image. It compares the complete position to that after-image and
reconciles quantity, economic balances and cumulative posted consumption against
the anchor. It retains depleted rows, including their zero economic balances, and
supports positive-quantity free inventory. Distinct touched IDs and combined source
work are bounded; output copies are immutable and canonically ordered.

`prepareInventoryReductionEffectFromReadContext` derives the touched ID set from
the supplied canonical operations, snapshots the candidate before callbacks, and
feeds those resolved originals into the sequential whole-effect constructor. Head
checks surround reads and follow evaluation. Storage failures and stale-head errors
propagate rather than becoming retained accounting rejections. Later publication
must still use the same head and CAS; returned data is not a publication capability.

The context is an internal storage contract, not client authority. Its storage
implementation must authenticate current projections and exact origin membership
at the pinned head, including outcome-only changes. Contract-double tests are not
that implementation. The full-state command adapter now supplies replay-verified
sources, and typed indexed origin reads authenticate stored acquisition records.
Indexed latest-position and original policy-pool readers now exist separately;
they must still be composed with the complete command read set, managed scopes and
same-command overlay before this contract can replace full-state admission. An
origin read alone is not complete costing selection, policy admission or replay.

`prepareInventoryPostedAcquisitionGroup` now creates prospective first anchors
and acquisition origin movements for a complete new-lot posting group. All members
share one inventory coordinate. Their actual source posting's money is apportioned
by cumulative exact carrying-value weights in canonical holding-ID order; its full
quantity and historical basis must match the group. A zero carrying-weight member
gets zero money. Positive money with no carrying weight is rejected as ambiguous.
No-posting groups require explicit source evidence and a zero quantized aggregate
carrying target; all-zero carrying uses quantity weights for deterministic zero
proofs. This includes free inventory and nonzero exact costs that round to zero.

Each first anchor has the assigned posted budget, full policy and evidence; its
origin after-position starts with zero consumption. Anchors precede movements,
with both phases ordered by holding ID. Every movement retains the common-total
acquisition proof. Quantity-only members have no movement posting reference, but
their anchors can retain provenance from the real shared source posting. The
standalone artifact codec now covers acquisition movements and checks their closed
shape, full hashes, zero initial consumption, origins and cumulative arithmetic.

These helper outputs are candidates, not independently admitted commands.
Evidence authorization, prospective policy/capability admission, permanent-ID
absence and complete command membership remain caller obligations. Acquisition
and reduction journals in the original helper lifecycle test commit through the real
evaluator, while that test's ownership origins use a trusted read-contract double.
Separate canonical-command and indexed-owner tests now cover atomic acquisition/issue
ownership, original source authentication and replay. Transfer-in/coalescing,
adjustment/reanchoring, legacy adoption and complete indexed admission remain open.
The old command profile and historical bytes remain unchanged.

`prepareInventoryOwnershipEffect` now assembles acquisitions and reductions into
one candidate with one artifact sequence, cross-kind posting/reference claims,
consistent journal sources and unique local identities. New anchors and rows are
constructed in operation order, so later reductions consume internally produced
positions rather than caller overlays. Original sources must predate the revision
and be used. A failure returns no ownership effect, new lots or partial projections.
New lots and final holdings are separate returned data: they must enter the same
complete BookCommitIntent as the immutable ownership effect, not be inferred from
its hash or discarded because the final holding is depleted.

`prepareInventoryOwnershipEffectFromReadContext` resolves external originals only;
earlier acquisitions supply local successors. Reversing the operation order cannot
turn a future creation into an existing source. Source-free acquisitions still
require live-head checks and fresh permanent-ID admission outside this helper.
The reduction-only APIs delegate to the shared engine while retaining their old
result and codec shapes and rejecting acquisition operations.

The standalone `ownershipEffect` codec checks mixed artifact ordering, complete
new-anchor/origin linkage, same-command position chains, quantities and budgets,
and rejects orphan anchors, gaps and mismatched monetary variants. It still cannot
authenticate external source history or prove complete command membership. The
separate canonical acquisition/issue command and indexed owner supply admission,
durability and replay; the candidate/transport implementation alone does not.
Incoming transfer, reanchoring/adoption and complete indexed admission remain open.

`prepareInventoryOwnershipSelection` now derives selected quantities and exact
economic allocations from a supplied complete canonical policy pool. It invokes
the existing costing-method calculator with layers built from canonical holdings
and lots, validates policy applicability/capability and matching derivation metadata,
checks nested pool hashes and exact selected identity coverage, and returns a
full-content policy reference. It accepts no caller-supplied allocation amounts.
Weighted-average selection retains each source's own proportional basis and
allowance while preserving the computed aggregate basis. Free live holdings and
depleted rows are distinguished; provisional shortages remain explicit separate
quantity/basis results, not invented ordinary ownership.

The pool and policy inputs are trusted read-side data. The compiler cannot prove
their completeness or approval authority, fresh permanent IDs, historical
availability, or admissibility under the eventual cumulative command profile.
`hashAccountingPolicy` exposes the individual hash already used by the retained
policy snapshot; it does not change legacy snapshot hashes. Posted budgets still
come from ownership anchors and actual postings, not the exact costing result.
The prospective compiler currently supports costing algorithm 1.0.0 only and is
not a new canonical command or a change to the old costing calculator's semantics.

Chronological admission remains a distinct obligation. Beancount sorts entries
before booking (`loader.py:602`) and hledger's lot engine explicitly processes
transactions in date order (`Lots.hs:9`). Rastrata's append-only book order cannot
borrow that behavior by silently rewriting old outcomes. Complete backdated
inventory workflows need explicit chronology/availability, provisional recosting
or restatement treatment before the prospective command profile can be enabled.
The current-pool compiler is not an as-of inventory reconstruction.

**Hash construction must be acyclic.** A movement contains its after-position, so
that position cannot contain the movement's hash. It contains only the movement's
origin identity/locator. Position source verification resolves the authenticated
effect at that origin and compares the complete after-image; the locator is not
proof of authenticity. The position's own hash binds the locator, anchor reference
and cumulative counters. Hash dependencies proceed from actual journal sources
to outgoing reductions, then successor anchors and incoming positions/movements,
then the enclosing effect. A predecessor reference points to an already finalized
position. Same-command dependencies follow finalized artifact order; forward or
cyclic references reject. This avoids both hash fixed points and recursively
embedded histories whose size grows with the book's lifetime.

### Required atomic transitions

| Operation | Posted-carrying requirement | Minimum authenticated read/evidence |
| --- | --- | --- |
| Acquisition | Attribute actual booked inventory amounts to new holding budgets; never infer them from exact basis alone. Multiple allocations must conserve the complete source posting, not consume it twice | New permanent IDs, canonical acquisition posting, quantity/basis/allowance, coordinate and complete attribution set |
| Partial disposal | Consume cumulative shares from each selected anchor; actual inventory credits and expense debits must match those shares. A selected holding's remaining posted budget cannot become negative | Selected current holdings, anchors and consumption positions; complete selected-cost population remains a separate costing dependency |
| Full disposal | Consume every remaining posted unit of each depleted holding; verify resulting financial posting rather than only a zero exact holding | Same bounded source set plus complete allocation/journal linkage |
| Transfer | Move exactly the source's consumed posted amount to the destination, with opposite journal signs; no independent destination rerounding and no unexplained transfer gain/loss | Selected source anchors and destination coordinate/identity evidence; complete applicable coalescing population |
| Coalescing | Close predecessor ownership and start a successor anchor with the sum of actual remaining/incoming posted budgets and quantities; preserve predecessor lineage | Existing destination anchor/current balance and same-command transferred budget; account/commodity/dimension/policy compatibility |
| Value adjustment | Attribute actual signed posted adjustment across affected remaining and recognized-cost destinations; re-anchor only after proving before/after quantities, budgets and journals. Complete write-down must explicitly extinguish any posted balance. Partial changes may not silently redistribute an external source posting | Governed policy and source, complete supplied allocation set, touched anchors and actual posted amounts; rounding disposition must be explicit |
| Correction or policy change | Append a governed transition/reversal of original posted effects; never overwrite anchors or reround their history under the active policy | Original effects and exact posted coordinates, current anchors and closed-period authority |

The dimension coordinate is essential: current holdings are account-scoped and
must not start coalescing postings with different canonical dimension selections
under this new design. A destination requiring another coordinate needs distinct
ownership. Canonical ordering, not locale collation or map insertion order, governs
allocation of any aggregate source budget. Zero exact-cost live holdings are valid
only with an independently coherent posted budget; zero quantity cannot retain an
unexplained posted amount. Existing contradictory zero-basis admission behavior
still needs its compatibility review.

**Zero-posted quantity movement is a required command topology, not an optional
edge case.** The current ACC-018 canonical journal validator rejects every
zero-book-value posting. A 0.01 budget consumed in three equal quantities under
half-even produces posted reductions 0.00, 0.01, 0.00. Thus even terminal depletion
can require a physical/exact-cost reduction with no new money posting. The new
inventory profile must admit an explicit quantity/ownership-only effect when its
verified cumulative share is zero. It must advance the lot allocation and financial
revision, retain source-anchor and before/after position evidence, apply ordinary
period/authorization/identity/CAS checks, retain its outcome and replay identically,
without advancing journal posting sequence or emitting dummy zero postings. A
mixed batch must publish its nonzero journal and all zero/nonzero lot movements
atomically. A transfer with a zero posted share still transfers quantity and exact
basis/allowance and establishes or coalesces the destination's ownership. These
topologies must be designed and tested before enabling the profile; allowing zero
postings globally or manufacturing a cent is not an acceptable workaround.

| Admitted transition | Retained outcome sequence | Financial revision | Journal posting sequence |
| --- | --- | --- | --- |
| Quantity-only inventory change | +1 | +1 | unchanged |
| One journal with zero/nonzero inventory movements | +1 | +1 | +1 for the journal, not per movement |
| Rejected request | +1 when retention policy admits the rejection | unchanged | unchanged |
| Retry of a retained command | unchanged | unchanged | unchanged |

These are normative contracts, not implemented zero-posted-command test results.
Only the absence of **every nonzero coordinate posting** permits journal omission.
A transfer's negative and positive postings always sum to zero; that sum is not
permission to omit its journal. Do not cancel across accounts or dimensions.
Generated posting ordinal selections apply only to real journal postings; zero
movements obtain their dimension coordinate from admitted ownership/source data.
Inventory historical reads and close/reopen evidence must use financial revision
and movement accounting date, not journal sequence alone: two inventory states can
share a journal sequence while having different physical quantities.

Seven exact examples are maintained in
`packages/kernel/spec/inventory-posted-transition-examples.json`. Their dedicated
test invokes the production cumulative-share primitive to verify the declared
amounts, cumulative positions, remaining quantities and separate economic
differences. They explicitly remain `prospective-design-not-command-executable`:
the test does not authenticate source postings, emit journals, commit inventory
effects, validate authorization/periods, or demonstrate storage/restart behavior.
It must be supplemented by canonical command executors before these requirements
can leave the design-pending disposition.

The legacy journal-linked path now rejects reversed acquisition/disposal posted
signs and continuity transfers whose signed source/destination book values do not
conserve exactly. This repairs admitted invalid postings, not cumulative costing:
equal transfer amounts can still be disconnected from a holding's correct posted
budget, and fractional disposal rounding remains unresolved. Previously committed
counterexamples are preserved as bytes and fail semantic recovery; the runtime
does not overwrite their committed receipts with newly evaluated rejections.

### Legacy and completion gates

An explicit future policy discriminator and supported implementation version are
required before any of these transitions becomes executable. A version string
alone must not opt old holdings in. A legacy bridge must verify original posted
source and all attributed movements through a pinned revision. It must detect
missing attribution, conflicting dimensions, depleted holdings with remaining
posted balances, unsupported corrections and policy changes. A scalar assertion
or Q(exact remaining value) is insufficient. An existing -0.01 residual needs a
separately authorized, append-only reconciliation, not an anchor initialized to
zero to hide the discrepancy.

Still required before enabling the new profile: runtime anchor/movement
types, effects and codecs; concrete quantity-only and mixed command payloads and
topology; per-kind adjustment/reconciliation rules including partial
write-down and external source-budget rounding; all command admission/topology
checks; cold/restart replay; indexed identity/range access and atomic publication;
closed-period handling; legacy adoption evidence; fault tests; and complete
acquisition/transfer/coalescing/adjustment/depletion workflows under all admitted
cost methods. The arithmetic helper and green legacy characterization are not
evidence that these integration gates have been passed.

### Executable read-only attribution audit

`ProductionLedger.auditInventoryPostedBalances(encodedWitness?)` audits a fully
recovered snapshot and returns its exact scope/head and domain-separated source
hash with one of three dispositions:

- `attributed`: every processed holding movement has a unique canonical posting
  attribution, with signed actual amounts, posting hashes, financial revisions,
  effect keys, quantization-policy hashes and holding coordinates. No historical
  amount is reconstructed by rounding the current exact holding value.
- `proposedAttribution`: an explicit validated allocation proposal was needed or
  supplied. Its normalized hash and per-movement canonical/proposed provenance
  accompany the balances. This is not a claim about an undocumented historical
  allocation rule and does not promote proposed shares into canonical history.
- `requiresReview`: missing/ambiguous source attribution, coordinate conflicts,
  transfer value/sign mismatches, relevant unsupported corrections, unclassified
  postings in tracked accounts, negative posted balances, or depleted/zero-carrying
  residuals; movements before the lot's acquisition instant; or negative economic
  quantity prefixes. No usable balance/movement set is returned, even if other holdings
  were individually attributable.

`requiresReview` does not necessarily mean the original business transaction was
invalid. A legitimate multi-lot disposal can lack a unique historical per-holding
decimal allocation; other legitimate non-inventory postings may share a tracked
account. These need an explicit attribution/reconciliation witness, not guessed
amounts. Conversely, `attributed` is not a valuation opinion, policy opt-in, migration
eligibility decision, or authority to post a correction.

The audit checks touched holding balances at completed revisions as well as at
the final head, so later activity cannot hide an earlier depleted residual. It
also derives quantity changes from canonical acquisitions and disposal/transfer
allocations, then inspects each holding in economic-instant order, breaking ties
by financial revision and netting same-journal changes atomically. UTC offsets
and all supplied fractional-second digits are preserved when ordering instants;
millisecond truncation must not turn an earlier issue into an equal-time event. A
`negative_economic_quantity` finding identifies the holding, offending revision
and exact negative **quantity**, not money. `movement_precedes_lot_acquisition`
identifies a movement earlier than its canonical lot's acquisition instant.
Late-entered receipts/transfers can cover issues when economically earlier;
future inflows cannot conceal an earlier shortage. This read-only ordering does
not change commit order, journal bytes or receipts, recalculate costing, certify
as-of valuation, or enable prospective backdated inventory admission. These are
additional necessary checks, not sufficient evidence for automatic adoption.
The audit
uses the normal full recovery path and writes no outcomes, anchors or policies.
It is historical at its returned head; a concurrent publication does not mutate
that snapshot or turn the report into evidence at the later head. The method is
trusted in-process API like `read()`; no public HTTP route or new authorization
surface has been deployed. The full-history legacy bounds still apply, and this
is not the scalable indexed bridge or the cumulative-policy implementation.

The optional UTF-8 JSON envelope has exactly `version`, `sourceHash` and `postings`
fields. Version `legacy-inventory-posted-attribution-v1` accepts at most 1 MiB and
10,000 total shares. Each posting has exactly `postingId`, `postingHash`, `shares`;
each share has exactly `holdingId`, `postedAmount` (a canonical decimal string).
Posting IDs and holding IDs within each posting must be unique. Complete hash
algorithm/version/digest fields are validated. The envelope is decoded, copied
and frozen before ledger I/O; malformed input is not treated as absent evidence.

`sourceHash` binds domain `rastrata-inventory-posted-audit-source-v1`, the complete
recovered scope and durable head, including outcome sequence, rejection history
and compact storage namespace/generation. `postingHash` binds the actual canonical
posting. Eligible holdings and exact weights are obtained from canonical disposal
allocations or same-sign inventory value-adjustment allocations, never from the
proposal. For absolute posted total P, use canonical holding-ID order and
differences of Q(P*cumulativeWeight/totalWeight), restoring the posting sign.
The full historical quantization policy is resolved by its content hash; the
current policy cannot reround old amounts. Every supplied share must equal this
result, be representable under that policy, and conserve the actual posted total.
Zero-weight multi-holding groups with nonzero posted totals remain unresolved.

Transfers move the opposite of each accepted source share to that source lot's
destination, including coalescing. Destination IDs cannot change the distribution
of pennies. Optional destination rows must match the inherited amounts exactly.
Mixed-sign changes hidden in a net value-adjustment posting remain unresolved;
this version does not invent gross posting movements. Unused witness rows, wrong
hashes, stale heads, missing/extra holdings or inconsistent shares require review
and suppress all usable balances/movements. Witness hashes normalize row/share
order and decimal numeric values; they identify proposals, not signatures or
approval. Corrections, unclassified account activity, legacy conversion and
cumulative inventory command integration remain separate open work.

## Integrity and representation requirements before implementation

- **One authenticated context:** bind identity/generation, complete durable head,
  configuration, representation/codec version and relevant index roots. Do not mix
  rows from different heads, restored generations or selected-but-unpublished state.
- **Presence is not completeness:** a content hash proves a fetched record's bytes,
  not that a missing record never existed. A plain SQL `NOT EXISTS` or an R2 404
  cannot establish permanent ID availability under the modeled missing-row faults.
  Design authenticated non-membership or a comparably verified complete index.
  The [implemented pinned lookup primitive](design-review.md#authenticated-point-and-absence-lookups)
  now verifies paths for membership and absence after canonical-population audit.
  Its positive result remains a key/Oseq locator. The current indexed SQLite owner
  performs raw-identity resolution and atomic maintenance on the bounded accounting
  path; source hits now use a complete-record-checked targeted SQL fetch. The
  expected source hash still comes from fully verified history in memory, not a
  scalable locator commitment. See the [source evidence](design-review.md#bounded-canonical-source-fetch-and-late-corruption).
- **Range completeness:** predicates such as an empty overdue-FX range, exhausted
  lot, complete schedule recognition set and current close set need verified query
  boundaries/population. Checking hashes on returned rows alone permits omission.
  Preserve the kernel's ordering, not incidental SQL or object-list order.
  Authenticated half-open hash-key range traversal is now implemented in
  `scanIndexRange`, with a pinned two-partition merge in `scanKeys`. It verifies
  every required subtree and only reports completion after exhaustion; partial
  batches/cancellation are not complete sets. This is not an accounting predicate
  schema: account/date/lot/recognition key layouts, atomic secondary-index upkeep,
  raw-source resolution and resumable computation still need their own design.
  See the [range evidence](design-review.md#authenticated-range-traversal).
- **Exact derived state:** summaries must be deterministic folds of immutable
  effects, have no independent accounting authority, and update in the same local
  publication transaction as canonical locators/head. Reject underflow, duplicate
  application and inconsistent before-values. Test rebuild from genesis and from a
  verified checkpoint against independent exact expected values.
- **Availability of evidence:** removing exhausted items from a hot query is not
  deleting their identity or source. Missing required archived evidence makes the
  operation unavailable; it cannot become a retained accounting rejection claiming
  that a source never existed. The public ledger must classify this boundary before
  invoking a semantic evaluator that assumes complete inputs.
- **No unreviewed trust downgrade:** changing full startup replay to lazy verified
  reads changes the detection point for untouched historical corruption. The current
  PL-007/PL-008 design still requires complete recovery verification before readiness.
  Propose the new threat/detection contract explicitly, with negative controls and
  an independently anchored expected head; do not quietly bypass that requirement
  to meet a restart timer. Periodic audit alone is not an equivalent guarantee.
- **Count the entire index:** command IDs, journal IDs, posting IDs, every accounting
  effect family's identities, lot/holding/allocation identities, secondary predicates,
  integrity nodes, checkpoint metadata and current-state rows all consume storage.
  The measured command-locator experiment does not include these. The production
  layout must earn its capacity/performance claim with this full inventory, including
  posting count and long IDs—not just one small row per outcome.

Do not select a custom authenticated tree merely because it sounds scalable.
G1 still needs a bounded layout trade study measuring write amplification, full
index bytes, authenticated point/absence/range reads and checkpoint/startup costs.
The selected mechanism must fit the first-principles workload and fault contract;
if it does not, reopen placement or recovery assumptions explicitly.

## Hash and historical compatibility boundary

Current `hashBookState` commits complete accounting state, all lot arrays, journal
effects, corrections, transitions, closes and configuration snapshot history.
`LotStateEffect` itself contains full arrays; `LedgerCutoff` contains the ordered
journal-hash list. Replacing these with tree roots changes canonical bytes; changing
an effect's encoding also changes its intent/revision hashes, while changing a state
hash affects snapshots and records that bind that hash. Appending a hash to the old
digest does not reproduce the old hash function.

The [buffered canonical-hash improvement](design-review.md#byte-preserving-buffered-canonical-hashing)
preserves the old hash function's bytes and reduces temporary sink allocation. It
does not make whole-state hashing incremental or discharge the indexed-context
and representation-transition requirements below.

The design must specify explicit representation/hash identities and an authenticated
transition at an exact old full head. Keep original old commands/results/hashes and
their supported decoder/verifier; derive new indexes without rewriting old records.
Different storage encoding does not authorize different money, policies or rejection
semantics. Any semantic repair needs its own applicability/version decision and
mixed-history tests. An old rejected retry must still return its original rejection,
even when a new command could be accepted under a repaired implementation.

### Indexed representation boundary

Design decision, not an enabled runtime format: indexed execution needs its own
state/effect/intent/revision/receipt commitment profile. It is **not** a transparent
replacement of `hashBookState`, and the existing compact format must not acquire
new meanings under its current version identifier. Legacy snapshot and compact
books keep their original evaluator, codecs and exact results. The first indexed
implementation should be explicitly selected for new books; existing-book adoption
remains disabled until the bridge procedure below is implemented and verified.
This is a representation change, not permission to alter accounting policies.

The new profile must specify these commitments together before wire-format freeze:

| Commitment | Complete preimage / obligation |
| --- | --- |
| Profile identity | State layout, collection key/order schemas, row codec, effect/intent/revision codecs, hash and canonicalization identifiers, evaluator semantic profile. Unknown combinations fail closed. |
| State header | Full immutable financial identity and its hash, status, book revision, posting sequence, configuration revision/hash, active configuration reference, optional opening boundary, and the complete closed collection-root catalog. |
| Collection root | Immutable financial identity, profile, collection name, key/order schema, population and authenticated logical root. Empty is explicit. Physical location is authenticated by the storage view but is not financial identity: compaction cannot change accounting hashes. |
| Source row | Full canonical row bytes, collection, stable raw identity, canonical insertion ordinal and creating outcome/effect locator. The locator alone is not the row's content commitment. |
| Outcome / protocol | All retained commitments and rejections, exact command/result bytes or their complete validated commitments, Oseq, prior outcome commitment and explicit profile. An indexed ID lookup is an accelerator, not a replacement for retained outcome history. |
| Effect / intent / revision | Exact amounts and provenance plus expected prior and resulting logical state roots; book revision and financial revision chain remain distinct from Oseq. Collection deltas require complete expected-before values and atomic after-values, not caller-supplied trusted roots. |
| Pinned execution context | Full identity/generation, canonical head, profile, configuration and root catalog, plus live publication fence and verified presence/absence/range evidence. Rows and negative answers from different contexts cannot be combined. |

Logical roots must be independent of physical COW page allocation, hot/cold placement
and merge boundaries. Object ID, namespace, restore generation and publication fence
belong to the execution view, not the financial root's domain; relocation or restore
cannot change the economic commitment merely by changing those storage identities.
The execution view separately binds the financial root to its authorized current
tenant/book/generation. The existing permanent-ID `IndexRoot.contentHash` includes
physical page references and is therefore **not** a drop-in financial state root.
It can authenticate an execution view without defining accounting state identity.
A binary Patricia logical-map candidate now has independent-rebuild tests and
10,000-row in-memory measurements; see the
[candidate review](design-review.md#logical-map-candidate-and-measurements).
It is not selected as the production representation: physical packing, canonical
row projection in the production owner and indexed execution remain unimplemented. This table does not
claim incremental SHA-256 of the existing serialized arrays is possible.

The internal `outcome-source` candidate now recovers tagged legacy row bytes from
one already verified compact record. It verifies both the complete source commitment
(including before/after heads) and the separate collection/ordinal/row commitment.
Retained commit-intent hashes use the kernel's unchanged commitment function; they
cannot be reconstructed from payload bytes alone. Known ordinals use Oseq, book or
posting sequence, configuration revision plus one, or lot-snapshot position. Other
append ordinals must come from authenticated prior population, never a guessed Oseq.
This does not itself establish semantic index membership, a complete read set,
or a live pinned view. An opt-in owner storage profile now derives the complete
legacy projection (including genesis and headers), maintains row and locator roots,
and publishes those roots with canonical state under the existing transaction/CAS.
It still performs full projection and catalog/source audits, not bounded evaluation
or lazy recovery. The owner has no node reclamation or old-book adoption. See the
[evidence and limits](design-review.md#authenticated-outcome-row-resolution).
The [catalog publication review](design-review.md#atomic-source-catalog-publication)
records the storage profile, atomicity tests and remaining production boundary.
The separate indexed source path now uses the same private tagged-wire mapper
after validating the new indexed outcome/head chain and an independently supplied
source commitment. It reconstructs original retained commit-intent hashes from
the complete indexed counters/configuration hash, not an invented compact head.
Row resolution checks the exact selector, positive uint64 ordinal and indexed
collection-domain/row commitment. All twenty effect families, empty replacement
semantics and unknown global append ordinals remain explicit. It does not establish
locator membership or a live pin; existing physical source catalogs still use the
compact profile and full legacy projection. This prerequisite does not yet provide
atomic indexed source/index publication or a complete command read set.
`SqliteIndexedSourceCatalog` now implements the new-format source-catalog component:
prepare a new-book genesis or replay-verified row transition, preserve unchanged
origins, and atomically publish financial nodes, changed origins and all 24 locator
roots alongside the owner's canonical writes using a same-port transaction token.
The owner must pass an independently verified prior catalog commitment and complete
canonical anchor. Catalog CAS and post-write readback prevent stale/substituted
publication; no receipt or durability confirmation is issued by this component.
It uses separate versioned tables and is not yet adopted by a `BookStorageAdapter`.

Its owner-issued row captures verify both financial and locator paths, bounded
origin bytes, exact canonical source rows, current head/catalog and the owner's
live-pin confirmation. Unavailable sources cannot become absence. The canonical
source port must independently verify membership in the captured historical prefix.
New-book genesis input remains bounded at 16 MiB, catalog at 512 KiB, individual
nodes/origins at 2 KiB and staged node/origin work at 32 MiB (in addition to compiler
limits). These are operational limits, not demonstrated production capacity.
The real-SQLite tests use a synthetic canonical owner, not a complete production
adapter or a new process-crash/cold-recovery proof. Permanent-ID/group projection
integration, accounting admission, fence/CAS ownership, durability and complete
startup verification remain required before this path can serve business traffic.
The owner now exposes a lease-bound current-row reader only after full verification.
It checks financial and locator paths, bounded source bytes, independent row hashes,
and the captured catalog/head before delivering a row or proven absence. Publishing
a new head invalidates this context. The reader is not a stable historical report
snapshot or complete command read set; those remain required before
replacing materialized evaluation. A typed kernel subtree codec and `readTyped` now
reuse the existing aggregate schemas and immutable exact numeric classes after
source authentication. Shape decoding cannot substitute for a complete accounting
context. See the
[pinned-row evidence](design-review.md#pinned-current-row-access).
Its command-ID method reuses the permanent identity index's first Oseq and verifies
the retained row there. Both partitions must prove absence for an unused ID. It
does not generalize that first-creation locator to current lot/holding state or
accounting collection ordinals. Other semantic indexes remain open; see the
[command-lookup review](design-review.md#pinned-command-identity-reads).
The journal/posting method likewise uses first Oseq only to locate the committed
retained result. It follows that result's financial revision, selects one raw
identity among journal effects, and verifies the selected journal's independent
posting-sequence row. See the [journal-lookup review](design-review.md#pinned-journal-and-posting-identity-reads).

### Exhaustive current-state disposition

Source baseline: the current `BookState`, `BookProtocolState`,
`AccountingCanonicalState`, `hashBookState` and `applyEffects` definitions. Every
field must have exactly one canonical home; aliases must agree with that home.

| Existing fields | Indexed disposition and required semantics |
| --- | --- |
| `identity`, `financialIdentityHash`, `status`, `bookRevision`, `latestPostingSequence`, `configurationRevision`, `configurationHash` | Committed header fields; preserve all financial identity and independent counter rules. |
| `contentHash` | Old-profile verification only for old state. New state uses the explicitly different complete header/root commitment; never put new bytes under the old hash identity. |
| `configurationSnapshots` | Append-only ordered immutable configuration records, including genesis revision zero. Exact configuration membership and validity lookup remain required. |
| `activeConfigurationSnapshot` | Authenticated pointer to the exact active configuration record, not an independently writable duplicate. |
| `periods`, `admissionSnapshot`, `policies`, `quantizationPolicies`, `accountingPolicySnapshot` | Exact members of the active configuration. Do not omit them from validation simply because their parent hash is present. |
| `openingBoundary` | Explicitly absent before activation; then immutable source-bearing boundary. Its configuration and optional opening journal remain resolvable. |
| `lots`, `lotHoldings`, `lotAllocations` | Identity-addressed records with preserved insertion ordinals. Current `lotState` replaces complete arrays: do not assume these collections are append-only. New deltas must prove unchanged untouched records and exact changed/deleted/replaced rows. Exhausted live-query entries can disappear only while original identities and history remain available. |
| `journals`, `corrections`, `periodTransitions`, `closePackages`, `revisions` | Ordered immutable records. Preserve canonical insertion order, including multiple journals per command and historical close packages after reopening. Posting sequence, row count and revision count are not interchangeable. |
| `accountingState` | Closed catalog of the thirteen immutable ordered effect collections below; no unrecognized or missing family can silently become empty. |
| `protocol.retainedResults` | Ordered immutable retained command/result records, including rejections and original semantic profile. Exact old retry resolution precedes current-policy admission. |

The thirteen accounting collections are `provisionalInventoryLayers`,
`inventoryRecostings`, `inventoryValueAdjustments`, `openItems`, `settlements`,
`settlementAllocations`, `remeasurementResults`, `remeasurementReversals`,
`allocationSchedules`, `allocationRecognitions`, `allocationScheduleRevisions`,
`taxDeterminations` and `consolidationCompilations`. Recognition totals, open balances,
active lots, overdue FX obligations and latest schedule status are *derived query
state*, not mutable rewrites of those immutable effects.

The pinned `readAccountingIdentity` method now resolves those immutable source
effects by family/raw ID through both permanent identity partitions, the retained
committed result and its authenticated creating revision. It returns an explicit
source-revision row commitment rather than inventing the effect's collection
ordinal. This relies on fully verified append-only effect/population semantics;
it does not prove derived balances, recognition sets or lifecycle predicates.
See the [accounting-lookup review](design-review.md#pinned-immutable-accounting-identity-reads).

`src/logical-book.ts` now supplies a bounded reference projection of the exact
legacy tagged wire into 24 logical collections and separate header/state/protocol
commitments. Its field dispositions are exhaustive against the kernel's TypeScript
interfaces and runtime source fields. This is an old-content comparison oracle,
not the proposed new execution codec, a source-of-truth migration, or an authenticated
live context. See the [projection evidence](design-review.md#exact-legacy-accounting-projection).

This mapping also exposes two non-storage changes that must be designed before
indexed execution can be enabled: replacing full-array `LotStateEffect` with
authenticated conditional deltas, and replacing complete journal-hash lists in
close cutoffs with a population commitment plus a resumable, complete fold. These
changes propagate to intent/revision hashes and need the new profile. A large
command cannot publish intermediate journals or a partial close as a completed
financial revision merely to stay inside a request budget.

### Transition and acceptance sequence

1. Keep legacy books unchanged. For comparison, fully replay a bounded reference
   book under its original profile and capture its complete head and original bytes.
2. Rebuild *all* logical collections and all derived query indexes from that
   canonical state. Prove exact row identity/content/order/population agreement;
   testing only the currently requested accounts or nonempty collections is not enough.
3. Exercise the indexed evaluator at a pinned context against the original evaluator
   for all eighteen commands. Compare complete economic effects, diagnostics and
   chronology under an explicit field-by-field projection. Differences in new
   representation hashes are expected and must be accounted for, not removed by
   indiscriminately ignoring all hash/provenance fields. Unsupported or incomplete
   context is a service failure before semantic evaluation, never a fabricated
   accounting rejection.
4. Prove conditional row deltas and logical root updates produce the same projected
   state as independent full rebuild, including retained rejection-only advances.
   Race mutations in positive, negative and range dependencies; full-head/fence CAS
   must prevent stale publication. A valid proof for an omitted predicate is not a
   complete command read set.
5. Preserve old-profile receipts byte-for-byte. A future existing-book bridge must
   bind the exact old profile/head, new profile/root catalog, complete projection
   evidence and independent migration authority. Publish a separately versioned,
   durable representation boundary before admitting any new-profile command; do not
   silently change `stateHash` at an unchanged old head/Oseq. Interrupted or stale
   bridges leave the old representation authoritative, or quarantine an uncertain
   publication. Repeated bridge requests cannot create a second boundary.
6. Measure command I/O, hashing, memory and latency with fixed live populations and
   increasing retained history. Measure historical identity lookups and large folds
   separately. Full startup verification remains required until the owner approves
   a different corruption-detection contract; this design does not grant that approval.

Reference rationale: TigerBeetle's local `docs/internals/data_file.md` distinguishes
authenticated physical block pointers and atomically selected manifests; those are
storage authority, not a reason to reuse a physical page hash as an economic state
hash. Its `docs/internals/upgrades.md` retains version-specific executables across
upgrades. The applicable lesson here is explicit old-verifier availability, not
copying its deployment mechanism or fixed-scale accounting model. These reference
observations are design inputs, not evidence that Rastrata's new profile is implemented.

## Correctness finding and repair: unrelated inventory account

**G1-INV-01 — repaired under algorithm 1.0.1; targeted verification complete.**
The pre-repair behavior below remains executable only under its legacy algorithm
1.0.0 contract. `book.ts` passes all retained lots and holdings to
`calculateInventoryValueAdjustment`. The old `holdingPopulationValid`
requires **every** holding to use the selected policy's inventory account. Thus an
unrelated valid holding in another account prevents an otherwise valid adjustment.
The kernel SysML takes a complete book snapshot; it does not declare that a book
can have only one inventory account. This cannot be labeled an index optimization.

Pre-repair Bun 1.4.0 calculator experiment, same request/policies in each case:

| Input population | Observed production calculator output |
|---|---|
| Lot A: quantity 1, basis 10; holding A in `account-inventory`; add exact cost 1 to holding A | `draft`; inventory `+1/1`, adjustment account `-1/1` |
| Same, plus valid lot B/holding B of quantity 1, basis 10 in `account-other-inventory` | `rejected`; `inventory_value_adjustment_violation`, path `command.inventoryValueAdjustment` |
| Same two lots/holdings, but B uses `account-inventory` | `draft`; identical `+1/1`, `-1/1` postings |

The initial experiment directly called the production calculator with existing test
policy/evidence constructors. A subsequent book-level reproduction also completed:
create a configured book, activate, acquire lot A, then compare adding cost 1 with
and without acquiring lot B in the other inventory account. The one-account branch
commits and increases A's basis from `10/1` to `11/1`. The two-account branch reaches
revision 3 with two canonical acquisition journals and two holdings; its durable
encode/decode succeeds before attempting the adjustment. The adjustment is rejected
with the diagnostic above, leaves the complete financial state hash unchanged and
retains a fourth command result. Encoding/decoding again succeeds; an exact retry
replays the original rejection and complete result hash:

```text
algorithm: sha256
canonicalizationVersion: rastrata-canonical-v1
digest: bd43ade0477fab46033ed0172eb8a98f9e26c27d8f990871ee564a89c9a81e4b
```

The first book-level probe stopped on a harness comparison of null-prototype decoded
hash objects against ordinary objects. Repeating with comparison of their complete
hash fields passed all probe assertions; no kernel code or hash values were changed.
This is local kernel command/codec evidence, not a process crash or Cloudflare test.
It confirms a defect, not a passing production acceptance scenario.

The repair distinguishes globally valid holdings from policy-scoped **targets**, keeps
the complete cross-account holdings of an allocated lot when deciding fully disposed
status, rejects a target in the wrong account, and leaves unrelated holdings unchanged.
Filtering the entire input by policy account is unsafe: it can make a transferred,
still-live lot appear fully disposed. These cases are now executable tests, including
no-mutation-on-rejection, exact results for all five adjustment kinds, and replay.

### Version decision and repair evidence

Use exported `INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION` (`1.0.1`) for new
value-adjustment policies, with a matching capability implementation version. Existing
books adopt it through an ordinary prospective `replaceConfiguration` command and a
new policy version. Nothing changes financial identity, the command protocol or the
durable codec; no account is silently migrated. Explicit algorithm `1.0.0` retains
the old decision procedure so replay from genesis does not turn an old rejection into
a posting. Both configuration admission and standalone calculation reject unknown
algorithm versions. This is a narrowly versioned semantic repair, not a second kernel.

- `kernel/test/data/inventory-adjustment-legacy.json` contains 72,973 encoded bytes
  captured with the unmodified kernel before this repair (plus a file newline).
  Its checksum is `71cf9958ff519a32d738510899d3aec46003bd8e6f91628dab89d2c36c6efd98`.
  Do not regenerate this historical oracle with the implementation being tested.
- `kernel/test/inventory-value-scope.test.ts`: six tests, 80 assertions. Full
  reexecution reproduces the old aggregate byte-for-byte. A prospective policy
  replacement then commits the adjustment at revision 5; A's basis becomes `11/1`,
  B stays `10/1`, both quantities remain `1/1`, and postings are exactly `+1/-1`.
  Both the old rejected receipt and the new accepted receipt replay after decoding;
  rebuilding the entire mixed-version history yields identical durable bytes.
- Ledger `test/ledger.test.ts`, `L11: SQL recovery preserves pre-repair rejection
  across inventory policy upgrade`: 15 assertions through `ProductionLedger` and
  its real local SQLite adapter. A new ledger instance reloads/reexecutes history;
  the old rejected retry retains Oseq 4 and the original result hash, the corrected
  adjustment retains Oseq 6, and retries do not advance the head. This is instance
  reload, not an abrupt process crash, independent backup drill or remote test.
- Six targeted, build-verified semantic mutations are killed by the new kernel
  tests: changing legacy behavior, retaining global scope for new policy, removing
  target-account enforcement, hiding a live cross-account holding, admitting an
  unknown algorithm, and removing configuration's algorithm gate. Each used a fresh
  independently copied source tree; the real worktree was never mutated. An earlier
  attempt's ambiguous restoration of a common `return true` line corrupted its
  temporary copy; that attempt was discarded, not counted as mutation evidence.
  These six controls are **not** a renewed all-module mutation score.
- Kernel SysIDE and ledger workspace-import SysIDE checks pass with zero diagnostics
  and the real valid/syntax/unresolved-reference controls. The historical full release
  campaign is not recertified by this scoped repair; rerun it for the final release.
  The all-module mutation command was attempted and correctly refused the dirty
  mutation-input tree; no score was produced. Use a verified clean snapshot for the
  full campaign, not a bypass of that guard. The six-copy local audit above is
  separate evidence with explicitly narrower scope.
- The existing decade soak passes (one test, 21 assertions). It exercises the
  retained legacy policies; the mixed-version repair is covered by the dedicated
  six-case suite and SQLite test, not claimed to have a new decade-scale workload.

Repaired source hashes: `accounting.ts`
`bae1be36e1699e5931997250fd30e6aca10708e91f991e66524c172f24fa2c3d`,
`book.ts` `b131211d6b773f45ca9ba5a17c3c2f2cd145c726f8b47030f397ef5eaf0a0c23`.
The captured fixture file SHA-256 (including newline) is
`bf669885c3427eec096083d3203bac7c4196d83eb6b92e46b01fc8b59147d47b`;
this file digest is distinct from its encoded-body checksum and original result hash.

## Audit provenance and next executable gates

The [complete permanent-identity sizing](../../../docs/reference/reviews/ledger-capacity-2026-09-05.md#follow-up-all-permanent-identity-families)
now derives minima for all effect families, not just retry IDs. Proposed inventory
volume yields 205,484,344 logical identities, or 410,968,312 at 2x. Keeping separate
32-byte keys for that latter population requires 13,150,985,984 bytes before values
or metadata. Thus a command-only locator fit does not establish a complete local
index fit. A physical representation may compress or derive keys, but must still
prove permanent uniqueness and historical lookup for each logical family. The
calculator and four tests are planning evidence, not executed workload conformance.

Pre-repair source SHA-256 identities for the original dependency review (not the
whole dirty repository; the repair changes `book.ts` and `accounting.ts`):

```text
book.ts       5714ea1c0b100372cc274ee59aed8f483e2487a0a750d34cd4c91e744c338a73
accounting.ts e39172905db98fa673e485815eabdfe7d68bd90b0683f1ba5773059d27dd09a6
codec.ts      9bc8301087cd230f4165851691e2fb03fb60ec84f5e7b5354e379fee979c2c1c
lots.ts       75a1515d0a0bbded454256a70b91e55d7f9530a3826524365e113466827b7bd7
```

This inventory is human-readable design evidence, not machine semantic traceability.
Before G1 closes: choose and measure a complete physical
index/integrity layout; model verified read contexts and atomic projection updates;
settle explicit hash/codec transition, startup fault detection and large-population
workflows. Then test the actual implementation by removing one required row, forging
an empty range, swapping a head/configuration, duplicating a source, omitting a prior
recognition/allocation, forcing a digest-locator collision, and interrupting every
publication update. Small-book differential tests must compare complete diagnostics,
exact immutable effects, original receipts and independently folded state—not just
final balances or a list of source filenames.

The root `bun run check` passes with the repair: 204 kernel tests, 5,025 assertions,
100% kernel function/line coverage across 13 modules, and 102 existing trace bindings.
The new direct regression tests complement those bindings; the trace catalog's old
fixtures alone do not prove the new business cases. G1 representation work and renewed
full-release verification remain open; this is not production readiness.

### Follow-up: exact schedule basis is not posted carrying basis

The [indexed-owner workflow counterexample](design-review.md#indexed-accounting-workflows-and-a-schedule-completion-counterexample)
demonstrates an additional dependency for the prospective schedule-completion
design: exact installment amounts and recognition IDs alone cannot determine the
posted carrying balance. Three separately rounded recognitions followed by an
exact terminal adjustment can leave 0.01 posted after termination. Existing
history must retain that result; do not reinterpret its amounts while indexing.

A future read context must authenticate the actual canonical recognition journal
postings, their source/schedule/ordinal lineage and governing quantization policy,
alongside the complete prior recognition set. Any cumulative rounding settlement
must distinguish economic basis, posted carrying basis and residual differences,
and enter the same atomic command as the lifecycle transition. This requirement
is open design work, not implemented by the identity index or the scalar checker.

The prospective arithmetic component `planAllocationPostings` now implements the
modeled cumulative posting plan. It accepts an exact schedule and an explicitly
supplied posted source basis, pins the complete quantization policy and distributes
the posted allocable basis in the exact schedule's proportions. For cumulative
exact amount E, total exact allocable A, and posted allocable T, its cumulative
target is T*E/A; an ordinal receives the difference of two quantized cumulative
targets. The final cumulative target is T, which is already representable. Thus
the final posted total is exactly posted source basis minus the quantized residual,
not merely within a rounding tolerance. Ordinal amounts are fixed before arrival
order is known. Zero exact/posted schedules are explicit; a zero exact schedule
with a posted remainder is rejected for separate explicit settlement.

The calculator alone does not verify that supplied posted basis is true, select
or admit an accounting policy, authorize a journal, or migrate a legacy schedule.
An explicit cumulative policy now invokes it through canonical command admission
and the strict codec. Integration obligations and their remaining scope are:

- Complete canonical source/recognition journal closure and exact posted totals,
  including original, successor and repeatedly revised schedules. A plan's own
  hash or caller-supplied total is not that evidence.
- A persisted explicit algorithm discriminator and complete immutable plan in
  the schedule effect, strict codec/hash admission, and a prospective transition
  that never synthesizes plans into old effects or changes original receipts.
- Generated journals that match each planned ordinal exactly under the retained
  policy. A later quantization-policy change must not silently reround them.
- Revision carrying totals that retain both exact economic and actual posted
  amounts, and successors whose posted basis follows the actual canonical prior
  postings. Incomplete source chains or recognition sets reject atomically.
- Terminal settlement of the actual posted remainder, including the case where
  exact carrying is zero but a historical rounding remainder remains, without
  fabricating usage, a zero-value installment, or a caller-chosen balancing plug.
- Direct/indexed ledger tests for those commands, interrupted commit, retries,
  successive estimate changes, impairment, disposal completion, no-op/zero cases,
  chronological and out-of-order recognition, and policy/scale transitions.

New opt-in schedules now meet the scoped command/codec obligations: creation binds
source basis and a fully recomputed plan; recognition uses immutable planned
ordinals; source-closure validation reexecutes cumulative recognition/revision
calculations and compares their effects and actual journals; revision preserves
separate exact/posted totals; successor chains use posted basis; terminal adjustment
clears the posted remainder. A zero posted remainder needs no fabricated journal.
The opt-in requires BOTH a newly added `postingAlgorithm` discriminator and version
1.1.0. Old version strings alone cannot change historical behavior.

Legacy-to-cumulative conversion, posting-account/quantization-policy transitions,
full disposal/fault/hostile-input campaigns and release recertification remain
open. Existing algorithms and legacy bytes are untouched; attempting to convert
a legacy schedule through ordinary cumulative revision currently rejects.

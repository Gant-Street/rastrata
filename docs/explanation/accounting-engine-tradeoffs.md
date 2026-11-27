# Accounting engine tradeoffs

Status: source-level and pinned executable study, 2026-08-24. All paths below are relative to the
pinned checkouts in [`../reference/source-register.md`](../reference/source-register.md).

The objective is synthesis. Rastrata will not emulate one journal syntax or make one
reference runtime its accounting kernel. It will adopt ideas only where they reinforce
the semantic contract, and it will make policy choices explicit where the references
disagree.

The executable companion is
[`../../packages/kernel/spec/research/`](../../investigations/accounting-engine-lab).
Its v0.1 corpus verified 46 observations and two posting-order equivalence pairs.

## Beancount

### Observed behavior

- Directives and positions are treated as immutable value objects. See
  `beancount/core/data.py`, `beancount/core/position.py`, and
  `beancount/core/docs.md`.
- A posting keeps units, cost, and transaction price distinct. An incomplete
  `CostSpec` is resolved to a definite `Cost`; it is not silently treated as already
  booked. See `beancount/core/data.py` and `beancount/core/position.py`.
- Booking is deliberately staged: resolve reductions first, interpolate remaining
  values, then convert augmentation `CostSpec` values to `Cost`. See the module-level
  algorithm in `beancount/parser/booking_full.py`.
- `STRICT` fails on ambiguous lots, while FIFO, LIFO, and HIFO split a reduction in
  their policy order. `STRICT_WITH_SIZE` uses a uniquely matching size and then the
  oldest lot. See `beancount/parser/booking_method.py` and its tests.
- `AVERAGE` exists in the public enum but the current implementation returns
  `AVERAGE method is not supported`. This is an important distinction between
  advertised vocabulary and executable capability.
- Tolerances are inferred from written decimal precision and may account for cost or
  price effects. Residual postings are separately tagged. See
  `beancount/core/interpolate.py` and `beancount/core/interpolate_test.py`.
- Open and close directives establish account lifetimes; validation rejects duplicate
  opens, duplicate closes, use before open, and use after close. See
  `beancount/ops/validation.py`.

### Adopt

- Immutable semantic values and pure transforms.
- Explicit unresolved and resolved representations.
- Strict ambiguity as the default.
- Separate cost basis from transaction price.
- Account roles and lifetimes as modeled concepts.

### Adapt

- Preserve the staged algorithm, but make every stage a distinct typed Rastrata value
  with persisted provenance at the application boundary.
- Use explicit quantization policies and rounding postings instead of allowing inferred
  tolerance to become an implicit accounting rule.

### Reject

- A date-plus-source-line ordering dependency as canonical accounting semantics.
- Arbitrary metadata as a substitute for typed domain fields.
- Treating a declared enum member as a supported policy without verified behavior.

## hledger

### Observed behavior

- The current finalisation pipeline is documented as an ordered sequence with explicit
  hard constraints between stages. See `doc/SPEC-finalising.md` and
  `hledger-lib/Hledger/Read/Common.hs`.
- An amount distinguishes transacted cost (`acost`) from lot cost basis
  (`acostbasis`). Cost can be per-unit or total. See
  `hledger-lib/Hledger/Data/Types.hs`.
- Lot postings are classified as acquire, dispose, transfer-from, or transfer-to before
  lot calculation. Multi-lot reductions and transfers become per-lot fragments while
  retaining the original posting for display. See `doc/SPEC-lots.md` and
  `hledger-lib/Hledger/Data/Lots.hs`.
- A transfer preserves lot identity and cost basis. Weighted-average methods recompute
  a pool on acquisition; global `*ALL` methods require coherent policy across all
  accounts holding the commodity.
- Supported reduction methods are FIFO, LIFO, HIFO, AVERAGE, SPECID, and global
  FIFOALL, LIFOALL, HIFOALL, AVERAGEALL. SPECID rejects a missing or multi-match
  selector. See `Hledger/Data/Types.hs` and `Hledger/Data/Lots.hs::selectLots`.
- Lot identifiers are date plus optional label, while basis is stored separately as a
  per-unit amount. The specification documents a precision boundary when repeating
  decimal basis is rendered and later parsed again.
- `Quantity` is a decimal value with up to 255 display digits, not an exact rational.
  This is strong decimal behavior but is not sufficient for Rastrata's exact allocation
  intermediate.

### Adopt

- First-class lot allocations and basis-preserving transfer semantics.
- Explicit classification before selection and gain realization.
- Configurable, versioned selection policy with SPECID-style fail-closed behavior.
- Per-account and jurisdiction/global policy scope.
- Original-versus-derived posting lineage.

### Adapt

- Give every lot a stable UUID; acquisition time and label remain searchable
  attributes, not identity.
- Preserve total basis exactly when a lot is split. Per-unit basis is a derived view,
  not the authoritative value.
- Separate inference artifacts from presentation collapse rather than storing hidden
  semantic tags in a general tag list.

### Reject

- Account-name encoding as canonical lot identity.
- Display precision participating in canonical lot matching.
- Optional disabling of accounting invariants in a posted production journal.
- Virtual postings in the canonical ledger.

## Ledger

### Observed behavior

- `amount_t` stores a GMP `mpq_t` rational plus separate display precision. Arithmetic
  is exact internally, while rendering and explicit rounding are distinct operations.
  See `src/amount.h` and `src/amount.cc`.
- Commodities form nodes in a price-history graph; valuation may find a conversion path
  between commodities. See `src/commodity.h`, `src/commodity.cc`, and `src/history.*`.
- Transaction finalisation combines amount inference, conversion-price inference, lot
  matching, commodity exchange, gain calculation, rounding accommodation, and balance
  enforcement. See `src/xact.cc::xact_base_t::finalize`.
- FIFO and LIFO lot behavior is exercised in `test/baseline/opt-lots-fifo.test` and
  `opt-lots-lifo.test`; the larger test suite covers annotations, gains, assertions,
  valuation paths, virtual postings, hashes, and the query language.
- Transaction hashes sort posting representations before SHA-512 hashing. This is a
  useful tamper-evidence idea, but a content hash alone is not a complete audit model.
- The pinned source contains a regression guard preventing posting order from
  overriding a primary commodity established by price directives. Explicit-rate order
  variants in the Rastrata lab produced identical valued output.

### Adopt

- Exact rational arithmetic for intermediate allocation, exchange, and apportionment.
- Commodity-agnostic quantities.
- A temporal price-observation graph with explicit valuation path provenance.
- Expressive read-side queries.
- Hash-chained audit evidence as defense in depth.

### Adapt

- Preserve input decimal coefficient and scale alongside exact rational computation.
- Move valuation and query execution outside the booking invariant kernel.
- Hash canonical, versioned serialized records and link them to actor, policy, and
  source evidence.

### Reject

- One large finalisation procedure as the semantic boundary.
- Silent reliance on posting order to select a conversion direction.
- Plain and balanced virtual postings in the canonical journal.
- Programmable expressions or arbitrary metadata that can mutate accounting meaning
  after posting.

## GnuCash

### Observed behavior

- A transaction owns splits and one transaction balancing commodity. Each split keeps
  `amount` in the account commodity separate from `value` in the transaction
  commodity. See `libgnucash/engine/Split.h` and `Transaction.cpp`.
- Transaction imbalance is evaluated from split values in the ordinary case and by
  commodity when trading accounts or non-currency commodities require it. See
  `Transaction.cpp::xaccTransGetImbalance`.
- The engine has a root account per book and hierarchical account ownership. Opening
  balances and book-close operations create real balanced transactions rather than
  rewriting account balances. See `gnc-ui-util.cpp` and
  `gnome-utils/dialog-book-close.c`.
- Book close computes account balances at the close date, creates closing transactions
  by commodity, and balances them into equity. The close operation is useful evidence
  for real closing entries, but it does not itself provide Rastrata's immutable close
  checkpoint, approval, or reproducible-report package.

### Adopt

- One book as the journal and account ownership boundary.
- Quantity in account commodity separated from value in transaction/book commodity.
- Hierarchical accounts and real balanced opening and closing entries.
- Reports derived from transaction splits rather than mutable document totals.

### Adapt

- Replace editable transaction/split state with immutable booked journals and linked
  corrections.
- Add explicit fiscal admission, book revision, posting sequence, chart snapshot, and
  close/report population identities.
- Keep reconciliation as external evidence links rather than a mutable split flag.

### Reject

- Edit-session mutability as the production correction model.
- Order-sensitive setter protocols for establishing amount and value.
- Treating a closing transaction alone as complete close governance.

## TigerBeetle

### Observed behavior

- Account and transfer IDs are end-to-end idempotency keys. A repeated ID is compared
  field by field: identical content returns the retained object while changed content
  returns an `exists_with_different_*` result. See
  `docs/coding/reliable-transaction-submission.md` and
  `src/state_machine.zig::create_transfer_exists`.
- Idempotency checks occur before ordinary semantic validation so a retry can recover
  the original result even after surrounding state has advanced.
- Accounts and transfers are constrained to the same ledger, event timestamps are
  monotonically ordered, and balance accumulators are checked for overflow before
  mutation. Pending, posted, voided, and expired transfers have explicit transitions.

### Adopt

- Stable command identity with same-content replay and changed-content rejection.
- Explicit ordered state transitions and fail-before-mutation overflow checks.
- Idempotency comparison before current-state admission checks.

### Adapt

- Give every canonical book transition a book revision and every posted journal a
  separate posting sequence.
- Apply the identity rule to complete accounting command content, not only a transfer
  record.
- Retain TigerBeetle as a concurrency and integrity reference, not as the general
  ledger or reporting model.

### Reject

- Reducing a multi-line, multi-commodity accounting journal to paired transfers.
- Treating pending transfer state as a substitute for draft, approval, period, close,
  or correction semantics.

## Legacy Rastrata

The final complete pre-reset system at
`8dc3c1af8251975e4b14302f4c6e6a444fa09fb6` is internal implementation evidence. It
proved legal-entity and group books, immutable financial identity, fiscal-period
admission, balanced opening activation, content-addressed posting envelopes,
same-content replay, gap-free posting sequence, reversals and replacements, close and
reopen checkpoints, and one golden posted population tying six reports together.

Rastrata adopts those controls as kernel contracts. It rejects the old implementation
shape: 159 migrations, dispersed domain compilers, database-trigger accretion, and
product breadth before a small portable semantic core was frozen.

## Synthesis matrix

| Concern | Rastrata decision | Strongest evidence | Deliberate difference |
|---|---|---|---|
| Numeric core | Preserved decimal input + exact rational intermediate + explicit quantization | Ledger | Display precision never changes canonical value |
| Boundary resolution | Typed staged transforms that cannot book | Beancount, hledger | Only pure kernel command evaluation may create a canonical intent |
| Ambiguous reductions | Fail closed by default; explicit versioned policy may resolve | Beancount STRICT, hledger SPECID | No implicit fallback based on source order |
| Lot identity | Stable UUID | hledger lot behavior | Date/label/cost are attributes and selectors, never identity |
| Basis | Authoritative total basis; derived per-unit view | hledger and Ledger | Splits allocate conserved total basis exactly |
| Transfer | Preserve identity and total basis | hledger | Crossing a declared tax boundary requires an explicit policy decision |
| Price | Typed observation with source/effective/observed time | Ledger price graph | A transaction price is not automatically a market price |
| Balance assertion | Evidence about a balance at a point | all three | Never creates or alters a posting |
| Corrections | Reversal or supersession | immutable Beancount philosophy | Posted transactions are never edited in place |
| Reconciliation | Evidence graph | operational product requirements | Not a boolean field on a posting |
| Automation | Persisted versioned derivation | hledger/Beancount inference lessons | No invisible recomputation of historical meaning |
| Interchange | Canonical Rastrata JSONL plus fidelity-classified adapters | all three | Adapter round-trips may be explicitly lossy or unsupported |
| Book authority | Exactly one owner and serialized accounting authority per book | GnuCash, legacy Rastrata | Deployment may be a lock protocol or actor; the kernel is vendor-neutral |
| Command replay | Same identity and content replays; changed content fails | TigerBeetle, legacy Rastrata | Identity covers the full typed command and canonical input hash |
| Ordered history | Separate book revision and journal posting sequence | TigerBeetle, legacy Rastrata | Effective accounting time remains separate from both orders |
| Period control | Immutable opening, close checkpoint, and reopen effect | GnuCash, legacy Rastrata | A closing entry alone is not a complete close package |
| Reports | One pinned population feeds journal, ledger, trial balance, and statements | GnuCash, legacy Rastrata | Every output pins revision, posting cutoff, chart, basis, and policy |

## Executable findings that changed the model

- Beancount resolved `3 UNIT {{10 USD}}` to a 27-digit per-unit Decimal and rejected
  the remaining `10^-27 USD` imbalance. Exact rational arithmetic is therefore a
  correctness boundary, not an optimization.
- hledger accepted the same acquisition but rendered `3.33333333 USD` as the lot's
  per-unit identity component; Ledger rendered six digits in its lot view. Rastrata's
  authoritative basis is now an exact total rational, never a rendered per-unit value.
- Beancount rejected an ambiguous default disposal, hledger selected FIFO, and Ledger
  created a new negative sale-price lot until explicit FIFO matching was enabled.
  Rastrata keeps fail-closed ambiguity as its default.
- hledger alone executed the weighted-average booking fixture correctly. Beancount's
  public enum failed at execution, while Ledger's average flag changed a report rather
  than booking. The model now distinguishes policy vocabulary from certified
  executable capability.
- hledger and Ledger automatically traversed a two-edge valuation path. Beancount
  required the caller to nominate the intermediate commodity. Rastrata now models a
  versioned valuation policy, ordered path steps, and a `MarketValue` distinct from
  `BookValue`.

## Kernel v1 capability dispositions

Kernel closure does not turn declared policy vocabulary into advertised capability.
The following decisions bound v1 without pretending that every jurisdictional method
is already implemented:

1. Specific identification and FIFO define the first lot-selection verification
   surface. Weighted average remains in the type system but is supported only for a
   capability record whose account or jurisdiction-pool scope, acquisition pooling,
   transfer behavior, and conservation fixtures are executable. LIFO and HIFO require
   the same certification and are not baseline launch claims.
2. Negative inventory and short positions fail closed in the baseline. A future
   short-position capability must model acquisition, cover, proceeds, basis, gain, and
   jurisdiction separately; it cannot reuse a negative ordinary lot accidentally.
3. A tax-boundary crossing that changes basis is an explicit disposal and
   reacquisition under a pinned policy. A basis-preserving transfer is legal only when
   the declared boundary policy says legal and tax identity remain continuous.
4. The valuation graph is reporting-only in Kernel v1. Booking FX requires an explicit
   pinned transaction-rate observation or typed policy result; it never silently uses
   a current, inverse, or triangulated market path.
5. Quantization has no universal hard-coded scale or rounding mode. Every booked or
   rendered decimal names a versioned policy with target scale, mode, and residual
   destination. A storage adapter must prove its bounded representation for every
   admitted policy.

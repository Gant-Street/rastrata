# Pinned-engine observations

Run date: 2026-08-24. Corpus: `rastrata-accounting-engine-lab-v0.1`.

The run used Beancount 3.2.3, hledger
`1.99-gd06affcbb-20260824`, and Ledger 3.4.1-20251025 from the commits in
[`../../docs/reference/source-register.md`](../../../../docs/reference/source-register.md). The
raw result directory was disposable; the inputs, runner, expected observations, and
conclusions are versioned here. `verify_results.py` passed 46 observations and two
posting-order equivalence pairs.

## Results

| Case | Beancount | hledger | Ledger | Rastrata consequence |
|---|---|---|---|---|
| Missing amount | Inferred `-123.450 USD`, tagged automatic, retained scale | Inferred and printed `-123.450 USD` | Accepted; ordinary `print` preserved the omission | Inference is a derivation with source scale and provenance, never an invisible mutation |
| Three units for total 10 | Converted to 27-digit Decimal unit cost, then rejected a `10^-27 USD` residual | Accepted; internal Decimal basis rendered as `3.33333333 USD` | Accepted; exact rational core rendered `3.333333 USD` in lot view | Store authoritative total basis as a rational; a rendered per-unit basis cannot become canonical input |
| Ambiguous default reduction | Failed under `STRICT` | Silently selected FIFO | Default created a negative sale-price lot; explicit FIFO matched oldest lot | Rastrata fails closed by default; any automatic selection is an explicit versioned policy |
| FIFO/LIFO/HIFO | All three policies selected the expected lots | All three selected the expected lots | FIFO and LIFO selected expected lots; no equivalent HIFO booking probe | Policy vocabulary is not capability. Each method and scope needs executable certification |
| Basis versus sale price | Preserved 10 basis and inferred 6 gain | Preserved basis; generated 6 realized-gain and offsetting unrealized-gain postings | Explicit FIFO produced 6 gain | Transaction price, basis, market price, and gain stay typed and separate |
| Account transfer | Equivalent annotations preserved date and basis | Native transfer inference moved the lot with its basis | Paired annotated postings preserved displayed date and basis | Adopt hledger's continuity, but model a stable lot ID and first-class transfer allocation |
| Weighted average | Public enum parsed, executable booking failed as unsupported | Correctly used 12 average basis and generated 8 gain; 24 total basis remained | `--average-lot-prices` displayed a misleading 8-dollar lot; it did not book average cost | Average cost is supported only with declared pool scope, conservation rules, and passing fixtures |
| Account lifetime | Rejected use before open | Account declaration check accepted; no dated lifetime semantics | Accepted; no comparable lifetime semantics | Adopt explicit validity intervals and validate at accounting date |
| Failed balance assertion | Rejected; recorded one-unit difference | Rejected with expected, calculated, and difference | Rejected with difference | Assertions are evidence and cannot synthesize an adjustment |
| Specific identification | Explicit cost/date selector consumed the intended lot | `SPECID` consumed the intended lot and rejected a missing selector | Explicit cost/date annotation consumed intended lot | Specific identification stores selected stable lot IDs plus the source selector evidence |
| Two-edge valuation | Direct conversion returned AAA unchanged; caller-supplied `via=BBB` produced 6 USD | Automatically traversed AAA→BBB→USD | Automatically traversed AAA→BBB→USD | Valuation is a policy-driven read-side graph; persist the ordered path, edge direction, observations, and exact result |
| Posting order | Explicit price produced equivalent booked meaning in both orders | Both orders produced identical USD output | Both orders produced identical USD output; pinned source includes the historical primary-commodity fix | Order is never semantic. Canonicalization and tests enforce equivalence |
| Virtual posting | Syntax rejected | Accepted; disappeared from `--real` balance | Accepted; disappeared from `--real` balance | Virtual/statistical allocations belong in derived analytical models, never the canonical journal |

## What each engine gets most right

Beancount has the cleanest semantic posture: immutable data, unresolved-versus-booked
types, staged booking, strict ambiguity, and dated account lifetimes. Its weakness is
that Decimal is asked to do work that sometimes requires a rational, and the declared
`AVERAGE` vocabulary is ahead of executable support.

hledger has the richest current lot model. Its classification of acquisitions,
disposals, transfers, gains, local methods, and global pools makes jurisdictional
policy visible. Its strongest lesson is basis-preserving transfer. Its weaknesses are
date/label lot identity, per-unit basis authority, presentation-collapse complexity,
and a real print/reload precision boundary for repeating basis.

Ledger has the strongest numeric primitive and valuation graph: GMP rationals keep
arithmetic exact, while display precision remains separate. Its query and price graph
heritage is valuable. Its weaknesses are a broad monolithic finalization boundary,
optional lot matching whose default can create a negative sale-price lot, and virtual
or programmable features that blur canonical accounting with reporting convenience.

## Reconciled architecture

The synthesis is not a majority vote:

1. Preserve every written decimal as coefficient and scale, but use canonical exact
   rationals for quantities, rates, allocations, and total lot basis. Quantize only
   named book/report outputs.
2. Follow Beancount and hledger's staged resolution, with a different type at every
   semantic boundary and typed failure instead of residual tolerance.
3. Follow hledger's lot operations, but replace date/label identity with a stable ID
   and replace authoritative per-unit cost with conserved exact total basis.
4. Make `STRICT` the safety default. FIFO, LIFO, HIFO, SPECID, and weighted average
   are versioned capabilities whose jurisdictional scope is explicit.
5. Follow Ledger and hledger's valuation graphs outside the booking kernel. A market
   value is not a `BookValue`; every cross-rate result retains its selected path.
6. Keep canonical journals real, balanced, immutable, and minimal. Virtual postings,
   unrealized analytical reclassifications, reconciliation state, and market values
   are linked derived models.
7. Treat formatted journal syntax as an adapter boundary. No printed per-unit basis,
   omitted inferred amount, account-name lot, or renderer precision may feed back
   into canonical identity or value.

## Follow-on capability investigations

These are not allowed to expand the bounded Kernel v1 closure. They become admission
tests only when Rastrata proposes the corresponding capability: shorts, returns of
capital, stock splits and mergers, wash-sale adjustments, fees paid in acquired
commodity, weighted-average pool crossings, and lossy adapter round trips.

Kernel-level concerns that must remain in the closure verification surface are
multi-currency book value, backdated policy pinning, same-instant stable lot identity,
reversal/supersession, concurrent command replay, canonical serialization hashes, and
projection/export reconstruction.

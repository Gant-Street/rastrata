# Accounting kernel

The kernel owns the deterministic accounting implementation and the evidence that
verifies it. It does not own persistence, transport, authorization, or product UI.
Its public entry point is `@rastrata/kernel`; support files are not public exports.
Canonical hashing uses synchronous native `node:crypto` in Bun and in Workers
with Node compatibility; the ledger integration suite verifies matching bytes and
hashes. This portability change does not change the canonical encoding or version.

| Directory | Responsibility |
|---|---|
| `src/` | Accounting implementation |
| `test/` | Fast accounting tests and executable fixture runners |
| `slow/` | Decade-scale stateful accounting test |
| `spec/` | Authoritative SysML, design fixtures, and semantic trace bindings |
| `spec/research/` | Optional comparative experiments against pinned reference engines |
| `scripts/` | Coverage, trace, SysIDE, and mutation verification |

From this directory, run `bun run typecheck`, `bun run test`, `bun run check:spec`,
or `bun run check:trace`. The root `bun run check` combines these with repository
checks and coverage. Root `bun run check:release` additionally runs licensed SysIDE,
the slow test, and mutation verification against a clean committed checkpoint.
Package test/trace commands explicitly preserve repository-root fixture paths;
coverage and mutation reports remain in the root ignored `coverage/` directory.

See the [accounting contract](../../docs/reference/accounting-kernel-v1.md),
[specification](spec/README.md), and [validation guide](../../docs/how-to/validate-kernel.md).
The production-ledger architecture and implementation status are documented in the
[ledger contract](../../docs/reference/production-ledger.md). The kernel SysML's
boundary requirements remain authoritative and are not duplicated there.

`createBookState` optionally selects `STRUCTURAL_SOURCE_IDENTITY_PROFILE` at
genesis. The hashed configuration then uses structural posting-source coordinates;
absence retains legacy bytes and lookup behavior. Ordinary configuration replacement
preserves the selection. An explicit `executionProfileAdoption` payload can move
legacy source resolution forward using the exact prior configuration hash, reason
and bounded evidence IDs; it cannot downgrade or rewrite old receipts. This is a
source-resolution transition, not inventory ownership completion or a storage format.
ACC-038 remains open for complete integration verification and release recertification.

`createBookState` also optionally selects `CHAIN_HEAD_STATE_COMMITMENT_PROFILE` at genesis,
as a separate ninth argument, so it composes with the structural profile. A book that carries
it computes `BookState.contentHash` from its identity, counters, active configuration, opening
boundary and revision chain head instead of re-encoding every journal, so admission and
`applyEffects` do not scale with the history; absence keeps the original complete-population
preimage, bytes and behavior. The marker is hash-bound by the configuration snapshot, kept by
every configuration change, and never adopted, changed or removed. Recovery (`validateBookState`,
so `decodeDurableBook`) proves every materialized collection and retained configuration
snapshot against the ordered effects, which is where the legacy hash's coverage of them is
kept; admission checks counters, the head revision, the latest journal and the commitment in
constant time. A build that predates the marker rejects a book that carries it at the codec.
See the [design note](../../docs/reference/program/scale/commit.md).

`applyRecordedRevision` and `applyRecordedOutcome` apply what a book has already recorded, without
evaluating the command that made it again: for a book with the chain-head commitment they return the
state (and, for an outcome, the protocol with the retained command result) that `executeBookCommand`
returns for the same command, by the same `applyEffects`, after checks that cost the size of one revision
(its book, number, link to the previous chain hash, chain hash derived from the recorded effects hash,
posting sequence, command binding and configuration chain). They do not re-evaluate the command or
re-derive the hash of the effects, so they are for a reader whose storage already vouches for the bytes
(a ledger's hash chain) and who leaves independent re-execution to a verifier; a record whose effects
were altered consistently with nothing else is accepted, and `executeBookCommand` against the stored
command, or `validateBookState`, is what says so. `decodeStoredBookOutcome` decodes such a stored outcome
without the proof that its text is the canonical encoding of what it decodes. All three are additive:
nothing existing changed, and the tests hold the applied state, protocol and encoding equal to the
executed ones at every step (`recorded-revision.test.ts`). See the
[coldstart lane record](../../docs/reference/program/scale/coldstart.md).

A state built by `executeBookCommand` keeps its journals, revisions and retained command
results in one append-only store shared with the states before and after it, so a command does
not copy, freeze or scan the history (`book-history.ts`). `state.journals`, `state.revisions`
and `protocol.retainedResults` of such a state are accessors that return a frozen array, copied
and frozen on the first read and the same array afterwards; no caller can obtain a writable
one. That first read costs 50 to 130 ns an element, so code on a per-command path reads the
ends of these lists with `latestRevisionRecord` and `latestRetainedCommandResult`, and the
kernel's own code uses the internal views. `bookHistoryMaterializations` counts the copies, for
tests that a path makes none. See the [scaleindex lane record](../../docs/reference/program/scale/scaleindex.md).

`PostOwnedInventoryTransactionCommand` is the eighteenth modeled and runtime command
variant. Its bounded full-state implementation admits ordered acquisition/issue groups
and optional real journals, retains ownership effects, and verifies their materialized
state during durable decoding and replay. It requires the explicit structural source
identity profile; it does not silently adopt existing unowned stock. Legacy books omit
the optional ownership projection and retain their original bytes and hash preimages.
A newly managed scope must also have zero existing posted balance; otherwise verified
adoption is required even if there are no lot rows or the old stock is exhausted.
Correction/transfer/value-adjustment/adoption and complete indexed admission remain
release-blocking work under ACC-039.7/.8/.9. This is not a production inventory release.

The internal `owned-inventory-command.ts` accounting stage now compiles ordered
acquisitions/issues from admitted journals, resolved policies and trusted pinned
inventory reads. It checks managed money scopes and produces one ownership
candidate, including quantity-only movements. It is not exported by the package
entry point and cannot create an intent or durable outcome by itself. The book command
evaluator owns that integration. The internal indexed ledger persists ownership
inside authenticated revision rows, with the current array checked as a revision
alias. It indexes immutable ownership identities without inventing legacy allocation
postings. Full-state evaluation and startup remain; this is not scalable indexed
admission or a production durability/capacity certification.

`planAllocationPostings` is arithmetic, not command authority. New schedule policies
may explicitly opt into `postingAlgorithm: "cumulative-posted-allocation-v1"` with
algorithm version `1.1.0`; their canonical commands persist and enforce the plan.
Policies without that new field retain legacy behavior regardless of version.
The [posted allocation completion finding](../../docs/reference/reviews/kernel-v1/production-closure.md)
remains open for legacy posted-history conversion and full release verification.
No existing schedule or receipt is rewritten automatically.

`encodeBookRow` / `decodeBookRow` provide typed canonical subtrees for the closed
`BOOK_ROW_COLLECTIONS` catalog. They reuse the aggregate codec's schemas and exact
numeric encoding; decoded rows are immutable. Decoding checks structure and bytes,
not source authenticity, content hashes, cross-row closure or accounting admission.
The enclosing source/profile and collection/ordinal/row commitment remain required.

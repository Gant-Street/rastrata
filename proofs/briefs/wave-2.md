# Wave 2: an admitted journal balances, rounding that balances, lots, valuation

Read `proofs/README.md` first and follow it to the letter. Read the TypeScript you model in full before writing.
The numbers (`Numeric.lean`, proved), the canonical value and the hash (`Canonical.lean`, `Sha256.lean`, proved)
and the vocabulary (`Journal/Types.lean`, `Policy/Types.lean`) are there to be used and are not edited.

Rules that apply to every workstream, beyond the README:

- The model is typed, so a run-time type check on a value that TypeScript's types already guarantee
  (`x instanceof ExactDecimal`) is modelled as always passing; say where you did this. A check on something the
  types do not guarantee is modelled.
- A function that collects diagnostics returns the same diagnostics in the same order (code, path and the
  requirement identifiers; the message text may be left out, and say that you left it out).
- An exact-number operation that can throw inside a function makes the function return `.error` with that code.
- For every function, two kinds of law: **soundness** (what an accepted input is guaranteed to satisfy) and
  **completeness** (an input that satisfies the stated conditions is accepted), so that the conditions in the laws
  are exactly the function's, not a subset.

## 1. Journal admission

File: `proofs/Rastrata/Kernel/Journal/Admission.lean`. Source: `packages/kernel/src/journal.ts` after `diagnostic`
(`validateSnapshot` and its helpers, `canonicalPostingValue`, `canonicalJournalValue`,
`validateAccountingCoordinate`, `admitJournal`).

- **The headline: an admitted journal balances.** If `admitJournal` returns `admitted`, the meanings of the book
  values of its postings add up to exactly zero.
- An admitted journal has at least two postings, distinct posting identifiers, distinct non-negative ordinals, no
  zero book value, every posting in the book's functional commodity, the journal in the snapshot's book; and each
  further property that a diagnostic of `admitJournal` guards, one theorem a diagnostic.
- Completeness: a journal with all of those properties, on a valid snapshot, is admitted (or the running balance
  exceeded the size limit, which is `.error`).
- A rejected journal carries at least one diagnostic, and `journal_imbalance` is among them exactly when the
  balance is not zero.
- The canonical value of a journal determines the journal: two admitted journals with the same
  `canonicalJournalValue` are equal, and so two with the same hash are equal or a `HashCollision` is in hand.

## 2. Rounding that balances

File: `proofs/Rastrata/Kernel/QuantizationBalanced.lean`. Source: the rest of `packages/kernel/src/quantization.ts`
(`QuantizationPolicy`, `hashQuantizationPolicy`, `quantizeBalancedBookValues`, and `quantizeCumulativePostedShare`
over the full policy record), on top of `Quantization.lean`.

- When `quantizeBalancedBookValues` returns `quantized`, the returned book values plus the rounding posting (when
  there is one) add up to exactly zero, provided the exact values did; and in general their total differs from the
  exact total by exactly the stated residual.
- Each returned value is within one unit of the target scale of its exact value; the rounding posting is at most
  as many units as there are values; there is a rounding posting exactly when the rounded values do not add up.
- Every rejection is for a stated reason, and a policy for another book or commodity is always rejected.

## 3. Lots

File: `proofs/Rastrata/Kernel/Lots.lean`. Source: `packages/kernel/src/lots.ts`.

- `allocateLots`: when it returns an allocation, the quantities taken add up to exactly the requested quantity;
  no holding is taken below zero or by more than it holds; the cost basis removed from the holdings equals the
  cost basis assigned to the allocations, exactly; holdings not touched are unchanged; total quantity and total
  basis across holdings fall by exactly what was allocated.
- The selection method is honoured: first in first out takes holdings in acquisition order and never takes from a
  later one while an earlier one has quantity left; the same for last in, highest cost and specific
  identification (which takes exactly the named quantities), each as the TypeScript orders them, ties included.
- A request for more than is held is rejected as `lot_overallocation`, and nothing else is.
- `transferLots`: quantity and basis leave the source and arrive at the destination unchanged in total; the
  destination holdings carry the acquisition identity the transfer policy says.

## 4. Valuation and the policy functions

Files: `proofs/Rastrata/Kernel/Valuation.lean`, `proofs/Rastrata/Kernel/Policy.lean`. Sources:
`packages/kernel/src/valuation.ts`, and every function of `packages/kernel/src/policy.ts` that the vocabulary
worker left as "not a type".

- `valueWithObservation`: the value is the quantity times the rate, or divided by it when the inverse is allowed
  and used; an observation from after the effective time is refused; valuing with the inverse and then back gives
  the quantity again. `Date.parse` on an admitted `Instant` is its time in milliseconds: use the vocabulary's
  model of it and say what you assumed.
- Policy resolution: exactly one policy governs a date or the result is `policy_ambiguity` or a missing-policy
  diagnostic; the governing policy is the one whose validity contains the date; resolution does not depend on the
  order the policies are given in.

## 5. Oracle

Files: `proofs/Oracle/*.lean`, `packages/kernel/test-lean/*.test.ts`. Add every function of `Quantization.lean`,
the validators of the vocabulary, and each function of workstreams 1 to 4 as it builds, on the pattern of
`numeric.test.ts` and `canonical.test.ts`. A difference is a finding: record it as a named test and report it.

## Done means

From `proofs/`: `python3 check.py` prints `proofs: ok`, and `bun run test:lean` passes in `packages/kernel`.
The report: the files; each law as one plain sentence with its theorem name; anything not proved and why; every
place the TypeScript did something a law did not expect (file, line, input, result).

# Currency, allocation schedules, tax, consolidation

Read `proofs/README.md` first and follow it to the letter: a file always builds (an unfinished proof is `sorry`,
never text that does not compile; build after every definition and every theorem, never more than about fifty
lines between two builds), every build runs under the time limit, and no proof makes Lean compute with a huge
number. A worker's file that was never built counts as not written. Then read `proofs/briefs/wave-3.md` (the module
plan, what a modelled function is, the five kinds of law, and what a report holds): your rows are 5d, 5e, 5f, 5g.

This is a small swarm on purpose, because the model's quota is small: four workers, one workstream each, on
`gemini-4-hydrogen-xhigh`, plus the coordinator; no monitor worker. Every worker works in this checkout, in `proofs/`,
only in its own file. Do not give a worker its own copy or worktree of the repository (`proofs/.lake` holds a 7 GB
build of Mathlib). Nobody commits, pushes or runs `bun run ship`. Nobody edits `proofs/Rastrata.lean`, any file that
exists already, the oracle, or the TypeScript. Other agents are working in this checkout on other files: do not touch
or import files you were not told to import.

Build command, from `proofs/`:
`perl -e 'alarm 300; exec @ARGV' lake build Rastrata.Kernel.Accounting.<Module> 2>&1 | grep -v "module system"`

## What every worker reads before writing

1. The head (first 120 lines) and the style of `proofs/Rastrata/Kernel/Lots.lean` and `QuantizationBalanced.lean`: a
   header that lists what is assumed about JavaScript and what is not modelled, doc comments naming the TypeScript
   member and its line, `Except` for what throws, diagnostics as values in order, laws as iff statements over the
   model's own conditions.
2. `proofs/Rastrata/Kernel/Accounting/Types.lean` (every type of `accounting.ts`, its `WF` predicates, its header) and
   `proofs/Rastrata/Kernel/Accounting/Core.lean` (the helpers you call: `policyAt`, `validAccountingDerivation`,
   `reject`, `drafted`, the hashes, the canonical values; the definitions are final, its theorems are being proved at
   the same time by another worker and you may use the statements that already build).
3. The TypeScript of your range, in full, and then the functions it calls.
4. The laws of `wave-3.md`, and the hints below.

The shape of what these functions produce is regular: an `ExactPreparedJournal` whose postings carry exact book values
(`exactBookValue`), and one or more effects, each hashed with `accountingHash("Name", body)`. So the central law of
each is that the prepared journal BALANCES (its exact book values add up to zero) and that the effect's hash is the
hash of its body.

## 5d. currency: `Accounting/Currency.lean`

`accounting.ts` 1496 to 1542: `CurrencyRemeasurementRequest`, `CurrencyAccountingState`, `calculateCurrencyRemeasurement`.
Laws: the journal produced (for a remeasurement and for a reversal) has two postings whose exact values are
`difference` and `-difference` and so balances; `difference = denomination × rate − carryingBookValue` exactly; the gain
or loss account is chosen by the sign of the difference as the code says (and for a reversal, the ORIGINAL result's
policy accounts when it recorded them); a reversal is refused unless the original exists, is `unrealized`, has not been
reversed, and a `reversalId` is given (one iff theorem); every rejection and the diagnostic it gives; the only `.error`
is the size limit.

## 5e. schedules: `Accounting/Schedules.lean`

`accounting.ts` 1543 to 1755: `monthsBetween`, `addMonths`, `scheduleStepMonths`, `usesCumulativeAllocation`,
`allocationPlanIsValid`, `createAllocationSchedule`, `recognizeScheduledAllocation`, `reviseAllocationSchedule`, and the
request types in that range not yet in Types.lean. `planAllocationPostings` is in `Core.lean`: use its laws.
Laws: `monthsBetween` and `addMonths` are the calendar arithmetic they name (including month ends; JavaScript
`Number` of the split date parts; state any date `addMonths` can produce that is not a real date, with a witness);
when `createAllocationSchedule` returns a schedule, its instalments are in date order, their exact amounts add up to
the allocable amount, and (cumulative algorithm) its posting plan's posted amounts add up to the posted allocable
amount; recognising an instalment produces a balanced journal for exactly the planned amount and marks that
instalment recognised once (a second recognition is refused); a revision conserves what was already recognised and
re-plans only the rest; all rejections with their diagnostics.

## 5f. tax: `Accounting/Tax.lean`

`accounting.ts` 1756 to 2024: `TaxableLine`, `TaxRequest`, `PreResolvedTaxLine`, `determineTax` (about 250 lines, read
every branch). Laws: the tax lines add up to the tax of the components under the stated rounding level (document: per
line, per group, per document: prove what each level guarantees and report where the total of rounded lines can differ
from the rounded total of the exact tax, with a witness); the journal produced balances (taxable amounts plus tax
against the counter-posting, inclusive and exclusive); inclusive tax backs the tax out exactly (net + tax = gross);
recoverable and non-recoverable treatment put the tax in the accounts the policy names; the structural grouping
variant (`usesStructuralTaxGrouping`) groups as the code says and the result does not depend on the order of the input
lines (or a witness that it does); all rejections with their diagnostics; the only `.error` is the size limit.

## 5g. consolidation: `Accounting/Consolidation.lean`

`accounting.ts` 2025 to 2164: `ConsolidationValuationStep`, `ConsolidationValuationPath`, `ConsolidationSource`,
`ConsolidationElimination`, `ConsolidationRequest`, `compileConsolidation`. Laws: each compiled entry balances;
eliminations net to zero (a source amount and its elimination are equal and opposite); translation by a valuation path
multiplies by the rates along the path in order, exactly; the sources' totals translate to the compiled totals; the
result does not depend on the order of the sources (or a witness); all rejections with their diagnostics; the only
`.error` is the size limit.

## Reports

Each worker, and then the coordinator, reports exactly as `wave-3.md` says: the files; what is modelled and left out;
each law with its theorem name; the exact result of the final build (errors and `sorry` warnings); anything not proved
and why; every place the model and the TypeScript can differ; every place the TypeScript does something a law did not
expect (file, line, input, result). The coordinator builds every file itself before reporting.

Scratch files go only in `/private/tmp/claude-501/-Users-eric--herdr-worktrees-rastrata-lean/cae2d16e-e645-4cc6-9a7b-31b78ef0cc36/scratchpad/wave3b/<your name>/`.

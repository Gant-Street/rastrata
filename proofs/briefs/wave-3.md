# Wave 3: `accounting.ts`

Read `proofs/README.md` first and follow it to the letter, and the top of `proofs/briefs/wave-2.md` (the rules for
every workstream: typed values, diagnostics in order, soundness and completeness). The workers of wave 2 left a style
to follow: read the head and the first two hundred lines of `proofs/Rastrata/Kernel/Lots.lean` and
`proofs/Rastrata/Kernel/QuantizationBalanced.lean` before you start, and read the other workers' files in this
wave's list when yours depends on them.

## The module plan

`accounting.ts` (2,233 lines) is cut into these Lean modules, in this order of dependency. A module builds before
anything that imports it is started; the workers of a later row do not start until the file they import is on disk,
builds, and its definitions are final (the owner of a file only adds theorems after that).

| Order | Module | TypeScript | Imports |
|---|---|---|---|
| 1 | `Accounting/Types.lean` | `accounting.ts` 33 to 680 (every type, the identifier makers, `effectKey`, the canonical posting reference and its hash functions) and the types of 1131 to 1160 | Numeric, Canonical, Journal/Types, Policy/Types, Quantization, Lots |
| 2 | `Book/BaseTypes.lean` | `book.ts` 1 to 250: the identifiers, `FiscalPeriod`, `OpeningBoundary`, the execution and commitment profiles, `ExecutionProfileAdoption`, `BookConfigurationSnapshot`, `BookedJournal` | Accounting/Types, Policy |
| 3 | `Accounting/BasisTypes.lean` | `accounting.ts` 1282 to 1330 (the read snapshot and the basis projection types, which mention the book's types) | Book/BaseTypes |
| 4 | `Accounting/Core.lean` | `accounting.ts` 682 to 865 (the helpers, `ACCOUNTING_LIMITS`, the artifact hashes, `emptyAccountingCanonicalState`, `applyAccountingEffect`, `validAccountingDerivation`, `policyAt`, ...), `planAllocationPostings` (527 to 567) and 2165 to 2233 (the canonical values of effects and state, the hash checks, `validateAccountingEffectAdmission`, `validateAccountingEffectIdentities`) | 1 to 3 |
| 5a | `Accounting/Inventory.lean` | 866 to 1130: `calculateInventoryCost`, `calculateInventoryRecosting`, `calculateInventoryValueAdjustment`, `applyInventoryValueAdjustmentToHoldings` | 4 |
| 5b | `Accounting/Settlement.lean` | 1131 to 1281: `recognizeOpenItem`, `calculateOpenItem`, `applySettlement`, `calculateSettlement` | 4 |
| 5c | `Accounting/Basis.lean` | 1329 to 1495: the hashes of the read snapshot and population, `accountingStateHashesAreValid`, `projectAccountingBasis` | 4 |
| 5d | `Accounting/Currency.lean` | 1496 to 1542: `calculateCurrencyRemeasurement` | 4 |
| 5e | `Accounting/Schedules.lean` | 1543 to 1755: `createAllocationSchedule`, `recognizeScheduledAllocation`, `reviseAllocationSchedule` | 4 |
| 5f | `Accounting/Tax.lean` | 1756 to 2024: `determineTax` | 4 |
| 5g | `Accounting/Consolidation.lean` | 2025 to 2164: `compileConsolidation` | 4 |

`book.ts` imports `accounting.ts` and `accounting.ts` imports types from `book.ts`: Lean allows no import cycle, so the
types both need are in rows 1 to 3. If a type you need is in neither, say so on the board and model it in the lowest
file that can hold it, in a clearly marked section.

## What a modelled type is

A TypeScript `interface` is a structure with the same field names (an optional field is an `Option`, a `readonly T[]`
a `List T`, a `bigint` an `Int`, a `Record<string, T>` a list of pairs in the order of the keys as the TypeScript
builds it, a union of string literals an inductive with one constructor each, a discriminated union an inductive with
the field `kind` or `type` as the constructor). Every structure derives `DecidableEq, Repr, Inhabited`. For every
record that holds an exact number, write a `WF` predicate: the numbers in it are constructible and every identifier is
valid; the laws of the later rows are stated under it. A branded string is a structure around a `String`
(`Identifier "Kind"` from `Canonical.lean`).

## The laws, for every function

Soundness and completeness, as in wave 2, in the order of what matters to a bookkeeper:

1. **What is conserved.** Inventory cost: the cost taken from the layers equals the cost assigned, and quantity taken
   equals the quantity requested. Settlement: what is allocated never exceeds what is open on either side, and an open
   item that is settled in full is closed. Allocation schedules: the instalments add up to the allocable basis, to the
   cent. Tax: the tax lines add up to the tax of the components, by the stated rounding level. Currency remeasurement:
   the produced entries balance. Consolidation: eliminations net to zero and the compiled entries balance.
2. **What is produced is admitted.** Where a function produces journals, they satisfy what journal admission
   (`Journal/Admission.lean`) requires of a balanced journal, or the exact reason they do not is proved.
3. **Rejections.** Exactly when each diagnostic is produced, one theorem a diagnostic; a function that throws in
   TypeScript is `.error` here and the theorem says when.
4. **Hashes.** Every artifact hash is a function of the artifact's content, and two artifacts with equal hashes are
   equal or a `HashCollision` is in hand (state which fields the hash covers, and report any field it does not).
5. **Determinism and order.** Where the result depends on the order of an input list, say how (a sort key, ties as the
   stable sort leaves them); where the TypeScript says it does not, prove it.

A law that is false for what the TypeScript does is not bent: the strongest true version is proved and the gap is
reported (file, line, input, result).

## Reports

Each worker ends with: the files; what is modelled and left out; each law with its theorem name; the exact result of
the final build (errors and `sorry` warnings); every `sorry` left and why; every place the model and the TypeScript can
differ; every place the TypeScript does something a law did not expect.

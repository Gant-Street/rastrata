# Wave 4: inventory ownership and the owned-inventory command

Read `proofs/README.md` first and follow it to the letter, then `proofs/briefs/wave-3.md` (what a modelled type and a
modelled function are, the five kinds of law, what a report holds) and the head and style of
`proofs/Rastrata/Kernel/Lots.lean` and `proofs/Rastrata/Kernel/Accounting/Types.lean`.

## The module plan

| Order | Module | TypeScript | Imports |
|---|---|---|---|
| 1 | `InventoryOwnership/Types.lean` | `inventory-ownership.ts` every `interface`/`type` (lines 10 to 107, 236 to 360, 544 to 576, 776 to 800, 876 to 935, 1002 to 1135, 1445 to 1455) | Accounting/Types, Accounting/Core, InventoryPostedValues, Lots, Policy, Quantization |
| 2a | `InventoryOwnership/Reduction.lean` | 108 to 543: `reject`, `fullHash`, `referenceValid`, `precedes`, `postedAnchorVersionValid`, `hashInventoryPostedAnchor`, `hashInventoryPostedPosition`, `prepareInventoryPostedReduction`, the movement hashes, `prepareInventoryPostedAcquisitionGroup`, `prepareInventoryPostedReductionGroup` | 1 |
| 2b | `InventoryOwnership/Transfer.lean` | 544 to 875: `prepareInventoryPostedTransferGroup`, `prepareInventoryPostedAdoptionGroup` | 1, 2a |
| 2c | `InventoryOwnership/Effects.lean` | 876 to 1444: the effect hashes, `resolveInventoryOwnershipSources`, `prepareInventoryOwnershipSelection`, `prepareInventoryReductionEffect*`, `prepareInventoryOwnershipEffect*` | 1, 2a, 2b |
| 2d | `InventoryOwnership/Validation.lean` | 1445 to 1677: `sameOwnershipValue`, the `ownership*Valid` predicates, `isInventoryPostedReductionMovement`, `validateInventoryOwnershipArtifact` | 1, 2a, 2b, 2c |
| 3 | `OwnedInventoryCommand.lean` | `owned-inventory-command.ts` all 487 lines (its types need only `BookedJournal` from `Book/BaseTypes`) | InventoryOwnership/*, Book/BaseTypes |

`InventoryPostedValues.lean` (`inventory-posted-values.ts`) is written by another worker at the same time; its types
(`InventoryPostedValueBudget`, `InventoryPostedValueAllocation`) are the first things in it and build first.

## Laws

Soundness and completeness, as in wave 2, in the order of what matters to a bookkeeper:

1. **What is conserved.** A reduction: the posted value consumed plus what remains is the anchor's budget, per
   cumulative share (the laws of `InventoryPostedValues.lean` and `cumulativeShares_sum`); the quantity consumed after
   is the quantity before plus the allocation; the holding after plus the allocation is the holding before in
   quantity, basis, allowance and carrying amount, exactly. An acquisition group: the posted amounts of its entries
   add up to what the journal posts. A transfer: what leaves the source group arrives at the destination, quantity and
   posted value, nothing lost to rounding (state how a remainder is carried). Adoption: the adopted quantity and posted
   value are the supplied ones.
2. **What is produced is valid.** `validateInventoryOwnershipArtifact` accepts what every `prepare*` function returns
   `prepared` (soundness of the pair), under the hypotheses the preparing function itself checked; if some prepared
   effect fails validation, that is a finding: prove the witness and report it with the lines.
3. **Rejections.** Exactly when each diagnostic is produced (one theorem per diagnostic, as iff over the model's own
   conditions; the order of the checks is the order of the TypeScript); a function that throws in TypeScript is
   `.error` and the theorem says when.
4. **Hashes.** Every artifact hash is a function of the artifact's content; two artifacts with equal hashes are equal,
   or a `HashCollision` is in hand; state which fields a hash covers and REPORT any field it does not.
5. **Order and bounds.** Where the result depends on the order of a list (sources, entries, movements, dimension
   member ids that must be strictly increasing), say how; the bounds (`ACCOUNTING_LIMITS`) are checked where the code
   says and a population over the bound is always rejected.

A law that is false for what the TypeScript does is not bent: the strongest true version is proved and the gap is
reported (file, line, input, result).

## Reports

Each worker ends with: the files; what is modelled and left out; each law with its theorem name; the exact result of
the final build (errors and `sorry` warnings); every `sorry` left and why; every place the model and the TypeScript can
differ; every place the TypeScript does something a law did not expect.

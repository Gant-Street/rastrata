/-
Inventory ownership, row 2d of the module plan (`proofs/briefs/wave-4.md`):
`packages/kernel/src/inventory-ownership.ts` lines 1445 to 1677.

- `Validation/Model.lean`: the model of `ownershipMovementValid`,
  `ownershipAcquisitionMovementValid`, `ownershipReductionEffectValid`, `ownershipEffectValid` and
  `validateInventoryOwnershipArtifact`. Import it alone to use the definitions without building the
  laws.
- `Validation/Laws.lean`: the predicates characterised, the ordinals of a valid effect, and the header
  tests on prepared effects.

How the model was checked against the TypeScript: the effect of `InventoryOwnership/Effects.lean`
(an acquisition of two holdings and a disposal in one command) was validated under Bun and under
`#eval`, as an ownership effect, and each of its anchors, movements and after-positions as its own
kind; every answer agreed (all `true`).

What is produced is valid. Proved: a prepared ownership effect always passes the effect key,
revision and hash parts of the validator's header, and passes the header exactly when it has at most
`maxInventoryLayers` new anchors and between one and `maxInventoryLayers` movements
(`prepared_ownershipEffectHeader`); a prepared reduction effect has no new anchor and passes its
header exactly when it has between one and the bound of movements (`prepared_reductionEffectHeader`);
the cast of the reduction-only API is never reached (`prepareInventoryReductionEffect_ne_uncheckedCast`).
Not proved: that every prepared effect passes the loops of `ownershipEffectValid` and
`ownershipReductionEffectValid` (each anchor, movement, hash, recomputed share and continuation),
which rests on the laws of the four group functions. Run under Bun, the effects tried all passed: an
acquisition and a disposal in one command; two one-unit transfers, a disposal of a transferred
holding, an adoption and a disposal of the adopted holding in one command; three reductions of one
holding through the reduction-only API (valid both as a reduction effect and as an ownership effect).

A gap found (`inventory-ownership.ts` lines 1249 to 1275 against line 1579): the bounds of
`prepareInventoryOwnershipEffect` count a transfer entry once (`allocationCount`, and one unit of
source work for an entry with one item of evidence and a destination lot without evidence
identifiers), but a transfer entry produces two movements (its transfer out and its transfer in),
while `ownershipEffectValid` refuses an effect with more than `maxInventoryLayers` (10000) movements.
Input: one zero-cost holding of 5001 units from a prior revision (an anchor with one item of evidence
and no source posting), and 5001 transfer operations of one unit each, with no journal link. Result:
`prepareInventoryOwnershipEffect` returns `prepared` with 5001 new anchors and 10002 movements, and
`validateInventoryOwnershipArtifact("ownershipEffect", effect)` returns `false`; with 5000 transfers,
10000 movements, it returns `true`. The model has the same gap: `ownershipEffectValid_over_cap`.
-/
import Rastrata.Kernel.InventoryOwnership.Validation.Model
import Rastrata.Kernel.InventoryOwnership.Effects
import Rastrata.Kernel.InventoryOwnership.Validation.Laws

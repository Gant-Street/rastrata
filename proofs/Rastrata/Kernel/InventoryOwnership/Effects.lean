/-
Inventory ownership, row 2c of the module plan (`proofs/briefs/wave-4.md`):
`packages/kernel/src/inventory-ownership.ts` lines 876 to 1443.

- `Effects/Model.lean`: the model of the effect hashes, `resolveInventoryOwnershipSources`,
  `prepareInventoryOwnershipSelection`, `prepareInventoryOwnershipEffect` and its read-context and
  reduction-only forms, with `ownershipCoordinateValid`, `ownershipPositionValid` and
  `ownershipAnchorValid`, which resolution calls. Import it alone to use the definitions without
  building the laws.
- `Effects/Hashes.lean`: the effect hashes are functions of content, injective up to a collision.
- `Effects/Validity.lean`: the validity of coordinates, positions and anchors, characterised.
- `Effects/Resolution.lean`: what resolved sources guarantee, and when resolution rejects.
- `Effects/Selection.lean`: what a selection guarantees, and when it rejects.
- `Effects/Effect.lean`: what a prepared effect is, and the reduction-only API's cast.

How the model was checked against the TypeScript: under Bun on the real `packages/kernel/src`
functions and under `#eval` on this model, with the same inputs: an effect of an acquisition of two
holdings and a disposal of one of them in the same command (the effect's content hash, its anchors
and movements in ordinal order, the holdings and positions after it, all agreed); the resolution of
the acquired holding through a read context, and four rejections of it (no after-image, a pinned
revision before the origin, an absent holding, a repeated holding); and a selection by first in first
out from a pool of two holdings, one with an allowance (the policy hash, every allocation's
quantity, basis, allowance and carrying amount, and the totals), with three rejections (identities
missing, a shortage under a rejecting policy, a repeated pool row). Every value agreed.
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Model
import Rastrata.Kernel.InventoryOwnership.Effects.Hashes
import Rastrata.Kernel.InventoryOwnership.Effects.Validity
import Rastrata.Kernel.InventoryOwnership.Effects.Resolution
import Rastrata.Kernel.InventoryOwnership.Effects.Selection
import Rastrata.Kernel.InventoryOwnership.Effects.Effect

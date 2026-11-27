/-
Inventory ownership, row 2a of the module plan (`proofs/briefs/wave-4.md`):
`packages/kernel/src/inventory-ownership.ts` lines 108 to 543.

- `Reduction/Canonical.lean`: what `canonicalAccountingValue` writes for every artifact of the
  module (anchors, positions, references, coordinates, movements, and the lots, holdings,
  allocations, shares and posted values they hold).
- `Reduction/Model.lean`: the model of `reject`, `fullHash`, `referenceValid`, `precedes`,
  `postedAnchorVersionValid`, `sameOwnershipValue`, the anchor, position and movement hashes,
  `prepareInventoryPostedReduction`, `prepareInventoryPostedAcquisitionGroup` and
  `prepareInventoryPostedReductionGroup`.
- `Reduction/Lawful.lean`: every canonical value of an ownership artifact is well formed and
  determines the artifact (`LawfulCanonicalize`).
- `Reduction/Basic.lean`: the helpers as statements, and the laws of the four hashes.
- `Reduction/Prepared.lean`, `Reduction/Laws.lean` and `Reduction/Rejections.lean`: the laws of
  `prepareInventoryPostedReduction`: what a prepared reduction conserves, and exactly when each
  rejection is produced.
- `Reduction/ReductionGroup.lean` and `Reduction/Acquisition.lean`: what a prepared reduction group
  and a prepared acquisition group conserve, and the posting each is tied to.
- `Reduction/Errors.lean`: when a reduction throws.

How the model was checked against the TypeScript: an acquisition group of two holdings with a
journal-linked posting, a reduction group of one disposal with its journal, a transfer group of
one holding (from a `1.0.0` and from a `1.1.0` anchor) and an adoption group of two holdings were
run under Bun on the real `packages/kernel/src` functions and under `#eval` on this model with the
same inputs; every content hash (anchors, positions, movements, posting references), every posted
amount and every remaining holding value agreed.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Canonical
import Rastrata.Kernel.InventoryOwnership.Reduction.Lawful
import Rastrata.Kernel.InventoryOwnership.Reduction.Model
import Rastrata.Kernel.InventoryOwnership.Reduction.Basic
import Rastrata.Kernel.InventoryOwnership.Reduction.Prepared
import Rastrata.Kernel.InventoryOwnership.Reduction.Laws
import Rastrata.Kernel.InventoryOwnership.Reduction.Rejections
import Rastrata.Kernel.InventoryOwnership.Reduction.ReductionGroup
import Rastrata.Kernel.InventoryOwnership.Reduction.Acquisition
import Rastrata.Kernel.InventoryOwnership.Reduction.Errors

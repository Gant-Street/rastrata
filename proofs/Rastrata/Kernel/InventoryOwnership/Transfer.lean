/-
Inventory ownership, row 2b of the module plan (`proofs/briefs/wave-4.md`):
`packages/kernel/src/inventory-ownership.ts` lines 544 to 875.

- `Transfer/Model.lean`: the model of `prepareInventoryPostedTransferGroup` and
  `prepareInventoryPostedAdoptionGroup`.
- `Transfer/Laws.lean`: what a prepared transfer group conserves.
- `Transfer/Adoption.lean`: what a prepared adoption group adopts.
- `Transfer/GroupRejections.lean`: the rejections of the four group functions before their loops
  (with those of the acquisition and reduction groups of `Reduction.lean`), and
  `Transfer/TransferRejections.lean` for the transfer group.
- `Transfer/Findings.lean`: what the TypeScript does that the laws did not expect.
- `Transfer/PostingRejections.lean`: the posting rejections of the reduction group.
- The other laws, in the other files of `Transfer/`.

The model was checked against the TypeScript with the runs described in
`InventoryOwnership/Reduction.lean`.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction
import Rastrata.Kernel.InventoryOwnership.Transfer.Model
import Rastrata.Kernel.InventoryOwnership.Transfer.Laws
import Rastrata.Kernel.InventoryOwnership.Transfer.Adoption
import Rastrata.Kernel.InventoryOwnership.Transfer.GroupRejections
import Rastrata.Kernel.InventoryOwnership.Transfer.TransferRejections
import Rastrata.Kernel.InventoryOwnership.Transfer.Findings
import Rastrata.Kernel.InventoryOwnership.Transfer.PostingRejections

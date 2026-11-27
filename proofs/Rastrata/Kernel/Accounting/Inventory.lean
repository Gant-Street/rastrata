/-
The inventory module of `packages/kernel/src/accounting.ts`, lines 866 to 1129: costing an issue of
inventory, recosting a provisional layer, adjusting the value of inventory.

Files (`Accounting/Inventory/`): `Model.lean` is the model (the request and result types, and
`calculateInventoryCost`, `calculateInventoryRecosting`, `applyInventoryValueAdjustmentToHoldings`,
`calculateInventoryValueAdjustment` and `createProvisionalInventoryLayerEffect`, with the pieces each is
cut into in `Rastrata.Kernel.Inventory`); `Support.lean` the lemmas the laws share; `CostLaws.lean`,
`RecostingLaws.lean`, `AdjustmentLaws.lean` and `HashLaws.lean` the laws. This file imports them all.
Other modules import `Model.lean` for the request types.

## How the TypeScript is modelled

- The same checks in the same order, the same diagnostics (code, path, message, requirement
  identifiers) in the same order. Every exact-number operation that can throw returns `.error`: with the
  `NumErr` of `numeric.ts` for `calculateInventoryCost`, `calculateInventoryRecosting` and
  `applyInventoryValueAdjustmentToHoldings`; with `InventoryAdjustmentErr` for
  `calculateInventoryValueAdjustment`, which can also throw the `RangeError` of `quantize` (a scale
  outside 0 to 1000) and the identity conflict of `identifier<...>()` when it forms a posting or journal
  identifier from the request's identifier. The messages of exceptions are not modelled.
- `Array.prototype.sort` is a stable insertion sort (`Lots.stableSort` where the comparator can throw:
  the unit cost of highest cost first; `Inventory.sortBy` where it cannot). The engine's choice of pairs
  to compare cannot change the outcome here: with two layers or more every layer is compared at least
  once, so a division that exceeds the size limit throws in the model exactly when it does there.
- A `Map` answers with its last entry for a key and a `Set` counts each value once (`Lots.mapGet`,
  `Lots.setSize`). Instants and identifiers compare as texts by UTF-16 code unit. `Date.parse` is the
  model of `Accounting/Core/Model.lean` (`validAccountingDerivation`). The key
  `JSON.stringify([lotId, holdingId ?? null])` of algorithm 1.0.2 is modelled as the pair, which the
  text encodes without loss; the text `${lotId}:${holdingId ?? "disposed"}` of the earlier algorithms is
  modelled as that text (it can coincide for different pairs).
- `Object.freeze` and object identity are not modelled. Nothing else of lines 866 to 1129 is left out.

## The laws (each theorem has its plain sentence where it is stated)

Cost, `calculateInventoryCost`:
- quantity: `calculateInventoryCost_quantity` (taken plus short is the request), `_shortage` (short is the
  request less what the method may take from; not zero only if the policy allows it), `_layers` (the
  allocations name distinct layers of the request: the others are left alone), `_remaining` (no layer is
  over-drawn);
- cost: `_ordinaryBasis` (the ordinary basis is the sum of the allocations' bases; each allocation's basis
  is its layer's total basis times the quantity taken over the layer's quantity, the whole total basis for
  a layer taken whole), `_weightedAverage` (every layer in proportion, in identifier order),
  `_provisionalBasis` (what a shortage adds, by method), `_wf`;
- order: `_fifo`, `_lifo`, `_hifo`, `_specific` (a later layer is never taken from while an earlier one has
  quantity left), with `costOrder_fifo`, `costOrder_lifo`, `costOrder_hifo` (the sorted order, ties by
  identifier), `lastReceipt_spec`, `provisionalRateOf_spec`;
- rejections, one theorem a reason and a unified one: `_rejected_iff`, `_incoherent_iff`
  (`costIncoherent_iff`, `costCoherent_iff`), `_specific_iff`, `_shortage_iff`, `_rate_iff`
  (`rateRejected_iff`);
- errors: `calculateInventoryCost_error` (only the size limit).

Recosting, `calculateInventoryRecosting`: `_adjustment` (the difference is the actual cost less the
provisional cost, exactly; no journal), `_settledOnce` and `_full` (a layer is recosted up to its quantity
and no further), `_rejected_iff` (with `recostingRejected_iff`), `_error`.

Value adjustment, `calculateInventoryValueAdjustment` and `applyInventoryValueAdjustmentToHoldings`:
`_balanced` (the journal balances, exactly), `_conservation` (the allocations add up to the amount; what a
write-down, a reversal and each capitalized kind allows), `_holdings` (holdings after, `HoldingAfter`;
carrying amount is basis plus allowance before and after; nothing below zero after), `_writeDown_holdings`
(a write-down changes only the allowance), `_effect`, `_identity` (what a drafted adjustment rests on),
`_rejected_iff` and `adjustmentRejection_some_iff` (every rejection and its diagnostic),
`_never_combined` (the diagnostic of line 1081 is unreachable), `_error` (the size limit, the scale of the
rounding, an identity conflict); `applyInventoryValueAdjustmentToHoldings_spec` and `_error`.

Hashes, `HashLaws.lean`: `createProvisionalInventoryLayerEffect_valid`, `recostingEffect_valid` and
`adjustmentEffect_valid` (every effect these functions create carries the hash of its body, and
`validateAccountingEffectHash` accepts it), `_contentHash`, `calculateInventoryRecosting_effects_valid`,
`calculateInventoryValueAdjustment_effects_valid`, and `inventory_effects_hash_inj` (two such effects with
one hash are one effect, or a `HashCollision` is in hand).

Depends on the laws of `Accounting/Core`: `eq_of_validateAccountingEffectHash` (`Core/Effects.lean`),
`InventoryRecosting.bodyValue_contentHash` and `InventoryValueAdjustment.bodyValue_contentHash`
(`Core/Hashes.lean`), `canonicalize_object` (`Core/Canonical.lean`), and what they rest on.

## Checked against the TypeScript

The model was run on the same inputs as the shipped function (a one-off script against
`packages/kernel/src`, and `#eval` here): twenty-six costings (every method, every provisional method,
shortages, a specific selection with a repeat, ties in time and in unit cost, a policy not yet valid, an
unsupported capability, a layer outside the pools, a negative basis, a repeated layer, an exact boundary,
a fractional quantity), fifteen adjustments (every kind, a disposed lot, a reversal beyond the
write-down, the legacy key collision, a scale out of range, one that posts to all three accounts), three
recostings (one drafted, one reusing a receipt, one refused as over-allocated); every outcome, diagnostic
path or message, allocation and posting agreed, and the content hashes of the three effects agreed digit
for digit.
-/
import Rastrata.Kernel.Accounting.Inventory.Model
import Rastrata.Kernel.Accounting.Inventory.Support
import Rastrata.Kernel.Accounting.Inventory.CostLaws
import Rastrata.Kernel.Accounting.Inventory.RecostingLaws
import Rastrata.Kernel.Accounting.Inventory.AdjustmentLaws
import Rastrata.Kernel.Accounting.Inventory.HashLaws

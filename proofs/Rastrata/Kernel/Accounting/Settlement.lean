/-
Open items and settlements: the Lean model of `packages/kernel/src/accounting.ts` lines 1131 to
1281 (`recognizeOpenItem`, `calculateOpenItem`, `settlementReadContext`, `settlementIdentityPresent`,
`applySettlement`, `calculateSettlement`) and its laws.

The model does what the TypeScript does, with the same tests in the same order, the same diagnostics
(code, path, message and requirement identifiers) and the same exact-number operations in the same
order, so that the first one that throws is the one that is returned. It was run against the real
`packages/kernel/src` on the same inputs (the last section of this file): fifty-eight requests, every
rejection and every way a request goes wrong, give the same diagnostic, the same effects with the
same content hashes, and the same error; one only, an application time that is a bare date, differs
(below).

Where the model differs from the TypeScript in form:

- A test of something the types guarantee passes: that an `operation` is one of the two strings
  (line 1208), that the identity observations are `"present"` or `"absent"` (line 1197), that
  `existingSettlement` and `openItem` do not answer `undefined` (lines 1217 and 1229), that the
  totals are `ExactRational`s (lines 1221 and 1231). A negative total is a `TypeError` of the
  TypeScript and `.incompletePriorSettlementTotals` and `.incompleteSettlementTotals` here.
- `SettlementRequest` is flat (`Accounting/Types.lean`), so the test of line 1208 of the combination
  of `operation` and `appliedAt` is made. An absent `appliedAt` for `allocateExisting` is
  `Date.parse(undefined)`, `NaN`.
- What throws is `.error` of a `SettlementErr`: an exact-number error, the `RangeError` of `quantize`,
  or one of the two `TypeError`s. The `identity` function of `calculateOpenItem` is a value, because
  a total function without effects is called at most once and the TypeScript calls it after the
  tests before it.
- A `Map` read with `get` is a list with the newest entry first (`settlementMapGet`,
  `settlementMapSet`); the `Map` of open items keeps the first item of an identifier, the `Map` of
  settlements the last (`settlementFact`).
- Strings compare by UTF-16 code unit (`jsStringLt`, `jsStringLe`, `jsSliceTen` for `slice(0, 10)`).
  `Date.parse` is `dateParse` (`Policy/Types.lean`): it answers for the texts `instant` accepts, and
  `none` for the others, which the engines read in many more ways; an application time that is such
  a text (`"2026-01-21"`) is refused here and accepted by the TypeScript.
- A JavaScript object may carry properties its type does not name, and the hash of an allocation
  covers every own property; a Lean structure has exactly its fields.
- `recognizeOpenItem` and `settlementReadContext` take the whole `AccountingCanonicalState`; the
  TypeScript takes the `Pick` of the collections it reads.
- `Object.freeze` and the object identity of the results are not modelled.

The laws, in the order of what matters to a bookkeeper:

1. What a settlement allocates never exceeds what is open on either side
   (`calculateSettlement_open_bound`, `calculateSettlement_settlement_bound`, and over the state
   `applySettlement_open_bound`, `applySettlement_settlement_bound`); each allocation is the exact
   proportion of the quantity on each side (`calculateSettlement_allocations`,
   `calculateSettlement_settlement_share`), so that a settlement or an open item allocated in full in
   quantity is allocated in full in value, with no remainder
   (`calculateSettlement_settlement_in_full`, `calculateSettlement_open_item_in_full`), and what
   remains of an open item is what remained less what is allocated
   (`calculateSettlement_open_item_remaining`); the realized difference is recorded without loss
   (`calculateSettlement_quantization`); the draft holds no journal
   (`calculateSettlement_journals`); the effects have the hash of their body
   (`calculateSettlement_hashes`); applying them adds exactly them (`calculateSettlement_applied`).
2. An open item is recognized once, with the amounts, side and scope it states, and the hash of its
   body (`calculateOpenItem_draft`, `recognizeOpenItem_recorded_once`, `calculateOpenItem_hash`).
3. The read context answers what the state's lists say (`settlementReadContext_openItem` and the
   theorems after it), and the result of `calculateSettlement` depends on nothing else
   (`calculateSettlement_congr`).
4. One theorem for each rejection says exactly when it is returned
   (`calculateOpenItem_eq_rejection_iff`, `calculateSettlement_application_rejected_iff` and the six
   after it), with the meaning of the tests they name; and the only errors are the size limit, the
   `RangeError` of the scale of a quantization policy and the `TypeError`s of negative totals
   (`calculateSettlement_error_limit`, `applySettlement_error_limit`), the `TypeError`s exactly when
   their conditions hold (`calculateSettlement_incompletePrior_iff`,
   `calculateSettlement_incompleteTotals_iff`).
-/
import Rastrata.Kernel.Accounting.Core

namespace Rastrata.Kernel

/-! ## Errors -/

/-- What `calculateSettlement` and `applySettlement` throw: an `ExactNumberError` of `numeric.ts`,
the `RangeError` of `quantize`, or one of the two `TypeError`s of lines 1222 and 1232 (a read context
whose totals are negative). -/
inductive SettlementErr where
  | exactNumber (code : NumErr)
  | scaleOutOfRange
  | incompletePriorSettlementTotals
  | incompleteSettlementTotals
  deriving DecidableEq, Repr, Inhabited

/-- A `quantize` error as an error of `calculateSettlement`. -/
def SettlementErr.ofQuantize : QuantizeErr → SettlementErr
  | .scaleOutOfRange => .scaleOutOfRange
  | .exactNumber code => .exactNumber code

/-! ## The rejections (`accounting.ts` lines 1138 and 1211 to 1259)

Each is the call `reject("settlement_allocation_violation", path, message, requirements)`. -/

/-- The rejection of `calculateOpenItem` (line 1138). -/
def openItemRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.openItem"
    "Open item must have unique identity, approved lineage, and nonzero exact values" ["ACC-041.1"]

/-- The rejection of line 1211: the operation and the application time are not coherent. -/
def settlementApplicationRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement.application"
    "Settlement operation and application time must be explicit and coherent"
    ["ACC-041.3", "ACC-041.6"]

/-- The rejection of line 1212: the identity, the evidence, the sizes or the party of the settlement
are not acceptable. -/
def settlementIdentityRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement"
    "Settlement identity must be unique, evidenced, and contain positive exact denomination and book value"
    ["ACC-041.1", "ACC-041.3"]

/-- The rejection of line 1219: a later allocation does not retain the original settlement. -/
def retainedSettlementRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement"
    "Later allocation must retain the exact original settlement" ["ACC-041.1", "ACC-041.4"]

/-- The rejection of line 1237: an allocation applied before its open item was recognized. -/
def allocationBeforeRecognitionRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement.application"
    "Allocation cannot precede its open-item recognition" ["ACC-041.3", "ACC-041.6"]

/-- The rejection of line 1239: the allocation is out of scope or exceeds what is open. -/
def allocationScopeRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement.allocations"
    "Settlement allocation violates scope or exact conservation" ["ACC-041.2", "ACC-041.4"]

/-- The rejection of line 1254: the allocation does not carry the values it must. -/
def allocationValueRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement.allocations"
    "Settlement allocation must conserve each side's proportional carrying value, derive functional-currency settlement measurement through a dated valuation path, and bind any realized difference to a generated effect"
    ["ACC-041.2", "ACC-041.5", "ACC-041.6"]

/-- The rejection of line 1259: the allocations exceed the settlement's book value. -/
def overAllocationRejection : AccountingCalculation :=
  reject .settlement_allocation_violation "command.settlement.allocations"
    "Settlement is over-allocated" ["ACC-041.4"]

/-! ## Open items (`accounting.ts` lines 1131 to 1141) -/

/-- `settlementIdentityPresent` (line 1196). The `TypeError` for an observation that is neither
`"present"` nor `"absent"` cannot happen: `IdentityObservation` has no third value. -/
def settlementIdentityPresent : IdentityObservation → Bool
  | .present => true
  | .absent => false

/-- The condition of line 1138, from the left: the derivation is not approved, the book value or the
denomination is zero, or the identity is present. The TypeScript passes the observation as a function
that it calls only when the first three tests have passed; a total function without effects makes
that unobservable, so the observation is passed as a value. -/
def openItemRefused (identity : IdentityObservation) (request : OpenItemRecognitionRequest) : Bool :=
  !validAccountingDerivation request.value.derivation || !positive request.value.bookValue.abs ||
    !positive request.value.denomination.abs || settlementIdentityPresent identity

/-- `calculateOpenItem` (line 1137). The open item carries `accountingHash("OpenItem", value)`. -/
def calculateOpenItem (identity : IdentityObservation) (request : OpenItemRecognitionRequest) :
    AccountingCalculation :=
  if openItemRefused identity request then openItemRejection
  else
    drafted []
      [.openItem { toOpenItemBody := request.value,
                   contentHash := accountingHash "OpenItem" request.value }]

/-- `recognizeOpenItem` (line 1134). The TypeScript takes `Pick<AccountingCanonicalState,
"openItems">`; the whole state is passed here. -/
def recognizeOpenItem (state : AccountingCanonicalState) (request : OpenItemRecognitionRequest) :
    AccountingCalculation :=
  calculateOpenItem (if state.openItems.any (·.id == request.value.id) then .present else .absent)
    request

/-! ## The read context (`accounting.ts` lines 1167 to 1195) -/

/-- The totals `{ bookValue: zero, quantity: zero }` the context answers for an identifier it has
not seen (lines 1176, 1181, 1191 and 1193). -/
def AllocatedTotal.zero : AllocatedTotal := ⟨ExactRational.zero, ExactRational.zero⟩

/-- `map.get(key)` of a JavaScript `Map` that is only read with `get`: `set` puts the newest entry
first, so the first entry of a key is the last one set. -/
def settlementMapGet {κ α : Type} [BEq κ] (entries : List (κ × α)) (key : κ) : Option α :=
  (entries.find? (·.1 == key)).map (·.2)

/-- `map.set(key, value)`, for a map that is only read with `get`. -/
def settlementMapSet {κ α : Type} (entries : List (κ × α)) (key : κ) (value : α) : List (κ × α) :=
  (key, value) :: entries

/-- `settlementFacts.get(id)` (lines 1171 and 1190): `new Map(entries)` keeps the last entry of a
repeated key, so the settlement is the last one of the state with the identifier. -/
def settlementFact (settlements : List Settlement) (id : SettlementId) : Option Settlement :=
  (settlements.filter (·.id == id)).getLast?

/-- `settlement.bookValue.abs().multiply(quantity).divide(settlement.denomination.abs())`
(lines 1184, 1243, 1245 and 1259): the part of a book value that a quantity of the denomination
carries. -/
def proportionalShare (bookValue denomination quantity : ExactRational) :
    Except NumErr ExactRational :=
  match bookValue.abs.multiply quantity with
  | .error e => .error e
  | .ok product => product.divide denomination.abs

/-- The value `measured` of line 1183: the settlement's book value an allocation carries, as it
records it, or as its quantity says when the settlement is in the state, or as its open item's
carrying value when it is not. -/
def paidMeasure (settlements : List Settlement) (item : SettlementAllocation) :
    Except NumErr ExactRational :=
  match item.allocatedSettlementBookValue with
  | some value => .ok value
  | none =>
    match settlementFact settlements item.settlementId with
    | none => .ok item.allocatedBookValue
    | some settlement =>
      proportionalShare settlement.bookValue settlement.denomination item.allocatedSettlementQuantity

/-- The two maps `allocated` and `paid` of `settlementReadContext` (lines 1173 and 1174). -/
structure SettlementContextTotals where
  allocated : List (OpenItemId × AllocatedTotal)
  paid : List (SettlementId × AllocatedTotal)

/-- The body of the loop of lines 1175 to 1186 for one allocation: the allocated totals of its open
item, then the paid totals of its settlement, each addition as the TypeScript evaluates it, from the
first to the last; the first that throws ends it. -/
def contextStep (settlements : List Settlement) (totals : SettlementContextTotals)
    (item : SettlementAllocation) : Except NumErr SettlementContextTotals :=
  let prior := (settlementMapGet totals.allocated item.openItemId).getD AllocatedTotal.zero
  match prior.bookValue.add (item.allocatedOpenItemBookValue.getD item.allocatedBookValue) with
  | .error e => .error e
  | .ok bookValue =>
    match prior.quantity.add item.allocatedOpenQuantity with
    | .error e => .error e
    | .ok quantity =>
      let source := (settlementMapGet totals.paid item.settlementId).getD AllocatedTotal.zero
      match paidMeasure settlements item with
      | .error e => .error e
      | .ok measured =>
        match source.bookValue.add measured with
        | .error e => .error e
        | .ok sourceBookValue =>
          match source.quantity.add item.allocatedSettlementQuantity with
          | .error e => .error e
          | .ok sourceQuantity =>
            .ok { allocated := settlementMapSet totals.allocated item.openItemId ⟨bookValue, quantity⟩
                  paid := settlementMapSet totals.paid item.settlementId ⟨sourceBookValue, sourceQuantity⟩ }

/-- The loop of lines 1175 to 1186: every prior allocation of the state, in order. -/
def contextTotals (settlements : List Settlement) :
    SettlementContextTotals → List SettlementAllocation → Except NumErr SettlementContextTotals
  | totals, [] => .ok totals
  | totals, item :: rest =>
    match contextStep settlements totals item with
    | .error e => .error e
    | .ok next => contextTotals settlements next rest

/-- `settlementReadContext` (line 1167). The TypeScript builds every total before it returns, so a
sum that throws makes the call throw; the six answers are then read from what was built. The
`openItem` answer is the first item of the state with the identifier (line 1169), the
`existingSettlement` answer the last settlement (line 1171). The TypeScript takes
`Pick<AccountingCanonicalState, "openItems" | "settlements" | "settlementAllocations">`; the whole
state is passed here. -/
def settlementReadContext (state : AccountingCanonicalState) :
    Except NumErr SettlementReadContext :=
  match contextTotals state.settlements ⟨[], []⟩ state.settlementAllocations with
  | .error e => .error e
  | .ok totals =>
    .ok { openItem := fun id => state.openItems.find? (·.id == id)
          settlementIdentity := fun id =>
            if state.settlements.any (·.id == id) then .present else .absent
          allocationIdentity := fun id =>
            if state.settlementAllocations.any (·.id == id) then .present else .absent
          existingSettlement := fun id => settlementFact state.settlements id
          allocatedFromSettlement := fun id =>
            (settlementMapGet totals.paid id).getD AllocatedTotal.zero
          allocatedToOpenItem := fun id =>
            (settlementMapGet totals.allocated id).getD AllocatedTotal.zero }

/-! ## `calculateSettlement`: the tests before the allocations (`accounting.ts` lines 1205 to 1223) -/

/-- `request.operation === "allocateExisting"` (line 1206). -/
def SettlementRequest.existing (request : SettlementRequest) : Bool :=
  request.operation == some .allocateExisting

/-- `request.operation === "recognizeUnallocated"` (line 1207). -/
def SettlementRequest.unallocated (request : SettlementRequest) : Bool :=
  request.operation == some .recognizeUnallocated

/-- `Object.freeze({ ...request.settlement, contentHash: accountingHash("Settlement",
request.settlement) })` (line 1213): the settlement with the hash of its body. -/
def SettlementRequest.hashedSettlement (request : SettlementRequest) : Settlement :=
  { toSettlementBody := request.settlement,
    contentHash := accountingHash "Settlement" request.settlement }

/-- `text.slice(0, 10)`: the first ten UTF-16 code units of the text. -/
def jsSliceTen (text : String) : List UInt16 := (stringToUTF16 text).take 10

/-- The condition of lines 1208 to 1210, from the left. Its first disjunct,
`request.operation !== undefined && !existing && !unallocated`, is always false here: an
`operation` is one of the two. An application time is wanted exactly for `allocateExisting`: for it,
`Date.parse` must read it (an absent time is `Date.parse(undefined)`, which is `NaN`) and it must not
be below the settlement's time, as texts; for the others no request or allocation may carry one; and
an allocation that carries one carries the request's. -/
def settlementApplicationIncoherent (request : SettlementRequest) : Bool :=
  (!request.existing && request.appliedAt.isSome) ||
  (request.existing &&
    (match request.appliedAt with
      | none => true
      | some appliedAt =>
        (dateParse appliedAt.value).isNone ||
          jsStringLt appliedAt.value request.settlement.settledAt.value)) ||
  request.allocations.any fun allocation =>
    allocation.appliedAt.isSome && (!request.existing || allocation.appliedAt != request.appliedAt)

/-- The condition of line 1212, from the left: the derivation is not approved; the settlement is
present exactly when it is not being created; the allocations are not none for a recognition of an
unallocated settlement, or none for the others; there are more allocations than the limit; two
allocations have the same identifier; an allocation identifier is present in the state; the
denomination or the book value is not positive; or the party is blank. -/
def settlementIdentityInvalid (context : SettlementReadContext) (request : SettlementRequest) :
    Bool :=
  !validAccountingDerivation request.settlement.derivation ||
  (settlementIdentityPresent (context.settlementIdentity request.settlement.id) !=
    request.existing) ||
  (if request.unallocated then request.allocations.length != 0
    else request.allocations.length == 0) ||
  decide (request.allocations.length > accountingLimits.maxSettlementAllocations) ||
  !decide ((request.allocations.map (·.id)).Nodup) ||
  request.allocations.any (fun item => settlementIdentityPresent (context.allocationIdentity item.id)) ||
  !positive request.settlement.denomination.abs || !positive request.settlement.bookValue.abs ||
  (jsTrim request.settlement.scope.externalPartyId).length == 0

/-- What lines 1214 to 1223 leave: the rejection of line 1219, or the totals already allocated from
the settlement (none for a settlement that is being created). -/
inductive SettlementPrevious where
  | mismatch
  | totals (previous : AllocatedTotal)
  deriving DecidableEq, Repr, Inhabited

/-- A `NumErr` as an error of `calculateSettlement`. -/
def liftNum {α : Type} (result : Except NumErr α) : Except SettlementErr α :=
  match result with
  | .ok value => .ok value
  | .error code => .error (.exactNumber code)

/-- A `QuantizeErr` as an error of `calculateSettlement`. -/
def liftQuantize {α : Type} (result : Except QuantizeErr α) : Except SettlementErr α :=
  match result with
  | .ok value => .ok value
  | .error error => .error (SettlementErr.ofQuantize error)

/-- Lines 1214 to 1223. For `allocateExisting` the context must answer the settlement that was
recorded, its content hash must be the request's and the hash of its own body, else the allocation is
rejected (line 1219); the totals the context gives are then read, and a negative one is a `TypeError`
(line 1222). The tests of line 1221 that the totals are `ExactRational`s are of the type. -/
def previousSettlementTotals (context : SettlementReadContext) (settlement : Settlement)
    (existing : Bool) : Except SettlementErr SettlementPrevious :=
  if !existing then .ok (.totals AllocatedTotal.zero)
  else
    match context.existingSettlement settlement.id with
    | none => .ok .mismatch
    | some retained =>
      if !contentHashEquals retained.contentHash settlement.contentHash then .ok .mismatch
      else
        match validateAccountingEffectHash (.settlement retained) with
        | .error e => .error (SettlementErr.ofQuantize e)
        | .ok false => .ok .mismatch
        | .ok true =>
          let previous := context.allocatedFromSettlement settlement.id
          if previous.bookValue.isNegative || previous.quantity.isNegative then
            .error .incompletePriorSettlementTotals
          else .ok (.totals previous)

/-! ## `calculateSettlement`: one allocation (`accounting.ts` lines 1224 to 1258) -/

/-- The three working values of the loop: `pendingByOpenItem` and `pendingOpenQuantity` (lines 1224
and 1225), read with `get` only, and `pendingSettlementQuantity` (line 1226). -/
structure SettlementPending where
  byOpenItem : List (OpenItemId × ExactRational)
  openQuantity : List (OpenItemId × ExactRational)
  settlementQuantity : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- What one pass of the loop does: it goes on with new working values, or it returns a rejection. -/
inductive SettlementStep where
  | next (pending : SettlementPending)
  | rejected (rejection : AccountingCalculation)
  deriving DecidableEq, Repr, Inhabited

/-- The test of line 1236: for `allocateExisting`, the open item was recognized on a date after the
date of the application time (its first ten characters), compared as texts. An application time that
is absent is not reached: line 1209 has rejected it. -/
def recognizedAfterApplication (request : SettlementRequest) (item : Option OpenItem) : Bool :=
  request.existing &&
    (match item, request.appliedAt with
      | some item, some appliedAt =>
        compare (stringToUTF16 item.recognizedOn.value) (jsSliceTen appliedAt.value) == .gt
      | _, _ => false)

/-- The clauses of line 1238 that look at no sum, from the left: the allocation is for another
settlement, is not approved, is for an open item of another book, party or control account, has a
book value or a quantity that is not positive, or states an open item book value that is not its
book value. `true` rejects. -/
def allocationScopeClauses (settlement : Settlement) (allocation : SettlementAllocationBody)
    (item : OpenItem) : Bool :=
  allocation.settlementId != settlement.id ||
    !validAccountingDerivation allocation.derivation ||
    item.bookId != settlement.bookId ||
    item.scope.externalPartyId != settlement.scope.externalPartyId ||
    item.scope.controlAccountId != settlement.scope.controlAccountId ||
    !positive allocation.allocatedBookValue || !positive allocation.allocatedOpenQuantity ||
    !positive allocation.allocatedSettlementQuantity ||
    (match allocation.allocatedOpenItemBookValue with
      | some value => !value.equals allocation.allocatedBookValue
      | none => false)

/-- The three clauses of line 1238 that add, each evaluated as the TypeScript does, from the left,
stopping at the first that holds: the open item's allocated book value, its allocated quantity or
the settlement's allocated quantity, with this allocation, goes beyond what the open item or the
settlement holds. `true` rejects; a sum that throws ends it. -/
def allocationCapacityExceeded (settlement : Settlement) (allocation : SettlementAllocationBody)
    (item : OpenItem) (prior : AllocatedTotal) (pendingBookValue pendingQuantity
      pendingSettlementQuantity : ExactRational) : Except NumErr Bool :=
  match prior.bookValue.add pendingBookValue with
  | .error e => .error e
  | .ok priorAndPending =>
    match priorAndPending.add allocation.allocatedBookValue with
    | .error e => .error e
    | .ok bookValueTotal =>
      if bookValueTotal.compare item.bookValue.abs == .gt then .ok true
      else
        match prior.quantity.add pendingQuantity with
        | .error e => .error e
        | .ok priorAndPendingQuantity =>
          match priorAndPendingQuantity.add allocation.allocatedOpenQuantity with
          | .error e => .error e
          | .ok quantityTotal =>
            if quantityTotal.compare item.denomination.abs == .gt then .ok true
            else
              match pendingSettlementQuantity.add allocation.allocatedSettlementQuantity with
              | .error e => .error e
              | .ok settlementQuantityTotal =>
                .ok (settlementQuantityTotal.compare settlement.denomination.abs == .gt)

/-- The test of line 1238: the clauses that look at no sum, then the three that add. -/
def allocationScopeViolated (settlement : Settlement) (allocation : SettlementAllocationBody)
    (item : OpenItem) (prior : AllocatedTotal) (pendingBookValue pendingQuantity
      pendingSettlementQuantity : ExactRational) : Except NumErr Bool :=
  if allocationScopeClauses settlement allocation item then .ok true
  else
    allocationCapacityExceeded settlement allocation item prior pendingBookValue pendingQuantity
      pendingSettlementQuantity

/-- `pathCoherent` (line 1248): for an open item and a settlement of one commodity, the allocation
carries no valuation path; for two commodities it carries a path from the settlement's commodity to
the request's functional commodity, with a positive rate, evidence, observed no later than the
settlement (as texts) and effective on the settlement's date (its first ten characters), and the
settlement's book value is the quantity at the rate. The product is evaluated only if the other
clauses hold, and may throw. -/
def pathCoherent (request : SettlementRequest) (settlement : Settlement) (item : OpenItem)
    (allocation : SettlementAllocationBody)
    (allocatedSettlementQuantity allocatedSettlementBookValue : ExactRational) :
    Except NumErr Bool :=
  if item.denominationCommodityId == settlement.denominationCommodityId then
    .ok allocation.valuationPath.isNone
  else
    match allocation.valuationPath, request.quantizationPolicy with
    | some path, some policy =>
      if path.fromCommodityId == settlement.denominationCommodityId &&
          path.toCommodityId == policy.functionalCommodityId && positive path.rate &&
          decide (path.evidenceIds.length > 0) &&
          jsStringLe path.observedAt.value settlement.settledAt.value &&
          decide (jsSliceTen path.effectiveAt.value = jsSliceTen settlement.settledAt.value) then
        match allocatedSettlementQuantity.multiply path.rate with
        | .error e => .error e
        | .ok product => .ok (allocatedSettlementBookValue.equals product)
      else .ok false
    | _, _ => .ok false

/-- `expectedSettlementMeasurement` (line 1251). -/
def expectedSettlementMeasurement (policy : Option QuantizationPolicy)
    (allocatedSettlementBookValue : ExactRational) : Except QuantizeErr (Option QuantizedValue) :=
  match policy with
  | none => .ok none
  | some policy =>
    match quantize allocatedSettlementBookValue policy.rule with
    | .error e => .error e
    | .ok measurement => .ok (some measurement)

/-- `expectedRealizedDifference` (line 1252): nothing without a policy or for a difference of zero. -/
def expectedRealizedDifference (policy : Option QuantizationPolicy) (difference : ExactRational) :
    Except QuantizeErr (Option QuantizedValue) :=
  match policy with
  | none => .ok none
  | some policy =>
    if difference.isZero then .ok none
    else
      match quantize difference policy.rule with
      | .error e => .error e
      | .ok realized => .ok (some realized)

/-- `quantizationMatches` (line 1253): an absent value matches anything; a present one matches a
present one with the same amount, as rationals, and the same residual. The amounts are converted
to rationals (left, then right) before they are compared, and the conversion may throw. -/
def quantizationMatches (actual expected : Option QuantizedValue) : Except NumErr Bool :=
  match actual with
  | none => .ok true
  | some actual =>
    match expected with
    | none => .ok false
    | some expected =>
      match actual.amount.toRational with
      | .error e => .error e
      | .ok actualAmount =>
        match expected.amount.toRational with
        | .error e => .error e
        | .ok expectedAmount =>
          .ok (actualAmount.equals expectedAmount && actual.residual.equals expected.residual)

/-- The values lines 1241 to 1252 compute before the test of line 1254. -/
structure AllocationValues where
  /-- `settlementShare`. -/
  settlementShare : ExactRational
  /-- `allocatedSettlementBookValue`. -/
  settlementBookValue : ExactRational
  /-- `carryingShare`. -/
  carryingShare : ExactRational
  /-- `difference`. -/
  difference : ExactRational
  /-- `pathCoherent`. -/
  pathCoherent : Bool
  /-- `expectedSettlementMeasurement`. -/
  expectedMeasurement : Option QuantizedValue
  /-- `expectedRealizedDifference`. -/
  expectedRealized : Option QuantizedValue
  deriving DecidableEq, Repr, Inhabited

/-- Lines 1241 to 1252, in the order the TypeScript evaluates them: the share of the settlement,
the share of the open item, the difference, the coherence of the path, and the two expected
quantizations; the first that throws ends it. -/
def allocationValues (request : SettlementRequest) (settlement : Settlement) (item : OpenItem)
    (allocation : SettlementAllocationBody) : Except SettlementErr AllocationValues :=
  let allocatedOpenItemBookValue :=
    allocation.allocatedOpenItemBookValue.getD allocation.allocatedBookValue
  match liftNum (proportionalShare settlement.bookValue settlement.denomination
      allocation.allocatedSettlementQuantity) with
  | .error e => .error e
  | .ok settlementShare =>
    let settlementBookValue := allocation.allocatedSettlementBookValue.getD settlementShare
    match liftNum (proportionalShare item.bookValue item.denomination
        allocation.allocatedOpenQuantity) with
    | .error e => .error e
    | .ok carryingShare =>
      match liftNum (settlementBookValue.subtract allocatedOpenItemBookValue) with
      | .error e => .error e
      | .ok difference =>
        match liftNum (pathCoherent request settlement item allocation
            allocation.allocatedSettlementQuantity settlementBookValue) with
        | .error e => .error e
        | .ok coherent =>
          match liftQuantize (expectedSettlementMeasurement request.quantizationPolicy
              settlementBookValue) with
          | .error e => .error e
          | .ok expectedMeasurement =>
            match liftQuantize (expectedRealizedDifference request.quantizationPolicy
                difference) with
            | .error e => .error e
            | .ok expectedRealized =>
              .ok { settlementShare, settlementBookValue, carryingShare, difference,
                    pathCoherent := coherent, expectedMeasurement, expectedRealized }

/-- The first four clauses of line 1254: the open item's book value is not its carrying share; the
settlement's is not its share; it is not positive; or the path is not coherent. `true` rejects. -/
def allocationValueClauses (allocation : SettlementAllocationBody) (values : AllocationValues) :
    Bool :=
  !(allocation.allocatedOpenItemBookValue.getD allocation.allocatedBookValue).equals
      values.carryingShare ||
    !values.settlementBookValue.equals values.settlementShare ||
    !positive values.settlementBookValue || !values.pathCoherent

/-- The last three clauses of line 1254: a measurement or a difference is recorded without a policy;
a difference is recorded without an effect key; or an effect key without a difference. `true`
rejects. -/
def allocationRecordedClauses (request : SettlementRequest) (allocation : SettlementAllocationBody)
    (values : AllocationValues) : Bool :=
  (request.quantizationPolicy.isNone &&
      (allocation.settlementMeasurement.isSome || allocation.realizedExchangeDifference.isSome)) ||
    (!values.difference.isZero && allocation.realizedExchangeEffectKey.isNone) ||
    (values.difference.isZero && allocation.realizedExchangeEffectKey.isSome)

/-- The test of line 1254, from the left, stopping at the first clause that holds: the four clauses
of `allocationValueClauses`; the recorded measurement is not the expected one; the recorded
difference is not the expected one (both comparisons may throw); the three clauses of
`allocationRecordedClauses`. `true` rejects. -/
def allocationValuesRejected (request : SettlementRequest) (allocation : SettlementAllocationBody)
    (values : AllocationValues) : Except NumErr Bool :=
  if allocationValueClauses allocation values then .ok true
  else
    match quantizationMatches allocation.settlementMeasurement values.expectedMeasurement with
    | .error e => .error e
    | .ok false => .ok true
    | .ok true =>
      match quantizationMatches allocation.realizedExchangeDifference values.expectedRealized with
      | .error e => .error e
      | .ok false => .ok true
      | .ok true => .ok (allocationRecordedClauses request allocation values)

/-- Lines 1255 to 1257: the three working values after the allocation, each sum as the TypeScript
evaluates it, from the first to the last; the first that throws ends it. -/
def pendingUpdate (pending : SettlementPending) (allocation : SettlementAllocationBody) :
    Except NumErr SettlementPending :=
  let pendingBookValue := (settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero
  let pendingQuantity := (settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero
  match pendingBookValue.add (allocation.allocatedOpenItemBookValue.getD allocation.allocatedBookValue) with
  | .error e => .error e
  | .ok bookValue =>
    match pendingQuantity.add allocation.allocatedOpenQuantity with
    | .error e => .error e
    | .ok quantity =>
      match pending.settlementQuantity.add allocation.allocatedSettlementQuantity with
      | .error e => .error e
      | .ok settlementQuantity =>
        .ok { byOpenItem := settlementMapSet pending.byOpenItem allocation.openItemId bookValue
              openQuantity := settlementMapSet pending.openQuantity allocation.openItemId quantity
              settlementQuantity }

/-- The body of the loop of lines 1227 to 1258 for one allocation. The context's totals for the
open item are read first, and a negative one is a `TypeError` (line 1232); the tests are then made
in the order of the TypeScript: the recognition date (line 1236), the scope and the sums (line 1238;
an open item the context does not have is rejected here), and the values (line 1254). -/
def settlementAllocationStep (context : SettlementReadContext) (request : SettlementRequest)
    (settlement : Settlement) (pending : SettlementPending) (allocation : SettlementAllocationBody) :
    Except SettlementErr SettlementStep :=
  let item := context.openItem allocation.openItemId
  let prior := context.allocatedToOpenItem allocation.openItemId
  if prior.bookValue.isNegative || prior.quantity.isNegative then .error .incompleteSettlementTotals
  else
    let pendingBookValue := (settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero
    let pendingQuantity := (settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero
    if recognizedAfterApplication request item then
      .ok (.rejected allocationBeforeRecognitionRejection)
    else
      match item with
      | none => .ok (.rejected allocationScopeRejection)
      | some item =>
        match liftNum (allocationScopeViolated settlement allocation item prior pendingBookValue
            pendingQuantity pending.settlementQuantity) with
        | .error e => .error e
        | .ok true => .ok (.rejected allocationScopeRejection)
        | .ok false =>
          match allocationValues request settlement item allocation with
          | .error e => .error e
          | .ok values =>
            match liftNum (allocationValuesRejected request allocation values) with
            | .error e => .error e
            | .ok true => .ok (.rejected allocationValueRejection)
            | .ok false =>
              match liftNum (pendingUpdate pending allocation) with
              | .error e => .error e
              | .ok next => .ok (.next next)

/-- The loop of lines 1227 to 1258: the allocations in order, from the working values `pending`;
the first rejection or error ends it. -/
def settlementAllocationLoop (context : SettlementReadContext) (request : SettlementRequest)
    (settlement : Settlement) :
    SettlementPending → List SettlementAllocationBody → Except SettlementErr SettlementStep
  | pending, [] => .ok (.next pending)
  | pending, allocation :: rest =>
    match settlementAllocationStep context request settlement pending allocation with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.next next) => settlementAllocationLoop context request settlement next rest

/-! ## `calculateSettlement`: after the loop (`accounting.ts` lines 1259 to 1279) -/

/-- `item.allocatedSettlementBookValue ?? share` (lines 1259 and 1263): the book value of the
settlement that the allocation carries, as it states it, or its share. -/
def settledBookValue (settlement : Settlement) (item : SettlementAllocationBody) :
    Except NumErr ExactRational :=
  match item.allocatedSettlementBookValue with
  | some value => .ok value
  | none =>
    proportionalShare settlement.bookValue settlement.denomination item.allocatedSettlementQuantity

/-- `request.allocations.map(item => item.allocatedSettlementBookValue ?? share)` (line 1259), from
the left; the first share that throws ends it. -/
def settledBookValues (settlement : Settlement) :
    List SettlementAllocationBody → Except NumErr (List ExactRational)
  | [] => .ok []
  | item :: rest =>
    match settledBookValue settlement item with
    | .error e => .error e
    | .ok value =>
      match settledBookValues settlement rest with
      | .error e => .error e
      | .ok values => .ok (value :: values)

/-- The test of line 1259: what was allocated from the settlement before, and what these
allocations carry of its book value, exceed its book value. The sum is evaluated before the
comparison and may throw. -/
def settlementOverAllocated (settlement : Settlement) (previous : AllocatedTotal)
    (allocations : List SettlementAllocationBody) : Except NumErr Bool :=
  match settledBookValues settlement allocations with
  | .error e => .error e
  | .ok values =>
    match accountingSum values with
    | .error e => .error e
    | .ok total =>
      match previous.bookValue.add total with
      | .error e => .error e
      | .ok allocated => .ok (allocated.compare settlement.bookValue.abs == .gt)

/-- The allocation of line 1277 before its hash: the item with the values of lines 1261 to 1266
written over it, as the spread `{ ...item, ... }` does. A measurement or a difference that was not
computed (line 1274 and 1275) leaves the item's own. -/
def settlementAllocationBody (request : SettlementRequest) (item : SettlementAllocationBody)
    (allocatedOpenItemBookValue allocatedSettlementBookValue : ExactRational)
    (settlementMeasurement realizedExchangeDifference : Option QuantizedValue) :
    SettlementAllocationBody :=
  { item with
    appliedAt := if request.existing then request.appliedAt else item.appliedAt
    allocatedBookValue := allocatedOpenItemBookValue
    allocatedOpenItemBookValue := some allocatedOpenItemBookValue
    allocatedSettlementBookValue := some allocatedSettlementBookValue
    settlementMeasurement := settlementMeasurement.orElse fun _ => item.settlementMeasurement
    realizedExchangeDifference :=
      realizedExchangeDifference.orElse fun _ => item.realizedExchangeDifference }

/-- One element of the `map` of lines 1260 to 1278: the values of the allocation, then
`{ ...body, contentHash: accountingHash("SettlementAllocation", body) }`. -/
def buildSettlementAllocation (request : SettlementRequest) (settlement : Settlement)
    (item : SettlementAllocationBody) : Except SettlementErr SettlementAllocation :=
  let allocatedOpenItemBookValue := item.allocatedOpenItemBookValue.getD item.allocatedBookValue
  match liftNum (settledBookValue settlement item) with
  | .error e => .error e
  | .ok allocatedSettlementBookValue =>
    match liftNum (allocatedSettlementBookValue.subtract allocatedOpenItemBookValue) with
    | .error e => .error e
    | .ok difference =>
      match liftQuantize (expectedSettlementMeasurement request.quantizationPolicy
          allocatedSettlementBookValue) with
      | .error e => .error e
      | .ok settlementMeasurement =>
        match liftQuantize (expectedRealizedDifference request.quantizationPolicy difference) with
        | .error e => .error e
        | .ok realizedExchangeDifference =>
          let body := settlementAllocationBody request item allocatedOpenItemBookValue
            allocatedSettlementBookValue settlementMeasurement realizedExchangeDifference
          .ok { toSettlementAllocationBody := body,
                contentHash := accountingHash "SettlementAllocation" body }

/-- `request.allocations.map(...)` (line 1260): every allocation, in order; the first that throws
ends it. -/
def buildSettlementAllocations (request : SettlementRequest) (settlement : Settlement) :
    List SettlementAllocationBody → Except SettlementErr (List SettlementAllocation)
  | [] => .ok []
  | item :: rest =>
    match buildSettlementAllocation request settlement item with
    | .error e => .error e
    | .ok built =>
      match buildSettlementAllocations request settlement rest with
      | .error e => .error e
      | .ok builts => .ok (built :: builts)

/-- The effects of line 1279: the settlement, unless it was recorded already, and every
allocation. -/
def settlementEffects (existing : Bool) (settlement : Settlement)
    (allocations : List SettlementAllocation) : List AccountingEffect :=
  (if existing then [] else [.settlement settlement]) ++ allocations.map .settlementAllocation

/-- `calculateSettlement` (line 1205). The tests are made in the order of the TypeScript: the
operation and the application time (line 1208), the identity and the amounts of the settlement
(line 1212), the settlement that was recorded, for `allocateExisting` (lines 1214 to 1223), each
allocation (lines 1224 to 1258) and the over-allocation (line 1259). The draft holds no journal; its
effects are the settlement, unless it was recorded already, and then every allocation. -/
def calculateSettlement (context : SettlementReadContext) (request : SettlementRequest) :
    Except SettlementErr AccountingCalculation :=
  if settlementApplicationIncoherent request then .ok settlementApplicationRejection
  else if settlementIdentityInvalid context request then .ok settlementIdentityRejection
  else
    let settlement := request.hashedSettlement
    match previousSettlementTotals context settlement request.existing with
    | .error e => .error e
    | .ok .mismatch => .ok retainedSettlementRejection
    | .ok (.totals previous) =>
      match settlementAllocationLoop context request settlement
          ⟨[], [], previous.quantity⟩ request.allocations with
      | .error e => .error e
      | .ok (.rejected rejection) => .ok rejection
      | .ok (.next _) =>
        match liftNum (settlementOverAllocated settlement previous request.allocations) with
        | .error e => .error e
        | .ok true => .ok overAllocationRejection
        | .ok false =>
          match buildSettlementAllocations request settlement request.allocations with
          | .error e => .error e
          | .ok allocations =>
            .ok (drafted [] (settlementEffects request.existing settlement allocations))

/-- `applySettlement` (line 1200): `calculateSettlement` over the context of the state. -/
def applySettlement (state : AccountingCanonicalState) (request : SettlementRequest) :
    Except SettlementErr AccountingCalculation :=
  match settlementReadContext state with
  | .error e => .error (.exactNumber e)
  | .ok context => calculateSettlement context request

/-! # Laws

## What the helpers mean -/

/-- A `NumErr` result lifted into `calculateSettlement`'s errors is `.ok` exactly when it was. -/
theorem liftNum_eq_ok {α : Type} {result : Except NumErr α} {value : α} :
    liftNum result = .ok value ↔ result = .ok value := by
  cases result <;> simp [liftNum]

/-- A `QuantizeErr` result lifted into `calculateSettlement`'s errors is `.ok` exactly when it was. -/
theorem liftQuantize_eq_ok {α : Type} {result : Except QuantizeErr α} {value : α} :
    liftQuantize result = .ok value ↔ result = .ok value := by
  cases result <;> simp [liftQuantize]

/-- A positive value is one whose meaning is above zero. -/
theorem positive_iff {x : ExactRational} (hx : x.WF) : positive x = true ↔ 0 < x.toRat := by
  unfold positive
  rw [beq_iff_eq, ExactRational.compare_gt_iff hx ExactRational.zero_wf,
    ExactRational.zero_toRat]

/-- A value whose magnitude is positive is one that is not zero. -/
theorem positive_abs_iff {x : ExactRational} (hx : x.WF) : positive x.abs = true ↔ x.toRat ≠ 0 := by
  rw [positive_iff (ExactRational.abs_wf hx), ExactRational.abs_toRat hx]
  exact abs_pos

/-- A comparison that answers `.gt` is the meaning of the first being above the second. -/
theorem compare_beq_gt_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (a.compare b == .gt) = true ↔ b.toRat < a.toRat := by
  rw [beq_iff_eq]
  exact ExactRational.compare_gt_iff ha hb

/-- A comparison that does not answer `.gt` is the meaning of the first being at most the second. -/
theorem compare_ne_gt_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.compare b ≠ .gt ↔ a.toRat ≤ b.toRat := by
  rw [Ne, ExactRational.compare_gt_iff ha hb, not_lt]

/-! ## What the hash of an effect covers -/

/-- Dropping the `contentHash` member from an object whose other members are not called that
leaves them. -/
theorem withoutContentHash_append {α : Type} [Canonicalize α] {members : List Member} {value : α}
    (h : ∀ m ∈ members, m.1 ≠ "contentHash") :
    withoutContentHash (members ++ [member "contentHash" value]) = members := by
  unfold withoutContentHash member
  rw [List.filter_append]
  have h1 : members.filter (fun m => m.1 != "contentHash") = members :=
    List.filter_eq_self.mpr fun m hm => by simpa using h m hm
  simp [h1]

/-- The canonical value of the body of an open item is that of its body structure. -/
theorem bodyValue_openItem (item : OpenItem) :
    bodyValue item = canonicalize item.toOpenItemBody := by
  have h : ∀ m ∈ item.toOpenItemBody.canonicalMembers, m.1 ≠ "contentHash" := by
    simp [OpenItemBody.canonicalMembers, member, optMember]
  show object (withoutContentHash (OpenItem.canonicalMembers item)) =
    object item.toOpenItemBody.canonicalMembers
  rw [OpenItem.canonicalMembers, withoutContentHash_append h]

/-- The canonical value of the body of a settlement is that of its body structure. -/
theorem bodyValue_settlement (settlement : Settlement) :
    bodyValue settlement = canonicalize settlement.toSettlementBody := by
  have h : ∀ m ∈ settlement.toSettlementBody.canonicalMembers, m.1 ≠ "contentHash" := by
    simp [SettlementBody.canonicalMembers, member, optMember]
  show object (withoutContentHash (Settlement.canonicalMembers settlement)) =
    object settlement.toSettlementBody.canonicalMembers
  rw [Settlement.canonicalMembers, withoutContentHash_append h]

/-- The canonical value of the body of a settlement allocation is that of its body structure. -/
theorem bodyValue_settlementAllocation (allocation : SettlementAllocation) :
    bodyValue allocation = canonicalize allocation.toSettlementAllocationBody := by
  have h : ∀ m ∈ allocation.toSettlementAllocationBody.canonicalMembers, m.1 ≠ "contentHash" := by
    simp [SettlementAllocationBody.canonicalMembers, member, optMember]
  show object (withoutContentHash (SettlementAllocation.canonicalMembers allocation)) =
    object allocation.toSettlementAllocationBody.canonicalMembers
  rw [SettlementAllocation.canonicalMembers, withoutContentHash_append h]

/-- The hash of a value that is already canonical is the hash of the value it was written from. -/
theorem accountingHash_canonicalize {α : Type} [Canonicalize α] (type : String) (value : α) :
    accountingHash type (canonicalize value) = accountingHash type value := rfl

/-- Two hashes are equal in all three fields exactly when they are the same hash. -/
theorem hash_fields_beq (a : ContentHash) :
    (a.algorithm == a.algorithm && a.canonicalizationVersion == a.canonicalizationVersion &&
      a.digest == a.digest) = true := by
  simp

/-- An open item whose hash is the hash of its body passes the check of an effect's hash. -/
theorem validateAccountingEffectHash_openItem {item : OpenItem}
    (h : item.contentHash = accountingHash "OpenItem" item.toOpenItemBody) :
    validateAccountingEffectHash (.openItem item) = .ok true := by
  have hv : AccountingEffect.bodyValue (.openItem item) = canonicalize item.toOpenItemBody :=
    bodyValue_openItem item
  have hc : AccountingEffect.contentHash (.openItem item) = item.contentHash := rfl
  simp only [validateAccountingEffectHash, AccountingEffect.typeName, hv, hc,
    accountingHash_canonicalize, ← h]
  simp

/-- A settlement whose hash is the hash of its body passes the check of an effect's hash. -/
theorem validateAccountingEffectHash_settlement {settlement : Settlement}
    (h : settlement.contentHash = accountingHash "Settlement" settlement.toSettlementBody) :
    validateAccountingEffectHash (.settlement settlement) = .ok true := by
  have hv : AccountingEffect.bodyValue (.settlement settlement) =
      canonicalize settlement.toSettlementBody := bodyValue_settlement settlement
  have hc : AccountingEffect.contentHash (.settlement settlement) = settlement.contentHash := rfl
  simp only [validateAccountingEffectHash, AccountingEffect.typeName, hv, hc,
    accountingHash_canonicalize, ← h]
  simp

/-- A settlement allocation whose hash is the hash of its body passes the check of an effect's
hash. -/
theorem validateAccountingEffectHash_settlementAllocation {allocation : SettlementAllocation}
    (h : allocation.contentHash =
      accountingHash "SettlementAllocation" allocation.toSettlementAllocationBody) :
    validateAccountingEffectHash (.settlementAllocation allocation) = .ok true := by
  have hv : AccountingEffect.bodyValue (.settlementAllocation allocation) =
      canonicalize allocation.toSettlementAllocationBody := bodyValue_settlementAllocation allocation
  have hc : AccountingEffect.contentHash (.settlementAllocation allocation) =
      allocation.contentHash := rfl
  simp only [validateAccountingEffectHash, AccountingEffect.typeName, hv, hc,
    accountingHash_canonicalize, ← h]
  simp

/-! ## Open items: the laws -/

/-- An open item is accepted exactly when its derivation is approved, evidenced and dated, its book
value and its denomination have a magnitude above zero, and its identity is absent. -/
theorem openItemRefused_eq_false_iff (identity : IdentityObservation)
    (request : OpenItemRecognitionRequest) :
    openItemRefused identity request = false ↔
      validAccountingDerivation request.value.derivation = true ∧
        positive request.value.bookValue.abs = true ∧
        positive request.value.denomination.abs = true ∧ identity = .absent := by
  cases identity <;> simp [openItemRefused, settlementIdentityPresent, and_assoc]

/-- An open item is accepted exactly when its derivation is approved, evidenced and dated, its book
value and its denomination are not zero, and its identity is absent. -/
theorem openItemRefused_eq_false_iff_meaning (identity : IdentityObservation)
    (request : OpenItemRecognitionRequest) (hrequest : request.WF) :
    openItemRefused identity request = false ↔
      validAccountingDerivation request.value.derivation = true ∧
        request.value.bookValue.toRat ≠ 0 ∧ request.value.denomination.toRat ≠ 0 ∧
        identity = .absent := by
  rw [openItemRefused_eq_false_iff, positive_abs_iff hrequest.value.bookValue,
    positive_abs_iff hrequest.value.denomination]

/-- An open item is refused, with the one diagnostic of the TypeScript, exactly when the test of its
conditions holds; otherwise it is not a rejection. -/
theorem calculateOpenItem_eq_rejection_iff (identity : IdentityObservation)
    (request : OpenItemRecognitionRequest) :
    calculateOpenItem identity request = openItemRejection ↔
      openItemRefused identity request = true := by
  unfold calculateOpenItem
  by_cases h : openItemRefused identity request = true
  · simp [h]
  · simp only [h, Bool.false_eq_true, ↓reduceIte, iff_false]
    simp [drafted, immutableAccountingValue, openItemRejection, reject]

/-- An open item that is accepted yields a draft with no journal and one effect, the open item, which
is the request's value (so its identifier, kind, scope, denomination and book value) with the hash
of that value. -/
theorem calculateOpenItem_draft {identity : IdentityObservation}
    {request : OpenItemRecognitionRequest} {draft : AccountingDraft}
    (h : calculateOpenItem identity request = .draft draft) :
    draft.journals = [] ∧ ∃ item : OpenItem, draft.effects = [.openItem item] ∧
      item.toOpenItemBody = request.value ∧
      item.contentHash = accountingHash "OpenItem" request.value := by
  unfold calculateOpenItem at h
  split at h
  · simp [openItemRejection, reject] at h
  · simp only [drafted, immutableAccountingValue, AccountingCalculation.draft.injEq] at h
    subst h
    exact ⟨rfl, _, rfl, rfl, rfl⟩

/-- An open item that is accepted is exactly the one the request states. -/
theorem calculateOpenItem_draft_fields {identity : IdentityObservation}
    {request : OpenItemRecognitionRequest} {draft : AccountingDraft} {item : OpenItem}
    (h : calculateOpenItem identity request = .draft draft) (hitem : .openItem item ∈ draft.effects) :
    item.id = request.value.id ∧ item.kind = request.value.kind ∧ item.scope = request.value.scope ∧
      item.denomination = request.value.denomination ∧ item.bookValue = request.value.bookValue := by
  obtain ⟨-, item', heffects, hbody, -⟩ := calculateOpenItem_draft h
  rw [heffects] at hitem
  simp only [List.mem_singleton, AccountingEffect.openItem.injEq] at hitem
  subst hitem
  rw [← hbody]
  exact ⟨rfl, rfl, rfl, rfl, rfl⟩

/-- The open item an accepted request produces has the hash of its body, and the check the kernel
makes of an effect's hash passes. -/
theorem calculateOpenItem_hash {identity : IdentityObservation}
    {request : OpenItemRecognitionRequest} {draft : AccountingDraft}
    (h : calculateOpenItem identity request = .draft draft) :
    ∀ effect ∈ draft.effects, validateAccountingEffectHash effect = .ok true := by
  obtain ⟨-, item, heffects, hbody, hhash⟩ := calculateOpenItem_draft h
  intro effect hmem
  rw [heffects, List.mem_singleton] at hmem
  subst hmem
  apply validateAccountingEffectHash_openItem
  rw [hhash, hbody]

/-- The test of `recognizeOpenItem` for the identity: an open item of the state has the
identifier. -/
theorem recognizeOpenItem_eq (state : AccountingCanonicalState)
    (request : OpenItemRecognitionRequest) :
    recognizeOpenItem state request =
      calculateOpenItem
        (if state.openItems.any (·.id == request.value.id) then .present else .absent) request :=
  rfl

/-- An open item whose identifier the state already holds is refused. -/
theorem recognizeOpenItem_present (state : AccountingCanonicalState)
    (request : OpenItemRecognitionRequest)
    (h : ∃ item ∈ state.openItems, item.id = request.value.id) :
    recognizeOpenItem state request = openItemRejection := by
  obtain ⟨item, hmem, hid⟩ := h
  have hany : state.openItems.any (·.id == request.value.id) = true :=
    List.any_eq_true.mpr ⟨item, hmem, by simp [hid]⟩
  simp only [recognizeOpenItem, hany, ↓reduceIte, calculateOpenItem_eq_rejection_iff]
  simp [openItemRefused, settlementIdentityPresent]

/-- An open item is recognized exactly when the state does not hold its identifier and the other
conditions hold: the identity is recorded once. -/
theorem recognizeOpenItem_eq_rejection_iff (state : AccountingCanonicalState)
    (request : OpenItemRecognitionRequest) :
    recognizeOpenItem state request = openItemRejection ↔
      validAccountingDerivation request.value.derivation = false ∨
        positive request.value.bookValue.abs = false ∨
        positive request.value.denomination.abs = false ∨
        ∃ item ∈ state.openItems, item.id = request.value.id := by
  rw [recognizeOpenItem_eq, calculateOpenItem_eq_rejection_iff]
  by_cases hany : state.openItems.any (·.id == request.value.id) = true
  · have : ∃ item ∈ state.openItems, item.id = request.value.id := by
      obtain ⟨item, hmem, hid⟩ := List.any_eq_true.mp hany
      exact ⟨item, hmem, by simpa using hid⟩
    simp [hany, openItemRefused, settlementIdentityPresent, this]
  · have : ¬ ∃ item ∈ state.openItems, item.id = request.value.id := by
      rintro ⟨item, hmem, hid⟩
      exact hany (List.any_eq_true.mpr ⟨item, hmem, by simp [hid]⟩)
    simp [hany, openItemRefused, settlementIdentityPresent, this, or_assoc]

/-- Once the effect of an accepted open item is applied, the same request is refused: an open item is
recorded once. -/
theorem recognizeOpenItem_recorded_once (state : AccountingCanonicalState)
    (request : OpenItemRecognitionRequest) {draft : AccountingDraft}
    (h : recognizeOpenItem state request = .draft draft) :
    ∀ effect ∈ draft.effects,
      recognizeOpenItem (applyAccountingEffect state effect) request = openItemRejection := by
  rw [recognizeOpenItem_eq] at h
  obtain ⟨-, item, heffects, hbody, -⟩ := calculateOpenItem_draft h
  intro effect hmem
  rw [heffects, List.mem_singleton] at hmem
  subst hmem
  apply recognizeOpenItem_present
  refine ⟨item, ?_, by rw [hbody]⟩
  simp [applyAccountingEffect]

/-! ## The loop: which rejections it returns -/

/-- One pass of the loop returns, when it rejects, one of the three rejections of its tests. -/
theorem settlementAllocationStep_rejected {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {rejection : AccountingCalculation}
    (h : settlementAllocationStep context request settlement pending allocation =
      .ok (.rejected rejection)) :
    rejection = allocationBeforeRecognitionRejection ∨ rejection = allocationScopeRejection ∨
      rejection = allocationValueRejection := by
  unfold settlementAllocationStep at h
  dsimp only at h
  split at h
  · cases h
  split at h
  · cases h; exact Or.inl rfl
  split at h
  · cases h; exact Or.inr (Or.inl rfl)
  split at h
  · cases h
  · cases h; exact Or.inr (Or.inl rfl)
  split at h
  · cases h
  split at h
  · cases h
  · cases h; exact Or.inr (Or.inr rfl)
  split at h
  · cases h
  · cases h

/-- The loop returns, when it rejects, one of the three rejections of its tests. -/
theorem settlementAllocationLoop_rejected {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} :
    ∀ {pending : SettlementPending} {allocations : List SettlementAllocationBody}
      {rejection : AccountingCalculation},
      settlementAllocationLoop context request settlement pending allocations =
        .ok (.rejected rejection) →
      rejection = allocationBeforeRecognitionRejection ∨ rejection = allocationScopeRejection ∨
        rejection = allocationValueRejection
  | pending, [], rejection, h => by simp [settlementAllocationLoop] at h
  | pending, allocation :: rest, rejection, h => by
    unfold settlementAllocationLoop at h
    split at h
    · cases h
    · rename_i rejection' hstep
      cases h
      exact settlementAllocationStep_rejected hstep
    · rename_i next hstep
      exact settlementAllocationLoop_rejected h

/-! ## `calculateSettlement`: what an accepted request went through -/

/-- A request that `calculateSettlement` turns into a draft passed every test, in order, and the
draft holds no journal and, as effects, the settlement (unless it was recorded already) and every
allocation. -/
theorem calculateSettlement_draft {context : SettlementReadContext} {request : SettlementRequest}
    {draft : AccountingDraft}
    (h : calculateSettlement context request = .ok (.draft draft)) :
    ∃ (previous : AllocatedTotal) (pending : SettlementPending)
      (built : List SettlementAllocation),
      settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = false ∧
      previousSettlementTotals context request.hashedSettlement request.existing =
        .ok (.totals previous) ∧
      settlementAllocationLoop context request request.hashedSettlement
        ⟨[], [], previous.quantity⟩ request.allocations = .ok (.next pending) ∧
      settlementOverAllocated request.hashedSettlement previous request.allocations = .ok false ∧
      buildSettlementAllocations request request.hashedSettlement request.allocations =
        .ok built ∧
      draft = { journals := [],
                effects := settlementEffects request.existing request.hashedSettlement built } := by
  unfold calculateSettlement at h
  split at h
  · simp [settlementApplicationRejection, reject] at h
  rename_i hincoherent
  split at h
  · simp [settlementIdentityRejection, reject] at h
  rename_i hinvalid
  simp only [Bool.not_eq_true] at hincoherent hinvalid
  dsimp only at h
  split at h
  · cases h
  · simp [retainedSettlementRejection, reject] at h
  rename_i previous hprevious
  split at h
  · cases h
  · rename_i rejection hloop
    have hrejection := settlementAllocationLoop_rejected hloop
    injection h with h
    rcases hrejection with rfl | rfl | rfl <;>
      simp [allocationBeforeRecognitionRejection, allocationScopeRejection,
        allocationValueRejection, reject] at h
  · rename_i pending hloop
    split at h
    · cases h
    · simp [overAllocationRejection, reject] at h
    · rename_i hover
      split at h
      · cases h
      · rename_i built hbuild
        injection h with h
        simp only [drafted, immutableAccountingValue, AccountingCalculation.draft.injEq] at h
        exact ⟨previous, pending, built, hincoherent, hinvalid, hprevious, hloop,
          liftNum_eq_ok.mp hover, hbuild, h.symm⟩

/-! ## The allocations an accepted request produces -/

/-- `built` is the allocation that `item` becomes: the share of the settlement it carries, the
difference between the two sides, and the two quantizations were computed, and `built` is the item
with those values, as `settlementAllocationBody` writes them, and the hash of that body. -/
def BuiltFrom (request : SettlementRequest) (settlement : Settlement)
    (item : SettlementAllocationBody) (built : SettlementAllocation) : Prop :=
  ∃ (settlementBookValue difference : ExactRational) (measurement realized : Option QuantizedValue),
    settledBookValue settlement item = .ok settlementBookValue ∧
    settlementBookValue.subtract (item.allocatedOpenItemBookValue.getD item.allocatedBookValue) =
      .ok difference ∧
    expectedSettlementMeasurement request.quantizationPolicy settlementBookValue = .ok measurement ∧
    expectedRealizedDifference request.quantizationPolicy difference = .ok realized ∧
    built.toSettlementAllocationBody = settlementAllocationBody request item
      (item.allocatedOpenItemBookValue.getD item.allocatedBookValue) settlementBookValue
      measurement realized ∧
    built.contentHash = accountingHash "SettlementAllocation" built.toSettlementAllocationBody

/-- An allocation is built from its item exactly as `BuiltFrom` says. -/
theorem buildSettlementAllocation_builtFrom {request : SettlementRequest}
    {settlement : Settlement} {item : SettlementAllocationBody} {built : SettlementAllocation}
    (h : buildSettlementAllocation request settlement item = .ok built) :
    BuiltFrom request settlement item built := by
  unfold buildSettlementAllocation at h
  dsimp only at h
  split at h
  · cases h
  rename_i settlementBookValue hvalue
  split at h
  · cases h
  rename_i difference hdifference
  split at h
  · cases h
  rename_i measurement hmeasurement
  split at h
  · cases h
  rename_i realized hrealized
  injection h with h
  subst h
  exact ⟨settlementBookValue, difference, measurement, realized, liftNum_eq_ok.mp hvalue,
    liftNum_eq_ok.mp hdifference, liftQuantize_eq_ok.mp hmeasurement,
    liftQuantize_eq_ok.mp hrealized, rfl, rfl⟩

/-- Every allocation of the list is built from its item, in order. -/
theorem buildSettlementAllocations_forall₂ {request : SettlementRequest} {settlement : Settlement} :
    ∀ {items : List SettlementAllocationBody} {built : List SettlementAllocation},
      buildSettlementAllocations request settlement items = .ok built →
      List.Forall₂ (BuiltFrom request settlement) items built
  | [], built, h => by
    simp only [buildSettlementAllocations, Except.ok.injEq] at h
    subst h
    exact .nil
  | item :: rest, built, h => by
    unfold buildSettlementAllocations at h
    split at h
    · cases h
    rename_i first hfirst
    split at h
    · cases h
    rename_i others hothers
    injection h with h
    subst h
    exact .cons (buildSettlementAllocation_builtFrom hfirst)
      (buildSettlementAllocations_forall₂ hothers)

/-! ## One allocation: what its tests say -/

/-- The share of a book value that a quantity carries, when it is computed: the meaning is the
book value's magnitude times the quantity over the denomination's magnitude, and the denomination
is not zero. -/
theorem proportionalShare_ok {bookValue denomination quantity share : ExactRational}
    (hbookValue : bookValue.WF) (hdenomination : denomination.WF) (hquantity : quantity.WF)
    (h : proportionalShare bookValue denomination quantity = .ok share) :
    share.WF ∧ denomination.toRat ≠ 0 ∧
      share.toRat = |bookValue.toRat| * quantity.toRat / |denomination.toRat| := by
  unfold proportionalShare at h
  split at h
  · cases h
  · rename_i product hproduct
    obtain ⟨hproductWF, hproductRat⟩ :=
      ExactRational.multiply_ok (ExactRational.abs_wf hbookValue) hquantity hproduct
    obtain ⟨hshareWF, hne, hshareRat⟩ :=
      ExactRational.divide_ok hproductWF (ExactRational.abs_wf hdenomination) h
    refine ⟨hshareWF, ?_, ?_⟩
    · rw [ExactRational.abs_toRat hdenomination] at hne
      exact fun h0 => hne (by rw [h0]; simp)
    · rw [hshareRat, hproductRat, ExactRational.abs_toRat hbookValue,
        ExactRational.abs_toRat hdenomination]

/-- The clauses of line 1238 that look at no sum are all false exactly when the allocation is for
the settlement, is approved, is for an open item of the settlement's book, party and control
account, has a book value and quantities that are positive, and states an open item book value that
is its book value. -/
theorem allocationScopeClauses_eq_false_iff (settlement : Settlement)
    (allocation : SettlementAllocationBody) (item : OpenItem) :
    allocationScopeClauses settlement allocation item = false ↔
      allocation.settlementId = settlement.id ∧
        validAccountingDerivation allocation.derivation = true ∧
        item.bookId = settlement.bookId ∧
        item.scope.externalPartyId = settlement.scope.externalPartyId ∧
        item.scope.controlAccountId = settlement.scope.controlAccountId ∧
        positive allocation.allocatedBookValue = true ∧
        positive allocation.allocatedOpenQuantity = true ∧
        positive allocation.allocatedSettlementQuantity = true ∧
        ∀ value, allocation.allocatedOpenItemBookValue = some value →
          value.equals allocation.allocatedBookValue = true := by
  unfold allocationScopeClauses
  cases hv : allocation.allocatedOpenItemBookValue with
  | none => simp [and_assoc]
  | some value => simp [and_assoc]

/-- When the three sums of line 1238 are computed and none is beyond what it is compared with, the
allocated book value of the open item, its allocated quantity and the settlement's allocated
quantity, each with this allocation, are within the open item's book value and denomination and the
settlement's denomination. -/
theorem allocationCapacityExceeded_eq_false {settlement : Settlement}
    {allocation : SettlementAllocationBody} {item : OpenItem} {prior : AllocatedTotal}
    {pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational}
    (hsettlement : settlement.WF) (hitem : item.WF) (hallocation : allocation.WF)
    (hprior : prior.WF) (hbook : pendingBookValue.WF) (hquantity : pendingQuantity.WF)
    (hsettled : pendingSettlementQuantity.WF)
    (h : allocationCapacityExceeded settlement allocation item prior pendingBookValue
      pendingQuantity pendingSettlementQuantity = .ok false) :
    prior.bookValue.toRat + pendingBookValue.toRat + allocation.allocatedBookValue.toRat ≤
        |item.bookValue.toRat| ∧
      prior.quantity.toRat + pendingQuantity.toRat + allocation.allocatedOpenQuantity.toRat ≤
        |item.denomination.toRat| ∧
      pendingSettlementQuantity.toRat + allocation.allocatedSettlementQuantity.toRat ≤
        |settlement.denomination.toRat| := by
  unfold allocationCapacityExceeded at h
  split at h
  · cases h
  rename_i s1 hs1
  obtain ⟨hs1wf, hs1rat⟩ := ExactRational.add_ok hprior.bookValue hbook hs1
  split at h
  · cases h
  rename_i s2 hs2
  obtain ⟨hs2wf, hs2rat⟩ := ExactRational.add_ok hs1wf hallocation.allocatedBookValue hs2
  split at h
  · cases h
  rename_i hgt1
  split at h
  · cases h
  rename_i t1 ht1
  obtain ⟨ht1wf, ht1rat⟩ := ExactRational.add_ok hprior.quantity hquantity ht1
  split at h
  · cases h
  rename_i t2 ht2
  obtain ⟨ht2wf, ht2rat⟩ := ExactRational.add_ok ht1wf hallocation.allocatedOpenQuantity ht2
  split at h
  · cases h
  rename_i hgt2
  split at h
  · cases h
  rename_i t3 ht3
  obtain ⟨ht3wf, ht3rat⟩ :=
    ExactRational.add_ok hsettled hallocation.allocatedSettlementQuantity ht3
  simp only [Except.ok.injEq] at h
  have hgt3 : ¬ (t3.compare settlement.denomination.abs == .gt) = true := by
    simpa using h
  refine ⟨?_, ?_, ?_⟩
  · have := not_lt.mp (mt (compare_beq_gt_iff hs2wf (ExactRational.abs_wf hitem.bookValue)).mpr hgt1)
    rw [ExactRational.abs_toRat hitem.bookValue, hs2rat, hs1rat] at this
    exact this
  · have := not_lt.mp (mt (compare_beq_gt_iff ht2wf (ExactRational.abs_wf hitem.denomination)).mpr hgt2)
    rw [ExactRational.abs_toRat hitem.denomination, ht2rat, ht1rat] at this
    exact this
  · have := not_lt.mp (mt (compare_beq_gt_iff ht3wf (ExactRational.abs_wf hsettlement.denomination)).mpr hgt3)
    rw [ExactRational.abs_toRat hsettlement.denomination, ht3rat] at this
    exact this

/-! ## The working values of the loop -/

/-- A map that is only read with `get`: the entry just set is the one found. -/
theorem settlementMapGet_settlementMapSet {κ α : Type} [BEq κ] [LawfulBEq κ] (entries : List (κ × α)) (key key' : κ)
    (value : α) :
    settlementMapGet (settlementMapSet entries key value) key' =
      if key == key' then some value else settlementMapGet entries key' := by
  by_cases h : key = key'
  · subst h; simp [settlementMapGet, settlementMapSet]
  · have h' : (key == key') = false := by simpa using h
    simp [settlementMapGet, settlementMapSet, h']

/-- What an allocation adds to the allocated book value of its open item: the book value it states
for the open item, or its book value (lines 1178 and 1241). -/
def SettlementAllocationBody.openItemBookValue (allocation : SettlementAllocationBody) :
    ExactRational :=
  allocation.allocatedOpenItemBookValue.getD allocation.allocatedBookValue

/-- The sum of `value` over the items whose `key` is `id` (the open item, or the settlement, that
the items are for). -/
def sumOver {α κ : Type} [DecidableEq κ] (key : α → κ) (value : α → ℚ) (id : κ) (items : List α) :
    ℚ :=
  (items.map fun item => if key item = id then value item else 0).sum

/-- The sum over a list with one more item at its end. -/
theorem sumOver_append_singleton {α κ : Type} [DecidableEq κ] (key : α → κ) (value : α → ℚ)
    (id : κ) (items : List α) (item : α) :
    sumOver key value id (items ++ [item]) =
      sumOver key value id items + if key item = id then value item else 0 := by
  simp [sumOver, List.map_append, List.sum_append]

/-- The sum over two lists whose items correspond, with the same key and value, is the same. -/
theorem sumOver_forall₂ {α β κ : Type} [DecidableEq κ] {key : α → κ} {key' : β → κ}
    {value : α → ℚ} {value' : β → ℚ} {related : α → β → Prop}
    (h : ∀ a b, related a b → key a = key' b ∧ value a = value' b) (id : κ) :
    ∀ {items : List α} {others : List β}, List.Forall₂ related items others →
      sumOver key value id items = sumOver key' value' id others
  | _, _, .nil => by simp [sumOver]
  | _, _, .cons hab hrest => by
    have := sumOver_forall₂ h id hrest
    obtain ⟨hk, hv⟩ := h _ _ hab
    simp only [sumOver, List.map_cons, List.sum_cons, hk, hv] at this ⊢
    rw [this]

/-- The working values of the loop after the allocations `done`: the pending book value and quantity
of each open item are the sums of what the allocations before added to it, and the pending
settlement quantity is the quantity already allocated from the settlement and the sum of what they
add; all are constructible. -/
structure PendingSpec (pending : SettlementPending) (done : List SettlementAllocationBody)
    (previousQuantity : ℚ) : Prop where
  book : ∀ id, ((settlementMapGet pending.byOpenItem id).getD ExactRational.zero).WF ∧
    ((settlementMapGet pending.byOpenItem id).getD ExactRational.zero).toRat =
      sumOver (·.openItemId) (·.openItemBookValue.toRat) id done
  openQuantity : ∀ id, ((settlementMapGet pending.openQuantity id).getD ExactRational.zero).WF ∧
    ((settlementMapGet pending.openQuantity id).getD ExactRational.zero).toRat =
      sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id done
  settlementQuantity : pending.settlementQuantity.WF ∧
    pending.settlementQuantity.toRat =
      previousQuantity + (done.map (·.allocatedSettlementQuantity.toRat)).sum

/-- At the start of the loop nothing is pending, and the settlement quantity is the one already
allocated. -/
theorem pendingSpec_initial {previous : AllocatedTotal} (hprevious : previous.WF) :
    PendingSpec ⟨[], [], previous.quantity⟩ [] previous.quantity.toRat := by
  refine ⟨fun id => ?_, fun id => ?_, ?_⟩
  · simp [settlementMapGet, sumOver, ExactRational.zero_wf, ExactRational.zero_toRat]
  · simp [settlementMapGet, sumOver, ExactRational.zero_wf, ExactRational.zero_toRat]
  · simpa using hprevious.quantity

/-- The book value an allocation adds to its open item is constructible. -/
theorem openItemBookValue_wf {allocation : SettlementAllocationBody} (h : allocation.WF) :
    allocation.openItemBookValue.WF := by
  unfold SettlementAllocationBody.openItemBookValue
  cases hv : allocation.allocatedOpenItemBookValue with
  | none => exact h.allocatedBookValue
  | some value => exact h.allocatedOpenItemBookValue value hv

/-- After an allocation the working values are those of the allocations before and this one. -/
theorem pendingUpdate_spec {pending pending' : SettlementPending}
    {done : List SettlementAllocationBody} {previousQuantity : ℚ}
    {allocation : SettlementAllocationBody} (hallocation : allocation.WF)
    (hpending : PendingSpec pending done previousQuantity)
    (h : pendingUpdate pending allocation = .ok pending') :
    PendingSpec pending' (done ++ [allocation]) previousQuantity := by
  unfold pendingUpdate at h
  dsimp only at h
  split at h
  · cases h
  rename_i bookValue hbook
  split at h
  · cases h
  rename_i quantity hquantity
  split at h
  · cases h
  rename_i settlementQuantity hsettled
  injection h with h
  subst h
  obtain ⟨hbookWF, hbookRat⟩ := ExactRational.add_ok
    (hpending.book allocation.openItemId).1 (openItemBookValue_wf hallocation) hbook
  obtain ⟨hquantityWF, hquantityRat⟩ := ExactRational.add_ok
    (hpending.openQuantity allocation.openItemId).1 hallocation.allocatedOpenQuantity hquantity
  obtain ⟨hsettledWF, hsettledRat⟩ := ExactRational.add_ok hpending.settlementQuantity.1
    hallocation.allocatedSettlementQuantity hsettled
  refine ⟨fun id => ?_, fun id => ?_, ?_⟩
  · simp only [settlementMapGet_settlementMapSet, sumOver_append_singleton]
    by_cases hid : allocation.openItemId = id
    · subst hid
      simp only [beq_self_eq_true, ↓reduceIte, Option.getD_some]
      refine ⟨hbookWF, ?_⟩
      rw [hbookRat, (hpending.book allocation.openItemId).2]
    · have hid' : (allocation.openItemId == id) = false := by simpa using hid
      simp only [hid', Bool.false_eq_true, ↓reduceIte, hid, add_zero]
      exact hpending.book id
  · simp only [settlementMapGet_settlementMapSet, sumOver_append_singleton]
    by_cases hid : allocation.openItemId = id
    · subst hid
      simp only [beq_self_eq_true, ↓reduceIte, Option.getD_some]
      refine ⟨hquantityWF, ?_⟩
      rw [hquantityRat, (hpending.openQuantity allocation.openItemId).2]
    · have hid' : (allocation.openItemId == id) = false := by simpa using hid
      simp only [hid', Bool.false_eq_true, ↓reduceIte, hid, add_zero]
      exact hpending.openQuantity id
  · refine ⟨hsettledWF, ?_⟩
    simp only [List.map_append, List.sum_append, List.map_cons, List.map_nil, List.sum_cons,
      List.sum_nil, add_zero]
    rw [hsettledRat, hpending.settlementQuantity.2]
    ring

/-- What the values of an allocation are, when they are computed: each is the result of the
operation the TypeScript makes on the ones before. -/
theorem allocationValues_ok {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody} {values : AllocationValues}
    (h : allocationValues request settlement item allocation = .ok values) :
    proportionalShare settlement.bookValue settlement.denomination
        allocation.allocatedSettlementQuantity = .ok values.settlementShare ∧
      values.settlementBookValue = allocation.allocatedSettlementBookValue.getD values.settlementShare ∧
      proportionalShare item.bookValue item.denomination allocation.allocatedOpenQuantity =
        .ok values.carryingShare ∧
      values.settlementBookValue.subtract allocation.openItemBookValue = .ok values.difference ∧
      pathCoherent request settlement item allocation allocation.allocatedSettlementQuantity
        values.settlementBookValue = .ok values.pathCoherent ∧
      expectedSettlementMeasurement request.quantizationPolicy values.settlementBookValue =
        .ok values.expectedMeasurement ∧
      expectedRealizedDifference request.quantizationPolicy values.difference =
        .ok values.expectedRealized := by
  unfold allocationValues at h
  dsimp only at h
  split at h
  · cases h
  rename_i settlementShare hshare
  split at h
  · cases h
  rename_i carryingShare hcarrying
  split at h
  · cases h
  rename_i difference hdifference
  split at h
  · cases h
  rename_i coherent hcoherent
  split at h
  · cases h
  rename_i measurement hmeasurement
  split at h
  · cases h
  rename_i realized hrealized
  injection h with h
  subst h
  exact ⟨liftNum_eq_ok.mp hshare, rfl, liftNum_eq_ok.mp hcarrying, liftNum_eq_ok.mp hdifference,
    liftNum_eq_ok.mp hcoherent, liftQuantize_eq_ok.mp hmeasurement,
    liftQuantize_eq_ok.mp hrealized⟩

/-- The first four clauses of line 1254 are all false exactly when the open item's book value is its
carrying share, the settlement's is its share, it is positive, and the path is coherent. -/
theorem allocationValueClauses_eq_false_iff (allocation : SettlementAllocationBody)
    (values : AllocationValues) :
    allocationValueClauses allocation values = false ↔
      allocation.openItemBookValue.equals values.carryingShare = true ∧
        values.settlementBookValue.equals values.settlementShare = true ∧
        positive values.settlementBookValue = true ∧ values.pathCoherent = true := by
  unfold allocationValueClauses SettlementAllocationBody.openItemBookValue
  simp [and_assoc]

/-- A recorded quantization that is compared with an absent one is absent. -/
theorem quantizationMatches_none {actual : Option QuantizedValue}
    (h : quantizationMatches actual none = .ok true) : actual = none := by
  cases actual with
  | none => rfl
  | some actual => simp [quantizationMatches] at h

/-- The test of line 1254 is false exactly when its four first clauses are, the two recorded
quantizations match the expected ones, and its three last clauses are. -/
theorem allocationValuesRejected_eq_false {request : SettlementRequest}
    {allocation : SettlementAllocationBody} {values : AllocationValues}
    (h : allocationValuesRejected request allocation values = .ok false) :
    allocationValueClauses allocation values = false ∧
      quantizationMatches allocation.settlementMeasurement values.expectedMeasurement = .ok true ∧
      quantizationMatches allocation.realizedExchangeDifference values.expectedRealized =
        .ok true ∧
      allocationRecordedClauses request allocation values = false := by
  unfold allocationValuesRejected at h
  split at h
  · cases h
  rename_i hclauses
  split at h
  · cases h
  · cases h
  rename_i hmeasurement
  split at h
  · cases h
  · cases h
  rename_i hrealized
  injection h with h
  exact ⟨by simpa using hclauses, hmeasurement, hrealized, h⟩

/-- The settlement's book value an allocation carries is the one it states, or its share. -/
theorem settledBookValue_eq {settlement : Settlement} {allocation : SettlementAllocationBody}
    {share : ExactRational}
    (h : proportionalShare settlement.bookValue settlement.denomination
      allocation.allocatedSettlementQuantity = .ok share) :
    settledBookValue settlement allocation = .ok (allocation.allocatedSettlementBookValue.getD share) := by
  unfold settledBookValue
  cases allocation.allocatedSettlementBookValue <;> simp [h]

/-- What a coherent path says of an allocation: between two denominations of one commodity it has no
valuation path; between two commodities it has a path from the settlement's commodity to the
functional commodity of the quantization policy, with a positive rate, with evidence, observed no
later than the settlement and effective on its date, and the settlement's book value is the
quantity at that rate. -/
def PathFacts (request : SettlementRequest) (settlement : Settlement) (item : OpenItem)
    (allocation : SettlementAllocationBody) (settlementBookValue : ExactRational) : Prop :=
  (item.denominationCommodityId = settlement.denominationCommodityId ∧
      allocation.valuationPath = none) ∨
    (item.denominationCommodityId ≠ settlement.denominationCommodityId ∧
      ∃ (path : CurrencyValuationPath) (policy : QuantizationPolicy),
        allocation.valuationPath = some path ∧ request.quantizationPolicy = some policy ∧
        path.fromCommodityId = settlement.denominationCommodityId ∧
        path.toCommodityId = policy.functionalCommodityId ∧ 0 < path.rate.toRat ∧
        path.evidenceIds ≠ [] ∧
        jsStringLe path.observedAt.value settlement.settledAt.value = true ∧
        jsSliceTen path.effectiveAt.value = jsSliceTen settlement.settledAt.value ∧
        settlementBookValue.toRat = allocation.allocatedSettlementQuantity.toRat * path.rate.toRat)

/-- When the path is coherent, `PathFacts` holds. -/
theorem pathCoherent_eq_true {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody} {settlementBookValue : ExactRational}
    (hquantity : allocation.allocatedSettlementQuantity.WF) (hvalue : settlementBookValue.WF)
    (hpath : ∀ path, allocation.valuationPath = some path → path.WF)
    (h : pathCoherent request settlement item allocation allocation.allocatedSettlementQuantity
      settlementBookValue = .ok true) :
    PathFacts request settlement item allocation settlementBookValue := by
  unfold pathCoherent at h
  split at h
  · rename_i hsame
    left
    refine ⟨by simpa using hsame, ?_⟩
    simpa using h
  · rename_i hdifferent
    right
    refine ⟨by simpa using hdifferent, ?_⟩
    split at h
    · rename_i path policy hpathEq hpolicyEq
      split at h
      · rename_i hconditions
        split at h
        · cases h
        · rename_i product hproduct
          simp only [Except.ok.injEq] at h
          obtain ⟨hproductWF, hproductRat⟩ :=
            ExactRational.multiply_ok hquantity (hpath path hpathEq).rate hproduct
          simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at hconditions
          obtain ⟨⟨⟨⟨⟨hfrom, hto⟩, hrate⟩, hevidence⟩, hobserved⟩, heffective⟩ := hconditions
          refine ⟨path, policy, hpathEq, hpolicyEq, hfrom, hto,
            (positive_iff (hpath path hpathEq).rate).mp hrate, ?_, hobserved, heffective, ?_⟩
          · intro hnil
            rw [hnil] at hevidence
            simp at hevidence
          · rw [← hproductRat]
            exact (ExactRational.equals_iff hvalue hproductWF).mp h
      · cases h
    · cases h

/-- Without a policy nothing is expected. -/
theorem expectedSettlementMeasurement_none (value : ExactRational) :
    expectedSettlementMeasurement none value = .ok none := rfl

/-- With a policy the expected measurement is the quantization of the value. -/
theorem expectedSettlementMeasurement_some {policy : QuantizationPolicy} {value : ExactRational}
    {expected : Option QuantizedValue}
    (h : expectedSettlementMeasurement (some policy) value = .ok expected) :
    ∃ measurement, expected = some measurement ∧ quantize value policy.rule = .ok measurement := by
  simp only [expectedSettlementMeasurement] at h
  split at h
  · cases h
  · rename_i measurement hmeasurement
    simp only [Except.ok.injEq] at h
    exact ⟨measurement, h.symm, hmeasurement⟩

/-- Without a policy no difference is expected. -/
theorem expectedRealizedDifference_none (difference : ExactRational) :
    expectedRealizedDifference none difference = .ok none := rfl

/-- A difference of zero expects no quantization. -/
theorem expectedRealizedDifference_zero (policy : Option QuantizationPolicy)
    {difference : ExactRational} (h : difference.isZero = true) :
    expectedRealizedDifference policy difference = .ok none := by
  cases policy <;> simp [expectedRealizedDifference, h]

/-- With a policy, the expected quantization of a difference that is not zero is its quantization. -/
theorem expectedRealizedDifference_some {policy : QuantizationPolicy} {difference : ExactRational}
    {expected : Option QuantizedValue} (hzero : difference.isZero = false)
    (h : expectedRealizedDifference (some policy) difference = .ok expected) :
    ∃ realized, expected = some realized ∧ quantize difference policy.rule = .ok realized := by
  simp only [expectedRealizedDifference, hzero, Bool.false_eq_true, ↓reduceIte] at h
  split at h
  · cases h
  · rename_i realized hrealized
    simp only [Except.ok.injEq] at h
    exact ⟨realized, h.symm, hrealized⟩

/-- The last three clauses of line 1254 are all false exactly when an allocation without a policy
records neither a measurement nor a difference, a difference that is not zero has an effect key, and
a difference of zero has none. -/
theorem allocationRecordedClauses_eq_false_iff (request : SettlementRequest)
    (allocation : SettlementAllocationBody) (values : AllocationValues) :
    allocationRecordedClauses request allocation values = false ↔
      (request.quantizationPolicy = none → allocation.settlementMeasurement = none ∧
        allocation.realizedExchangeDifference = none) ∧
      (values.difference.isZero = false → allocation.realizedExchangeEffectKey.isSome = true) ∧
      (values.difference.isZero = true → allocation.realizedExchangeEffectKey = none) := by
  unfold allocationRecordedClauses
  cases request.quantizationPolicy <;> cases allocation.settlementMeasurement <;>
    cases allocation.realizedExchangeDifference <;> cases values.difference.isZero <;>
    cases allocation.realizedExchangeEffectKey <;> simp

/-! ## The loop: what an allocation that passes carries -/

/-- What the tests of the loop say of an allocation that passed them, for the open item it is for
and the values computed for it (a rational is compared by its meaning, `toRat`). -/
structure AllocationFacts (context : SettlementReadContext) (request : SettlementRequest)
    (settlement : Settlement) (allocation : SettlementAllocationBody) (item : OpenItem)
    (values : AllocationValues) : Prop where
  /-- The open item is the one the context has. -/
  openItem : context.openItem allocation.openItemId = some item
  /-- The allocation is for this settlement. -/
  settlementId : allocation.settlementId = settlement.id
  /-- The allocation's derivation is approved, evidenced and dated. -/
  derivation : validAccountingDerivation allocation.derivation = true
  /-- The open item and the settlement are of one book, party and control account. -/
  bookId : item.bookId = settlement.bookId
  party : item.scope.externalPartyId = settlement.scope.externalPartyId
  controlAccount : item.scope.controlAccountId = settlement.scope.controlAccountId
  /-- The allocated book value and the two allocated quantities are positive. -/
  bookPositive : 0 < allocation.allocatedBookValue.toRat
  openQuantityPositive : 0 < allocation.allocatedOpenQuantity.toRat
  settlementQuantityPositive : 0 < allocation.allocatedSettlementQuantity.toRat
  /-- What the allocation adds to the open item is its allocated book value. -/
  openItemBookValue : allocation.openItemBookValue.toRat = allocation.allocatedBookValue.toRat
  /-- The allocated book value is the open item's book value in the proportion of the quantity to
  its denomination, exactly. -/
  denominationNonzero : item.denomination.toRat ≠ 0
  carrying : allocation.allocatedBookValue.toRat =
    |item.bookValue.toRat| * allocation.allocatedOpenQuantity.toRat / |item.denomination.toRat|
  /-- The settlement's book value the allocation carries is the settlement's in the proportion of
  the quantity to its denomination, exactly, and is positive. -/
  settlementDenominationNonzero : settlement.denomination.toRat ≠ 0
  settled : settledBookValue settlement allocation = .ok values.settlementBookValue
  settledWF : values.settlementBookValue.WF
  settledPositive : 0 < values.settlementBookValue.toRat
  settledShare : values.settlementBookValue.toRat =
    |settlement.bookValue.toRat| * allocation.allocatedSettlementQuantity.toRat /
      |settlement.denomination.toRat|
  /-- The realized difference is the settlement's book value less the open item's. -/
  difference : values.difference.WF ∧
    values.difference.toRat = values.settlementBookValue.toRat - allocation.allocatedBookValue.toRat
  /-- The path of the valuation is coherent. -/
  path : PathFacts request settlement item allocation values.settlementBookValue
  /-- A difference has an effect key, and an effect key has a difference. -/
  effectKey : allocation.realizedExchangeEffectKey.isSome = true ↔
    values.settlementBookValue.toRat ≠ allocation.allocatedBookValue.toRat
  /-- Without a policy, nothing is recorded and nothing is expected. -/
  withoutPolicy : request.quantizationPolicy = none →
    allocation.settlementMeasurement = none ∧ allocation.realizedExchangeDifference = none ∧
      values.expectedMeasurement = none ∧ values.expectedRealized = none
  /-- With a policy, the expected measurement is the quantization of the settlement's book value,
  and the expected difference that of the difference, unless it is zero, and then none is recorded. -/
  withPolicy : ∀ policy, request.quantizationPolicy = some policy →
    (∃ measurement, values.expectedMeasurement = some measurement ∧
      quantize values.settlementBookValue policy.rule = .ok measurement) ∧
    (values.settlementBookValue.toRat ≠ allocation.allocatedBookValue.toRat →
      ∃ realized, values.expectedRealized = some realized ∧
        quantize values.difference policy.rule = .ok realized) ∧
    (values.settlementBookValue.toRat = allocation.allocatedBookValue.toRat →
      values.expectedRealized = none ∧ allocation.realizedExchangeDifference = none)
  /-- The difference and the two expected quantizations are the results of the operations. -/
  differenceOk : values.settlementBookValue.subtract allocation.openItemBookValue =
    .ok values.difference
  measurementOk : expectedSettlementMeasurement request.quantizationPolicy
    values.settlementBookValue = .ok values.expectedMeasurement
  realizedOk : expectedRealizedDifference request.quantizationPolicy values.difference =
    .ok values.expectedRealized

/-- The test of line 1238 is false exactly when both of its parts are. -/
theorem allocationScopeViolated_eq_false {settlement : Settlement}
    {allocation : SettlementAllocationBody} {item : OpenItem} {prior : AllocatedTotal}
    {pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational}
    (h : allocationScopeViolated settlement allocation item prior pendingBookValue
      pendingQuantity pendingSettlementQuantity = .ok false) :
    allocationScopeClauses settlement allocation item = false ∧
      allocationCapacityExceeded settlement allocation item prior pendingBookValue
        pendingQuantity pendingSettlementQuantity = .ok false := by
  unfold allocationScopeViolated at h
  split at h
  · cases h
  · rename_i hclauses
    exact ⟨by simpa using hclauses, h⟩

/-- What one pass of the loop that goes on says: the allocation carries `AllocationFacts` for the
open item of the context; the open item's totals the context gives are not negative; what was
already allocated to the open item, with what the allocations before it added and this one, is
within the open item's book value and its denomination; what was already allocated from the
settlement, with what they added and this one, is within the settlement's denomination; and the
working values are those of the allocations up to this one. -/
theorem settlementAllocationStep_next {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending pending' : SettlementPending}
    {allocation : SettlementAllocationBody} {done : List SettlementAllocationBody}
    {previousQuantity : ℚ} (hcontext : context.WF) (hsettlement : settlement.WF)
    (hallocation : allocation.WF) (hpending : PendingSpec pending done previousQuantity)
    (h : settlementAllocationStep context request settlement pending allocation =
      .ok (.next pending')) :
    ∃ (item : OpenItem) (values : AllocationValues),
      AllocationFacts context request settlement allocation item values ∧
      0 ≤ (context.allocatedToOpenItem allocation.openItemId).bookValue.toRat ∧
      0 ≤ (context.allocatedToOpenItem allocation.openItemId).quantity.toRat ∧
      (context.allocatedToOpenItem allocation.openItemId).bookValue.toRat +
          sumOver (·.openItemId) (·.openItemBookValue.toRat) allocation.openItemId done +
          allocation.allocatedBookValue.toRat ≤ |item.bookValue.toRat| ∧
      (context.allocatedToOpenItem allocation.openItemId).quantity.toRat +
          sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) allocation.openItemId done +
          allocation.allocatedOpenQuantity.toRat ≤ |item.denomination.toRat| ∧
      previousQuantity + (done.map (·.allocatedSettlementQuantity.toRat)).sum +
          allocation.allocatedSettlementQuantity.toRat ≤ |settlement.denomination.toRat| ∧
      PendingSpec pending' (done ++ [allocation]) previousQuantity := by
  unfold settlementAllocationStep at h
  dsimp only at h
  split at h
  · cases h
  rename_i hnegative
  split at h
  · cases h
  rename_i hrecognized
  split at h
  · cases h
  rename_i item hitem
  split at h
  · cases h
  · cases h
  rename_i hscope
  split at h
  · cases h
  rename_i values hvalues
  split at h
  · cases h
  · cases h
  rename_i hrejected
  split at h
  · cases h
  rename_i next hnext
  injection h with h
  injection h with h
  subst h
  have hprior := hcontext.allocatedToOpenItem allocation.openItemId
  have hitemWF : item.WF := hcontext.openItem _ item hitem
  obtain ⟨hclauses, hcapacity⟩ := allocationScopeViolated_eq_false (liftNum_eq_ok.mp hscope)
  have hcap := allocationCapacityExceeded_eq_false hsettlement hitemWF hallocation hprior
    (hpending.book allocation.openItemId).1 (hpending.openQuantity allocation.openItemId).1
    hpending.settlementQuantity.1 hcapacity
  obtain ⟨hsettlementId, hderivation, hbookId, hparty, hcontrol, hbookPos, hopenPos, hsettledPos,
    hobv⟩ := (allocationScopeClauses_eq_false_iff _ _ _).mp hclauses
  obtain ⟨hshare, hsbv, hcarrying, hdifference, hpath, hmeasurement, hrealized⟩ :=
    allocationValues_ok hvalues
  obtain ⟨hvclauses, hmatch1, hmatch2, hrecorded⟩ :=
    allocationValuesRejected_eq_false (liftNum_eq_ok.mp hrejected)
  obtain ⟨hcl1, hcl2, hcl3, hcl4⟩ := (allocationValueClauses_eq_false_iff _ _).mp hvclauses
  obtain ⟨hrec1, hrec2, hrec3⟩ := (allocationRecordedClauses_eq_false_iff _ _ _).mp hrecorded
  have hbookPos' := (positive_iff hallocation.allocatedBookValue).mp hbookPos
  have hopenPos' := (positive_iff hallocation.allocatedOpenQuantity).mp hopenPos
  have hsettledPos' := (positive_iff hallocation.allocatedSettlementQuantity).mp hsettledPos
  have hobvWF := openItemBookValue_wf hallocation
  have hobvEq : allocation.openItemBookValue.toRat = allocation.allocatedBookValue.toRat := by
    unfold SettlementAllocationBody.openItemBookValue
    cases hv : allocation.allocatedOpenItemBookValue with
    | none => rfl
    | some value =>
      exact (ExactRational.equals_iff (hallocation.allocatedOpenItemBookValue value hv)
        hallocation.allocatedBookValue).mp (hobv value hv)
  obtain ⟨hcarryWF, hden, hcarryRat⟩ :=
    proportionalShare_ok hitemWF.bookValue hitemWF.denomination hallocation.allocatedOpenQuantity
      hcarrying
  obtain ⟨hshareWF, hsden, hshareRat⟩ :=
    proportionalShare_ok hsettlement.bookValue hsettlement.denomination
      hallocation.allocatedSettlementQuantity hshare
  have hsbvWF : values.settlementBookValue.WF := by
    rw [hsbv]
    cases hv : allocation.allocatedSettlementBookValue with
    | none => exact hshareWF
    | some value => exact hallocation.allocatedSettlementBookValue value hv
  have hsbvEq : values.settlementBookValue.toRat = values.settlementShare.toRat :=
    (ExactRational.equals_iff hsbvWF hshareWF).mp hcl2
  obtain ⟨hdifferenceWF, hdifferenceRat⟩ :=
    ExactRational.subtract_ok hsbvWF hobvWF hdifference
  rw [hobvEq] at hdifferenceRat
  have hzero : values.difference.isZero = true ↔
      values.settlementBookValue.toRat = allocation.allocatedBookValue.toRat := by
    rw [ExactRational.isZero_iff hdifferenceWF, hdifferenceRat, sub_eq_zero]
  have hpathFacts : PathFacts request settlement item allocation values.settlementBookValue := by
    rw [hcl4] at hpath
    exact pathCoherent_eq_true hallocation.allocatedSettlementQuantity hsbvWF
      hallocation.valuationPath hpath
  refine ⟨item, values, ⟨hitem, hsettlementId, hderivation, hbookId, hparty, hcontrol, hbookPos',
    hopenPos', hsettledPos', hobvEq, hden, ?_, hsden, ?_, hsbvWF, ?_, ?_, ⟨hdifferenceWF,
    hdifferenceRat⟩, hpathFacts, ?_, ?_, ?_, hdifference, hmeasurement, hrealized⟩, ?_, ?_, ?_, ?_,
    ?_, ?_⟩
  · rw [← hobvEq, (ExactRational.equals_iff hobvWF hcarryWF).mp hcl1, hcarryRat]
  · rw [hsbv]
    exact settledBookValue_eq hshare
  · exact (positive_iff hsbvWF).mp hcl3
  · rw [hsbvEq, hshareRat]
  · constructor
    · intro hsome hz
      have := hrec3 (hzero.mpr hz)
      rw [this] at hsome
      cases hsome
    · intro hne
      by_cases hz : values.difference.isZero = true
      · exact absurd (hzero.mp hz) hne
      · exact hrec2 (by simpa using hz)
  · intro hnone
    rw [hnone, expectedSettlementMeasurement_none] at hmeasurement
    rw [hnone, expectedRealizedDifference_none] at hrealized
    obtain ⟨hmeas, hreal⟩ := hrec1 hnone
    exact ⟨hmeas, hreal, (Except.ok.inj hmeasurement).symm, (Except.ok.inj hrealized).symm⟩
  · intro policy hpolicy
    rw [hpolicy] at hmeasurement hrealized
    refine ⟨expectedSettlementMeasurement_some hmeasurement, fun hne => ?_, fun heq => ?_⟩
    · have hnz : values.difference.isZero = false := by
        by_cases hz : values.difference.isZero = true
        · exact absurd (hzero.mp hz) hne
        · simpa using hz
      exact expectedRealizedDifference_some hnz hrealized
    · have hz := hzero.mpr heq
      have hexp : values.expectedRealized = none := by
        rw [expectedRealizedDifference_zero _ hz] at hrealized
        exact (Except.ok.inj hrealized).symm
      rw [hexp] at hmatch2
      exact ⟨hexp, quantizationMatches_none hmatch2⟩
  · have := (ExactRational.isNegative_iff hprior.bookValue).not.mp
      (by intro hb; exact hnegative (by simp [hb]))
    exact not_lt.mp this
  · have := (ExactRational.isNegative_iff hprior.quantity).not.mp
      (by intro hb; exact hnegative (by simp [hb]))
    exact not_lt.mp this
  · have := hcap.1
    rw [(hpending.book allocation.openItemId).2] at this
    exact this
  · have := hcap.2.1
    rw [(hpending.openQuantity allocation.openItemId).2] at this
    exact this
  · have := hcap.2.2
    rw [hpending.settlementQuantity.2] at this
    exact this
  · exact pendingUpdate_spec hallocation hpending (liftNum_eq_ok.mp hnext)

/-! ## The loop: what it keeps true -/

/-- What is true after the loop has passed the allocations `done`: the working values are their
sums; each carries `AllocationFacts`; what is allocated to every open item they are for, with what
was allocated before, is within the open item's book value and its denomination; and what is
allocated from the settlement, with what was allocated before, is within its denomination. -/
structure LoopInvariant (context : SettlementReadContext) (request : SettlementRequest)
    (settlement : Settlement) (previousQuantity : ℚ) (done : List SettlementAllocationBody)
    (pending : SettlementPending) : Prop where
  pending : PendingSpec pending done previousQuantity
  facts : ∀ allocation ∈ done, ∃ (item : OpenItem) (values : AllocationValues),
    AllocationFacts context request settlement allocation item values
  openBound : ∀ id, (∃ allocation ∈ done, allocation.openItemId = id) →
    ∃ item : OpenItem, context.openItem id = some item ∧
      (context.allocatedToOpenItem id).bookValue.toRat +
          sumOver (·.openItemId) (·.openItemBookValue.toRat) id done ≤ |item.bookValue.toRat| ∧
      (context.allocatedToOpenItem id).quantity.toRat +
          sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id done ≤
        |item.denomination.toRat|
  settlementBound : done ≠ [] →
    previousQuantity + (done.map (·.allocatedSettlementQuantity.toRat)).sum ≤
      |settlement.denomination.toRat|

/-- Nothing has been passed at the start. -/
theorem loopInvariant_initial {context : SettlementReadContext} {request : SettlementRequest}
    {settlement : Settlement} {previous : AllocatedTotal} (hprevious : previous.WF) :
    LoopInvariant context request settlement previous.quantity.toRat []
      ⟨[], [], previous.quantity⟩ :=
  ⟨pendingSpec_initial hprevious, by simp, by simp, by simp⟩

/-- One pass of the loop that goes on keeps the invariant. -/
theorem loopInvariant_step {context : SettlementReadContext} {request : SettlementRequest}
    {settlement : Settlement} {previousQuantity : ℚ} {done : List SettlementAllocationBody}
    {pending pending' : SettlementPending} {allocation : SettlementAllocationBody}
    (hcontext : context.WF) (hsettlement : settlement.WF) (hallocation : allocation.WF)
    (hinvariant : LoopInvariant context request settlement previousQuantity done pending)
    (h : settlementAllocationStep context request settlement pending allocation =
      .ok (.next pending')) :
    LoopInvariant context request settlement previousQuantity (done ++ [allocation]) pending' := by
  obtain ⟨item, values, hfacts, -, -, hbook, hquantity, hsettled, hpending'⟩ :=
    settlementAllocationStep_next hcontext hsettlement hallocation hinvariant.pending h
  refine ⟨hpending', ?_, ?_, ?_⟩
  · intro a ha
    rcases List.mem_append.mp ha with ha | ha
    · exact hinvariant.facts a ha
    · rw [List.mem_singleton.mp ha]
      exact ⟨item, values, hfacts⟩
  · intro id ⟨a, ha, hid⟩
    by_cases hsame : allocation.openItemId = id
    · subst hsame
      refine ⟨item, hfacts.openItem, ?_, ?_⟩
      · rw [sumOver_append_singleton]
        simp only [↓reduceIte]
        rw [hfacts.openItemBookValue]
        linarith
      · rw [sumOver_append_singleton]
        simp only [↓reduceIte]
        linarith
    · have hold : ∃ a ∈ done, a.openItemId = id := by
        rcases List.mem_append.mp ha with ha | ha
        · exact ⟨a, ha, hid⟩
        · rw [List.mem_singleton.mp ha] at hid
          exact absurd hid hsame
      obtain ⟨item', hitem', hb, hq⟩ := hinvariant.openBound id hold
      refine ⟨item', hitem', ?_, ?_⟩
      · rw [sumOver_append_singleton]
        simp only [hsame, ↓reduceIte, add_zero]
        exact hb
      · rw [sumOver_append_singleton]
        simp only [hsame, ↓reduceIte, add_zero]
        exact hq
  · intro _
    simp only [List.map_append, List.map_cons, List.map_nil, List.sum_append, List.sum_cons,
      List.sum_nil, add_zero]
    linarith

/-- The loop that goes on to its end keeps the invariant through every allocation it passes. -/
theorem loopInvariant_loop {context : SettlementReadContext} {request : SettlementRequest}
    {settlement : Settlement} {previousQuantity : ℚ} (hcontext : context.WF)
    (hsettlement : settlement.WF) :
    ∀ {items : List SettlementAllocationBody} {done : List SettlementAllocationBody}
      {pending pending' : SettlementPending},
      (∀ allocation ∈ items, allocation.WF) →
      LoopInvariant context request settlement previousQuantity done pending →
      settlementAllocationLoop context request settlement pending items = .ok (.next pending') →
      LoopInvariant context request settlement previousQuantity (done ++ items) pending'
  | [], done, pending, pending', _, hinvariant, h => by
    simp only [settlementAllocationLoop, Except.ok.injEq, SettlementStep.next.injEq] at h
    subst h
    simpa using hinvariant
  | allocation :: rest, done, pending, pending', hwf, hinvariant, h => by
    unfold settlementAllocationLoop at h
    split at h
    · cases h
    · cases h
    · rename_i next hstep
      have hstep' := loopInvariant_step hcontext hsettlement (hwf allocation (by simp))
        hinvariant hstep
      have := loopInvariant_loop hcontext hsettlement (done := done ++ [allocation])
        (fun a ha => hwf a (List.mem_cons_of_mem _ ha)) hstep' h
      simpa [List.append_assoc] using this

/-- The book value of the settlement that an allocation carries is constructible. -/
theorem settledBookValue_wf {settlement : Settlement} {allocation : SettlementAllocationBody}
    {value : ExactRational} (hsettlement : settlement.WF) (hallocation : allocation.WF)
    (h : settledBookValue settlement allocation = .ok value) : value.WF := by
  unfold settledBookValue at h
  split at h
  · rename_i stated hstated
    simp only [Except.ok.injEq] at h
    subst h
    exact hallocation.allocatedSettlementBookValue stated hstated
  · exact (proportionalShare_ok hsettlement.bookValue hsettlement.denomination
      hallocation.allocatedSettlementQuantity h).1

/-- When the settlement's book value is read from every allocation, each is read from its own. -/
theorem settledBookValues_forall₂ {settlement : Settlement} :
    ∀ {items : List SettlementAllocationBody} {values : List ExactRational},
      settledBookValues settlement items = .ok values →
      List.Forall₂ (fun item value => settledBookValue settlement item = .ok value) items values
  | [], values, h => by
    simp only [settledBookValues, Except.ok.injEq] at h
    subst h
    exact .nil
  | item :: rest, values, h => by
    unfold settledBookValues at h
    split at h
    · cases h
    rename_i first hfirst
    split at h
    · cases h
    rename_i others hothers
    injection h with h
    subst h
    exact .cons hfirst (settledBookValues_forall₂ hothers)

/-- A member of the right list of two lists that correspond is the image of a member of the left. -/
theorem forall₂_mem_right {α β : Type} {related : α → β → Prop} :
    ∀ {left : List α} {right : List β}, List.Forall₂ related left right →
      ∀ b ∈ right, ∃ a ∈ left, related a b
  | _, _, .nil, b, hb => by simp at hb
  | _, _, .cons hab hrest, b, hb => by
    rcases List.mem_cons.mp hb with rfl | hb
    · exact ⟨_, List.mem_cons_self, hab⟩
    · obtain ⟨a, ha, hrelated⟩ := forall₂_mem_right hrest b hb
      exact ⟨a, List.mem_cons_of_mem _ ha, hrelated⟩

/-- When the over-allocation test of line 1259 is false, what was allocated from the settlement
before, with the settlement's book value that every allocation carries, is within its book value. -/
theorem settlementOverAllocated_eq_false {settlement : Settlement} {previous : AllocatedTotal}
    {items : List SettlementAllocationBody} (hsettlement : settlement.WF) (hprevious : previous.WF)
    (hitems : ∀ item ∈ items, item.WF)
    (h : settlementOverAllocated settlement previous items = .ok false) :
    ∃ values : List ExactRational,
      List.Forall₂ (fun item value => settledBookValue settlement item = .ok value) items values ∧
      previous.bookValue.toRat + (values.map ExactRational.toRat).sum ≤
        |settlement.bookValue.toRat| := by
  unfold settlementOverAllocated at h
  split at h
  · cases h
  rename_i values hvalues
  have hforall := settledBookValues_forall₂ hvalues
  have hwf : ∀ value ∈ values, value.WF := by
    intro value hvalue
    obtain ⟨item, hitem, hread⟩ := forall₂_mem_right hforall value hvalue
    exact settledBookValue_wf hsettlement (hitems item hitem) hread
  split at h
  · cases h
  rename_i total htotal
  split at h
  · cases h
  rename_i allocated hallocated
  obtain ⟨htotalWF, htotalRat⟩ := addExactValues_ok ExactRational.zero_wf hwf htotal
  obtain ⟨hallocatedWF, hallocatedRat⟩ :=
    ExactRational.add_ok hprevious.bookValue htotalWF hallocated
  simp only [Except.ok.injEq] at h
  have hle : ¬ (allocated.compare settlement.bookValue.abs == .gt) = true := by simpa using h
  have := not_lt.mp (mt (compare_beq_gt_iff hallocatedWF
    (ExactRational.abs_wf hsettlement.bookValue)).mpr hle)
  rw [ExactRational.abs_toRat hsettlement.bookValue, hallocatedRat, htotalRat] at this
  exact ⟨values, hforall, by simpa [exactTotalRat, ExactRational.zero_toRat] using this⟩

/-! ## The settlement that was recorded -/

/-- The totals already allocated from the settlement that a request counts: those the context gives
for `allocateExisting`, none for a settlement that is being created (lines 1214 and 1220). -/
def SettlementRequest.previousTotals (context : SettlementReadContext)
    (request : SettlementRequest) : AllocatedTotal :=
  if request.existing then context.allocatedFromSettlement request.settlement.id
  else AllocatedTotal.zero

/-- Totals of zero are constructible. -/
theorem AllocatedTotal.zero_wf : AllocatedTotal.zero.WF :=
  ⟨ExactRational.zero_wf, ExactRational.zero_wf⟩

/-- The totals the previous settlement gives are those of the request, and for `allocateExisting`
the settlement the context holds is the one of the request, with the hash of its own body, and the
totals are not negative. -/
theorem previousSettlementTotals_totals {context : SettlementReadContext}
    {settlement : Settlement} {existing : Bool} {previous : AllocatedTotal}
    (h : previousSettlementTotals context settlement existing = .ok (.totals previous)) :
    previous = (if existing then context.allocatedFromSettlement settlement.id
      else AllocatedTotal.zero) ∧
    (existing = true →
      (∃ retained, context.existingSettlement settlement.id = some retained ∧
        contentHashEquals retained.contentHash settlement.contentHash = true ∧
        validateAccountingEffectHash (.settlement retained) = .ok true) ∧
      previous.bookValue.isNegative = false ∧ previous.quantity.isNegative = false) := by
  unfold previousSettlementTotals at h
  split at h
  · rename_i hnot
    simp only [Except.ok.injEq, SettlementPrevious.totals.injEq] at h
    have : existing = false := by simpa using hnot
    subst this
    subst h
    exact ⟨rfl, fun h => absurd h (by simp)⟩
  · rename_i hexisting
    have hexisting' : existing = true := by simpa using hexisting
    split at h
    · cases h
    · rename_i retained hretained
      split at h
      · cases h
      · rename_i hhash
        split at h
        · cases h
        · cases h
        · rename_i hvalid
          dsimp only at h
          split at h
          · cases h
          · rename_i hnegative
            simp only [Except.ok.injEq, SettlementPrevious.totals.injEq] at h
            subst h
            refine ⟨by simp [hexisting'], fun _ => ⟨⟨retained, hretained, by simpa using hhash, hvalid⟩,
              ?_, ?_⟩⟩
            · simpa using (by simpa using hnegative : _ ∧ _).1
            · simpa using (by simpa using hnegative : _ ∧ _).2

/-! ## The laws of an accepted request -/

/-- Everything an accepted request has been through, at once: the draft, the invariant of the loop
at its end, how each allocation was built, the settlement's book value each allocation carries
against what was allocated before, and the settlement that was recorded. -/
theorem calculateSettlement_facts {context : SettlementReadContext} {request : SettlementRequest}
    {draft : AccountingDraft} (hcontext : context.WF) (hrequest : request.WF)
    (h : calculateSettlement context request = .ok (.draft draft)) :
    ∃ (pending : SettlementPending) (built : List SettlementAllocation)
      (values : List ExactRational),
      settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = false ∧
      draft = { journals :=  [],
                effects := settlementEffects request.existing request.hashedSettlement built } ∧
      (request.previousTotals context).WF ∧
      LoopInvariant context request request.hashedSettlement
        (request.previousTotals context).quantity.toRat request.allocations pending ∧
      List.Forall₂ (BuiltFrom request request.hashedSettlement) request.allocations built ∧
      List.Forall₂ (fun item value => settledBookValue request.hashedSettlement item = .ok value)
        request.allocations values ∧
      (request.previousTotals context).bookValue.toRat + (values.map ExactRational.toRat).sum ≤
        |request.settlement.bookValue.toRat| ∧
      (request.existing = true →
        ∃ retained, context.existingSettlement request.settlement.id = some retained ∧
          contentHashEquals retained.contentHash request.hashedSettlement.contentHash = true ∧
          validateAccountingEffectHash (.settlement retained) = .ok true) := by
  obtain ⟨previous, pending, built, hincoherent, hinvalid, hprevious, hloop, hover, hbuild,
    hdraft⟩ := calculateSettlement_draft h
  obtain ⟨hprevEq, hretained⟩ := previousSettlementTotals_totals hprevious
  have hprevEq' : previous = request.previousTotals context := by
    rw [hprevEq]; rfl
  subst hprevEq'
  have hprevWF : (request.previousTotals context).WF := by
    unfold SettlementRequest.previousTotals
    split
    · exact hcontext.allocatedFromSettlement _
    · exact AllocatedTotal.zero_wf
  have hsettlement : request.hashedSettlement.WF := hrequest.settlement
  have hinvariant := loopInvariant_loop hcontext hsettlement hrequest.allocations
    (loopInvariant_initial (context := context) (request := request)
      (settlement := request.hashedSettlement) hprevWF) hloop
  obtain ⟨values, hvalues, hbound⟩ := settlementOverAllocated_eq_false hsettlement hprevWF
    hrequest.allocations hover
  refine ⟨pending, built, values, hincoherent, hinvalid, hdraft, hprevWF, by simpa using hinvariant,
    buildSettlementAllocations_forall₂ hbuild, hvalues, hbound, fun hexisting => ?_⟩
  obtain ⟨retained, hr, hh, hv⟩ := (hretained hexisting).1
  exact ⟨retained, hr, hh, hv⟩

/-! ### The draft: no journal, and its effects -/

/-- The settlement allocations among a list of effects, in order. -/
def allocationEffects (effects : List AccountingEffect) : List SettlementAllocation :=
  effects.filterMap fun
    | .settlementAllocation allocation => some allocation
    | _ => none

/-- The settlements among a list of effects, in order. -/
def settlementEffectsOf (effects : List AccountingEffect) : List Settlement :=
  effects.filterMap fun
    | .settlement settlement => some settlement
    | _ => none

/-- The allocation effects of the effects of a draft are its allocations. -/
theorem allocationEffects_settlementEffects (existing : Bool) (settlement : Settlement)
    (allocations : List SettlementAllocation) :
    allocationEffects (settlementEffects existing settlement allocations) = allocations := by
  unfold settlementEffects allocationEffects
  induction allocations with
  | nil => cases existing <;> simp
  | cons allocation rest ih => cases existing <;> simp_all

/-- The settlement effects of the effects of a draft are its settlement, unless it was recorded
already. -/
theorem settlementEffectsOf_settlementEffects (existing : Bool) (settlement : Settlement)
    (allocations : List SettlementAllocation) :
    settlementEffectsOf (settlementEffects existing settlement allocations) =
      if existing then [] else [settlement] := by
  unfold settlementEffects settlementEffectsOf
  induction allocations with
  | nil => cases existing <;> simp
  | cons allocation rest ih => cases existing <;> simp_all

/-- What a built allocation keeps of its item, and what it states: the identifiers, the quantities,
the valuation path, the effect key and the derivation are the item's; the book value is what it adds
to its open item, and it states it for both the allocation and the open item; and the settlement's
book value it states is the one the item carries. -/
theorem BuiltFrom.fields {request : SettlementRequest} {settlement : Settlement}
    {item : SettlementAllocationBody} {built : SettlementAllocation}
    (h : BuiltFrom request settlement item built) :
    built.id = item.id ∧ built.openItemId = item.openItemId ∧
      built.settlementId = item.settlementId ∧
      built.allocatedBookValue = item.openItemBookValue ∧
      built.allocatedOpenQuantity = item.allocatedOpenQuantity ∧
      built.allocatedSettlementQuantity = item.allocatedSettlementQuantity ∧
      built.valuationPath = item.valuationPath ∧
      built.realizedExchangeEffectKey = item.realizedExchangeEffectKey ∧
      built.derivation = item.derivation ∧
      built.allocatedOpenItemBookValue = some item.openItemBookValue ∧
      ∃ settled, settledBookValue settlement item = .ok settled ∧
        built.allocatedSettlementBookValue = some settled := by
  obtain ⟨settled, difference, measurement, realized, hsettled, -, -, -, hbody, -⟩ := h
  have hbody' : built.toSettlementAllocationBody = _ := hbody
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, settled, hsettled, ?_⟩ <;>
    simp only [hbody', settlementAllocationBody, SettlementAllocationBody.openItemBookValue]

/-- A built allocation carries the hash of its body. -/
theorem BuiltFrom.hash {request : SettlementRequest} {settlement : Settlement}
    {item : SettlementAllocationBody} {built : SettlementAllocation}
    (h : BuiltFrom request settlement item built) :
    built.contentHash = accountingHash "SettlementAllocation" built.toSettlementAllocationBody := by
  obtain ⟨-, -, -, -, -, -, -, -, -, hhash⟩ := h
  exact hhash

/-- A sum over two lists that correspond to a third in the same way is the same. -/
theorem sum_forall₂ {α β γ : Type} {first : α → β → Prop} {second : α → γ → Prop}
    {f : β → ℚ} {g : γ → ℚ} (h : ∀ a b c, first a b → second a c → f b = g c) :
    ∀ {items : List α} {left : List β} {right : List γ}, List.Forall₂ first items left →
      List.Forall₂ second items right → (left.map f).sum = (right.map g).sum
  | _, _, _, .nil, .nil => rfl
  | _, _, _, .cons hab hrest, .cons hac hrest' => by
    simp only [List.map_cons, List.sum_cons]
    rw [h _ _ _ hab hac, sum_forall₂ h hrest hrest']

/-- The effects of an accepted request, which hold the hash of their body, pass the hash check. -/
theorem settlementEffects_hash {request : SettlementRequest} {built : List SettlementAllocation}
    (hbuilt : List.Forall₂ (BuiltFrom request request.hashedSettlement) request.allocations built) :
    ∀ effect ∈ settlementEffects request.existing request.hashedSettlement built,
      validateAccountingEffectHash effect = .ok true := by
  intro effect hmem
  unfold settlementEffects at hmem
  rcases List.mem_append.mp hmem with hmem | hmem
  · cases hexisting : request.existing
    · simp only [hexisting, Bool.false_eq_true, ↓reduceIte, List.mem_singleton] at hmem
      subst hmem
      exact validateAccountingEffectHash_settlement rfl
    · simp [hexisting] at hmem
  · obtain ⟨allocation, hallocation, rfl⟩ := List.mem_map.mp hmem
    obtain ⟨item, -, hfrom⟩ := forall₂_mem_right hbuilt allocation hallocation
    exact validateAccountingEffectHash_settlementAllocation hfrom.hash

/-- Applying the allocation effects of a list appends the allocations to the state's. -/
theorem foldl_applyAccountingEffect_allocations (state : AccountingCanonicalState)
    (allocations : List SettlementAllocation) :
    (allocations.map AccountingEffect.settlementAllocation).foldl applyAccountingEffect state =
      { state with settlementAllocations := state.settlementAllocations ++ allocations } := by
  induction allocations generalizing state with
  | nil => simp
  | cons allocation rest ih =>
    simp only [List.map_cons, List.foldl_cons, applyAccountingEffect]
    rw [ih]
    simp [List.append_assoc]

/-- Applying the effects of an accepted request adds exactly them to the state, the settlement to the
settlements (unless it was recorded already) and the allocations to the allocations, and changes
nothing else. -/
theorem applyEffects_settlementEffects (state : AccountingCanonicalState) (existing : Bool)
    (settlement : Settlement) (allocations : List SettlementAllocation) :
    (settlementEffects existing settlement allocations).foldl applyAccountingEffect state =
      { state with
        settlements := state.settlements ++ (if existing then [] else [settlement])
        settlementAllocations := state.settlementAllocations ++ allocations } := by
  unfold settlementEffects
  rw [List.foldl_append, foldl_applyAccountingEffect_allocations]
  cases existing <;> simp [applyAccountingEffect]

/-- An accepted settlement draft holds no journal: a settlement writes no posting, and the posting
of a realized exchange difference is not made here. -/
theorem calculateSettlement_journals {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft}
    (h : calculateSettlement context request = .ok (.draft draft)) : draft.journals = [] := by
  obtain ⟨_, _, _, -, -, -, -, -, -, hdraft⟩ := calculateSettlement_draft h
  rw [hdraft]

/-- The effects of an accepted request are the settlement, unless it was recorded already, and one
allocation for each allocation of the request, in order. -/
theorem calculateSettlement_effects {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft}
    (h : calculateSettlement context request = .ok (.draft draft)) :
    ∃ built : List SettlementAllocation,
      draft.effects = settlementEffects request.existing request.hashedSettlement built ∧
      List.Forall₂ (BuiltFrom request request.hashedSettlement) request.allocations built := by
  obtain ⟨_, _, built, -, -, -, -, -, hbuild, hdraft⟩ := calculateSettlement_draft h
  exact ⟨built, by rw [hdraft], buildSettlementAllocations_forall₂ hbuild⟩

/-- The settlement and the allocations that an accepted request produces each carry the hash of
their body, and the check the kernel makes of an effect's hash passes for each. -/
theorem calculateSettlement_hashes {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft}
    (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ effect ∈ draft.effects, validateAccountingEffectHash effect = .ok true := by
  obtain ⟨built, heffects, hbuilt⟩ := calculateSettlement_effects h
  rw [heffects]
  exact settlementEffects_hash hbuilt

/-- Applying the effects of an accepted request adds exactly them to the state: the settlement,
unless it was recorded already, and the allocations; nothing else changes. -/
theorem calculateSettlement_applied {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft}
    (h : calculateSettlement context request = .ok (.draft draft))
    (state : AccountingCanonicalState) :
    ∃ built : List SettlementAllocation,
      List.Forall₂ (BuiltFrom request request.hashedSettlement) request.allocations built ∧
      draft.effects.foldl applyAccountingEffect state =
        { state with
          settlements := state.settlements ++
            (if request.existing then [] else [request.hashedSettlement])
          settlementAllocations := state.settlementAllocations ++ built } := by
  obtain ⟨built, heffects, hbuilt⟩ := calculateSettlement_effects h
  exact ⟨built, hbuilt, by rw [heffects, applyEffects_settlementEffects]⟩

/-! ### What is allocated never exceeds what is open -/

/-- Two scopes with the same party and control account are the same. -/
theorem SettlementScope.ext' {a b : SettlementScope} (hparty : a.externalPartyId = b.externalPartyId)
    (hcontrol : a.controlAccountId = b.controlAccountId) : a = b := by
  cases a; cases b; simp_all

/-- The what is allocated to an open item never exceeds what is open: for every open item that an
accepted request allocates to, what the context says was allocated to it before, with what the
request allocates to it (its book value and its quantity), is within the open item's book value and
its denomination. -/
theorem calculateSettlement_open_bound {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ id, (∃ allocation ∈ allocationEffects draft.effects, allocation.openItemId = id) →
      ∃ item : OpenItem, context.openItem id = some item ∧
        (context.allocatedToOpenItem id).bookValue.toRat +
            sumOver (·.openItemId) (·.allocatedBookValue.toRat) id
              (allocationEffects draft.effects) ≤ |item.bookValue.toRat| ∧
        (context.allocatedToOpenItem id).quantity.toRat +
            sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id
              (allocationEffects draft.effects) ≤ |item.denomination.toRat| := by
  obtain ⟨pending, built, values, -, -, hdraft, hprevious, hinvariant, hbuilt, -, -, -⟩ :=
    calculateSettlement_facts hcontext hrequest h
  rw [hdraft]
  simp only [allocationEffects_settlementEffects]
  have hfields : ∀ item allocation, BuiltFrom request request.hashedSettlement item allocation →
      item.openItemId = allocation.openItemId ∧
        item.openItemBookValue.toRat = allocation.allocatedBookValue.toRat ∧
        item.allocatedOpenQuantity.toRat = allocation.allocatedOpenQuantity.toRat := by
    intro item allocation hfrom
    obtain ⟨-, hopen, -, hbook, hquantity, -⟩ := hfrom.fields
    exact ⟨hopen.symm, by rw [hbook], by rw [hquantity]⟩
  intro id ⟨allocation, hallocation, hid⟩
  obtain ⟨item, hitem, hfrom⟩ := forall₂_mem_right hbuilt allocation hallocation
  obtain ⟨hkey, -, -⟩ := hfields item allocation hfrom
  obtain ⟨openItem, hopenItem, hbook, hquantity⟩ :=
    hinvariant.openBound id ⟨item, hitem, by rw [hkey, hid]⟩
  refine ⟨openItem, hopenItem, ?_, ?_⟩
  · rw [← sumOver_forall₂ (related := BuiltFrom request request.hashedSettlement)
      (fun item allocation hfrom => ⟨(hfields item allocation hfrom).1,
        (hfields item allocation hfrom).2.1⟩) id hbuilt]
    exact hbook
  · rw [← sumOver_forall₂ (related := BuiltFrom request request.hashedSettlement)
      (fun item allocation hfrom => ⟨(hfields item allocation hfrom).1,
        (hfields item allocation hfrom).2.2⟩) id hbuilt]
    exact hquantity

/-- An observation that is not `"present"` is `"absent"`. -/
theorem IdentityObservation.ne_present_iff {observation : IdentityObservation} :
    ¬ observation = .present ↔ observation = .absent := by
  cases observation <;> simp

/-- An observation is read as present exactly when it is `"present"`. -/
theorem settlementIdentityPresent_eq_true {observation : IdentityObservation} :
    settlementIdentityPresent observation = true ↔ observation = .present := by
  cases observation <;> simp [settlementIdentityPresent]

/-- An observation is read as not present exactly when it is `"absent"`. -/
theorem settlementIdentityPresent_eq_false {observation : IdentityObservation} :
    settlementIdentityPresent observation = false ↔ observation = .absent := by
  cases observation <;> simp [settlementIdentityPresent]

/-- A request that allocates an existing settlement does not recognize an unallocated one. -/
theorem SettlementRequest.existing_not_unallocated {request : SettlementRequest}
    (h : request.existing = true) : request.unallocated = false := by
  unfold SettlementRequest.existing at h
  unfold SettlementRequest.unallocated
  cases hop : request.operation with
  | none => simp [hop] at h
  | some operation => cases operation <;> simp_all

/-- The identity and the amounts of the settlement are acceptable exactly when its derivation is
approved, evidenced and dated; the context knows the settlement exactly when it is `allocateExisting`;
a request that recognizes an unallocated settlement has no allocation and any other has some, at
most the limit, with distinct identifiers that the context does not know; its denomination and book
value have a magnitude above zero; and its party is not blank. -/
theorem settlementIdentityInvalid_eq_false_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    settlementIdentityInvalid context request = false ↔
      validAccountingDerivation request.settlement.derivation = true ∧
      (context.settlementIdentity request.settlement.id = .present ↔ request.existing = true) ∧
      (request.unallocated = true → request.allocations = []) ∧
      (request.unallocated = false → request.allocations ≠ []) ∧
      request.allocations.length ≤ accountingLimits.maxSettlementAllocations ∧
      (request.allocations.map (·.id)).Nodup ∧
      (∀ item ∈ request.allocations, context.allocationIdentity item.id = .absent) ∧
      positive request.settlement.denomination.abs = true ∧
      positive request.settlement.bookValue.abs = true ∧
      (jsTrim request.settlement.scope.externalPartyId).length ≠ 0 := by
  unfold settlementIdentityInvalid
  cases hid : context.settlementIdentity request.settlement.id <;>
    cases hex : request.existing <;> cases hun : request.unallocated <;>
    simp [settlementIdentityPresent_eq_false, settlementIdentityPresent_eq_true,
      IdentityObservation.ne_present_iff, List.length_eq_zero_iff, and_assoc]

/-- A sum over two lists that correspond, with the same value, is the same. -/
theorem sum_forall₂_single {α β : Type} {related : α → β → Prop} {f : α → ℚ} {g : β → ℚ}
    (h : ∀ a b, related a b → f a = g b) :
    ∀ {left : List α} {right : List β}, List.Forall₂ related left right →
      (left.map f).sum = (right.map g).sum
  | _, _, .nil => rfl
  | _, _, .cons hab hrest => by
    simp only [List.map_cons, List.sum_cons]
    rw [h _ _ hab, sum_forall₂_single h hrest]

/-- What is allocated from the settlement never exceeds it: what the context says was allocated from
it before, with the allocations an accepted request makes (their quantities, and the settlement's
book value they carry), is within the settlement's denomination and its book value. -/
theorem calculateSettlement_settlement_bound {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    (request.previousTotals context).quantity.toRat +
        ((allocationEffects draft.effects).map (·.allocatedSettlementQuantity.toRat)).sum ≤
        |request.settlement.denomination.toRat| ∧
      (request.previousTotals context).bookValue.toRat +
        ((allocationEffects draft.effects).map
          fun allocation => (allocation.allocatedSettlementBookValue.getD ExactRational.zero).toRat).sum ≤
        |request.settlement.bookValue.toRat| := by
  obtain ⟨pending, built, values, -, hinvalid, hdraft, hprevious, hinvariant, hbuilt, hvalues,
    hbound, -⟩ := calculateSettlement_facts hcontext hrequest h
  rw [hdraft]
  simp only [allocationEffects_settlementEffects]
  constructor
  · by_cases hempty : request.allocations = []
    · have hbuiltEmpty : built = [] := by
        rw [hempty] at hbuilt
        exact List.forall₂_nil_left_iff.mp hbuilt
      have hexisting : request.existing = false := by
        by_contra hex
        have hex' : request.existing = true := by simpa using hex
        have := ((settlementIdentityInvalid_eq_false_iff _ _).mp hinvalid).2.2.2.1
          (SettlementRequest.existing_not_unallocated hex')
        exact this hempty
      have hzero : request.previousTotals context = AllocatedTotal.zero := by
        simp [SettlementRequest.previousTotals, hexisting]
      rw [hbuiltEmpty, hzero]
      simp only [AllocatedTotal.zero, ExactRational.zero_toRat, List.map_nil, List.sum_nil,
        add_zero]
      exact abs_nonneg _
    · have := hinvariant.settlementBound hempty
      rw [sum_forall₂_single (related := BuiltFrom request request.hashedSettlement)
        (g := (·.allocatedSettlementQuantity.toRat))
        (fun item allocation hfrom => by rw [hfrom.fields.2.2.2.2.2.1]) hbuilt] at this
      exact this
  · have hsum := sum_forall₂ (first := fun item value =>
        settledBookValue request.hashedSettlement item = .ok value)
      (second := BuiltFrom request request.hashedSettlement) (f := ExactRational.toRat)
      (g := fun allocation => (allocation.allocatedSettlementBookValue.getD ExactRational.zero).toRat)
      (fun item value allocation hvalue hfrom => by
        obtain ⟨settled, hsettled, hstated⟩ := hfrom.fields.2.2.2.2.2.2.2.2.2.2
        rw [hsettled] at hvalue
        rw [hstated, ← Except.ok.inj hvalue]
        rfl) hvalues hbuilt
    rw [← hsum]
    exact hbound

/-- What a built allocation states of the two quantizations: the expected ones, or its item's own
when none was expected. -/
theorem BuiltFrom.quantized {request : SettlementRequest} {settlement : Settlement}
    {item : SettlementAllocationBody} {built : SettlementAllocation}
    (h : BuiltFrom request settlement item built) :
    ∃ (settled difference : ExactRational) (measurement realized : Option QuantizedValue),
      settledBookValue settlement item = .ok settled ∧
      built.allocatedSettlementBookValue = some settled ∧
      settled.subtract item.openItemBookValue = .ok difference ∧
      expectedSettlementMeasurement request.quantizationPolicy settled = .ok measurement ∧
      expectedRealizedDifference request.quantizationPolicy difference = .ok realized ∧
      built.settlementMeasurement = measurement.orElse (fun _ => item.settlementMeasurement) ∧
      built.realizedExchangeDifference =
        realized.orElse (fun _ => item.realizedExchangeDifference) := by
  obtain ⟨settled, difference, measurement, realized, hsettled, hdifference, hmeasurement,
    hrealized, hbody, -⟩ := h
  have hbody' : built.toSettlementAllocationBody = _ := hbody
  refine ⟨settled, difference, measurement, realized, hsettled, ?_, hdifference, hmeasurement,
    hrealized, ?_, ?_⟩ <;> simp only [hbody', settlementAllocationBody]

/-- Each allocation an accepted request produces is built from an allocation of the request, which
passed the tests of the loop for an open item of the context. -/
theorem calculateSettlement_allocation_facts {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ allocation ∈ allocationEffects draft.effects,
      ∃ (item : SettlementAllocationBody) (openItem : OpenItem) (values : AllocationValues),
        BuiltFrom request request.hashedSettlement item allocation ∧
        AllocationFacts context request request.hashedSettlement item openItem values := by
  obtain ⟨pending, built, values, -, -, hdraft, hprevious, hinvariant, hbuilt, -, -, -⟩ :=
    calculateSettlement_facts hcontext hrequest h
  rw [hdraft]
  simp only [allocationEffects_settlementEffects]
  intro allocation hallocation
  obtain ⟨item, hitem, hfrom⟩ := forall₂_mem_right hbuilt allocation hallocation
  obtain ⟨openItem, values, hfacts⟩ := hinvariant.facts item hitem
  exact ⟨item, openItem, values, hfrom, hfacts⟩

/-- Every allocation an accepted request produces is for this settlement and for an open item the
context holds, of the settlement's book, party and control account; it is approved; its book value
and its quantities are above zero; and its book value is the open item's book value in the
proportion of its quantity to the open item's denomination, exactly. -/
theorem calculateSettlement_allocations {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ allocation ∈ allocationEffects draft.effects,
      ∃ item : OpenItem, context.openItem allocation.openItemId = some item ∧
        allocation.settlementId = request.settlement.id ∧
        item.bookId = request.settlement.bookId ∧ item.scope = request.settlement.scope ∧
        validAccountingDerivation allocation.derivation = true ∧
        0 < allocation.allocatedBookValue.toRat ∧ 0 < allocation.allocatedOpenQuantity.toRat ∧
        0 < allocation.allocatedSettlementQuantity.toRat ∧
        allocation.allocatedOpenItemBookValue = some allocation.allocatedBookValue ∧
        item.denomination.toRat ≠ 0 ∧
        allocation.allocatedBookValue.toRat =
          |item.bookValue.toRat| * allocation.allocatedOpenQuantity.toRat /
            |item.denomination.toRat| := by
  intro allocation hallocation
  obtain ⟨item, openItem, values, hfrom, hfacts⟩ :=
    calculateSettlement_allocation_facts hcontext hrequest h allocation hallocation
  obtain ⟨hid, hopen, hsettlementId, hbook, hquantity, hsettledQuantity, hpath, hkey, hderivation,
    hobv, -⟩ := hfrom.fields
  have hbookEq : allocation.allocatedBookValue.toRat = item.allocatedBookValue.toRat := by
    rw [hbook]; exact hfacts.openItemBookValue
  refine ⟨openItem, by rw [hopen]; exact hfacts.openItem, by rw [hsettlementId]; exact hfacts.settlementId,
    hfacts.bookId, SettlementScope.ext' hfacts.party hfacts.controlAccount,
    by rw [hderivation]; exact hfacts.derivation, by rw [hbookEq]; exact hfacts.bookPositive,
    by rw [hquantity]; exact hfacts.openQuantityPositive,
    by rw [hsettledQuantity]; exact hfacts.settlementQuantityPositive,
    by rw [hobv, hbook], hfacts.denominationNonzero, ?_⟩
  rw [hbookEq, hquantity, hfacts.carrying]

/-- The settlement of an accepted request has a denomination and a book value that are not zero. -/
theorem calculateSettlement_settlement_nonzero {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft}
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    request.settlement.denomination.toRat ≠ 0 ∧ request.settlement.bookValue.toRat ≠ 0 := by
  obtain ⟨_, _, _, -, hinvalid, -⟩ := calculateSettlement_draft h
  obtain ⟨-, -, -, -, -, -, -, hden, hbook, -⟩ :=
    (settlementIdentityInvalid_eq_false_iff _ _).mp hinvalid
  exact ⟨(positive_abs_iff hrequest.settlement.denomination).mp hden,
    (positive_abs_iff hrequest.settlement.bookValue).mp hbook⟩

/-- Every allocation an accepted request produces carries a book value of the settlement that is
above zero and is the settlement's book value in the proportion of the allocation's quantity to the
settlement's denomination, exactly; and the allocation has an effect key for its realized exchange
difference exactly when that book value is not the open item's. -/
theorem calculateSettlement_settlement_share {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ allocation ∈ allocationEffects draft.effects, ∃ settled : ExactRational,
      allocation.allocatedSettlementBookValue = some settled ∧ settled.WF ∧
      0 < settled.toRat ∧
      settled.toRat = |request.settlement.bookValue.toRat| *
        allocation.allocatedSettlementQuantity.toRat / |request.settlement.denomination.toRat| ∧
      (allocation.realizedExchangeEffectKey.isSome = true ↔
        settled.toRat ≠ allocation.allocatedBookValue.toRat) := by
  intro allocation hallocation
  obtain ⟨item, openItem, values, hfrom, hfacts⟩ :=
    calculateSettlement_allocation_facts hcontext hrequest h allocation hallocation
  obtain ⟨-, -, -, hbook, -, hsettledQuantity, -, hkey, -, -, settled, hsettled, hstated⟩ :=
    hfrom.fields
  have hvalues : values.settlementBookValue = settled := by
    have := hfacts.settled
    rw [hsettled] at this
    exact (Except.ok.inj this).symm
  have hbookEq : allocation.allocatedBookValue.toRat = item.allocatedBookValue.toRat := by
    rw [hbook]; exact hfacts.openItemBookValue
  refine ⟨settled, hstated, hvalues ▸ hfacts.settledWF, hvalues ▸ hfacts.settledPositive, ?_, ?_⟩
  · rw [← hvalues, hfacts.settledShare, hsettledQuantity]
    rfl
  · rw [hkey, hbookEq, ← hvalues]; exact hfacts.effectKey

/-- The realized exchange difference of every allocation an accepted request produces is recorded
without loss: with a quantization policy, the settlement's book value it carries is the sum of the
amount recorded in the functional currency (at the scale of the policy) and a residual; and so is a
difference that is not zero (the settlement's book value less the open item's); with none, nothing
is recorded; and a difference of zero records none. -/
theorem calculateSettlement_quantization {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ allocation ∈ allocationEffects draft.effects, ∀ settled : ExactRational,
      allocation.allocatedSettlementBookValue = some settled →
      (request.quantizationPolicy = none → allocation.settlementMeasurement = none ∧
        allocation.realizedExchangeDifference = none) ∧
      (∀ policy, request.quantizationPolicy = some policy →
        (∃ measurement : QuantizedValue, allocation.settlementMeasurement = some measurement ∧
          measurement.amount.scale = policy.targetScale ∧
          measurement.amount.toRat + measurement.residual.toRat = settled.toRat) ∧
        (settled.toRat ≠ allocation.allocatedBookValue.toRat →
          ∃ realized : QuantizedValue, allocation.realizedExchangeDifference = some realized ∧
            realized.amount.scale = policy.targetScale ∧
            realized.amount.toRat + realized.residual.toRat =
              settled.toRat - allocation.allocatedBookValue.toRat) ∧
        (settled.toRat = allocation.allocatedBookValue.toRat →
          allocation.realizedExchangeDifference = none)) := by
  intro allocation hallocation settled hstated
  obtain ⟨item, openItem, values, hfrom, hfacts⟩ :=
    calculateSettlement_allocation_facts hcontext hrequest h allocation hallocation
  obtain ⟨settled', difference, measurement, realized, hsettled, hstated', hdifference,
    hmeasurement, hrealized, hmeasured, hrecorded⟩ := hfrom.quantized
  obtain ⟨-, -, -, hbook, -⟩ := hfrom.fields
  have hsettledEq : settled' = values.settlementBookValue := by
    have := hfacts.settled
    rw [hsettled] at this
    exact Except.ok.inj this
  have hsettledEq' : settled = values.settlementBookValue := by
    rw [hstated] at hstated'
    exact (Option.some.inj hstated').trans hsettledEq
  subst hsettledEq
  subst hsettledEq'
  have hdifferenceEq : difference = values.difference := by
    have := hfacts.differenceOk
    rw [hdifference] at this
    exact Except.ok.inj this
  subst hdifferenceEq
  have hmeasurementEq : measurement = values.expectedMeasurement := by
    have := hfacts.measurementOk
    rw [hmeasurement] at this
    exact Except.ok.inj this
  have hrealizedEq : realized = values.expectedRealized := by
    have := hfacts.realizedOk
    rw [hrealized] at this
    exact Except.ok.inj this
  subst hmeasurementEq
  subst hrealizedEq
  have hbookEq : allocation.allocatedBookValue.toRat = item.allocatedBookValue.toRat := by
    rw [hbook]; exact hfacts.openItemBookValue
  refine ⟨fun hnone => ?_, fun policy hpolicy => ?_⟩
  · obtain ⟨hmeas, hreal, hexpMeas, hexpReal⟩ := hfacts.withoutPolicy hnone
    rw [hmeasured, hexpMeas, hrecorded, hexpReal]
    exact ⟨hmeas, hreal⟩
  · obtain ⟨⟨m, hm, hquantize⟩, hnonzero, hzero⟩ := hfacts.withPolicy policy hpolicy
    obtain ⟨-, hwf, hscale, -, -⟩ := quantize_ok hfacts.settledWF hquantize
    refine ⟨⟨m, by rw [hmeasured, hm]; rfl, hscale, quantize_amount_add_residual hfacts.settledWF hquantize⟩,
      fun hne => ?_, fun heq => ?_⟩
    · rw [hbookEq] at hne
      obtain ⟨r, hr, hqr⟩ := hnonzero hne
      refine ⟨r, by rw [hrecorded, hr]; rfl, ?_, ?_⟩
      · exact (quantize_ok hfacts.difference.1 hqr).2.2.1
      · rw [quantize_amount_add_residual hfacts.difference.1 hqr, hfacts.difference.2, hbookEq]
    · rw [hbookEq] at heq
      obtain ⟨hexp, hnone⟩ := hzero heq
      rw [hrecorded, hexp]
      exact hnone

/-! ### Settled in full -/

/-- A sum of constant multiples is the multiple of the sum. -/
theorem sumOver_const_mul {α κ : Type} [DecidableEq κ] (key : α → κ) (value : α → ℚ) (c : ℚ)
    (id : κ) (items : List α) :
    sumOver key (fun item => c * value item) id items = c * sumOver key value id items := by
  unfold sumOver
  induction items with
  | nil => simp
  | cons item rest ih =>
    simp only [List.map_cons, List.sum_cons]
    rw [ih]
    split_ifs <;> ring

/-- The sum of constant multiples is the multiple of the sum. -/
theorem sum_map_const_mul {α : Type} (c : ℚ) (f : α → ℚ) (items : List α) :
    (items.map fun item => c * f item).sum = c * (items.map f).sum := by
  induction items with
  | nil => simp
  | cons item rest ih => simp [List.sum_cons, ih, mul_add]

/-- Sums of two values that agree on the items of the open item are the same. -/
theorem sumOver_congr {α κ : Type} [DecidableEq κ] {key : α → κ} {value value' : α → ℚ}
    {id : κ} {items : List α} (h : ∀ item ∈ items, key item = id → value item = value' item) :
    sumOver key value id items = sumOver key value' id items := by
  unfold sumOver
  congr 1
  apply List.map_congr_left
  intro item hitem
  split_ifs with hkey
  · exact h item hitem hkey
  · rfl

/-- When an accepted request allocates the settlement in full in quantity, and what was allocated
from it before is in the proportion of its quantity to its denomination, then the settlement's book
value allocated before and now is its book value, exactly: there is no remainder. -/
theorem calculateSettlement_settlement_in_full {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft))
    (hproportional : (request.previousTotals context).bookValue.toRat *
        |request.settlement.denomination.toRat| =
      |request.settlement.bookValue.toRat| * (request.previousTotals context).quantity.toRat)
    (hfull : (request.previousTotals context).quantity.toRat +
        ((allocationEffects draft.effects).map (·.allocatedSettlementQuantity.toRat)).sum =
      |request.settlement.denomination.toRat|) :
    (request.previousTotals context).bookValue.toRat +
        ((allocationEffects draft.effects).map
          fun allocation =>
            (allocation.allocatedSettlementBookValue.getD ExactRational.zero).toRat).sum =
      |request.settlement.bookValue.toRat| := by
  obtain ⟨hden, -⟩ := calculateSettlement_settlement_nonzero hrequest h
  have hden' : |request.settlement.denomination.toRat| ≠ 0 := abs_ne_zero.mpr hden
  have hshare := calculateSettlement_settlement_share hcontext hrequest h
  have hsum : ((allocationEffects draft.effects).map
      fun allocation => (allocation.allocatedSettlementBookValue.getD ExactRational.zero).toRat).sum =
      (|request.settlement.bookValue.toRat| / |request.settlement.denomination.toRat|) *
        ((allocationEffects draft.effects).map (·.allocatedSettlementQuantity.toRat)).sum := by
    rw [← sum_map_const_mul]
    congr 1
    apply List.map_congr_left
    intro allocation hallocation
    obtain ⟨settled, hstated, -, -, hshareRat, -⟩ := hshare allocation hallocation
    simp only [hstated, Option.getD_some, hshareRat]
    field_simp
  rw [hsum]
  have hq : ((allocationEffects draft.effects).map (·.allocatedSettlementQuantity.toRat)).sum =
      |request.settlement.denomination.toRat| -
        (request.previousTotals context).quantity.toRat := by linarith
  rw [hq]
  have hbook : (request.previousTotals context).bookValue.toRat =
      |request.settlement.bookValue.toRat| * (request.previousTotals context).quantity.toRat /
        |request.settlement.denomination.toRat| := by
    field_simp
    exact hproportional
  rw [hbook]
  field_simp
  ring

/-- When an accepted request allocates an open item in full in quantity, and what was allocated to it
before is in the proportion of its quantity to its denomination, then the open item's book value
allocated before and now is its book value, exactly: what remains of it is zero. -/
theorem calculateSettlement_open_item_in_full {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft))
    (id : OpenItemId) (item : OpenItem) (hitem : context.openItem id = some item)
    (hany : ∃ allocation ∈ allocationEffects draft.effects, allocation.openItemId = id)
    (hproportional : (context.allocatedToOpenItem id).bookValue.toRat * |item.denomination.toRat| =
      |item.bookValue.toRat| * (context.allocatedToOpenItem id).quantity.toRat)
    (hfull : (context.allocatedToOpenItem id).quantity.toRat +
        sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id
          (allocationEffects draft.effects) = |item.denomination.toRat|) :
    (context.allocatedToOpenItem id).bookValue.toRat +
        sumOver (·.openItemId) (·.allocatedBookValue.toRat) id (allocationEffects draft.effects) =
      |item.bookValue.toRat| := by
  have hall := calculateSettlement_allocations hcontext hrequest h
  have hshare : ∀ allocation ∈ allocationEffects draft.effects, allocation.openItemId = id →
      item.denomination.toRat ≠ 0 ∧ allocation.allocatedBookValue.toRat =
        |item.bookValue.toRat| * allocation.allocatedOpenQuantity.toRat /
          |item.denomination.toRat| := by
    intro allocation hallocation hid
    obtain ⟨item', hitem', -, -, -, -, -, -, -, -, hden, hcarrying⟩ := hall allocation hallocation
    rw [hid, hitem] at hitem'
    have := Option.some.inj hitem'
    subst this
    exact ⟨hden, hcarrying⟩
  obtain ⟨allocation, hallocation, hid⟩ := hany
  have hden := (hshare allocation hallocation hid).1
  have hden' : |item.denomination.toRat| ≠ 0 := abs_ne_zero.mpr hden
  have hsum : sumOver (·.openItemId) (·.allocatedBookValue.toRat) id
      (allocationEffects draft.effects) =
      (|item.bookValue.toRat| / |item.denomination.toRat|) *
        sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id
          (allocationEffects draft.effects) := by
    rw [← sumOver_const_mul]
    apply sumOver_congr
    intro allocation hallocation hid
    rw [(hshare allocation hallocation hid).2]
    field_simp
  rw [hsum]
  have hq : sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id
      (allocationEffects draft.effects) =
      |item.denomination.toRat| - (context.allocatedToOpenItem id).quantity.toRat := by linarith
  rw [hq]
  have hbook : (context.allocatedToOpenItem id).bookValue.toRat =
      |item.bookValue.toRat| * (context.allocatedToOpenItem id).quantity.toRat /
        |item.denomination.toRat| := by
    field_simp
    exact hproportional
  rw [hbook]
  field_simp
  ring

/-! ## The read context: the laws -/

/-- What an allocation adds to the settlement's paid book value, as a number (line 1183): the
book value it states, or the share its quantity says when the settlement is in the state, or its
book value for the open item when it is not. -/
def paidMeasureRat (settlements : List Settlement) (item : SettlementAllocation) : ℚ :=
  match item.allocatedSettlementBookValue with
  | some value => value.toRat
  | none =>
    match settlementFact settlements item.settlementId with
    | none => item.allocatedBookValue.toRat
    | some settlement =>
      |settlement.bookValue.toRat| * item.allocatedSettlementQuantity.toRat /
        |settlement.denomination.toRat|

/-- The settlement the state holds for an identifier is a settlement of the state. -/
theorem settlementFact_mem {settlements : List Settlement} {id : SettlementId}
    {settlement : Settlement} (h : settlementFact settlements id = some settlement) :
    settlement ∈ settlements ∧ settlement.id = id := by
  unfold settlementFact at h
  have hmem := List.mem_of_getLast? h
  rw [List.mem_filter] at hmem
  exact ⟨hmem.1, by simpa using hmem.2⟩

/-- When the measure an allocation adds to the paid totals is computed, it is constructible and it
is the number `paidMeasureRat`. -/
theorem paidMeasure_ok {settlements : List Settlement} {item : SettlementAllocation}
    {measured : ExactRational} (hsettlements : ∀ settlement ∈ settlements, settlement.WF)
    (hitem : item.WF) (h : paidMeasure settlements item = .ok measured) :
    measured.WF ∧ measured.toRat = paidMeasureRat settlements item := by
  unfold paidMeasure at h
  split at h
  · rename_i stated hstated
    simp only [Except.ok.injEq] at h
    subst h
    exact ⟨hitem.allocatedSettlementBookValue stated hstated, by simp [paidMeasureRat, hstated]⟩
  · rename_i hnone
    split at h
    · rename_i hfact
      simp only [Except.ok.injEq] at h
      subst h
      exact ⟨hitem.allocatedBookValue, by simp [paidMeasureRat, hnone, hfact]⟩
    · rename_i settlement hfact
      obtain ⟨hmem, -⟩ := settlementFact_mem hfact
      obtain ⟨hwf, -, hrat⟩ := proportionalShare_ok (hsettlements settlement hmem).bookValue
        (hsettlements settlement hmem).denomination hitem.allocatedSettlementQuantity h
      exact ⟨hwf, by simp [paidMeasureRat, hnone, hfact, hrat]⟩

/-- What the totals of the context hold after the allocations `done`: for every open item, what the
allocations of `done` for it add to its allocated book value and quantity; for every settlement,
what they add to its paid book value (`paidMeasureRat`) and quantity; all constructible. -/
structure TotalsSpec (settlements : List Settlement) (totals : SettlementContextTotals)
    (done : List SettlementAllocation) : Prop where
  allocated : ∀ id, ((settlementMapGet totals.allocated id).getD AllocatedTotal.zero).WF ∧
    ((settlementMapGet totals.allocated id).getD AllocatedTotal.zero).bookValue.toRat =
      sumOver (·.openItemId) (·.toSettlementAllocationBody.openItemBookValue.toRat) id done ∧
    ((settlementMapGet totals.allocated id).getD AllocatedTotal.zero).quantity.toRat =
      sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id done
  paid : ∀ id, ((settlementMapGet totals.paid id).getD AllocatedTotal.zero).WF ∧
    ((settlementMapGet totals.paid id).getD AllocatedTotal.zero).bookValue.toRat =
      sumOver (·.settlementId) (paidMeasureRat settlements) id done ∧
    ((settlementMapGet totals.paid id).getD AllocatedTotal.zero).quantity.toRat =
      sumOver (·.settlementId) (·.allocatedSettlementQuantity.toRat) id done

/-- Before any allocation the totals are empty. -/
theorem totalsSpec_initial (settlements : List Settlement) :
    TotalsSpec settlements ⟨[], []⟩ [] := by
  refine ⟨fun id => ⟨AllocatedTotal.zero_wf, ?_⟩, fun id => ⟨AllocatedTotal.zero_wf, ?_⟩⟩ <;>
    simp [settlementMapGet, sumOver, ExactRational.zero_toRat, AllocatedTotal.zero]

/-- One allocation of the loop that builds the context adds its amounts to the totals of its open
item and of its settlement. -/
theorem contextStep_spec {settlements : List Settlement} {totals totals' : SettlementContextTotals}
    {item : SettlementAllocation} {done : List SettlementAllocation}
    (hsettlements : ∀ settlement ∈ settlements, settlement.WF) (hitem : item.WF)
    (hspec : TotalsSpec settlements totals done)
    (h : contextStep settlements totals item = .ok totals') :
    TotalsSpec settlements totals' (done ++ [item]) := by
  unfold contextStep at h
  dsimp only at h
  split at h
  · cases h
  rename_i bookValue hbook
  split at h
  · cases h
  rename_i quantity hquantity
  split at h
  · cases h
  rename_i measured hmeasured
  split at h
  · cases h
  rename_i sourceBookValue hsourceBook
  split at h
  · cases h
  rename_i sourceQuantity hsourceQuantity
  injection h with h
  subst h
  have hobv : (item.toSettlementAllocationBody.openItemBookValue).WF := openItemBookValue_wf hitem
  obtain ⟨hbookWF, hbookRat⟩ := ExactRational.add_ok (hspec.allocated item.openItemId).1.bookValue
    hobv hbook
  obtain ⟨hquantityWF, hquantityRat⟩ := ExactRational.add_ok
    (hspec.allocated item.openItemId).1.quantity hitem.allocatedOpenQuantity hquantity
  obtain ⟨hmeasuredWF, hmeasuredRat⟩ := paidMeasure_ok hsettlements hitem hmeasured
  obtain ⟨hsourceBookWF, hsourceBookRat⟩ := ExactRational.add_ok
    (hspec.paid item.settlementId).1.bookValue hmeasuredWF hsourceBook
  obtain ⟨hsourceQuantityWF, hsourceQuantityRat⟩ := ExactRational.add_ok
    (hspec.paid item.settlementId).1.quantity hitem.allocatedSettlementQuantity hsourceQuantity
  refine ⟨fun id => ?_, fun id => ?_⟩
  · simp only [settlementMapGet_settlementMapSet, sumOver_append_singleton]
    by_cases hid : item.openItemId = id
    · subst hid
      simp only [beq_self_eq_true, ↓reduceIte, Option.getD_some]
      refine ⟨⟨hbookWF, hquantityWF⟩, ?_, ?_⟩
      · show bookValue.toRat = _
        rw [hbookRat, (hspec.allocated item.openItemId).2.1]
      · show quantity.toRat = _
        rw [hquantityRat, (hspec.allocated item.openItemId).2.2]
    · have hid' : (item.openItemId == id) = false := by simpa using hid
      simp only [hid', Bool.false_eq_true, ↓reduceIte, hid, add_zero]
      exact hspec.allocated id
  · simp only [settlementMapGet_settlementMapSet, sumOver_append_singleton]
    by_cases hid : item.settlementId = id
    · subst hid
      simp only [beq_self_eq_true, ↓reduceIte, Option.getD_some]
      refine ⟨⟨hsourceBookWF, hsourceQuantityWF⟩, ?_, ?_⟩
      · show sourceBookValue.toRat = _
        rw [hsourceBookRat, hmeasuredRat, (hspec.paid item.settlementId).2.1]
      · show sourceQuantity.toRat = _
        rw [hsourceQuantityRat, (hspec.paid item.settlementId).2.2]
    · have hid' : (item.settlementId == id) = false := by simpa using hid
      simp only [hid', Bool.false_eq_true, ↓reduceIte, hid, add_zero]
      exact hspec.paid id

/-- The loop that builds the context, when it returns, leaves the totals of all the allocations. -/
theorem contextTotals_spec {settlements : List Settlement}
    (hsettlements : ∀ settlement ∈ settlements, settlement.WF) :
    ∀ {items : List SettlementAllocation} {done : List SettlementAllocation}
      {totals totals' : SettlementContextTotals},
      (∀ item ∈ items, item.WF) → TotalsSpec settlements totals done →
      contextTotals settlements totals items = .ok totals' →
      TotalsSpec settlements totals' (done ++ items)
  | [], done, totals, totals', _, hspec, h => by
    simp only [contextTotals, Except.ok.injEq] at h
    subst h
    simpa using hspec
  | item :: rest, done, totals, totals', hwf, hspec, h => by
    unfold contextTotals at h
    split at h
    · cases h
    · rename_i next hstep
      have hspec' := contextStep_spec hsettlements (hwf item (by simp)) hspec hstep
      have := contextTotals_spec hsettlements (done := done ++ [item])
        (fun a ha => hwf a (List.mem_cons_of_mem _ ha)) hspec' h
      simpa [List.append_assoc] using this

/-- What `settlementReadContext` builds, when it returns: the totals of the loop, and the six
answers read from the state's lists and those totals. -/
theorem settlementReadContext_eq {state : AccountingCanonicalState} {context : SettlementReadContext}
    (h : settlementReadContext state = .ok context) :
    ∃ totals : SettlementContextTotals,
      contextTotals state.settlements ⟨[], []⟩ state.settlementAllocations = .ok totals ∧
      (∀ id, context.openItem id = state.openItems.find? (·.id == id)) ∧
      (∀ id, context.settlementIdentity id =
        if state.settlements.any (·.id == id) then .present else .absent) ∧
      (∀ id, context.allocationIdentity id =
        if state.settlementAllocations.any (·.id == id) then .present else .absent) ∧
      (∀ id, context.existingSettlement id = settlementFact state.settlements id) ∧
      (∀ id, context.allocatedFromSettlement id = (settlementMapGet totals.paid id).getD AllocatedTotal.zero) ∧
      (∀ id, context.allocatedToOpenItem id =
        (settlementMapGet totals.allocated id).getD AllocatedTotal.zero) := by
  unfold settlementReadContext at h
  split at h
  · cases h
  · rename_i totals htotals
    injection h with h
    subst h
    exact ⟨totals, htotals, fun _ => rfl, fun _ => rfl, fun _ => rfl, fun _ => rfl, fun _ => rfl,
      fun _ => rfl⟩

/-- The context holds an open item for an identifier exactly when the state's open items do, and the
item it holds is the first of the state's with that identifier. -/
theorem settlementReadContext_openItem {state : AccountingCanonicalState}
    {context : SettlementReadContext} (h : settlementReadContext state = .ok context)
    (id : OpenItemId) :
    (∀ item, context.openItem id = some item →
      ∃ before after, state.openItems = before ++ item :: after ∧ item.id = id ∧
        ∀ earlier ∈ before, earlier.id ≠ id) ∧
    ((∃ item ∈ state.openItems, item.id = id) → ∃ item, context.openItem id = some item) := by
  obtain ⟨-, -, hopen, -⟩ := settlementReadContext_eq h
  refine ⟨fun item hitem => ?_, fun ⟨item, hmem, hid⟩ => ?_⟩
  · rw [hopen id] at hitem
    obtain ⟨hid, before, after, hsplit, hbefore⟩ := List.find?_eq_some_iff_append.mp hitem
    exact ⟨before, after, hsplit, by simpa using hid, fun earlier hearlier => by
      simpa using hbefore earlier hearlier⟩
  · rw [hopen id]
    have : (state.openItems.find? (·.id == id)).isSome = true := by
      rw [List.find?_isSome]
      exact ⟨item, hmem, by simpa using hid⟩
    exact Option.isSome_iff_exists.mp this

/-- The context knows a settlement identity exactly when the state's settlements hold it. -/
theorem settlementReadContext_settlementIdentity {state : AccountingCanonicalState}
    {context : SettlementReadContext} (h : settlementReadContext state = .ok context)
    (id : SettlementId) :
    context.settlementIdentity id = .present ↔ ∃ settlement ∈ state.settlements, settlement.id = id := by
  obtain ⟨-, -, -, hidentity, -⟩ := settlementReadContext_eq h
  rw [hidentity id]
  by_cases hany : state.settlements.any (·.id == id) = true
  · simp only [hany, ↓reduceIte, true_iff]
    obtain ⟨settlement, hmem, hid⟩ := List.any_eq_true.mp hany
    exact ⟨settlement, hmem, by simpa using hid⟩
  · simp only [hany, Bool.false_eq_true, ↓reduceIte]
    constructor
    · intro h'; cases h'
    · rintro ⟨settlement, hmem, hid⟩
      exact absurd (List.any_eq_true.mpr ⟨settlement, hmem, by simp [hid]⟩) hany

/-- The context knows an allocation identity exactly when the state's allocations hold it. -/
theorem settlementReadContext_allocationIdentity {state : AccountingCanonicalState}
    {context : SettlementReadContext} (h : settlementReadContext state = .ok context)
    (id : SettlementAllocationId) :
    context.allocationIdentity id = .present ↔
      ∃ allocation ∈ state.settlementAllocations, allocation.id = id := by
  obtain ⟨-, -, -, -, hidentity, -⟩ := settlementReadContext_eq h
  rw [hidentity id]
  by_cases hany : state.settlementAllocations.any (·.id == id) = true
  · simp only [hany, ↓reduceIte, true_iff]
    obtain ⟨allocation, hmem, hid⟩ := List.any_eq_true.mp hany
    exact ⟨allocation, hmem, by simpa using hid⟩
  · simp only [hany, Bool.false_eq_true, ↓reduceIte]
    constructor
    · intro h'; cases h'
    · rintro ⟨allocation, hmem, hid⟩
      exact absurd (List.any_eq_true.mpr ⟨allocation, hmem, by simp [hid]⟩) hany

/-- The last item of a filtered list is the last item of the list that passes the filter. -/
theorem getLast?_filter_split {α : Type} {p : α → Bool} :
    ∀ {items : List α} {item : α}, (items.filter p).getLast? = some item →
      ∃ before after, items = before ++ item :: after ∧ p item = true ∧ ∀ later ∈ after, p later = false
  | [], item, h => by simp at h
  | head :: rest, item, h => by
    by_cases hp : p head = true
    · simp only [List.filter_cons, hp, ↓reduceIte] at h
      by_cases hrest : rest.filter p = []
      · rw [hrest] at h
        simp only [List.getLast?_singleton, Option.some.injEq] at h
        subst h
        refine ⟨[], rest, by simp, hp, fun later hlater => ?_⟩
        have := List.filter_eq_nil_iff.mp hrest later hlater
        simpa using this
      · have hne : (head :: rest.filter p).getLast? = (rest.filter p).getLast? := by
          cases hfilter : rest.filter p with
          | nil => exact absurd hfilter hrest
          | cons x xs => simp [List.getLast?_cons_cons]
        rw [hne] at h
        obtain ⟨before, after, hsplit, hitem, hafter⟩ := getLast?_filter_split h
        exact ⟨head :: before, after, by simp [hsplit], hitem, hafter⟩
    · have hp' : p head = false := by simpa using hp
      simp only [List.filter_cons, hp', Bool.false_eq_true, ↓reduceIte] at h
      obtain ⟨before, after, hsplit, hitem, hafter⟩ := getLast?_filter_split h
      exact ⟨head :: before, after, by simp [hsplit], hitem, hafter⟩

/-- The context holds a settlement for an identifier exactly when the state's settlements hold one,
and it holds the last of the state's with that identifier. -/
theorem settlementReadContext_existingSettlement {state : AccountingCanonicalState}
    {context : SettlementReadContext} (h : settlementReadContext state = .ok context)
    (id : SettlementId) :
    (∀ settlement, context.existingSettlement id = some settlement →
      ∃ before after, state.settlements = before ++ settlement :: after ∧ settlement.id = id ∧
        ∀ later ∈ after, later.id ≠ id) ∧
    ((∃ settlement ∈ state.settlements, settlement.id = id) →
      ∃ settlement, context.existingSettlement id = some settlement) := by
  obtain ⟨-, -, -, -, -, hexisting, -⟩ := settlementReadContext_eq h
  refine ⟨fun settlement hsettlement => ?_, fun ⟨settlement, hmem, hid⟩ => ?_⟩
  · rw [hexisting id] at hsettlement
    obtain ⟨before, after, hsplit, hid, hafter⟩ := getLast?_filter_split hsettlement
    exact ⟨before, after, hsplit, by simpa using hid, fun later hlater => by
      simpa using hafter later hlater⟩
  · rw [hexisting id]
    have : (settlementFact state.settlements id).isSome = true := by
      unfold settlementFact
      rw [List.getLast?_isSome]
      intro hnil
      have := List.filter_eq_nil_iff.mp hnil settlement hmem
      simp [hid] at this
    exact Option.isSome_iff_exists.mp this

/-- The totals the context gives for an open item are those of the state's allocations: the sum of
what each adds to the open item's allocated book value and quantity, and constructible. -/
theorem settlementReadContext_allocatedToOpenItem {state : AccountingCanonicalState}
    {context : SettlementReadContext} (hstate : state.WF)
    (h : settlementReadContext state = .ok context) (id : OpenItemId) :
    (context.allocatedToOpenItem id).WF ∧
      (context.allocatedToOpenItem id).bookValue.toRat =
        sumOver (·.openItemId) (·.toSettlementAllocationBody.openItemBookValue.toRat) id
          state.settlementAllocations ∧
      (context.allocatedToOpenItem id).quantity.toRat =
        sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id state.settlementAllocations := by
  obtain ⟨totals, htotals, -, -, -, -, -, hallocated⟩ := settlementReadContext_eq h
  have hspec := contextTotals_spec hstate.settlements hstate.settlementAllocations
    (totalsSpec_initial state.settlements) htotals
  rw [List.nil_append] at hspec
  rw [hallocated id]
  exact hspec.allocated id

/-- The totals the context gives for a settlement are those of the state's allocations: the sum of
what each adds to the settlement's paid book value and quantity, and constructible. -/
theorem settlementReadContext_allocatedFromSettlement {state : AccountingCanonicalState}
    {context : SettlementReadContext} (hstate : state.WF)
    (h : settlementReadContext state = .ok context) (id : SettlementId) :
    (context.allocatedFromSettlement id).WF ∧
      (context.allocatedFromSettlement id).bookValue.toRat =
        sumOver (·.settlementId) (paidMeasureRat state.settlements) id
          state.settlementAllocations ∧
      (context.allocatedFromSettlement id).quantity.toRat =
        sumOver (·.settlementId) (·.allocatedSettlementQuantity.toRat) id
          state.settlementAllocations := by
  obtain ⟨totals, htotals, -, -, -, -, hpaid, -⟩ := settlementReadContext_eq h
  have hspec := contextTotals_spec hstate.settlements hstate.settlementAllocations
    (totalsSpec_initial state.settlements) htotals
  rw [List.nil_append] at hspec
  rw [hpaid id]
  exact hspec.paid id

/-- A context built from a constructible state answers constructible values. -/
theorem settlementReadContext_wf {state : AccountingCanonicalState}
    {context : SettlementReadContext} (hstate : state.WF)
    (h : settlementReadContext state = .ok context) : context.WF := by
  obtain ⟨totals, htotals, hopen, -, -, hexisting, -, -⟩ := settlementReadContext_eq h
  refine ⟨fun id item hitem => ?_, fun id settlement hsettlement => ?_,
    fun id => (settlementReadContext_allocatedFromSettlement hstate h id).1,
    fun id => (settlementReadContext_allocatedToOpenItem hstate h id).1⟩
  · rw [hopen id] at hitem
    exact hstate.openItems item (List.mem_of_find?_eq_some hitem)
  · rw [hexisting id] at hsettlement
    exact hstate.settlements settlement (settlementFact_mem hsettlement).1

/-- Two read contexts that give the same six answers are the same. -/
theorem SettlementReadContext.ext' {first second : SettlementReadContext}
    (hopen : ∀ id, first.openItem id = second.openItem id)
    (hsettlement : ∀ id, first.settlementIdentity id = second.settlementIdentity id)
    (hallocation : ∀ id, first.allocationIdentity id = second.allocationIdentity id)
    (hexisting : ∀ id, first.existingSettlement id = second.existingSettlement id)
    (hfrom : ∀ id, first.allocatedFromSettlement id = second.allocatedFromSettlement id)
    (hto : ∀ id, first.allocatedToOpenItem id = second.allocatedToOpenItem id) :
    first = second := by
  cases first
  cases second
  simp only [SettlementReadContext.mk.injEq]
  exact ⟨funext hopen, funext hsettlement, funext hallocation, funext hexisting, funext hfrom,
    funext hto⟩

/-- `calculateSettlement` reads its context only through its six answers: two contexts that answer
the same give the same result for every request. -/
theorem calculateSettlement_congr {first second : SettlementReadContext}
    (hopen : ∀ id, first.openItem id = second.openItem id)
    (hsettlement : ∀ id, first.settlementIdentity id = second.settlementIdentity id)
    (hallocation : ∀ id, first.allocationIdentity id = second.allocationIdentity id)
    (hexisting : ∀ id, first.existingSettlement id = second.existingSettlement id)
    (hfrom : ∀ id, first.allocatedFromSettlement id = second.allocatedFromSettlement id)
    (hto : ∀ id, first.allocatedToOpenItem id = second.allocatedToOpenItem id)
    (request : SettlementRequest) :
    calculateSettlement first request = calculateSettlement second request := by
  rw [SettlementReadContext.ext' hopen hsettlement hallocation hexisting hfrom hto]

/-- A context that answers what the state's context answers gives, for every request, the result
`applySettlement` gives. -/
theorem applySettlement_congr {state : AccountingCanonicalState}
    {built other : SettlementReadContext} (h : settlementReadContext state = .ok built)
    (hopen : ∀ id, other.openItem id = built.openItem id)
    (hsettlement : ∀ id, other.settlementIdentity id = built.settlementIdentity id)
    (hallocation : ∀ id, other.allocationIdentity id = built.allocationIdentity id)
    (hexisting : ∀ id, other.existingSettlement id = built.existingSettlement id)
    (hfrom : ∀ id, other.allocatedFromSettlement id = built.allocatedFromSettlement id)
    (hto : ∀ id, other.allocatedToOpenItem id = built.allocatedToOpenItem id)
    (request : SettlementRequest) :
    calculateSettlement other request = applySettlement state request := by
  unfold applySettlement
  rw [h]
  exact calculateSettlement_congr hopen hsettlement hallocation hexisting hfrom hto request

/-- `applySettlement` returns what `calculateSettlement` returns over the state's context, and fails
when the context cannot be built. -/
theorem applySettlement_eq_ok {state : AccountingCanonicalState} {request : SettlementRequest}
    {result : AccountingCalculation} (h : applySettlement state request = .ok result) :
    ∃ context, settlementReadContext state = .ok context ∧
      calculateSettlement context request = .ok result := by
  unfold applySettlement at h
  split at h
  · cases h
  · rename_i context hcontext
    exact ⟨context, hcontext, h⟩

/-! ### The laws over the state -/

/-- The sum over two lists put together is the two sums added. -/
theorem sumOver_append {α κ : Type} [DecidableEq κ] (key : α → κ) (value : α → ℚ) (id : κ)
    (first second : List α) :
    sumOver key value id (first ++ second) = sumOver key value id first + sumOver key value id second := by
  simp [sumOver, List.map_append, List.sum_append]

/-- What an accepted request allocates, put with what the state holds, never exceeds what is open:
for every open item the request allocates to, the state holds it, and the book value and the
quantity that the state's allocations and the request's allocations add to it, together, are within
its book value and its denomination. -/
theorem applySettlement_open_bound {state : AccountingCanonicalState} {request : SettlementRequest}
    {draft : AccountingDraft} (hstate : state.WF) (hrequest : request.WF)
    (h : applySettlement state request = .ok (.draft draft)) :
    ∀ id, (∃ allocation ∈ allocationEffects draft.effects, allocation.openItemId = id) →
      ∃ item : OpenItem, state.openItems.find? (·.id == id) = some item ∧
        sumOver (·.openItemId) (·.toSettlementAllocationBody.openItemBookValue.toRat) id
            (state.settlementAllocations ++ allocationEffects draft.effects) ≤
          |item.bookValue.toRat| ∧
        sumOver (·.openItemId) (·.allocatedOpenQuantity.toRat) id
            (state.settlementAllocations ++ allocationEffects draft.effects) ≤
          |item.denomination.toRat| := by
  obtain ⟨context, hcontext, hcalculate⟩ := applySettlement_eq_ok h
  obtain ⟨-, -, hopen, -⟩ := settlementReadContext_eq hcontext
  have hwf := settlementReadContext_wf hstate hcontext
  intro id hid
  obtain ⟨item, hitem, hbook, hquantity⟩ :=
    calculateSettlement_open_bound hwf hrequest hcalculate id hid
  obtain ⟨-, hbookTotal, hquantityTotal⟩ :=
    settlementReadContext_allocatedToOpenItem hstate hcontext id
  have hproduced : sumOver (·.openItemId) (·.allocatedBookValue.toRat) id
      (allocationEffects draft.effects) =
      sumOver (·.openItemId) (·.toSettlementAllocationBody.openItemBookValue.toRat) id
        (allocationEffects draft.effects) := by
    apply sumOver_congr
    intro allocation hallocation _
    obtain ⟨_, _, _, _, _, _, _, _, _, hobv, _⟩ :=
      calculateSettlement_allocations hwf hrequest hcalculate allocation hallocation
    simp [SettlementAllocationBody.openItemBookValue, hobv]
  refine ⟨item, by rw [← hopen id]; exact hitem, ?_, ?_⟩
  · rw [sumOver_append, ← hproduced, ← hbookTotal]
    exact hbook
  · rw [sumOver_append, ← hquantityTotal]
    exact hquantity

/-- What an accepted request allocates from the settlement, put with what the state's allocations
took from it before (for `allocateExisting`; a settlement that is being created has had nothing),
never exceeds the settlement: the quantities are within its denomination, and the book value of the
settlement that the allocations carry is within its book value. -/
theorem applySettlement_settlement_bound {state : AccountingCanonicalState}
    {request : SettlementRequest} {draft : AccountingDraft} (hstate : state.WF)
    (hrequest : request.WF) (h : applySettlement state request = .ok (.draft draft)) :
    (if request.existing then
        sumOver (·.settlementId) (·.allocatedSettlementQuantity.toRat) request.settlement.id
          state.settlementAllocations
      else 0) +
        ((allocationEffects draft.effects).map (·.allocatedSettlementQuantity.toRat)).sum ≤
        |request.settlement.denomination.toRat| ∧
      (if request.existing then
        sumOver (·.settlementId) (paidMeasureRat state.settlements) request.settlement.id
          state.settlementAllocations
      else 0) +
        ((allocationEffects draft.effects).map
          fun allocation => (allocation.allocatedSettlementBookValue.getD ExactRational.zero).toRat).sum ≤
        |request.settlement.bookValue.toRat| := by
  obtain ⟨context, hcontext, hcalculate⟩ := applySettlement_eq_ok h
  have hwf := settlementReadContext_wf hstate hcontext
  have hbound := calculateSettlement_settlement_bound hwf hrequest hcalculate
  obtain ⟨-, hbook, hquantity⟩ :=
    settlementReadContext_allocatedFromSettlement hstate hcontext request.settlement.id
  by_cases hexisting : request.existing = true
  · simp only [hexisting, ↓reduceIte]
    simp only [SettlementRequest.previousTotals, hexisting, ↓reduceIte] at hbound
    rw [← hbook, ← hquantity]
    exact hbound
  · have hfalse : request.existing = false := by simpa using hexisting
    simp only [hfalse, Bool.false_eq_true, ↓reduceIte]
    simp only [SettlementRequest.previousTotals, hfalse, Bool.false_eq_true, ↓reduceIte,
      AllocatedTotal.zero, ExactRational.zero_toRat] at hbound
    simpa using hbound

/-! ## Rejections -/

set_option maxRecDepth 100000 in
/-- The seven rejections of `calculateSettlement` are different from one another. -/
theorem settlementRejections_pairwise_ne :
    [settlementApplicationRejection, settlementIdentityRejection, retainedSettlementRejection,
      allocationBeforeRecognitionRejection, allocationScopeRejection, allocationValueRejection,
      overAllocationRejection].Pairwise (· ≠ ·) := by
  unfold settlementApplicationRejection settlementIdentityRejection retainedSettlementRejection
    allocationBeforeRecognitionRejection allocationScopeRejection allocationValueRejection
    overAllocationRejection reject diagnostic
  decide

/-- The seven rejections of `calculateSettlement`, pair by pair. -/
theorem settlementRejections_ne :
    (settlementApplicationRejection ≠ settlementIdentityRejection ∧
        settlementApplicationRejection ≠ retainedSettlementRejection ∧
        settlementApplicationRejection ≠ allocationBeforeRecognitionRejection ∧
        settlementApplicationRejection ≠ allocationScopeRejection ∧
        settlementApplicationRejection ≠ allocationValueRejection ∧
        settlementApplicationRejection ≠ overAllocationRejection) ∧
      (settlementIdentityRejection ≠ retainedSettlementRejection ∧
        settlementIdentityRejection ≠ allocationBeforeRecognitionRejection ∧
        settlementIdentityRejection ≠ allocationScopeRejection ∧
        settlementIdentityRejection ≠ allocationValueRejection ∧
        settlementIdentityRejection ≠ overAllocationRejection) ∧
      (retainedSettlementRejection ≠ allocationBeforeRecognitionRejection ∧
        retainedSettlementRejection ≠ allocationScopeRejection ∧
        retainedSettlementRejection ≠ allocationValueRejection ∧
        retainedSettlementRejection ≠ overAllocationRejection) ∧
      (allocationBeforeRecognitionRejection ≠ allocationScopeRejection ∧
        allocationBeforeRecognitionRejection ≠ allocationValueRejection ∧
        allocationBeforeRecognitionRejection ≠ overAllocationRejection) ∧
      (allocationScopeRejection ≠ allocationValueRejection ∧
        allocationScopeRejection ≠ overAllocationRejection) ∧
      allocationValueRejection ≠ overAllocationRejection := by
  have h := settlementRejections_pairwise_ne
  simpa only [List.pairwise_cons, List.mem_cons, List.mem_singleton, forall_eq_or_imp, forall_eq,
    List.not_mem_nil, false_imp_iff, implies_true, and_true, List.Pairwise.nil] using h

/-- The rejection of the operation and the application time is returned when its test holds. -/
theorem calculateSettlement_incoherent {context : SettlementReadContext}
    {request : SettlementRequest} (h : settlementApplicationIncoherent request = true) :
    calculateSettlement context request = .ok settlementApplicationRejection := by
  unfold calculateSettlement
  simp [h]

/-- The rejection of the identity and the amounts is returned when its test holds, the one before
having passed. -/
theorem calculateSettlement_invalid {context : SettlementReadContext}
    {request : SettlementRequest} (h1 : settlementApplicationIncoherent request = false)
    (h2 : settlementIdentityInvalid context request = true) :
    calculateSettlement context request = .ok settlementIdentityRejection := by
  unfold calculateSettlement
  simp [h1, h2]

/-- The rejection of an allocation that does not retain the settlement is returned when the
settlement that was recorded does not match, the tests before having passed. -/
theorem calculateSettlement_mismatch {context : SettlementReadContext}
    {request : SettlementRequest} (h1 : settlementApplicationIncoherent request = false)
    (h2 : settlementIdentityInvalid context request = false)
    (h3 : previousSettlementTotals context request.hashedSettlement request.existing =
      .ok .mismatch) :
    calculateSettlement context request = .ok retainedSettlementRejection := by
  unfold calculateSettlement
  simp [h1, h2, h3]

/-- The rejection of the loop is returned when the loop rejects, the tests before having passed. -/
theorem calculateSettlement_loop_rejected {context : SettlementReadContext}
    {request : SettlementRequest} (h1 : settlementApplicationIncoherent request = false)
    (h2 : settlementIdentityInvalid context request = false) {previous : AllocatedTotal}
    (h3 : previousSettlementTotals context request.hashedSettlement request.existing =
      .ok (.totals previous))
    {rejection : AccountingCalculation}
    (h4 : settlementAllocationLoop context request request.hashedSettlement
      ⟨[], [], previous.quantity⟩ request.allocations = .ok (.rejected rejection)) :
    calculateSettlement context request = .ok rejection := by
  unfold calculateSettlement
  simp [h1, h2, h3, h4]

/-- The over-allocation is returned when the loop goes on to its end and the test of line 1259
holds, the tests before having passed. -/
theorem calculateSettlement_overAllocated {context : SettlementReadContext}
    {request : SettlementRequest} (h1 : settlementApplicationIncoherent request = false)
    (h2 : settlementIdentityInvalid context request = false) {previous : AllocatedTotal}
    (h3 : previousSettlementTotals context request.hashedSettlement request.existing =
      .ok (.totals previous))
    {pending : SettlementPending}
    (h4 : settlementAllocationLoop context request request.hashedSettlement
      ⟨[], [], previous.quantity⟩ request.allocations = .ok (.next pending))
    (h5 : settlementOverAllocated request.hashedSettlement previous request.allocations =
      .ok true) :
    calculateSettlement context request = .ok overAllocationRejection := by
  unfold calculateSettlement
  simp [h1, h2, h3, h4, h5, liftNum]

/-- Whatever `calculateSettlement` returns without throwing is a draft or one of the seven rejections,
and the test that gives it holds, with the tests before it passed. -/
theorem calculateSettlement_ok_cases {context : SettlementReadContext}
    {request : SettlementRequest} {result : AccountingCalculation}
    (h : calculateSettlement context request = .ok result) :
    (∃ draft, result = .draft draft) ∨
    (settlementApplicationIncoherent request = true ∧ result = settlementApplicationRejection) ∨
    (settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = true ∧ result = settlementIdentityRejection) ∨
    (settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = false ∧
      previousSettlementTotals context request.hashedSettlement request.existing =
        .ok .mismatch ∧ result = retainedSettlementRejection) ∨
    (settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = false ∧
      ∃ previous : AllocatedTotal,
        previousSettlementTotals context request.hashedSettlement request.existing =
          .ok (.totals previous) ∧
        settlementAllocationLoop context request request.hashedSettlement
          ⟨[], [], previous.quantity⟩ request.allocations = .ok (.rejected result)) ∨
    (settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = false ∧
      ∃ (previous : AllocatedTotal) (pending : SettlementPending),
        previousSettlementTotals context request.hashedSettlement request.existing =
          .ok (.totals previous) ∧
        settlementAllocationLoop context request request.hashedSettlement
          ⟨[], [], previous.quantity⟩ request.allocations = .ok (.next pending) ∧
        settlementOverAllocated request.hashedSettlement previous request.allocations = .ok true ∧
        result = overAllocationRejection) := by
  unfold calculateSettlement at h
  split at h
  · rename_i hincoherent
    injection h with h
    exact Or.inr (Or.inl ⟨by simpa using hincoherent, h.symm⟩)
  rename_i hincoherent
  split at h
  · rename_i hinvalid
    injection h with h
    exact Or.inr (Or.inr (Or.inl ⟨by simpa using hincoherent, by simpa using hinvalid, h.symm⟩))
  rename_i hinvalid
  have hincoherent' : settlementApplicationIncoherent request = false := by simpa using hincoherent
  have hinvalid' : settlementIdentityInvalid context request = false := by simpa using hinvalid
  dsimp only at h
  split at h
  · cases h
  · injection h with h
    rename_i hprevious
    exact Or.inr (Or.inr (Or.inr (Or.inl ⟨hincoherent', hinvalid', hprevious, h.symm⟩)))
  · rename_i previous hprevious
    split at h
    · cases h
    · rename_i rejection hloop
      injection h with h
      subst h
      exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl ⟨hincoherent', hinvalid', previous, hprevious,
        hloop⟩))))
    · rename_i pending hloop
      split at h
      · cases h
      · rename_i hover
        injection h with h
        exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr ⟨hincoherent', hinvalid', previous, pending,
          hprevious, hloop, liftNum_eq_ok.mp hover, h.symm⟩))))
      · rename_i hover
        split at h
        · cases h
        · rename_i built hbuild
          injection h with h
          exact Or.inl ⟨_, h.symm⟩

/-- A rejection is not a draft. -/
theorem rejection_ne_draft {rejection : AccountingCalculation} {draft : AccountingDraft}
    (h : rejection = settlementApplicationRejection ∨ rejection = settlementIdentityRejection ∨
      rejection = retainedSettlementRejection ∨ rejection = allocationBeforeRecognitionRejection ∨
      rejection = allocationScopeRejection ∨ rejection = allocationValueRejection ∨
      rejection = overAllocationRejection) : rejection ≠ .draft draft := by
  rcases h with rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
    simp [settlementApplicationRejection, settlementIdentityRejection, retainedSettlementRejection,
      allocationBeforeRecognitionRejection, allocationScopeRejection, allocationValueRejection,
      overAllocationRejection, reject]

/-- A settlement is refused for its operation and application time exactly when the test of line
1208 holds, whatever the rest of the request: it is the first test. -/
theorem calculateSettlement_application_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok settlementApplicationRejection ↔
      settlementApplicationIncoherent request = true := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨hi, -⟩ | ⟨-, -, hr⟩ | ⟨-, -, -, hr⟩ |
      ⟨-, -, previous, -, hloop⟩ | ⟨-, -, previous, pending, -, -, -, hr⟩
    · exact absurd hd (rejection_ne_draft (Or.inl rfl))
    · exact hi
    · exact absurd hr h12
    · exact absurd hr h13
    · rcases settlementAllocationLoop_rejected hloop with hr | hr | hr
      · exact absurd hr h14
      · exact absurd hr h15
      · exact absurd hr h16
    · exact absurd hr h17
  · exact calculateSettlement_incoherent

/-- A settlement is refused for its identity and amounts exactly when the operation and application
time are coherent and the test of line 1212 holds. -/
theorem calculateSettlement_identity_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok settlementIdentityRejection ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = true := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨-, hr⟩ | ⟨hi, hv, -⟩ | ⟨-, -, -, hr⟩ |
      ⟨-, -, previous, -, hloop⟩ | ⟨-, -, previous, pending, -, -, -, hr⟩
    · exact absurd hd (rejection_ne_draft (Or.inr (Or.inl rfl)))
    · exact absurd hr.symm h12
    · exact ⟨hi, hv⟩
    · exact absurd hr h23
    · rcases settlementAllocationLoop_rejected hloop with hr | hr | hr
      · exact absurd hr h24
      · exact absurd hr h25
      · exact absurd hr h26
    · exact absurd hr h27
  · rintro ⟨h1, h2⟩
    exact calculateSettlement_invalid h1 h2

/-- An allocation of an existing settlement is refused for not retaining it exactly when the two
tests before have passed and the settlement that was recorded does not match. -/
theorem calculateSettlement_retained_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok retainedSettlementRejection ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        previousSettlementTotals context request.hashedSettlement request.existing =
          .ok .mismatch := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨-, hr⟩ | ⟨-, -, hr⟩ |
      ⟨hi, hv, hp, -⟩ | ⟨-, -, previous, -, hloop⟩ | ⟨-, -, previous, pending, -, -, -, hr⟩
    · exact absurd hd (rejection_ne_draft (Or.inr (Or.inr (Or.inl rfl))))
    · exact absurd hr.symm h13
    · exact absurd hr.symm h23
    · exact ⟨hi, hv, hp⟩
    · rcases settlementAllocationLoop_rejected hloop with hr | hr | hr
      · exact absurd hr h34
      · exact absurd hr h35
      · exact absurd hr h36
    · exact absurd hr h37
  · rintro ⟨h1, h2, h3⟩
    exact calculateSettlement_mismatch h1 h2 h3

/-- The loop rejects exactly when the allocations before one of them all went on, and that one is
rejected. -/
theorem settlementAllocationLoop_rejected_iff {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} :
    ∀ {pending : SettlementPending} {items : List SettlementAllocationBody}
      {rejection : AccountingCalculation},
      settlementAllocationLoop context request settlement pending items =
          .ok (.rejected rejection) ↔
        ∃ (before : List SettlementAllocationBody) (allocation : SettlementAllocationBody)
          (after : List SettlementAllocationBody) (pending' : SettlementPending),
          items = before ++ allocation :: after ∧
          settlementAllocationLoop context request settlement pending before = .ok (.next pending') ∧
          settlementAllocationStep context request settlement pending' allocation =
            .ok (.rejected rejection)
  | pending, [], rejection => by
    simp [settlementAllocationLoop]
  | pending, allocation :: rest, rejection => by
    constructor
    · intro h
      unfold settlementAllocationLoop at h
      split at h
      · cases h
      · rename_i rejection' hstep
        injection h with h
        injection h with h
        subst h
        exact ⟨[], allocation, rest, pending, rfl, rfl, hstep⟩
      · rename_i next hstep
        obtain ⟨before, allocation', after, pending', hsplit, hloop, hrejected⟩ :=
          (settlementAllocationLoop_rejected_iff (pending := next)).mp h
        exact ⟨allocation :: before, allocation', after, pending', by simp [hsplit],
          by simp [settlementAllocationLoop, hstep, hloop], hrejected⟩
    · rintro ⟨before, allocation', after, pending', hsplit, hloop, hrejected⟩
      cases before with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, rfl⟩ := hsplit
        simp only [settlementAllocationLoop, Except.ok.injEq, SettlementStep.next.injEq] at hloop
        subst hloop
        simp [settlementAllocationLoop, hrejected]
      | cons first before =>
        simp only [List.cons_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, hrest⟩ := hsplit
        unfold settlementAllocationLoop at hloop
        split at hloop
        · cases hloop
        · cases hloop
        · rename_i next hstep
          simp only [settlementAllocationLoop, hstep]
          exact (settlementAllocationLoop_rejected_iff (pending := next)).mpr
            ⟨before, allocation', after, pending', hrest, hloop, hrejected⟩

/-- The test of line 1231: a total the context gives for the open item of an allocation is negative,
and then it throws a `TypeError`. -/
def SettlementReadContext.priorNegative (context : SettlementReadContext) (id : OpenItemId) : Bool :=
  (context.allocatedToOpenItem id).bookValue.isNegative ||
    (context.allocatedToOpenItem id).quantity.isNegative

/-- What a pass of the loop that rejects has been through, and which rejection it gives. -/
theorem settlementAllocationStep_rejected_cases {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {rejection : AccountingCalculation}
    (h : settlementAllocationStep context request settlement pending allocation =
      .ok (.rejected rejection)) :
    (context.priorNegative allocation.openItemId = false ∧
      recognizedAfterApplication request (context.openItem allocation.openItemId) = true ∧
      rejection = allocationBeforeRecognitionRejection) ∨
    (context.priorNegative allocation.openItemId = false ∧
      recognizedAfterApplication request (context.openItem allocation.openItemId) = false ∧
      context.openItem allocation.openItemId = none ∧ rejection = allocationScopeRejection) ∨
    (context.priorNegative allocation.openItemId = false ∧
      recognizedAfterApplication request (context.openItem allocation.openItemId) = false ∧
      ∃ item : OpenItem, context.openItem allocation.openItemId = some item ∧
        allocationScopeViolated settlement allocation item
          (context.allocatedToOpenItem allocation.openItemId)
          ((settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero)
          ((settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero)
          pending.settlementQuantity = .ok true ∧ rejection = allocationScopeRejection) ∨
    (context.priorNegative allocation.openItemId = false ∧
      recognizedAfterApplication request (context.openItem allocation.openItemId) = false ∧
      ∃ (item : OpenItem) (values : AllocationValues),
        context.openItem allocation.openItemId = some item ∧
        allocationScopeViolated settlement allocation item
          (context.allocatedToOpenItem allocation.openItemId)
          ((settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero)
          ((settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero)
          pending.settlementQuantity = .ok false ∧
        allocationValues request settlement item allocation = .ok values ∧
        allocationValuesRejected request allocation values = .ok true ∧
        rejection = allocationValueRejection) := by
  unfold settlementAllocationStep at h
  dsimp only at h
  split at h
  · cases h
  rename_i hnegative
  have hnegative' : context.priorNegative allocation.openItemId = false := by
    simpa [SettlementReadContext.priorNegative] using hnegative
  split at h
  · rename_i hrecognized
    injection h with h
    injection h with h
    exact Or.inl ⟨hnegative', by simpa using hrecognized, h.symm⟩
  rename_i hrecognized
  have hrecognized' : recognizedAfterApplication request (context.openItem allocation.openItemId) =
      false := by simpa using hrecognized
  split at h
  · rename_i hnone
    injection h with h
    injection h with h
    exact Or.inr (Or.inl ⟨hnegative', hrecognized', hnone, h.symm⟩)
  rename_i item hitem
  split at h
  · cases h
  · rename_i hscope
    injection h with h
    injection h with h
    exact Or.inr (Or.inr (Or.inl ⟨hnegative', hrecognized', item, hitem,
      liftNum_eq_ok.mp hscope, h.symm⟩))
  · rename_i hscope
    split at h
    · cases h
    rename_i values hvalues
    split at h
    · cases h
    · rename_i hrejected
      injection h with h
      injection h with h
      exact Or.inr (Or.inr (Or.inr ⟨hnegative', hrecognized', item, values, hitem,
        liftNum_eq_ok.mp hscope, hvalues, liftNum_eq_ok.mp hrejected, h.symm⟩))
    · split at h
      · cases h
      · cases h

/-- A pass of the loop rejects an allocation recognized after its application. -/
theorem settlementAllocationStep_of_recognition {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody}
    (hnegative : context.priorNegative allocation.openItemId = false)
    (hrecognized : recognizedAfterApplication request (context.openItem allocation.openItemId) =
      true) :
    settlementAllocationStep context request settlement pending allocation =
      .ok (.rejected allocationBeforeRecognitionRejection) := by
  unfold settlementAllocationStep
  simp only [SettlementReadContext.priorNegative] at hnegative
  simp [hnegative, hrecognized]

/-- A pass of the loop rejects an allocation for an open item the context does not have. -/
theorem settlementAllocationStep_of_missing {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody}
    (hnegative : context.priorNegative allocation.openItemId = false)
    (hrecognized : recognizedAfterApplication request (context.openItem allocation.openItemId) =
      false)
    (hnone : context.openItem allocation.openItemId = none) :
    settlementAllocationStep context request settlement pending allocation =
      .ok (.rejected allocationScopeRejection) := by
  unfold settlementAllocationStep
  simp only [SettlementReadContext.priorNegative] at hnegative
  rw [hnone] at hrecognized
  simp [hnegative, hrecognized, hnone]

/-- A pass of the loop rejects an allocation out of scope or beyond what is open. -/
theorem settlementAllocationStep_of_scope {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {item : OpenItem}
    (hnegative : context.priorNegative allocation.openItemId = false)
    (hrecognized : recognizedAfterApplication request (context.openItem allocation.openItemId) =
      false)
    (hitem : context.openItem allocation.openItemId = some item)
    (hscope : allocationScopeViolated settlement allocation item
      (context.allocatedToOpenItem allocation.openItemId)
      ((settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero)
      ((settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero)
      pending.settlementQuantity = .ok true) :
    settlementAllocationStep context request settlement pending allocation =
      .ok (.rejected allocationScopeRejection) := by
  unfold settlementAllocationStep
  simp only [SettlementReadContext.priorNegative] at hnegative
  rw [hitem] at hrecognized
  simp [hnegative, hrecognized, hitem, hscope, liftNum]

/-- A pass of the loop rejects an allocation whose values are not the ones it must carry. -/
theorem settlementAllocationStep_of_values {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {item : OpenItem} {values : AllocationValues}
    (hnegative : context.priorNegative allocation.openItemId = false)
    (hrecognized : recognizedAfterApplication request (context.openItem allocation.openItemId) =
      false)
    (hitem : context.openItem allocation.openItemId = some item)
    (hscope : allocationScopeViolated settlement allocation item
      (context.allocatedToOpenItem allocation.openItemId)
      ((settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero)
      ((settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero)
      pending.settlementQuantity = .ok false)
    (hvalues : allocationValues request settlement item allocation = .ok values)
    (hrejected : allocationValuesRejected request allocation values = .ok true) :
    settlementAllocationStep context request settlement pending allocation =
      .ok (.rejected allocationValueRejection) := by
  unfold settlementAllocationStep
  simp only [SettlementReadContext.priorNegative] at hnegative
  rw [hitem] at hrecognized
  simp [hnegative, hrecognized, hitem, hscope, hvalues, hrejected, liftNum]

/-- An allocation is refused for being applied before its open item was recognized exactly when the
tests before have passed, the allocations before it have gone on, and its open item's totals are not
negative and its open item was recognized after the date of the application. -/
theorem calculateSettlement_beforeRecognition_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok allocationBeforeRecognitionRejection ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        ∃ (previous : AllocatedTotal) (before : List SettlementAllocationBody)
          (allocation : SettlementAllocationBody) (after : List SettlementAllocationBody)
          (pending : SettlementPending),
          previousSettlementTotals context request.hashedSettlement request.existing =
            .ok (.totals previous) ∧
          request.allocations = before ++ allocation :: after ∧
          settlementAllocationLoop context request request.hashedSettlement
            ⟨[], [], previous.quantity⟩ before = .ok (.next pending) ∧
          context.priorNegative allocation.openItemId = false ∧
          recognizedAfterApplication request (context.openItem allocation.openItemId) = true := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨-, hr⟩ | ⟨-, -, hr⟩ | ⟨-, -, -, hr⟩ |
      ⟨hi, hv, previous, hprevious, hloop⟩ | ⟨-, -, previous, pending, -, -, -, hr⟩
    · exact absurd hd (rejection_ne_draft (Or.inr (Or.inr (Or.inr (Or.inl rfl)))))
    · exact absurd hr.symm h14
    · exact absurd hr.symm h24
    · exact absurd hr.symm h34
    · obtain ⟨before, allocation, after, pending, hsplit, hbefore, hstep⟩ :=
        settlementAllocationLoop_rejected_iff.mp hloop
      rcases settlementAllocationStep_rejected_cases hstep with
        ⟨hn, hr, -⟩ | ⟨-, -, -, hr⟩ | ⟨-, -, -, -, -, hr⟩ | ⟨-, -, -, -, -, -, -, -, hr⟩
      · exact ⟨hi, hv, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn, hr⟩
      · exact absurd hr h45
      · exact absurd hr h45
      · exact absurd hr h46
    · exact absurd hr h47
  · rintro ⟨h1, h2, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn,
      hr⟩
    exact calculateSettlement_loop_rejected h1 h2 hprevious
      (settlementAllocationLoop_rejected_iff.mpr ⟨before, allocation, after, pending, hsplit,
        hbefore, settlementAllocationStep_of_recognition hn hr⟩)

/-- An allocation is refused for scope or conservation exactly when the tests before have passed, the
allocations before it have gone on, and, for its open item's totals that are not negative and an
open item recognized by the date of the application, the context holds no open item, or the test of
line 1238 holds for it with what the allocations before added. -/
theorem calculateSettlement_scope_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok allocationScopeRejection ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        ∃ (previous : AllocatedTotal) (before : List SettlementAllocationBody)
          (allocation : SettlementAllocationBody) (after : List SettlementAllocationBody)
          (pending : SettlementPending),
          previousSettlementTotals context request.hashedSettlement request.existing =
            .ok (.totals previous) ∧
          request.allocations = before ++ allocation :: after ∧
          settlementAllocationLoop context request request.hashedSettlement
            ⟨[], [], previous.quantity⟩ before = .ok (.next pending) ∧
          context.priorNegative allocation.openItemId = false ∧
          recognizedAfterApplication request (context.openItem allocation.openItemId) = false ∧
          (context.openItem allocation.openItemId = none ∨
            ∃ item : OpenItem, context.openItem allocation.openItemId = some item ∧
              allocationScopeViolated request.hashedSettlement allocation item
                (context.allocatedToOpenItem allocation.openItemId)
                ((settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero)
                ((settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero)
                pending.settlementQuantity = .ok true) := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨-, hr⟩ | ⟨-, -, hr⟩ | ⟨-, -, -, hr⟩ |
      ⟨hi, hv, previous, hprevious, hloop⟩ | ⟨-, -, previous, pending, -, -, -, hr⟩
    · exact absurd hd (rejection_ne_draft (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl rfl))))))
    · exact absurd hr.symm h15
    · exact absurd hr.symm h25
    · exact absurd hr.symm h35
    · obtain ⟨before, allocation, after, pending, hsplit, hbefore, hstep⟩ :=
        settlementAllocationLoop_rejected_iff.mp hloop
      rcases settlementAllocationStep_rejected_cases hstep with
        ⟨-, -, hr⟩ | ⟨hn, hr, hnone, -⟩ | ⟨hn, hr, item, hitem, hscope, -⟩ |
        ⟨-, -, -, -, -, -, -, -, hr⟩
      · exact absurd hr.symm h45
      · exact ⟨hi, hv, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn,
          hr, Or.inl hnone⟩
      · exact ⟨hi, hv, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn,
          hr, Or.inr ⟨item, hitem, hscope⟩⟩
      · exact absurd hr h56
    · exact absurd hr h57
  · rintro ⟨h1, h2, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn,
      hr, hscope⟩
    refine calculateSettlement_loop_rejected h1 h2 hprevious
      (settlementAllocationLoop_rejected_iff.mpr ⟨before, allocation, after, pending, hsplit,
        hbefore, ?_⟩)
    rcases hscope with hnone | ⟨item, hitem, hviolated⟩
    · exact settlementAllocationStep_of_missing hn hr hnone
    · exact settlementAllocationStep_of_scope hn hr hitem hviolated

/-- An allocation is refused for not carrying the values it must exactly when the tests before have
passed, the allocations before it have gone on, its open item's totals are not negative, its open
item was recognized by the date of the application, the test of line 1238 does not hold for it, the
values of the allocation are computed, and the test of line 1254 holds for them. -/
theorem calculateSettlement_value_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok allocationValueRejection ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        ∃ (previous : AllocatedTotal) (before : List SettlementAllocationBody)
          (allocation : SettlementAllocationBody) (after : List SettlementAllocationBody)
          (pending : SettlementPending),
          previousSettlementTotals context request.hashedSettlement request.existing =
            .ok (.totals previous) ∧
          request.allocations = before ++ allocation :: after ∧
          settlementAllocationLoop context request request.hashedSettlement
            ⟨[], [], previous.quantity⟩ before = .ok (.next pending) ∧
          context.priorNegative allocation.openItemId = false ∧
          recognizedAfterApplication request (context.openItem allocation.openItemId) = false ∧
          ∃ (item : OpenItem) (values : AllocationValues),
            context.openItem allocation.openItemId = some item ∧
            allocationScopeViolated request.hashedSettlement allocation item
              (context.allocatedToOpenItem allocation.openItemId)
              ((settlementMapGet pending.byOpenItem allocation.openItemId).getD ExactRational.zero)
              ((settlementMapGet pending.openQuantity allocation.openItemId).getD ExactRational.zero)
              pending.settlementQuantity = .ok false ∧
            allocationValues request request.hashedSettlement item allocation = .ok values ∧
            allocationValuesRejected request allocation values = .ok true := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨-, hr⟩ | ⟨-, -, hr⟩ | ⟨-, -, -, hr⟩ |
      ⟨hi, hv, previous, hprevious, hloop⟩ | ⟨-, -, previous, pending, -, -, -, hr⟩
    · exact absurd hd (rejection_ne_draft (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl rfl)))))))
    · exact absurd hr.symm h16
    · exact absurd hr.symm h26
    · exact absurd hr.symm h36
    · obtain ⟨before, allocation, after, pending, hsplit, hbefore, hstep⟩ :=
        settlementAllocationLoop_rejected_iff.mp hloop
      rcases settlementAllocationStep_rejected_cases hstep with
        ⟨-, -, hr⟩ | ⟨-, -, -, hr⟩ | ⟨-, -, -, -, -, hr⟩ |
        ⟨hn, hr, item, values, hitem, hscope, hvalues, hrejected, -⟩
      · exact absurd hr.symm h46
      · exact absurd hr.symm h56
      · exact absurd hr.symm h56
      · exact ⟨hi, hv, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn,
          hr, item, values, hitem, hscope, hvalues, hrejected⟩
    · exact absurd hr h67
  · rintro ⟨h1, h2, previous, before, allocation, after, pending, hprevious, hsplit, hbefore, hn,
      hr, item, values, hitem, hscope, hvalues, hrejected⟩
    exact calculateSettlement_loop_rejected h1 h2 hprevious
      (settlementAllocationLoop_rejected_iff.mpr ⟨before, allocation, after, pending, hsplit,
        hbefore, settlementAllocationStep_of_values hn hr hitem hscope hvalues hrejected⟩)

/-- A settlement is refused as over-allocated exactly when the tests before have passed, every
allocation has gone through the loop, and what was allocated from the settlement before, with the
settlement's book value that every allocation carries, exceeds its book value. -/
theorem calculateSettlement_overAllocated_rejected_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .ok overAllocationRejection ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        ∃ (previous : AllocatedTotal) (pending : SettlementPending),
          previousSettlementTotals context request.hashedSettlement request.existing =
            .ok (.totals previous) ∧
          settlementAllocationLoop context request request.hashedSettlement
            ⟨[], [], previous.quantity⟩ request.allocations = .ok (.next pending) ∧
          settlementOverAllocated request.hashedSettlement previous request.allocations =
            .ok true := by
  obtain ⟨⟨h12, h13, h14, h15, h16, h17⟩, ⟨h23, h24, h25, h26, h27⟩, ⟨h34, h35, h36, h37⟩,
    ⟨h45, h46, h47⟩, ⟨h56, h57⟩, h67⟩ := settlementRejections_ne
  constructor
  · intro h
    rcases calculateSettlement_ok_cases h with ⟨d, hd⟩ | ⟨-, hr⟩ | ⟨-, -, hr⟩ | ⟨-, -, -, hr⟩ |
      ⟨hi, hv, previous, hprevious, hloop⟩ | ⟨hi, hv, previous, pending, hprevious, hloop, hover, -⟩
    · exact absurd hd (rejection_ne_draft
        (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr rfl)))))))
    · exact absurd hr.symm h17
    · exact absurd hr.symm h27
    · exact absurd hr.symm h37
    · rcases settlementAllocationLoop_rejected hloop with hr | hr | hr
      · exact absurd hr.symm h47
      · exact absurd hr.symm h57
      · exact absurd hr.symm h67
    · exact ⟨hi, hv, previous, pending, hprevious, hloop, hover⟩
  · rintro ⟨h1, h2, previous, pending, hprevious, hloop, hover⟩
    exact calculateSettlement_overAllocated h1 h2 hprevious hloop hover

/-- Every item has no value exactly when no item has one. -/
theorem forall_not_some_iff {α β : Type} (items : List α) (f : α → Option β) :
    (∀ x ∈ items, ∀ y, ¬ f x = some y) ↔ ∀ x ∈ items, f x = none := by
  constructor
  · intro h x hx
    cases hv : f x with
    | none => rfl
    | some y => exact absurd hv (h x hx y)
  · intro h x hx y hy
    rw [h x hx] at hy
    cases hy

/-- Every item that has a value has the given one exactly when each has none or the given one. -/
theorem forall_some_eq_iff {α β : Type} (items : List α) (f : α → Option β) (r : Option β) :
    (∀ x ∈ items, ∀ y, f x = some y → f x = r) ↔ ∀ x ∈ items, f x = none ∨ f x = r := by
  constructor
  · intro h x hx
    cases hv : f x with
    | none => exact Or.inl rfl
    | some y => exact Or.inr (hv ▸ h x hx y hv)
  · intro h x hx y hy
    rcases h x hx with h | h
    · rw [h] at hy; cases hy
    · exact h

/-- The operation and the application time are coherent exactly when a request that does not allocate
an existing settlement has no application time, one that does has one that `Date.parse` reads and
that is not below the settlement's time (as texts), and an allocation that carries an application
time is of an existing settlement and carries the request's. -/
theorem settlementApplicationIncoherent_eq_false_iff (request : SettlementRequest) :
    settlementApplicationIncoherent request = false ↔
      (request.existing = false → request.appliedAt = none) ∧
      (request.existing = true → ∃ appliedAt : Instant, request.appliedAt = some appliedAt ∧
        (dateParse appliedAt.value).isSome = true ∧
        jsStringLt appliedAt.value request.settlement.settledAt.value = false) ∧
      (∀ allocation ∈ request.allocations, allocation.appliedAt = none ∨
        (request.existing = true ∧ allocation.appliedAt = request.appliedAt)) := by
  unfold settlementApplicationIncoherent
  cases hex : request.existing <;> cases hat : request.appliedAt <;>
    simp [Option.isSome_iff_exists, forall_not_some_iff, forall_some_eq_iff]

/-- The test of line 1238 holds exactly when a clause that looks at no sum holds, or none does and a
sum goes beyond what it is compared with. -/
theorem allocationScopeViolated_eq_true_iff (settlement : Settlement)
    (allocation : SettlementAllocationBody) (item : OpenItem) (prior : AllocatedTotal)
    (pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational) :
    allocationScopeViolated settlement allocation item prior pendingBookValue pendingQuantity
        pendingSettlementQuantity = .ok true ↔
      allocationScopeClauses settlement allocation item = true ∨
        (allocationScopeClauses settlement allocation item = false ∧
          allocationCapacityExceeded settlement allocation item prior pendingBookValue
            pendingQuantity pendingSettlementQuantity = .ok true) := by
  unfold allocationScopeViolated
  cases hclauses : allocationScopeClauses settlement allocation item <;> simp

/-- The three sums of line 1238 go beyond what they are compared with exactly when, in this order,
the open item's allocated book value is computed and goes beyond its book value; or it does not, and
the open item's allocated quantity is computed and goes beyond its denomination; or it does not, and
the settlement's allocated quantity is computed and goes beyond its denomination. -/
theorem allocationCapacityExceeded_eq_true_iff (settlement : Settlement)
    (allocation : SettlementAllocationBody) (item : OpenItem) (prior : AllocatedTotal)
    (pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational) :
    allocationCapacityExceeded settlement allocation item prior pendingBookValue pendingQuantity
        pendingSettlementQuantity = .ok true ↔
      ∃ bookValueTotal : ExactRational,
        (∃ priorAndPending : ExactRational,
          prior.bookValue.add pendingBookValue = .ok priorAndPending ∧
          priorAndPending.add allocation.allocatedBookValue = .ok bookValueTotal) ∧
        ((bookValueTotal.compare item.bookValue.abs == .gt) = true ∨
          ((bookValueTotal.compare item.bookValue.abs == .gt) = false ∧
            ∃ quantityTotal : ExactRational,
              (∃ priorAndPendingQuantity : ExactRational,
                prior.quantity.add pendingQuantity = .ok priorAndPendingQuantity ∧
                priorAndPendingQuantity.add allocation.allocatedOpenQuantity = .ok quantityTotal) ∧
              ((quantityTotal.compare item.denomination.abs == .gt) = true ∨
                ((quantityTotal.compare item.denomination.abs == .gt) = false ∧
                  ∃ settlementQuantityTotal : ExactRational,
                    pendingSettlementQuantity.add allocation.allocatedSettlementQuantity =
                      .ok settlementQuantityTotal ∧
                    (settlementQuantityTotal.compare settlement.denomination.abs == .gt) =
                      true)))) := by
  constructor
  · intro h
    unfold allocationCapacityExceeded at h
    split at h
    · cases h
    rename_i priorAndPending hpp
    split at h
    · cases h
    rename_i bookValueTotal hbook
    refine ⟨bookValueTotal, ⟨priorAndPending, hpp, hbook⟩, ?_⟩
    split at h
    · rename_i hgt
      exact Or.inl hgt
    rename_i hgt
    refine Or.inr ⟨by simpa using hgt, ?_⟩
    split at h
    · cases h
    rename_i priorAndPendingQuantity hpq
    split at h
    · cases h
    rename_i quantityTotal hquantity
    refine ⟨quantityTotal, ⟨priorAndPendingQuantity, hpq, hquantity⟩, ?_⟩
    split at h
    · rename_i hgt'
      exact Or.inl hgt'
    rename_i hgt'
    refine Or.inr ⟨by simpa using hgt', ?_⟩
    split at h
    · cases h
    rename_i settlementQuantityTotal hsettled
    simp only [Except.ok.injEq] at h
    exact ⟨settlementQuantityTotal, hsettled, h⟩
  · rintro ⟨bookValueTotal, ⟨priorAndPending, hpp, hbook⟩, hcases⟩
    unfold allocationCapacityExceeded
    rw [hpp]
    dsimp only
    rw [hbook]
    dsimp only
    rcases hcases with hgt | ⟨hgt, quantityTotal, ⟨priorAndPendingQuantity, hpq, hquantity⟩, hcases'⟩
    · simp [hgt]
    · simp only [hgt, Bool.false_eq_true, ↓reduceIte]
      rw [hpq]
      dsimp only
      rw [hquantity]
      dsimp only
      rcases hcases' with hgt' | ⟨hgt', settlementQuantityTotal, hsettled, hlast⟩
      · simp [hgt']
      · simp only [hgt', Bool.false_eq_true, ↓reduceIte]
        rw [hsettled]
        simp [hlast]

/-- The test of line 1254 holds exactly when, in this order, one of its first four clauses holds; or
none does and the recorded measurement is not the expected one; or it is and the recorded
difference is not the expected one; or both are and one of its last three clauses holds. -/
theorem allocationValuesRejected_eq_true_iff (request : SettlementRequest)
    (allocation : SettlementAllocationBody) (values : AllocationValues) :
    allocationValuesRejected request allocation values = .ok true ↔
      allocationValueClauses allocation values = true ∨
        (allocationValueClauses allocation values = false ∧
          (quantizationMatches allocation.settlementMeasurement values.expectedMeasurement =
              .ok false ∨
            (quantizationMatches allocation.settlementMeasurement values.expectedMeasurement =
                .ok true ∧
              (quantizationMatches allocation.realizedExchangeDifference values.expectedRealized =
                  .ok false ∨
                (quantizationMatches allocation.realizedExchangeDifference
                    values.expectedRealized = .ok true ∧
                  allocationRecordedClauses request allocation values = true))))) := by
  unfold allocationValuesRejected
  cases hclauses : allocationValueClauses allocation values
  · simp only [Bool.false_eq_true, ↓reduceIte, false_or, true_and]
    cases hm : quantizationMatches allocation.settlementMeasurement values.expectedMeasurement with
    | error e => simp
    | ok first =>
      cases first
      · simp
      · simp only [Except.ok.injEq, Bool.true_eq_false, false_or, true_and]
        cases hr : quantizationMatches allocation.realizedExchangeDifference
            values.expectedRealized with
        | error e => simp
        | ok second =>
          cases second
          · simp
          · simp
  · simp

/-- An open item is accepted exactly when its conditions hold: the draft it gives is the one effect. -/
theorem calculateOpenItem_eq_draft_iff (identity : IdentityObservation)
    (request : OpenItemRecognitionRequest) (draft : AccountingDraft) :
    calculateOpenItem identity request = .draft draft ↔
      openItemRefused identity request = false ∧
        draft = { journals := [],
                  effects := [.openItem { toOpenItemBody := request.value,
                                          contentHash := accountingHash "OpenItem" request.value }] } := by
  unfold calculateOpenItem
  by_cases h : openItemRefused identity request = true
  · simp [h, openItemRejection, reject]
  · have hfalse : openItemRefused identity request = false := by simpa using h
    simp only [hfalse, Bool.false_eq_true, ↓reduceIte, true_and, drafted,
      immutableAccountingValue, AccountingCalculation.draft.injEq]
    constructor <;> intro h' <;> subst h' <;> rfl

/-- A request that has gone through every stage is a draft: the converse of
`calculateSettlement_draft`. -/
theorem calculateSettlement_of_stages {context : SettlementReadContext} {request : SettlementRequest}
    {previous : AllocatedTotal} {pending : SettlementPending} {built : List SettlementAllocation}
    (h1 : settlementApplicationIncoherent request = false)
    (h2 : settlementIdentityInvalid context request = false)
    (h3 : previousSettlementTotals context request.hashedSettlement request.existing =
      .ok (.totals previous))
    (h4 : settlementAllocationLoop context request request.hashedSettlement
      ⟨[], [], previous.quantity⟩ request.allocations = .ok (.next pending))
    (h5 : settlementOverAllocated request.hashedSettlement previous request.allocations =
      .ok false)
    (h6 : buildSettlementAllocations request request.hashedSettlement request.allocations =
      .ok built) :
    calculateSettlement context request =
      .ok (.draft { journals := [],
                    effects := settlementEffects request.existing request.hashedSettlement built }) := by
  unfold calculateSettlement
  simp [h1, h2, h3, h4, h5, h6, liftNum, drafted, immutableAccountingValue]

/-! ## What the TypeScript does that a law did not expect -/

set_option maxRecDepth 200000 in
/-- The test of line 1209 compares the application time with the settlement's as texts, not as times,
so that an application at `2026-01-01T10:00:00+14:00`, which is `2025-12-31T20:00:00Z`, five hours
before a settlement at `2026-01-01T01:00:00Z`, is coherent because its text is the larger. -/
theorem settlementApplication_compares_texts :
    ∃ request : SettlementRequest, request.existing = true ∧
      settlementApplicationIncoherent request = false ∧
      dateParse "2026-01-01T10:00:00+14:00" = some 1767211200000 ∧
      dateParse request.settlement.settledAt.value = some 1767229200000 ∧
      (1767211200000 : Int) < 1767229200000 := by
  refine ⟨{ (default : SettlementRequest) with
      operation := some .allocateExisting
      appliedAt := some ⟨"2026-01-01T10:00:00+14:00"⟩
      settlement := { (default : SettlementRequest).settlement with
        settledAt := ⟨"2026-01-01T01:00:00Z"⟩ }
      allocations := [] }, ?_, ?_, ?_, ?_, by decide⟩
  · decide
  · decide
  · decide
  · decide

/-! ## What throws -/

/-- The hash check of a settlement effect never throws. -/
theorem validateAccountingEffectHash_settlement_ok (settlement : Settlement) :
    ∃ valid : Bool, validateAccountingEffectHash (.settlement settlement) = .ok valid := by
  simp [validateAccountingEffectHash]

/-- A `NumErr` result lifted into `calculateSettlement`'s errors is an error exactly when it was. -/
theorem liftNum_eq_error {α : Type} {result : Except NumErr α} {e : SettlementErr} :
    liftNum result = .error e ↔ ∃ code, result = .error code ∧ e = .exactNumber code := by
  cases result <;> simp [liftNum, eq_comm]

/-- A `QuantizeErr` result lifted into `calculateSettlement`'s errors is an error exactly when it
was. -/
theorem liftQuantize_eq_error {α : Type} {result : Except QuantizeErr α} {e : SettlementErr} :
    liftQuantize result = .error e ↔
      ∃ error, result = .error error ∧ e = SettlementErr.ofQuantize error := by
  cases result <;> simp [liftQuantize, eq_comm]

/-- The settlement that was recorded fails to be read only for a negative total: the one
`TypeError` of lines 1221 and 1222. -/
theorem previousSettlementTotals_error {context : SettlementReadContext} {settlement : Settlement}
    {existing : Bool} {e : SettlementErr}
    (h : previousSettlementTotals context settlement existing = .error e) :
    e = .incompletePriorSettlementTotals ∧ existing = true ∧
      ∃ retained, context.existingSettlement settlement.id = some retained ∧
        contentHashEquals retained.contentHash settlement.contentHash = true ∧
        validateAccountingEffectHash (.settlement retained) = .ok true ∧
        ((context.allocatedFromSettlement settlement.id).bookValue.isNegative = true ∨
          (context.allocatedFromSettlement settlement.id).quantity.isNegative = true) := by
  unfold previousSettlementTotals at h
  split at h
  · cases h
  · rename_i hexisting
    split at h
    · cases h
    · rename_i retained hretained
      split at h
      · cases h
      · rename_i hhash
        split at h
        · rename_i code hcode
          obtain ⟨valid, hvalid⟩ := validateAccountingEffectHash_settlement_ok retained
          rw [hvalid] at hcode
          cases hcode
        · cases h
        · rename_i hvalid
          dsimp only at h
          split at h
          · rename_i hnegative
            simp only [Except.error.injEq] at h
            exact ⟨h.symm, by simpa using hexisting, retained, hretained, by simpa using hhash,
              hvalid, by simpa using hnegative⟩
          · cases h

/-- Where `calculateSettlement` throws: after the two first tests passed, in the read of the settlement
that was recorded, in the loop, in the over-allocation test, or in the building of the allocations. -/
theorem calculateSettlement_error_cases {context : SettlementReadContext}
    {request : SettlementRequest} {e : SettlementErr}
    (h : calculateSettlement context request = .error e) :
    settlementApplicationIncoherent request = false ∧
      settlementIdentityInvalid context request = false ∧
      (previousSettlementTotals context request.hashedSettlement request.existing = .error e ∨
        ∃ previous : AllocatedTotal,
          previousSettlementTotals context request.hashedSettlement request.existing =
            .ok (.totals previous) ∧
          (settlementAllocationLoop context request request.hashedSettlement
              ⟨[], [], previous.quantity⟩ request.allocations = .error e ∨
            ∃ pending : SettlementPending,
              settlementAllocationLoop context request request.hashedSettlement
                ⟨[], [], previous.quantity⟩ request.allocations = .ok (.next pending) ∧
              ((∃ code, settlementOverAllocated request.hashedSettlement previous
                  request.allocations = .error code ∧ e = .exactNumber code) ∨
                (settlementOverAllocated request.hashedSettlement previous request.allocations =
                    .ok false ∧
                  buildSettlementAllocations request request.hashedSettlement request.allocations =
                    .error e)))) := by
  unfold calculateSettlement at h
  split at h
  · cases h
  rename_i hincoherent
  split at h
  · cases h
  rename_i hinvalid
  refine ⟨by simpa using hincoherent, by simpa using hinvalid, ?_⟩
  dsimp only at h
  split at h
  · rename_i e' hprevious
    injection h with h
    subst h
    exact Or.inl hprevious
  · cases h
  · rename_i previous hprevious
    refine Or.inr ⟨previous, hprevious, ?_⟩
    split at h
    · rename_i e' hloop
      injection h with h
      subst h
      exact Or.inl hloop
    · cases h
    · rename_i pending hloop
      refine Or.inr ⟨pending, hloop, ?_⟩
      split at h
      · rename_i e' hover
        injection h with h
        subst h
        obtain ⟨code, hcode, hlift⟩ := liftNum_eq_error.mp hover
        exact Or.inl ⟨code, hcode, hlift⟩
      · cases h
      · rename_i hover
        split at h
        · rename_i e' hbuild
          injection h with h
          subst h
          exact Or.inr ⟨liftNum_eq_ok.mp hover, hbuild⟩
        · cases h

/-- The codes that an exact-number operation of `numeric.ts` throws in the settlement code: a
division by zero or a size beyond the limit. -/
def NumErr.Plain (code : NumErr) : Prop :=
  code = .invalidRational ∨ code = .representationLimitExceeded

/-- Adding throws a plain error. -/
theorem add_error_plain {a b : ExactRational} {code : NumErr} (h : a.add b = .error code) :
    code.Plain := ExactRational.of_error h

/-- Subtracting throws a plain error. -/
theorem subtract_error_plain {a b : ExactRational} {code : NumErr} (h : a.subtract b = .error code) :
    code.Plain := ExactRational.of_error h

/-- Multiplying throws a plain error. -/
theorem multiply_error_plain {a b : ExactRational} {code : NumErr}
    (h : a.multiply b = .error code) : code.Plain := ExactRational.of_error h

/-- Dividing throws a plain error. -/
theorem divide_error_plain {a b : ExactRational} {code : NumErr} (h : a.divide b = .error code) :
    code.Plain := by
  unfold ExactRational.divide at h
  split at h
  · cases h; exact Or.inl rfl
  · dsimp only at h
    split at h <;> exact ExactRational.of_error h

/-- Converting a decimal to a fraction throws a plain error. -/
theorem toRational_error_plain {d : ExactDecimal} {code : NumErr} (h : d.toRational = .error code) :
    code.Plain := ExactRational.of_error h

/-- The share of a book value throws a plain error. -/
theorem proportionalShare_error_plain {bookValue denomination quantity : ExactRational}
    {code : NumErr} (h : proportionalShare bookValue denomination quantity = .error code) :
    code.Plain := by
  unfold proportionalShare at h
  split at h
  · cases h; exact multiply_error_plain ‹_›
  · exact divide_error_plain h

/-- A decimal at an admitted scale is refused only for size. -/
theorem decimal_of_error_limit {coefficient scale : Int} {code : NumErr} (h0 : 0 ≤ scale)
    (h1 : scale ≤ maxDecimalScale) (h : ExactDecimal.of coefficient scale = .error code) :
    code = .representationLimitExceeded := by
  by_cases hw : withinMagnitude coefficient = true
  · rw [(ExactDecimal.of_eq_ok_iff coefficient scale ⟨coefficient, scale⟩).mpr
      ⟨h0, h1, hw, rfl⟩] at h
    cases h
  · rw [(ExactDecimal.of_eq_limit_iff coefficient scale).mpr ⟨h0, h1, hw⟩] at h
    cases h
    rfl

/-- A lifted exact-number error is the error of the operation. -/
theorem liftExact_error_code {α : Type} {result : Except NumErr α} {e : QuantizeErr}
    (h : liftExact result = .error e) : ∃ code, result = .error code ∧ e = .exactNumber code := by
  cases result with
  | error code => exact ⟨code, rfl, by simpa [liftExact] using h.symm⟩
  | ok value => simp [liftExact] at h

/-- Rounding throws the `RangeError` of the scale or a plain error. -/
theorem quantize_error_plain {value : ExactRational} {rule : QuantizationRule} {e : QuantizeErr}
    (h : quantize value rule = .error e) :
    e = .scaleOutOfRange ∨ ∃ code, code.Plain ∧ e = .exactNumber code := by
  unfold quantize at h
  split at h
  · cases h; exact Or.inl rfl
  · rename_i hscale
    right
    have h0 : 0 ≤ rule.targetScale := by
      simp only [not_or, not_lt] at hscale; exact hscale.1
    have h1 : rule.targetScale ≤ maxDecimalScale := by
      simp only [not_or, not_lt, gt_iff_lt] at hscale; exact hscale.2
    dsimp only at h
    split at h
    · rename_i e' hof
      cases h
      obtain ⟨code, hcode, rfl⟩ := liftExact_error_code hof
      exact ⟨code, Or.inr (decimal_of_error_limit h0 h1 hcode), rfl⟩
    · split at h
      · rename_i e' hto
        cases h
        obtain ⟨code, hcode, rfl⟩ := liftExact_error_code hto
        exact ⟨code, toRational_error_plain hcode, rfl⟩
      · split at h
        · rename_i e' hsub
          cases h
          obtain ⟨code, hcode, rfl⟩ := liftExact_error_code hsub
          exact ⟨code, subtract_error_plain hcode, rfl⟩
        · cases h

/-- An error of an operation on numbers: a plain exact-number error, or the `RangeError` of the scale
of a quantization policy. -/
def SettlementErr.Arithmetic (e : SettlementErr) : Prop :=
  (∃ code : NumErr, code.Plain ∧ e = .exactNumber code) ∨ e = .scaleOutOfRange

/-- A lifted plain exact-number error is an error of an operation on numbers. -/
theorem liftNum_error_arithmetic {α : Type} {result : Except NumErr α} {e : SettlementErr}
    (h : liftNum result = .error e) (hplain : ∀ code, result = .error code → code.Plain) :
    e.Arithmetic := by
  obtain ⟨code, hcode, rfl⟩ := liftNum_eq_error.mp h
  exact Or.inl ⟨code, hplain code hcode, rfl⟩

/-- A lifted rounding error is an error of an operation on numbers. -/
theorem liftQuantize_error_arithmetic {α : Type} {result : Except QuantizeErr α} {e : SettlementErr}
    (h : liftQuantize result = .error e)
    (hplain : ∀ error, result = .error error →
      error = .scaleOutOfRange ∨ ∃ code : NumErr, code.Plain ∧ error = .exactNumber code) :
    e.Arithmetic := by
  obtain ⟨error, herror, rfl⟩ := liftQuantize_eq_error.mp h
  rcases hplain error herror with rfl | ⟨code, hcode, rfl⟩
  · exact Or.inr rfl
  · exact Or.inl ⟨code, hcode, rfl⟩

/-- The three sums of line 1238 throw plain errors. -/
theorem allocationCapacityExceeded_error_plain {settlement : Settlement}
    {allocation : SettlementAllocationBody} {item : OpenItem} {prior : AllocatedTotal}
    {pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational} {code : NumErr}
    (h : allocationCapacityExceeded settlement allocation item prior pendingBookValue
      pendingQuantity pendingSettlementQuantity = .error code) : code.Plain := by
  unfold allocationCapacityExceeded at h
  split at h
  · cases h; exact add_error_plain ‹_›
  · split at h
    · cases h; exact add_error_plain ‹_›
    · split at h
      · cases h
      · split at h
        · cases h; exact add_error_plain ‹_›
        · split at h
          · cases h; exact add_error_plain ‹_›
          · split at h
            · cases h
            · split at h
              · cases h; exact add_error_plain ‹_›
              · cases h

/-- The test of line 1238 throws a plain error. -/
theorem allocationScopeViolated_error_plain {settlement : Settlement}
    {allocation : SettlementAllocationBody} {item : OpenItem} {prior : AllocatedTotal}
    {pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational} {code : NumErr}
    (h : allocationScopeViolated settlement allocation item prior pendingBookValue
      pendingQuantity pendingSettlementQuantity = .error code) : code.Plain := by
  unfold allocationScopeViolated at h
  split at h
  · cases h
  · exact allocationCapacityExceeded_error_plain h

/-- The coherence of the path throws a plain error. -/
theorem pathCoherent_error_plain {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody}
    {quantity settlementBookValue : ExactRational} {code : NumErr}
    (h : pathCoherent request settlement item allocation quantity settlementBookValue =
      .error code) : code.Plain := by
  unfold pathCoherent at h
  split at h
  · cases h
  · split at h
    · split at h
      · split at h
        · cases h; exact multiply_error_plain ‹_›
        · cases h
      · cases h
    · cases h

/-- The comparison of two quantizations throws a plain error. -/
theorem quantizationMatches_error_plain {actual expected : Option QuantizedValue} {code : NumErr}
    (h : quantizationMatches actual expected = .error code) : code.Plain := by
  unfold quantizationMatches at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h; exact toRational_error_plain ‹_›
      · split at h
        · cases h; exact toRational_error_plain ‹_›
        · cases h

/-- The expected measurement throws the `RangeError` of the scale or a plain error. -/
theorem expectedSettlementMeasurement_error {policy : Option QuantizationPolicy}
    {value : ExactRational} {error : QuantizeErr}
    (h : expectedSettlementMeasurement policy value = .error error) :
    error = .scaleOutOfRange ∨ ∃ code : NumErr, code.Plain ∧ error = .exactNumber code := by
  cases policy with
  | none => simp [expectedSettlementMeasurement] at h
  | some policy =>
    simp only [expectedSettlementMeasurement] at h
    split at h
    · cases h; exact quantize_error_plain ‹_›
    · cases h

/-- The expected difference throws the `RangeError` of the scale or a plain error. -/
theorem expectedRealizedDifference_error {policy : Option QuantizationPolicy}
    {difference : ExactRational} {error : QuantizeErr}
    (h : expectedRealizedDifference policy difference = .error error) :
    error = .scaleOutOfRange ∨ ∃ code : NumErr, code.Plain ∧ error = .exactNumber code := by
  cases policy with
  | none => simp [expectedRealizedDifference] at h
  | some policy =>
    simp only [expectedRealizedDifference] at h
    split at h
    · cases h
    · split at h
      · cases h; exact quantize_error_plain ‹_›
      · cases h

/-- The values of an allocation throw an error of an operation on numbers. -/
theorem allocationValues_error_arithmetic {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody} {e : SettlementErr}
    (h : allocationValues request settlement item allocation = .error e) : e.Arithmetic := by
  unfold allocationValues at h
  dsimp only at h
  split at h
  · cases h
    exact liftNum_error_arithmetic ‹_› fun code hcode => proportionalShare_error_plain hcode
  · split at h
    · cases h
      exact liftNum_error_arithmetic ‹_› fun code hcode => proportionalShare_error_plain hcode
    · split at h
      · cases h
        exact liftNum_error_arithmetic ‹_› fun code hcode => subtract_error_plain hcode
      · split at h
        · cases h
          exact liftNum_error_arithmetic ‹_› fun code hcode => pathCoherent_error_plain hcode
        · split at h
          · cases h
            exact liftQuantize_error_arithmetic ‹_› fun error herror =>
              expectedSettlementMeasurement_error herror
          · split at h
            · cases h
              exact liftQuantize_error_arithmetic ‹_› fun error herror =>
                expectedRealizedDifference_error herror
            · cases h

/-- The test of line 1254 throws a plain error. -/
theorem allocationValuesRejected_error_plain {request : SettlementRequest}
    {allocation : SettlementAllocationBody} {values : AllocationValues} {code : NumErr}
    (h : allocationValuesRejected request allocation values = .error code) : code.Plain := by
  unfold allocationValuesRejected at h
  split at h
  · cases h
  · split at h
    · cases h; exact quantizationMatches_error_plain ‹_›
    · cases h
    · split at h
      · cases h; exact quantizationMatches_error_plain ‹_›
      · cases h
      · cases h

/-- The update of the working values throws a plain error. -/
theorem pendingUpdate_error_plain {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {code : NumErr}
    (h : pendingUpdate pending allocation = .error code) : code.Plain := by
  unfold pendingUpdate at h
  dsimp only at h
  split at h
  · cases h; exact add_error_plain ‹_›
  · split at h
    · cases h; exact add_error_plain ‹_›
    · split at h
      · cases h; exact add_error_plain ‹_›
      · cases h

/-- One pass of the loop throws an error of an operation on numbers, or the `TypeError` of a negative
total. -/
theorem settlementAllocationStep_error_cases {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {e : SettlementErr}
    (h : settlementAllocationStep context request settlement pending allocation = .error e) :
    e.Arithmetic ∨ e = .incompleteSettlementTotals := by
  unfold settlementAllocationStep at h
  dsimp only at h
  split at h
  · cases h; exact Or.inr rfl
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · rename_i hscope
          cases h
          exact Or.inl (liftNum_error_arithmetic ‹_› fun code hcode =>
            allocationScopeViolated_error_plain hcode)
        · cases h
        · split at h
          · rename_i e' hvalues
            cases h
            exact Or.inl (allocationValues_error_arithmetic hvalues)
          · split at h
            · cases h
              exact Or.inl (liftNum_error_arithmetic ‹_› fun code hcode =>
                allocationValuesRejected_error_plain hcode)
            · cases h
            · split at h
              · cases h
                exact Or.inl (liftNum_error_arithmetic ‹_› fun code hcode =>
                  pendingUpdate_error_plain hcode)
              · cases h

/-- The loop throws an error of an operation on numbers, or the `TypeError` of a negative total. -/
theorem settlementAllocationLoop_error_cases {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} :
    ∀ {pending : SettlementPending} {allocations : List SettlementAllocationBody}
      {e : SettlementErr},
      settlementAllocationLoop context request settlement pending allocations = .error e →
      e.Arithmetic ∨ e = .incompleteSettlementTotals
  | pending, [], e, h => by simp [settlementAllocationLoop] at h
  | pending, allocation :: rest, e, h => by
    unfold settlementAllocationLoop at h
    split at h
    · rename_i e' hstep
      cases h
      exact settlementAllocationStep_error_cases hstep
    · cases h
    · exact settlementAllocationLoop_error_cases h

/-- Adding up values throws a plain error. -/
theorem addExactValues_error_plain :
    ∀ {total : ExactRational} {values : List ExactRational} {code : NumErr},
      addExactValues total values = .error code → code.Plain
  | total, [], code, h => by cases h
  | total, value :: rest, code, h => by
    simp only [addExactValues] at h
    split at h
    · cases h; exact add_error_plain ‹_›
    · exact addExactValues_error_plain h

/-- The settlement's book value that an allocation carries throws a plain error. -/
theorem settledBookValue_error_plain {settlement : Settlement} {item : SettlementAllocationBody}
    {code : NumErr} (h : settledBookValue settlement item = .error code) : code.Plain := by
  unfold settledBookValue at h
  split at h
  · cases h
  · exact proportionalShare_error_plain h

/-- Reading the settlement's book value from every allocation throws a plain error. -/
theorem settledBookValues_error_plain {settlement : Settlement} :
    ∀ {items : List SettlementAllocationBody} {code : NumErr},
      settledBookValues settlement items = .error code → code.Plain
  | [], code, h => by simp [settledBookValues] at h
  | item :: rest, code, h => by
    unfold settledBookValues at h
    split at h
    · cases h; exact settledBookValue_error_plain ‹_›
    · split at h
      · cases h; exact settledBookValues_error_plain ‹_›
      · cases h

/-- The over-allocation test throws a plain error. -/
theorem settlementOverAllocated_error_plain {settlement : Settlement} {previous : AllocatedTotal}
    {items : List SettlementAllocationBody} {code : NumErr}
    (h : settlementOverAllocated settlement previous items = .error code) : code.Plain := by
  unfold settlementOverAllocated at h
  split at h
  · cases h; exact settledBookValues_error_plain ‹_›
  · split at h
    · cases h; exact addExactValues_error_plain ‹_›
    · split at h
      · cases h; exact add_error_plain ‹_›
      · cases h

/-- Building an allocation throws an error of an operation on numbers. -/
theorem buildSettlementAllocation_error_arithmetic {request : SettlementRequest}
    {settlement : Settlement} {item : SettlementAllocationBody} {e : SettlementErr}
    (h : buildSettlementAllocation request settlement item = .error e) : e.Arithmetic := by
  unfold buildSettlementAllocation at h
  dsimp only at h
  split at h
  · cases h
    exact liftNum_error_arithmetic ‹_› fun code hcode => settledBookValue_error_plain hcode
  · split at h
    · cases h
      exact liftNum_error_arithmetic ‹_› fun code hcode => subtract_error_plain hcode
    · split at h
      · cases h
        exact liftQuantize_error_arithmetic ‹_› fun error herror =>
          expectedSettlementMeasurement_error herror
      · split at h
        · cases h
          exact liftQuantize_error_arithmetic ‹_› fun error herror =>
            expectedRealizedDifference_error herror
        · cases h

/-- Building the allocations throws an error of an operation on numbers. -/
theorem buildSettlementAllocations_error_arithmetic {request : SettlementRequest}
    {settlement : Settlement} :
    ∀ {items : List SettlementAllocationBody} {e : SettlementErr},
      buildSettlementAllocations request settlement items = .error e → e.Arithmetic
  | [], e, h => by simp [buildSettlementAllocations] at h
  | item :: rest, e, h => by
    unfold buildSettlementAllocations at h
    split at h
    · cases h; exact buildSettlementAllocation_error_arithmetic ‹_›
    · split at h
      · cases h; exact buildSettlementAllocations_error_arithmetic ‹_›
      · cases h

/-- When `calculateSettlement` throws, it is an error of an operation on numbers (a division by zero or
the size limit, or the `RangeError` of the scale of the quantization policy), or the `TypeError` of
a negative total that the context gives. -/
theorem calculateSettlement_error_classified {context : SettlementReadContext}
    {request : SettlementRequest} {e : SettlementErr}
    (h : calculateSettlement context request = .error e) :
    e.Arithmetic ∨ e = .incompletePriorSettlementTotals ∨ e = .incompleteSettlementTotals := by
  obtain ⟨-, -, hprevious | ⟨previous, -, hloop | ⟨pending, -, ⟨code, hcode, rfl⟩ | ⟨-, hbuild⟩⟩⟩⟩ :=
    calculateSettlement_error_cases h
  · exact Or.inr (Or.inl (previousSettlementTotals_error hprevious).1)
  · rcases settlementAllocationLoop_error_cases hloop with h | h
    · exact Or.inl h
    · exact Or.inr (Or.inr h)
  · exact Or.inl (Or.inl ⟨code, settlementOverAllocated_error_plain hcode, rfl⟩)
  · exact Or.inl (buildSettlementAllocations_error_arithmetic hbuild)

/-- The measure an allocation adds to the paid totals throws a plain error. -/
theorem paidMeasure_error_plain {settlements : List Settlement} {item : SettlementAllocation}
    {code : NumErr} (h : paidMeasure settlements item = .error code) : code.Plain := by
  unfold paidMeasure at h
  split at h
  · cases h
  · split at h
    · cases h
    · exact proportionalShare_error_plain h

/-- One pass of the loop that builds the context throws a plain error. -/
theorem contextStep_error_plain {settlements : List Settlement} {totals : SettlementContextTotals}
    {item : SettlementAllocation} {code : NumErr}
    (h : contextStep settlements totals item = .error code) : code.Plain := by
  unfold contextStep at h
  dsimp only at h
  split at h
  · cases h; exact add_error_plain ‹_›
  · split at h
    · cases h; exact add_error_plain ‹_›
    · split at h
      · cases h; exact paidMeasure_error_plain ‹_›
      · split at h
        · cases h; exact add_error_plain ‹_›
        · split at h
          · cases h; exact add_error_plain ‹_›
          · cases h

/-- The loop that builds the context throws a plain error. -/
theorem contextTotals_error_plain {settlements : List Settlement} :
    ∀ {totals : SettlementContextTotals} {items : List SettlementAllocation} {code : NumErr},
      contextTotals settlements totals items = .error code → code.Plain
  | totals, [], code, h => by cases h
  | totals, item :: rest, code, h => by
    unfold contextTotals at h
    split at h
    · cases h; exact contextStep_error_plain ‹_›
    · exact contextTotals_error_plain h

/-- Building the context throws a plain error: a sum beyond the size limit, or a division by a
settlement denomination of zero. -/
theorem settlementReadContext_error_plain {state : AccountingCanonicalState} {code : NumErr}
    (h : settlementReadContext state = .error code) : code.Plain := by
  unfold settlementReadContext at h
  split at h
  · cases h; exact contextTotals_error_plain ‹_›
  · cases h

/-- When `applySettlement` throws, it is an error of an operation on numbers, or a `TypeError` of a
negative total. -/
theorem applySettlement_error_classified {state : AccountingCanonicalState}
    {request : SettlementRequest} {e : SettlementErr}
    (h : applySettlement state request = .error e) :
    e.Arithmetic ∨ e = .incompletePriorSettlementTotals ∨ e = .incompleteSettlementTotals := by
  unfold applySettlement at h
  split at h
  · rename_i code hcontext
    cases h
    exact Or.inl (Or.inl ⟨code, settlementReadContext_error_plain hcontext, rfl⟩)
  · exact calculateSettlement_error_classified h

/-- A pass of the loop throws the `TypeError` of a negative total exactly when the context's totals
for the open item are negative, and then it is the first thing it does. -/
theorem settlementAllocationStep_error_totals_iff {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} :
    settlementAllocationStep context request settlement pending allocation =
        .error .incompleteSettlementTotals ↔
      context.priorNegative allocation.openItemId = true := by
  constructor
  · intro h
    have h0 := h
    unfold settlementAllocationStep at h
    dsimp only at h
    split at h
    · rename_i hnegative
      simpa [SettlementReadContext.priorNegative] using hnegative
    · exfalso
      have hlater : ∀ e, settlementAllocationStep context request settlement pending allocation =
          .error e → e = .incompleteSettlementTotals → False := by
        intro e he hetotals
        subst hetotals
        unfold settlementAllocationStep at he
        dsimp only at he
        split at he
        · rename_i hneg; contradiction
        · split at he
          · cases he
          · split at he
            · cases he
            · split at he
              · rename_i hscope
                cases he
                obtain ⟨code, -, hcode⟩ := liftNum_eq_error.mp ‹_›
                cases hcode
              · cases he
              · split at he
                · rename_i e' hvalues
                  cases he
                  rcases allocationValues_error_arithmetic hvalues with ⟨code, -, h'⟩ | h' <;>
                    cases h'
                · split at he
                  · cases he
                    obtain ⟨code, -, hcode⟩ := liftNum_eq_error.mp ‹_›
                    cases hcode
                  · cases he
                  · split at he
                    · cases he
                      obtain ⟨code, -, hcode⟩ := liftNum_eq_error.mp ‹_›
                      cases hcode
                    · cases he
      exact hlater _ h0 rfl
  · intro hnegative
    unfold settlementAllocationStep
    simp only [SettlementReadContext.priorNegative] at hnegative
    simp [hnegative]

/-- The loop throws exactly when the allocations before one of them all went on, and that one throws. -/
theorem settlementAllocationLoop_error_iff {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} :
    ∀ {pending : SettlementPending} {items : List SettlementAllocationBody} {e : SettlementErr},
      settlementAllocationLoop context request settlement pending items = .error e ↔
        ∃ (before : List SettlementAllocationBody) (allocation : SettlementAllocationBody)
          (after : List SettlementAllocationBody) (pending' : SettlementPending),
          items = before ++ allocation :: after ∧
          settlementAllocationLoop context request settlement pending before = .ok (.next pending') ∧
          settlementAllocationStep context request settlement pending' allocation = .error e
  | pending, [], e => by simp [settlementAllocationLoop]
  | pending, allocation :: rest, e => by
    constructor
    · intro h
      unfold settlementAllocationLoop at h
      split at h
      · rename_i e' hstep
        injection h with h
        subst h
        exact ⟨[], allocation, rest, pending, rfl, rfl, hstep⟩
      · cases h
      · rename_i next hstep
        obtain ⟨before, allocation', after, pending', hsplit, hloop, herror⟩ :=
          (settlementAllocationLoop_error_iff (pending := next)).mp h
        exact ⟨allocation :: before, allocation', after, pending', by simp [hsplit],
          by simp [settlementAllocationLoop, hstep, hloop], herror⟩
    · rintro ⟨before, allocation', after, pending', hsplit, hloop, herror⟩
      cases before with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, rfl⟩ := hsplit
        simp only [settlementAllocationLoop, Except.ok.injEq, SettlementStep.next.injEq] at hloop
        subst hloop
        simp [settlementAllocationLoop, herror]
      | cons first before =>
        simp only [List.cons_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, hrest⟩ := hsplit
        unfold settlementAllocationLoop at hloop
        split at hloop
        · cases hloop
        · cases hloop
        · rename_i next hstep
          simp only [settlementAllocationLoop, hstep]
          exact (settlementAllocationLoop_error_iff (pending := next)).mpr
            ⟨before, allocation', after, pending', hrest, hloop, herror⟩

/-- The settlement that was recorded fails to be read exactly for `allocateExisting` with a settlement
of the context that matches the request's, with the hash of its own body, whose totals are negative. -/
theorem previousSettlementTotals_error_iff {context : SettlementReadContext}
    {settlement : Settlement} {existing : Bool} :
    previousSettlementTotals context settlement existing = .error .incompletePriorSettlementTotals ↔
      existing = true ∧
        ∃ retained, context.existingSettlement settlement.id = some retained ∧
          contentHashEquals retained.contentHash settlement.contentHash = true ∧
          validateAccountingEffectHash (.settlement retained) = .ok true ∧
          ((context.allocatedFromSettlement settlement.id).bookValue.isNegative = true ∨
            (context.allocatedFromSettlement settlement.id).quantity.isNegative = true) := by
  constructor
  · intro h
    obtain ⟨-, hexisting, hrest⟩ := previousSettlementTotals_error h
    exact ⟨hexisting, hrest⟩
  · rintro ⟨hexisting, retained, hretained, hhash, hvalid, hnegative⟩
    unfold previousSettlementTotals
    simp [hexisting, hretained, hhash, hvalid]
    rcases hnegative with h | h <;> simp [h]

/-- The `TypeError` of a negative total of the settlement that was recorded is thrown exactly when the
operation and application time and the identity and amounts are accepted, and the settlement that was
recorded is of `allocateExisting`, matches, and has negative totals. -/
theorem calculateSettlement_incompletePrior_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .error .incompletePriorSettlementTotals ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        previousSettlementTotals context request.hashedSettlement request.existing =
          .error .incompletePriorSettlementTotals := by
  constructor
  · intro h
    obtain ⟨h1, h2, hprevious | ⟨previous, -, hloop | ⟨pending, -, ⟨code, hcode, hcode'⟩ | ⟨-, hbuild⟩⟩⟩⟩ :=
      calculateSettlement_error_cases h
    · exact ⟨h1, h2, hprevious⟩
    · rcases settlementAllocationLoop_error_cases hloop with (⟨code, -, h'⟩ | h') | h' <;>
        cases h'
    · cases hcode'
    · rcases buildSettlementAllocations_error_arithmetic hbuild with ⟨code, -, h'⟩ | h' <;> cases h'
  · rintro ⟨h1, h2, hprevious⟩
    unfold calculateSettlement
    simp [h1, h2, hprevious]

/-- The `TypeError` of a negative total of an open item is thrown exactly when the tests before have
passed, the allocations before one of them have gone on, and the context's totals for that one's open
item are negative. -/
theorem calculateSettlement_incompleteTotals_iff (context : SettlementReadContext)
    (request : SettlementRequest) :
    calculateSettlement context request = .error .incompleteSettlementTotals ↔
      settlementApplicationIncoherent request = false ∧
        settlementIdentityInvalid context request = false ∧
        ∃ (previous : AllocatedTotal) (before : List SettlementAllocationBody)
          (allocation : SettlementAllocationBody) (after : List SettlementAllocationBody)
          (pending : SettlementPending),
          previousSettlementTotals context request.hashedSettlement request.existing =
            .ok (.totals previous) ∧
          request.allocations = before ++ allocation :: after ∧
          settlementAllocationLoop context request request.hashedSettlement
            ⟨[], [], previous.quantity⟩ before = .ok (.next pending) ∧
          context.priorNegative allocation.openItemId = true := by
  constructor
  · intro h
    obtain ⟨h1, h2, hprevious | ⟨previous, hprevious, hloop | ⟨pending, hloop, ⟨code, hcode, hcode'⟩ | ⟨-, hbuild⟩⟩⟩⟩ :=
      calculateSettlement_error_cases h
    · have := (previousSettlementTotals_error hprevious).1
      cases this
    · obtain ⟨before, allocation, after, pending, hsplit, hbefore, hstep⟩ :=
        settlementAllocationLoop_error_iff.mp hloop
      exact ⟨h1, h2, previous, before, allocation, after, pending, hprevious, hsplit, hbefore,
        settlementAllocationStep_error_totals_iff.mp hstep⟩
    · cases hcode'
    · rcases buildSettlementAllocations_error_arithmetic hbuild with ⟨code, -, h'⟩ | h' <;> cases h'
  · rintro ⟨h1, h2, previous, before, allocation, after, pending, hprevious, hsplit, hbefore,
      hnegative⟩
    unfold calculateSettlement
    have hloop : settlementAllocationLoop context request request.hashedSettlement
        ⟨[], [], previous.quantity⟩ request.allocations = .error .incompleteSettlementTotals :=
      settlementAllocationLoop_error_iff.mpr ⟨before, allocation, after, pending, hsplit, hbefore,
        settlementAllocationStep_error_totals_iff.mpr hnegative⟩
    simp [h1, h2, hprevious, hloop]

/-! ### What remains of an open item -/

/-- What remains of an open item's book value: its magnitude less what was allocated to it. The kernel
keeps no field for it: an open item is closed when nothing remains. -/
def openItemRemaining (item : OpenItem) (allocated : ℚ) : ℚ := |item.bookValue.toRat| - allocated

/-- What remains of every open item an accepted request allocates to is never negative and is exactly
what remained less what the request allocates to it. -/
theorem calculateSettlement_open_item_remaining {context : SettlementReadContext}
    {request : SettlementRequest} {draft : AccountingDraft} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .ok (.draft draft)) :
    ∀ id, (∃ allocation ∈ allocationEffects draft.effects, allocation.openItemId = id) →
      ∃ item : OpenItem, context.openItem id = some item ∧
        0 ≤ openItemRemaining item ((context.allocatedToOpenItem id).bookValue.toRat +
          sumOver (·.openItemId) (·.allocatedBookValue.toRat) id (allocationEffects draft.effects)) ∧
        openItemRemaining item ((context.allocatedToOpenItem id).bookValue.toRat +
            sumOver (·.openItemId) (·.allocatedBookValue.toRat) id
              (allocationEffects draft.effects)) =
          openItemRemaining item (context.allocatedToOpenItem id).bookValue.toRat -
            sumOver (·.openItemId) (·.allocatedBookValue.toRat) id
              (allocationEffects draft.effects) := by
  intro id hid
  obtain ⟨item, hitem, hbook, -⟩ := calculateSettlement_open_bound hcontext hrequest h id hid
  refine ⟨item, hitem, ?_, ?_⟩
  · unfold openItemRemaining
    linarith
  · unfold openItemRemaining
    ring

/-! ### For constructible values, only the size limit -/

/-- Adding two constructible values throws only for size. -/
theorem add_error_limit {a b : ExactRational} {code : NumErr} (ha : a.WF) (hb : b.WF)
    (h : a.add b = .error code) : code = .representationLimitExceeded := by
  rcases ExactRational.add_ok_or_limit ha hb with ⟨c, hc⟩ | hlimit
  · rw [hc] at h; cases h
  · rw [hlimit] at h; cases h; rfl

/-- Subtracting two constructible values throws only for size. -/
theorem subtract_error_limit {a b : ExactRational} {code : NumErr} (ha : a.WF) (hb : b.WF)
    (h : a.subtract b = .error code) : code = .representationLimitExceeded := by
  rcases ExactRational.subtract_ok_or_limit ha hb with ⟨c, hc⟩ | hlimit
  · rw [hc] at h; cases h
  · rw [hlimit] at h; cases h; rfl

/-- The share of a book value throws only for size when the denomination is not zero. -/
theorem proportionalShare_error_limit {bookValue denomination quantity : ExactRational}
    {code : NumErr} (hbookValue : bookValue.WF) (hdenomination : denomination.WF)
    (hquantity : quantity.WF) (hnonzero : denomination.toRat ≠ 0)
    (h : proportionalShare bookValue denomination quantity = .error code) :
    code = .representationLimitExceeded := by
  unfold proportionalShare at h
  split at h
  · rename_i c hmultiply
    cases h
    rcases ExactRational.multiply_ok_or_limit (ExactRational.abs_wf hbookValue) hquantity with
      ⟨r, hr⟩ | hlimit
    · rw [hr] at hmultiply; cases hmultiply
    · rw [hlimit] at hmultiply; cases hmultiply; rfl
  · rename_i product hmultiply
    obtain ⟨hproductWF, -⟩ :=
      ExactRational.multiply_ok (ExactRational.abs_wf hbookValue) hquantity hmultiply
    rcases ExactRational.divide_ok_or_error (b := denomination.abs) hproductWF with
      ⟨r, hr⟩ | ⟨hzero, -⟩ | ⟨-, hlimit⟩
    · rw [hr] at h; cases h
    · exfalso
      have hzero' : denomination.abs.isZero = true := by simp [ExactRational.isZero, hzero]
      have := (ExactRational.isZero_iff (ExactRational.abs_wf hdenomination)).mp hzero'
      rw [ExactRational.abs_toRat hdenomination] at this
      exact hnonzero (abs_eq_zero.mp this)
    · rw [hlimit] at h; cases h; rfl

/-- A sum of nonnegative terms is not negative. -/
theorem sumOver_nonneg {α κ : Type} [DecidableEq κ] {key : α → κ} {value : α → ℚ} {id : κ}
    {items : List α} (h : ∀ item ∈ items, key item = id → 0 ≤ value item) :
    0 ≤ sumOver key value id items := by
  unfold sumOver
  apply List.sum_nonneg
  intro x hx
  obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hx
  split_ifs with hkey
  · exact h item hitem hkey
  · exact le_refl 0

/-- The three sums of line 1238 throw only for size, for constructible values. -/
theorem allocationCapacityExceeded_error_limit {settlement : Settlement}
    {allocation : SettlementAllocationBody} {item : OpenItem} {prior : AllocatedTotal}
    {pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational} {code : NumErr}
    (hallocation : allocation.WF) (hprior : prior.WF) (hbook : pendingBookValue.WF)
    (hquantity : pendingQuantity.WF) (hsettled : pendingSettlementQuantity.WF)
    (h : allocationCapacityExceeded settlement allocation item prior pendingBookValue
      pendingQuantity pendingSettlementQuantity = .error code) :
    code = .representationLimitExceeded := by
  unfold allocationCapacityExceeded at h
  split at h
  · cases h; exact add_error_limit hprior.bookValue hbook ‹_›
  · rename_i s1 hs1
    obtain ⟨hs1wf, -⟩ := ExactRational.add_ok hprior.bookValue hbook hs1
    split at h
    · cases h; exact add_error_limit hs1wf hallocation.allocatedBookValue ‹_›
    · split at h
      · cases h
      · split at h
        · cases h; exact add_error_limit hprior.quantity hquantity ‹_›
        · rename_i t1 ht1
          obtain ⟨ht1wf, -⟩ := ExactRational.add_ok hprior.quantity hquantity ht1
          split at h
          · cases h; exact add_error_limit ht1wf hallocation.allocatedOpenQuantity ‹_›
          · split at h
            · cases h
            · split at h
              · cases h
                exact add_error_limit hsettled hallocation.allocatedSettlementQuantity ‹_›
              · cases h

/-- The test of line 1238 throws only for size, for constructible values. -/
theorem allocationScopeViolated_error_limit {settlement : Settlement}
    {allocation : SettlementAllocationBody} {item : OpenItem} {prior : AllocatedTotal}
    {pendingBookValue pendingQuantity pendingSettlementQuantity : ExactRational} {code : NumErr}
    (hallocation : allocation.WF) (hprior : prior.WF) (hbook : pendingBookValue.WF)
    (hquantity : pendingQuantity.WF) (hsettled : pendingSettlementQuantity.WF)
    (h : allocationScopeViolated settlement allocation item prior pendingBookValue
      pendingQuantity pendingSettlementQuantity = .error code) :
    code = .representationLimitExceeded := by
  unfold allocationScopeViolated at h
  split at h
  · cases h
  · exact allocationCapacityExceeded_error_limit hallocation hprior hbook hquantity hsettled h

/-- The coherence of the path throws only for size, for constructible values. -/
theorem pathCoherent_error_limit {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody} {settlementBookValue : ExactRational}
    {code : NumErr} (hallocation : allocation.WF)
    (h : pathCoherent request settlement item allocation allocation.allocatedSettlementQuantity
      settlementBookValue = .error code) : code = .representationLimitExceeded := by
  unfold pathCoherent at h
  split at h
  · cases h
  · split at h
    · rename_i path policy hpathEq hpolicyEq
      split at h
      · split at h
        · rename_i c hmultiply
          cases h
          rcases ExactRational.multiply_ok_or_limit hallocation.allocatedSettlementQuantity
              (hallocation.valuationPath path hpathEq).rate with ⟨r, hr⟩ | hlimit
          · rw [hr] at hmultiply; cases hmultiply
          · rw [hlimit] at hmultiply; cases hmultiply; rfl
        · cases h
      · cases h
    · cases h

/-- Rounding a constructible value throws the `RangeError` of the scale or a size error. -/
theorem quantize_error_limit {value : ExactRational} {rule : QuantizationRule} {e : QuantizeErr}
    (hvalue : value.WF) (h : quantize value rule = .error e) :
    e = .scaleOutOfRange ∨ e = .exactNumber .representationLimitExceeded := by
  by_cases hscale : rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale
  · left
    unfold quantize at h
    simp only [hscale, ↓reduceIte] at h
    cases h
    rfl
  · right
    have h0 : 0 ≤ rule.targetScale := by simp only [not_or, not_lt] at hscale; exact hscale.1
    have h1 : rule.targetScale ≤ maxDecimalScale := by
      simp only [not_or, not_lt, gt_iff_lt] at hscale; exact hscale.2
    exact quantize_error hvalue h0 h1 h

/-- The expected measurement of a constructible value throws only for scale or size. -/
theorem expectedSettlementMeasurement_error_limit {policy : Option QuantizationPolicy}
    {value : ExactRational} {error : QuantizeErr} (hvalue : value.WF)
    (h : expectedSettlementMeasurement policy value = .error error) :
    error = .scaleOutOfRange ∨ error = .exactNumber .representationLimitExceeded := by
  cases policy with
  | none => simp [expectedSettlementMeasurement] at h
  | some policy =>
    simp only [expectedSettlementMeasurement] at h
    split at h
    · cases h; exact quantize_error_limit hvalue ‹_›
    · cases h

/-- The expected difference of a constructible value throws only for scale or size. -/
theorem expectedRealizedDifference_error_limit {policy : Option QuantizationPolicy}
    {difference : ExactRational} {error : QuantizeErr} (hdifference : difference.WF)
    (h : expectedRealizedDifference policy difference = .error error) :
    error = .scaleOutOfRange ∨ error = .exactNumber .representationLimitExceeded := by
  cases policy with
  | none => simp [expectedRealizedDifference] at h
  | some policy =>
    simp only [expectedRealizedDifference] at h
    split at h
    · cases h
    · split at h
      · cases h; exact quantize_error_limit hdifference ‹_›
      · cases h

/-- The errors of an operation on constructible numbers: the `RangeError` of the scale, or the size
limit. -/
def SettlementErr.Limit (e : SettlementErr) : Prop :=
  e = .scaleOutOfRange ∨ e = .exactNumber .representationLimitExceeded

/-- A lifted size error is a limit error. -/
theorem liftNum_error_limit {α : Type} {result : Except NumErr α} {e : SettlementErr}
    (h : liftNum result = .error e)
    (hlimit : ∀ code, result = .error code → code = .representationLimitExceeded) : e.Limit := by
  obtain ⟨code, hcode, rfl⟩ := liftNum_eq_error.mp h
  exact Or.inr (by rw [hlimit code hcode])

/-- A lifted rounding error is a limit error. -/
theorem liftQuantize_error_limit {α : Type} {result : Except QuantizeErr α} {e : SettlementErr}
    (h : liftQuantize result = .error e)
    (hlimit : ∀ error, result = .error error →
      error = .scaleOutOfRange ∨ error = .exactNumber .representationLimitExceeded) : e.Limit := by
  obtain ⟨error, herror, rfl⟩ := liftQuantize_eq_error.mp h
  rcases hlimit error herror with rfl | rfl
  · exact Or.inl rfl
  · exact Or.inr rfl

/-- The values of an allocation throw only the `RangeError` of the scale or a size error, for
constructible values and denominations that are not zero. -/
theorem allocationValues_error_limit {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody} {e : SettlementErr}
    (hsettlement : settlement.WF) (hitem : item.WF) (hallocation : allocation.WF)
    (hsettlementDenomination : settlement.denomination.toRat ≠ 0)
    (hitemDenomination : item.denomination.toRat ≠ 0)
    (h : allocationValues request settlement item allocation = .error e) : e.Limit := by
  unfold allocationValues at h
  dsimp only at h
  split at h
  · cases h
    exact liftNum_error_limit ‹_› fun code hcode => proportionalShare_error_limit
      hsettlement.bookValue hsettlement.denomination hallocation.allocatedSettlementQuantity
      hsettlementDenomination hcode
  · rename_i settlementShare hshare
    obtain ⟨hshareWF, -, -⟩ := proportionalShare_ok hsettlement.bookValue hsettlement.denomination
      hallocation.allocatedSettlementQuantity (liftNum_eq_ok.mp hshare)
    have hsbv : (allocation.allocatedSettlementBookValue.getD settlementShare).WF := by
      cases hv : allocation.allocatedSettlementBookValue with
      | none => exact hshareWF
      | some value => exact hallocation.allocatedSettlementBookValue value hv
    split at h
    · cases h
      exact liftNum_error_limit ‹_› fun code hcode => proportionalShare_error_limit
        hitem.bookValue hitem.denomination hallocation.allocatedOpenQuantity hitemDenomination hcode
    · split at h
      · cases h
        exact liftNum_error_limit ‹_› fun code hcode => subtract_error_limit hsbv
          (openItemBookValue_wf hallocation) hcode
      · rename_i difference hdifference
        obtain ⟨hdifferenceWF, -⟩ := ExactRational.subtract_ok hsbv (openItemBookValue_wf hallocation)
          (liftNum_eq_ok.mp hdifference)
        split at h
        · cases h
          exact liftNum_error_limit ‹_› fun code hcode => pathCoherent_error_limit hallocation hcode
        · split at h
          · cases h
            exact liftQuantize_error_limit ‹_› fun error herror =>
              expectedSettlementMeasurement_error_limit hsbv herror
          · split at h
            · cases h
              exact liftQuantize_error_limit ‹_› fun error herror =>
                expectedRealizedDifference_error_limit hdifferenceWF herror
            · cases h

/-- Comparing two constructible quantizations never throws. -/
theorem quantizationMatches_ne_error {actual expected : Option QuantizedValue} {code : NumErr}
    (hactual : ∀ m, actual = some m → m.WF) (hexpected : ∀ m, expected = some m → m.WF) :
    quantizationMatches actual expected ≠ .error code := by
  intro h
  cases actual with
  | none => simp [quantizationMatches] at h
  | some a =>
    cases expected with
    | none => simp [quantizationMatches] at h
    | some e =>
      simp only [quantizationMatches] at h
      split at h
      · rename_i c hc
        exact ExactDecimal.toRational_ne_error (hactual a rfl).amount c hc
      · split at h
        · rename_i c hc
          exact ExactDecimal.toRational_ne_error (hexpected e rfl).amount c hc
        · cases h

/-- The update of the working values throws only for size, for constructible working values. -/
theorem pendingUpdate_error_limit {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {done : List SettlementAllocationBody}
    {previousQuantity : ℚ} {code : NumErr} (hallocation : allocation.WF)
    (hpending : PendingSpec pending done previousQuantity)
    (h : pendingUpdate pending allocation = .error code) : code = .representationLimitExceeded := by
  unfold pendingUpdate at h
  dsimp only at h
  split at h
  · cases h
    exact add_error_limit (hpending.book allocation.openItemId).1 (openItemBookValue_wf hallocation)
      ‹_›
  · split at h
    · cases h
      exact add_error_limit (hpending.openQuantity allocation.openItemId).1
        hallocation.allocatedOpenQuantity ‹_›
    · split at h
      · cases h
        exact add_error_limit hpending.settlementQuantity.1 hallocation.allocatedSettlementQuantity ‹_›
      · cases h

/-- The expected measurement of a constructible value is constructible. -/
theorem expectedSettlementMeasurement_wf {policy : Option QuantizationPolicy}
    {value : ExactRational} {expected : Option QuantizedValue} (hvalue : value.WF)
    (h : expectedSettlementMeasurement policy value = .ok expected) :
    ∀ m, expected = some m → m.WF := by
  cases policy with
  | none =>
    rw [expectedSettlementMeasurement_none] at h
    have := Except.ok.inj h
    intro m hm; rw [← this] at hm; cases hm
  | some policy =>
    obtain ⟨measurement, hexpected, hquantize⟩ := expectedSettlementMeasurement_some h
    intro m hm
    rw [hexpected] at hm
    cases hm
    obtain ⟨hamount, hresidual, -⟩ := quantize_ok hvalue hquantize
    exact ⟨hamount, hresidual⟩

/-- The expected difference of a constructible difference is constructible. -/
theorem expectedRealizedDifference_wf {policy : Option QuantizationPolicy}
    {difference : ExactRational} {expected : Option QuantizedValue} (hdifference : difference.WF)
    (h : expectedRealizedDifference policy difference = .ok expected) :
    ∀ m, expected = some m → m.WF := by
  by_cases hzero : difference.isZero = true
  · rw [expectedRealizedDifference_zero policy hzero] at h
    have := Except.ok.inj h
    intro m hm; rw [← this] at hm; cases hm
  · have hnonzero : difference.isZero = false := by simpa using hzero
    cases policy with
    | none =>
      rw [expectedRealizedDifference_none] at h
      have := Except.ok.inj h
      intro m hm; rw [← this] at hm; cases hm
    | some policy =>
      obtain ⟨realized, hexpected, hquantize⟩ := expectedRealizedDifference_some hnonzero h
      intro m hm
      rw [hexpected] at hm
      cases hm
      obtain ⟨hamount, hresidual, -⟩ := quantize_ok hdifference hquantize
      exact ⟨hamount, hresidual⟩

/-- The values of an allocation, when they are computed from constructible values, are
constructible. -/
theorem allocationValues_ok_wf {request : SettlementRequest} {settlement : Settlement}
    {item : OpenItem} {allocation : SettlementAllocationBody} {values : AllocationValues}
    (hsettlement : settlement.WF) (hallocation : allocation.WF)
    (h : allocationValues request settlement item allocation = .ok values) :
    values.settlementBookValue.WF ∧ values.difference.WF ∧
      (∀ m, values.expectedMeasurement = some m → m.WF) ∧
      (∀ m, values.expectedRealized = some m → m.WF) := by
  obtain ⟨hshare, hsbv, -, hdifference, -, hmeasurement, hrealized⟩ := allocationValues_ok h
  obtain ⟨hshareWF, -, -⟩ := proportionalShare_ok hsettlement.bookValue hsettlement.denomination
    hallocation.allocatedSettlementQuantity hshare
  have hsbvWF : values.settlementBookValue.WF := by
    rw [hsbv]
    cases hv : allocation.allocatedSettlementBookValue with
    | none => exact hshareWF
    | some value => exact hallocation.allocatedSettlementBookValue value hv
  obtain ⟨hdifferenceWF, -⟩ :=
    ExactRational.subtract_ok hsbvWF (openItemBookValue_wf hallocation) hdifference
  exact ⟨hsbvWF, hdifferenceWF, expectedSettlementMeasurement_wf hsbvWF hmeasurement,
    expectedRealizedDifference_wf hdifferenceWF hrealized⟩

/-- The test of line 1254 never throws, for constructible values. -/
theorem allocationValuesRejected_ne_error {request : SettlementRequest}
    {allocation : SettlementAllocationBody} {values : AllocationValues} {code : NumErr}
    (hallocation : allocation.WF) (hmeasurement : ∀ m, values.expectedMeasurement = some m → m.WF)
    (hrealized : ∀ m, values.expectedRealized = some m → m.WF) :
    allocationValuesRejected request allocation values ≠ .error code := by
  intro h
  unfold allocationValuesRejected at h
  split at h
  · cases h
  · split at h
    · cases h
      exact quantizationMatches_ne_error hallocation.settlementMeasurement hmeasurement ‹_›
    · cases h
    · split at h
      · cases h
        exact quantizationMatches_ne_error hallocation.realizedExchangeDifference hrealized ‹_›
      · cases h
      · cases h

/-- One pass of the loop throws only the `RangeError` of the scale, a size error, or the `TypeError` of
a negative total, for constructible values: the divisors are not zero, because the settlement's
denomination is not, and the open item's is at least what is allocated to it. -/
theorem settlementAllocationStep_error_limit {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {pending : SettlementPending}
    {allocation : SettlementAllocationBody} {done : List SettlementAllocationBody}
    {previousQuantity : ℚ} {e : SettlementErr} (hcontext : context.WF) (hsettlement : settlement.WF)
    (hallocation : allocation.WF) (hsettlementDenomination : settlement.denomination.toRat ≠ 0)
    (hpending : PendingSpec pending done previousQuantity)
    (hdone : ∀ a ∈ done, 0 < a.allocatedOpenQuantity.toRat)
    (h : settlementAllocationStep context request settlement pending allocation = .error e) :
    e.Limit ∨ e = .incompleteSettlementTotals := by
  unfold settlementAllocationStep at h
  dsimp only at h
  split at h
  · cases h; exact Or.inr rfl
  rename_i hnegative
  split at h
  · cases h
  split at h
  · cases h
  rename_i item hitem
  have hprior := hcontext.allocatedToOpenItem allocation.openItemId
  have hitemWF : item.WF := hcontext.openItem _ item hitem
  split at h
  · cases h
    exact Or.inl (liftNum_error_limit ‹_› fun code hcode =>
      allocationScopeViolated_error_limit hallocation hprior (hpending.book _).1
        (hpending.openQuantity _).1 hpending.settlementQuantity.1 hcode)
  · cases h
  · rename_i hscope
    split at h
    · rename_i e' hvalues
      cases h
      obtain ⟨hclauses, hcapacity⟩ := allocationScopeViolated_eq_false (liftNum_eq_ok.mp hscope)
      obtain ⟨-, hquantityCap, -⟩ := allocationCapacityExceeded_eq_false hsettlement hitemWF
        hallocation hprior (hpending.book _).1 (hpending.openQuantity _).1
        hpending.settlementQuantity.1 hcapacity
      obtain ⟨-, -, -, -, -, -, hopenPos, -, -⟩ :=
        (allocationScopeClauses_eq_false_iff _ _ _).mp hclauses
      have hopenPos' := (positive_iff hallocation.allocatedOpenQuantity).mp hopenPos
      have hpriorNonneg : 0 ≤ (context.allocatedToOpenItem allocation.openItemId).quantity.toRat :=
        not_lt.mp ((ExactRational.isNegative_iff hprior.quantity).not.mp
          (by intro hb; exact hnegative (by simp [hb])))
      have hpendingNonneg : 0 ≤ ((settlementMapGet pending.openQuantity
          allocation.openItemId).getD ExactRational.zero).toRat := by
        rw [(hpending.openQuantity _).2]
        exact sumOver_nonneg fun a ha _ => (hdone a ha).le
      have hdenominator : item.denomination.toRat ≠ 0 := by
        intro hzero
        rw [hzero, abs_zero] at hquantityCap
        linarith
      exact Or.inl (allocationValues_error_limit hsettlement hitemWF hallocation
        hsettlementDenomination hdenominator hvalues)
    · rename_i values hvalues
      obtain ⟨-, -, hmeasurement, hrealized⟩ := allocationValues_ok_wf hsettlement hallocation hvalues
      split at h
      · rename_i e' hrejected
        obtain ⟨code, hcode, -⟩ := liftNum_eq_error.mp hrejected
        exact absurd hcode (allocationValuesRejected_ne_error hallocation hmeasurement hrealized)
      · cases h
      · split at h
        · cases h
          exact Or.inl (liftNum_error_limit ‹_› fun code hcode =>
            pendingUpdate_error_limit hallocation hpending hcode)
        · cases h

/-- The loop throws only the `RangeError` of the scale, a size error, or the `TypeError` of a negative
total, for constructible values. -/
theorem settlementAllocationLoop_error_limit {context : SettlementReadContext}
    {request : SettlementRequest} {settlement : Settlement} {previousQuantity : ℚ}
    (hcontext : context.WF) (hsettlement : settlement.WF)
    (hsettlementDenomination : settlement.denomination.toRat ≠ 0) :
    ∀ {items : List SettlementAllocationBody} {done : List SettlementAllocationBody}
      {pending : SettlementPending} {e : SettlementErr},
      (∀ allocation ∈ items, allocation.WF) →
      LoopInvariant context request settlement previousQuantity done pending →
      settlementAllocationLoop context request settlement pending items = .error e →
      e.Limit ∨ e = .incompleteSettlementTotals
  | [], done, pending, e, _, _, h => by simp [settlementAllocationLoop] at h
  | allocation :: rest, done, pending, e, hwf, hinvariant, h => by
    unfold settlementAllocationLoop at h
    split at h
    · rename_i e' hstep
      cases h
      have hdone : ∀ a ∈ done, 0 < a.allocatedOpenQuantity.toRat := fun a ha => by
        obtain ⟨item, values, hfacts⟩ := hinvariant.facts a ha
        exact hfacts.openQuantityPositive
      exact settlementAllocationStep_error_limit hcontext hsettlement (hwf allocation (by simp))
        hsettlementDenomination hinvariant.pending hdone hstep
    · cases h
    · rename_i next hstep
      exact settlementAllocationLoop_error_limit hcontext hsettlement hsettlementDenomination
        (fun a ha => hwf a (List.mem_cons_of_mem _ ha))
        (loopInvariant_step hcontext hsettlement (hwf allocation (by simp)) hinvariant hstep) h

/-- The settlement's book value that an allocation carries throws only for size. -/
theorem settledBookValue_error_limit {settlement : Settlement} {item : SettlementAllocationBody}
    {code : NumErr} (hsettlement : settlement.WF) (hitem : item.WF)
    (hdenomination : settlement.denomination.toRat ≠ 0)
    (h : settledBookValue settlement item = .error code) : code = .representationLimitExceeded := by
  unfold settledBookValue at h
  split at h
  · cases h
  · exact proportionalShare_error_limit hsettlement.bookValue hsettlement.denomination
      hitem.allocatedSettlementQuantity hdenomination h

/-- Reading the settlement's book value from every allocation throws only for size. -/
theorem settledBookValues_error_limit {settlement : Settlement} (hsettlement : settlement.WF)
    (hdenomination : settlement.denomination.toRat ≠ 0) :
    ∀ {items : List SettlementAllocationBody} {code : NumErr},
      (∀ item ∈ items, item.WF) → settledBookValues settlement items = .error code →
      code = .representationLimitExceeded
  | [], code, _, h => by simp [settledBookValues] at h
  | item :: rest, code, hwf, h => by
    unfold settledBookValues at h
    split at h
    · cases h
      exact settledBookValue_error_limit hsettlement (hwf item (by simp)) hdenomination ‹_›
    · split at h
      · cases h
        exact settledBookValues_error_limit hsettlement hdenomination
          (fun a ha => hwf a (List.mem_cons_of_mem _ ha)) ‹_›
      · cases h

/-- The over-allocation test throws only for size, for constructible values. -/
theorem settlementOverAllocated_error_limit {settlement : Settlement} {previous : AllocatedTotal}
    {items : List SettlementAllocationBody} {code : NumErr} (hsettlement : settlement.WF)
    (hprevious : previous.WF) (hdenomination : settlement.denomination.toRat ≠ 0)
    (hitems : ∀ item ∈ items, item.WF)
    (h : settlementOverAllocated settlement previous items = .error code) :
    code = .representationLimitExceeded := by
  unfold settlementOverAllocated at h
  split at h
  · cases h
    exact settledBookValues_error_limit hsettlement hdenomination hitems ‹_›
  · rename_i values hvalues
    have hforall := settledBookValues_forall₂ hvalues
    have hwf : ∀ value ∈ values, value.WF := by
      intro value hvalue
      obtain ⟨item, hitem, hread⟩ := forall₂_mem_right hforall value hvalue
      exact settledBookValue_wf hsettlement (hitems item hitem) hread
    split at h
    · cases h
      exact addExactValues_error ExactRational.zero_wf hwf ‹_›
    · rename_i total htotal
      obtain ⟨htotalWF, -⟩ := addExactValues_ok ExactRational.zero_wf hwf htotal
      split at h
      · cases h
        exact add_error_limit hprevious.bookValue htotalWF ‹_›
      · cases h

/-- Building an allocation throws only the `RangeError` of the scale or a size error, for
constructible values. -/
theorem buildSettlementAllocation_error_limit {request : SettlementRequest}
    {settlement : Settlement} {item : SettlementAllocationBody} {e : SettlementErr}
    (hsettlement : settlement.WF) (hitem : item.WF)
    (hdenomination : settlement.denomination.toRat ≠ 0)
    (h : buildSettlementAllocation request settlement item = .error e) : e.Limit := by
  unfold buildSettlementAllocation at h
  dsimp only at h
  split at h
  · cases h
    exact liftNum_error_limit ‹_› fun code hcode =>
      settledBookValue_error_limit hsettlement hitem hdenomination hcode
  · rename_i settled hsettled
    have hsettledWF := settledBookValue_wf hsettlement hitem (liftNum_eq_ok.mp hsettled)
    split at h
    · cases h
      exact liftNum_error_limit ‹_› fun code hcode =>
        subtract_error_limit hsettledWF (openItemBookValue_wf hitem) hcode
    · rename_i difference hdifference
      obtain ⟨hdifferenceWF, -⟩ := ExactRational.subtract_ok hsettledWF
        (openItemBookValue_wf hitem) (liftNum_eq_ok.mp hdifference)
      split at h
      · cases h
        exact liftQuantize_error_limit ‹_› fun error herror =>
          expectedSettlementMeasurement_error_limit hsettledWF herror
      · split at h
        · cases h
          exact liftQuantize_error_limit ‹_› fun error herror =>
            expectedRealizedDifference_error_limit hdifferenceWF herror
        · cases h

/-- Building the allocations throws only the `RangeError` of the scale or a size error, for
constructible values. -/
theorem buildSettlementAllocations_error_limit {request : SettlementRequest}
    {settlement : Settlement} (hsettlement : settlement.WF)
    (hdenomination : settlement.denomination.toRat ≠ 0) :
    ∀ {items : List SettlementAllocationBody} {e : SettlementErr},
      (∀ item ∈ items, item.WF) → buildSettlementAllocations request settlement items = .error e →
      e.Limit
  | [], e, _, h => by simp [buildSettlementAllocations] at h
  | item :: rest, e, hwf, h => by
    unfold buildSettlementAllocations at h
    split at h
    · cases h
      exact buildSettlementAllocation_error_limit hsettlement (hwf item (by simp)) hdenomination ‹_›
    · split at h
      · cases h
        exact buildSettlementAllocations_error_limit hsettlement hdenomination
          (fun a ha => hwf a (List.mem_cons_of_mem _ ha)) ‹_›
      · cases h

/-- The totals already allocated from the settlement, when they are read, are constructible. -/
theorem previousSettlementTotals_wf {context : SettlementReadContext} {settlement : Settlement}
    {existing : Bool} {previous : AllocatedTotal} (hcontext : context.WF)
    (h : previousSettlementTotals context settlement existing = .ok (.totals previous)) :
    previous.WF := by
  obtain ⟨hprevious, -⟩ := previousSettlementTotals_totals h
  rw [hprevious]
  split
  · exact hcontext.allocatedFromSettlement _
  · exact AllocatedTotal.zero_wf

/-- When `calculateSettlement` throws, for a constructible context and request, it is the size limit,
the `RangeError` of the scale of the quantization policy, or the `TypeError` of a negative total that
the context gives: a negative total of the settlement that was recorded, or of an open item. -/
theorem calculateSettlement_error_limit {context : SettlementReadContext}
    {request : SettlementRequest} {e : SettlementErr} (hcontext : context.WF)
    (hrequest : request.WF) (h : calculateSettlement context request = .error e) :
    e = .exactNumber .representationLimitExceeded ∨ e = .scaleOutOfRange ∨
      e = .incompletePriorSettlementTotals ∨ e = .incompleteSettlementTotals := by
  obtain ⟨_, hinvalid, hrest⟩ := calculateSettlement_error_cases h
  have hsettlement : request.hashedSettlement.WF := hrequest.settlement
  have hdenomination : request.hashedSettlement.denomination.toRat ≠ 0 := by
    obtain ⟨-, -, -, -, -, -, -, hden, -, -⟩ :=
      (settlementIdentityInvalid_eq_false_iff _ _).mp hinvalid
    exact (positive_abs_iff hrequest.settlement.denomination).mp hden
  rcases hrest with hprevious | ⟨previous, hprevious,
    hloop | ⟨pending, hloop, ⟨code, hcode, rfl⟩ | ⟨hover, hbuild⟩⟩⟩
  · exact Or.inr (Or.inr (Or.inl (previousSettlementTotals_error hprevious).1))
  · have hprevious' := previousSettlementTotals_wf hcontext hprevious
    rcases settlementAllocationLoop_error_limit hcontext hsettlement hdenomination
      hrequest.allocations (loopInvariant_initial (context := context) (request := request)
        (settlement := request.hashedSettlement) hprevious') hloop with (h' | h') | h'
    · exact Or.inr (Or.inl h')
    · exact Or.inl h'
    · exact Or.inr (Or.inr (Or.inr h'))
  · have hprevious' := previousSettlementTotals_wf hcontext hprevious
    exact Or.inl (by rw [settlementOverAllocated_error_limit hsettlement hprevious' hdenomination
      hrequest.allocations hcode])
  · rcases buildSettlementAllocations_error_limit hsettlement hdenomination hrequest.allocations
      hbuild with h' | h'
    · exact Or.inr (Or.inl h')
    · exact Or.inl h'

/-- One pass of the loop that builds the context throws only for size, or for a division by the
denomination of a settlement of the state that is zero. -/
theorem contextStep_error_limit {settlements : List Settlement} {totals : SettlementContextTotals}
    {item : SettlementAllocation} {done : List SettlementAllocation} {code : NumErr}
    (hsettlements : ∀ settlement ∈ settlements, settlement.WF) (hitem : item.WF)
    (hspec : TotalsSpec settlements totals done)
    (h : contextStep settlements totals item = .error code) :
    code = .representationLimitExceeded ∨
      (code = .invalidRational ∧ ∃ settlement ∈ settlements, settlement.denomination.toRat = 0) := by
  unfold contextStep at h
  dsimp only at h
  split at h
  · cases h
    exact Or.inl (add_error_limit (hspec.allocated item.openItemId).1.bookValue
      (openItemBookValue_wf hitem) ‹_›)
  · rename_i bookValue hbook
    split at h
    · cases h
      exact Or.inl (add_error_limit (hspec.allocated item.openItemId).1.quantity
        hitem.allocatedOpenQuantity ‹_›)
    · rename_i quantity hquantity
      split at h
      · cases h
        rename_i hmeasured
        unfold paidMeasure at hmeasured
        split at hmeasured
        · cases hmeasured
        · split at hmeasured
          · cases hmeasured
          · rename_i settlement hfact
            obtain ⟨hmem, -⟩ := settlementFact_mem hfact
            by_cases hzero : settlement.denomination.toRat = 0
            · rcases proportionalShare_error_plain hmeasured with hcode | hcode
              · exact Or.inr ⟨hcode, settlement, hmem, hzero⟩
              · exact Or.inl hcode
            · exact Or.inl (proportionalShare_error_limit (hsettlements settlement hmem).bookValue
                (hsettlements settlement hmem).denomination hitem.allocatedSettlementQuantity hzero
                hmeasured)
      · rename_i measured hmeasured
        obtain ⟨hmeasuredWF, -⟩ := paidMeasure_ok hsettlements hitem hmeasured
        split at h
        · cases h
          exact Or.inl (add_error_limit (hspec.paid item.settlementId).1.bookValue hmeasuredWF ‹_›)
        · split at h
          · cases h
            exact Or.inl (add_error_limit (hspec.paid item.settlementId).1.quantity
              hitem.allocatedSettlementQuantity ‹_›)
          · cases h

/-- The loop that builds the context throws only for size, or for a division by the denomination of a
settlement of the state that is zero. -/
theorem contextTotals_error_limit {settlements : List Settlement}
    (hsettlements : ∀ settlement ∈ settlements, settlement.WF) :
    ∀ {items : List SettlementAllocation} {done : List SettlementAllocation}
      {totals : SettlementContextTotals} {code : NumErr},
      (∀ item ∈ items, item.WF) → TotalsSpec settlements totals done →
      contextTotals settlements totals items = .error code →
      code = .representationLimitExceeded ∨
        (code = .invalidRational ∧ ∃ settlement ∈ settlements, settlement.denomination.toRat = 0)
  | [], done, totals, code, _, _, h => by cases h
  | item :: rest, done, totals, code, hwf, hspec, h => by
    unfold contextTotals at h
    split at h
    · cases h
      exact contextStep_error_limit hsettlements (hwf item (by simp)) hspec ‹_›
    · rename_i next hstep
      exact contextTotals_error_limit hsettlements (fun a ha => hwf a (List.mem_cons_of_mem _ ha))
        (contextStep_spec hsettlements (hwf item (by simp)) hspec hstep) h

/-- Building the context from a constructible state throws only for size, or for a division by the
denomination of a settlement of the state that is zero. -/
theorem settlementReadContext_error_limit {state : AccountingCanonicalState} {code : NumErr}
    (hstate : state.WF) (h : settlementReadContext state = .error code) :
    code = .representationLimitExceeded ∨
      (code = .invalidRational ∧ ∃ settlement ∈ state.settlements, settlement.denomination.toRat = 0) := by
  unfold settlementReadContext at h
  split at h
  · cases h
    exact contextTotals_error_limit hstate.settlements hstate.settlementAllocations
      (totalsSpec_initial state.settlements) ‹_›
  · cases h

/-- When `applySettlement` throws, for a constructible state and request, it is the size limit, the
`RangeError` of the scale, a `TypeError` of a negative total, or a division by a settlement of the
state whose denomination is zero (the state of a settlement that no request of the kernel produces). -/
theorem applySettlement_error_limit {state : AccountingCanonicalState}
    {request : SettlementRequest} {e : SettlementErr} (hstate : state.WF) (hrequest : request.WF)
    (h : applySettlement state request = .error e) :
    e = .exactNumber .representationLimitExceeded ∨ e = .scaleOutOfRange ∨
      e = .incompletePriorSettlementTotals ∨ e = .incompleteSettlementTotals ∨
      (e = .exactNumber .invalidRational ∧
        ∃ settlement ∈ state.settlements, settlement.denomination.toRat = 0) := by
  unfold applySettlement at h
  split at h
  · rename_i code hcontext
    cases h
    rcases settlementReadContext_error_limit hstate hcontext with hcode | ⟨hcode, hzero⟩
    · exact Or.inl (by rw [hcode])
    · exact Or.inr (Or.inr (Or.inr (Or.inr ⟨by rw [hcode], hzero⟩)))
  · rename_i context hcontext
    rcases calculateSettlement_error_limit (settlementReadContext_wf hstate hcontext) hrequest h with
      h' | h' | h' | h'
    · exact Or.inl h'
    · exact Or.inr (Or.inl h')
    · exact Or.inr (Or.inr (Or.inl h'))
    · exact Or.inr (Or.inr (Or.inr (Or.inl h')))

/-! ## Checked against the TypeScript

The model was run and compared with `packages/kernel/src` (Bun) on fifty-eight requests: every rejection
and every way a request goes wrong, the settlements the context knows once and twice, legacy
allocations, a state that cannot be read, and what throws. Each line of `expected` is what the
TypeScript printed for the same request, a rejection as its path and message, a draft as its effect
types and the first eight digits of each content hash, an error as its class and its code or message;
a `#guard` fails the build if the model ever answers another. The last request, an application time
that `Date.parse` reads and `instant` does not accept (a bare date), is the one the model refuses and
the TypeScript accepts. -/

namespace SettlementExamples

/-- The path of the rejections of the operation and the application time. -/
def pathApplication : String := "command.settlement.application"

/-- The path of the rejections of the identity and the amounts, and of the settlement that was
recorded. -/
def pathSettlement : String := "command.settlement"

/-- The path of the rejections of the allocations. -/
def pathAllocations : String := "command.settlement.allocations"

/-- The message of the rejection of the operation and the application time. -/
def messageApplication : String :=
  "Settlement operation and application time must be explicit and coherent"

/-- The message of the rejection of the identity and the amounts. -/
def messageIdentity : String :=
  "Settlement identity must be unique, evidenced, and contain positive exact denomination and book value"

/-- The message of the rejection of an allocation that does not retain the settlement. -/
def messageRetained : String := "Later allocation must retain the exact original settlement"

/-- The message of the rejection of an allocation applied before its open item. -/
def messageRecognition : String := "Allocation cannot precede its open-item recognition"

/-- The message of the rejection of the scope and the sums. -/
def messageScope : String := "Settlement allocation violates scope or exact conservation"

/-- The message of the rejection of the values. -/
def messageValues : String :=
  "Settlement allocation must conserve each side's proportional carrying value, derive functional-currency settlement measurement through a dated valuation path, and bind any realized difference to a generated effect"

/-- The message of the rejection of the over-allocation. -/
def messageOver : String := "Settlement is over-allocated"

/-- A whole number as an exact rational. -/
def ex (n : Int) : ExactRational := ⟨n, 1⟩
/-- A content hash with this digest, of the algorithm and canonicalization of the kernel. -/
def mkHash (d : String) : ContentHash := ⟨contentHashAlgorithm, canonicalizationVersion, d⟩
/-- The item of evidence of the derivation the TypeScript fixtures use. -/
def evidence : SourceEvidence :=
  { id := ⟨"accounting-evidence"⟩, sourceSystem := "test", sourceRecordId := "record",
    observedAt := ⟨"2026-01-01T00:00:00Z"⟩,
    contentHash := mkHash "deaeac9aa5900d480a51d28619ce93609eda707846c9f3401ec7b18d470b76c1" }
/-- The approved derivation the TypeScript fixtures use, with one item of evidence. -/
def derivation : DerivationRecord :=
  { id := ⟨"accounting-derivation"⟩, policyId := ⟨"policy-main"⟩, policyVersion := ⟨"1.0.0"⟩,
    algorithmVersion := ⟨"1.0.0"⟩,
    inputHash := mkHash "2c4bf609915383515fc2702c0099f6b1e344f3ef5a4db1d4deef622f7b52765f",
    actorId := ⟨"actor-main"⟩, state := .approved, recordedAt := ⟨"2026-01-01T00:00:00Z"⟩,
    evidence := [evidence] }
/-- The party and the control account of every open item and settlement below. -/
def scope : SettlementScope := { externalPartyId := "CUSTOMER", controlAccountId := ⟨"account-ar"⟩ }
/-- The quantization policy the TypeScript fixtures use: USD, two places, half even. -/
def policy : QuantizationPolicy :=
  { id := ⟨"quantization-usd"⟩, version := ⟨"1.0.0"⟩, bookId := ⟨"book-main"⟩,
    functionalCommodityId := ⟨"USD"⟩, validFrom := ⟨"2020-01-01"⟩, validTo := none, targetScale := 2,
    roundingMode := .halfEven, roundingAccountId := ⟨"account-cash"⟩ }
/-- An open item of USD 100 recognized on a date, in a scope. -/
def mkOpen (id : String) (recognizedOn : String := "2026-01-01") (sc : SettlementScope := scope) :
    OpenItemBody :=
  { id := ⟨id⟩, bookId := ⟨"book-main"⟩, kind := .receivable, scope := sc, recognitionSource := none,
    recognitionPostingId := some ⟨id ++ "-p"⟩, recognizedOn := ⟨recognizedOn⟩,
    denominationCommodityId := ⟨"USD"⟩, denomination := ex 100, bookValue := ex 100, derivation }
/-- The state after the effects of a draft, or the state when the calculation was rejected. -/
def applyDraft (state : AccountingCanonicalState) (c : AccountingCalculation) : AccountingCanonicalState :=
  match c with
  | .draft d => d.effects.foldl applyAccountingEffect state
  | .rejected _ => state
/-- A state with four open items of USD 100: two ordinary, one recognized later, one of another party. -/
def base : AccountingCanonicalState :=
  [mkOpen "inv-a", mkOpen "inv-b", mkOpen "inv-late" "2026-02-01",
    mkOpen "inv-other" "2026-01-01" { scope with externalPartyId := "OTHER" }].foldl
    (fun state body => applyDraft state (recognizeOpenItem state ⟨body⟩)) emptyAccountingCanonicalState
/-- The instant of the payment. -/
def settledAt : Instant := ⟨"2026-01-15T00:00:00Z"⟩
/-- A payment of USD 100 that is worth USD 100. -/
def settlementB : SettlementBody :=
  { id := ⟨"pay"⟩, bookId := ⟨"book-main"⟩, kind := .cash, scope, settlementSource := none,
    settlementPostingId := some ⟨"pay-p"⟩, settledAt, denominationCommodityId := ⟨"USD"⟩,
    denomination := ex 100, bookValue := ex 100, derivation }
/-- An allocation of a quantity of the payment to an open item. -/
def alloc (id open_ : String) (q : Int) : SettlementAllocationBody :=
  { id := ⟨id⟩, openItemId := ⟨open_⟩, settlementId := ⟨"pay"⟩, appliedAt := none,
    allocatedBookValue := ex q, allocatedOpenQuantity := ex q, allocatedSettlementQuantity := ex q,
    allocatedOpenItemBookValue := none, allocatedSettlementBookValue := none,
    settlementMeasurement := none, realizedExchangeDifference := none, valuationPath := none,
    realizedExchangeEffectKey := none, derivation }
/-- A request: a settlement, its allocations, an operation, an application time and a policy. -/
def req (s : SettlementBody) (allocs : List SettlementAllocationBody)
    (op : Option SettlementOperation := none) (appliedAt : Option Instant := none)
    (p : Option QuantizationPolicy := none) : SettlementRequest :=
  { settlement := s, allocations := allocs, quantizationPolicy := p, realizedExchangePolicyId := none,
    realizedExchangePolicyVersion := none, operation := op, appliedAt }
/-- The request that allocates USD 40 of the payment to the first open item. -/
def baseRequest : SettlementRequest := req settlementB [alloc "a1" "inv-a" 40]
/-- The state that holds the payment, recorded without allocations. -/
def stateUn : AccountingCanonicalState :=
  applyDraft base (match applySettlement base (req settlementB [] (some .recognizeUnallocated)) with
    | .ok c => c | .error _ => .rejected [])
/-- An application time after the payment. -/
def atText : String := "2026-01-21T00:00:00Z"
/-- A request that allocates an existing settlement, every allocation applied at the same time. -/
def existingReq (allocs : List SettlementAllocationBody) (s : SettlementBody := settlementB)
    (appliedAt : String := atText) : SettlementRequest :=
  req s (allocs.map fun a => { a with appliedAt := some ⟨atText⟩ }) (some .allocateExisting)
    (some ⟨appliedAt⟩)
/-- The read context of a state. -/
def ctxOf (state : AccountingCanonicalState) : SettlementReadContext :=
  match settlementReadContext state with | .ok c => c | .error _ => default

/-- The error as the TypeScript's class and its code or message. -/
def showErr : SettlementErr → String
  | .exactNumber .representationLimitExceeded => "T:ExactNumberError:representation_limit_exceeded"
  | .exactNumber .invalidRational => "T:ExactNumberError:invalid_rational"
  | .exactNumber _ => "T:ExactNumberError:other"
  | .scaleOutOfRange => "T:RangeError:Quantization scale must be between 0 and 1000"
  | .incompleteSettlementTotals => "T:TypeError:Incomplete settlement totals evidence"
  | .incompletePriorSettlementTotals => "T:TypeError:Incomplete prior settlement allocation totals"
/-- The first eight digits of a content hash. -/
def digest8 (h : ContentHash) : String := String.ofList (h.digest.toList.take 8)
/-- What a calculation answered, as the text of the comparison. -/
def showResult : Except SettlementErr AccountingCalculation → String
  | .error e => showErr e
  | .ok (.rejected ds) => match ds with
    | d :: _ => s!"R:{d.path}|{d.message}"
    | [] => "R:"
  | .ok (.draft d) =>
    "D:" ++ "+".intercalate (d.effects.map AccountingEffect.type) ++ ":" ++
      ",".intercalate (d.effects.map fun e => digest8 e.contentHash)

/-- The request that has the payment changed and, by default, the allocation of USD 40. -/
def withS (f : SettlementBody → SettlementBody) (allocs : List SettlementAllocationBody := [alloc "a1" "inv-a" 40]) :
    SettlementRequest := req (f settlementB) allocs
/-- The request that has its allocations changed. -/
def edit (f : SettlementAllocationBody → SettlementAllocationBody) (allocs : List SettlementAllocationBody := [alloc "a1" "inv-a" 40]) :
    SettlementRequest := req settlementB (allocs.map f)
/-- A valuation path from a commodity to itself. -/
def fxPathSame : CurrencyValuationPath :=
  { fromCommodityId := ⟨"USD"⟩, toCommodityId := ⟨"USD"⟩, effectiveAt := settledAt, observedAt := settledAt,
    rate := ex 1, evidenceIds := [⟨"accounting-evidence"⟩] }
/-- A quantized value of USD 40. -/
def junk : QuantizedValue := { amount := ⟨4000, 2⟩, residual := ex 0 }
/-- A quantity of 2 to the 9000. -/
def big : ExactRational := ex (2 ^ 9000)

/-- An open item whose hash is not the hash of its body. -/
def sealOpen (b : OpenItemBody) : OpenItem := { toOpenItemBody := b, contentHash := mkHash "00" }
/-- A settlement whose hash is not the hash of its body. -/
def sealSettlement (b : SettlementBody) : Settlement :=
  { toSettlementBody := b, contentHash := mkHash "00" }
/-- An allocation whose hash is not the hash of its body. -/
def sealAlloc (b : SettlementAllocationBody) : SettlementAllocation :=
  { toSettlementAllocationBody := b, contentHash := mkHash "00" }
/-- A state that holds two open items of one identifier. -/
def dupState : AccountingCanonicalState :=
  { emptyAccountingCanonicalState with
    openItems := [sealOpen (mkOpen "dup"),
      sealOpen { mkOpen "dup" with denomination := ex 7, bookValue := ex 7 }] }
/-- A state that holds two settlements of one identifier. -/
def dupSettlements : AccountingCanonicalState :=
  { stateUn with
    settlements := [sealSettlement settlementB,
      sealSettlement { settlementB with denomination := ex 50, bookValue := ex 50 }] }
/-- A state that holds an allocation without the book values the kernel states today. -/
def legacyState : AccountingCanonicalState :=
  { stateUn with settlementAllocations := [sealAlloc (alloc "old" "inv-a" 60)] }
/-- A settlement of the state whose denomination is zero. -/
def zeroDenSettlement : Settlement := sealSettlement { settlementB with denomination := ex 0 }
/-- A state that holds it. -/
def zeroDenBase : AccountingCanonicalState := { stateUn with settlements := [zeroDenSettlement] }
/-- A state that holds it and an allocation of it, which the context cannot be built from. -/
def zeroDenState : AccountingCanonicalState :=
  { zeroDenBase with settlementAllocations := legacyState.settlementAllocations }

/-- A payment of EUR 100 that is worth USD 120. -/
def fxSettlementB : SettlementBody :=
  { settlementB with id := ⟨"fx"⟩, denominationCommodityId := ⟨"EUR"⟩, bookValue := ex 120 }

/-- Its valuation path, from the euro to the dollar on the day of the payment, with a function that
changes it. -/
def fxPathB (g : CurrencyValuationPath → CurrencyValuationPath := id) : CurrencyValuationPath :=
  g { fromCommodityId := ⟨"EUR"⟩, toCommodityId := ⟨"USD"⟩, effectiveAt := settledAt,
      observedAt := settledAt, rate := ⟨6, 5⟩, evidenceIds := [⟨"accounting-evidence"⟩] }

/-- Its allocation to the first open item, with a function that changes it and one that changes the
path. -/
def fxAllocB (f : SettlementAllocationBody → SettlementAllocationBody := id)
    (g : CurrencyValuationPath → CurrencyValuationPath := id) : SettlementAllocationBody :=
  f { id := ⟨"f1"⟩, openItemId := ⟨"inv-a"⟩, settlementId := ⟨"fx"⟩, appliedAt := none,
      allocatedBookValue := ex 100, allocatedOpenQuantity := ex 100,
      allocatedSettlementQuantity := ex 100, allocatedOpenItemBookValue := none,
      allocatedSettlementBookValue := some (ex 120), settlementMeasurement := none,
      realizedExchangeDifference := none, valuationPath := some (fxPathB g),
      realizedExchangeEffectKey := some ⟨"k:fx"⟩, derivation }

/-- The request that allocates it, with or without the quantization policy. -/
def fxReqB (a : SettlementAllocationBody) (p : Option QuantizationPolicy := some policy) :
    SettlementRequest :=
  req fxSettlementB [a] none none p

/-- A quantized value of this many hundredths, with no residual. -/
def qv (c : Int) : QuantizedValue := { amount := ⟨c, 2⟩, residual := ex 0 }

/-- What the model answers for each of the fifty-eight requests. -/
def cases : List (String × String) := [
  ("base", showResult (applySettlement base baseRequest)),
  ("appliedAtWithoutOperation", showResult (applySettlement base { baseRequest with appliedAt := some ⟨atText⟩ })),
  ("existingNoApplied", showResult (applySettlement stateUn
    { req settlementB [alloc "a1" "inv-a" 40] (some .allocateExisting) with appliedAt := none })),
  ("existingBadDate", showResult (applySettlement stateUn (existingReq [alloc "a1" "inv-a" 40] settlementB "garbage"))),
  ("existingEarly", showResult (applySettlement stateUn
    (existingReq [alloc "a1" "inv-a" 40] settlementB "2026-01-14T00:00:00Z"))),
  ("allocationAppliedAtOnNew", showResult (applySettlement base
    (edit fun a => { a with appliedAt := some ⟨atText⟩ }))),
  ("allocationAppliedAtDiffers", showResult (applySettlement stateUn
    { existingReq [alloc "a1" "inv-a" 40] with
      allocations := [{ alloc "a1" "inv-a" 40 with appliedAt := some ⟨"2026-01-22T00:00:00Z"⟩ }] })),
  ("proposedDerivation", showResult (applySettlement base
    (withS fun s => { s with derivation := { derivation with state := .proposed } }))),
  ("settlementPresent", showResult (applySettlement stateUn baseRequest)),
  ("emptyAllocations", showResult (applySettlement base (req settlementB []))),
  ("unallocatedWithAllocations", showResult (applySettlement base
    { baseRequest with operation := some .recognizeUnallocated })),
  ("duplicateAllocationIds", showResult (applySettlement base
    (req settlementB [alloc "a1" "inv-a" 10, alloc "a1" "inv-b" 10]))),
  ("zeroSettlementValue", showResult (applySettlement base (withS fun s => { s with bookValue := ex 0 }))),
  ("zeroDenomination", showResult (applySettlement base (withS fun s => { s with denomination := ex 0 }))),
  ("blankParty", showResult (applySettlement base
    (withS fun s => { s with scope := { scope with externalPartyId := "  " } }))),
  ("existingMissing", showResult (applySettlement base (existingReq [alloc "a1" "inv-a" 40]))),
  ("existingChanged", showResult (applySettlement stateUn
    (existingReq [alloc "a1" "inv-a" 40] { settlementB with bookValue := ex 99 }))),
  ("existingOk", showResult (applySettlement stateUn (existingReq [alloc "a1" "inv-a" 40]))),
  ("recognizedAfter", showResult (applySettlement stateUn (existingReq [alloc "a1" "inv-late" 40]))),
  ("unknownOpen", showResult (applySettlement base (req settlementB [alloc "a1" "nope" 40]))),
  ("wrongSettlementId", showResult (applySettlement base
    (edit fun a => { a with settlementId := ⟨"other"⟩ }))),
  ("otherParty", showResult (applySettlement base (req settlementB [alloc "a1" "inv-other" 40]))),
  ("overBook", showResult (applySettlement base (req settlementB [alloc "a1" "inv-a" 101]))),
  ("overSettlementQuantity", showResult (applySettlement base
    (req settlementB [alloc "a1" "inv-a" 60, alloc "a2" "inv-b" 60]))),
  ("zeroQuantity", showResult (applySettlement base (edit fun a => { a with allocatedOpenQuantity := ex 0 }))),
  ("statedBookMismatch", showResult (applySettlement base
    (edit fun a => { a with allocatedOpenItemBookValue := some (ex 39) }))),
  ("wrongCarrying", showResult (applySettlement base (edit fun a => { a with allocatedBookValue := ex 39 }))),
  ("wrongSettlementShare", showResult (applySettlement base
    (edit fun a => { a with allocatedSettlementBookValue := some (ex 39) }))),
  ("statedSettlementShareOk", showResult (applySettlement base
    (edit fun a => { a with allocatedSettlementBookValue := some (ex 40) }))),
  ("pathOnSameCommodity", showResult (applySettlement base
    { edit fun a => { a with valuationPath := some fxPathSame } with quantizationPolicy := some policy })),
  ("measurementWithoutPolicy", showResult (applySettlement base
    (edit fun a => { a with settlementMeasurement := some junk }))),
  ("withPolicy", showResult (applySettlement base { baseRequest with quantizationPolicy := some policy })),
  ("effectKeyWithoutDifference", showResult (applySettlement base
    (edit fun a => { a with realizedExchangeEffectKey := some ⟨"k:1"⟩ }))),
  ("differenceWithoutKey", showResult (applySettlement base
    (withS fun s => { s with bookValue := ex 120 }))),
  ("differenceWithKey", showResult (applySettlement base
    (req { settlementB with bookValue := ex 120 }
      [{ alloc "a1" "inv-a" 40 with realizedExchangeEffectKey := some ⟨"k:1"⟩ }]))),
  ("bigScale", showResult (calculateSettlement (ctxOf base)
    { baseRequest with quantizationPolicy := some { policy with targetScale := 2000 } })),
  ("overAllocatedPrevious", showResult (calculateSettlement
    { ctxOf stateUn with allocatedFromSettlement := fun _ => ⟨ex 90, ex 0⟩ }
    (existingReq [alloc "a1" "inv-a" 40]))),
  ("negativeTotals", showResult (calculateSettlement
    { ctxOf base with allocatedToOpenItem := fun _ => ⟨ex (-1), ex 0⟩ } baseRequest)),
  ("negativePrior", showResult (calculateSettlement
    { ctxOf stateUn with allocatedFromSettlement := fun _ => ⟨ex 0, ex (-1)⟩ }
    (existingReq [alloc "a1" "inv-a" 40]))),
  ("limit", showResult (applySettlement base
    (req { settlementB with denomination := ex (2 ^ 9000 + 1), bookValue := ex (3 ^ 6000) }
      [{ alloc "a1" "inv-a" 1 with allocatedSettlementQuantity := big }])))
  ,("duplicateOpenItems", showResult (applySettlement dupState (req settlementB [alloc "a1" "dup" 100]))),
  ("duplicateSettlements", showResult (applySettlement dupSettlements (existingReq [alloc "a1" "inv-a" 40]))),
  ("legacyWithin", showResult (applySettlement legacyState (existingReq [alloc "a1" "inv-a" 40]))),
  ("legacyOver", showResult (applySettlement legacyState (existingReq [alloc "a1" "inv-a" 50]))),
  ("zeroDenominatorState", showResult (applySettlement zeroDenState (existingReq [alloc "a1" "inv-a" 40]))),
  ("bareDateApplied", showResult (applySettlement stateUn
    { existingReq [alloc "a1" "inv-a" 40] settlementB "2026-01-21" with
      allocations := [{ alloc "a1" "inv-a" 40 with appliedAt := some ⟨"2026-01-21"⟩ }] })),
  ("fxOk", showResult (applySettlement base (fxReqB (fxAllocB)))),
  ("fxPathOtherDay", showResult (applySettlement base
    (fxReqB (fxAllocB id fun p => { p with effectiveAt := ⟨"2026-01-16T00:00:00Z"⟩ })))),
  ("fxPathObservedLate", showResult (applySettlement base
    (fxReqB (fxAllocB id fun p => { p with observedAt := ⟨"2026-01-15T00:00:01Z"⟩ })))),
  ("fxPathNoEvidence", showResult (applySettlement base
    (fxReqB (fxAllocB id fun p => { p with evidenceIds := [] })))),
  ("fxPathWrongTarget", showResult (applySettlement base
    (fxReqB (fxAllocB id fun p => { p with toCommodityId := ⟨"EUR"⟩ })))),
  ("fxPathRateWrong", showResult (applySettlement base
    (fxReqB (fxAllocB id fun p => { p with rate := ⟨11, 10⟩ })))),
  ("fxNoPolicy", showResult (applySettlement base (fxReqB (fxAllocB) none))),
  ("fxNoPath", showResult (applySettlement base
    (fxReqB (fxAllocB fun a => { a with valuationPath := none })))),
  ("fxMeasurementOk", showResult (applySettlement base
    (fxReqB (fxAllocB fun a => { a with settlementMeasurement := some (qv 12000) })))),
  ("fxMeasurementWrong", showResult (applySettlement base
    (fxReqB (fxAllocB fun a => { a with settlementMeasurement := some (qv 11900) })))),
  ("fxRealizedOk", showResult (applySettlement base
    (fxReqB (fxAllocB fun a => { a with realizedExchangeDifference := some (qv 2000) })))),
  ("fxRealizedWrong", showResult (applySettlement base
    (fxReqB (fxAllocB fun a => { a with realizedExchangeDifference := some (qv 1900) }))))]

/-- What the TypeScript printed for each of them. -/
def expected : List (String × String) := [
  ("base", "D:settlement+settlementAllocation:ba65fcaa,2d55517e"),
  ("appliedAtWithoutOperation", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("existingNoApplied", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("existingBadDate", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("existingEarly", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("allocationAppliedAtOnNew", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("allocationAppliedAtDiffers", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("proposedDerivation", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("settlementPresent", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("emptyAllocations", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("unallocatedWithAllocations", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("duplicateAllocationIds", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("zeroSettlementValue", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("zeroDenomination", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("blankParty", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("existingMissing", "R:" ++ pathSettlement ++ "|" ++ messageIdentity),
  ("existingChanged", "R:" ++ pathSettlement ++ "|" ++ messageRetained),
  ("existingOk", "D:settlementAllocation:1bf7d871"),
  ("recognizedAfter", "R:" ++ pathApplication ++ "|" ++ messageRecognition),
  ("unknownOpen", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("wrongSettlementId", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("otherParty", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("overBook", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("overSettlementQuantity", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("zeroQuantity", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("statedBookMismatch", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("wrongCarrying", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("wrongSettlementShare", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("statedSettlementShareOk", "D:settlement+settlementAllocation:ba65fcaa,2d55517e"),
  ("pathOnSameCommodity", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("measurementWithoutPolicy", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("withPolicy", "D:settlement+settlementAllocation:ba65fcaa,64850228"),
  ("effectKeyWithoutDifference", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("differenceWithoutKey", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("differenceWithKey", "D:settlement+settlementAllocation:a91a7f2d,22b3e1b4"),
  ("bigScale", "T:RangeError:Quantization scale must be between 0 and 1000"),
  ("overAllocatedPrevious", "R:" ++ pathAllocations ++ "|" ++ messageOver),
  ("negativeTotals", "T:TypeError:Incomplete settlement totals evidence"),
  ("negativePrior", "T:TypeError:Incomplete prior settlement allocation totals"),
  ("limit", "T:ExactNumberError:representation_limit_exceeded"),
  ("duplicateOpenItems", "D:settlement+settlementAllocation:ba65fcaa,969664c9"),
  ("duplicateSettlements", "R:" ++ pathSettlement ++ "|" ++ messageRetained),
  ("legacyWithin", "D:settlementAllocation:1bf7d871"),
  ("legacyOver", "R:" ++ pathAllocations ++ "|" ++ messageScope),
  ("zeroDenominatorState", "T:ExactNumberError:invalid_rational"),
  ("bareDateApplied", "R:" ++ pathApplication ++ "|" ++ messageApplication),
  ("fxOk", "D:settlement+settlementAllocation:e23c68a1,21cff9ce"),
  ("fxPathOtherDay", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxPathObservedLate", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxPathNoEvidence", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxPathWrongTarget", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxPathRateWrong", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxNoPolicy", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxNoPath", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxMeasurementOk", "D:settlement+settlementAllocation:e23c68a1,21cff9ce"),
  ("fxMeasurementWrong", "R:" ++ pathAllocations ++ "|" ++ messageValues),
  ("fxRealizedOk", "D:settlement+settlementAllocation:e23c68a1,21cff9ce"),
  ("fxRealizedWrong", "R:" ++ pathAllocations ++ "|" ++ messageValues)]

#guard cases == expected

/-! A settlement of two commodities, with a valuation path, a quantization policy, a realized
difference and its effect key, and one of a single commodity: the content hashes in full. -/

/-- An open item of USD 100. -/
def fxOpenBody : OpenItemBody :=
  { id := ⟨"boundary-open"⟩, bookId := ⟨"book-main"⟩, kind := .receivable, scope,
    recognitionSource := none, recognitionPostingId := some ⟨"boundary-open-posting"⟩,
    recognizedOn := ⟨"2026-01-01"⟩, denominationCommodityId := ⟨"USD"⟩, denomination := ex 100,
    bookValue := ex 100, derivation }

/-- The state that holds it. -/
def fxOpenState : AccountingCanonicalState :=
  applyDraft emptyAccountingCanonicalState
    (recognizeOpenItem emptyAccountingCanonicalState ⟨fxOpenBody⟩)

/-- A payment of EUR 100 that is worth USD 120. -/
def fxSettlement : SettlementBody :=
  { id := ⟨"boundary-settlement"⟩, bookId := ⟨"book-main"⟩, kind := .cash, scope,
    settlementSource := none, settlementPostingId := some ⟨"boundary-settlement-posting"⟩, settledAt,
    denominationCommodityId := ⟨"EUR"⟩, denomination := ex 100, bookValue := ex 120, derivation }

/-- The valuation path of its allocation. -/
def fxPath : CurrencyValuationPath :=
  { fromCommodityId := ⟨"EUR"⟩, toCommodityId := ⟨"USD"⟩, effectiveAt := settledAt,
    observedAt := settledAt, rate := ⟨6, 5⟩, evidenceIds := [⟨"accounting-evidence"⟩] }

/-- Its allocation to the open item. -/
def fxEdge : SettlementAllocationBody :=
  { id := ⟨"boundary-edge"⟩, openItemId := ⟨"boundary-open"⟩, settlementId := ⟨"boundary-settlement"⟩,
    appliedAt := none, allocatedBookValue := ex 100, allocatedOpenQuantity := ex 100,
    allocatedSettlementQuantity := ex 100, allocatedOpenItemBookValue := none,
    allocatedSettlementBookValue := some (ex 120), settlementMeasurement := none,
    realizedExchangeDifference := none, valuationPath := some fxPath,
    realizedExchangeEffectKey := some ⟨"boundary:journal:1"⟩, derivation }

/-- The request. -/
def fxRequest : SettlementRequest := req fxSettlement [fxEdge] none none (some policy)

/-- A payment of USD 100 and an allocation of USD 40 of it. -/
def sameSettlement : SettlementBody :=
  { fxSettlement with
    id := ⟨"same-settlement"⟩, denominationCommodityId := ⟨"USD"⟩, bookValue := ex 100 }

/-- The allocation of USD 40. -/
def sameEdge : SettlementAllocationBody :=
  { alloc "same-edge" "boundary-open" 40 with settlementId := ⟨"same-settlement"⟩ }

/-- The text of a quantized value. -/
def quantizedText : Option QuantizedValue → String
  | none => "none"
  | some m => s!"{m.amount.coefficient}e{m.amount.scale} res {m.residual.numerator}/{m.residual.denominator}"

/-- The digests of the effects of a draft, and what its allocations record. -/
def effectSummary : Except SettlementErr AccountingCalculation → List String
  | .ok (.draft d) => d.effects.flatMap fun
    | .settlement v => [v.contentHash.digest]
    | .settlementAllocation v => [v.contentHash.digest, quantizedText v.settlementMeasurement,
        quantizedText v.realizedExchangeDifference]
    | .openItem v => [v.contentHash.digest]
    | _ => ["other"]
  | _ => []

#guard effectSummary (.ok (recognizeOpenItem emptyAccountingCanonicalState ⟨fxOpenBody⟩)) ==
  ["a08941ebcfffd5e68d6eecb726e6035e93fdd4f8750afe1e6c274032565acef5"]

#guard effectSummary (applySettlement fxOpenState fxRequest) ==
  ["4547c022f33f29d9104473ea14500e129cd8b9cccdf12ebdf89fc2a96a71bc06",
    "ae455082f9d030d327bfced3dbbee7d569912a6fab7aef63b86467626aaf0b96", "12000e2 res 0/1",
    "2000e2 res 0/1"]

#guard effectSummary (applySettlement fxOpenState (req sameSettlement [sameEdge])) ==
  ["2334ce2594e1ab70e8bd026c50ac7653f68da43ba23792f7a5e9605ff7152e19",
    "b4605aaf79a96015d8057aa49b6ed610940a375d8501a4df5a18fcc417c1cd65", "none", "none"]

#guard effectSummary (applySettlement fxOpenState
    (req sameSettlement [] (some .recognizeUnallocated))) ==
  ["2334ce2594e1ab70e8bd026c50ac7653f68da43ba23792f7a5e9605ff7152e19"]

end SettlementExamples

end Rastrata.Kernel

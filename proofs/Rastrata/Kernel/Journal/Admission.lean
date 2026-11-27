/-
Journal admission: the Lean model of `packages/kernel/src/journal.ts` after `diagnostic`
(`activeOn`, `indexById`, `detectParentCycle`, `validateSnapshot`, `rationalValue`, `decimalValue`,
`comparePostings`, `canonicalPostingValue`, `canonicalJournalValue`, `validateCoordinateWithIndexes`,
`validateAccountingCoordinate`, `admitJournal`), and the laws of admission.

Three layers, as everywhere in this project:

1. Model: one definition a TypeScript function, the same checks in the same order, the same
   diagnostics (code, path, requirement identifiers) in the same order. A function that pushes
   onto a shared `diagnostics` array returns here the diagnostics it pushed, and its caller appends
   them, which keeps the order. Where an exact-number operation throws, `admitJournal` is `.error`
   with the code of the `ExactNumberError`.
2. Meaning: `Posting.WF` and `JournalTransaction.WF` (every number is constructible), and the
   conditions of admission as plain statements about the snapshot's lists.
3. Laws: an admitted journal balances; what else an admitted journal satisfies, one theorem a
   diagnostic; that those conditions are all the function asks; when `journal_imbalance` is
   reported; and what the canonical value of a journal determines.

What is left out, and what is assumed:

- The `message` of a diagnostic is not modelled: every diagnostic here has the empty message. The
  code, the path and the requirement identifiers are modelled.
- The six run-time `instanceof` tests of `admitJournal` (`journal.ts` lines 705 to 715) are on
  values the TypeScript types already guarantee. They are modelled as always passing, so the
  diagnostic of lines 724 to 731 (`invalid_exact_number` or `monetary_type_mismatch` at the path
  of the posting) is never produced, and the three `amountIsDecimal &&` guards and the guards
  `quantityIsRational && sourceIsDecimal`, `basisIsRational && sourceBasisIsDecimal` and
  `priceIsRational` are true.
- A `Map<string, T>` and a `Set<string>` are lists in insertion order; `has` and `get` compare
  keys as strings.
- The loop of `detectParentCycle` has no bound in the TypeScript. Here it runs on fuel, and
  `parentCycleFrom_fuel` proves that the fuel given is never used up.
- `snapshot.requiredDimensionIdsByPosting?.[posting.id]` (`journal.ts` line 843) is modelled as a
  lookup among the object's own properties. The TypeScript reads inherited properties too: see
  `LookupDiverges` for the inputs on which the two differ.
- `Number(left.ordinal - right.ordinal)` in `comparePostings` is a floating-point number; only its
  sign and whether it is zero are read, and both are those of the exact difference (a non-zero
  integer converts to a non-zero number of the same sign, an infinity included).
- `[...posting.dimensionMemberIds].sort()` sorts strings by UTF-16 code unit and
  `Array.prototype.sort` is stable; both sorts are `List.mergeSort`, which is stable.
- `Object.freeze` is not modelled.
-/
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.NumericLimits
import Mathlib.Data.List.Perm.Basic

namespace Rastrata.Kernel

/-! ## The model: helpers of `validateSnapshot` (`journal.ts` lines 260 to 318) -/

/-- `activeOn` (`journal.ts` line 260). -/
def activeOn (openedOn : LocalDate) (closedOn : Option LocalDate) (accountingDate : LocalDate) :
    Bool :=
  decide (openedOn ≤ accountingDate) &&
    (match closedOn with
     | none => true
     | some closedOn => decide (accountingDate ≤ closedOn))

/-- A JavaScript `Map<string, T>`: its entries, key and value, in insertion order. -/
abbrev IdIndex (T : Type) := List (String × T)

/-- `Map.prototype.has`. -/
def IdIndex.has {T : Type} (index : IdIndex T) (key : String) : Bool := index.any (·.1 == key)

/-- `Map.prototype.get`: `none` for `undefined`. -/
def IdIndex.get {T : Type} (index : IdIndex T) (key : String) : Option T :=
  (index.find? (·.1 == key)).map (·.2)

/-- The loop of `indexById`: the index so far, then the index at the end and the diagnostics
pushed. A value whose identifier is already in the index is reported and not stored. -/
def indexByIdLoop {T : Type} (idOf : T → String) (path : String) :
    List T → IdIndex T → IdIndex T × List SemanticDiagnostic
  | [], index => (index, [])
  | value :: rest, index =>
    if index.has (idOf value) then
      let result := indexByIdLoop idOf path rest index
      (result.1,
        diagnostic .canonical_identity_conflict (path ++ "[id=" ++ idOf value ++ "]") ""
          ["ACC-038"] :: result.2)
    else indexByIdLoop idOf path rest (index ++ [(idOf value, value)])

/-- `indexById` (`journal.ts` line 268): the index and the diagnostics pushed. -/
def indexById {T : Type} (idOf : T → String) (values : List T) (path : String) :
    IdIndex T × List SemanticDiagnostic :=
  indexByIdLoop idOf path values []

/-- The `while` loop of `detectParentCycle` for one value: `true` when it pushes the diagnostic
and breaks, `false` when it ends because the cursor is `undefined` or has no parent. `visited` is
the `Set` and `cursor` the variable of that name. The loop has no bound in the TypeScript; the
fuel is the number of turns allowed here (`parentCycleFrom_fuel`: it is never used up). -/
def parentCycleFrom {T : Type} (idOf : T → String) (parentOf : T → Option String)
    (index : IdIndex T) : Nat → List String → Option T → Bool
  | 0, _, _ => false
  | fuel + 1, visited, cursor =>
    match cursor with
    | none => false
    | some cursor =>
      match parentOf cursor with
      | none => false
      | some parentId =>
        if visited.contains (idOf cursor) then true
        else parentCycleFrom idOf parentOf index fuel (idOf cursor :: visited) (index.get parentId)

/-- `detectParentCycle` (`journal.ts` line 291): the diagnostics pushed, one for each value whose
chain of parents comes back to an identifier it has passed. -/
def detectParentCycle {T : Type} (idOf : T → String) (parentOf : T → Option String)
    (values : List T) (index : IdIndex T) (path : String) (code : SemanticDiagnosticCode)
    (requirementId : String) : List SemanticDiagnostic :=
  values.flatMap fun value =>
    if parentCycleFrom idOf parentOf index (index.length + 2) [] (some value) then
      [diagnostic code (path ++ "[id=" ++ idOf value ++ "].parentId") "" [requirementId]]
    else []

/-! ## The model: `validateSnapshot` (`journal.ts` lines 320 to 492) -/

/-- What `validateSnapshot` returns: the three indexes. -/
structure SnapshotIndexes where
  accounts : IdIndex AccountSnapshot
  dimensions : IdIndex AccountingDimensionSnapshot
  members : IdIndex DimensionMemberSnapshot

/-- `closedOn !== undefined && closedOn < openedOn`, the test of the three "closes before it
opens" diagnostics. -/
def closesBeforeOpens (openedOn : LocalDate) (closedOn : Option LocalDate) : Bool :=
  match closedOn with
  | none => false
  | some closedOn => decide (closedOn < openedOn)

/-- The loop over `snapshot.accounts` (`journal.ts` lines 333 to 375). `accountCodes` is the `Set`
of that name. -/
def accountDiagnostics (snapshot : JournalAdmissionSnapshot) (accounts : IdIndex AccountSnapshot) :
    List AccountSnapshot → List String → List SemanticDiagnostic
  | [], _ => []
  | account :: rest, accountCodes =>
    (if account.bookId ≠ snapshot.bookId then
      [diagnostic .book_isolation_violation
        ("snapshot.accounts[id=" ++ account.id.value ++ "].bookId") "" ["ACC-026"]]
     else []) ++
    (if accountCodes.contains account.code then
      [diagnostic .invalid_chart_or_account
        ("snapshot.accounts[id=" ++ account.id.value ++ "].code") "" ["ACC-014"]]
     else []) ++
    (if closesBeforeOpens account.openedOn account.closedOn then
      [diagnostic .invalid_chart_or_account
        ("snapshot.accounts[id=" ++ account.id.value ++ "].closedOn") "" ["ACC-013", "ACC-014"]]
     else []) ++
    (if (match account.parentId with
         | none => false
         | some parentId => !accounts.has parentId.value) then
      [diagnostic .invalid_chart_or_account
        ("snapshot.accounts[id=" ++ account.id.value ++ "].parentId") "" ["ACC-014", "ACC-038"]]
     else []) ++
    accountDiagnostics snapshot accounts rest (account.code :: accountCodes)

/-- The loop over `snapshot.dimensions` (`journal.ts` lines 386 to 418). `dimensionCodes` is the
`Set` of that name. -/
def dimensionDiagnostics (snapshot : JournalAdmissionSnapshot) :
    List AccountingDimensionSnapshot → List String → List SemanticDiagnostic
  | [], _ => []
  | dimension :: rest, dimensionCodes =>
    (if dimension.bookId ≠ snapshot.bookId then
      [diagnostic .book_isolation_violation
        ("snapshot.dimensions[id=" ++ dimension.id.value ++ "].bookId") "" ["ACC-026", "ACC-037"]]
     else []) ++
    (if dimensionCodes.contains dimension.code then
      [diagnostic .invalid_dimension_selection
        ("snapshot.dimensions[id=" ++ dimension.id.value ++ "].code") "" ["ACC-037"]]
     else []) ++
    (if closesBeforeOpens dimension.openedOn dimension.closedOn then
      [diagnostic .invalid_dimension_selection
        ("snapshot.dimensions[id=" ++ dimension.id.value ++ "].closedOn") ""
        ["ACC-013", "ACC-037"]]
     else []) ++
    dimensionDiagnostics snapshot rest (dimension.code :: dimensionCodes)

/-- `scopedCode` (`journal.ts` line 432): the dimension, a NUL character, the code. -/
def scopedCode (member : DimensionMemberSnapshot) : String :=
  member.dimensionId.value ++ "\x00" ++ member.code

/-- The loop over `snapshot.dimensionMembers` (`journal.ts` lines 421 to 468). `memberCodes` is the
`Set` of that name. -/
def memberDiagnostics (dimensions : IdIndex AccountingDimensionSnapshot)
    (members : IdIndex DimensionMemberSnapshot) :
    List DimensionMemberSnapshot → List String → List SemanticDiagnostic
  | [], _ => []
  | member :: rest, memberCodes =>
    (if !dimensions.has member.dimensionId.value then
      [diagnostic .invalid_dimension_selection
        ("snapshot.dimensionMembers[id=" ++ member.id.value ++ "].dimensionId") ""
        ["ACC-037", "ACC-038"]]
     else []) ++
    (if memberCodes.contains (scopedCode member) then
      [diagnostic .invalid_dimension_selection
        ("snapshot.dimensionMembers[id=" ++ member.id.value ++ "].code") "" ["ACC-037"]]
     else []) ++
    (if closesBeforeOpens member.openedOn member.closedOn then
      [diagnostic .invalid_dimension_selection
        ("snapshot.dimensionMembers[id=" ++ member.id.value ++ "].closedOn") ""
        ["ACC-013", "ACC-037"]]
     else []) ++
    (if (match member.parentId with
         | none => false
         | some parentId =>
           match members.get parentId.value with
           | none => true
           | some parent => parent.dimensionId ≠ member.dimensionId) then
      [diagnostic .invalid_dimension_selection
        ("snapshot.dimensionMembers[id=" ++ member.id.value ++ "].parentId") ""
        ["ACC-037", "ACC-038"]]
     else []) ++
    memberDiagnostics dimensions members rest (scopedCode member :: memberCodes)

/-- The loop over `snapshot.requiredDimensionIds` (`journal.ts` lines 478 to 489). -/
def requiredDimensionDiagnostics (dimensions : IdIndex AccountingDimensionSnapshot)
    (requiredDimensionIds : List DimensionId) : List SemanticDiagnostic :=
  requiredDimensionIds.flatMap fun requiredDimensionId =>
    if !dimensions.has requiredDimensionId.value then
      [diagnostic .invalid_dimension_selection "snapshot.requiredDimensionIds" ""
        ["ACC-011", "ACC-037", "ACC-038"]]
    else []

/-- `validateSnapshot` (`journal.ts` line 320): the indexes and the diagnostics pushed. -/
def validateSnapshot (snapshot : JournalAdmissionSnapshot) :
    SnapshotIndexes × List SemanticDiagnostic :=
  let accounts := indexById (fun a : AccountSnapshot => a.id.value) snapshot.accounts
    "snapshot.accounts"
  let dimensions := indexById (fun d : AccountingDimensionSnapshot => d.id.value)
    snapshot.dimensions "snapshot.dimensions"
  let members := indexById (fun m : DimensionMemberSnapshot => m.id.value)
    snapshot.dimensionMembers "snapshot.dimensionMembers"
  ({ accounts := accounts.1, dimensions := dimensions.1, members := members.1 },
    accounts.2 ++ dimensions.2 ++ members.2 ++
    accountDiagnostics snapshot accounts.1 snapshot.accounts [] ++
    detectParentCycle (fun a : AccountSnapshot => a.id.value)
      (fun a => a.parentId.map (·.value)) snapshot.accounts accounts.1 "snapshot.accounts"
      .invalid_chart_or_account "ACC-014" ++
    dimensionDiagnostics snapshot snapshot.dimensions [] ++
    memberDiagnostics dimensions.1 members.1 snapshot.dimensionMembers [] ++
    detectParentCycle (fun m : DimensionMemberSnapshot => m.id.value)
      (fun m => m.parentId.map (·.value)) snapshot.dimensionMembers members.1
      "snapshot.dimensionMembers" .invalid_dimension_selection "ACC-037" ++
    requiredDimensionDiagnostics dimensions.1 snapshot.requiredDimensionIds)

/-! ## The model: the canonical value of a journal (`journal.ts` lines 494 to 576) -/

/-- `rationalValue` (`journal.ts` line 494). -/
def rationalValue (value : ExactRational) : CanonicalValue :=
  .record
    [("type", .string "ExactRational"), ("numerator", .int value.numerator),
      ("denominator", .int value.denominator)]

/-- `decimalValue` (`journal.ts` line 502). -/
def decimalValue (value : ExactDecimal) : CanonicalValue :=
  .record
    [("type", .string "ExactDecimal"), ("coefficient", .int value.coefficient),
      ("scale", .int value.scale)]

/-- `comparePostings` (`journal.ts` line 510): `.lt`, `.eq`, `.gt` for a negative number, zero and
a positive number. `Number(left.ordinal - right.ordinal)` is zero exactly when the two ordinals
are equal and has the sign of their difference otherwise. -/
def comparePostings (left right : Posting) : Ordering :=
  if left.ordinal < right.ordinal then .lt
  else if right.ordinal < left.ordinal then .gt
  else compareCanonicalText left.id.value right.id.value

/-- `[...posting.dimensionMemberIds].sort()`: the default sort of strings, by UTF-16 code unit. -/
def sortDimensionMemberIds (ids : List DimensionMemberId) : List DimensionMemberId :=
  ids.mergeSort fun left right => compareCanonicalText left.value right.value != .gt

/-- `[...journal.postings].sort(comparePostings)`. -/
def sortPostings (postings : List Posting) : List Posting :=
  postings.mergeSort fun left right => comparePostings left right != .gt

/-- `canonicalPostingValue` (`journal.ts` line 515). -/
def canonicalPostingValue (posting : Posting) : CanonicalValue :=
  .record
    [ ("type", .string "Posting"),
      ("id", .string posting.id.value),
      ("ordinal", .int posting.ordinal),
      ("accountId", .string posting.accountId.value),
      ("units", .record
        [ ("type", .string "Quantity"),
          ("canonicalNumber", rationalValue posting.units.canonicalNumber),
          ("commodityId", .string posting.units.commodityId.value),
          ("sourceNumber",
            match posting.units.sourceNumber with
            | none => .null
            | some sourceNumber => decimalValue sourceNumber) ]),
      ("bookValue", .record
        [ ("type", .string "BookValue"),
          ("amount", decimalValue posting.bookValue.amount),
          ("functionalCommodityId", .string posting.bookValue.functionalCommodityId.value) ]),
      ("transactionPrice",
        match posting.transactionPrice with
        | none => .null
        | some transactionPrice => .record
          [ ("type", .string "TransactionPrice"),
            ("unitRate", rationalValue transactionPrice.unitRate),
            ("baseCommodityId", .string transactionPrice.baseCommodityId.value),
            ("quoteCommodityId", .string transactionPrice.quoteCommodityId.value) ]),
      ("costBasis",
        match posting.costBasis with
        | none => .null
        | some costBasis => .record
          [ ("type", .string "CostBasis"),
            ("totalBasis", rationalValue costBasis.totalBasis),
            ("basisCommodityId", .string costBasis.basisCommodityId.value),
            ("sourceTotalBasis",
              match costBasis.sourceTotalBasis with
              | none => .null
              | some sourceTotalBasis => decimalValue sourceTotalBasis) ]),
      ("dimensionMemberIds",
        .array ((sortDimensionMemberIds posting.dimensionMemberIds).map fun id =>
          .string id.value)) ]

/-- A `JournalKind` as the string literal it is in the TypeScript. -/
def JournalKind.text : JournalKind → String
  | .opening => "opening"
  | .ordinary => "ordinary"
  | .adjustment => "adjustment"
  | .reversing => "reversing"
  | .closing => "closing"

/-- `canonicalJournalValue` (`journal.ts` line 560). -/
def canonicalJournalValue (journal : JournalTransaction) : CanonicalValue :=
  .record
    [ ("type", .string "JournalTransaction"),
      ("id", .string journal.id.value),
      ("kind", .string journal.kind.text),
      ("bookId", .string journal.bookId.value),
      ("functionalCommodityId", .string journal.functionalCommodityId.value),
      ("economicAt", .string journal.economicAt.value),
      ("accountingDate", .string journal.accountingDate.value),
      ("settledAt",
        match journal.settledAt with
        | none => .null
        | some settledAt => .string settledAt.value),
      ("recordedAt", .string journal.recordedAt.value),
      ("narration", .string journal.narration),
      ("postings", .array ((sortPostings journal.postings).map canonicalPostingValue)) ]

/-! ## The model: `validateCoordinateWithIndexes` and `validateAccountingCoordinate`
(`journal.ts` lines 578 to 659) -/

/-- The `kind` parameter of `validateCoordinateWithIndexes`. -/
inductive CoordinateKind where
  | posting
  | movement
  deriving DecidableEq, Repr, Inhabited

/-- The test of `journal.ts` lines 611 to 613: the member's dimension does not resolve, or is of
another book, or is not active on the accounting date, or the member is not active on it. -/
def memberInactive (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (accountingDate : LocalDate) (member : DimensionMemberSnapshot) : Bool :=
  (match indexes.dimensions.get member.dimensionId.value with
   | none => true
   | some dimension =>
     decide (dimension.bookId ≠ snapshot.bookId) ||
       !activeOn dimension.openedOn dimension.closedOn accountingDate) ||
    !activeOn member.openedOn member.closedOn accountingDate

/-- The loop over `coordinate.dimensionMemberIds` (`journal.ts` lines 603 to 623):
`selectedDimensions` at the end, and the diagnostics pushed. -/
def selectDimensions (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (accountingDate : LocalDate) (path : String) :
    List DimensionMemberId → List String → List String × List SemanticDiagnostic
  | [], selectedDimensions => (selectedDimensions, [])
  | memberId :: rest, selectedDimensions =>
    match indexes.members.get memberId.value with
    | none =>
      let result := selectDimensions snapshot indexes accountingDate path rest selectedDimensions
      (result.1,
        diagnostic .invalid_dimension_selection (path ++ ".dimensionMemberIds") ""
          ["ACC-037", "ACC-038"] :: result.2)
    | some member =>
      if memberInactive snapshot indexes accountingDate member then
        let result := selectDimensions snapshot indexes accountingDate path rest selectedDimensions
        (result.1,
          diagnostic .invalid_dimension_selection (path ++ ".dimensionMemberIds") ""
            ["ACC-026", "ACC-037"] :: result.2)
      else
        let result := selectDimensions snapshot indexes accountingDate path rest
          (member.dimensionId.value :: selectedDimensions)
        (result.1,
          (if selectedDimensions.contains member.dimensionId.value then
            [diagnostic .invalid_dimension_selection (path ++ ".dimensionMemberIds") ""
              ["ACC-037"]]
           else []) ++ result.2)

/-- `validateCoordinateWithIndexes` (`journal.ts` line 578): the diagnostics pushed. -/
def validateCoordinateWithIndexes (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (coordinate : AccountingCoordinate)
    (requiredDimensionIds : List DimensionId) (path : String) (kind : CoordinateKind) :
    List SemanticDiagnostic :=
  let selection := selectDimensions snapshot indexes coordinate.accountingDate path
    coordinate.dimensionMemberIds []
  (match indexes.accounts.get coordinate.accountId.value with
   | none =>
     [diagnostic .invalid_chart_or_account (path ++ ".accountId") "" ["ACC-014", "ACC-038"]]
   | some account =>
     (if !account.postingAllowed ||
          !activeOn account.openedOn account.closedOn coordinate.accountingDate then
       [diagnostic .invalid_chart_or_account (path ++ ".accountId") "" ["ACC-014"]]
      else []) ++
     (if decide (account.allowedCommodityIds.length > 0) &&
          !account.allowedCommodityIds.contains coordinate.unitsCommodityId then
       [diagnostic .invalid_chart_or_account
         (path ++ "." ++
           (match kind with
            | .posting => "units.commodityId"
            | .movement => "unitsCommodityId")) "" ["ACC-014"]]
      else [])) ++
  selection.2 ++
  requiredDimensionIds.flatMap fun requiredDimensionId =>
    if !selection.1.contains requiredDimensionId.value then
      [diagnostic .invalid_dimension_selection (path ++ ".dimensionMemberIds") ""
        ["ACC-011", "ACC-037"]]
    else []

/-- `validateAccountingCoordinate` (`journal.ts` line 637). `new Set(ids).size` is the number of
distinct identifiers. -/
def validateAccountingCoordinate (snapshot : JournalAdmissionSnapshot)
    (coordinate : AccountingCoordinate) (requiredDimensionIds : List DimensionId) :
    List SemanticDiagnostic :=
  let validated := validateSnapshot snapshot
  validated.2 ++
  (if coordinate.bookId ≠ snapshot.bookId then
    [diagnostic .book_isolation_violation "coordinate.bookId" "" ["ACC-026"]]
   else []) ++
  (if coordinate.functionalCommodityId ≠ snapshot.functionalCommodityId then
    [diagnostic .monetary_type_mismatch "coordinate.functionalCommodityId" ""
      ["ACC-002", "ACC-026"]]
   else []) ++
  (if decide (requiredDimensionIds.eraseDups.length ≠ requiredDimensionIds.length) ||
        requiredDimensionIds.any (fun id => !validated.1.dimensions.has id.value) then
    [diagnostic .invalid_dimension_selection "coordinate.requiredDimensionIds" ""
      ["ACC-011", "ACC-037", "ACC-038"]]
   else []) ++
  validateCoordinateWithIndexes snapshot validated.1 coordinate requiredDimensionIds "coordinate"
    .movement

/-! ## The model: `admitJournal` (`journal.ts` lines 661 to 873) -/

/-- `source !== undefined && !source.toRational().equals(canonical)`, the test of the two "source
decimal describes a different exact value" diagnostics (`journal.ts` lines 780 to 785 and 796 to
801). `.error` where `toRational` throws. -/
def sourceDiffers (source : Option ExactDecimal) (canonical : ExactRational) :
    Except NumErr Bool :=
  match source with
  | none => .ok false
  | some source =>
    match source.toRational with
    | .error code => .error code
    | .ok rational => .ok (!rational.equals canonical)

/-- `posting.costBasis?.sourceTotalBasis !== undefined &&
!posting.costBasis.sourceTotalBasis.toRational().equals(posting.costBasis.totalBasis)`
(`journal.ts` lines 799 and 800). -/
def basisDiffers (costBasis : Option CostBasis) : Except NumErr Bool :=
  match costBasis with
  | none => .ok false
  | some costBasis => sourceDiffers costBasis.sourceTotalBasis costBasis.totalBasis

/-- `snapshot.requiredDimensionIdsByPosting?.[posting.id] ?? snapshot.requiredDimensionIds`
(`journal.ts` line 843), as a lookup among the object's OWN properties. The TypeScript also finds
inherited properties: see `LookupDiverges`. -/
def requiredDimensionsFor (snapshot : JournalAdmissionSnapshot) (posting : Posting) :
    List DimensionId :=
  match snapshot.requiredDimensionIdsByPosting with
  | none => snapshot.requiredDimensionIds
  | some byPosting =>
    match byPosting.find? (·.1 == posting.id.value) with
    | none => snapshot.requiredDimensionIds
    | some entry => entry.2

/-- The coordinate `admitJournal` builds for a posting (`journal.ts` lines 844 to 848). -/
def postingCoordinate (journal : JournalTransaction) (posting : Posting) : AccountingCoordinate :=
  { bookId := journal.bookId
    functionalCommodityId := journal.functionalCommodityId
    accountingDate := journal.accountingDate
    accountId := posting.accountId
    unitsCommodityId := posting.units.commodityId
    dimensionMemberIds := posting.dimensionMemberIds }

/-- The diagnostics one turn of the loop over `journal.postings` pushes, in order, given the
outcome of the two tests that convert a decimal (`journal.ts` lines 704 to 848). The six
`instanceof` tests pass, so the diagnostic of lines 724 to 731 is absent. -/
def postingDiagnostics (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (journal : JournalTransaction) (path : String) (posting : Posting)
    (postingIds : List String) (ordinals : List Int) (unitsDiffer basisDiffers : Bool) :
    List SemanticDiagnostic :=
  (if postingIds.contains posting.id.value then
    [diagnostic .invalid_journal_structure (path ++ ".id") "" ["ACC-018", "ACC-038"]]
   else []) ++
  (if decide (posting.ordinal < 0) || ordinals.contains posting.ordinal then
    [diagnostic .invalid_journal_structure (path ++ ".ordinal") "" ["ACC-018", "ACC-019"]]
   else []) ++
  (if posting.bookValue.amount.isZero then
    [diagnostic .invalid_journal_structure (path ++ ".bookValue.amount") ""
      ["ACC-003", "ACC-018"]]
   else []) ++
  (if posting.bookValue.functionalCommodityId ≠ snapshot.functionalCommodityId then
    [diagnostic .monetary_type_mismatch (path ++ ".bookValue.functionalCommodityId") ""
      ["ACC-002", "ACC-003", "ACC-026"]]
   else []) ++
  (if unitsDiffer then
    [diagnostic .invalid_exact_number (path ++ ".units") "" ["ACC-001", "ACC-002"]]
   else []) ++
  (if basisDiffers then
    [diagnostic .invalid_exact_number (path ++ ".costBasis") "" ["ACC-001", "ACC-023"]]
   else []) ++
  (if (match posting.transactionPrice with
       | none => false
       | some transactionPrice =>
         transactionPrice.unitRate.isZero || transactionPrice.unitRate.isNegative ||
           decide (transactionPrice.baseCommodityId ≠ posting.units.commodityId) ||
           decide (transactionPrice.quoteCommodityId ≠ snapshot.functionalCommodityId)) then
    [diagnostic .monetary_type_mismatch (path ++ ".transactionPrice") ""
      ["ACC-002", "ACC-012", "ACC-026"]]
   else []) ++
  (if (match posting.costBasis with
       | none => false
       | some costBasis =>
         decide (costBasis.basisCommodityId ≠ snapshot.functionalCommodityId)) then
    [diagnostic .monetary_type_mismatch (path ++ ".costBasis.basisCommodityId") ""
      ["ACC-002", "ACC-023", "ACC-026"]]
   else []) ++
  validateCoordinateWithIndexes snapshot indexes (postingCoordinate journal posting)
    (requiredDimensionsFor snapshot posting) path .posting

/-- One turn of the loop over `journal.postings` (`journal.ts` lines 703 to 849): the new balance
and the diagnostics pushed, or `.error` where an exact-number operation throws. The operations
that can throw run in the TypeScript's order: the amount's `toRational`, `balance.add`, the
source number's `toRational`, the source basis's `toRational`. -/
def admitPosting (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (journal : JournalTransaction) (index : Nat) (posting : Posting)
    (postingIds : List String) (ordinals : List Int) (balance : ExactRational) :
    Except NumErr (ExactRational × List SemanticDiagnostic) :=
  match posting.bookValue.amount.toRational with
  | .error code => .error code
  | .ok amount =>
    match balance.add amount with
    | .error code => .error code
    | .ok balance =>
      match sourceDiffers posting.units.sourceNumber posting.units.canonicalNumber with
      | .error code => .error code
      | .ok unitsDiffer =>
        match basisDiffers posting.costBasis with
        | .error code => .error code
        | .ok basisDiffers =>
          .ok (balance,
            postingDiagnostics snapshot indexes journal
              ("journal.postings[" ++ toString index ++ "]") posting postingIds ordinals
              unitsDiffer basisDiffers)

/-- The loop over `journal.postings`: the index of the next posting, the postings left, the two
`Set`s and the balance so far; then the balance at the end and the diagnostics pushed. -/
def admitPostings (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (journal : JournalTransaction) :
    Nat → List Posting → List String → List Int → ExactRational →
      Except NumErr (ExactRational × List SemanticDiagnostic)
  | _, [], _, _, balance => .ok (balance, [])
  | index, posting :: rest, postingIds, ordinals, balance =>
    match admitPosting snapshot indexes journal index posting postingIds ordinals balance with
    | .error code => .error code
    | .ok step =>
      match admitPostings snapshot indexes journal (index + 1) rest
          (posting.id.value :: postingIds) (posting.ordinal :: ordinals) step.1 with
      | .error code => .error code
      | .ok result => .ok (result.1, step.2 ++ result.2)

/-- The three diagnostics `admitJournal` pushes before its loop (`journal.ts` lines 668 to
697). -/
def journalHeaderDiagnostics (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) : List SemanticDiagnostic :=
  (if journal.bookId ≠ snapshot.bookId then
    [diagnostic .book_isolation_violation "journal.bookId" "" ["ACC-026"]]
   else []) ++
  (if journal.functionalCommodityId ≠ snapshot.functionalCommodityId then
    [diagnostic .monetary_type_mismatch "journal.functionalCommodityId" ""
      ["ACC-002", "ACC-026"]]
   else []) ++
  (if journal.postings.length < 2 then
    [diagnostic .invalid_journal_structure "journal.postings" "" ["ACC-018"]]
   else [])

/-- Every diagnostic of `admitJournal` in order, given the balance and the diagnostics of the
loop. -/
def journalDiagnostics (snapshot : JournalAdmissionSnapshot) (journal : JournalTransaction)
    (loop : ExactRational × List SemanticDiagnostic) : List SemanticDiagnostic :=
  (validateSnapshot snapshot).2 ++ journalHeaderDiagnostics snapshot journal ++ loop.2 ++
  (if !loop.1.isZero then
    [diagnostic .journal_imbalance "journal.postings" "" ["ACC-003"]]
   else [])

/-- `admitJournal` (`journal.ts` line 661). `.error` where the TypeScript throws an
`ExactNumberError`. -/
def admitJournal (snapshot : JournalAdmissionSnapshot) (journal : JournalTransaction) :
    Except NumErr JournalAdmissionResult :=
  match admitPostings snapshot (validateSnapshot snapshot).1 journal 0 journal.postings [] []
      ExactRational.zero with
  | .error code => .error code
  | .ok loop =>
    if (journalDiagnostics snapshot journal loop).length > 0 then
      .ok (.rejected (journalDiagnostics snapshot journal loop))
    else .ok (.admitted (hashCanonical (canonicalJournalValue journal)))

/-! ## Meaning: constructible postings and journals -/

/-- What every posting the TypeScript can construct satisfies: each of its exact numbers is
constructible. -/
structure Posting.WF (posting : Posting) : Prop where
  amount : posting.bookValue.amount.WF
  canonicalNumber : posting.units.canonicalNumber.WF
  sourceNumber : ∀ source, posting.units.sourceNumber = some source → source.WF
  unitRate : ∀ price, posting.transactionPrice = some price → price.unitRate.WF
  totalBasis : ∀ basis, posting.costBasis = some basis → basis.totalBasis.WF
  sourceTotalBasis : ∀ basis source, posting.costBasis = some basis →
    basis.sourceTotalBasis = some source → source.WF

/-- A journal is constructible when each of its postings is. -/
def JournalTransaction.WF (journal : JournalTransaction) : Prop :=
  ∀ posting ∈ journal.postings, posting.WF

/-- The total of the book values of some postings, as a number. -/
def bookValueTotal (postings : List Posting) : ℚ :=
  (postings.map (·.bookValue.amount.toRat)).sum

/-! ## Laws: an admitted journal balances -/

/-- One turn of the loop succeeds exactly when its four exact-number operations do, and then
gives the new balance and the diagnostics of `postingDiagnostics`. -/
theorem admitPosting_eq_ok_iff (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (journal : JournalTransaction) (index : Nat) (posting : Posting) (postingIds : List String)
    (ordinals : List Int) (balance : ExactRational)
    (step : ExactRational × List SemanticDiagnostic) :
    admitPosting snapshot indexes journal index posting postingIds ordinals balance = .ok step ↔
      ∃ amount next unitsDiffer basisDiffer,
        posting.bookValue.amount.toRational = .ok amount ∧ balance.add amount = .ok next ∧
        sourceDiffers posting.units.sourceNumber posting.units.canonicalNumber = .ok unitsDiffer ∧
        basisDiffers posting.costBasis = .ok basisDiffer ∧
        step = (next, postingDiagnostics snapshot indexes journal
          ("journal.postings[" ++ toString index ++ "]") posting postingIds ordinals unitsDiffer
          basisDiffer) := by
  unfold admitPosting
  constructor
  · intro h
    split at h
    · exact absurd h (by simp)
    · rename_i amount h1
      split at h
      · exact absurd h (by simp)
      · rename_i next h2
        split at h
        · exact absurd h (by simp)
        · rename_i unitsDiffer h3
          split at h
          · exact absurd h (by simp)
          · rename_i basisDiffer h4
            exact ⟨amount, next, unitsDiffer, basisDiffer, h1, h2, h3, h4, (Except.ok.inj h).symm⟩
  · rintro ⟨amount, next, unitsDiffer, basisDiffer, h1, h2, h3, h4, rfl⟩
    simp only [h1, h2, h3, h4]

/-- One turn of the loop adds the posting's book value to the balance. -/
theorem admitPosting_balance {snapshot : JournalAdmissionSnapshot} {indexes : SnapshotIndexes}
    {journal : JournalTransaction} {index : Nat} {posting : Posting} {postingIds : List String}
    {ordinals : List Int} {balance : ExactRational}
    {step : ExactRational × List SemanticDiagnostic} (hb : balance.WF)
    (hp : posting.bookValue.amount.WF)
    (h : admitPosting snapshot indexes journal index posting postingIds ordinals balance =
      .ok step) :
    step.1.WF ∧ step.1.toRat = balance.toRat + posting.bookValue.amount.toRat := by
  obtain ⟨amount, next, _, _, h1, h2, -, -, rfl⟩ := (admitPosting_eq_ok_iff ..).mp h
  obtain ⟨hw, hr⟩ := ExactDecimal.toRational_ok hp h1
  obtain ⟨hw', hr'⟩ := ExactRational.add_ok hb hw h2
  exact ⟨hw', by rw [hr', hr]⟩

/-- The loop adds the book values of the postings it reads to the balance. -/
theorem admitPostings_balance {snapshot : JournalAdmissionSnapshot} {indexes : SnapshotIndexes}
    {journal : JournalTransaction} :
    ∀ {postings : List Posting} {index : Nat} {postingIds : List String} {ordinals : List Int}
      {balance : ExactRational} {result : ExactRational × List SemanticDiagnostic},
      balance.WF → (∀ posting ∈ postings, posting.bookValue.amount.WF) →
      admitPostings snapshot indexes journal index postings postingIds ordinals balance =
        .ok result →
      result.1.WF ∧ result.1.toRat = balance.toRat + bookValueTotal postings := by
  intro postings
  induction postings with
  | nil =>
    intro index postingIds ordinals balance result hb _ h
    simp only [admitPostings, Except.ok.injEq] at h
    subst h
    exact ⟨hb, by simp [bookValueTotal]⟩
  | cons posting rest ih =>
    intro index postingIds ordinals balance result hb hp h
    unfold admitPostings at h
    cases hstep : admitPosting snapshot indexes journal index posting postingIds ordinals balance with
    | error code => simp [hstep] at h
    | ok step =>
      simp only [hstep] at h
      cases hrest : admitPostings snapshot indexes journal (index + 1) rest
          (posting.id.value :: postingIds) (posting.ordinal :: ordinals) step.1 with
      | error code => simp [hrest] at h
      | ok tail =>
        simp only [hrest, Except.ok.injEq] at h
        subst h
        obtain ⟨hw, hr⟩ := admitPosting_balance hb (hp posting (by simp)) hstep
        obtain ⟨hw', hr'⟩ := ih hw (fun q hq => hp q (by simp [hq])) hrest
        refine ⟨hw', ?_⟩
        simp only [hr', hr, bookValueTotal, List.map_cons, List.sum_cons]
        ring

/-- The loop of `admitJournal` as it is started: at the first posting, with two empty `Set`s and a
zero balance. -/
def admitLoop (snapshot : JournalAdmissionSnapshot) (journal : JournalTransaction) :
    Except NumErr (ExactRational × List SemanticDiagnostic) :=
  admitPostings snapshot (validateSnapshot snapshot).1 journal 0 journal.postings [] []
    ExactRational.zero

/-- A journal is admitted exactly when no exact-number operation of the loop throws and no
diagnostic at all is pushed, and the hash returned is the hash of its canonical value. -/
theorem admitJournal_eq_admitted_iff (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) (hash : ContentHash) :
    admitJournal snapshot journal = .ok (.admitted hash) ↔
      ∃ loop, admitLoop snapshot journal = .ok loop ∧
        journalDiagnostics snapshot journal loop = [] ∧
        hash = hashCanonical (canonicalJournalValue journal) := by
  unfold admitJournal admitLoop
  cases admitPostings snapshot (validateSnapshot snapshot).1 journal 0 journal.postings [] []
      ExactRational.zero with
  | error code => simp
  | ok loop =>
    simp only [Except.ok.injEq, exists_eq_left']
    by_cases hd : journalDiagnostics snapshot journal loop = []
    · simp [hd, eq_comm]
    · have : (journalDiagnostics snapshot journal loop).length > 0 :=
        List.length_pos_iff.mpr hd
      simp [hd, this]

/-- A journal is rejected exactly when no exact-number operation of the loop throws and at least
one diagnostic is pushed, and the diagnostics returned are all that were pushed, in order. -/
theorem admitJournal_eq_rejected_iff (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) (diagnostics : List SemanticDiagnostic) :
    admitJournal snapshot journal = .ok (.rejected diagnostics) ↔
      ∃ loop, admitLoop snapshot journal = .ok loop ∧
        diagnostics = journalDiagnostics snapshot journal loop ∧ diagnostics ≠ [] := by
  unfold admitJournal admitLoop
  cases admitPostings snapshot (validateSnapshot snapshot).1 journal 0 journal.postings [] []
      ExactRational.zero with
  | error code => simp
  | ok loop =>
    simp only [Except.ok.injEq, exists_eq_left']
    by_cases hd : journalDiagnostics snapshot journal loop = []
    · simp only [hd, List.length_nil, gt_iff_lt, lt_self_iff_false, ↓reduceIte, ne_eq]
      constructor
      · intro h; cases h
      · rintro ⟨h1, h2⟩; exact absurd h1 h2
    · have : (journalDiagnostics snapshot journal loop).length > 0 :=
        List.length_pos_iff.mpr hd
      simp only [this, ↓reduceIte, Except.ok.injEq, JournalAdmissionResult.rejected.injEq]
      constructor
      · rintro rfl; exact ⟨rfl, hd⟩
      · rintro ⟨rfl, -⟩; rfl

/-- `admitJournal` throws exactly when an exact-number operation of its loop does, with that
code. -/
theorem admitJournal_eq_error_iff (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) (code : NumErr) :
    admitJournal snapshot journal = .error code ↔ admitLoop snapshot journal = .error code := by
  unfold admitJournal admitLoop
  cases admitPostings snapshot (validateSnapshot snapshot).1 journal 0 journal.postings [] []
      ExactRational.zero with
  | error code' => simp
  | ok loop =>
    simp only [reduceCtorEq, iff_false]
    split <;> simp

/-- No diagnostic is pushed exactly when the snapshot gives none, the journal's own three checks
give none, the loop gives none and the balance at the end is zero. -/
theorem journalDiagnostics_eq_nil_iff (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) (loop : ExactRational × List SemanticDiagnostic) :
    journalDiagnostics snapshot journal loop = [] ↔
      (validateSnapshot snapshot).2 = [] ∧ journalHeaderDiagnostics snapshot journal = [] ∧
        loop.2 = [] ∧ loop.1.isZero = true := by
  unfold journalDiagnostics
  cases loop.1.isZero <;> simp

/-- The balance the loop of `admitJournal` ends with is the total of the book values. -/
theorem admitLoop_balance {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {loop : ExactRational × List SemanticDiagnostic}
    (hw : ∀ posting ∈ journal.postings, posting.bookValue.amount.WF)
    (h : admitLoop snapshot journal = .ok loop) :
    loop.1.WF ∧ loop.1.toRat = bookValueTotal journal.postings := by
  obtain ⟨hwf, hr⟩ := admitPostings_balance ExactRational.zero_wf hw h
  exact ⟨hwf, by rw [hr, ExactRational.zero_toRat, zero_add]⟩

/-- **An admitted journal balances**: when `admitJournal` admits a journal whose book values are
constructible numbers, those book values add up to exactly zero. -/
theorem admitted_journal_balances {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (hw : ∀ posting ∈ journal.postings, posting.bookValue.amount.WF)
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    (journal.postings.map (·.bookValue.amount.toRat)).sum = 0 := by
  obtain ⟨loop, hloop, hnil, -⟩ := (admitJournal_eq_admitted_iff ..).mp h
  obtain ⟨hwf, hr⟩ := admitLoop_balance hw hloop
  have hz := ((journalDiagnostics_eq_nil_iff ..).mp hnil).2.2.2
  have := (ExactRational.isZero_iff hwf).mp hz
  rw [hr] at this
  exact this

/-- The headline with the hypothesis written as the constructibility of the journal. -/
theorem admitted_journal_balances_of_wf {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash} (hw : journal.WF)
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    (journal.postings.map (·.bookValue.amount.toRat)).sum = 0 :=
  admitted_journal_balances (fun posting hp => (hw posting hp).amount) h

/-! ## Laws of the indexes

An index built by `indexById` answers `get` with the first value of the list that has the
identifier, and `indexById` pushes no diagnostic exactly when the identifiers are distinct. -/

theorem IdIndex.get_append_singleton {T : Type} (index : IdIndex T) (key : String) (value : T)
    (lookup : String) :
    IdIndex.get (index ++ [(key, value)]) lookup =
      (index.get lookup).or (if key == lookup then some value else none) := by
  unfold IdIndex.get
  rw [List.find?_append]
  cases h : List.find? (fun x => x.1 == lookup) index with
  | some found => simp
  | none =>
    by_cases hk : key == lookup
    · simp [hk]
    · simp [hk]

theorem find?_isSome_eq_any {α : Type} (p : α → Bool) (l : List α) :
    (l.find? p).isSome = l.any p := by
  induction l with
  | nil => rfl
  | cons a l ih => by_cases h : p a <;> simp [h, ih]

theorem IdIndex.has_eq_isSome_get {T : Type} (index : IdIndex T) (key : String) :
    index.has key = (index.get key).isSome := by
  unfold IdIndex.has IdIndex.get
  rw [Option.isSome_map, find?_isSome_eq_any]

/-- `get` on the index `indexByIdLoop` returns: what the index it started with answered, and
otherwise the first of the values with that identifier. -/
theorem indexByIdLoop_get {T : Type} (idOf : T → String) (path : String) (key : String) :
    ∀ (values : List T) (index : IdIndex T),
      (indexByIdLoop idOf path values index).1.get key =
        (index.get key).or (values.find? (fun value => idOf value == key)) := by
  intro values
  induction values with
  | nil => intro index; simp [indexByIdLoop]
  | cons value rest ih =>
    intro index
    unfold indexByIdLoop
    by_cases hhas : index.has (idOf value) = true
    · simp only [hhas, ↓reduceIte, ih, List.find?_cons]
      by_cases hk : idOf value == key
      · have hk' : idOf value = key := by simpa using hk
        rw [IdIndex.has_eq_isSome_get, hk'] at hhas
        obtain ⟨found, hfound⟩ := Option.isSome_iff_exists.mp hhas
        simp [hfound]
      · simp [hk]
    · simp only [hhas, Bool.false_eq_true, ↓reduceIte, ih, IdIndex.get_append_singleton,
        List.find?_cons]
      by_cases hk : idOf value == key
      · simp [hk]
      · simp [hk]

/-- An index built by `indexById` answers `get` with the first value that has the identifier. -/
theorem indexById_get {T : Type} (idOf : T → String) (values : List T) (path key : String) :
    (indexById idOf values path).1.get key = values.find? (fun value => idOf value == key) := by
  unfold indexById
  rw [indexByIdLoop_get]
  simp [IdIndex.get]

/-- An index built by `indexById` has an identifier exactly when one of the values has it. -/
theorem indexById_has {T : Type} (idOf : T → String) (values : List T) (path key : String) :
    (indexById idOf values path).1.has key = values.any (fun value => idOf value == key) := by
  rw [IdIndex.has_eq_isSome_get, indexById_get, find?_isSome_eq_any]

theorem indexByIdLoop_diagnostics_eq_nil_iff {T : Type} (idOf : T → String) (path : String) :
    ∀ (values : List T) (index : IdIndex T),
      (indexByIdLoop idOf path values index).2 = [] ↔
        (values.map idOf).Nodup ∧ ∀ value ∈ values, index.has (idOf value) = false := by
  intro values
  induction values with
  | nil => intro index; simp [indexByIdLoop]
  | cons value rest ih =>
    intro index
    unfold indexByIdLoop
    by_cases hhas : index.has (idOf value) = true
    · simp [hhas]
    · have hfalse : index.has (idOf value) = false := by simpa using hhas
      simp only [hhas, Bool.false_eq_true, ↓reduceIte, ih, List.map_cons, List.nodup_cons,
        List.mem_map, not_exists, not_and, List.mem_cons, forall_eq_or_imp, true_and]
      have key : ∀ other : T, IdIndex.has (index ++ [(idOf value, value)]) (idOf other) =
          (index.has (idOf other) || (idOf value == idOf other)) := by
        intro other
        simp [IdIndex.has]
      constructor
      · rintro ⟨hnodup, hrest⟩
        refine ⟨⟨?_, hnodup⟩, ?_⟩
        · intro other hother heq
          have := hrest other hother
          rw [key] at this
          simp [heq] at this
        · intro other hother
          have := hrest other hother
          rw [key] at this
          simpa using (Bool.or_eq_false_iff.mp this).1
      · rintro ⟨⟨hfresh, hnodup⟩, hrest⟩
        refine ⟨hnodup, ?_⟩
        intro other hother
        rw [key, hrest other hother]
        simpa using fun heq => hfresh other hother heq.symm

/-- `indexById` pushes no diagnostic exactly when no identifier is used twice. -/
theorem indexById_diagnostics_eq_nil_iff {T : Type} (idOf : T → String) (values : List T)
    (path : String) : (indexById idOf values path).2 = [] ↔ (values.map idOf).Nodup := by
  unfold indexById
  rw [indexByIdLoop_diagnostics_eq_nil_iff]
  simp [IdIndex.has]

/-! ## Laws of `validateCoordinateWithIndexes` -/

/-- The dimension a selected member adds to `selectedDimensions`: `none` when the loop pushes a
diagnostic for the member and continues (it does not resolve, or `memberInactive`). -/
def selectedDimension (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (accountingDate : LocalDate) (memberId : DimensionMemberId) : Option String :=
  match indexes.members.get memberId.value with
  | none => none
  | some member =>
    if memberInactive snapshot indexes accountingDate member then none
    else some member.dimensionId.value

/-- `selectedDimensions` at the end of the loop holds what it held and the dimension of every
member that resolved and was active. -/
theorem selectDimensions_mem (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (accountingDate : LocalDate) (path : String) (dimension : String) :
    ∀ (memberIds : List DimensionMemberId) (selected : List String),
      dimension ∈ (selectDimensions snapshot indexes accountingDate path memberIds selected).1 ↔
        dimension ∈ selected ∨
          dimension ∈ memberIds.filterMap (selectedDimension snapshot indexes accountingDate) := by
  intro memberIds
  induction memberIds with
  | nil => intro selected; simp [selectDimensions]
  | cons memberId rest ih =>
    intro selected
    unfold selectDimensions
    cases hget : indexes.members.get memberId.value with
    | none => simp [ih, selectedDimension, hget]
    | some member =>
      by_cases hin : memberInactive snapshot indexes accountingDate member = true
      · simp [ih, selectedDimension, hget, hin]
      · simp only [hin, Bool.false_eq_true, ↓reduceIte, ih, List.mem_cons, List.filterMap_cons,
          selectedDimension, hget]
        tauto

/-- The loop over the members pushes no diagnostic exactly when every member resolves and is
active, no two of them are of one dimension, and none is of a dimension already selected. -/
theorem selectDimensions_diagnostics_eq_nil_iff (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (accountingDate : LocalDate) (path : String) :
    ∀ (memberIds : List DimensionMemberId) (selected : List String),
      (selectDimensions snapshot indexes accountingDate path memberIds selected).2 = [] ↔
        (∀ memberId ∈ memberIds,
          (selectedDimension snapshot indexes accountingDate memberId).isSome = true) ∧
        (memberIds.filterMap (selectedDimension snapshot indexes accountingDate)).Nodup ∧
        ∀ dimension ∈ memberIds.filterMap (selectedDimension snapshot indexes accountingDate),
          dimension ∉ selected := by
  intro memberIds
  induction memberIds with
  | nil => intro selected; simp [selectDimensions]
  | cons memberId rest ih =>
    intro selected
    unfold selectDimensions
    cases hget : indexes.members.get memberId.value with
    | none => simp [selectedDimension, hget]
    | some member =>
      by_cases hin : memberInactive snapshot indexes accountingDate member = true
      · simp [selectedDimension, hget, hin]
      · have hsel : selectedDimension snapshot indexes accountingDate memberId =
            some member.dimensionId.value := by simp [selectedDimension, hget, hin]
        simp only [hin, Bool.false_eq_true, ↓reduceIte, List.append_eq_nil_iff, ih,
          List.mem_cons, forall_eq_or_imp, hsel, Option.isSome_some, true_and,
          List.filterMap_cons, List.nodup_cons, ite_eq_right_iff, List.cons_ne_nil, imp_false,
          List.contains_iff_mem, not_or]
        constructor
        · rintro ⟨hnot, hall, hnodup, hfresh⟩
          exact ⟨hall, ⟨fun hmem => (hfresh _ hmem).1 rfl, hnodup⟩, hnot,
            fun d hd => (hfresh d hd).2⟩
        · rintro ⟨hall, ⟨hnotin, hnodup⟩, hnot, hfresh⟩
          exact ⟨hnot, hall, hnodup, fun d hd => ⟨fun heq => hnotin (heq ▸ hd), hfresh d hd⟩⟩

/-- What `validateCoordinateWithIndexes` asks of a coordinate, in terms of the indexes. -/
structure CoordinateChecks (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (coordinate : AccountingCoordinate) (requiredDimensionIds : List DimensionId) : Prop where
  account : ∃ account, indexes.accounts.get coordinate.accountId.value = some account ∧
    account.postingAllowed = true ∧
    activeOn account.openedOn account.closedOn coordinate.accountingDate = true ∧
    (account.allowedCommodityIds = [] ∨
      coordinate.unitsCommodityId ∈ account.allowedCommodityIds)
  members : ∀ memberId ∈ coordinate.dimensionMemberIds,
    (selectedDimension snapshot indexes coordinate.accountingDate memberId).isSome = true
  one_member_a_dimension : (coordinate.dimensionMemberIds.filterMap
    (selectedDimension snapshot indexes coordinate.accountingDate)).Nodup
  required : ∀ requiredDimensionId ∈ requiredDimensionIds,
    requiredDimensionId.value ∈ coordinate.dimensionMemberIds.filterMap
      (selectedDimension snapshot indexes coordinate.accountingDate)

/-- `validateCoordinateWithIndexes` pushes no diagnostic exactly when the account resolves, allows
posting, is active on the accounting date and admits the commodity, every member resolves and is
active with its dimension in the book, no two members are of one dimension, and every required
dimension has a member. -/
theorem validateCoordinateWithIndexes_eq_nil_iff (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (coordinate : AccountingCoordinate)
    (requiredDimensionIds : List DimensionId) (path : String) (kind : CoordinateKind) :
    validateCoordinateWithIndexes snapshot indexes coordinate requiredDimensionIds path kind =
        [] ↔
      CoordinateChecks snapshot indexes coordinate requiredDimensionIds := by
  unfold validateCoordinateWithIndexes
  simp only [List.append_eq_nil_iff, selectDimensions_diagnostics_eq_nil_iff,
    List.flatMap_eq_nil_iff, ite_eq_right_iff, List.cons_ne_nil, imp_false,
    Bool.not_eq_true', Bool.not_eq_false, List.contains_iff_mem, selectDimensions_mem,
    List.not_mem_nil, false_or, not_false_eq_true, implies_true, and_true]
  constructor
  · rintro ⟨⟨haccount, hmembers, hnodup⟩, hrequired⟩
    refine ⟨?_, hmembers, hnodup, hrequired⟩
    cases hget : indexes.accounts.get coordinate.accountId.value with
    | none => simp [hget] at haccount
    | some account =>
      simp only [hget, List.append_eq_nil_iff, ite_eq_right_iff, List.cons_ne_nil, imp_false,
        Bool.or_eq_true, Bool.not_eq_true', not_or, Bool.not_eq_false, Bool.and_eq_true,
        decide_eq_true_eq, not_and, List.contains_iff_mem] at haccount
      refine ⟨account, rfl, haccount.1.1, haccount.1.2, ?_⟩
      by_cases hempty : account.allowedCommodityIds = []
      · exact Or.inl hempty
      · exact Or.inr (haccount.2 (List.length_pos_iff.mpr hempty))
  · rintro ⟨⟨account, hget, hallowed, hactive, hcommodity⟩, hmembers, hnodup, hrequired⟩
    refine ⟨⟨?_, hmembers, hnodup⟩, hrequired⟩
    simp only [hget, hallowed, hactive, List.append_eq_nil_iff, ite_eq_right_iff,
      List.cons_ne_nil, imp_false, Bool.not_true, Bool.or_self, Bool.false_eq_true,
      not_false_eq_true, Bool.and_eq_true, decide_eq_true_eq, Bool.not_eq_true', not_and,
      Bool.not_eq_false, List.contains_iff_mem, true_and]
    intro hpos
    rcases hcommodity with hempty | hmem
    · simp [hempty] at hpos
    · exact hmem

/-! ## Laws of the loop over the postings -/

/-- What one turn of the loop asks of a posting whatever the postings before it, in terms of the
indexes: every diagnostic of the turn but the two about a duplicate. -/
structure PostingChecks (snapshot : JournalAdmissionSnapshot) (indexes : SnapshotIndexes)
    (journal : JournalTransaction) (posting : Posting) : Prop where
  value_nonzero : posting.bookValue.amount.isZero = false
  value_commodity : posting.bookValue.functionalCommodityId = snapshot.functionalCommodityId
  units_agree :
    sourceDiffers posting.units.sourceNumber posting.units.canonicalNumber = .ok false
  basis_agrees : basisDiffers posting.costBasis = .ok false
  price : ∀ price, posting.transactionPrice = some price →
    price.unitRate.isZero = false ∧ price.unitRate.isNegative = false ∧
      price.baseCommodityId = posting.units.commodityId ∧
      price.quoteCommodityId = snapshot.functionalCommodityId
  basis_commodity : ∀ basis, posting.costBasis = some basis →
    basis.basisCommodityId = snapshot.functionalCommodityId
  coordinate : CoordinateChecks snapshot indexes (postingCoordinate journal posting)
    (requiredDimensionsFor snapshot posting)

/-- One turn of the loop pushes no diagnostic exactly when the posting's identifier and ordinal
are new, the ordinal is not negative, and the posting passes every other check. -/
theorem postingDiagnostics_eq_nil_iff (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (journal : JournalTransaction) (path : String)
    (posting : Posting) (postingIds : List String) (ordinals : List Int)
    (unitsDiffer basisDiffer : Bool) :
    postingDiagnostics snapshot indexes journal path posting postingIds ordinals unitsDiffer
        basisDiffer = [] ↔
      posting.id.value ∉ postingIds ∧ 0 ≤ posting.ordinal ∧ posting.ordinal ∉ ordinals ∧
      posting.bookValue.amount.isZero = false ∧
      posting.bookValue.functionalCommodityId = snapshot.functionalCommodityId ∧
      unitsDiffer = false ∧ basisDiffer = false ∧
      (∀ price, posting.transactionPrice = some price →
        price.unitRate.isZero = false ∧ price.unitRate.isNegative = false ∧
          price.baseCommodityId = posting.units.commodityId ∧
          price.quoteCommodityId = snapshot.functionalCommodityId) ∧
      (∀ basis, posting.costBasis = some basis →
        basis.basisCommodityId = snapshot.functionalCommodityId) ∧
      CoordinateChecks snapshot indexes (postingCoordinate journal posting)
        (requiredDimensionsFor snapshot posting) := by
  unfold postingDiagnostics
  simp only [List.append_eq_nil_iff, validateCoordinateWithIndexes_eq_nil_iff, ite_eq_right_iff,
    List.cons_ne_nil, imp_false, List.contains_iff_mem, Bool.or_eq_true, decide_eq_true_eq,
    not_or, not_lt, Bool.not_eq_true, ne_eq, not_not, and_assoc]
  have hprice : (match posting.transactionPrice with
      | none => false
      | some transactionPrice =>
        transactionPrice.unitRate.isZero || transactionPrice.unitRate.isNegative ||
          decide (¬transactionPrice.baseCommodityId = posting.units.commodityId) ||
          decide (¬transactionPrice.quoteCommodityId = snapshot.functionalCommodityId)) = false ↔
      ∀ price, posting.transactionPrice = some price →
        price.unitRate.isZero = false ∧ price.unitRate.isNegative = false ∧
          price.baseCommodityId = posting.units.commodityId ∧
          price.quoteCommodityId = snapshot.functionalCommodityId := by
    cases posting.transactionPrice with
    | none => simp
    | some price => simp [and_assoc]
  have hbasis : (match posting.costBasis with
      | none => false
      | some costBasis =>
        decide (¬costBasis.basisCommodityId = snapshot.functionalCommodityId)) = false ↔
      ∀ basis, posting.costBasis = some basis →
        basis.basisCommodityId = snapshot.functionalCommodityId := by
    cases posting.costBasis with
    | none => simp
    | some basis => simp
  rw [hprice, hbasis]

/-- The loop pushes no diagnostic exactly when every posting it reads passes its own checks, the
identifiers are distinct and new, and the ordinals are not negative, distinct and new. -/
theorem admitPostings_diagnostics_eq_nil_iff {snapshot : JournalAdmissionSnapshot}
    {indexes : SnapshotIndexes} {journal : JournalTransaction} :
    ∀ {postings : List Posting} {index : Nat} {postingIds : List String} {ordinals : List Int}
      {balance : ExactRational} {result : ExactRational × List SemanticDiagnostic},
      admitPostings snapshot indexes journal index postings postingIds ordinals balance =
        .ok result →
      (result.2 = [] ↔
        (∀ posting ∈ postings, PostingChecks snapshot indexes journal posting) ∧
        (postings.map (·.id.value)).Nodup ∧
        (∀ posting ∈ postings, posting.id.value ∉ postingIds) ∧
        (∀ posting ∈ postings, 0 ≤ posting.ordinal) ∧
        (postings.map (·.ordinal)).Nodup ∧
        (∀ posting ∈ postings, posting.ordinal ∉ ordinals)) := by
  intro postings
  induction postings with
  | nil =>
    intro index postingIds ordinals balance result h
    simp only [admitPostings, Except.ok.injEq] at h
    subst h
    simp
  | cons posting rest ih =>
    intro index postingIds ordinals balance result h
    unfold admitPostings at h
    cases hstep : admitPosting snapshot indexes journal index posting postingIds ordinals balance with
    | error code => simp [hstep] at h
    | ok step =>
      simp only [hstep] at h
      cases hrest : admitPostings snapshot indexes journal (index + 1) rest
          (posting.id.value :: postingIds) (posting.ordinal :: ordinals) step.1 with
      | error code => simp [hrest] at h
      | ok tail =>
        simp only [hrest, Except.ok.injEq] at h
        subst h
        obtain ⟨amount, next, unitsDiffer, basisDiffer, -, -, h3, h4, rfl⟩ :=
          (admitPosting_eq_ok_iff ..).mp hstep
        have hu : unitsDiffer = false ↔
            sourceDiffers posting.units.sourceNumber posting.units.canonicalNumber =
              .ok false := by
          rw [h3]; simp
        have hb : basisDiffer = false ↔ basisDiffers posting.costBasis = .ok false := by
          rw [h4]; simp
        simp only [List.append_eq_nil_iff, postingDiagnostics_eq_nil_iff, ih hrest,
          List.mem_cons, forall_eq_or_imp, List.map_cons, List.nodup_cons, List.mem_map,
          not_exists, not_and, not_or, hu, hb]
        constructor
        · rintro ⟨⟨hid, hord, hordnew, hz, hc, hua, hba, hprice, hbc, hcoord⟩, hchecks, hidn,
            hidnew, hordn, hordnodup, hordnew'⟩
          refine ⟨⟨⟨hz, hc, hua, hba, hprice, hbc, hcoord⟩, hchecks⟩, ⟨?_, hidn⟩,
            ⟨hid, fun q hq => (hidnew q hq).2⟩, ⟨hord, hordn⟩, ⟨?_, hordnodup⟩,
            ⟨hordnew, fun q hq => (hordnew' q hq).2⟩⟩
          · intro q hq heq
            exact (hidnew q hq).1 heq
          · intro q hq heq
            exact (hordnew' q hq).1 heq
        · rintro ⟨⟨hposting, hchecks⟩, ⟨hidfresh, hidn⟩, ⟨hid, hidnew⟩, ⟨hord, hordn⟩,
            ⟨hordfresh, hordnodup⟩, ⟨hordnew, hordnew'⟩⟩
          exact ⟨⟨hid, hord, hordnew, hposting.value_nonzero, hposting.value_commodity,
            hposting.units_agree, hposting.basis_agrees, hposting.price, hposting.basis_commodity,
            hposting.coordinate⟩, hchecks, hidn,
            fun q hq => ⟨fun heq => hidfresh q hq heq, hidnew q hq⟩, hordn, hordnodup,
            fun q hq => ⟨fun heq => hordfresh q hq heq, hordnew' q hq⟩⟩

/-! ## Meaning: the conditions of admission, said about the snapshot's own lists -/

/-- The account a snapshot gives for an identifier: the first in its list. -/
def JournalAdmissionSnapshot.account (snapshot : JournalAdmissionSnapshot) (id : AccountId) :
    Option AccountSnapshot :=
  snapshot.accounts.find? fun account => account.id.value == id.value

/-- The dimension a snapshot gives for an identifier: the first in its list. -/
def JournalAdmissionSnapshot.dimension (snapshot : JournalAdmissionSnapshot) (id : DimensionId) :
    Option AccountingDimensionSnapshot :=
  snapshot.dimensions.find? fun dimension => dimension.id.value == id.value

/-- The dimension member a snapshot gives for an identifier: the first in its list. -/
def JournalAdmissionSnapshot.member (snapshot : JournalAdmissionSnapshot)
    (id : DimensionMemberId) : Option DimensionMemberSnapshot :=
  snapshot.dimensionMembers.find? fun member => member.id.value == id.value

/-- Open on a date: opened on or before it, and not closed before it. The order of two local dates
is the order of the calendar (`LocalDate.WF.le_iff`). -/
def ActiveOn (openedOn : LocalDate) (closedOn : Option LocalDate) (date : LocalDate) : Prop :=
  openedOn ≤ date ∧ ∀ closed, closedOn = some closed → date ≤ closed

/-- A dimension member can be selected on a date: its dimension is in the snapshot, belongs to the
snapshot's book and is open on the date, and the member is open on the date. -/
structure MemberSelectable (snapshot : JournalAdmissionSnapshot) (date : LocalDate)
    (member : DimensionMemberSnapshot) : Prop where
  dimension : ∃ dimension, snapshot.dimension member.dimensionId = some dimension ∧
    dimension.bookId = snapshot.bookId ∧ ActiveOn dimension.openedOn dimension.closedOn date
  active : ActiveOn member.openedOn member.closedOn date

theorem activeOn_iff (openedOn : LocalDate) (closedOn : Option LocalDate) (date : LocalDate) :
    activeOn openedOn closedOn date = true ↔ ActiveOn openedOn closedOn date := by
  unfold activeOn ActiveOn
  cases closedOn <;> simp

theorem Identifier.value_injective {Kind : String} :
    Function.Injective (fun id : Identifier Kind => id.value) := by
  rintro ⟨a⟩ ⟨b⟩ h
  simpa using h

theorem validateSnapshot_accounts_get (snapshot : JournalAdmissionSnapshot) (id : AccountId) :
    (validateSnapshot snapshot).1.accounts.get id.value = snapshot.account id :=
  indexById_get _ _ _ _

theorem validateSnapshot_dimensions_get (snapshot : JournalAdmissionSnapshot)
    (id : DimensionId) :
    (validateSnapshot snapshot).1.dimensions.get id.value = snapshot.dimension id :=
  indexById_get _ _ _ _

theorem validateSnapshot_members_get (snapshot : JournalAdmissionSnapshot)
    (id : DimensionMemberId) :
    (validateSnapshot snapshot).1.members.get id.value = snapshot.member id :=
  indexById_get _ _ _ _

/-- What a snapshot gives for an identifier is in its list and has that identifier. -/
theorem JournalAdmissionSnapshot.account_some {snapshot : JournalAdmissionSnapshot}
    {id : AccountId} {account : AccountSnapshot} (h : snapshot.account id = some account) :
    account ∈ snapshot.accounts ∧ account.id = id := by
  unfold JournalAdmissionSnapshot.account at h
  exact ⟨List.mem_of_find?_eq_some h,
    Identifier.value_injective (by simpa using List.find?_some h)⟩

theorem JournalAdmissionSnapshot.dimension_some {snapshot : JournalAdmissionSnapshot}
    {id : DimensionId} {dimension : AccountingDimensionSnapshot}
    (h : snapshot.dimension id = some dimension) :
    dimension ∈ snapshot.dimensions ∧ dimension.id = id := by
  unfold JournalAdmissionSnapshot.dimension at h
  exact ⟨List.mem_of_find?_eq_some h,
    Identifier.value_injective (by simpa using List.find?_some h)⟩

theorem JournalAdmissionSnapshot.member_some {snapshot : JournalAdmissionSnapshot}
    {id : DimensionMemberId} {member : DimensionMemberSnapshot}
    (h : snapshot.member id = some member) :
    member ∈ snapshot.dimensionMembers ∧ member.id = id := by
  unfold JournalAdmissionSnapshot.member at h
  exact ⟨List.mem_of_find?_eq_some h,
    Identifier.value_injective (by simpa using List.find?_some h)⟩

theorem memberInactive_eq_false_iff (snapshot : JournalAdmissionSnapshot) (date : LocalDate)
    (member : DimensionMemberSnapshot) :
    memberInactive snapshot (validateSnapshot snapshot).1 date member = false ↔
      MemberSelectable snapshot date member := by
  unfold memberInactive
  rw [validateSnapshot_dimensions_get]
  constructor
  · intro h
    cases hd : snapshot.dimension member.dimensionId with
    | none => simp [hd] at h
    | some dimension =>
      simp only [hd, Bool.or_eq_false_iff, decide_eq_false_iff_not, ne_eq, not_not,
        Bool.not_eq_false', activeOn_iff] at h
      exact ⟨⟨dimension, hd, h.1.1, h.1.2⟩, h.2⟩
  · rintro ⟨⟨dimension, hd, hbook, hactive⟩, hmember⟩
    simp [hd, hbook, (activeOn_iff ..).mpr hactive, (activeOn_iff ..).mpr hmember]

theorem selectedDimension_eq_some_iff (snapshot : JournalAdmissionSnapshot) (date : LocalDate)
    (memberId : DimensionMemberId) (dimension : String) :
    selectedDimension snapshot (validateSnapshot snapshot).1 date memberId = some dimension ↔
      ∃ member, snapshot.member memberId = some member ∧
        MemberSelectable snapshot date member ∧ member.dimensionId.value = dimension := by
  unfold selectedDimension
  rw [validateSnapshot_members_get]
  cases hm : snapshot.member memberId with
  | none => simp
  | some member =>
    by_cases hin : memberInactive snapshot (validateSnapshot snapshot).1 date member = true
    · have : ¬ MemberSelectable snapshot date member := by
        rw [← memberInactive_eq_false_iff, hin]; simp
      simp [hin, this]
    · have hsel : MemberSelectable snapshot date member := by
        rw [← memberInactive_eq_false_iff]; simpa using hin
      simp [hin, hsel]

/-- What `admitJournal` asks of one posting whatever the other postings: every diagnostic of a
turn of its loop but the two about a duplicate, as a statement about the snapshot's lists and the
meanings of the numbers. -/
structure PostingAdmissible (snapshot : JournalAdmissionSnapshot) (journal : JournalTransaction)
    (posting : Posting) : Prop where
  /-- The book value is not zero (`.bookValue.amount`). -/
  value_nonzero : posting.bookValue.amount.toRat ≠ 0
  /-- The book value is in the book's functional commodity (`.bookValue.functionalCommodityId`). -/
  value_commodity : posting.bookValue.functionalCommodityId = snapshot.functionalCommodityId
  /-- A source decimal of the quantity means the same number as the quantity (`.units`). -/
  source_number : ∀ source, posting.units.sourceNumber = some source →
    source.toRat = posting.units.canonicalNumber.toRat
  /-- A source decimal of the cost basis means the same number as the basis (`.costBasis`). -/
  source_basis : ∀ basis source, posting.costBasis = some basis →
    basis.sourceTotalBasis = some source → source.toRat = basis.totalBasis.toRat
  /-- A transaction price is a positive rate from the posting's commodity to the functional
  commodity (`.transactionPrice`). -/
  price : ∀ price, posting.transactionPrice = some price →
    0 < price.unitRate.toRat ∧ price.baseCommodityId = posting.units.commodityId ∧
      price.quoteCommodityId = snapshot.functionalCommodityId
  /-- A cost basis is in the functional commodity (`.costBasis.basisCommodityId`). -/
  basis_commodity : ∀ basis, posting.costBasis = some basis →
    basis.basisCommodityId = snapshot.functionalCommodityId
  /-- The account is in the snapshot, allows posting, is open on the accounting date and admits
  the posting's commodity (`.accountId`, `.units.commodityId`). -/
  account : ∃ account, snapshot.account posting.accountId = some account ∧
    account.postingAllowed = true ∧
    ActiveOn account.openedOn account.closedOn journal.accountingDate ∧
    (account.allowedCommodityIds = [] ∨
      posting.units.commodityId ∈ account.allowedCommodityIds)
  /-- Every dimension member is in the snapshot and can be selected on the accounting date
  (`.dimensionMemberIds`, two diagnostics). -/
  members : ∀ memberId ∈ posting.dimensionMemberIds, ∃ member,
    snapshot.member memberId = some member ∧
      MemberSelectable snapshot journal.accountingDate member
  /-- No two of the members are of one dimension (`.dimensionMemberIds`). -/
  one_member_a_dimension : (posting.dimensionMemberIds.filterMap fun memberId =>
    (snapshot.member memberId).map (·.dimensionId)).Nodup
  /-- Every required dimension has a member (`.dimensionMemberIds`). -/
  required : ∀ requiredDimensionId ∈ requiredDimensionsFor snapshot posting,
    ∃ memberId ∈ posting.dimensionMemberIds, ∃ member,
      snapshot.member memberId = some member ∧ member.dimensionId = requiredDimensionId

theorem sourceDiffers_eq_ok_false_iff {source : Option ExactDecimal} {canonical : ExactRational}
    (hs : ∀ decimal, source = some decimal → decimal.WF) (hc : canonical.WF) :
    sourceDiffers source canonical = .ok false ↔
      ∀ decimal, source = some decimal → decimal.toRat = canonical.toRat := by
  cases source with
  | none => simp [sourceDiffers]
  | some decimal =>
    obtain ⟨rational, hr, hw, hrat⟩ := ExactDecimal.toRational_isOk (hs decimal rfl)
    simp only [sourceDiffers, hr, Except.ok.injEq, Bool.not_eq_false', Option.some.injEq,
      forall_eq', ExactRational.equals_iff hw hc, hrat]

/-- A constructible source decimal never makes the comparison throw. -/
theorem sourceDiffers_isOk {source : Option ExactDecimal} (canonical : ExactRational)
    (hs : ∀ decimal, source = some decimal → decimal.WF) :
    ∃ differs, sourceDiffers source canonical = .ok differs := by
  cases source with
  | none => exact ⟨false, rfl⟩
  | some decimal =>
    obtain ⟨rational, hr, -, -⟩ := ExactDecimal.toRational_isOk (hs decimal rfl)
    exact ⟨!rational.equals canonical, by simp only [sourceDiffers, hr]⟩

theorem positive_rate_iff {rate : ExactRational} (h : rate.WF) :
    rate.isZero = false ∧ rate.isNegative = false ↔ 0 < rate.toRat := by
  rw [← Bool.not_eq_true, ← Bool.not_eq_true, ExactRational.isZero_iff h,
    ExactRational.isNegative_iff h]
  constructor
  · rintro ⟨h0, hn⟩
    exact lt_of_le_of_ne (not_lt.mp hn) (Ne.symm h0)
  · intro hp
    exact ⟨ne_of_gt hp, not_lt.mpr hp.le⟩

/-- For the indexes of the snapshot itself, the checks of a coordinate are the conditions on the
account and the members said about the snapshot's lists. -/
theorem coordinateChecks_iff (snapshot : JournalAdmissionSnapshot)
    (coordinate : AccountingCoordinate) (requiredDimensionIds : List DimensionId) :
    CoordinateChecks snapshot (validateSnapshot snapshot).1 coordinate requiredDimensionIds ↔
      (∃ account, snapshot.account coordinate.accountId = some account ∧
        account.postingAllowed = true ∧
        ActiveOn account.openedOn account.closedOn coordinate.accountingDate ∧
        (account.allowedCommodityIds = [] ∨
          coordinate.unitsCommodityId ∈ account.allowedCommodityIds)) ∧
      (∀ memberId ∈ coordinate.dimensionMemberIds, ∃ member,
        snapshot.member memberId = some member ∧
          MemberSelectable snapshot coordinate.accountingDate member) ∧
      (coordinate.dimensionMemberIds.filterMap fun memberId =>
        (snapshot.member memberId).map (·.dimensionId)).Nodup ∧
      (∀ requiredDimensionId ∈ requiredDimensionIds,
        ∃ memberId ∈ coordinate.dimensionMemberIds, ∃ member,
          snapshot.member memberId = some member ∧ member.dimensionId = requiredDimensionId) := by
  have hmembers : (∀ memberId ∈ coordinate.dimensionMemberIds,
      (selectedDimension snapshot (validateSnapshot snapshot).1 coordinate.accountingDate
        memberId).isSome = true) ↔
      ∀ memberId ∈ coordinate.dimensionMemberIds, ∃ member,
        snapshot.member memberId = some member ∧
          MemberSelectable snapshot coordinate.accountingDate member := by
    refine forall₂_congr fun memberId _ => ?_
    rw [Option.isSome_iff_exists]
    simp only [selectedDimension_eq_some_iff]
    constructor
    · rintro ⟨_, member, hm, hsel, -⟩; exact ⟨member, hm, hsel⟩
    · rintro ⟨member, hm, hsel⟩; exact ⟨_, member, hm, hsel, rfl⟩
  have hlist : (∀ memberId ∈ coordinate.dimensionMemberIds, ∃ member,
      snapshot.member memberId = some member ∧
        MemberSelectable snapshot coordinate.accountingDate member) →
      coordinate.dimensionMemberIds.filterMap
          (selectedDimension snapshot (validateSnapshot snapshot).1 coordinate.accountingDate) =
        (coordinate.dimensionMemberIds.filterMap fun memberId =>
          (snapshot.member memberId).map (·.dimensionId)).map (·.value) := by
    intro hall
    rw [List.map_filterMap]
    refine List.filterMap_congr fun memberId hmem => ?_
    obtain ⟨member, hm, hsel⟩ := hall memberId hmem
    rw [(selectedDimension_eq_some_iff ..).mpr ⟨member, hm, hsel, rfl⟩]
    simp [hm]
  constructor
  · rintro ⟨haccount, hm, hnodup, hrequired⟩
    have hall := hmembers.mp hm
    rw [hlist hall] at hnodup hrequired
    refine ⟨?_, hall, (List.nodup_map_iff Identifier.value_injective).mp hnodup, ?_⟩
    · simpa only [validateSnapshot_accounts_get, activeOn_iff] using haccount
    · intro requiredDimensionId hr
      have := hrequired requiredDimensionId hr
      rw [List.mem_map] at this
      obtain ⟨dimensionId, hmem, heq⟩ := this
      have hid : dimensionId = requiredDimensionId := Identifier.value_injective heq
      subst hid
      simp only [List.mem_filterMap, Option.map_eq_some_iff] at hmem
      obtain ⟨memberId, hin, member, hmember, hdim⟩ := hmem
      exact ⟨memberId, hin, member, hmember, hdim⟩
  · rintro ⟨haccount, hall, hnodup, hrequired⟩
    refine ⟨?_, hmembers.mpr hall, ?_, ?_⟩
    · simpa only [validateSnapshot_accounts_get, activeOn_iff] using haccount
    · rw [hlist hall]
      exact (List.nodup_map_iff Identifier.value_injective).mpr hnodup
    · intro requiredDimensionId hr
      rw [hlist hall, List.mem_map]
      obtain ⟨memberId, hin, member, hmember, hdim⟩ := hrequired requiredDimensionId hr
      refine ⟨requiredDimensionId, ?_, rfl⟩
      simp only [List.mem_filterMap, Option.map_eq_some_iff]
      exact ⟨memberId, hin, member, hmember, hdim⟩

theorem basisDiffers_eq_ok_false_iff {costBasis : Option CostBasis}
    (ht : ∀ basis, costBasis = some basis → basis.totalBasis.WF)
    (hs : ∀ basis decimal, costBasis = some basis → basis.sourceTotalBasis = some decimal →
      decimal.WF) :
    basisDiffers costBasis = .ok false ↔
      ∀ basis decimal, costBasis = some basis → basis.sourceTotalBasis = some decimal →
        decimal.toRat = basis.totalBasis.toRat := by
  cases costBasis with
  | none => simp [basisDiffers]
  | some basis =>
    simp only [basisDiffers, Option.some.injEq]
    rw [sourceDiffers_eq_ok_false_iff (fun decimal hd => hs basis decimal rfl hd) (ht basis rfl)]
    constructor
    · intro h basis' decimal hb; subst hb; exact h decimal
    · intro h decimal; exact h basis decimal rfl

/-- A constructible cost basis never makes the comparison throw. -/
theorem basisDiffers_isOk {costBasis : Option CostBasis}
    (hs : ∀ basis decimal, costBasis = some basis → basis.sourceTotalBasis = some decimal →
      decimal.WF) :
    ∃ differs, basisDiffers costBasis = .ok differs := by
  cases costBasis with
  | none => exact ⟨false, rfl⟩
  | some basis => exact sourceDiffers_isOk _ (fun decimal hd => hs basis decimal rfl hd)

/-- For a constructible posting and the indexes of the snapshot itself, the checks of a turn of
the loop are the conditions of `PostingAdmissible`. -/
theorem postingChecks_iff {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {posting : Posting} (hw : posting.WF) :
    PostingChecks snapshot (validateSnapshot snapshot).1 journal posting ↔
      PostingAdmissible snapshot journal posting := by
  constructor
  · rintro ⟨hz, hc, hu, hb, hprice, hbc, hcoord⟩
    obtain ⟨haccount, hmembers, hone, hrequired⟩ := (coordinateChecks_iff ..).mp hcoord
    refine ⟨?_, hc, (sourceDiffers_eq_ok_false_iff hw.sourceNumber hw.canonicalNumber).mp hu,
      (basisDiffers_eq_ok_false_iff hw.totalBasis hw.sourceTotalBasis).mp hb, ?_, hbc, haccount,
      hmembers, hone, hrequired⟩
    · intro h0
      rw [(ExactDecimal.isZero_iff _).mpr h0] at hz
      cases hz
    · intro price hp
      obtain ⟨h1, h2, h3, h4⟩ := hprice price hp
      exact ⟨(positive_rate_iff (hw.unitRate price hp)).mp ⟨h1, h2⟩, h3, h4⟩
  · rintro ⟨hz, hc, hu, hb, hprice, hbc, haccount, hmembers, hone, hrequired⟩
    refine ⟨?_, hc, (sourceDiffers_eq_ok_false_iff hw.sourceNumber hw.canonicalNumber).mpr hu,
      (basisDiffers_eq_ok_false_iff hw.totalBasis hw.sourceTotalBasis).mpr hb, ?_, hbc,
      (coordinateChecks_iff ..).mpr ⟨haccount, hmembers, hone, hrequired⟩⟩
    · rw [← Bool.not_eq_true, ExactDecimal.isZero_iff]
      exact hz
    · intro price hp
      obtain ⟨h1, h3, h4⟩ := hprice price hp
      obtain ⟨hnz, hnn⟩ := (positive_rate_iff (hw.unitRate price hp)).mpr h1
      exact ⟨hnz, hnn, h3, h4⟩

/-- The conditions of admission: what `admitJournal` asks of a journal on a snapshot, one field a
diagnostic (the snapshot's own diagnostics together in the first). -/
structure Admissible (snapshot : JournalAdmissionSnapshot) (journal : JournalTransaction) :
    Prop where
  /-- `validateSnapshot` pushes no diagnostic: see `validateSnapshot_eq_nil_iff`. -/
  snapshot_accepted : (validateSnapshot snapshot).2 = []
  /-- The journal is of the snapshot's book (`journal.bookId`). -/
  same_book : journal.bookId = snapshot.bookId
  /-- The journal is in the snapshot's functional commodity (`journal.functionalCommodityId`). -/
  same_commodity : journal.functionalCommodityId = snapshot.functionalCommodityId
  /-- There are at least two postings (`journal.postings`). -/
  two_postings : 2 ≤ journal.postings.length
  /-- No posting identifier is used twice (`.id`). -/
  posting_ids_distinct : (journal.postings.map (·.id)).Nodup
  /-- No ordinal is negative (`.ordinal`). -/
  ordinals_nonnegative : ∀ posting ∈ journal.postings, 0 ≤ posting.ordinal
  /-- No ordinal is used twice (`.ordinal`). -/
  ordinals_distinct : (journal.postings.map (·.ordinal)).Nodup
  /-- Every posting passes its own checks. -/
  postings : ∀ posting ∈ journal.postings, PostingAdmissible snapshot journal posting
  /-- The book values add up to zero (`journal_imbalance`). -/
  balanced : (journal.postings.map (·.bookValue.amount.toRat)).sum = 0

/-- The loop of `admitJournal` on a constructible journal pushes no diagnostic exactly when the
posting identifiers are distinct, the ordinals are distinct and not negative, and every posting
passes its own checks. -/
theorem admitLoop_diagnostics_eq_nil_iff {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {loop : ExactRational × List SemanticDiagnostic}
    (hw : journal.WF) (h : admitLoop snapshot journal = .ok loop) :
    loop.2 = [] ↔
      (journal.postings.map (·.id)).Nodup ∧ (∀ posting ∈ journal.postings, 0 ≤ posting.ordinal) ∧
      (journal.postings.map (·.ordinal)).Nodup ∧
      ∀ posting ∈ journal.postings, PostingAdmissible snapshot journal posting := by
  rw [admitPostings_diagnostics_eq_nil_iff h]
  have hids : (journal.postings.map (·.id.value)).Nodup ↔ (journal.postings.map (·.id)).Nodup := by
    rw [show (journal.postings.map (·.id.value)) = (journal.postings.map (·.id)).map (·.value) by
      simp]
    exact List.nodup_map_iff Identifier.value_injective
  have hchecks : (∀ posting ∈ journal.postings,
      PostingChecks snapshot (validateSnapshot snapshot).1 journal posting) ↔
      ∀ posting ∈ journal.postings, PostingAdmissible snapshot journal posting :=
    forall₂_congr fun posting hp => postingChecks_iff (hw posting hp)
  rw [hids, hchecks]
  simp only [List.not_mem_nil, not_false_eq_true, implies_true, true_and, and_true]
  tauto

/-! ## Laws: soundness and completeness of `admitJournal` -/

theorem journalHeaderDiagnostics_eq_nil_iff (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) :
    journalHeaderDiagnostics snapshot journal = [] ↔
      journal.bookId = snapshot.bookId ∧
        journal.functionalCommodityId = snapshot.functionalCommodityId ∧
        2 ≤ journal.postings.length := by
  unfold journalHeaderDiagnostics
  simp

/-- On a constructible posting and a constructible balance, a turn of the loop throws only when
adding the book value to the balance exceeds the size limit. -/
theorem admitPosting_error {snapshot : JournalAdmissionSnapshot} {indexes : SnapshotIndexes}
    {journal : JournalTransaction} {index : Nat} {posting : Posting} {postingIds : List String}
    {ordinals : List Int} {balance : ExactRational} {code : NumErr} (hb : balance.WF)
    (hp : posting.WF)
    (h : admitPosting snapshot indexes journal index posting postingIds ordinals balance =
      .error code) :
    code = .representationLimitExceeded := by
  obtain ⟨amount, ha, haw, -⟩ := ExactDecimal.toRational_isOk hp.amount
  obtain ⟨unitsDiffer, hu⟩ := sourceDiffers_isOk posting.units.canonicalNumber hp.sourceNumber
  obtain ⟨basisDiffer, hbd⟩ := basisDiffers_isOk hp.sourceTotalBasis
  unfold admitPosting at h
  simp only [ha] at h
  rcases ExactRational.add_ok_or_limit hb haw with ⟨next, hnext⟩ | hlimit
  · simp [hnext, hu, hbd] at h
  · simp only [hlimit, Except.error.injEq] at h
    exact h.symm

/-- On constructible postings and a constructible balance, the loop throws only for the size
limit. -/
theorem admitPostings_error {snapshot : JournalAdmissionSnapshot} {indexes : SnapshotIndexes}
    {journal : JournalTransaction} :
    ∀ {postings : List Posting} {index : Nat} {postingIds : List String} {ordinals : List Int}
      {balance : ExactRational} {code : NumErr},
      balance.WF → (∀ posting ∈ postings, posting.WF) →
      admitPostings snapshot indexes journal index postings postingIds ordinals balance =
        .error code →
      code = .representationLimitExceeded := by
  intro postings
  induction postings with
  | nil =>
    intro index postingIds ordinals balance code _ _ h
    simp [admitPostings] at h
  | cons posting rest ih =>
    intro index postingIds ordinals balance code hb hp h
    unfold admitPostings at h
    cases hstep : admitPosting snapshot indexes journal index posting postingIds ordinals balance with
    | error code' =>
      simp only [hstep, Except.error.injEq] at h
      subst h
      exact admitPosting_error hb (hp posting (by simp)) hstep
    | ok step =>
      simp only [hstep] at h
      cases hrest : admitPostings snapshot indexes journal (index + 1) rest
          (posting.id.value :: postingIds) (posting.ordinal :: ordinals) step.1 with
      | error code' =>
        simp only [hrest, Except.error.injEq] at h
        subst h
        exact ih (admitPosting_balance hb (hp posting (by simp)).amount hstep).1
          (fun q hq => hp q (by simp [hq])) hrest
      | ok tail => simp [hrest] at h

/-- **Soundness**: a constructible journal that `admitJournal` admits satisfies every condition
of admission. -/
theorem admitted_admissible {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (hw : journal.WF)
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    Admissible snapshot journal := by
  obtain ⟨loop, hloop, hnil, -⟩ := (admitJournal_eq_admitted_iff ..).mp h
  obtain ⟨hsnapshot, hheader, hdiag, -⟩ := (journalDiagnostics_eq_nil_iff ..).mp hnil
  obtain ⟨hbook, hcommodity, htwo⟩ := (journalHeaderDiagnostics_eq_nil_iff ..).mp hheader
  obtain ⟨hids, hnonneg, hordinals, hpostings⟩ :=
    (admitLoop_diagnostics_eq_nil_iff hw hloop).mp hdiag
  exact ⟨hsnapshot, hbook, hcommodity, htwo, hids, hnonneg, hordinals, hpostings,
    admitted_journal_balances_of_wf hw h⟩

/-- **Completeness**: a constructible journal that satisfies every condition of admission is
admitted, with the hash of its canonical value, unless the running balance exceeded the size
limit, in which case `admitJournal` throws that error. -/
theorem admissible_admitted {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    (hw : journal.WF) (ha : Admissible snapshot journal) :
    admitJournal snapshot journal =
        .ok (.admitted (hashCanonical (canonicalJournalValue journal))) ∨
      admitJournal snapshot journal = .error .representationLimitExceeded := by
  cases hloop : admitLoop snapshot journal with
  | error code =>
    right
    have := admitPostings_error ExactRational.zero_wf hw hloop
    subst this
    exact (admitJournal_eq_error_iff ..).mpr hloop
  | ok loop =>
    left
    refine (admitJournal_eq_admitted_iff ..).mpr ⟨loop, hloop, ?_, rfl⟩
    obtain ⟨hwf, hr⟩ := admitLoop_balance (fun posting hp => (hw posting hp).amount) hloop
    refine (journalDiagnostics_eq_nil_iff ..).mpr ⟨ha.snapshot_accepted,
      (journalHeaderDiagnostics_eq_nil_iff ..).mpr ⟨ha.same_book, ha.same_commodity,
        ha.two_postings⟩,
      (admitLoop_diagnostics_eq_nil_iff hw hloop).mpr ⟨ha.posting_ids_distinct,
        ha.ordinals_nonnegative, ha.ordinals_distinct, ha.postings⟩, ?_⟩
    rw [ExactRational.isZero_iff hwf, hr]
    exact ha.balanced

/-- The conditions of admission are exactly the function's: a constructible journal is admitted
exactly when it satisfies them and the running balance stays within the size limit. -/
theorem admitJournal_admitted_iff {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} (hw : journal.WF) (hash : ContentHash) :
    admitJournal snapshot journal = .ok (.admitted hash) ↔
      Admissible snapshot journal ∧
        admitJournal snapshot journal ≠ .error .representationLimitExceeded ∧
        hash = hashCanonical (canonicalJournalValue journal) := by
  constructor
  · intro h
    refine ⟨admitted_admissible hw h, by rw [h]; simp, ?_⟩
    exact ((admitJournal_eq_admitted_iff ..).mp h).choose_spec.2.2
  · rintro ⟨ha, hne, rfl⟩
    rcases admissible_admitted hw ha with h | h
    · exact h
    · exact absurd h hne

/-! ### One theorem a diagnostic

Each of these is a field of `Admissible`; they are stated on their own so that each diagnostic of
`admitJournal` has a law of its own, with only the hypotheses it needs. -/

/-- What an admitted journal passed, before any hypothesis about its numbers: the snapshot's
checks, the journal's own three, and the loop's. -/
theorem admitted_checks {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    (validateSnapshot snapshot).2 = [] ∧ journalHeaderDiagnostics snapshot journal = [] ∧
      (∀ posting ∈ journal.postings,
        PostingChecks snapshot (validateSnapshot snapshot).1 journal posting) ∧
      (journal.postings.map (·.id.value)).Nodup ∧
      (∀ posting ∈ journal.postings, 0 ≤ posting.ordinal) ∧
      (journal.postings.map (·.ordinal)).Nodup := by
  obtain ⟨loop, hloop, hnil, -⟩ := (admitJournal_eq_admitted_iff ..).mp h
  obtain ⟨hsnapshot, hheader, hdiag, -⟩ := (journalDiagnostics_eq_nil_iff ..).mp hnil
  obtain ⟨hchecks, hids, -, hnonneg, hordinals, -⟩ :=
    (admitPostings_diagnostics_eq_nil_iff hloop).mp hdiag
  exact ⟨hsnapshot, hheader, hchecks, hids, hnonneg, hordinals⟩

/-- The hash of an admitted journal is the hash of its canonical value. -/
theorem admitted_hash {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    hash = hashCanonical (canonicalJournalValue journal) :=
  ((admitJournal_eq_admitted_iff ..).mp h).choose_spec.2.2

/-- A journal is admitted only on a snapshot that `validateSnapshot` accepts whole. -/
theorem admitted_snapshot_accepted {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    (validateSnapshot snapshot).2 = [] :=
  (admitted_checks h).1

/-- An admitted journal is of the snapshot's book. -/
theorem admitted_same_book {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    journal.bookId = snapshot.bookId :=
  ((journalHeaderDiagnostics_eq_nil_iff ..).mp (admitted_checks h).2.1).1

/-- An admitted journal is in the snapshot's functional commodity. -/
theorem admitted_same_functional_commodity {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    journal.functionalCommodityId = snapshot.functionalCommodityId :=
  ((journalHeaderDiagnostics_eq_nil_iff ..).mp (admitted_checks h).2.1).2.1

/-- An admitted journal has at least two postings. -/
theorem admitted_two_postings {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    2 ≤ journal.postings.length :=
  ((journalHeaderDiagnostics_eq_nil_iff ..).mp (admitted_checks h).2.1).2.2

/-- No two postings of an admitted journal have the same identifier. -/
theorem admitted_posting_ids_distinct {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    (journal.postings.map (·.id)).Nodup := by
  have := (admitted_checks h).2.2.2.1
  rw [show (journal.postings.map (·.id.value)) = (journal.postings.map (·.id)).map (·.value) by
    simp] at this
  exact (List.nodup_map_iff Identifier.value_injective).mp this

/-- No posting of an admitted journal has a negative ordinal. -/
theorem admitted_ordinals_nonnegative {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, 0 ≤ posting.ordinal :=
  (admitted_checks h).2.2.2.2.1

/-- No two postings of an admitted journal have the same ordinal. -/
theorem admitted_ordinals_distinct {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    (journal.postings.map (·.ordinal)).Nodup :=
  (admitted_checks h).2.2.2.2.2

/-- No posting of an admitted journal has a zero book value. -/
theorem admitted_value_nonzero {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, posting.bookValue.amount.toRat ≠ 0 := by
  intro posting hp h0
  have := ((admitted_checks h).2.2.1 posting hp).value_nonzero
  rw [(ExactDecimal.isZero_iff _).mpr h0] at this
  cases this

/-- Every book value of an admitted journal is in the book's functional commodity. -/
theorem admitted_value_commodity {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings,
      posting.bookValue.functionalCommodityId = snapshot.functionalCommodityId :=
  fun posting hp => ((admitted_checks h).2.2.1 posting hp).value_commodity

/-- In an admitted journal a source decimal of a quantity means the same number as the
quantity. -/
theorem admitted_source_number_agrees {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, posting.WF → ∀ source,
      posting.units.sourceNumber = some source →
        source.toRat = posting.units.canonicalNumber.toRat :=
  fun posting hp hw => (sourceDiffers_eq_ok_false_iff hw.sourceNumber hw.canonicalNumber).mp
    ((admitted_checks h).2.2.1 posting hp).units_agree

/-- In an admitted journal a source decimal of a cost basis means the same number as the
basis. -/
theorem admitted_source_basis_agrees {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, posting.WF → ∀ basis source,
      posting.costBasis = some basis → basis.sourceTotalBasis = some source →
        source.toRat = basis.totalBasis.toRat :=
  fun posting hp hw => (basisDiffers_eq_ok_false_iff hw.totalBasis hw.sourceTotalBasis).mp
    ((admitted_checks h).2.2.1 posting hp).basis_agrees

/-- In an admitted journal a transaction price is a positive rate from the posting's commodity to
the functional commodity. -/
theorem admitted_price {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, posting.WF → ∀ price,
      posting.transactionPrice = some price →
        0 < price.unitRate.toRat ∧ price.baseCommodityId = posting.units.commodityId ∧
          price.quoteCommodityId = snapshot.functionalCommodityId := by
  intro posting hp hw price hprice
  obtain ⟨h1, h2, h3, h4⟩ := ((admitted_checks h).2.2.1 posting hp).price price hprice
  exact ⟨(positive_rate_iff (hw.unitRate price hprice)).mp ⟨h1, h2⟩, h3, h4⟩

/-- In an admitted journal a cost basis is in the functional commodity. -/
theorem admitted_basis_commodity {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, ∀ basis, posting.costBasis = some basis →
      basis.basisCommodityId = snapshot.functionalCommodityId :=
  fun posting hp => ((admitted_checks h).2.2.1 posting hp).basis_commodity

/-- Every posting of an admitted journal is to an account of the snapshot that allows posting, is
open on the accounting date and admits the posting's commodity. -/
theorem admitted_account {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, ∃ account,
      snapshot.account posting.accountId = some account ∧ account.postingAllowed = true ∧
      ActiveOn account.openedOn account.closedOn journal.accountingDate ∧
      (account.allowedCommodityIds = [] ∨
        posting.units.commodityId ∈ account.allowedCommodityIds) :=
  fun posting hp =>
    ((coordinateChecks_iff ..).mp ((admitted_checks h).2.2.1 posting hp).coordinate).1

/-- Every dimension member of a posting of an admitted journal is in the snapshot and open on the
accounting date, in a dimension of the book that is open on that date. -/
theorem admitted_members {snapshot : JournalAdmissionSnapshot} {journal : JournalTransaction}
    {hash : ContentHash} (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, ∀ memberId ∈ posting.dimensionMemberIds, ∃ member,
      snapshot.member memberId = some member ∧
        MemberSelectable snapshot journal.accountingDate member :=
  fun posting hp =>
    ((coordinateChecks_iff ..).mp ((admitted_checks h).2.2.1 posting hp).coordinate).2.1

/-- No posting of an admitted journal selects two members of one dimension. -/
theorem admitted_one_member_a_dimension {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings, (posting.dimensionMemberIds.filterMap fun memberId =>
      (snapshot.member memberId).map (·.dimensionId)).Nodup :=
  fun posting hp =>
    ((coordinateChecks_iff ..).mp ((admitted_checks h).2.2.1 posting hp).coordinate).2.2.1

/-- Every posting of an admitted journal selects a member of each dimension required of it. -/
theorem admitted_required_dimensions {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) :
    ∀ posting ∈ journal.postings,
      ∀ requiredDimensionId ∈ requiredDimensionsFor snapshot posting,
        ∃ memberId ∈ posting.dimensionMemberIds, ∃ member,
          snapshot.member memberId = some member ∧ member.dimensionId = requiredDimensionId :=
  fun posting hp =>
    ((coordinateChecks_iff ..).mp ((admitted_checks h).2.2.1 posting hp).coordinate).2.2.2

/-! ## Laws: a rejected journal, and when `journal_imbalance` is reported -/

/-- No diagnostic of the list has the code `journal_imbalance`. -/
def NoImbalance (diagnostics : List SemanticDiagnostic) : Prop :=
  ∀ entry ∈ diagnostics, entry.code ≠ .journal_imbalance

theorem NoImbalance.nil : NoImbalance [] := fun _ h => absurd h (by simp)

theorem NoImbalance.append {left right : List SemanticDiagnostic} (hl : NoImbalance left)
    (hr : NoImbalance right) : NoImbalance (left ++ right) := by
  intro entry h
  rcases List.mem_append.mp h with h | h
  · exact hl entry h
  · exact hr entry h

theorem NoImbalance.cons {entry : SemanticDiagnostic} {rest : List SemanticDiagnostic}
    (he : entry.code ≠ .journal_imbalance) (hr : NoImbalance rest) :
    NoImbalance (entry :: rest) := by
  intro other h
  rcases List.mem_cons.mp h with rfl | h
  · exact he
  · exact hr other h

theorem NoImbalance.ite {c : Prop} [Decidable c] {entry : SemanticDiagnostic}
    (he : entry.code ≠ .journal_imbalance) : NoImbalance (if c then [entry] else []) := by
  split
  · exact NoImbalance.cons he NoImbalance.nil
  · exact NoImbalance.nil

theorem NoImbalance.flatMap {α : Type} {values : List α} {f : α → List SemanticDiagnostic}
    (h : ∀ value, NoImbalance (f value)) : NoImbalance (values.flatMap f) := by
  intro entry hmem
  obtain ⟨value, -, hin⟩ := List.mem_flatMap.mp hmem
  exact h value entry hin

theorem NoImbalance.ite_diagnostic {c : Prop} [Decidable c] {code : SemanticDiagnosticCode}
    {path message : String} {requirementIds : List String} (he : code ≠ .journal_imbalance) :
    NoImbalance (if c then [diagnostic code path message requirementIds] else []) :=
  NoImbalance.ite he

theorem NoImbalance.cons_diagnostic {code : SemanticDiagnosticCode} {path message : String}
    {requirementIds : List String} {rest : List SemanticDiagnostic}
    (he : code ≠ .journal_imbalance) (hr : NoImbalance rest) :
    NoImbalance (diagnostic code path message requirementIds :: rest) :=
  NoImbalance.cons he hr

/-- Takes a list of diagnostics apart and shows that none of the codes written in it is
`journal_imbalance`. -/
macro "no_imbalance" : tactic =>
  `(tactic| repeat' (first
    | exact NoImbalance.nil
    | assumption
    | apply NoImbalance.append
    | exact NoImbalance.ite_diagnostic (by decide)
    | apply NoImbalance.cons_diagnostic (by decide)
    | (apply NoImbalance.flatMap; intro _)))

theorem indexByIdLoop_noImbalance {T : Type} (idOf : T → String) (path : String) :
    ∀ (values : List T) (index : IdIndex T),
      NoImbalance (indexByIdLoop idOf path values index).2 := by
  intro values
  induction values with
  | nil => intro index; exact NoImbalance.nil
  | cons value rest ih =>
    intro index
    unfold indexByIdLoop
    split
    · exact NoImbalance.cons_diagnostic (by decide) (ih index)
    · exact ih _

theorem accountDiagnostics_noImbalance (snapshot : JournalAdmissionSnapshot)
    (accounts : IdIndex AccountSnapshot) :
    ∀ (values : List AccountSnapshot) (codes : List String),
      NoImbalance (accountDiagnostics snapshot accounts values codes) := by
  intro values
  induction values with
  | nil => intro codes; exact NoImbalance.nil
  | cons value rest ih =>
    intro codes
    have := ih (value.code :: codes)
    unfold accountDiagnostics
    no_imbalance

theorem dimensionDiagnostics_noImbalance (snapshot : JournalAdmissionSnapshot) :
    ∀ (values : List AccountingDimensionSnapshot) (codes : List String),
      NoImbalance (dimensionDiagnostics snapshot values codes) := by
  intro values
  induction values with
  | nil => intro codes; exact NoImbalance.nil
  | cons value rest ih =>
    intro codes
    have := ih (value.code :: codes)
    unfold dimensionDiagnostics
    no_imbalance

theorem memberDiagnostics_noImbalance (dimensions : IdIndex AccountingDimensionSnapshot)
    (members : IdIndex DimensionMemberSnapshot) :
    ∀ (values : List DimensionMemberSnapshot) (codes : List String),
      NoImbalance (memberDiagnostics dimensions members values codes) := by
  intro values
  induction values with
  | nil => intro codes; exact NoImbalance.nil
  | cons value rest ih =>
    intro codes
    have := ih (scopedCode value :: codes)
    unfold memberDiagnostics
    no_imbalance

theorem detectParentCycle_noImbalance {T : Type} (idOf : T → String)
    (parentOf : T → Option String) (values : List T) (index : IdIndex T) (path : String)
    {code : SemanticDiagnosticCode} (requirementId : String) (hc : code ≠ .journal_imbalance) :
    NoImbalance (detectParentCycle idOf parentOf values index path code requirementId) := by
  unfold detectParentCycle
  apply NoImbalance.flatMap
  intro value
  exact NoImbalance.ite hc

/-- `validateSnapshot` never reports an imbalance. -/
theorem validateSnapshot_noImbalance (snapshot : JournalAdmissionSnapshot) :
    NoImbalance (validateSnapshot snapshot).2 := by
  have h1 := indexByIdLoop_noImbalance (fun a : AccountSnapshot => a.id.value)
    "snapshot.accounts" snapshot.accounts []
  have h2 := indexByIdLoop_noImbalance (fun d : AccountingDimensionSnapshot => d.id.value)
    "snapshot.dimensions" snapshot.dimensions []
  have h3 := indexByIdLoop_noImbalance (fun m : DimensionMemberSnapshot => m.id.value)
    "snapshot.dimensionMembers" snapshot.dimensionMembers []
  unfold validateSnapshot requiredDimensionDiagnostics
  simp only []
  refine NoImbalance.append (NoImbalance.append (NoImbalance.append (NoImbalance.append
    (NoImbalance.append (NoImbalance.append (NoImbalance.append (NoImbalance.append h1 h2) h3)
    (accountDiagnostics_noImbalance _ _ _ _)) (detectParentCycle_noImbalance _ _ _ _ _ _ (by decide)))
    (dimensionDiagnostics_noImbalance _ _ _)) (memberDiagnostics_noImbalance _ _ _ _))
    (detectParentCycle_noImbalance _ _ _ _ _ _ (by decide))) ?_
  no_imbalance

theorem selectDimensions_noImbalance (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (accountingDate : LocalDate) (path : String) :
    ∀ (memberIds : List DimensionMemberId) (selected : List String),
      NoImbalance (selectDimensions snapshot indexes accountingDate path memberIds selected).2 := by
  intro memberIds
  induction memberIds with
  | nil => intro selected; exact NoImbalance.nil
  | cons memberId rest ih =>
    intro selected
    unfold selectDimensions
    split
    · exact NoImbalance.cons_diagnostic (by decide) (ih _)
    · split
      · exact NoImbalance.cons_diagnostic (by decide) (ih _)
      · exact NoImbalance.append (NoImbalance.ite_diagnostic (by decide)) (ih _)

/-- `validateCoordinateWithIndexes` never reports an imbalance. -/
theorem validateCoordinateWithIndexes_noImbalance (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (coordinate : AccountingCoordinate)
    (requiredDimensionIds : List DimensionId) (path : String) (kind : CoordinateKind) :
    NoImbalance (validateCoordinateWithIndexes snapshot indexes coordinate requiredDimensionIds
      path kind) := by
  have := selectDimensions_noImbalance snapshot indexes coordinate.accountingDate path
    coordinate.dimensionMemberIds []
  unfold validateCoordinateWithIndexes
  simp only []
  refine NoImbalance.append (NoImbalance.append ?_ this) ?_
  · split <;> no_imbalance
  · no_imbalance

theorem postingDiagnostics_noImbalance (snapshot : JournalAdmissionSnapshot)
    (indexes : SnapshotIndexes) (journal : JournalTransaction) (path : String)
    (posting : Posting) (postingIds : List String) (ordinals : List Int)
    (unitsDiffer basisDiffer : Bool) :
    NoImbalance (postingDiagnostics snapshot indexes journal path posting postingIds ordinals
      unitsDiffer basisDiffer) := by
  have := validateCoordinateWithIndexes_noImbalance snapshot indexes
    (postingCoordinate journal posting) (requiredDimensionsFor snapshot posting) path .posting
  unfold postingDiagnostics
  no_imbalance

/-- The loop over the postings never reports an imbalance. -/
theorem admitPostings_noImbalance {snapshot : JournalAdmissionSnapshot}
    {indexes : SnapshotIndexes} {journal : JournalTransaction} :
    ∀ {postings : List Posting} {index : Nat} {postingIds : List String} {ordinals : List Int}
      {balance : ExactRational} {result : ExactRational × List SemanticDiagnostic},
      admitPostings snapshot indexes journal index postings postingIds ordinals balance =
        .ok result → NoImbalance result.2 := by
  intro postings
  induction postings with
  | nil =>
    intro index postingIds ordinals balance result h
    simp only [admitPostings, Except.ok.injEq] at h
    subst h
    exact NoImbalance.nil
  | cons posting rest ih =>
    intro index postingIds ordinals balance result h
    unfold admitPostings at h
    cases hstep : admitPosting snapshot indexes journal index posting postingIds ordinals balance with
    | error code => simp [hstep] at h
    | ok step =>
      simp only [hstep] at h
      cases hrest : admitPostings snapshot indexes journal (index + 1) rest
          (posting.id.value :: postingIds) (posting.ordinal :: ordinals) step.1 with
      | error code => simp [hrest] at h
      | ok tail =>
        simp only [hrest, Except.ok.injEq] at h
        subst h
        obtain ⟨_, _, _, _, -, -, -, -, rfl⟩ := (admitPosting_eq_ok_iff ..).mp hstep
        exact NoImbalance.append (postingDiagnostics_noImbalance _ _ _ _ _ _ _ _ _) (ih hrest)

theorem journalHeaderDiagnostics_noImbalance (snapshot : JournalAdmissionSnapshot)
    (journal : JournalTransaction) :
    NoImbalance (journalHeaderDiagnostics snapshot journal) := by
  unfold journalHeaderDiagnostics
  no_imbalance

/-- A rejected journal carries at least one diagnostic. -/
theorem rejected_has_diagnostic {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {diagnostics : List SemanticDiagnostic}
    (h : admitJournal snapshot journal = .ok (.rejected diagnostics)) : diagnostics ≠ [] :=
  ((admitJournal_eq_rejected_iff ..).mp h).choose_spec.2.2

/-- When `admitJournal` does not throw, it reports `journal_imbalance` exactly when the book
values do not add up to zero; a journal with constructible book values that is rejected carries
that diagnostic exactly in that case. -/
theorem rejected_imbalance_iff {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {diagnostics : List SemanticDiagnostic}
    (hw : ∀ posting ∈ journal.postings, posting.bookValue.amount.WF)
    (h : admitJournal snapshot journal = .ok (.rejected diagnostics)) :
    (∃ entry ∈ diagnostics, entry.code = .journal_imbalance) ↔
      (journal.postings.map (·.bookValue.amount.toRat)).sum ≠ 0 := by
  obtain ⟨loop, hloop, rfl, -⟩ := (admitJournal_eq_rejected_iff ..).mp h
  obtain ⟨hwf, hr⟩ := admitLoop_balance hw hloop
  have hzero : loop.1.isZero = true ↔ (journal.postings.map (·.bookValue.amount.toRat)).sum = 0 := by
    rw [ExactRational.isZero_iff hwf, hr]; rfl
  have hbefore : NoImbalance ((validateSnapshot snapshot).2 ++
      journalHeaderDiagnostics snapshot journal ++ loop.2) :=
    NoImbalance.append (NoImbalance.append (validateSnapshot_noImbalance snapshot)
      (journalHeaderDiagnostics_noImbalance snapshot journal)) (admitPostings_noImbalance hloop)
  unfold journalDiagnostics
  constructor
  · rintro ⟨entry, hmem, hcode⟩ hsum
    rcases List.mem_append.mp hmem with hmem | hmem
    · exact hbefore entry hmem hcode
    · simp [hzero.mpr hsum] at hmem
  · intro hsum
    have : loop.1.isZero = false := by
      rw [← Bool.not_eq_true, hzero]; exact hsum
    exact ⟨diagnostic .journal_imbalance "journal.postings" "" ["ACC-003"], by simp [this], rfl⟩

/-- The same for the journal as a whole: whatever `admitJournal` answers without throwing, the
answer is an admission or carries `journal_imbalance` when the book values do not add up to zero,
and it never carries `journal_imbalance` when they do. -/
theorem imbalance_reported_iff {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {result : JournalAdmissionResult}
    (hw : ∀ posting ∈ journal.postings, posting.bookValue.amount.WF)
    (h : admitJournal snapshot journal = .ok result) :
    (∃ diagnostics, result = .rejected diagnostics ∧
        ∃ entry ∈ diagnostics, entry.code = .journal_imbalance) ↔
      (journal.postings.map (·.bookValue.amount.toRat)).sum ≠ 0 := by
  cases result with
  | admitted hash =>
    have := admitted_journal_balances hw h
    simp [this]
  | rejected diagnostics =>
    rw [← rejected_imbalance_iff hw h]
    simp

/-! ## Where the model and the TypeScript differ: the inherited-property lookup

`journal.ts` line 843 reads `snapshot.requiredDimensionIdsByPosting?.[posting.id]`. For an object
whose prototype is `Object.prototype` (an object literal, the result of `JSON.parse`) and a posting
identifier that names a property of `Object.prototype`, the read finds the inherited property when
the object has no own property of that name: a function, or `Object.prototype` itself for
`__proto__`. That value is not `undefined`, so it becomes `requiredDimensions`, and
`for (const requiredDimensionId of requiredDimensionIds)` at line 624 throws a `TypeError` (`{} is
not iterable`): `admitJournal` throws instead of answering. This was run on the shipped code for
each of the twelve names below, with `requiredDimensionIdsByPosting: {}`.

`requiredDimensionsFor` looks among the own properties only, so on those inputs the model goes on
with `snapshot.requiredDimensionIds`. `LookupDiverges` names the inputs. For an input that
satisfies it the TypeScript throws a `TypeError`, unless an `ExactNumberError` is thrown before the
first such posting reaches line 843; for an input that does not, the lookup of the model is the
lookup of the TypeScript. An object made with `Object.create(null)` inherits nothing and never
diverges; an object with another prototype inherits other names, and is outside what
`JournalAdmissionSnapshot.requiredDimensionIdsByPosting` (a list of own properties) can say. -/

/-- The own property names of `Object.prototype` (as `Object.getOwnPropertyNames` lists them in
the runtime the kernel ships on). -/
def objectPrototypeKeys : List String :=
  ["toString", "toLocaleString", "valueOf", "hasOwnProperty", "propertyIsEnumerable",
    "isPrototypeOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__",
    "__lookupSetter__", "__proto__", "constructor"]

/-- The inputs on which the model's lookup and the TypeScript's can differ: there is a map of
required dimensions by posting, and a posting whose identifier is a property name of
`Object.prototype` that the map does not have as an own property. -/
def LookupDiverges (snapshot : JournalAdmissionSnapshot) (journal : JournalTransaction) : Prop :=
  ∃ byPosting, snapshot.requiredDimensionIdsByPosting = some byPosting ∧
    ∃ posting ∈ journal.postings, posting.id.value ∈ objectPrototypeKeys ∧
      byPosting.find? (·.1 == posting.id.value) = none

/-- What the model does on a diverging posting: it requires the snapshot's default dimensions,
where the TypeScript throws. -/
theorem requiredDimensionsFor_of_absent {snapshot : JournalAdmissionSnapshot} {posting : Posting}
    {byPosting : List (String × List DimensionId)}
    (hmap : snapshot.requiredDimensionIdsByPosting = some byPosting)
    (habsent : byPosting.find? (·.1 == posting.id.value) = none) :
    requiredDimensionsFor snapshot posting = snapshot.requiredDimensionIds := by
  simp [requiredDimensionsFor, hmap, habsent]

/-- A snapshot without a map of required dimensions by posting never diverges. -/
theorem not_lookupDiverges_of_none {snapshot : JournalAdmissionSnapshot}
    (journal : JournalTransaction) (h : snapshot.requiredDimensionIdsByPosting = none) :
    ¬ LookupDiverges snapshot journal := by
  rintro ⟨byPosting, hmap, -⟩
  rw [h] at hmap
  cases hmap

/-- A journal none of whose posting identifiers is a property name of `Object.prototype` never
diverges. -/
theorem not_lookupDiverges_of_ids (snapshot : JournalAdmissionSnapshot)
    {journal : JournalTransaction}
    (h : ∀ posting ∈ journal.postings, posting.id.value ∉ objectPrototypeKeys) :
    ¬ LookupDiverges snapshot journal := by
  rintro ⟨_, -, posting, hp, hkey, -⟩
  exact h posting hp hkey

/-! ## Laws: what the canonical value of a journal determines

`canonicalJournalValue` sorts the postings by ordinal and then identifier, and sorts the dimension
members of each posting. So it does NOT determine the journal: two journals that differ only in
the order of their postings, or in the order of a posting's dimension members, have the same
canonical value and the same hash (`canonicalJournalValue_forgets_order` is an example). What it
determines is the journal with both put in that order, `JournalTransaction.canonicalForm`. -/

/-- A posting with its dimension members in the order the canonical value writes them. -/
def Posting.canonicalForm (posting : Posting) : Posting :=
  { posting with dimensionMemberIds := sortDimensionMemberIds posting.dimensionMemberIds }

/-- A journal with its postings in the order the canonical value writes them, each in its
canonical form. -/
def JournalTransaction.canonicalForm (journal : JournalTransaction) : JournalTransaction :=
  { journal with postings := (sortPostings journal.postings).map Posting.canonicalForm }

/-- A rearrangement of a list of entries with distinct keys that has the keys in the same order
is the same list. -/
theorem perm_eq_of_keys {α β : Type} :
    ∀ {xs zs : List (α × β)}, xs.Perm zs → (xs.map Prod.fst).Nodup →
      xs.map Prod.fst = zs.map Prod.fst → xs = zs
  | [], zs, hp, _, _ => by simpa using hp.symm
  | (_, _) :: _, [], _, _, hk => by simp at hk
  | (k, v) :: xs, (k', v') :: zs, hp, hnd, hk => by
    simp only [List.map_cons, List.cons.injEq] at hk
    obtain ⟨rfl, hk'⟩ := hk
    have hmem : (k, v) ∈ (k, v') :: zs := hp.subset List.mem_cons_self
    rcases List.mem_cons.mp hmem with heq | hin
    · have hv : v = v' := by simpa using heq
      subst hv
      rw [perm_eq_of_keys (List.Perm.cons_inv hp) (List.nodup_cons.mp hnd).2 hk']
    · exfalso
      have : k ∈ zs.map Prod.fst := List.mem_map.mpr ⟨(k, v), hin, rfl⟩
      rw [← hk'] at this
      exact (List.nodup_cons.mp hnd).1 this

theorem equivEntries_keys :
    ∀ {zs ys : List (String × CanonicalValue)}, CanonicalValue.EquivEntries zs ys →
      zs.map Prod.fst = ys.map Prod.fst
  | [], [], _ => rfl
  | [], (_, _) :: _, h => False.elim h
  | (_, _) :: _, [], h => False.elim h
  | (k1, v1) :: xs, (k2, v2) :: ys, h => by
    simp only [List.map_cons, List.cons.injEq]
    exact ⟨h.1, equivEntries_keys h.2.2⟩

/-- Two records that are equal up to the order of their entries, written with the same distinct
keys in the same order, are equal entry by entry. -/
theorem equiv_record {xs ys : List (String × CanonicalValue)}
    (h : CanonicalValue.Equiv (.record xs) (.record ys)) (hnd : (xs.map Prod.fst).Nodup)
    (hk : xs.map Prod.fst = ys.map Prod.fst) : CanonicalValue.EquivEntries xs ys := by
  obtain ⟨zs, hp, he⟩ := h
  have := perm_eq_of_keys hp hnd (hk.trans (equivEntries_keys he).symm)
  subst this
  exact he

theorem equivList_strings {α : Type} (f : α → String) (hf : Function.Injective f) :
    ∀ {left right : List α},
      CanonicalValue.EquivList (left.map fun a => .string (f a))
        (right.map fun a => .string (f a)) → left = right
  | [], [], _ => rfl
  | [], _ :: _, h => False.elim h
  | _ :: _, [], h => False.elim h
  | a :: left, b :: right, h => by
    rw [hf h.1, equivList_strings f hf h.2]

theorem rationalValue_equiv {a b : ExactRational}
    (h : (rationalValue a).Equiv (rationalValue b)) : a = b := by
  obtain ⟨-, -, -, hn, -, hd, -⟩ := equiv_record h (by simp) rfl
  have hn' : a.numerator = b.numerator := hn
  have hd' : a.denominator = b.denominator := hd
  cases a; cases b; simp_all

theorem decimalValue_equiv {a b : ExactDecimal}
    (h : (decimalValue a).Equiv (decimalValue b)) : a = b := by
  obtain ⟨-, -, -, hc, -, hs, -⟩ := equiv_record h (by simp) rfl
  have hc' : a.coefficient = b.coefficient := hc
  have hs' : a.scale = b.scale := hs
  cases a; cases b; simp_all

theorem optionalDecimalValue_equiv {a b : Option ExactDecimal}
    (h : CanonicalValue.Equiv
      (match a with
       | none => .null
       | some decimal => decimalValue decimal)
      (match b with
       | none => .null
       | some decimal => decimalValue decimal)) : a = b := by
  cases a <;> cases b
  · rfl
  · exact False.elim h
  · exact False.elim h
  · rw [decimalValue_equiv h]

theorem Identifier.eq_of_value_eq {Kind : String} {a b : Identifier Kind}
    (h : a.value = b.value) : a = b :=
  Identifier.value_injective h

theorem optionalPriceValue_equiv {a b : Option TransactionPrice}
    (h : CanonicalValue.Equiv
      (match a with
       | none => .null
       | some transactionPrice => .record
         [ ("type", .string "TransactionPrice"),
           ("unitRate", rationalValue transactionPrice.unitRate),
           ("baseCommodityId", .string transactionPrice.baseCommodityId.value),
           ("quoteCommodityId", .string transactionPrice.quoteCommodityId.value) ])
      (match b with
       | none => .null
       | some transactionPrice => .record
         [ ("type", .string "TransactionPrice"),
           ("unitRate", rationalValue transactionPrice.unitRate),
           ("baseCommodityId", .string transactionPrice.baseCommodityId.value),
           ("quoteCommodityId", .string transactionPrice.quoteCommodityId.value) ])) :
    a = b := by
  cases a <;> cases b
  · rfl
  · exact False.elim h
  · exact False.elim h
  · rename_i x y
    obtain ⟨-, -, -, hr, -, hb, -, hq, -⟩ := equiv_record h (by simp) rfl
    have e1 := rationalValue_equiv hr
    have e2 : x.baseCommodityId = y.baseCommodityId := Identifier.eq_of_value_eq hb
    have e3 : x.quoteCommodityId = y.quoteCommodityId := Identifier.eq_of_value_eq hq
    cases x; cases y; simp_all

theorem optionalBasisValue_equiv {a b : Option CostBasis}
    (h : CanonicalValue.Equiv
      (match a with
       | none => .null
       | some costBasis => .record
         [ ("type", .string "CostBasis"),
           ("totalBasis", rationalValue costBasis.totalBasis),
           ("basisCommodityId", .string costBasis.basisCommodityId.value),
           ("sourceTotalBasis",
             match costBasis.sourceTotalBasis with
             | none => .null
             | some sourceTotalBasis => decimalValue sourceTotalBasis) ])
      (match b with
       | none => .null
       | some costBasis => .record
         [ ("type", .string "CostBasis"),
           ("totalBasis", rationalValue costBasis.totalBasis),
           ("basisCommodityId", .string costBasis.basisCommodityId.value),
           ("sourceTotalBasis",
             match costBasis.sourceTotalBasis with
             | none => .null
             | some sourceTotalBasis => decimalValue sourceTotalBasis) ])) :
    a = b := by
  cases a <;> cases b
  · rfl
  · exact False.elim h
  · exact False.elim h
  · rename_i x y
    obtain ⟨-, -, -, hr, -, hb, -, hs, -⟩ := equiv_record h (by simp) rfl
    have e1 := rationalValue_equiv hr
    have e2 : x.basisCommodityId = y.basisCommodityId := Identifier.eq_of_value_eq hb
    have e3 := optionalDecimalValue_equiv hs
    cases x; cases y; simp_all

/-- Two postings whose canonical values are equal up to the order of record entries are the same
posting up to the order of their dimension members. -/
theorem canonicalPostingValue_equiv {p q : Posting}
    (h : (canonicalPostingValue p).Equiv (canonicalPostingValue q)) :
    p.canonicalForm = q.canonicalForm := by
  obtain ⟨-, -, -, hid, -, hord, -, hacct, -, hunits, -, hbv, -, hprice, -, hbasis, -, hdims, -⟩ :=
    equiv_record h (by simp) rfl
  obtain ⟨-, -, -, hnum, -, hcomm, -, hsrc, -⟩ := equiv_record hunits (by simp) rfl
  obtain ⟨-, -, -, hamount, -, hfc, -⟩ := equiv_record hbv (by simp) rfl
  have e1 : p.id = q.id := Identifier.eq_of_value_eq hid
  have e2 : p.ordinal = q.ordinal := hord
  have e3 : p.accountId = q.accountId := Identifier.eq_of_value_eq hacct
  have e4 : p.units = q.units := by
    have a := rationalValue_equiv hnum
    have b : p.units.commodityId = q.units.commodityId := Identifier.eq_of_value_eq hcomm
    have c := optionalDecimalValue_equiv hsrc
    cases hp : p.units; cases hq : q.units; simp_all
  have e5 : p.bookValue = q.bookValue := by
    have a := decimalValue_equiv hamount
    have b : p.bookValue.functionalCommodityId = q.bookValue.functionalCommodityId :=
      Identifier.eq_of_value_eq hfc
    cases hp : p.bookValue; cases hq : q.bookValue; simp_all
  have e6 : p.transactionPrice = q.transactionPrice := optionalPriceValue_equiv hprice
  have e7 : p.costBasis = q.costBasis := optionalBasisValue_equiv hbasis
  have e8 : sortDimensionMemberIds p.dimensionMemberIds =
      sortDimensionMemberIds q.dimensionMemberIds :=
    equivList_strings (fun id : DimensionMemberId => id.value) Identifier.value_injective hdims
  cases p; cases q; simp_all [Posting.canonicalForm]

theorem JournalKind.text_injective : Function.Injective JournalKind.text := by
  intro a b h
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

theorem Instant.eq_of_value_eq {a b : Instant} (h : a.value = b.value) : a = b := by
  cases a; cases b; simp_all

theorem LocalDate.eq_of_value_eq {a b : LocalDate} (h : a.value = b.value) : a = b := by
  cases a; cases b; simp_all

theorem optionalInstantValue_equiv {a b : Option Instant}
    (h : CanonicalValue.Equiv
      (match a with
       | none => .null
       | some settledAt => .string settledAt.value)
      (match b with
       | none => .null
       | some settledAt => .string settledAt.value)) : a = b := by
  cases a <;> cases b
  · rfl
  · exact False.elim h
  · exact False.elim h
  · rw [Instant.eq_of_value_eq h]

theorem equivList_postings :
    ∀ {left right : List Posting},
      CanonicalValue.EquivList (left.map canonicalPostingValue)
        (right.map canonicalPostingValue) →
      left.map Posting.canonicalForm = right.map Posting.canonicalForm
  | [], [], _ => rfl
  | [], _ :: _, h => False.elim h
  | _ :: _, [], h => False.elim h
  | p :: left, q :: right, h => by
    simp only [List.map_cons]
    rw [canonicalPostingValue_equiv h.1, equivList_postings h.2]

/-- Two journals whose canonical values are equal up to the order of record entries have the same
canonical form: they are the same journal up to the order of the postings and of each posting's
dimension members. -/
theorem canonicalJournalValue_equiv {j1 j2 : JournalTransaction}
    (h : (canonicalJournalValue j1).Equiv (canonicalJournalValue j2)) :
    j1.canonicalForm = j2.canonicalForm := by
  obtain ⟨-, -, -, hid, -, hkind, -, hbook, -, hfc, -, hecon, -, hdate, -, hsettled, -, hrec, -,
    hnarr, -, hposts, -⟩ := equiv_record h (by simp) rfl
  have e1 : j1.id = j2.id := Identifier.eq_of_value_eq hid
  have e2 : j1.kind = j2.kind := JournalKind.text_injective hkind
  have e3 : j1.bookId = j2.bookId := Identifier.eq_of_value_eq hbook
  have e4 : j1.functionalCommodityId = j2.functionalCommodityId := Identifier.eq_of_value_eq hfc
  have e5 : j1.economicAt = j2.economicAt := Instant.eq_of_value_eq hecon
  have e6 : j1.accountingDate = j2.accountingDate := LocalDate.eq_of_value_eq hdate
  have e7 : j1.settledAt = j2.settledAt := optionalInstantValue_equiv hsettled
  have e8 : j1.recordedAt = j2.recordedAt := Instant.eq_of_value_eq hrec
  have e9 : j1.narration = j2.narration := hnarr
  have e10 := equivList_postings hposts
  cases j1; cases j2; simp_all [JournalTransaction.canonicalForm]

theorem canonicalPostingValue_congr {p q : Posting} (h : p.canonicalForm = q.canonicalForm) :
    canonicalPostingValue p = canonicalPostingValue q := by
  cases p; cases q
  simp only [Posting.canonicalForm, Posting.mk.injEq] at h
  obtain ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, h8⟩ := h
  simp only [canonicalPostingValue, h8]

theorem map_canonicalPostingValue_congr :
    ∀ {left right : List Posting},
      left.map Posting.canonicalForm = right.map Posting.canonicalForm →
      left.map canonicalPostingValue = right.map canonicalPostingValue
  | [], [], _ => rfl
  | [], _ :: _, h => by simp at h
  | _ :: _, [], h => by simp at h
  | p :: left, q :: right, h => by
    simp only [List.map_cons, List.cons.injEq] at h ⊢
    exact ⟨canonicalPostingValue_congr h.1, map_canonicalPostingValue_congr h.2⟩

/-- Two journals with the same canonical form have the same canonical value. -/
theorem canonicalJournalValue_congr {j1 j2 : JournalTransaction}
    (h : j1.canonicalForm = j2.canonicalForm) :
    canonicalJournalValue j1 = canonicalJournalValue j2 := by
  cases j1; cases j2
  simp only [JournalTransaction.canonicalForm, JournalTransaction.mk.injEq] at h
  obtain ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, h10⟩ := h
  simp only [canonicalJournalValue, map_canonicalPostingValue_congr h10]

/-- **What the canonical value determines**: two journals have the same canonical value exactly
when they are the same journal up to the order of the postings and the order of each posting's
dimension members. No hypothesis on the journals is needed. -/
theorem canonicalJournalValue_eq_iff (j1 j2 : JournalTransaction) :
    canonicalJournalValue j1 = canonicalJournalValue j2 ↔
      j1.canonicalForm = j2.canonicalForm :=
  ⟨fun h => canonicalJournalValue_equiv (h ▸ CanonicalValue.Equiv_refl _),
    canonicalJournalValue_congr⟩

theorem rationalValue_wf (value : ExactRational) : (rationalValue value).WF :=
  ⟨by simp, trivial, trivial, trivial, trivial⟩

theorem decimalValue_wf (value : ExactDecimal) : (decimalValue value).WF :=
  ⟨by simp, trivial, trivial, trivial, trivial⟩

theorem wfList_map {α : Type} (f : α → CanonicalValue) (h : ∀ a, (f a).WF) :
    ∀ values : List α, CanonicalValue.WFList (values.map f)
  | [] => trivial
  | a :: rest => ⟨h a, wfList_map f h rest⟩

/-- The canonical value of a posting has no record with a key written twice. -/
theorem canonicalPostingValue_wf (posting : Posting) : (canonicalPostingValue posting).WF := by
  refine ⟨by simp, trivial, trivial, trivial, trivial,
    ⟨by simp, trivial, rationalValue_wf _, trivial, ?_, trivial⟩,
    ⟨by simp, trivial, decimalValue_wf _, trivial, trivial⟩, ?_, ?_,
    wfList_map (fun id : DimensionMemberId => CanonicalValue.string id.value)
      (fun _ => trivial) _, trivial⟩
  · cases posting.units.sourceNumber with
    | none => trivial
    | some sourceNumber => exact decimalValue_wf _
  · cases posting.transactionPrice with
    | none => trivial
    | some price => exact ⟨by simp, trivial, rationalValue_wf _, trivial, trivial, trivial⟩
  · cases posting.costBasis with
    | none => trivial
    | some basis =>
      refine ⟨by simp, trivial, rationalValue_wf _, trivial, ?_, trivial⟩
      cases basis.sourceTotalBasis with
      | none => trivial
      | some sourceTotalBasis => exact decimalValue_wf _

/-- The canonical value of a journal has no record with a key written twice. -/
theorem canonicalJournalValue_wf (journal : JournalTransaction) :
    (canonicalJournalValue journal).WF := by
  refine ⟨by simp, trivial, trivial, trivial, trivial, trivial, trivial, trivial, ?_, trivial,
    trivial, wfList_map _ canonicalPostingValue_wf _, trivial⟩
  cases journal.settledAt <;> trivial

/-- Two journals whose canonical values have the same hash are the same journal up to the order
of the postings and of each posting's dimension members, or a collision of SHA-256 is in hand. -/
theorem canonicalJournalHash_eq {j1 j2 : JournalTransaction}
    (h : hashCanonical (canonicalJournalValue j1) = hashCanonical (canonicalJournalValue j2)) :
    j1.canonicalForm = j2.canonicalForm ∨ HashCollision := by
  rcases hashCanonical_inj_or_collision (canonicalJournalValue_wf j1)
      (canonicalJournalValue_wf j2) h with he | hc
  · exact Or.inl (canonicalJournalValue_equiv he)
  · exact Or.inr hc

/-- Two admitted journals with the same hash are the same journal up to the order of the postings
and of each posting's dimension members, or a collision of SHA-256 is in hand. -/
theorem admitted_hash_determines {s1 s2 : JournalAdmissionSnapshot}
    {j1 j2 : JournalTransaction} {hash : ContentHash}
    (h1 : admitJournal s1 j1 = .ok (.admitted hash))
    (h2 : admitJournal s2 j2 = .ok (.admitted hash)) :
    j1.canonicalForm = j2.canonicalForm ∨ HashCollision :=
  canonicalJournalHash_eq ((admitted_hash h1).symm.trans (admitted_hash h2))

/-- A journal that is already written in the canonical order is determined by its canonical
value. -/
theorem canonicalJournalValue_determines_canonical {j1 j2 : JournalTransaction}
    (h1 : j1.canonicalForm = j1) (h2 : j2.canonicalForm = j2)
    (h : canonicalJournalValue j1 = canonicalJournalValue j2) : j1 = j2 := by
  rw [← h1, ← h2]
  exact (canonicalJournalValue_eq_iff j1 j2).mp h

/-! ### The two sorts put a list in an order that does not depend on the order it came in -/

/-- `left <= right` on two strings, as the two sorts use it. -/
def textLe (left right : String) : Bool := compareCanonicalText left right != .gt

theorem textLe_total (a b : String) : (textLe a b || textLe b a) = true := by
  unfold textLe
  cases h : compareCanonicalText a b with
  | lt => simp
  | eq => simp
  | gt =>
    have := (compareCanonicalText_antisymm b a).mpr h
    simp [this]

theorem textLe_trans {a b c : String} (hab : textLe a b = true) (hbc : textLe b c = true) :
    textLe a c = true := by
  unfold textLe at *
  cases h1 : compareCanonicalText a b with
  | gt => simp [h1] at hab
  | eq =>
    rw [(compareCanonicalText_eq_iff a b).mp h1]
    exact hbc
  | lt =>
    cases h2 : compareCanonicalText b c with
    | gt => simp [h2] at hbc
    | eq =>
      rw [← (compareCanonicalText_eq_iff b c).mp h2, h1]
      rfl
    | lt =>
      rw [compareCanonicalText_trans a b c h1 h2]
      rfl

theorem textLe_antisymm {a b : String} (hab : textLe a b = true) (hba : textLe b a = true) :
    a = b := by
  unfold textLe at *
  cases h1 : compareCanonicalText a b with
  | gt => simp [h1] at hab
  | eq => exact (compareCanonicalText_eq_iff a b).mp h1
  | lt =>
    have := (compareCanonicalText_antisymm a b).mp h1
    simp [this] at hba

/-- `comparePostings` puts one posting before another, or level with it, exactly when its ordinal
is smaller, or equal with an identifier that is not greater. -/
theorem comparePostings_le_iff (p q : Posting) :
    (comparePostings p q != .gt) = true ↔
      p.ordinal < q.ordinal ∨ (p.ordinal = q.ordinal ∧ textLe p.id.value q.id.value = true) := by
  unfold comparePostings textLe
  by_cases h1 : p.ordinal < q.ordinal
  · simp [h1]
  · by_cases h2 : q.ordinal < p.ordinal
    · simp only [h1, h2, ↓reduceIte, bne_self_eq_false, Bool.false_eq_true, false_or, false_iff,
        not_and]
      intro h; omega
    · have : p.ordinal = q.ordinal := by omega
      simp [this]

theorem sortDimensionMemberIds_perm {left right : List DimensionMemberId}
    (h : left.Perm right) : sortDimensionMemberIds left = sortDimensionMemberIds right := by
  have htrans : ∀ a b c : DimensionMemberId, textLe a.value b.value = true →
      textLe b.value c.value = true → textLe a.value c.value = true :=
    fun _ _ _ => textLe_trans
  have htotal : ∀ a b : DimensionMemberId,
      (textLe a.value b.value || textLe b.value a.value) = true :=
    fun a b => textLe_total a.value b.value
  exact List.Perm.eq_of_pairwise
    (le := fun a b : DimensionMemberId => textLe a.value b.value = true)
    (fun a b _ _ hab hba => Identifier.eq_of_value_eq (textLe_antisymm hab hba))
    (List.pairwise_mergeSort htrans htotal left) (List.pairwise_mergeSort htrans htotal right)
    ((List.mergeSort_perm left _).trans (h.trans (List.mergeSort_perm right _).symm))

/-- Postings no two of which have the same ordinal and identifier are sorted into one order
whatever order they came in. -/
theorem sortPostings_perm {left right : List Posting} (h : left.Perm right)
    (hkey : ∀ p ∈ left, ∀ q ∈ left, p.ordinal = q.ordinal → p.id = q.id → p = q) :
    sortPostings left = sortPostings right := by
  have htrans : ∀ a b c : Posting, (comparePostings a b != .gt) = true →
      (comparePostings b c != .gt) = true → (comparePostings a c != .gt) = true := by
    intro a b c hab hbc
    rw [comparePostings_le_iff] at *
    rcases hab with hab | ⟨hab, hab'⟩ <;> rcases hbc with hbc | ⟨hbc, hbc'⟩
    · left; omega
    · left; omega
    · left; omega
    · right; exact ⟨by omega, textLe_trans hab' hbc'⟩
  have htotal : ∀ a b : Posting,
      ((comparePostings a b != .gt) || (comparePostings b a != .gt)) = true := by
    intro a b
    rw [Bool.or_eq_true, comparePostings_le_iff, comparePostings_le_iff]
    rcases lt_trichotomy a.ordinal b.ordinal with hlt | heq | hgt
    · exact Or.inl (Or.inl hlt)
    · rcases Bool.or_eq_true _ _ ▸ textLe_total a.id.value b.id.value with ht | ht
      · exact Or.inl (Or.inr ⟨heq, ht⟩)
      · exact Or.inr (Or.inr ⟨heq.symm, ht⟩)
    · exact Or.inr (Or.inl hgt)
  refine List.Perm.eq_of_pairwise
    (le := fun a b : Posting => (comparePostings a b != .gt) = true) ?_
    (List.pairwise_mergeSort htrans htotal left) (List.pairwise_mergeSort htrans htotal right)
    ((List.mergeSort_perm left _).trans (h.trans (List.mergeSort_perm right _).symm))
  intro a b ha hb hab hba
  have ha' : a ∈ left := (List.mergeSort_perm left _).subset ha
  have hb' : b ∈ left := h.symm.subset ((List.mergeSort_perm right _).subset hb)
  rw [comparePostings_le_iff] at hab hba
  rcases hab with hab | ⟨hab, hab'⟩
  · rcases hba with hba | ⟨hba, -⟩ <;> omega
  · rcases hba with hba | ⟨-, hba'⟩
    · omega
    · exact hkey a ha' b hb' hab (Identifier.eq_of_value_eq (textLe_antisymm hab' hba'))

/-- Two postings that differ at most in the order of their dimension members. -/
structure Posting.SameUpToOrder (p q : Posting) : Prop where
  id : p.id = q.id
  ordinal : p.ordinal = q.ordinal
  accountId : p.accountId = q.accountId
  units : p.units = q.units
  bookValue : p.bookValue = q.bookValue
  transactionPrice : p.transactionPrice = q.transactionPrice
  costBasis : p.costBasis = q.costBasis
  dimensionMemberIds : p.dimensionMemberIds.Perm q.dimensionMemberIds

/-- Two journals that differ at most in the order of their postings and in the order of the
dimension members of each posting. -/
structure JournalTransaction.SameUpToOrder (j1 j2 : JournalTransaction) : Prop where
  id : j1.id = j2.id
  kind : j1.kind = j2.kind
  bookId : j1.bookId = j2.bookId
  functionalCommodityId : j1.functionalCommodityId = j2.functionalCommodityId
  economicAt : j1.economicAt = j2.economicAt
  accountingDate : j1.accountingDate = j2.accountingDate
  settledAt : j1.settledAt = j2.settledAt
  recordedAt : j1.recordedAt = j2.recordedAt
  narration : j1.narration = j2.narration
  postings : ∃ rearranged, j1.postings.Perm rearranged ∧
    List.Forall₂ Posting.SameUpToOrder rearranged j2.postings

/-- Two postings have the same canonical form exactly when they differ at most in the order of
their dimension members. -/
theorem Posting.canonicalForm_eq_iff (p q : Posting) :
    p.canonicalForm = q.canonicalForm ↔ p.SameUpToOrder q := by
  constructor
  · intro h
    have e1 := congrArg Posting.id h
    have e2 := congrArg Posting.ordinal h
    have e3 := congrArg Posting.accountId h
    have e4 := congrArg Posting.units h
    have e5 := congrArg Posting.bookValue h
    have e6 := congrArg Posting.transactionPrice h
    have e7 := congrArg Posting.costBasis h
    refine ⟨e1, e2, e3, e4, e5, e6, e7, ?_⟩
    have hd : sortDimensionMemberIds p.dimensionMemberIds =
        sortDimensionMemberIds q.dimensionMemberIds := congrArg Posting.dimensionMemberIds h
    have h1 : (sortDimensionMemberIds p.dimensionMemberIds).Perm p.dimensionMemberIds :=
      List.mergeSort_perm _ _
    have h2 : (sortDimensionMemberIds q.dimensionMemberIds).Perm q.dimensionMemberIds :=
      List.mergeSort_perm _ _
    exact h1.symm.trans (hd ▸ h2)
  · rintro ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩
    cases p; cases q
    dsimp only at h1 h2 h3 h4 h5 h6 h7 h8
    subst h1 h2 h3 h4 h5 h6 h7
    simp only [Posting.canonicalForm, sortDimensionMemberIds_perm h8]

theorem forall₂_sameUpToOrder_iff (left right : List Posting) :
    List.Forall₂ Posting.SameUpToOrder left right ↔
      left.map Posting.canonicalForm = right.map Posting.canonicalForm := by
  rw [← List.forall₂_eq_eq_eq, List.forall₂_map_left_iff, List.forall₂_map_right_iff]
  constructor
  · exact List.Forall₂.imp fun p q h => (Posting.canonicalForm_eq_iff p q).mpr h
  · exact List.Forall₂.imp fun p q h => (Posting.canonicalForm_eq_iff p q).mp h

/-- Two journals with the same canonical form differ at most in the order of their postings and
of each posting's dimension members. -/
theorem JournalTransaction.sameUpToOrder_of_canonicalForm_eq {j1 j2 : JournalTransaction}
    (h : j1.canonicalForm = j2.canonicalForm) : j1.SameUpToOrder j2 := by
  have e1 := congrArg JournalTransaction.id h
  have e2 := congrArg JournalTransaction.kind h
  have e3 := congrArg JournalTransaction.bookId h
  have e4 := congrArg JournalTransaction.functionalCommodityId h
  have e5 := congrArg JournalTransaction.economicAt h
  have e6 := congrArg JournalTransaction.accountingDate h
  have e7 := congrArg JournalTransaction.settledAt h
  have e8 := congrArg JournalTransaction.recordedAt h
  have e9 := congrArg JournalTransaction.narration h
  refine ⟨e1, e2, e3, e4, e5, e6, e7, e8, e9, ?_⟩
  have hp : (sortPostings j1.postings).map Posting.canonicalForm =
      (sortPostings j2.postings).map Posting.canonicalForm :=
    congrArg JournalTransaction.postings h
  have hcomp : Relation.Comp (List.Forall₂ Posting.SameUpToOrder) List.Perm
      (sortPostings j1.postings) j2.postings :=
    ⟨sortPostings j2.postings, (forall₂_sameUpToOrder_iff _ _).mpr hp, List.mergeSort_perm _ _⟩
  rw [List.forall₂_comp_perm_eq_perm_comp_forall₂] at hcomp
  obtain ⟨rearranged, hperm, hall⟩ := hcomp
  exact ⟨rearranged, (List.mergeSort_perm j1.postings _).symm.trans hperm, hall⟩

/-- Two journals that differ at most in the order of their postings and of each posting's
dimension members have the same canonical form, when no two postings share an ordinal. -/
theorem JournalTransaction.canonicalForm_eq_of_sameUpToOrder {j1 j2 : JournalTransaction}
    (hord : (j1.postings.map (·.ordinal)).Nodup) (h : j1.SameUpToOrder j2) :
    j1.canonicalForm = j2.canonicalForm := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, rearranged, hperm, hall⟩ := h
  have hsort : sortPostings j1.postings = sortPostings rearranged :=
    sortPostings_perm hperm fun p hp q hq hpq _ => List.inj_on_of_nodup_map hord hp hq hpq
  have hmap : ∀ postings : List Posting,
      (sortPostings postings).map Posting.canonicalForm =
        sortPostings (postings.map Posting.canonicalForm) := fun postings =>
    List.map_mergeSort fun _ _ _ _ => rfl
  have hp : (sortPostings j1.postings).map Posting.canonicalForm =
      (sortPostings j2.postings).map Posting.canonicalForm := by
    rw [hsort, hmap, hmap, (forall₂_sameUpToOrder_iff _ _).mp hall]
  cases j1; cases j2
  dsimp only at h1 h2 h3 h4 h5 h6 h7 h8 h9 hp
  subst h1 h2 h3 h4 h5 h6 h7 h8 h9
  simp only [JournalTransaction.canonicalForm, hp]

/-- **The strongest true form of "the canonical value determines the journal"**: for a journal no
two of whose postings share an ordinal (every admitted journal), another journal has the same
canonical value exactly when the two differ at most in the order of their postings and in the
order of each posting's dimension members. -/
theorem canonicalJournalValue_eq_iff_sameUpToOrder {j1 j2 : JournalTransaction}
    (hord : (j1.postings.map (·.ordinal)).Nodup) :
    canonicalJournalValue j1 = canonicalJournalValue j2 ↔ j1.SameUpToOrder j2 := by
  rw [canonicalJournalValue_eq_iff]
  exact ⟨JournalTransaction.sameUpToOrder_of_canonicalForm_eq,
    JournalTransaction.canonicalForm_eq_of_sameUpToOrder hord⟩

/-- Two admitted journals with the same hash differ at most in the order of their postings and of
each posting's dimension members, or a collision of SHA-256 is in hand. -/
theorem admitted_same_hash {s1 s2 : JournalAdmissionSnapshot} {j1 j2 : JournalTransaction}
    {hash : ContentHash} (h1 : admitJournal s1 j1 = .ok (.admitted hash))
    (h2 : admitJournal s2 j2 = .ok (.admitted hash)) :
    j1.SameUpToOrder j2 ∨ HashCollision :=
  (admitted_hash_determines h1 h2).imp JournalTransaction.sameUpToOrder_of_canonicalForm_eq id

/-- **The canonical value does not determine the journal.** Writing two postings with different
ordinals in the other order gives a different journal with the same canonical value, and so the
same hash: the order of `journal.postings` is not in the canonical value. -/
theorem canonicalJournalValue_forgets_order (journal : JournalTransaction) (p q : Posting)
    (hpq : p.ordinal ≠ q.ordinal) (hj : journal.postings = [p, q]) :
    ({ journal with postings := [q, p] } : JournalTransaction) ≠ journal ∧
      canonicalJournalValue { journal with postings := [q, p] } =
        canonicalJournalValue journal ∧
      hashCanonical (canonicalJournalValue { journal with postings := [q, p] }) =
        hashCanonical (canonicalJournalValue journal) := by
  have hne : ({ journal with postings := [q, p] } : JournalTransaction) ≠ journal := by
    intro h
    have := congrArg JournalTransaction.postings h
    rw [hj] at this
    simp only [List.cons.injEq, and_true] at this
    exact hpq (by rw [this.1])
  have heq : canonicalJournalValue { journal with postings := [q, p] } =
      canonicalJournalValue journal := by
    refine (canonicalJournalValue_eq_iff_sameUpToOrder ?_).mpr ⟨rfl, rfl, rfl, rfl, rfl, rfl,
      rfl, rfl, rfl, [p, q], List.Perm.swap p q [], ?_⟩
    · simpa using fun h => hpq h.symm
    · rw [hj, forall₂_sameUpToOrder_iff]
  exact ⟨hne, heq, by rw [heq]⟩

/-- The order of a posting's dimension members is not in the canonical value either. -/
theorem canonicalPostingValue_forgets_member_order (posting : Posting)
    (members : List DimensionMemberId) (h : members.Perm posting.dimensionMemberIds) :
    canonicalPostingValue { posting with dimensionMemberIds := members } =
      canonicalPostingValue posting :=
  canonicalPostingValue_congr ((Posting.canonicalForm_eq_iff _ _).mpr
    ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, h⟩)

/-! ## Laws of `detectParentCycle`: the fuel is enough, and what "no cycle" means -/

theorem parentCycleFrom_none {T : Type} (idOf : T → String) (parentOf : T → Option String)
    (index : IdIndex T) (fuel : Nat) (visited : List String) :
    parentCycleFrom idOf parentOf index fuel visited none = false := by
  cases fuel <;> simp [parentCycleFrom]

theorem parentCycleFrom_root {T : Type} {idOf : T → String} {parentOf : T → Option String}
    {index : IdIndex T} {value : T} (fuel : Nat) (visited : List String)
    (h : parentOf value = none) :
    parentCycleFrom idOf parentOf index (fuel + 1) visited (some value) = false := by
  rw [parentCycleFrom, h]

theorem parentCycleFrom_visited {T : Type} {idOf : T → String} {parentOf : T → Option String}
    {index : IdIndex T} {value : T} {parentId : String} (fuel : Nat) {visited : List String}
    (h : parentOf value = some parentId) (hv : idOf value ∈ visited) :
    parentCycleFrom idOf parentOf index (fuel + 1) visited (some value) = true := by
  rw [parentCycleFrom, h]
  exact ite_eq_left (by simpa using hv)

theorem parentCycleFrom_next {T : Type} {idOf : T → String} {parentOf : T → Option String}
    {index : IdIndex T} {value : T} {parentId : String} (fuel : Nat) {visited : List String}
    (h : parentOf value = some parentId) (hv : idOf value ∉ visited) :
    parentCycleFrom idOf parentOf index (fuel + 1) visited (some value) =
      parentCycleFrom idOf parentOf index fuel (idOf value :: visited) (index.get parentId) := by
  rw [parentCycleFrom, h]
  exact ite_eq_right (by simpa using hv)

/-- With enough fuel, one more turn changes nothing. `known` lists every identifier the loop can
visit; each turn that does not end the loop adds a new one of them to `visited`, so the loop ends
before the fuel does. -/
theorem parentCycleFrom_succ {T : Type} (idOf : T → String) (parentOf : T → Option String)
    (index : IdIndex T) (known : List String)
    (hknown : ∀ key value, index.get key = some value → idOf value ∈ known) :
    ∀ (fuel : Nat) (visited : List String) (cursor : Option T),
      visited.Nodup → visited ⊆ known → (∀ value, cursor = some value → idOf value ∈ known) →
      known.length < fuel + visited.length →
      parentCycleFrom idOf parentOf index (fuel + 1) visited cursor =
        parentCycleFrom idOf parentOf index fuel visited cursor := by
  intro fuel
  induction fuel with
  | zero =>
    intro visited cursor hnodup hsubset _ hlength
    have := (hnodup.subperm hsubset).length_le
    omega
  | succ fuel ih =>
    intro visited cursor hnodup hsubset hcursor hlength
    cases cursor with
    | none => rw [parentCycleFrom_none, parentCycleFrom_none]
    | some value =>
      cases hparent : parentOf value with
      | none => rw [parentCycleFrom_root _ _ hparent, parentCycleFrom_root _ _ hparent]
      | some parentId =>
        by_cases hvisited : idOf value ∈ visited
        · rw [parentCycleFrom_visited _ hparent hvisited,
            parentCycleFrom_visited _ hparent hvisited]
        · rw [parentCycleFrom_next _ hparent hvisited, parentCycleFrom_next _ hparent hvisited]
          exact ih (idOf value :: visited) (index.get parentId)
            (List.nodup_cons.mpr ⟨hvisited, hnodup⟩)
            (List.cons_subset.mpr ⟨hcursor value rfl, hsubset⟩)
            (fun next hnext => hknown parentId next hnext)
            (by simp only [List.length_cons]; omega)

theorem IdIndex.get_mem {T : Type} {index : IdIndex T} {key : String} {value : T}
    (h : index.get key = some value) : value ∈ index.map (·.2) := by
  unfold IdIndex.get at h
  obtain ⟨entry, hentry, rfl⟩ := Option.map_eq_some_iff.mp h
  exact List.mem_map.mpr ⟨entry, List.mem_of_find?_eq_some hentry, rfl⟩

/-- **The fuel of `detectParentCycle` is never used up**: with any more fuel than the model
gives, the loop for a value answers the same, so the model's answer is that of the unbounded
loop of the TypeScript. -/
theorem parentCycleFrom_fuel {T : Type} (idOf : T → String) (parentOf : T → Option String)
    (index : IdIndex T) (value : T) (extra : Nat) :
    parentCycleFrom idOf parentOf index (index.length + 2 + extra) [] (some value) =
      parentCycleFrom idOf parentOf index (index.length + 2) [] (some value) := by
  induction extra with
  | zero => rfl
  | succ extra ih =>
    rw [← ih]
    refine parentCycleFrom_succ idOf parentOf index
      (idOf value :: index.map (fun entry => idOf entry.2))
      (fun key found hfound => ?_) _ [] (some value) List.nodup_nil (List.nil_subset _)
      (fun found hfound => ?_) (by simp; omega)
    · obtain ⟨entry, hentry, rfl⟩ := List.mem_map.mp (IdIndex.get_mem hfound)
      exact List.mem_cons_of_mem _ (List.mem_map.mpr ⟨entry, hentry, rfl⟩)
    · cases hfound
      exact List.mem_cons_self

/-- Following parents from a value comes to an end: at a value without a parent, or at a parent
the lookup does not find. -/
inductive ParentChainEnds {T : Type} (parentOf : T → Option String)
    (lookup : String → Option T) : T → Prop
  | root {value : T} : parentOf value = none → ParentChainEnds parentOf lookup value
  | unresolved {value : T} {parentId : String} : parentOf value = some parentId →
      lookup parentId = none → ParentChainEnds parentOf lookup value
  | step {value parent : T} {parentId : String} : parentOf value = some parentId →
      lookup parentId = some parent → ParentChainEnds parentOf lookup parent →
      ParentChainEnds parentOf lookup value

/-- When the loop of `detectParentCycle` reports no cycle for a value (and the fuel is enough),
following parents from that value comes to an end. -/
theorem parentChainEnds_of_no_cycle {T : Type} (idOf : T → String)
    (parentOf : T → Option String) (index : IdIndex T) (known : List String)
    (hknown : ∀ key value, index.get key = some value → idOf value ∈ known) :
    ∀ (fuel : Nat) (visited : List String) (value : T),
      visited.Nodup → visited ⊆ known → idOf value ∈ known →
      known.length < fuel + visited.length →
      parentCycleFrom idOf parentOf index fuel visited (some value) = false →
      ParentChainEnds parentOf index.get value := by
  intro fuel
  induction fuel with
  | zero =>
    intro visited value hnodup hsubset _ hlength _
    have := (hnodup.subperm hsubset).length_le
    omega
  | succ fuel ih =>
    intro visited value hnodup hsubset hvalue hlength h
    cases hparent : parentOf value with
    | none => exact .root hparent
    | some parentId =>
      by_cases hvisited : idOf value ∈ visited
      · rw [parentCycleFrom_visited _ hparent hvisited] at h
        cases h
      · rw [parentCycleFrom_next _ hparent hvisited] at h
        cases hnext : index.get parentId with
        | none => exact .unresolved hparent hnext
        | some parent =>
          rw [hnext] at h
          exact .step hparent hnext (ih (idOf value :: visited) parent
            (List.nodup_cons.mpr ⟨hvisited, hnodup⟩)
            (List.cons_subset.mpr ⟨hvalue, hsubset⟩) (hknown parentId parent hnext)
            (by simp only [List.length_cons]; omega) h)

/-- One step up a hierarchy: the value has a parent and the lookup finds it. -/
def ParentStep {T : Type} (parentOf : T → Option String) (lookup : String → Option T)
    (value parent : T) : Prop :=
  ∃ parentId, parentOf value = some parentId ∧ lookup parentId = some parent

/-- A hierarchy whose chain of parents ends from a value does not come back to that value. -/
theorem ParentChainEnds.no_return {T : Type} {parentOf : T → Option String}
    {lookup : String → Option T} {value : T} (h : ParentChainEnds parentOf lookup value) :
    ∀ parent, ParentStep parentOf lookup value parent →
      ¬ Relation.ReflTransGen (ParentStep parentOf lookup) parent value := by
  induction h with
  | root hroot =>
    rintro parent ⟨parentId, hparent, -⟩ -
    rw [hroot] at hparent
    cases hparent
  | unresolved hparent hnone =>
    rintro parent ⟨parentId, hparent', hsome⟩ -
    rw [hparent] at hparent'
    cases hparent'
    rw [hnone] at hsome
    cases hsome
  | @step value parent parentId hparent hsome _ ih =>
    rintro parent' ⟨parentId', hparent', hsome'⟩ hreach
    rw [hparent] at hparent'
    cases hparent'
    rw [hsome] at hsome'
    cases hsome'
    have hstep : ParentStep parentOf lookup value parent := ⟨parentId, hparent, hsome⟩
    rcases hreach.cases_head with heq | ⟨next, hnext, hrest⟩
    · subst heq
      exact ih parent hstep .refl
    · exact ih next hnext (hrest.tail hstep)

/-- When following parents from a value comes to an end, the loop of `detectParentCycle` reports
no cycle for it, whatever the fuel, provided the index is keyed by the identifiers and holds the
value under its own identifier. -/
theorem no_cycle_of_parentChainEnds {T : Type} (idOf : T → String)
    (parentOf : T → Option String) (index : IdIndex T)
    (hkeyed : ∀ key value, index.get key = some value → idOf value = key) :
    ∀ {value : T}, ParentChainEnds parentOf index.get value →
      index.get (idOf value) = some value →
      ∀ (fuel : Nat) (visited : List String),
        (∀ reached, Relation.ReflTransGen (ParentStep parentOf index.get) value reached →
          idOf reached ∉ visited) →
        parentCycleFrom idOf parentOf index fuel visited (some value) = false := by
  intro value h
  induction h with
  | root hroot =>
    intro _ fuel visited _
    cases fuel with
    | zero => rfl
    | succ fuel => exact parentCycleFrom_root fuel visited hroot
  | unresolved hparent hnone =>
    intro _ fuel visited hfresh
    cases fuel with
    | zero => rfl
    | succ fuel =>
      rw [parentCycleFrom_next fuel hparent (hfresh _ .refl), hnone, parentCycleFrom_none]
  | @step value parent parentId hparent hsome hends ih =>
    intro hindexed fuel visited hfresh
    cases fuel with
    | zero => rfl
    | succ fuel =>
      have hstep : ParentStep parentOf index.get value parent := ⟨parentId, hparent, hsome⟩
      have hparentIndexed : index.get (idOf parent) = some parent := by
        rw [hkeyed parentId parent hsome]; exact hsome
      rw [parentCycleFrom_next fuel hparent (hfresh _ .refl), hsome]
      refine ih hparentIndexed fuel (idOf value :: visited) fun reached hreach => ?_
      rw [List.mem_cons, not_or]
      refine ⟨fun heq => ?_, hfresh reached (.head hstep hreach)⟩
      have hreachedIndexed : index.get (idOf reached) = some reached := by
        rcases hreach.cases_tail with heq' | ⟨before, -, ⟨key, -, hkey⟩⟩
        · rw [heq']; exact hparentIndexed
        · rw [hkeyed key reached hkey]; exact hkey
      have hsame : reached = value := by
        rw [heq, hindexed] at hreachedIndexed
        exact (Option.some.inj hreachedIndexed).symm
      subst hsame
      exact (ParentChainEnds.step hparent hsome hends).no_return parent hstep hreach

theorem find?_eq_some_of_nodup {α : Type} (f : α → String) :
    ∀ {values : List α} {value : α}, (values.map f).Nodup → value ∈ values →
      values.find? (fun other => f other == f value) = some value
  | [], _, _, h => absurd h (by simp)
  | head :: rest, value, hnodup, hmem => by
    rw [List.map_cons, List.nodup_cons] at hnodup
    rcases List.mem_cons.mp hmem with rfl | hrest
    · simp
    · have hne : f head ≠ f value := fun heq =>
        hnodup.1 (heq ▸ List.mem_map.mpr ⟨value, hrest, rfl⟩)
      rw [List.find?_cons_of_neg (by simpa using hne)]
      exact find?_eq_some_of_nodup f hnodup.2 hrest

theorem detectParentCycle_eq_nil_iff {T : Type} (idOf : T → String)
    (parentOf : T → Option String) (values : List T) (index : IdIndex T) (path : String)
    (code : SemanticDiagnosticCode) (requirementId : String) :
    detectParentCycle idOf parentOf values index path code requirementId = [] ↔
      ∀ value ∈ values,
        parentCycleFrom idOf parentOf index (index.length + 2) [] (some value) = false := by
  unfold detectParentCycle
  simp

/-- **What "no cycle" means**: for values with distinct identifiers, indexed by `indexById`,
`detectParentCycle` pushes no diagnostic for a value exactly when following parents from it comes
to an end. -/
theorem parentCycleFrom_indexById_eq_false_iff {T : Type} (idOf : T → String)
    (parentOf : T → Option String) (values : List T) (path : String)
    (hnodup : (values.map idOf).Nodup) {value : T} (hmem : value ∈ values) :
    parentCycleFrom idOf parentOf (indexById idOf values path).1
        ((indexById idOf values path).1.length + 2) [] (some value) = false ↔
      ParentChainEnds parentOf (indexById idOf values path).1.get value := by
  constructor
  · intro h
    refine parentChainEnds_of_no_cycle idOf parentOf _
      (idOf value :: (indexById idOf values path).1.map (fun entry => idOf entry.2))
      (fun key found hfound => ?_) _ [] value List.nodup_nil (List.nil_subset _)
      List.mem_cons_self (by simp) h
    obtain ⟨entry, hentry, rfl⟩ := List.mem_map.mp (IdIndex.get_mem hfound)
    exact List.mem_cons_of_mem _ (List.mem_map.mpr ⟨entry, hentry, rfl⟩)
  · intro h
    refine no_cycle_of_parentChainEnds idOf parentOf _ (fun key found hfound => ?_) h ?_ _ []
      (fun _ _ => by simp)
    · rw [indexById_get] at hfound
      simpa using List.find?_some hfound
    · rw [indexById_get]
      exact find?_eq_some_of_nodup idOf hnodup hmem

theorem closesBeforeOpens_eq_false_iff (openedOn : LocalDate) (closedOn : Option LocalDate) :
    closesBeforeOpens openedOn closedOn = false ↔
      ∀ closed, closedOn = some closed → ¬ closed < openedOn := by
  cases closedOn <;> simp [closesBeforeOpens]

theorem accountDiagnostics_eq_nil_iff (snapshot : JournalAdmissionSnapshot)
    (accounts : IdIndex AccountSnapshot) :
    ∀ (values : List AccountSnapshot) (codes : List String),
      accountDiagnostics snapshot accounts values codes = [] ↔
        (∀ account ∈ values, account.bookId = snapshot.bookId ∧
          closesBeforeOpens account.openedOn account.closedOn = false ∧
          ∀ parentId, account.parentId = some parentId → accounts.has parentId.value = true) ∧
        (values.map (·.code)).Nodup ∧ ∀ account ∈ values, account.code ∉ codes := by
  intro values
  induction values with
  | nil => intro codes; simp [accountDiagnostics]
  | cons account rest ih =>
    intro codes
    have hparent : (match account.parentId with
        | none => false
        | some parentId => !accounts.has parentId.value) = false ↔
        ∀ parentId, account.parentId = some parentId → accounts.has parentId.value = true := by
      cases account.parentId <;> simp
    unfold accountDiagnostics
    simp only [List.append_eq_nil_iff, ite_eq_right_iff, List.cons_ne_nil, imp_false, ne_eq,
      not_not, List.contains_iff_mem, Bool.not_eq_true, hparent, ih, List.mem_cons,
      forall_eq_or_imp, List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and,
      not_or]
    constructor
    · rintro ⟨⟨⟨⟨hbook, hcode⟩, hdates⟩, hpar⟩, hrest, hnodup, hfresh⟩
      exact ⟨⟨⟨hbook, hdates, hpar⟩, hrest⟩, ⟨fun other hother heq => (hfresh other hother).1 heq,
        hnodup⟩, hcode, fun other hother => (hfresh other hother).2⟩
    · rintro ⟨⟨⟨hbook, hdates, hpar⟩, hrest⟩, ⟨hnew, hnodup⟩, hcode, hfresh⟩
      exact ⟨⟨⟨⟨hbook, hcode⟩, hdates⟩, hpar⟩, hrest, hnodup,
        fun other hother => ⟨fun heq => hnew other hother heq, hfresh other hother⟩⟩

theorem dimensionDiagnostics_eq_nil_iff (snapshot : JournalAdmissionSnapshot) :
    ∀ (values : List AccountingDimensionSnapshot) (codes : List String),
      dimensionDiagnostics snapshot values codes = [] ↔
        (∀ dimension ∈ values, dimension.bookId = snapshot.bookId ∧
          closesBeforeOpens dimension.openedOn dimension.closedOn = false) ∧
        (values.map (·.code)).Nodup ∧ ∀ dimension ∈ values, dimension.code ∉ codes := by
  intro values
  induction values with
  | nil => intro codes; simp [dimensionDiagnostics]
  | cons dimension rest ih =>
    intro codes
    unfold dimensionDiagnostics
    simp only [List.append_eq_nil_iff, ite_eq_right_iff, List.cons_ne_nil, imp_false, ne_eq,
      not_not, List.contains_iff_mem, Bool.not_eq_true, ih, List.mem_cons,
      forall_eq_or_imp, List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and,
      not_or]
    constructor
    · rintro ⟨⟨⟨hbook, hcode⟩, hdates⟩, hrest, hnodup, hfresh⟩
      exact ⟨⟨⟨hbook, hdates⟩, hrest⟩, ⟨fun other hother heq => (hfresh other hother).1 heq,
        hnodup⟩, hcode, fun other hother => (hfresh other hother).2⟩
    · rintro ⟨⟨⟨hbook, hdates⟩, hrest⟩, ⟨hnew, hnodup⟩, hcode, hfresh⟩
      exact ⟨⟨⟨hbook, hcode⟩, hdates⟩, hrest, hnodup,
        fun other hother => ⟨fun heq => hnew other hother heq, hfresh other hother⟩⟩

theorem memberDiagnostics_eq_nil_iff (dimensions : IdIndex AccountingDimensionSnapshot)
    (members : IdIndex DimensionMemberSnapshot) :
    ∀ (values : List DimensionMemberSnapshot) (codes : List String),
      memberDiagnostics dimensions members values codes = [] ↔
        (∀ member ∈ values, dimensions.has member.dimensionId.value = true ∧
          closesBeforeOpens member.openedOn member.closedOn = false ∧
          ∀ parentId, member.parentId = some parentId → ∃ parent,
            members.get parentId.value = some parent ∧
              parent.dimensionId = member.dimensionId) ∧
        (values.map scopedCode).Nodup ∧ ∀ member ∈ values, scopedCode member ∉ codes := by
  intro values
  induction values with
  | nil => intro codes; simp [memberDiagnostics]
  | cons member rest ih =>
    intro codes
    have hparent : (match member.parentId with
        | none => false
        | some parentId =>
          match members.get parentId.value with
          | none => true
          | some parent => decide (parent.dimensionId ≠ member.dimensionId)) = false ↔
        ∀ parentId, member.parentId = some parentId → ∃ parent,
          members.get parentId.value = some parent ∧
            parent.dimensionId = member.dimensionId := by
      cases member.parentId with
      | none => simp
      | some parentId => cases hget : members.get parentId.value <;> simp [hget]
    unfold memberDiagnostics
    simp only [List.append_eq_nil_iff, ite_eq_right_iff, List.cons_ne_nil, imp_false,
      Bool.not_eq_true', Bool.not_eq_false, List.contains_iff_mem, Bool.not_eq_true, hparent,
      ih, List.mem_cons, forall_eq_or_imp, List.map_cons, List.nodup_cons, List.mem_map,
      not_exists, not_and, not_or]
    constructor
    · rintro ⟨⟨⟨⟨hdim, hcode⟩, hdates⟩, hpar⟩, hrest, hnodup, hfresh⟩
      exact ⟨⟨⟨hdim, hdates, hpar⟩, hrest⟩, ⟨fun other hother heq => (hfresh other hother).1 heq,
        hnodup⟩, hcode, fun other hother => (hfresh other hother).2⟩
    · rintro ⟨⟨⟨hdim, hdates, hpar⟩, hrest⟩, ⟨hnew, hnodup⟩, hcode, hfresh⟩
      exact ⟨⟨⟨⟨hdim, hcode⟩, hdates⟩, hpar⟩, hrest, hnodup,
        fun other hother => ⟨fun heq => hnew other hother heq, hfresh other hother⟩⟩

theorem requiredDimensionDiagnostics_eq_nil_iff
    (dimensions : IdIndex AccountingDimensionSnapshot) (requiredDimensionIds : List DimensionId) :
    requiredDimensionDiagnostics dimensions requiredDimensionIds = [] ↔
      ∀ requiredDimensionId ∈ requiredDimensionIds,
        dimensions.has requiredDimensionId.value = true := by
  unfold requiredDimensionDiagnostics
  simp

/-! ## Laws of `validateSnapshot`: what an accepted snapshot is -/

/-- Following parents from an account of the snapshot comes to an end. -/
def AccountChainEnds (snapshot : JournalAdmissionSnapshot) (account : AccountSnapshot) : Prop :=
  ParentChainEnds (fun a : AccountSnapshot => a.parentId.map (·.value))
    (fun id => snapshot.account ⟨id⟩) account

/-- Following parents from a dimension member of the snapshot comes to an end. -/
def MemberChainEnds (snapshot : JournalAdmissionSnapshot) (member : DimensionMemberSnapshot) :
    Prop :=
  ParentChainEnds (fun m : DimensionMemberSnapshot => m.parentId.map (·.value))
    (fun id => snapshot.member ⟨id⟩) member

/-- What `validateSnapshot` asks of a snapshot, one field a diagnostic. -/
structure SnapshotValid (snapshot : JournalAdmissionSnapshot) : Prop where
  /-- No account identifier is used twice (`snapshot.accounts[id=…]`). -/
  account_ids : (snapshot.accounts.map (·.id)).Nodup
  /-- No dimension identifier is used twice (`snapshot.dimensions[id=…]`). -/
  dimension_ids : (snapshot.dimensions.map (·.id)).Nodup
  /-- No member identifier is used twice (`snapshot.dimensionMembers[id=…]`). -/
  member_ids : (snapshot.dimensionMembers.map (·.id)).Nodup
  /-- Every account is of the snapshot's book (`.bookId`). -/
  account_books : ∀ account ∈ snapshot.accounts, account.bookId = snapshot.bookId
  /-- No account code is used twice (`.code`). -/
  account_codes : (snapshot.accounts.map (·.code)).Nodup
  /-- No account closes before it opens (`.closedOn`). -/
  account_dates : ∀ account ∈ snapshot.accounts, ∀ closed, account.closedOn = some closed →
    ¬ closed < account.openedOn
  /-- The parent of an account is an account of the snapshot (`.parentId`). -/
  account_parents : ∀ account ∈ snapshot.accounts, ∀ parentId,
    account.parentId = some parentId → ∃ parent, snapshot.account parentId = some parent
  /-- The hierarchy of accounts has no cycle (`.parentId`). -/
  account_hierarchy : ∀ account ∈ snapshot.accounts, AccountChainEnds snapshot account
  /-- Every dimension is of the snapshot's book (`.bookId`). -/
  dimension_books : ∀ dimension ∈ snapshot.dimensions, dimension.bookId = snapshot.bookId
  /-- No dimension code is used twice (`.code`). -/
  dimension_codes : (snapshot.dimensions.map (·.code)).Nodup
  /-- No dimension closes before it opens (`.closedOn`). -/
  dimension_dates : ∀ dimension ∈ snapshot.dimensions, ∀ closed,
    dimension.closedOn = some closed → ¬ closed < dimension.openedOn
  /-- The dimension of a member is a dimension of the snapshot (`.dimensionId`). -/
  member_dimensions : ∀ member ∈ snapshot.dimensionMembers,
    ∃ dimension, snapshot.dimension member.dimensionId = some dimension
  /-- No member code is used twice within a dimension (`.code`): the scoped codes, dimension
  then a NUL then code, are distinct. -/
  member_codes : (snapshot.dimensionMembers.map scopedCode).Nodup
  /-- No member closes before it opens (`.closedOn`). -/
  member_dates : ∀ member ∈ snapshot.dimensionMembers, ∀ closed,
    member.closedOn = some closed → ¬ closed < member.openedOn
  /-- The parent of a member is a member of the snapshot in the same dimension (`.parentId`). -/
  member_parents : ∀ member ∈ snapshot.dimensionMembers, ∀ parentId,
    member.parentId = some parentId → ∃ parent, snapshot.member parentId = some parent ∧
      parent.dimensionId = member.dimensionId
  /-- The hierarchy of members has no cycle (`.parentId`). -/
  member_hierarchy : ∀ member ∈ snapshot.dimensionMembers, MemberChainEnds snapshot member
  /-- Every required dimension is a dimension of the snapshot (`snapshot.requiredDimensionIds`). -/
  required_dimensions : ∀ requiredDimensionId ∈ snapshot.requiredDimensionIds,
    ∃ dimension, snapshot.dimension requiredDimensionId = some dimension

theorem nodup_map_value_iff {α : Type} {Kind : String} (f : α → Identifier Kind)
    (values : List α) : (values.map fun a => (f a).value).Nodup ↔ (values.map f).Nodup := by
  rw [show (values.map fun a => (f a).value) = (values.map f).map (·.value) by simp]
  exact List.nodup_map_iff Identifier.value_injective

theorem has_iff_exists_get {T : Type} (index : IdIndex T) (key : String) :
    index.has key = true ↔ ∃ value, index.get key = some value := by
  rw [IdIndex.has_eq_isSome_get, Option.isSome_iff_exists]

/-- **`validateSnapshot` pushes no diagnostic exactly when the snapshot is valid.** -/
theorem validateSnapshot_eq_nil_iff (snapshot : JournalAdmissionSnapshot) :
    (validateSnapshot snapshot).2 = [] ↔ SnapshotValid snapshot := by
  have hA : (indexById (fun a : AccountSnapshot => a.id.value) snapshot.accounts
      "snapshot.accounts").1.get = fun id => snapshot.account ⟨id⟩ :=
    funext fun id => indexById_get _ _ _ _
  have hD : (indexById (fun d : AccountingDimensionSnapshot => d.id.value) snapshot.dimensions
      "snapshot.dimensions").1.get = fun id => snapshot.dimension ⟨id⟩ :=
    funext fun id => indexById_get _ _ _ _
  have hM : (indexById (fun m : DimensionMemberSnapshot => m.id.value)
      snapshot.dimensionMembers "snapshot.dimensionMembers").1.get =
      fun id => snapshot.member ⟨id⟩ :=
    funext fun id => indexById_get _ _ _ _
  -- the loop of `detectParentCycle` finds no cycle from an account exactly when its chain ends
  have hAcycle : (snapshot.accounts.map AccountSnapshot.id).Nodup →
      ∀ account ∈ snapshot.accounts,
        (parentCycleFrom (fun a : AccountSnapshot => a.id.value)
          (fun a : AccountSnapshot => a.parentId.map (·.value))
          (indexById (fun a : AccountSnapshot => a.id.value) snapshot.accounts
            "snapshot.accounts").1
          ((indexById (fun a : AccountSnapshot => a.id.value) snapshot.accounts
            "snapshot.accounts").1.length + 2) [] (some account) = false) ↔
        AccountChainEnds snapshot account := by
    intro hnodup account hmem
    rw [parentCycleFrom_indexById_eq_false_iff (fun a : AccountSnapshot => a.id.value)
      (fun a : AccountSnapshot => a.parentId.map (·.value)) snapshot.accounts "snapshot.accounts"
      ((nodup_map_value_iff AccountSnapshot.id snapshot.accounts).mpr hnodup) hmem, hA]
    exact Iff.rfl
  -- the same for a dimension member
  have hMcycle : (snapshot.dimensionMembers.map DimensionMemberSnapshot.id).Nodup →
      ∀ member ∈ snapshot.dimensionMembers,
        (parentCycleFrom (fun m : DimensionMemberSnapshot => m.id.value)
          (fun m : DimensionMemberSnapshot => m.parentId.map (·.value))
          (indexById (fun m : DimensionMemberSnapshot => m.id.value) snapshot.dimensionMembers
            "snapshot.dimensionMembers").1
          ((indexById (fun m : DimensionMemberSnapshot => m.id.value) snapshot.dimensionMembers
            "snapshot.dimensionMembers").1.length + 2) [] (some member) = false) ↔
        MemberChainEnds snapshot member := by
    intro hnodup member hmem
    rw [parentCycleFrom_indexById_eq_false_iff (fun m : DimensionMemberSnapshot => m.id.value)
      (fun m : DimensionMemberSnapshot => m.parentId.map (·.value)) snapshot.dimensionMembers
      "snapshot.dimensionMembers"
      ((nodup_map_value_iff DimensionMemberSnapshot.id snapshot.dimensionMembers).mpr hnodup)
      hmem, hM]
    exact Iff.rfl
  unfold validateSnapshot
  simp only [List.append_eq_nil_iff, indexById_diagnostics_eq_nil_iff,
    accountDiagnostics_eq_nil_iff, detectParentCycle_eq_nil_iff, dimensionDiagnostics_eq_nil_iff,
    memberDiagnostics_eq_nil_iff, requiredDimensionDiagnostics_eq_nil_iff, List.not_mem_nil,
    not_false_eq_true, implies_true, and_true, has_iff_exists_get, hA, hD, hM,
    closesBeforeOpens_eq_false_iff, nodup_map_value_iff]
  constructor
  · rintro ⟨⟨⟨⟨⟨⟨⟨⟨hAids, hDids⟩, hMids⟩, haccounts, hAcodes⟩, hAchains⟩, hdimensions, hDcodes⟩,
      hmembers, hMcodes⟩, hMchains⟩, hrequired⟩
    exact ⟨hAids, hDids, hMids, fun a ha => (haccounts a ha).1, hAcodes,
      fun a ha => (haccounts a ha).2.1, fun a ha => (haccounts a ha).2.2,
      fun a ha => (hAcycle hAids a ha).mp (hAchains a ha),
      fun d hd => (hdimensions d hd).1, hDcodes, fun d hd => (hdimensions d hd).2,
      fun m hm => (hmembers m hm).1, hMcodes, fun m hm => (hmembers m hm).2.1,
      fun m hm => (hmembers m hm).2.2, fun m hm => (hMcycle hMids m hm).mp (hMchains m hm),
      hrequired⟩
  · rintro ⟨hAids, hDids, hMids, hAbooks, hAcodes, hAdates, hAparents, hAhier, hDbooks, hDcodes,
      hDdates, hMdimensions, hMcodes, hMdates, hMparents, hMhier, hrequired⟩
    exact ⟨⟨⟨⟨⟨⟨⟨⟨hAids, hDids⟩, hMids⟩,
      fun a ha => ⟨hAbooks a ha, hAdates a ha, hAparents a ha⟩, hAcodes⟩,
      fun a ha => (hAcycle hAids a ha).mpr (hAhier a ha)⟩,
      fun d hd => ⟨hDbooks d hd, hDdates d hd⟩, hDcodes⟩,
      fun m hm => ⟨hMdimensions m hm, hMdates m hm, hMparents m hm⟩, hMcodes⟩,
      fun m hm => (hMcycle hMids m hm).mpr (hMhier m hm)⟩, hrequired⟩

/-- **Soundness for the snapshot's own diagnostics**: a journal is admitted only on a valid
snapshot. No identifier of an account, a dimension or a member is used twice, no account or
dimension code is, no member code is within its dimension; every account and dimension is of the
snapshot's book; none closes before it opens; every parent of an account or member, the dimension
of a member and every required dimension is in the snapshot; and no chain of parents comes back
on itself. -/
theorem admitted_snapshot_valid {snapshot : JournalAdmissionSnapshot}
    {journal : JournalTransaction} {hash : ContentHash}
    (h : admitJournal snapshot journal = .ok (.admitted hash)) : SnapshotValid snapshot :=
  (validateSnapshot_eq_nil_iff snapshot).mp (admitted_snapshot_accepted h)

end Rastrata.Kernel

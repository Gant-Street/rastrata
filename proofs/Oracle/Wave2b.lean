/-
The oracle's side of the second wave (b): journal admission (`journal.ts`: `admitJournal`,
`validateAccountingCoordinate`, `canonicalJournalValue` and its hash, `validateSnapshot`) and the
lots (`lots.ts`: `allocateLots`, `transferLots`), as they travel between the TypeScript test and the
Lean model.

Everything on the wire is ASCII, as in `Oracle/Canonical.lean` and `Oracle/Wave2a.lean`, whose
pieces are used here:

- a string is the lowercase hexadecimal of its UTF-16 code units, four digits a unit;
- an integer is a decimal string; a rational is `{"numerator","denominator"}` and a decimal is
  `{"coefficient","scale"}`, both of decimal strings;
- an optional field is `null` or its value; a list is an array; a union of string literals is the
  literal itself as a plain ASCII string, and a value outside the union is a protocol error;
- a content hash is `{"algorithm","canonicalizationVersion","digest"}` (strings);
- a canonical value is the tagged object of `Oracle/Canonical.lean`.

The records of journal admission, with the TypeScript's field names:

- snapshot: `{"bookId","functionalCommodityId"` (strings), `"accounts"`, `"dimensions"`,
  `"dimensionMembers"` (arrays of the three records below), `"requiredDimensionIds"` (an array of
  strings), `"requiredDimensionIdsByPosting"` (`null` when the object is absent, else an array of
  `[key, [id, ...]]` pairs: the object's own enumerable properties in the order `Object.entries`
  gives them)`}`;
- account: `{"id","bookId","code","name"` (strings), `"role"`, `"normalSide"` (literals),
  `"postingAllowed"` (a boolean), `"openedOn"` (a string), `"closedOn"`, `"parentId"` (a string or
  `null`), `"allowedCommodityIds"` (an array of strings)`}`;
- dimension: `{"id","bookId","code","name","openedOn"` (strings), `"closedOn"` (a string or `null`)`}`;
- member: `{"id","dimensionId","code","name","openedOn"` (strings), `"closedOn"`, `"parentId"` (a
  string or `null`)`}`;
- coordinate: `{"bookId","functionalCommodityId","accountingDate","accountId","unitsCommodityId"`
  (strings), `"dimensionMemberIds"` (an array of strings)`}`;
- journal: `{"id","bookId","functionalCommodityId","economicAt","accountingDate","recordedAt",
  "narration"` (strings), `"kind"` (a literal), `"settledAt"` (a string or `null`), `"postings"` (an
  array of postings)`}`;
- posting: `{"id","accountId"` (strings), `"ordinal"` (an integer), `"units"` (a quantity, as in
  `Oracle/Wave2a.lean`), `"bookValue"` (`{"amount"` a decimal, `"functionalCommodityId"` a string`}`),
  `"transactionPrice"` (`null` or `{"unitRate"` a rational, `"baseCommodityId"`,
  `"quoteCommodityId"` strings`}`), `"costBasis"` (`null` or `{"totalBasis"` a rational,
  `"basisCommodityId"` a string, `"sourceTotalBasis"` a decimal or `null`}`),
  `"dimensionMemberIds"` (an array of strings)`}`.

The results of journal admission:

- `admitJournal`: `{"disposition":"admitted","canonicalHash":<hash>}` or
  `{"disposition":"rejected","diagnostics":[<diagnostic>, ...]}`; an exact-number error is its code;
- `validateAccountingCoordinate`: the array of diagnostics;
- `validateSnapshot`: `{"diagnostics":[...],"accountIds":[...],"dimensionIds":[...],
  "memberIds":[...]}`: the diagnostics `validateSnapshot` pushes and the keys of the three maps it
  returns, in the order a `Map` holds them;
- `canonicalJournalHash`: a content hash; `canonicalJournalValue`: a canonical value;
- a diagnostic of admission is `{"code":<ASCII>,"path":<string>,"requirementIds":[<string>]}`. The
  `message` is not on the wire: the model does not model it (`Journal/Admission.lean`, head).

The records of the lots:

- lot: `{"id","bookId","commodityId","acquiredAt"` (strings), `"acquisitionQuantity"`,
  `"acquisitionTotalBasis"` (rationals), `"basisCommodityId"` (a string), `"evidenceIds"` (an array
  of strings)`}`;
- holding: `{"id","bookId","lotId","accountId","commodityId","basisCommodityId"` (strings),
  `"remainingQuantity"`, `"remainingTotalBasis"`, `"remainingValuationAllowance"`,
  `"remainingCarryingAmount"` (rationals)`}`;
- selection: `{"method":<literal>}`, and for `specificIdentification` also `"allocations"`, an array of
  `{"holdingId"` (a string), `"quantity"` (a rational)`}`;
- identity: `{"holdingId","allocationId"}`; destination identity:
  `{"sourceHoldingId","destinationHoldingId"}` (strings);
- derivation: the record of `Oracle/Wave2a.lean`; transfer policy: `{"id","version","bookId",
  "sourceAccountId","destinationAccountId","validFrom"` (strings), `"validTo"` (a string or `null`),
  `"treatment"` (a literal)`}`.

`allocateLots` and `transferLots` have six and eleven arguments and the dispatch table has wrappers
up to four, so each takes ONE argument, an object with the TypeScript's parameter names:
`{"holdings","lots","requestedQuantity","selection","derivation","identities"}` and
`{"sourceHoldings","destinationHoldings","lots","requestedQuantity","selection","policies",
"governedAt","destinationAccountId","derivation","allocationIdentities","destinationIdentities"}`.

The results of the lots:

- `allocateLots`: `{"disposition":"allocated","allocations":[...],"holdings":[...]}` or
  `{"disposition":"rejected","diagnostics":[...]}` where a diagnostic is the one of
  `Oracle/Wave2a.lean` WITH its message (the lots model carries the messages in full);
- `transferLots`: `{"disposition":"transferred","sourceHoldings","destinationHoldings",
  "allocations"}`, `{"disposition":"requiresDisposalAndReacquisition","policy":<policy>}` or
  `{"disposition":"rejected","diagnostics":[...]}`;
- an allocation is `{"id","holdingId","lotId","allocatedQuantity","allocatedTotalBasis",
  "allocatedValuationAllowance","allocatedCarryingAmount","derivation"}`;
- an exact-number error is its code (`representation_limit_exceeded`, ...), and the one error of the
  model that no TypeScript outcome equals is `source_holding_absent`.

A string with a lone surrogate, which a Lean `String` cannot hold, is `model_has_no_lone_surrogate`,
as everywhere in the oracle.

Every name here is in `Oracle.Wave2b` and every table key starts with the TypeScript module's name,
so that this file cannot clash with another oracle file.
-/
import Rastrata.Kernel.Journal.Admission
import Rastrata.Kernel.Lots
import Oracle.Dispatch
import Oracle.Numeric
import Oracle.Canonical
import Oracle.Wave2a

namespace Oracle.Wave2b

open Rastrata.Kernel
open Oracle.Wave2a (Dec Err arrived carried field textField optTextField plainField listField
  textListField literalField idListField jText jObj jList jOpt jRational jDecimal jValue codeText
  numErrCode jDiagnostic decodeQuantity decodeDerivation lotMethods)

/-! ## Decoding -/

private def lift {α : Type} (r : Except String α) : Dec α :=
  match r with
  | .ok a => .ok a
  | .error e => .error (.protocol e)

/-- A member that is `null` or a record, decoded by `f`. -/
def optField {α : Type} (f : Lean.Json → Dec α) (j : Lean.Json) (name : String) :
    Dec (Option α) := do
  let value ← field j name
  if value.isNull then pure none else pure (some (← f value))

/-- A member that is `null` or an identifier, as a string. -/
def optIdField {Kind : String} (j : Lean.Json) (name : String) :
    Dec (Option (Identifier Kind)) := do
  pure ((← optTextField j name).map fun value => (⟨value⟩ : Identifier Kind))

def accountRoles : List (String × AccountRole) :=
  [("asset", .asset), ("liability", .liability), ("equity", .equity), ("income", .income),
    ("expense", .expense), ("gain", .gain), ("unrealizedGain", .unrealizedGain)]

def normalSides : List (String × NormalSide) := [("debit", .debit), ("credit", .credit)]

def journalKinds : List (String × JournalKind) :=
  [("opening", .opening), ("ordinary", .ordinary), ("adjustment", .adjustment),
    ("reversing", .reversing), ("closing", .closing)]

def decodeAccount (j : Lean.Json) : Dec AccountSnapshot := do
  pure
    { id := ⟨← textField j "id"⟩
      bookId := ⟨← textField j "bookId"⟩
      code := ← textField j "code"
      name := ← textField j "name"
      role := ← literalField "account role" accountRoles j "role"
      normalSide := ← literalField "normal side" normalSides j "normalSide"
      postingAllowed := ← plainField (α := Bool) j "postingAllowed"
      openedOn := ⟨← textField j "openedOn"⟩
      closedOn := (← optTextField j "closedOn").map fun date => (⟨date⟩ : LocalDate)
      parentId := ← optIdField (Kind := "Account") j "parentId"
      allowedCommodityIds := ← idListField (Kind := "Commodity") j "allowedCommodityIds" }

def decodeDimension (j : Lean.Json) : Dec AccountingDimensionSnapshot := do
  pure
    { id := ⟨← textField j "id"⟩
      bookId := ⟨← textField j "bookId"⟩
      code := ← textField j "code"
      name := ← textField j "name"
      openedOn := ⟨← textField j "openedOn"⟩
      closedOn := (← optTextField j "closedOn").map fun date => (⟨date⟩ : LocalDate) }

def decodeMember (j : Lean.Json) : Dec DimensionMemberSnapshot := do
  pure
    { id := ⟨← textField j "id"⟩
      dimensionId := ⟨← textField j "dimensionId"⟩
      code := ← textField j "code"
      name := ← textField j "name"
      openedOn := ⟨← textField j "openedOn"⟩
      closedOn := (← optTextField j "closedOn").map fun date => (⟨date⟩ : LocalDate)
      parentId := ← optIdField (Kind := "DimensionMember") j "parentId" }

/-- `requiredDimensionIdsByPosting`: `null` or the pairs `[key, [id, ...]]`. -/
def decodeByPosting (j : Lean.Json) (name : String) :
    Dec (Option (List (String × List DimensionId))) := do
  let value ← field j name
  if value.isNull then pure none
  else
    let entries ← lift value.getArr?
    let mut out : Array (String × List DimensionId) := #[]
    for entry in entries do
      let pair ← lift entry.getArr?
      if _ : pair.size = 2 then
        let key ← decodeText pair[0]
        let ids ← lift pair[1].getArr?
        let mut list : Array DimensionId := #[]
        for item in ids do
          list := list.push ⟨← decodeText item⟩
        out := out.push (key, list.toList)
      else
        throw (.protocol s!"expected a [key, ids] pair, got {pair.size} members")
    pure (some out.toList)

def decodeSnapshot (j : Lean.Json) : Dec JournalAdmissionSnapshot := do
  pure
    { bookId := ⟨← textField j "bookId"⟩
      functionalCommodityId := ⟨← textField j "functionalCommodityId"⟩
      accounts := ← listField decodeAccount j "accounts"
      dimensions := ← listField decodeDimension j "dimensions"
      dimensionMembers := ← listField decodeMember j "dimensionMembers"
      requiredDimensionIds := ← idListField (Kind := "AccountingDimension") j "requiredDimensionIds"
      requiredDimensionIdsByPosting := ← decodeByPosting j "requiredDimensionIdsByPosting" }

def decodeCoordinate (j : Lean.Json) : Dec AccountingCoordinate := do
  pure
    { bookId := ⟨← textField j "bookId"⟩
      functionalCommodityId := ⟨← textField j "functionalCommodityId"⟩
      accountingDate := ⟨← textField j "accountingDate"⟩
      accountId := ⟨← textField j "accountId"⟩
      unitsCommodityId := ⟨← textField j "unitsCommodityId"⟩
      dimensionMemberIds := ← idListField (Kind := "DimensionMember") j "dimensionMemberIds" }

def decodeBookValue (j : Lean.Json) : Dec BookValue := do
  pure
    { amount := ← plainField (α := ExactDecimal) j "amount"
      functionalCommodityId := ⟨← textField j "functionalCommodityId"⟩ }

def decodeTransactionPrice (j : Lean.Json) : Dec TransactionPrice := do
  pure
    { unitRate := ← plainField (α := ExactRational) j "unitRate"
      baseCommodityId := ⟨← textField j "baseCommodityId"⟩
      quoteCommodityId := ⟨← textField j "quoteCommodityId"⟩ }

def decodeCostBasis (j : Lean.Json) : Dec CostBasis := do
  pure
    { totalBasis := ← plainField (α := ExactRational) j "totalBasis"
      basisCommodityId := ⟨← textField j "basisCommodityId"⟩
      sourceTotalBasis := ← plainField (α := Option ExactDecimal) j "sourceTotalBasis" }

def decodePosting (j : Lean.Json) : Dec Posting := do
  pure
    { id := ⟨← textField j "id"⟩
      ordinal := ← plainField (α := Int) j "ordinal"
      accountId := ⟨← textField j "accountId"⟩
      units := ← decodeQuantity (← field j "units")
      bookValue := ← decodeBookValue (← field j "bookValue")
      transactionPrice := ← optField decodeTransactionPrice j "transactionPrice"
      costBasis := ← optField decodeCostBasis j "costBasis"
      dimensionMemberIds := ← idListField (Kind := "DimensionMember") j "dimensionMemberIds" }

def decodeJournal (j : Lean.Json) : Dec JournalTransaction := do
  pure
    { id := ⟨← textField j "id"⟩
      kind := ← literalField "journal kind" journalKinds j "kind"
      bookId := ⟨← textField j "bookId"⟩
      functionalCommodityId := ⟨← textField j "functionalCommodityId"⟩
      economicAt := ⟨← textField j "economicAt"⟩
      accountingDate := ⟨← textField j "accountingDate"⟩
      settledAt := (← optTextField j "settledAt").map fun at_ => (⟨at_⟩ : Instant)
      recordedAt := ⟨← textField j "recordedAt"⟩
      narration := ← textField j "narration"
      postings := ← listField decodePosting j "postings" }

instance : FromOracleJson (Carried JournalAdmissionSnapshot) where
  fromOracleJson j := carried (decodeSnapshot j)

instance : FromOracleJson (Carried AccountingCoordinate) where
  fromOracleJson j := carried (decodeCoordinate j)

instance : FromOracleJson (Carried JournalTransaction) where
  fromOracleJson j := carried (decodeJournal j)

instance : FromOracleJson (Carried (List DimensionId)) where
  fromOracleJson j := carried do
    let arr ← lift j.getArr?
    let mut out : Array DimensionId := #[]
    for item in arr do
      out := out.push ⟨← decodeText item⟩
    pure out.toList

/-! ## Journal admission: the entries -/

/-- A diagnostic of admission: code, path and requirement identifiers. -/
def jAdmissionDiagnostic (d : SemanticDiagnostic) : Lean.Json :=
  jObj
    [ ("code", Lean.Json.str (codeText d.code))
    , ("path", jText d.path)
    , ("requirementIds", jList jText d.requirementIds) ]

/-- `admitJournal`. -/
def entryAdmitJournal (snapshot : Carried JournalAdmissionSnapshot)
    (journal : Carried JournalTransaction) : Except Err Lean.Json := do
  match Rastrata.Kernel.admitJournal (← arrived snapshot) (← arrived journal) with
  | .error e => throw ⟨numErrCode e⟩
  | .ok (.admitted hash) =>
    pure (jObj
      [ ("disposition", Lean.Json.str "admitted")
      , ("canonicalHash", ToOracleJson.toOracleJson hash) ])
  | .ok (.rejected diagnostics) =>
    pure (jObj
      [ ("disposition", Lean.Json.str "rejected")
      , ("diagnostics", jList jAdmissionDiagnostic diagnostics) ])

/-- `validateAccountingCoordinate`. -/
def entryValidateAccountingCoordinate (snapshot : Carried JournalAdmissionSnapshot)
    (coordinate : Carried AccountingCoordinate) (required : Carried (List DimensionId)) :
    Except Err Lean.Json := do
  pure (jList jAdmissionDiagnostic
    (Rastrata.Kernel.validateAccountingCoordinate (← arrived snapshot) (← arrived coordinate)
      (← arrived required)))

/-- `validateSnapshot`: the diagnostics it pushes, and the keys of the three maps it returns. -/
def entryValidateSnapshot (snapshot : Carried JournalAdmissionSnapshot) :
    Except Err Lean.Json := do
  let validated := Rastrata.Kernel.validateSnapshot (← arrived snapshot)
  pure (jObj
    [ ("diagnostics", jList jAdmissionDiagnostic validated.2)
    , ("accountIds", jList (fun entry => jText entry.1) validated.1.accounts)
    , ("dimensionIds", jList (fun entry => jText entry.1) validated.1.dimensions)
    , ("memberIds", jList (fun entry => jText entry.1) validated.1.members) ])

/-- `canonicalJournalValue`. -/
def entryCanonicalJournalValue (journal : Carried JournalTransaction) : Except Err Lean.Json := do
  pure (jValue (Rastrata.Kernel.canonicalJournalValue (← arrived journal)))

/-- `hashCanonical(canonicalJournalValue(journal))`. -/
def entryCanonicalJournalHash (journal : Carried JournalTransaction) : Except Err ContentHash := do
  pure (Rastrata.Kernel.hashCanonical (Rastrata.Kernel.canonicalJournalValue (← arrived journal)))

/-! ## Lots: decoding -/

def transferTreatments : List (String × TransferTreatment) :=
  [("continuity", .continuity), ("disposalAndReacquisition", .disposalAndReacquisition)]

def decodeLot (j : Lean.Json) : Dec Lot := do
  pure
    { id := ⟨← textField j "id"⟩
      bookId := ⟨← textField j "bookId"⟩
      commodityId := ⟨← textField j "commodityId"⟩
      acquiredAt := ⟨← textField j "acquiredAt"⟩
      acquisitionQuantity := ← plainField (α := ExactRational) j "acquisitionQuantity"
      acquisitionTotalBasis := ← plainField (α := ExactRational) j "acquisitionTotalBasis"
      basisCommodityId := ⟨← textField j "basisCommodityId"⟩
      evidenceIds := ← textListField j "evidenceIds" }

def decodeHolding (j : Lean.Json) : Dec LotHolding := do
  pure
    { id := ⟨← textField j "id"⟩
      bookId := ⟨← textField j "bookId"⟩
      lotId := ⟨← textField j "lotId"⟩
      accountId := ⟨← textField j "accountId"⟩
      commodityId := ⟨← textField j "commodityId"⟩
      basisCommodityId := ⟨← textField j "basisCommodityId"⟩
      remainingQuantity := ← plainField (α := ExactRational) j "remainingQuantity"
      remainingTotalBasis := ← plainField (α := ExactRational) j "remainingTotalBasis"
      remainingValuationAllowance :=
        ← plainField (α := ExactRational) j "remainingValuationAllowance"
      remainingCarryingAmount := ← plainField (α := ExactRational) j "remainingCarryingAmount" }

def decodeSpecificAllocation (j : Lean.Json) : Dec SpecificAllocation := do
  pure
    { holdingId := ⟨← textField j "holdingId"⟩
      quantity := ← plainField (α := ExactRational) j "quantity" }

/-- A selection: `{"method": <literal>}`, with `"allocations"` for `specificIdentification`. -/
def decodeSelection (j : Lean.Json) : Dec LotSelection := do
  match ← literalField "lot selection method" lotMethods j "method" with
  | .fifo => pure .fifo
  | .lifo => pure .lifo
  | .hifo => pure .hifo
  | .weightedAverage => pure .weightedAverage
  | .specificIdentification =>
    pure (.specificIdentification (← listField decodeSpecificAllocation j "allocations"))

def decodeIdentity (j : Lean.Json) : Dec LotAllocationIdentity := do
  pure
    { holdingId := ⟨← textField j "holdingId"⟩
      allocationId := ⟨← textField j "allocationId"⟩ }

def decodeDestinationIdentity (j : Lean.Json) : Dec DestinationHoldingIdentity := do
  pure
    { sourceHoldingId := ⟨← textField j "sourceHoldingId"⟩
      destinationHoldingId := ⟨← textField j "destinationHoldingId"⟩ }

def decodeTransferPolicy (j : Lean.Json) : Dec TransferPolicy := do
  pure
    { id := ⟨← textField j "id"⟩
      version := ⟨← textField j "version"⟩
      bookId := ⟨← textField j "bookId"⟩
      sourceAccountId := ⟨← textField j "sourceAccountId"⟩
      destinationAccountId := ⟨← textField j "destinationAccountId"⟩
      validFrom := ⟨← textField j "validFrom"⟩
      validTo := (← optTextField j "validTo").map fun at_ => (⟨at_⟩ : Instant)
      treatment := ← literalField "transfer treatment" transferTreatments j "treatment" }

/-- The six arguments of `allocateLots`, as one object. -/
structure AllocateInput where
  holdings : List LotHolding
  lots : List Lot
  requestedQuantity : ExactRational
  selection : LotSelection
  derivation : DerivationRecord
  identities : List LotAllocationIdentity

def decodeAllocateInput (j : Lean.Json) : Dec AllocateInput := do
  pure
    { holdings := ← listField decodeHolding j "holdings"
      lots := ← listField decodeLot j "lots"
      requestedQuantity := ← plainField (α := ExactRational) j "requestedQuantity"
      selection := ← decodeSelection (← field j "selection")
      derivation := ← decodeDerivation (← field j "derivation")
      identities := ← listField decodeIdentity j "identities" }

/-- The eleven arguments of `transferLots`, as one object. -/
structure TransferInput where
  sourceHoldings : List LotHolding
  destinationHoldings : List LotHolding
  lots : List Lot
  requestedQuantity : ExactRational
  selection : LotSelection
  policies : List TransferPolicy
  governedAt : Instant
  destinationAccountId : AccountId
  derivation : DerivationRecord
  allocationIdentities : List LotAllocationIdentity
  destinationIdentities : List DestinationHoldingIdentity

def decodeTransferInput (j : Lean.Json) : Dec TransferInput := do
  pure
    { sourceHoldings := ← listField decodeHolding j "sourceHoldings"
      destinationHoldings := ← listField decodeHolding j "destinationHoldings"
      lots := ← listField decodeLot j "lots"
      requestedQuantity := ← plainField (α := ExactRational) j "requestedQuantity"
      selection := ← decodeSelection (← field j "selection")
      policies := ← listField decodeTransferPolicy j "policies"
      governedAt := ⟨← textField j "governedAt"⟩
      destinationAccountId := ⟨← textField j "destinationAccountId"⟩
      derivation := ← decodeDerivation (← field j "derivation")
      allocationIdentities := ← listField decodeIdentity j "allocationIdentities"
      destinationIdentities := ← listField decodeDestinationIdentity j "destinationIdentities" }

instance : FromOracleJson (Carried AllocateInput) where
  fromOracleJson j := carried (decodeAllocateInput j)

instance : FromOracleJson (Carried TransferInput) where
  fromOracleJson j := carried (decodeTransferInput j)

/-! ## Lots: encoding -/

def jEvidence (evidence : SourceEvidence) : Lean.Json :=
  jObj
    [ ("id", jText evidence.id.value)
    , ("sourceSystem", jText evidence.sourceSystem)
    , ("sourceRecordId", jText evidence.sourceRecordId)
    , ("observedAt", jText evidence.observedAt.value)
    , ("contentHash", ToOracleJson.toOracleJson evidence.contentHash) ]

def jDerivation (derivation : DerivationRecord) : Lean.Json :=
  jObj
    [ ("id", jText derivation.id.value)
    , ("policyId", jText derivation.policyId.value)
    , ("policyVersion", jText derivation.policyVersion.value)
    , ("algorithmVersion", jText derivation.algorithmVersion.value)
    , ("inputHash", ToOracleJson.toOracleJson derivation.inputHash)
    , ("actorId", jText derivation.actorId.value)
    , ("state", Lean.Json.str derivation.state.text)
    , ("recordedAt", jText derivation.recordedAt.value)
    , ("evidence", jList jEvidence derivation.evidence) ]

def jHolding (holding : LotHolding) : Lean.Json :=
  jObj
    [ ("id", jText holding.id.value)
    , ("bookId", jText holding.bookId.value)
    , ("lotId", jText holding.lotId.value)
    , ("accountId", jText holding.accountId.value)
    , ("commodityId", jText holding.commodityId.value)
    , ("basisCommodityId", jText holding.basisCommodityId.value)
    , ("remainingQuantity", jRational holding.remainingQuantity)
    , ("remainingTotalBasis", jRational holding.remainingTotalBasis)
    , ("remainingValuationAllowance", jRational holding.remainingValuationAllowance)
    , ("remainingCarryingAmount", jRational holding.remainingCarryingAmount) ]

def jAllocation (allocation : LotAllocation) : Lean.Json :=
  jObj
    [ ("id", jText allocation.id.value)
    , ("holdingId", jText allocation.holdingId.value)
    , ("lotId", jText allocation.lotId.value)
    , ("allocatedQuantity", jRational allocation.allocatedQuantity)
    , ("allocatedTotalBasis", jRational allocation.allocatedTotalBasis)
    , ("allocatedValuationAllowance", jRational allocation.allocatedValuationAllowance)
    , ("allocatedCarryingAmount", jRational allocation.allocatedCarryingAmount)
    , ("derivation", jDerivation allocation.derivation) ]

def jRejected (diagnostics : List SemanticDiagnostic) : Lean.Json :=
  jObj
    [ ("disposition", Lean.Json.str "rejected")
    , ("diagnostics", jList jDiagnostic diagnostics) ]

def jAllocationResult : LotAllocationResult → Lean.Json
  | .allocated allocations holdings =>
    jObj
      [ ("disposition", Lean.Json.str "allocated")
      , ("allocations", jList jAllocation allocations)
      , ("holdings", jList jHolding holdings) ]
  | .rejected diagnostics => jRejected diagnostics

def treatmentText : TransferTreatment → String
  | .continuity => "continuity"
  | .disposalAndReacquisition => "disposalAndReacquisition"

def jTransferPolicy (policy : TransferPolicy) : Lean.Json :=
  jObj
    [ ("id", jText policy.id.value)
    , ("version", jText policy.version.value)
    , ("bookId", jText policy.bookId.value)
    , ("sourceAccountId", jText policy.sourceAccountId.value)
    , ("destinationAccountId", jText policy.destinationAccountId.value)
    , ("validFrom", jText policy.validFrom.value)
    , ("validTo", jOpt (fun at_ => jText at_.value) policy.validTo)
    , ("treatment", Lean.Json.str (treatmentText policy.treatment)) ]

def jTransferResult : LotTransferResult → Lean.Json
  | .transferred sourceHoldings destinationHoldings allocations =>
    jObj
      [ ("disposition", Lean.Json.str "transferred")
      , ("sourceHoldings", jList jHolding sourceHoldings)
      , ("destinationHoldings", jList jHolding destinationHoldings)
      , ("allocations", jList jAllocation allocations) ]
  | .requiresDisposalAndReacquisition policy =>
    jObj
      [ ("disposition", Lean.Json.str "requiresDisposalAndReacquisition")
      , ("policy", jTransferPolicy policy) ]
  | .rejected diagnostics => jRejected diagnostics

/-- The code of what `transferLots` throws: an exact-number error, or the `TypeError` of reading a
field of `sourceHoldings.find(...)!` when nothing was found, which the model proves never happens. -/
def lotsErrCode : LotsErr → String
  | .exactNumber code => numErrCode code
  | .sourceHoldingAbsent => "source_holding_absent"

/-! ## Lots: the entries -/

/-- `allocateLots`. -/
def entryAllocateLots (input : Carried AllocateInput) : Except Err Lean.Json := do
  let input ← arrived input
  match Rastrata.Kernel.allocateLots input.holdings input.lots input.requestedQuantity
      input.selection input.derivation input.identities with
  | .error e => throw ⟨numErrCode e⟩
  | .ok result => pure (jAllocationResult result)

/-- `transferLots`. -/
def entryTransferLots (input : Carried TransferInput) : Except Err Lean.Json := do
  let input ← arrived input
  match Rastrata.Kernel.transferLots input.sourceHoldings input.destinationHoldings input.lots
      input.requestedQuantity input.selection input.policies input.governedAt
      input.destinationAccountId input.derivation input.allocationIdentities
      input.destinationIdentities with
  | .error e => throw ⟨lotsErrCode e⟩
  | .ok result => pure (jTransferResult result)

end Oracle.Wave2b

namespace Oracle

/-- The entries of this file. -/
def wave2bSingle : List (String × Handler) :=
  [ ("journal.admitJournal", fn2 Wave2b.entryAdmitJournal)
  , ("journal.validateAccountingCoordinate", fn3 Wave2b.entryValidateAccountingCoordinate)
  , ("journal.validateSnapshot", fn1 Wave2b.entryValidateSnapshot)
  , ("journal.canonicalJournalValue", fn1 Wave2b.entryCanonicalJournalValue)
  , ("journal.canonicalJournalHash", fn1 Wave2b.entryCanonicalJournalHash)
  , ("lots.allocateLots", fn1 Wave2b.entryAllocateLots)
  , ("lots.transferLots", fn1 Wave2b.entryTransferLots)
  ]

/-- This file's entries of the dispatch table. Each has a twin whose name ends in `.each`, which
takes one argument, a list of argument lists, and answers each in turn (`each`). -/
def wave2bEntries : List (String × Handler) :=
  wave2bSingle ++ wave2bSingle.map fun (name, handler) => (name ++ ".each", each handler)

end Oracle

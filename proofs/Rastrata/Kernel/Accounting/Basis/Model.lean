/-
The model of `packages/kernel/src/accounting.ts` lines 1329 to 1495: the hashes of the read snapshot
and of the source population, `canonicalPostingSourceKey`, `accountingStateHashesAreValid` and
`projectAccountingBasis`. The types are those of `Accounting/BasisTypes.lean`, `canonicalize` and
`accountingHash` are those of `Accounting/Core/Canonical.lean` (with the instances of
`Accounting/Basis/Canonical.lean` for the journal and book vocabulary), and the helpers are those of
`Accounting/Core/Model.lean`.

Every definition mirrors one TypeScript member, named in its doc comment, with the same checks in the
same order; a diagnostic carries its code, path, message and requirement identifiers in full. Where
the TypeScript throws (an exact-number operation that exceeds the size limit, a `quantize` that
fails) the model returns `.error`, with the error that is thrown first.

Where the model differs from the TypeScript in form:

- The test `"amount" in event || "settlementRatio" in event` (line 1401) is about JavaScript
  properties a `BasisSourceEvent` does not have; a Lean `BasisSourceEvent` has exactly its fields, so
  the test always passes (`BasisSourceEvent.carriesComputedAmount` is `false`).
- The type of `projectAccountingBasis` guarantees these, and so they are modelled as passing:
  `Array.isArray(selected)` is the constructor of `AccountingPolicySelection` (see `Core/Model.lean`);
  the `!` assertions on `rules[0]`, `configuredPolicies[0]` and `settlementRatio` read a value that
  the preceding test has shown to be there.
- `ExactRational.of(1n, 1n)` (line 1472) never throws; it is the constant `basisOne`
  (`of_one_one`).
- A `Map` is a list of pairs in insertion order; `get` after a run of `set`s answers the value last
  set under the key (`mapLast`), and `size` of a map built from a list is the number of distinct keys.
- `[...x].sort()` without a comparator and `sort(compareCanonicalText)` both order strings by UTF-16
  code unit, and `Array.prototype.sort` is stable: both are `List.mergeSort` with `jsStringLe`, which
  is stable. `sort((l, r) => Number(l.postingSequence - r.postingSequence))` is a stable sort by the
  sequence (a non-zero difference of two integers converts to a number of the same sign, an infinity
  included, and never to zero or `NaN`).
- `Object.freeze`, the object identity of the results and `immutableAccountingValue` are not
  modelled; `immutableAccountingValue` is the identity (`Core/Model.lean`).
-/
import Rastrata.Kernel.Accounting.Basis.Canonical

namespace Rastrata.Kernel

/-! ## `canonicalPostingSourceKey` and the sorts (`accounting.ts` lines 1332 to 1367) -/

/-- `canonicalPostingSourceKey` (line 1367): the book, the journal, the effect key and the posting,
separated by NUL characters. -/
def canonicalPostingSourceKey (source : CanonicalPostingReference) : String :=
  source.bookId.value ++ "\x00" ++ source.journalId.value ++ "\x00" ++ source.effectKey.value ++
    "\x00" ++ source.postingId.value

/-- `[...events].sort((left, right) => compareCanonicalText(left.id, right.id))` (lines 1332, 1348,
1363 and 1443): a stable sort by the identifier, in UTF-16 code unit order. -/
def sortBasisEventsById (events : List BasisSourceEvent) : List BasisSourceEvent :=
  events.mergeSort fun left right => jsStringLe left.id right.id

/-- `[...journals].sort((left, right) => Number(left.postingSequence - right.postingSequence))`
(lines 1345, 1360 and 1406): a stable sort by the posting sequence. -/
def sortBookedJournals (journals : List BookedJournal) : List BookedJournal :=
  journals.mergeSort fun left right => decide (left.postingSequence ≤ right.postingSequence)

/-- `[...sourcePostingPopulation].sort((left, right) => compareCanonicalText(key(left), key(right)))`
(lines 1347 and 1362): a stable sort by the source key. -/
def sortSourcePostingPopulation (population : List CanonicalPostingReference) :
    List CanonicalPostingReference :=
  population.mergeSort fun left right =>
    jsStringLe (canonicalPostingSourceKey left) (canonicalPostingSourceKey right)

/-! ## The hashes (`accounting.ts` lines 1329 to 1365) -/

/-- `hashAccountingBasisSourcePopulation` (line 1329): `hashCanonical` of the record `{ type, events }`,
the events sorted by identifier and each one's `canonicalize`. -/
def hashAccountingBasisSourcePopulation (events : List BasisSourceEvent) : ContentHash :=
  hashCanonical (.record [("type", .string "AccountingBasisSourcePopulation"),
    ("events", .array ((sortBasisEventsById events).map canonicalize))])

/-- `hashAccountingReadSnapshot` (line 1336): `accountingHash("AccountingReadSnapshot", ...)` of the
eleven properties it reads, the three lists sorted and the events left to `canonicalize`. The
snapshot is `Omit<AccountingReadSnapshot, "contentHash">`; the whole snapshot is passed as
`snapshot.toAccountingReadSnapshotBody` (the function reads named properties only). -/
def hashAccountingReadSnapshot (snapshot : AccountingReadSnapshotBody) : ContentHash :=
  accountingHash "AccountingReadSnapshot" (object [
    member "throughBookRevision" snapshot.throughBookRevision,
    member "throughPostingSequence" snapshot.throughPostingSequence,
    member "policyEffectiveAt" snapshot.policyEffectiveAt,
    member "bookStateHash" snapshot.bookStateHash,
    member "reportPopulationHash" snapshot.reportPopulationHash,
    member "sourcePopulationHash" snapshot.sourcePopulationHash,
    ("configurationSnapshot", some (canonicalize snapshot.configurationSnapshot)),
    ("journals", some (.array ((sortBookedJournals snapshot.journals).map canonicalize))),
    ("accountingState", some (canonicalAccountingStateValue snapshot.accountingState)),
    ("sourcePostingPopulation", some (.array
      ((sortSourcePostingPopulation snapshot.sourcePostingPopulation).map canonicalize))),
    member "sourceEvents" (sortBasisEventsById snapshot.sourceEvents)])

/-- `hashAccountingReadPopulation` (line 1352): the same, without `reportPopulationHash`, under
`"AccountingReadPopulation"`. -/
def hashAccountingReadPopulation (snapshot : AccountingReadPopulation) : ContentHash :=
  accountingHash "AccountingReadPopulation" (object [
    member "throughBookRevision" snapshot.throughBookRevision,
    member "throughPostingSequence" snapshot.throughPostingSequence,
    member "policyEffectiveAt" snapshot.policyEffectiveAt,
    member "bookStateHash" snapshot.bookStateHash,
    member "sourcePopulationHash" snapshot.sourcePopulationHash,
    ("configurationSnapshot", some (canonicalize snapshot.configurationSnapshot)),
    ("journals", some (.array ((sortBookedJournals snapshot.journals).map canonicalize))),
    ("accountingState", some (canonicalAccountingStateValue snapshot.accountingState)),
    ("sourcePostingPopulation", some (.array
      ((sortSourcePostingPopulation snapshot.sourcePostingPopulation).map canonicalize))),
    member "sourceEvents" (sortBasisEventsById snapshot.sourceEvents)])

/-! ## `accountingStateHashesAreValid` (`accounting.ts` line 1371) -/

/-- The effects the thirteen loops of `accountingStateHashesAreValid` check, in the order of the
loops: each collection of the state, each value wrapped as the effect of its type. -/
def accountingStateEffects (state : AccountingCanonicalState) : List AccountingEffect :=
  state.provisionalInventoryLayers.map .provisionalInventoryLayer ++
  state.inventoryRecostings.map .inventoryRecosting ++
  state.inventoryValueAdjustments.map .inventoryValueAdjustment ++
  state.openItems.map .openItem ++
  state.settlements.map .settlement ++
  state.settlementAllocations.map .settlementAllocation ++
  state.remeasurementResults.map .remeasurementResult ++
  state.remeasurementReversals.map .remeasurementReversal ++
  state.allocationSchedules.map .allocationSchedule ++
  state.allocationRecognitions.map .allocationRecognition ++
  state.allocationScheduleRevisions.map .allocationScheduleRevision ++
  state.taxDeterminations.map .taxDetermination ++
  state.consolidationCompilations.map .consolidationCompilation

/-- The loops of `accountingStateHashesAreValid` (lines 1372 to 1384) run over the effects in order:
`false` at the first effect whose hash does not check, a throw (`validateAccountingEffectHash` can
throw for an allocation schedule) at the first effect that throws, `true` after the last. -/
def effectHashesAreValid : List AccountingEffect → Except QuantizeErr Bool
  | [] => .ok true
  | effect :: rest =>
    match validateAccountingEffectHash effect with
    | .error e => .error e
    | .ok false => .ok false
    | .ok true => effectHashesAreValid rest

/-- `accountingStateHashesAreValid` (line 1371). -/
def accountingStateHashesAreValid (state : AccountingCanonicalState) : Except QuantizeErr Bool :=
  effectHashesAreValid (accountingStateEffects state)

/-! ## The tables of `projectAccountingBasis` (lines 1406 to 1440) -/

/-- `new Set(values).size` (and `new Map(entries).size`, with `values` the keys): the number of
distinct values. It is the length of the list exactly when the values are distinct
(`setSize_eq_length_iff`). -/
def setSize {α : Type} [DecidableEq α] (values : List α) : Nat := values.dedup.length

/-- `Map.prototype.get` on a map built by a run of `set`s: the value last set under the key. -/
def mapLast {V : Type} (entries : List (String × V)) (key : String) : Option V :=
  (entries.reverse.find? fun entry => entry.1 == key).map (·.2)

/-- The key of `bookedBySourceKey` (line 1414): the journal, a NUL character, the effect key. -/
def bookedSourceKey (booked : BookedJournal) : String :=
  booked.journal.id.value ++ "\x00" ++ booked.effectKey

/-- The entries `bookedBySourceKey.set(key, ...)` receives, in the order of the journals (line 1416). -/
def bookedBySourceKey (ordered : List BookedJournal) : List (String × BookedJournal) :=
  ordered.map fun booked => (bookedSourceKey booked, booked)

/-- The entries of `new Map(booked.journal.postings.map((posting) => [posting.id, posting]))`
(line 1416). -/
def bookedPostingMap (booked : BookedJournal) : List (String × Posting) :=
  booked.journal.postings.map fun posting => (posting.id.value, posting)

/-- `uniqueJournalSources` (lines 1412 to 1417): no key was already in the map when a journal was
set. -/
def uniqueJournalSources (ordered : List BookedJournal) : Bool :=
  decide (setSize (ordered.map bookedSourceKey) = ordered.length)

/-- `postingReferenceCloses` (line 1422): the reference is valid and of the policy's book; a booked
journal has its journal and effect key, with distinct posting identifiers; that journal has the
referenced posting, on the accounting date when one is given, whose content hash is the reference's,
and so is the copied posting's when one is given. -/
def postingReferenceCloses (policy : AccountingBasisPolicy) (ordered : List BookedJournal)
    (reference : CanonicalPostingReference) (copiedPosting : Option Posting)
    (accountingDate : Option LocalDate) : Bool :=
  if !validateCanonicalPostingReferenceHash reference || reference.bookId != policy.bookId then false
  else
    match mapLast (bookedBySourceKey ordered)
        (reference.journalId.value ++ "\x00" ++ reference.effectKey.value) with
    | none => false
    | some booked =>
      if setSize (bookedPostingMap booked |>.map (·.1)) != booked.journal.postings.length then false
      else
        match mapLast (bookedPostingMap booked) reference.postingId.value with
        | none => false
        | some posting =>
          (match accountingDate with
            | none => true
            | some date => date == booked.journal.accountingDate) &&
          contentHashEquals (hashCanonical (canonicalPostingValue posting))
            reference.postingContentHash &&
          (match copiedPosting with
            | none => true
            | some copied => contentHashEquals (hashCanonical (canonicalPostingValue copied))
                reference.postingContentHash)

/-! ## The checks of the read snapshot (`accounting.ts` lines 1402 to 1442) -/

/-- The `every` of `journalPopulationValid` (lines 1407 to 1410), from the journal at `index`: the
sequence is `index + 1`, the revision is within the cutoff, the journal is of the policy's book, and
the carried hash is the journal's. -/
def journalsAreOrdered (policy : AccountingBasisPolicy) (throughBookRevision : Int) :
    Nat → List BookedJournal → Bool
  | _, [] => true
  | index, booked :: rest =>
    decide (booked.postingSequence = ((index + 1 : Nat) : Int)) &&
    decide (booked.bookRevision ≤ throughBookRevision) &&
    booked.journal.bookId == policy.bookId &&
    contentHashEquals booked.canonicalHash (hashCanonical (canonicalJournalValue booked.journal)) &&
    journalsAreOrdered policy throughBookRevision (index + 1) rest

/-- `journalPopulationValid` (line 1407): as many journals as the cutoff sequence, and each one in
place. -/
def journalPopulationValid (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (ordered : List BookedJournal) : Bool :=
  decide ((ordered.length : Int) = snapshot.throughPostingSequence) &&
  journalsAreOrdered policy snapshot.throughBookRevision 0 ordered

/-- `configuredPolicyMatches` (line 1421): exactly one basis policy of the configuration has the
policy's identifier and version, and its canonical hash is the policy's. -/
def configuredPolicyMatches (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot) :
    Bool :=
  match snapshot.configurationSnapshot.accountingPolicySnapshot.policies.filter fun candidate =>
      candidate.kind == .accountingBasis && candidate.id == policy.id &&
        candidate.version == policy.version with
  | [configured] =>
    contentHashEquals (hashCanonical (canonicalize configured))
      (hashCanonical (canonicalize (AccountingPolicy.accountingBasis policy)))
  | _ => false

/-- `completeClassification` (line 1434), with `sortTexts` of `Policy.lean` for `[...keys].sort()`
(lines 1432 and 1433): the population and the events have as many keys, each
set of keys has no repeat, and the two sorted lists of keys are equal (with equal lengths, the
`every` over the indices is equality of the lists). -/
def completeClassification (snapshot : AccountingReadSnapshot) : Bool :=
  let populationKeys := snapshot.sourcePostingPopulation.map canonicalPostingSourceKey
  let eventSourceKeys := snapshot.sourceEvents.map fun event =>
    canonicalPostingSourceKey event.source
  populationKeys.length == eventSourceKeys.length &&
  decide (setSize populationKeys = populationKeys.length) &&
  decide (setSize eventSourceKeys = eventSourceKeys.length) &&
  sortTexts populationKeys == sortTexts eventSourceKeys

/-- `exactReferenceClassification` (line 1436): every event's source is in the population under its
key, with the same content hash (the map keeps the last reference set under a key). -/
def exactReferenceClassification (snapshot : AccountingReadSnapshot) : Bool :=
  let populationBySourceKey := snapshot.sourcePostingPopulation.map fun source =>
    (canonicalPostingSourceKey source, source)
  snapshot.sourceEvents.all fun event =>
    match mapLast populationBySourceKey (canonicalPostingSourceKey event.source) with
    | none => false
    | some populationSource =>
      contentHashEquals populationSource.contentHash event.source.contentHash

/-- `sourcePopulationCloses` (line 1440): every member of the population closes, and every event's
source closes over its copied posting and its accounting date. -/
def sourcePopulationCloses (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (ordered : List BookedJournal) : Bool :=
  snapshot.sourcePostingPopulation.all (fun source =>
    postingReferenceCloses policy ordered source none none) &&
  snapshot.sourceEvents.all fun event =>
    postingReferenceCloses policy ordered event.source (some event.sourcePosting)
      (some event.accountingDate)

/-- The checks of line 1441 that come before `accountingStateHashesAreValid`, in its order. -/
def snapshotFailsBeforeState (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (ordered : List BookedJournal) : Bool :=
  decide (snapshot.throughBookRevision < 0) || decide (snapshot.throughPostingSequence < 0) ||
  !configuredPolicyMatches policy snapshot || !journalPopulationValid policy snapshot ordered ||
  !uniqueJournalSources ordered || !completeClassification snapshot ||
  !exactReferenceClassification snapshot || !sourcePopulationCloses policy snapshot ordered

/-- The three hash checks of line 1441, after `accountingStateHashesAreValid`: the carried report
population hash, source population hash and content hash are the recomputed ones (the report
population from the snapshot without `contentHash` and `reportPopulationHash`, lines 1403 to 1405). -/
def snapshotHashesDiffer (snapshot : AccountingReadSnapshot) : Bool :=
  !contentHashEqual snapshot.reportPopulationHash
    (hashAccountingReadPopulation snapshot.toAccountingReadPopulation) ||
  !contentHashEqual snapshot.sourcePopulationHash
    (hashAccountingBasisSourcePopulation snapshot.sourceEvents) ||
  !contentHashEqual snapshot.contentHash
    (hashAccountingReadSnapshot snapshot.toAccountingReadSnapshotBody)

/-- The test of line 1441 as a whole, `||` from the left: `true` rejects. The checks before
`accountingStateHashesAreValid` stop it, and a throw in that function ends the call. -/
def readSnapshotRejects (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot) :
    Except QuantizeErr Bool :=
  if snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) then .ok true
  else
    match accountingStateHashesAreValid snapshot.accountingState with
    | .error e => .error e
    | .ok false => .ok true
    | .ok true => .ok (snapshotHashesDiffer snapshot)

/-! ## The rejections before the events (`accounting.ts` lines 1398 to 1401 and 1446) -/

/-- `"amount" in event || "settlementRatio" in event` (line 1401): a test of JavaScript properties
that a `BasisSourceEvent` does not have. A Lean event has exactly its fields, so it never holds. -/
def BasisSourceEvent.carriesComputedAmount (_ : BasisSourceEvent) : Bool := false

/-- The test of line 1401: two events have the same identifier, or one has an identifier that is
blank, or a list of settlement allocation identifiers with a repeat, or a computed amount or ratio. -/
def populationIdentityRejects (events : List BasisSourceEvent) : Bool :=
  decide (setSize (events.map (·.id)) ≠ events.length) ||
  events.any fun event =>
    (jsTrim event.id).length == 0 ||
    (match event.settlementAllocationIds with
      | none => false
      | some ids => decide (setSize ids ≠ ids.length)) ||
    event.carriesComputedAmount

/-- The diagnostic of line 1398. -/
def basisPolicyDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.policy"
    "Complete basis policy is required" ["ACC-042.3"]

/-- The diagnostic of line 1400. -/
def basisBoundDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.population"
    "Basis projection population exceeds the executable bound" ["ACC-042.4"]

/-- The diagnostic of line 1401. -/
def basisIdentityDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.population"
    "Basis projection requires one complete pinned source population with unique source identities and no caller-computed amounts or ratios"
    ["ACC-042.1", "ACC-042.4", "ACC-042.5"]

/-- The diagnostic of line 1441. -/
def basisSnapshotDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.readSnapshot"
    "Accounting-basis projection requires a complete content-hashed configuration, journal, accounting-effect, and typed source population at the requested cutoffs"
    ["ACC-042.1", "ACC-042.2", "ACC-042.4"]

/-- The test of line 1446 for one event: its reference is invalid, or its copied posting has another
identifier or another content hash than the reference names, or the reference is of another book, or
the posting is not in the policy's functional commodity. -/
def eventDoesNotClose (policy : AccountingBasisPolicy) (event : BasisSourceEvent) : Bool :=
  !validateCanonicalPostingReferenceHash event.source ||
  event.sourcePosting.id != event.source.postingId ||
  !contentHashEquals event.source.postingContentHash
    (hashCanonical (canonicalPostingValue event.sourcePosting)) ||
  event.source.bookId != policy.bookId ||
  event.sourcePosting.bookValue.functionalCommodityId !=
    policy.quantizationPolicy.functionalCommodityId

/-- The diagnostic of line 1446, at the path of the event. -/
def basisEventDiagnostic (event : BasisSourceEvent) : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete ("projection.events[" ++ event.id ++ "]")
    "Every source event must close over its exact same-book canonical posting reference and copied posting"
    ["ACC-042.1", "ACC-042.2"]

/-! ## The settlement ratio (`accounting.ts` lines 1459 to 1473) -/

/-- `[...ids].sort()` of identifiers (lines 1462, 1463 and 1485): a stable sort by the string, in
UTF-16 code unit order. -/
def sortIdentifiers {Kind : String} (ids : List (Identifier Kind)) : List (Identifier Kind) :=
  ids.mergeSort fun left right => jsStringLe left.value right.value

/-- `ExactRational.of(1n, 1n)` (line 1472), which never throws (`of_one_one`). -/
def basisOne : ExactRational := ⟨1, 1⟩

/-- The diagnostic of line 1456: the policy has no rule, or more than one, for the event's kind. -/
def basisRuleDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.events"
    "Every source event must resolve exactly one treatment" ["ACC-042.2", "ACC-042.3"]

/-- The diagnostic of line 1470. -/
def basisGraphDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.events"
    "Settlement-ratio treatment requires the source transaction's retained open item and complete content-hashed settlement-allocation graph"
    ["ACC-042.2", "ACC-042.3", "ACC-042.5"]

/-- The diagnostic of line 1472. -/
def basisRatioDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.events"
    "The retained settlement graph must derive an exact ratio between zero and one"
    ["ACC-042.3", "ACC-042.5"]

/-- What the settlement-ratio step of one event ends in: a rejection, or the ratio. -/
inductive SettlementRatioOutcome where
  | rejected (diagnostic : SemanticDiagnostic)
  | ratio (value : ExactRational)
  deriving DecidableEq, Repr, Inhabited

/-- The open item of an event (line 1460): the first of the state's open items with the event's
open item identifier. -/
def basisOpenItem (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) : Option OpenItem :=
  event.openItemId.bind fun id => snapshot.accountingState.openItems.find? fun candidate =>
    candidate.id == id

/-- The settlement allocations of an event (line 1461): those of the state that name the event's open
item, in the state's order; none when the event has no open item identifier. -/
def basisAllocations (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) :
    List SettlementAllocation :=
  match event.openItemId with
  | none => []
  | some id => snapshot.accountingState.settlementAllocations.filter fun candidate =>
    candidate.openItemId == id

/-- `allocationsClose` (line 1464): the supplied identifiers, sorted, are the retained ones, sorted
(with equal lengths, the `every` over the indices is equality of the lists), and every retained
allocation has a settlement of the open item's book, party and control account. -/
def allocationsClose (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent)
    (openItem : Option OpenItem) : Bool :=
  let allocations := basisAllocations snapshot event
  let suppliedIds := sortIdentifiers (event.settlementAllocationIds.getD [])
  let retainedIds := sortIdentifiers (allocations.map (·.id))
  suppliedIds.length == retainedIds.length && suppliedIds == retainedIds &&
  allocations.all fun allocation => snapshot.accountingState.settlements.any fun settlement =>
    settlement.id == allocation.settlementId &&
    openItem.map (·.bookId) == some settlement.bookId &&
    openItem.map (·.scope.externalPartyId) == some settlement.scope.externalPartyId &&
    openItem.map (·.scope.controlAccountId) == some settlement.scope.controlAccountId

/-- `recognitionCloses` (line 1469): the open item has a recognition source with a valid hash, in
the event's book, journal and effect. -/
def recognitionCloses (event : BasisSourceEvent) (openItem : Option OpenItem) : Bool :=
  match openItem.bind (·.recognitionSource) with
  | none => false
  | some recognition =>
    validateCanonicalPostingReferenceHash recognition &&
    recognition.bookId == event.source.bookId && recognition.journalId == event.source.journalId &&
    recognition.effectKey == event.source.effectKey

/-- The settlement ratio of an event with the `allocateBySettlementRatio` treatment (lines 1460 to
1472): the test of line 1470, then the sum of the allocations over the open item's book value
(`allocatedOpenItemBookValue ?? allocatedBookValue`), then the test that it lies from zero to one.
The sum and the division can throw. -/
def settlementRatioOf (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (event : BasisSourceEvent) : Except QuantizeErr SettlementRatioOutcome :=
  let openItem := basisOpenItem snapshot event
  let allocations := basisAllocations snapshot event
  match openItem with
  | none => .ok (.rejected basisGraphDiagnostic)
  | some item =>
    if item.bookId != policy.bookId || !positive item.bookValue.abs ||
        !allocationsClose snapshot event openItem || !recognitionCloses event openItem then
      .ok (.rejected basisGraphDiagnostic)
    else
      match liftExact (accountingSum (allocations.map fun allocation =>
          allocation.allocatedOpenItemBookValue.getD allocation.allocatedBookValue)) with
      | .error e => .error e
      | .ok total =>
        match liftExact (total.divide item.bookValue.abs) with
        | .error e => .error e
        | .ok ratio =>
          if ratio.compare ExactRational.zero == .lt || ratio.compare basisOne == .gt then
            .ok (.rejected basisRatioDiagnostic)
          else .ok (.ratio ratio)

/-! ## The loop over the events (`accounting.ts` lines 1448 to 1486) -/

/-- The five accumulators of the loop (lines 1449 to 1453). -/
structure BasisTotals where
  sourceExactTotal : ExactRational
  includedExactTotal : ExactRational
  excludedExactTotal : ExactRational
  projectedBookValueTotal : ExactRational
  quantizationResidualTotal : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- The accumulators before the first event: all zero. -/
def BasisTotals.empty : BasisTotals :=
  ⟨ExactRational.zero, ExactRational.zero, ExactRational.zero, ExactRational.zero,
    ExactRational.zero⟩

/-- `treatment === "exclude" ? zero : treatment === "allocateBySettlementRatio" ?
amount.multiply(settlementRatio!) : amount` (line 1475). The ratio is read only by the treatment
that allocates by it; for the others the TypeScript variable is `undefined`, and the caller passes
zero. -/
def includedExactAmountOf (treatment : AccountingBasisTreatment) (settlementRatio amount : ExactRational) :
    Except QuantizeErr ExactRational :=
  match treatment with
  | .exclude => .ok ExactRational.zero
  | .allocateBySettlementRatio => liftExact (amount.multiply settlementRatio)
  | _ => .ok amount

/-- `treatment === "exclude" ? undefined : quantize(includedExactAmount, policy.quantizationPolicy)`
(line 1477). -/
def recognizedAmountOf (policy : AccountingBasisPolicy) (treatment : AccountingBasisTreatment)
    (included : ExactRational) : Except QuantizeErr (Option QuantizedValue) :=
  match treatment with
  | .exclude => .ok none
  | _ =>
    match quantize included policy.quantizationPolicy.rule with
    | .error e => .error e
    | .ok recognized => .ok (some recognized)

/-- Lines 1478 to 1484: the three totals take the amount, the included and the excluded amounts,
and, for a recognized amount, the booked total takes its amount and the residual total its
residual; the first addition that throws ends the call. -/
def addBasisTotals (totals : BasisTotals) (amount included excluded : ExactRational)
    (recognized : Option QuantizedValue) : Except QuantizeErr BasisTotals :=
  match liftExact (totals.sourceExactTotal.add amount) with
  | .error e => .error e
  | .ok source =>
    match liftExact (totals.includedExactTotal.add included) with
    | .error e => .error e
    | .ok includedTotal =>
      match liftExact (totals.excludedExactTotal.add excluded) with
      | .error e => .error e
      | .ok excludedTotal =>
        match recognized with
        | none =>
          .ok ⟨source, includedTotal, excludedTotal, totals.projectedBookValueTotal,
            totals.quantizationResidualTotal⟩
        | some value =>
          match liftExact value.amount.toRational with
          | .error e => .error e
          | .ok valueAmount =>
            match liftExact (totals.projectedBookValueTotal.add valueAmount) with
            | .error e => .error e
            | .ok bookedTotal =>
              match liftExact (totals.quantizationResidualTotal.add value.residual) with
              | .error e => .error e
              | .ok residualTotal =>
                .ok ⟨source, includedTotal, excludedTotal, bookedTotal, residualTotal⟩

/-- Lines 1474 to 1485 for one event whose treatment is known: the amount, the included, excluded
and recognized amounts, the totals, and the entry, whose ordinal is one more than the number of
entries before it. -/
def basisEntryOf (policy : AccountingBasisPolicy) (event : BasisSourceEvent)
    (treatment : AccountingBasisTreatment) (settlementRatio : ExactRational) (count : Nat)
    (totals : BasisTotals) : Except QuantizeErr (AccountingBasisProjectionEntry × BasisTotals) :=
  match liftExact event.sourcePosting.bookValue.amount.toRational with
  | .error e => .error e
  | .ok amount =>
    match includedExactAmountOf treatment settlementRatio amount with
    | .error e => .error e
    | .ok included =>
      match liftExact (amount.subtract included) with
      | .error e => .error e
      | .ok excluded =>
        match recognizedAmountOf policy treatment included with
        | .error e => .error e
        | .ok recognized =>
          match addBasisTotals totals amount included excluded recognized with
          | .error e => .error e
          | .ok totals' =>
            .ok ({ ordinal := ((count + 1 : Nat) : Int), sourceId := event.id, treatment,
                    includedExactAmount := included, excludedExactAmount := excluded,
                    recognizedAmount := recognized,
                    settlementAllocationIds := sortIdentifiers (event.settlementAllocationIds.getD []),
                    amount := included }, totals')

/-- What the loop does with one event: a rejection, or the entry and the new totals. -/
inductive BasisEventOutcome where
  | rejected (diagnostic : SemanticDiagnostic)
  | entry (entry : AccountingBasisProjectionEntry) (totals : BasisTotals)
  deriving DecidableEq, Repr, Inhabited

/-- The body of the loop of line 1454 for one event: the rules (line 1455), the settlement ratio
(lines 1458 to 1473; the TypeScript variable is `undefined`, and here zero, for another treatment),
and the entry. -/
def processBasisEvent (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (event : BasisSourceEvent) (count : Nat) (totals : BasisTotals) :
    Except QuantizeErr BasisEventOutcome :=
  match policy.rules.filter fun rule => rule.event == event.event with
  | [rule] =>
    match (if rule.treatment == .allocateBySettlementRatio then settlementRatioOf policy snapshot event
        else .ok (.ratio ExactRational.zero)) with
    | .error e => .error e
    | .ok (.rejected diagnostic) => .ok (.rejected diagnostic)
    | .ok (.ratio ratio) =>
      match basisEntryOf policy event rule.treatment ratio count totals with
      | .error e => .error e
      | .ok (entry, totals') => .ok (.entry entry totals')
  | _ => .ok (.rejected basisRuleDiagnostic)

/-- What the whole loop ends in: a rejection, or every entry and the final totals. -/
inductive BasisLoopOutcome where
  | rejected (diagnostic : SemanticDiagnostic)
  | done (entries : List AccountingBasisProjectionEntry) (totals : BasisTotals)
  deriving DecidableEq, Repr, Inhabited

/-- The loop of line 1454: the events in order, `count` entries so far; the first rejection or throw
ends it. -/
def basisLoop (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot) :
    Nat → BasisTotals → List BasisSourceEvent → Except QuantizeErr BasisLoopOutcome
  | _, totals, [] => .ok (.done [] totals)
  | count, totals, event :: rest =>
    match processBasisEvent policy snapshot event count totals with
    | .error e => .error e
    | .ok (.rejected diagnostic) => .ok (.rejected diagnostic)
    | .ok (.entry entry totals') =>
      match basisLoop policy snapshot (count + 1) totals' rest with
      | .error e => .error e
      | .ok (.rejected diagnostic) => .ok (.rejected diagnostic)
      | .ok (.done entries final) => .ok (.done (entry :: entries) final)

/-! ## The reconciliation, the projection and `projectAccountingBasis` (lines 1487 to 1494) -/

/-- The diagnostic of line 1490. -/
def basisReconciliationDiagnostic : SemanticDiagnostic :=
  diagnostic .accounting_basis_policy_incomplete "projection.reconciliation"
    "Accounting-basis source, inclusion, exclusion, exact projection, booked projection, and quantization residual totals must reconcile exactly"
    ["ACC-042.5"]

/-- `projectedExactTotal` (line 1487): the included total. -/
def BasisTotals.projectedExactTotal (totals : BasisTotals) : ExactRational := totals.includedExactTotal

/-- The reconciliation of line 1489 without its hash (`reconciliationBody`, line 1488). -/
def basisReconciliationBody (totals : BasisTotals) : AccountingBasisReconciliation :=
  { sourceExactTotal := totals.sourceExactTotal, includedExactTotal := totals.includedExactTotal,
    excludedExactTotal := totals.excludedExactTotal,
    projectedExactTotal := totals.projectedExactTotal,
    projectedBookValueTotal := totals.projectedBookValueTotal,
    quantizationResidualTotal := totals.quantizationResidualTotal, contentHash := default }

/-- `reconciliation` (line 1489): the body with `accountingHash("AccountingBasisReconciliation",
body)`. -/
def basisReconciliation (totals : BasisTotals) : AccountingBasisReconciliation :=
  let body := basisReconciliationBody totals
  { body with contentHash := accountingBodyHash "AccountingBasisReconciliation" body }

/-- The test of line 1490, `||` from the left: the source total is not the included plus the excluded
total, or the projected exact total is not the included total, or the booked total plus the residual
total is not the projected exact total. `true` rejects; an addition can throw. -/
def reconciliationFails (totals : BasisTotals) : Except QuantizeErr Bool :=
  match liftExact (totals.includedExactTotal.add totals.excludedExactTotal) with
  | .error e => .error e
  | .ok sum =>
    if !totals.sourceExactTotal.equals sum then .ok true
    else if !totals.projectedExactTotal.equals totals.includedExactTotal then .ok true
    else
      match liftExact (totals.projectedBookValueTotal.add totals.quantizationResidualTotal) with
      | .error e => .error e
      | .ok booked => .ok (!booked.equals totals.projectedExactTotal)

/-- `sourceSnapshot` (line 1491): the read snapshot with its events in identifier order and the
content hash of that snapshot. -/
def basisSourceSnapshot (snapshot : AccountingReadSnapshot) (ordered : List BasisSourceEvent) :
    AccountingReadSnapshot :=
  immutableAccountingValue
    { snapshot with
      sourceEvents := ordered
      contentHash := hashAccountingReadSnapshot
        { snapshot.toAccountingReadSnapshotBody with sourceEvents := ordered } }

/-- The projection of lines 1492 and 1493: `body` with `accountingHash("AccountingBasisProjection",
body)`. -/
def basisProjection (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (ordered : List BasisSourceEvent) (entries : List AccountingBasisProjectionEntry)
    (reconciliation : AccountingBasisReconciliation) : AccountingBasisProjection :=
  let body : AccountingBasisProjection :=
    { policyId := policy.id, sourcePopulationHash := snapshot.sourcePopulationHash, entries,
      reconciliation, sourceSnapshot := basisSourceSnapshot snapshot ordered,
      contentHash := default }
  { body with contentHash := accountingBodyHash "AccountingBasisProjection" body }

/-- `projectAccountingBasis` (line 1388): the checks in the TypeScript's order. The policy
(`policyAt`, line 1397; its diagnostic is replaced by that of line 1398), the size of the population,
its identities, the read snapshot, the closure of each event in identifier order, the events in
identifier order (the first rejection or throw ends the loop), the reconciliation, and the
projection. `.error` is the first exact-number throw. -/
def projectAccountingBasis (policies : List AccountingPolicy) (policyIdValue : PolicyId)
    (version : SemanticVersion) (readSnapshot : AccountingReadSnapshot) :
    Except QuantizeErr BasisProjectionResult :=
  match policyAt AccountingBasisPolicy policies policyIdValue version readSnapshot.policyEffectiveAt with
  | .rejected _ => .ok (.rejected [basisPolicyDiagnostic])
  | .selected policy =>
    if decide (readSnapshot.sourceEvents.length > accountingLimits.maxBasisEvents) then
      .ok (.rejected [basisBoundDiagnostic])
    else if populationIdentityRejects readSnapshot.sourceEvents then
      .ok (.rejected [basisIdentityDiagnostic])
    else
      match readSnapshotRejects policy readSnapshot with
      | .error e => .error e
      | .ok true => .ok (.rejected [basisSnapshotDiagnostic])
      | .ok false =>
        let ordered := sortBasisEventsById readSnapshot.sourceEvents
        match ordered.find? (eventDoesNotClose policy) with
        | some event => .ok (.rejected [basisEventDiagnostic event])
        | none =>
          match basisLoop policy readSnapshot 0 BasisTotals.empty ordered with
          | .error e => .error e
          | .ok (.rejected diagnostic) => .ok (.rejected [diagnostic])
          | .ok (.done entries totals) =>
            match reconciliationFails totals with
            | .error e => .error e
            | .ok true => .ok (.rejected [basisReconciliationDiagnostic])
            | .ok false =>
              .ok (.projected (basisProjection policy readSnapshot ordered entries
                (basisReconciliation totals)))

end Rastrata.Kernel

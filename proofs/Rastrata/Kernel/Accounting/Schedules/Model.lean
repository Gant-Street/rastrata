/-
Allocation schedules: the Lean model of `packages/kernel/src/accounting.ts` lines 1543 to 1755
(`monthsBetween`, `addMonths`, `scheduleStepMonths`, `AllocationUsageFact`,
`AllocationScheduleRequest`, `createAllocationSchedule`, `AllocationRecognitionRequest`,
`AllocationAccountingState`, `recognizeScheduledAllocation`, `AllocationScheduleRevisionRequest`,
`reviseAllocationSchedule`) and the proofs of their laws.

`CUMULATIVE_ALLOCATION_ALGORITHM_VERSION`, `usesCumulativeAllocation` and `allocationPlanIsValid`
(lines 1555 to 1572) are already modelled in `Accounting/Core/Model.lean` and used from there.

What is assumed about JavaScript, and what is not modelled:

- `monthsBetween` and `addMonths` split a `LocalDate` on `"-"` and convert the year and month
  strings with `Number(...)`. On any valid `LocalDate` (`LocalDate.WF`), the parts are four-digit
  years (0 to 9999) and two-digit months (1 to 12), which are exact JavaScript `Number`s; the
  result of `monthsBetween` lies in `[-119998, 120000]`, also exact. `addMonths` converts `offset`
  with `Number(offset)`, which is exact when `|offset| ≤ 2^53` (inside `createAllocationSchedule`,
  `0 ≤ offset ≤ 14400`); `Number(offset)` rounding for larger offsets is not modelled.
- `BigInt` `/` in `(months + step - 1n) / step` and `12n / step` truncates toward zero (`jsDiv`).
  `Math.floor(total / 12)` in `addMonths` rounds toward negative infinity (`Int.ediv total 12`), and
  `total % 12` truncates toward zero (`jsMod total 12`).
- `Array.from({ length: Number(count) }, ...)` returns `[]` for `count ≤ 0`, matching `List.range
  count.toNat`.
- `[...request.priorRecognitionIds].sort()` and `recognitions.map(...).sort()` sort strings by
  UTF-16 code unit (`List.mergeSort` with `jsStringLe`).
- `new Set(values).size !== values.length` is modelled via `List.Nodup` (`!values.Nodup` /
  `values.eraseDups.length ≠ values.length`).
- In `reviseAllocationSchedule` (line 1688), `original.postingPlan!.installments.find(...)!.postedAmount`
  uses non-null assertions; if `find?` were `none` (possible only on a SHA-256 collision of
  `AllocationPostingPlanValue`), JavaScript would throw a `TypeError`, modelled as
  `ScheduleErr.missingPlanInstallment`. Similarly line 1727's `throw new Error(...)` is modelled as
  `ScheduleErr.missingSuccessorEffect` and proved unreachable.
- `Object.freeze` and object identity are not modelled.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Accounting.Core
import Mathlib.Data.List.Perm.Basic

namespace Rastrata.Kernel

/-! ## Types not yet in `Accounting/Types.lean` (`accounting.ts` lines 1554, 1624 to 1663) -/

/-- The element type of `AllocationScheduleRequest.usage`, unnamed in the TypeScript
(`accounting.ts` line 1554). -/
structure AllocationUsageFact where
  date : LocalDate
  value : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationScheduleRequest` (`accounting.ts` line 1554). -/
structure AllocationScheduleRequest where
  id : AllocationScheduleId
  policyId : PolicyId
  policyVersion : SemanticVersion
  governedAt : Instant
  source : Option CanonicalPostingReference
  /-- Deprecated in the TypeScript: use `source`. -/
  sourcePostingId : Option PostingId
  sourceBasis : ExactRational
  residualValue : ExactRational
  startsOn : LocalDate
  endsOn : LocalDate
  usage : Option (List AllocationUsageFact)
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationRecognitionRequest` (`accounting.ts` line 1624). -/
structure AllocationRecognitionRequest where
  id : AllocationRecognitionId
  scheduleId : AllocationScheduleId
  ordinal : Int
  governedAt : Instant
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `AllocationAccountingState` (`accounting.ts` line 1628). -/
structure AllocationAccountingState where
  allocationSchedules : List AllocationSchedule
  allocationRecognitions : List AllocationRecognition
  allocationScheduleRevisions : List AllocationScheduleRevision
  deriving DecidableEq, Repr, Inhabited

/-- The schedule-lifecycle slice of a full `AccountingCanonicalState`. -/
def AccountingCanonicalState.toAllocationState (state : AccountingCanonicalState) :
    AllocationAccountingState where
  allocationSchedules := state.allocationSchedules
  allocationRecognitions := state.allocationRecognitions
  allocationScheduleRevisions := state.allocationScheduleRevisions

/-- `AllocationScheduleRevisionRequest` (`accounting.ts` line 1646). -/
structure AllocationScheduleRevisionRequest where
  id : AllocationScheduleRevisionId
  kind : AllocationScheduleChangeKind
  effectiveOn : LocalDate
  policyEffectiveAt : Instant
  generatedEffectKey : Option EffectKey
  originalScheduleId : AllocationScheduleId
  priorRecognitionIds : List AllocationRecognitionId
  policyId : PolicyId
  policyVersion : SemanticVersion
  revisedResidualValue : ExactRational
  exactAdjustmentAmount : Option ExactRational
  successorScheduleId : Option AllocationScheduleId
  revisedEndsOn : Option LocalDate
  revisedUsage : Option (List AllocationUsageFact)
  evidence : List SourceEvidence
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-! ## Meaning: constructible requests and state -/

/-- A constructible usage fact: its date is a real date and its value is constructible. -/
structure AllocationUsageFact.WF (fact : AllocationUsageFact) : Prop where
  date : fact.date.WF
  value : fact.value.WF

/-- A constructible schedule creation request: the two dates are real dates (`localDate` is the
only maker of a `LocalDate`), the exact numbers are constructible and the identifiers valid. -/
structure AllocationScheduleRequest.WF (request : AllocationScheduleRequest) : Prop where
  id : request.id.WF
  policyId : request.policyId.WF
  startsOn : request.startsOn.WF
  endsOn : request.endsOn.WF
  source : ∀ s, request.source = some s → s.WF
  sourcePostingId : ∀ id, request.sourcePostingId = some id → id.WF
  sourceBasis : request.sourceBasis.WF
  residualValue : request.residualValue.WF
  usage : ∀ u, request.usage = some u → ∀ item ∈ u, item.WF
  derivation : request.derivation.WF

/-- A constructible allocation recognition request. -/
structure AllocationRecognitionRequest.WF (request : AllocationRecognitionRequest) : Prop where
  id : request.id.WF
  scheduleId : request.scheduleId.WF
  derivation : request.derivation.WF

/-- A constructible allocation accounting state. -/
structure AllocationAccountingState.WF (state : AllocationAccountingState) : Prop where
  allocationSchedules : ∀ s ∈ state.allocationSchedules, s.WF
  allocationRecognitions : ∀ r ∈ state.allocationRecognitions, r.WF
  allocationScheduleRevisions : ∀ r ∈ state.allocationScheduleRevisions, r.WF

/-- A constructible allocation schedule revision request. -/
structure AllocationScheduleRevisionRequest.WF (request : AllocationScheduleRevisionRequest) :
    Prop where
  id : request.id.WF
  effectiveOn : request.effectiveOn.WF
  revisedEndsOn : ∀ d, request.revisedEndsOn = some d → d.WF
  originalScheduleId : request.originalScheduleId.WF
  priorRecognitionIds : ∀ id ∈ request.priorRecognitionIds, id.WF
  policyId : request.policyId.WF
  revisedResidualValue : request.revisedResidualValue.WF
  exactAdjustmentAmount : ∀ a, request.exactAdjustmentAmount = some a → a.WF
  successorScheduleId : ∀ id, request.successorScheduleId = some id → id.WF
  revisedUsage : ∀ u, request.revisedUsage = some u → ∀ item ∈ u, item.WF
  evidence : ∀ item ∈ request.evidence, item.WF
  derivation : request.derivation.WF

/-! ## Errors -/

/-- What the schedule functions can throw: an `ExactNumberError` or `RangeError` of `quantize`
(`QuantizeErr`), an `IdentityError` from `identifier<...>` (`CanonicalErr`), or the unreachable
run-time errors for missing plan installment (on a hash collision) or omitted successor effect. -/
inductive ScheduleErr where
  | quantize (error : QuantizeErr)
  | identity (error : CanonicalErr)
  | missingPlanInstallment
  | missingSuccessorEffect
  deriving DecidableEq, Repr, Inhabited

namespace Schedules

/-- Lift a `NumErr` operation into `ScheduleErr`. -/
def liftNum {α : Type} : Except NumErr α → Except ScheduleErr α
  | .ok v => .ok v
  | .error e => .error (.quantize (.exactNumber e))

/-- Lift a `QuantizeErr` operation into `ScheduleErr`. -/
def liftQuantize {α : Type} : Except QuantizeErr α → Except ScheduleErr α
  | .ok v => .ok v
  | .error e => .error (.quantize e)

/-- Lift a `CanonicalErr` operation into `ScheduleErr`. -/
def liftCanonical {α : Type} : Except CanonicalErr α → Except ScheduleErr α
  | .ok v => .ok v
  | .error e => .error (.identity e)

/-! ## Calendar helpers (`accounting.ts` lines 1543 to 1553) -/

/-- Split a character list on `'-'`, matching JavaScript `String.prototype.split("-")`. -/
def splitDash : List Char → List Char → List (List Char)
  | [], acc => [acc.reverse]
  | c :: cs, acc =>
    if c == '-' then acc.reverse :: splitDash cs []
    else splitDash cs (c :: acc)

/-- Parse the leading year and month of `start.split("-").map(Number)` for a `LocalDate`. -/
def parseYearMonth (d : LocalDate) : Int × Int :=
  match splitDash d.value.toList [] with
  | y :: m :: _ =>
    if !y.isEmpty && y.all isAsciiDigit && !m.isEmpty && m.all isAsciiDigit then
      ((digitsToNat y : Int), (digitsToNat m : Int))
    else (0, 0)
  | _ => (0, 0)

/-- Left-pad a string with `'0'` to at least `width` characters (`padStart(width, "0")`). -/
def padZero (width : Nat) (s : String) : String :=
  String.ofList (List.replicate (width - s.length) '0') ++ s

/-- `monthsBetween` (`accounting.ts` line 1543). -/
def monthsBetween (start endDate : LocalDate) : Int :=
  let (sy, sm) := parseYearMonth start
  let (ey, em) := parseYearMonth endDate
  (ey - sy) * 12 + em - sm + 1

/-- `addMonths` (`accounting.ts` line 1547). -/
def addMonths (start : LocalDate) (offset : Int) : LocalDate :=
  let (year, month) := parseYearMonth start
  let total := year * 12 + month - 1 + offset
  let yStr := padZero 4 (toString (Int.ediv total 12))
  let mStr := padZero 2 (toString (jsMod total 12 + 1))
  ⟨yStr ++ "-" ++ mStr ++ "-01"⟩

/-- `scheduleStepMonths` (`accounting.ts` line 1551). -/
def scheduleStepMonths : AllocationFrequency → Option Int
  | .monthly => some 1
  | .quarterly => some 3
  | .annual => some 12
  | .eventDriven => none

/-! ## Rejections of `createAllocationSchedule` (`accounting.ts` lines 1576 to 1608) -/

/-- Line 1576: policy, derivation, book, dates, residual or basis incoherent. -/
def createCoherenceRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule"
    "Allocation basis, residual, dates, lineage, and policy must be coherent" ["ACC-044.1"]

/-- Line 1580: non-full-period or unsupported frequency for straight-line/declining-balance. -/
def createPolicyRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.policy"
    "This executable capability requires a monthly, quarterly, or annual full-period convention"
    ["ACC-044.1", "ACC-044.2"]

/-- Line 1583: installment count exceeds `ACCOUNTING_LIMITS.maxScheduleInstallments`. -/
def createSpanRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.span"
    "Allocation schedule span exceeds the executable installment bound" ["ACC-044.1"]

/-- Line 1587: declining-balance rate missing, non-positive, or greater than one. -/
def createDecliningRateRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.policy"
    "Declining balance requires a positive exact annual rate no greater than one" ["ACC-044.2"]

/-- Line 1599: usage-event population exceeds `ACCOUNTING_LIMITS.maxUsageEvents`. -/
def createUsageBoundRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.usage"
    "Usage-event population exceeds the executable bound" ["ACC-044.2"]

/-- Line 1600: units-of-production usage facts invalid or do not match expected usage. -/
def createUsageFactsRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.usage"
    "Units-of-production requires complete, unique, positive usage facts matching policy expectations"
    ["ACC-044.2"]

/-- Line 1603: exact installments plus residual do not equal source basis. -/
def createInstallmentsConservationRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.installments"
    "Exact installments plus residual must conserve source basis" ["ACC-044.3"]

/-- Line 1608: cumulative schedule posted source basis not representable or accounts equal. -/
def createPostingPlanRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.schedule.postingPlan"
    "Cumulative schedules require representable posted source basis and distinct recognition accounts"
    ["ACC-044.3"]

/-- `dates.map(() => allocable.divide(ExactRational.of(count, 1n)))` (`accounting.ts` line 1585). -/
def straightLineAmounts (allocable : ExactRational) (count : Int) :
    List LocalDate → Except ScheduleErr (List ExactRational)
  | [] => .ok []
  | _ :: rest =>
    match liftNum (ExactRational.of count 1) with
    | .error e => .error e
    | .ok divisor =>
      match liftNum (allocable.divide divisor) with
      | .error e => .error e
      | .ok amount =>
        match straightLineAmounts allocable count rest with
        | .error e => .error e
        | .ok tail => .ok (amount :: tail)

/-- Line 1593: the last period, or one whose calculated amount is above what remains of the
allocable amount, takes what remains. `remaining` is the number of periods after this one. -/
def decliningAmount (remaining : Nat) (calculated remainingAllocable : ExactRational) :
    ExactRational :=
  if remaining == 0 || calculated.compare remainingAllocable == .gt then remainingAllocable
  else calculated

/-- The loop for `decliningBalance` (`accounting.ts` lines 1590 to 1595), from iteration `index`
with `remaining` iterations left (`count - index`) and current `carrying` basis. -/
def decliningBalanceAmounts (rate residualValue : ExactRational) (periodsPerYear : Int) :
    Nat → ExactRational → Except ScheduleErr (List ExactRational)
  | 0, _ => .ok []
  | remaining + 1, carrying =>
    match liftNum (carrying.multiply rate) with
    | .error e => .error e
    | .ok prod =>
      match liftNum (ExactRational.of periodsPerYear 1) with
      | .error e => .error e
      | .ok divisor =>
        match liftNum (prod.divide divisor) with
        | .error e => .error e
        | .ok calculated =>
          match liftNum (carrying.subtract residualValue) with
          | .error e => .error e
          | .ok remainingAllocable =>
            let amount := decliningAmount remaining calculated remainingAllocable
            match liftNum (carrying.subtract amount) with
            | .error e => .error e
            | .ok nextCarrying =>
              match decliningBalanceAmounts rate residualValue periodsPerYear remaining
                  nextCarrying with
              | .error e => .error e
              | .ok rest => .ok (amount :: rest)

/-- `usage.map((item) => allocable.multiply(item.value).divide(totalUsage))`
(`accounting.ts` line 1601). -/
def usageAmounts (allocable totalUsage : ExactRational) :
    List AllocationUsageFact → Except ScheduleErr (List ExactRational)
  | [] => .ok []
  | item :: rest =>
    match liftNum (allocable.multiply item.value) with
    | .error e => .error e
    | .ok prod =>
      match liftNum (prod.divide totalUsage) with
      | .error e => .error e
      | .ok amount =>
        match usageAmounts allocable totalUsage rest with
        | .error e => .error e
        | .ok tail => .ok (amount :: tail)

/-- Zip amounts and dates into `ScheduledAllocation`s with 1-based ordinals (`accounting.ts` line
1604). -/
def buildInstallments (nextOrdinal : Nat) :
    List ExactRational → List LocalDate → List ScheduledAllocation
  | [], _ => []
  | _, [] => []
  | amount :: amounts, date :: dates =>
    { ordinal := (nextOrdinal : Int), accountingDate := date, amount := amount } ::
      buildInstallments (nextOrdinal + 1) amounts dates

/-- Dates generated by `addMonths(startsOn, index * step)` for `0 ≤ index < count`
(`accounting.ts` line 1584). -/
def scheduleDates (startsOn : LocalDate) (step : Int) (count : Nat) : List LocalDate :=
  (List.range count).map fun (index : Nat) => addMonths startsOn (Int.ofNat index * step)


/-! ## The parts of `createAllocationSchedule` (`accounting.ts` lines 1574 to 1622)

The function is one `if` chain in the TypeScript; each part below is a named piece of that chain,
in its order, so that a law can speak of the condition it tests. -/

/-- The test of line 1576 once `policyAt` returned a policy: the derivation is approved with
evidence, the policy is of this book, the dates are in order, and the residual is not negative and
not above the basis. -/
def createIncoherent (policy : AllocationPolicy) (bookId : BookId)
    (request : AllocationScheduleRequest) : Bool :=
  !validAccountingDerivation request.derivation || policy.bookId != bookId ||
    decide (request.endsOn < request.startsOn) || request.residualValue.isNegative ||
    request.residualValue.compare request.sourceBasis == .gt

/-- Lines 1579 to 1596, for `straightLine` and `decliningBalance`: the dates and the exact amounts,
or the rejection of the policy's shape, of the span, or of the declining rate. -/
def periodicSchedule (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (allocable : ExactRational) :
    Except ScheduleErr (AccountingCalculation ⊕ (List ExactRational × List LocalDate)) :=
  match scheduleStepMonths policy.frequency with
  | none => .ok (.inl createPolicyRejection)
  | some step =>
    if policy.convention != .fullPeriod then .ok (.inl createPolicyRejection)
    else
      let months := monthsBetween request.startsOn request.endsOn
      let count := jsDiv (months + step - 1) step
      if count > (accountingLimits.maxScheduleInstallments : Int) then
        .ok (.inl createSpanRejection)
      else
        let dates := scheduleDates request.startsOn step count.toNat
        if policy.method == .straightLine then
          match straightLineAmounts allocable count dates with
          | .error e => .error e
          | .ok amounts => .ok (.inr (amounts, dates))
        else
          match policy.decliningRate with
          | none => .ok (.inl createDecliningRateRejection)
          | some rate =>
            if !positive rate || rate.compare ⟨1, 1⟩ == .gt then
              .ok (.inl createDecliningRateRejection)
            else
              match decliningBalanceAmounts rate request.residualValue (jsDiv 12 step)
                  count.toNat request.sourceBasis with
              | .error e => .error e
              | .ok amounts => .ok (.inr (amounts, dates))

/-- The test of line 1600, which rejects the usage facts of a units-of-production schedule. -/
def usageFactsBad (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (totalUsage : ExactRational) (usage : List AllocationUsageFact) : Bool :=
  policy.frequency != .eventDriven || policy.convention != .usageEvent ||
    (match policy.expectedUsage with
      | none => true
      | some expected => !positive expected || !totalUsage.equals expected) ||
    usage.isEmpty || !decide ((usage.map (·.date)).Nodup) ||
    usage.any (fun item => !positive item.value || decide (item.date < request.startsOn) ||
      decide (request.endsOn < item.date))

/-- Lines 1598 to 1601, for `unitsOfProduction`: the exact amounts, one for each usage fact in the
order given, and their dates, or the rejection of the population or of the facts. -/
def usageSchedule (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (allocable : ExactRational) :
    Except ScheduleErr (AccountingCalculation ⊕ (List ExactRational × List LocalDate)) :=
  let usage := request.usage.getD []
  match liftNum (accountingSum (usage.map (·.value))) with
  | .error e => .error e
  | .ok totalUsage =>
    if usage.length > accountingLimits.maxUsageEvents then .ok (.inl createUsageBoundRejection)
    else if usageFactsBad policy request totalUsage usage then
      .ok (.inl createUsageFactsRejection)
    else
      match usageAmounts allocable totalUsage usage with
      | .error e => .error e
      | .ok amounts => .ok (.inr (amounts, usage.map (·.date)))

/-- Lines 1578 to 1602: the exact amounts and dates of the schedule, by the policy's method. -/
def generate (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (allocable : ExactRational) :
    Except ScheduleErr (AccountingCalculation ⊕ (List ExactRational × List LocalDate)) :=
  if policy.method == .straightLine || policy.method == .decliningBalance then
    periodicSchedule policy request allocable
  else usageSchedule policy request allocable

/-- Lines 1605 to 1614: the posting plan of a cumulative schedule, none for another. -/
def createPlan (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (installments : List ScheduledAllocation) :
    Except ScheduleErr (AccountingCalculation ⊕ Option AllocationPostingPlan) :=
  if usesCumulativeAllocation policy then
    match liftQuantize (quantize request.sourceBasis policy.quantizationPolicy.rule) with
    | .error e => .error e
    | .ok source =>
      if !source.residual.isZero || policy.allocationAccountId == policy.contraAccountId then
        .ok (.inl createPostingPlanRejection)
      else
        match liftQuantize (planAllocationPostings
            { exactSourceBasis := request.sourceBasis,
              exactResidualValue := request.residualValue,
              postedSourceBasis := source.amount,
              quantizationPolicy := policy.quantizationPolicy,
              installments := installments }) with
        | .error e => .error e
        | .ok (.rejected diagnostics) => .ok (.inl (.rejected diagnostics))
        | .ok (.planned plan) => .ok (.inr (some plan))
  else .ok (.inr none)

/-- Lines 1615 to 1620: the schedule, with the hash of its body. -/
def assembleSchedule (bookId : BookId) (policy : AllocationPolicy)
    (request : AllocationScheduleRequest) (installments : List ScheduledAllocation)
    (postingPlan : Option AllocationPostingPlan) : AllocationSchedule :=
  let body : AllocationSchedule :=
    { id := request.id, bookId := bookId, policyId := policy.id, policy := policy,
      source := request.source, sourcePostingId := request.sourcePostingId,
      sourceBasis := request.sourceBasis, residualValue := request.residualValue,
      installments := installments, postingPlan := postingPlan,
      derivation := request.derivation, contentHash := default }
  { body with contentHash := accountingBodyHash "AllocationSchedule" body }

end Schedules

/-- `createAllocationSchedule` (`accounting.ts` line 1574). -/
def createAllocationSchedule (policies : List AccountingPolicy) (bookId : BookId)
    (request : AllocationScheduleRequest) : Except ScheduleErr AccountingCalculation :=
  match policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt with
  | .rejected _ => .ok Schedules.createCoherenceRejection
  | .selected policy =>
    if Schedules.createIncoherent policy bookId request then
      .ok Schedules.createCoherenceRejection
    else
      match Schedules.liftNum (request.sourceBasis.subtract request.residualValue) with
      | .error e => .error e
      | .ok allocable =>
        match Schedules.generate policy request allocable with
        | .error e => .error e
        | .ok (.inl rejection) => .ok rejection
        | .ok (.inr (amounts, dates)) =>
          match Schedules.liftNum (accountingSum amounts) with
          | .error e => .error e
          | .ok amountsSum =>
            match Schedules.liftNum (amountsSum.add request.residualValue) with
            | .error e => .error e
            | .ok totalBasis =>
              if !totalBasis.equals request.sourceBasis then
                .ok Schedules.createInstallmentsConservationRejection
              else
                let installments := Schedules.buildInstallments 1 amounts dates
                match Schedules.createPlan policy request installments with
                | .error e => .error e
                | .ok (.inl rejection) => .ok rejection
                | .ok (.inr postingPlan) =>
                  .ok (drafted []
                    [.allocationSchedule
                      (Schedules.assembleSchedule bookId policy request installments postingPlan)])

namespace Schedules

/-! ## The parts of `recognizeScheduledAllocation` (`accounting.ts` lines 1630 to 1644) -/

/-- Line 1634: schedule installment must exist, remain unsuperseded, retain approved lineage, and
may be recognized once. -/
def recognitionRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.recognition"
    "Schedule installment must exist, remain unsuperseded, retain approved lineage, and may be recognized once"
    ["ACC-044.4", "ACC-044.5"]

/-- Line 1635: retained algorithm and posting plan disagree. -/
def recognitionPostingPlanRejection : AccountingCalculation :=
  reject .allocation_schedule_violation "command.recognition.postingPlan"
    "The retained algorithm and complete immutable posting plan must agree" ["ACC-044.3"]

/-- The `superseded` of line 1633: a revision of the schedule that disposes of it, terminates it,
or takes effect on or before the installment's date. -/
def superseded (state : AllocationAccountingState) (scheduleId : AllocationScheduleId)
    (installment : ScheduledAllocation) : Bool :=
  state.allocationScheduleRevisions.any fun revision =>
    revision.originalScheduleId == scheduleId &&
      (revision.kind == .disposal || revision.kind == .termination ||
        decide (revision.effectiveOn ≤ installment.accountingDate))

/-- The last clause of line 1634: a recognition of this identity, or of this installment of this
schedule, exists. -/
def alreadyRecognized (state : AllocationAccountingState)
    (request : AllocationRecognitionRequest) : Bool :=
  state.allocationRecognitions.any fun item =>
    item.id == request.id ||
      (item.scheduleId == request.scheduleId && item.ordinal == request.ordinal)

/-- The test of line 1634 once the schedule and the installment are found. -/
def recognitionRefused (state : AllocationAccountingState)
    (request : AllocationRecognitionRequest) (installment : ScheduledAllocation) : Bool :=
  superseded state request.scheduleId installment || !validAccountingDerivation request.derivation ||
    alreadyRecognized state request

/-- Line 1636: the posted amount the schedule's plan holds for the ordinal, else the
installment's exact amount. -/
def plannedAmount (schedule : AllocationSchedule) (installment : ScheduledAllocation)
    (ordinal : Int) : Except ScheduleErr ExactRational :=
  match schedule.postingPlan.bind (fun plan => plan.installments.find? (·.ordinal == ordinal)) with
  | some planInstallment => liftNum planInstallment.postedAmount.toRational
  | none => .ok installment.amount

/-- Lines 1638 to 1642: the journal that recognizes `amount`. -/
def recognitionJournal (request : AllocationRecognitionRequest) (schedule : AllocationSchedule)
    (installment : ScheduledAllocation) (commodityId : CommodityId) (amount : ExactRational)
    (journalId' : JournalId) (expenseId contraId : PostingId) : ExactPreparedJournal :=
  { requiredQuantizationPolicy := schedule.postingPlan.map fun _ => schedule.policy.quantizationPolicy,
    id := journalId', kind := .adjustment, economicAt := request.governedAt,
    accountingDate := installment.accountingDate, recordedAt := request.governedAt,
    narration := "Scheduled allocation recognition",
    postings :=
      [{ id := expenseId, accountId := schedule.policy.allocationAccountId, units := amount,
         unitsCommodityId := commodityId, exactBookValue := amount, costBasis := none },
       { id := contraId, accountId := schedule.policy.contraAccountId, units := amount.negate,
         unitsCommodityId := commodityId, exactBookValue := amount.negate, costBasis := none }],
    derivations := [request.derivation] }

/-- Line 1637: the recognition, with the hash of its body. -/
def recognitionEffect (request : AllocationRecognitionRequest) : AllocationRecognition :=
  let body : AllocationRecognition :=
    { id := request.id, scheduleId := request.scheduleId, ordinal := request.ordinal,
      derivation := request.derivation, contentHash := default }
  { body with contentHash := accountingBodyHash "AllocationRecognition" body }

end Schedules

/-- `recognizeScheduledAllocation` (`accounting.ts` line 1630). -/
def recognizeScheduledAllocation (_policies : List AccountingPolicy)
    (state : AllocationAccountingState) (commodityId : CommodityId)
    (request : AllocationRecognitionRequest) : Except ScheduleErr AccountingCalculation :=
  let scheduleOpt := state.allocationSchedules.find? (·.id == request.scheduleId)
  let installmentOpt :=
    scheduleOpt.bind fun schedule => schedule.installments.find? (·.ordinal == request.ordinal)
  match scheduleOpt, installmentOpt with
  | some schedule, some installment =>
    if Schedules.recognitionRefused state request installment then
      .ok Schedules.recognitionRejection
    else
      match Schedules.liftQuantize (allocationPlanIsValid schedule) with
      | .error e => .error e
      | .ok false => .ok Schedules.recognitionPostingPlanRejection
      | .ok true =>
        match Schedules.plannedAmount schedule installment request.ordinal with
        | .error e => .error e
        | .ok amount =>
          match Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with
          | .error e => .error e
          | .ok jid =>
            match Schedules.liftCanonical (postingId (request.id.value ++ "-expense")) with
            | .error e => .error e
            | .ok pidExpense =>
              match Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with
              | .error e => .error e
              | .ok pidContra =>
                .ok (drafted
                  [Schedules.recognitionJournal request schedule installment commodityId amount
                    jid pidExpense pidContra]
                  [.allocationRecognition (Schedules.recognitionEffect request)])
  | _, _ => .ok Schedules.recognitionRejection

namespace Schedules

/-! ## The parts of `reviseAllocationSchedule` (`accounting.ts` lines 1665 to 1754) -/

/-- Line 1674: original schedule missing or policy not resolved. -/
def revisionMissingRejection : AccountingCalculation :=
  reject .allocation_schedule_revision_violation "command.scheduleRevision"
    "Schedule revision requires one existing schedule and one applicable executable policy"
    ["ACC-044.4"]

/-- Line 1682: cumulative/legacy posting plan or accounts/quantization mismatch. -/
def revisionPostingPlanRejection : AccountingCalculation :=
  reject .allocation_schedule_revision_violation "command.scheduleRevision.postingPlan"
    "Cumulative revisions require a verified cumulative original and unchanged posting accounts/quantization; legacy conversion requires an explicit posted-history transition"
    ["ACC-044.3", "ACC-044.4"]

/-- Line 1713: revision cutoff, prior recognitions, adjustment topology, residual, successor,
policy, or evidence mismatch. -/
def revisionCoherenceRejection : AccountingCalculation :=
  reject .allocation_schedule_revision_violation "command.scheduleRevision"
    "Revision cutoff, prior recognitions, adjustment topology, residual, successor, policy, and evidence must reconcile exactly"
    ["ACC-044.4", "ACC-044.5", "ACC-044.6"]

/-- Line 1714: earlier installment not recognized prior to prospective revision. -/
def revisionPriorRecognitionsRejection : AccountingCalculation :=
  reject .allocation_schedule_revision_violation "command.scheduleRevision.priorRecognitionIds"
    "Recognize every earlier installment before a prospective revision so its carrying basis cannot be allocated twice"
    ["ACC-044.4", "ACC-044.5"]

/-- Sum posted amounts of the original schedule's posting plan matching each recognition
(`accounting.ts` line 1688). -/
def postedRecognitionAmounts (plan : AllocationPostingPlan) :
    List AllocationRecognition → Except ScheduleErr (List ExactRational)
  | [] => .ok []
  | recognition :: rest =>
    match plan.installments.find? (·.ordinal == recognition.ordinal) with
    | none => .error .missingPlanInstallment
    | some item =>
      match liftNum item.postedAmount.toRational with
      | .error e => .error e
      | .ok amt =>
        match postedRecognitionAmounts plan rest with
        | .error e => .error e
        | .ok tail => .ok (amt :: tail)

/-- Sort strings stably by UTF-16 code unit (`[...ids].sort()`). -/
def sortRecognitionStrings (ids : List String) : List String :=
  ids.mergeSort fun left right => jsStringLe left right

/-- Sort recognition identifiers stably by UTF-16 code unit of their string values. -/
def sortRecognitionIds (ids : List AllocationRecognitionId) : List AllocationRecognitionId :=
  ids.mergeSort fun left right => jsStringLe left.value right.value

/-- Lines 1678 to 1681, the part of the test that reads the original schedule and the policy once
the original is verified: a recognition of an installment the schedule does not have, a change of
posting account, or a change of quantization policy. -/
def planChanged (policy : AllocationPolicy) (original : AllocationSchedule)
    (recognitions : List AllocationRecognition) : Bool :=
  recognitions.any (fun recognition =>
    !original.installments.any (·.ordinal == recognition.ordinal)) ||
    policy.allocationAccountId != original.policy.allocationAccountId ||
    policy.contraAccountId != original.policy.contraAccountId ||
    !contentHashEquals (hashQuantizationPolicy policy.quantizationPolicy)
      (hashQuantizationPolicy original.policy.quantizationPolicy)

/-- Lines 1677 to 1683: `true` when the revision may go on; `false` when line 1682 rejects it. A
cumulative policy, or an original that carries a plan, needs both, a valid plan, and nothing
changed. -/
def planGate (policy : AllocationPolicy) (original : AllocationSchedule)
    (recognitions : List AllocationRecognition) : Except ScheduleErr Bool :=
  if usesCumulativeAllocation policy || original.postingPlan.isSome then
    if !usesCumulativeAllocation policy || original.postingPlan.isNone then .ok false
    else
      match liftQuantize (allocationPlanIsValid original) with
      | .error e => .error e
      | .ok false => .ok false
      | .ok true => .ok (!planChanged policy original recognitions)
  else .ok true

/-- Line 1686: the exact amounts of the recognized installments. -/
def recognizedParts (original : AllocationSchedule) (recognitions : List AllocationRecognition) :
    List ExactRational :=
  recognitions.map fun recognition =>
    ((original.installments.find? (·.ordinal == recognition.ordinal)).map (·.amount)).getD
      ExactRational.zero

/-- The figures of lines 1686 to 1694 that the checks and the result read. -/
structure RevisionTotals where
  recognizedToDate : ExactRational
  carryingAmountAtRevision : ExactRational
  postedRecognizedToDate : Option ExactRational
  postedCarryingAmountAtRevision : Option ExactRational
  appliedAdjustment : Option ExactRational
  afterAdjustment : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- Line 1690: the carrying amount the revision works from: the posted one when there is one. -/
def RevisionTotals.effectiveCarrying (totals : RevisionTotals) : ExactRational :=
  totals.postedCarryingAmountAtRevision.getD totals.carryingAmountAtRevision

/-- Lines 1688 and 1689: the posted amounts recognized to date and the posted carrying amount,
under the cumulative algorithm; neither otherwise. -/
def postedTotals (cumulative : Bool) (original : AllocationSchedule)
    (recognitions : List AllocationRecognition) :
    Except ScheduleErr (Option ExactRational × Option ExactRational) :=
  if cumulative then
    match original.postingPlan with
    | none => .error .missingPlanInstallment
    | some plan =>
      match postedRecognitionAmounts plan recognitions with
      | .error e => .error e
      | .ok postedParts =>
        match liftNum (accountingSum postedParts) with
        | .error e => .error e
        | .ok postedRecognized =>
          match liftNum (original.sourceBasis.subtract postedRecognized) with
          | .error e => .error e
          | .ok postedCarrying => .ok (some postedRecognized, some postedCarrying)
  else .ok (none, none)

/-- Line 1693: the adjustment as it is applied: rounded to the policy's scale under the cumulative
algorithm. -/
def appliedAdjustmentOf (cumulative : Bool) (policy : AllocationPolicy)
    (exactAdjustmentAmount : Option ExactRational) : Except ScheduleErr (Option ExactRational) :=
  match cumulative, exactAdjustmentAmount with
  | true, some adjustment =>
    match liftQuantize (quantize adjustment policy.quantizationPolicy.rule) with
    | .error e => .error e
    | .ok quantized =>
      match liftNum quantized.amount.toRational with
      | .error e => .error e
      | .ok rational => .ok (some rational)
  | _, optional => .ok optional

/-- Lines 1686 to 1694. -/
def revisionTotals (policy : AllocationPolicy) (cumulative : Bool) (original : AllocationSchedule)
    (recognitions : List AllocationRecognition) (exactAdjustmentAmount : Option ExactRational) :
    Except ScheduleErr RevisionTotals :=
  match liftNum (accountingSum (recognizedParts original recognitions)) with
  | .error e => .error e
  | .ok recognizedToDate =>
    match liftNum (original.sourceBasis.subtract recognizedToDate) with
    | .error e => .error e
    | .ok carryingAmountAtRevision =>
      match postedTotals cumulative original recognitions with
      | .error e => .error e
      | .ok (postedRecognizedToDate, postedCarryingAmountAtRevision) =>
        match appliedAdjustmentOf cumulative policy exactAdjustmentAmount with
        | .error e => .error e
        | .ok appliedAdjustment =>
          let effectiveCarrying := postedCarryingAmountAtRevision.getD carryingAmountAtRevision
          match liftNum (effectiveCarrying.add (appliedAdjustment.getD ExactRational.zero)) with
          | .error e => .error e
          | .ok afterAdjustment =>
            .ok { recognizedToDate, carryingAmountAtRevision, postedRecognizedToDate,
                  postedCarryingAmountAtRevision, appliedAdjustment, afterAdjustment }

/-- Line 1691: `adjustmentRequired`. -/
def adjustmentRequired (kind : AllocationScheduleChangeKind) (effectiveCarrying : ExactRational) :
    Bool :=
  kind == .impairment ||
    ((kind == .disposal || kind == .termination) && !effectiveCarrying.isZero)

/-- Line 1695: `successorRequired`. -/
def successorRequired (request : AllocationScheduleRevisionRequest) (afterAdjustment : ExactRational) :
    Bool :=
  request.kind == .estimateChange ||
    (request.kind == .impairment &&
      request.revisedResidualValue.compare afterAdjustment == .lt)

/-- The test of lines 1697 to 1712: the revision's cutoff, prior recognitions, adjustment topology,
residual, successor, policy and evidence must reconcile exactly; `true` rejects. -/
def revisionIncoherent (policy : AllocationPolicy) (bookId : BookId)
    (state : AllocationAccountingState) (original : AllocationSchedule)
    (recognitions : List AllocationRecognition) (request : AllocationScheduleRevisionRequest)
    (totals : RevisionTotals) : Bool :=
  let suppliedRecognitionIds := sortRecognitionStrings (request.priorRecognitionIds.map (·.value))
  let actualRecognitionIds := sortRecognitionIds (recognitions.map (·.id))
  let exactAdjustmentAmount := request.exactAdjustmentAmount
  let effectiveCarrying := totals.effectiveCarrying
  policy.bookId != bookId || request.evidence.isEmpty ||
    !validAccountingDerivation request.derivation ||
    request.derivation.policyId != policy.id ||
    request.derivation.policyVersion != policy.version ||
    state.allocationScheduleRevisions.any (fun revision =>
      revision.id == request.id || revision.originalScheduleId == original.id) ||
    !decide suppliedRecognitionIds.Nodup ||
    String.intercalate "\x00" suppliedRecognitionIds !=
      String.intercalate "\x00" (actualRecognitionIds.map (·.value)) ||
    (match original.installments.head? with
      | none => false
      | some first => decide (request.effectiveOn < first.accountingDate)) ||
    recognitions.any (fun recognition =>
      decide (request.effectiveOn ≤
        ((original.installments.find? (·.ordinal == recognition.ordinal)).map
          (·.accountingDate)).getD request.effectiveOn)) ||
    request.revisedResidualValue.isNegative ||
    (adjustmentRequired request.kind effectiveCarrying != exactAdjustmentAmount.isSome) ||
    (match exactAdjustmentAmount with | none => false | some adjustment => adjustment.isZero) ||
    (request.kind == .estimateChange &&
      (request.generatedEffectKey.isSome || exactAdjustmentAmount.isSome)) ||
    (request.kind == .impairment &&
      match exactAdjustmentAmount with
      | none => true
      | some adjustment => adjustment.compare ExactRational.zero != .lt) ||
    ((request.kind == .disposal || request.kind == .termination) &&
      match exactAdjustmentAmount with
      | none => false
      | some adjustment => !adjustment.equals effectiveCarrying.negate) ||
    totals.afterAdjustment.isNegative ||
    request.revisedResidualValue.compare totals.afterAdjustment == .gt ||
    (request.kind == .estimateChange &&
      request.revisedResidualValue.compare totals.afterAdjustment != .lt) ||
    (successorRequired request totals.afterAdjustment != request.successorScheduleId.isSome) ||
    (successorRequired request totals.afterAdjustment &&
      match request.revisedEndsOn with
      | none => true
      | some endsOn => decide (endsOn < request.effectiveOn)) ||
    (!successorRequired request totals.afterAdjustment &&
      (request.revisedEndsOn.isSome || request.revisedUsage.isSome))

/-- The test of line 1714: a prospective revision with an earlier installment that no recognition
covers. -/
def earlierUnrecognized (original : AllocationSchedule) (recognitions : List AllocationRecognition)
    (request : AllocationScheduleRevisionRequest) : Bool :=
  (request.kind == .estimateChange || request.kind == .impairment) &&
    original.installments.any (fun installment =>
      decide (installment.accountingDate < request.effectiveOn) &&
        !recognitions.any (·.ordinal == installment.ordinal))

/-- Lines 1717 to 1729: the successor schedule, made by `createAllocationSchedule` from the
carrying amount after the adjustment, or its rejection. -/
def revisionSuccessor (policies : List AccountingPolicy) (bookId : BookId) (policy : AllocationPolicy)
    (original : AllocationSchedule) (request : AllocationScheduleRevisionRequest)
    (totals : RevisionTotals) :
    Except ScheduleErr (AccountingCalculation ⊕ Option AllocationSchedule) :=
  if successorRequired request totals.afterAdjustment then
    match request.successorScheduleId, request.revisedEndsOn with
    | some successorId, some revisedEndsOn =>
      match createAllocationSchedule policies bookId
          { id := successorId, policyId := policy.id, policyVersion := policy.version,
            governedAt := request.policyEffectiveAt, source := original.source,
            sourcePostingId := original.sourcePostingId, sourceBasis := totals.afterAdjustment,
            residualValue := request.revisedResidualValue, startsOn := request.effectiveOn,
            endsOn := revisedEndsOn, usage := request.revisedUsage,
            derivation := request.derivation } with
      | .error e => .error e
      | .ok (.rejected diagnostics) => .ok (.inl (.rejected diagnostics))
      | .ok (.draft draft) =>
        match draft.effects.find? (fun effect => match effect with
            | .allocationSchedule _ => true | _ => false) with
        | some (.allocationSchedule successor) => .ok (.inr (some successor))
        | _ => .error .missingSuccessorEffect
    | _, _ => .error .missingSuccessorEffect
  else .ok (.inr none)

/-- Lines 1730 to 1740: the revision, with the hash of its body. -/
def revisionEffect (policy : AllocationPolicy) (original : AllocationSchedule)
    (request : AllocationScheduleRevisionRequest) (recognitions : List AllocationRecognition)
    (totals : RevisionTotals) (successor : Option AllocationSchedule)
    (bookedAdjustment : Option QuantizedValue) : AllocationScheduleRevision :=
  let body : AllocationScheduleRevision :=
    { id := request.id, kind := request.kind, effectiveOn := request.effectiveOn,
      generatedEffectKey := request.generatedEffectKey, originalScheduleId := original.id,
      priorRecognitionIds := sortRecognitionIds (recognitions.map (·.id)),
      recognizedToDate := totals.recognizedToDate,
      carryingAmountAtRevision := totals.carryingAmountAtRevision,
      postedRecognizedToDate := totals.postedRecognizedToDate,
      postedCarryingAmountAtRevision := totals.postedCarryingAmountAtRevision,
      revisedResidualValue := request.revisedResidualValue,
      exactAdjustmentAmount := request.exactAdjustmentAmount, bookedAdjustment := bookedAdjustment,
      successorScheduleId := successor.map (·.id), policy := policy, evidence := request.evidence,
      derivation := request.derivation, contentHash := default }
  { body with contentHash := accountingBodyHash "AllocationScheduleRevision" body }

/-- Lines 1744 to 1752: the journal of the adjustment. -/
def adjustmentJournal (policy : AllocationPolicy) (cumulative : Bool)
    (request : AllocationScheduleRevisionRequest) (commodityId : CommodityId)
    (adjustment : ExactRational) (journalId' : JournalId) (allocationId contraId : PostingId) :
    ExactPreparedJournal :=
  { requiredQuantizationPolicy := if cumulative then some policy.quantizationPolicy else none,
    id := journalId', kind := .adjustment, economicAt := request.policyEffectiveAt,
    accountingDate := request.effectiveOn, recordedAt := request.policyEffectiveAt,
    narration := "Allocation schedule " ++ request.kind.text,
    postings :=
      [{ id := allocationId, accountId := policy.allocationAccountId, units := adjustment.negate,
         unitsCommodityId := commodityId, exactBookValue := adjustment.negate, costBasis := none },
       { id := contraId, accountId := policy.contraAccountId, units := adjustment,
         unitsCommodityId := commodityId, exactBookValue := adjustment, costBasis := none }],
    derivations := [request.derivation] }

end Schedules

/-- `reviseAllocationSchedule` (`accounting.ts` line 1665). -/
def reviseAllocationSchedule (policies : List AccountingPolicy)
    (state : AllocationAccountingState) (bookId : BookId) (commodityId : CommodityId)
    (request : AllocationScheduleRevisionRequest) : Except ScheduleErr AccountingCalculation :=
  match state.allocationSchedules.find? (·.id == request.originalScheduleId),
      policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt with
  | some original, .selected policy =>
    let recognitions := state.allocationRecognitions.filter (·.scheduleId == original.id)
    let cumulative := usesCumulativeAllocation policy
    match Schedules.planGate policy original recognitions with
    | .error e => .error e
    | .ok false => .ok Schedules.revisionPostingPlanRejection
    | .ok true =>
      match Schedules.revisionTotals policy cumulative original recognitions
          request.exactAdjustmentAmount with
      | .error e => .error e
      | .ok totals =>
        if Schedules.revisionIncoherent policy bookId state original recognitions request totals then
          .ok Schedules.revisionCoherenceRejection
        else if Schedules.earlierUnrecognized original recognitions request then
          .ok Schedules.revisionPriorRecognitionsRejection
        else
          match Schedules.revisionSuccessor policies bookId policy original request totals with
          | .error e => .error e
          | .ok (.inl rejection) => .ok rejection
          | .ok (.inr successor) =>
            let bookedRes : Except ScheduleErr (Option QuantizedValue) :=
              match request.exactAdjustmentAmount with
              | none => .ok none
              | some adjustment =>
                match Schedules.liftQuantize (quantize adjustment policy.quantizationPolicy.rule) with
                | .error e => .error e
                | .ok quantized => .ok (some quantized)
            match bookedRes with
            | .error e => .error e
            | .ok bookedAdjustment =>
              let revision := Schedules.revisionEffect policy original request recognitions totals
                successor bookedAdjustment
              let effects : List AccountingEffect :=
                [.allocationScheduleRevision revision] ++
                  (match successor with
                    | none => []
                    | some schedule => [.allocationSchedule schedule])
              match request.exactAdjustmentAmount with
              | none => .ok (drafted [] effects)
              | some _ =>
                match Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with
                | .error e => .error e
                | .ok jid =>
                  match Schedules.liftCanonical
                      (postingId (request.id.value ++ "-allocation")) with
                  | .error e => .error e
                  | .ok pidAllocation =>
                    match Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with
                    | .error e => .error e
                    | .ok pidContra =>
                      .ok (drafted
                        [Schedules.adjustmentJournal policy cumulative request commodityId
                          (totals.appliedAdjustment.getD ExactRational.zero) jid pidAllocation
                          pidContra] effects)
  | _, _ => .ok Schedules.revisionMissingRejection

end Rastrata.Kernel

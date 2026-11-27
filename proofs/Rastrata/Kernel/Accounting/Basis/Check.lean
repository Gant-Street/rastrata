/-
The model run against the TypeScript. Every value below was built twice, once in Lean from the data
written here and once in TypeScript with the kernel's own functions (`createCanonicalPostingReference`,
`hashAccountingPolicySnapshot`, `hashAccountingReadPopulation`, `hashAccountingReadSnapshot`,
`projectAccountingBasis`, `hashAccountingPolicyArtifact`); the `#guard`s compare what the model computes
(digests, entries, totals, diagnostics) with what the TypeScript printed for the same data. A guard that
fails stops the build, so the model cannot drift from the TypeScript on these inputs.

Sample 1 is a policy with three rules (`recognizeAtAccountingDate`, `carryThrough`, `exclude`), two
journals given out of order, three events given out of order and an empty accounting state; it covers the
canonical value of every journal, book and basis type, the three hashes with their sorts, and the
projection. Sample 2 is a policy that allocates by the settlement ratio over a state with one open item,
one settlement and two allocations (one with `allocatedOpenItemBookValue`), and the rejections. The
audits at the end are an out-of-range scale (the TypeScript throws a `RangeError`), two journals sharing a
sequence, and the same journals in the other order (the projection echoes the order it was given).
-/
import Rastrata.Kernel.Accounting.Basis.Laws12

open Rastrata.Kernel

namespace Rastrata.Kernel.BasisCheck

def h (d : String) : ContentHash :=
  ⟨"sha256", "rastrata-canonical-v1", d ++ String.ofList (List.replicate (64 - d.length) '0')⟩
def usd : CommodityId := ⟨"USD"⟩
def book : BookId := ⟨"book-1"⟩
def dec (c s : Int) : ExactDecimal := ⟨c, s⟩
def rat (n d : Int) : ExactRational := ⟨n, d⟩

def j1p1 : Posting :=
  { id := ⟨"p1"⟩, ordinal := 1, accountId := ⟨"acc-1"⟩,
    units := { canonicalNumber := rat 2001 20, commodityId := usd, sourceNumber := some (dec 10005 2) },
    bookValue := { amount := dec 10005 2, functionalCommodityId := usd },
    transactionPrice := some { unitRate := rat 1 1, baseCommodityId := usd, quoteCommodityId := usd },
    costBasis := some { totalBasis := rat 2001 20, basisCommodityId := usd, sourceTotalBasis := some (dec 10005 2) },
    dimensionMemberIds := [⟨"m2"⟩, ⟨"m1"⟩] }
def j1p2 : Posting :=
  { id := ⟨"p2"⟩, ordinal := 2, accountId := ⟨"acc-2"⟩,
    units := { canonicalNumber := rat (-2001) 20, commodityId := usd, sourceNumber := none },
    bookValue := { amount := dec (-10005) 2, functionalCommodityId := usd },
    transactionPrice := none, costBasis := none, dimensionMemberIds := [] }
def j2p1 : Posting :=
  { id := ⟨"p1"⟩, ordinal := 1, accountId := ⟨"acc-1"⟩,
    units := { canonicalNumber := rat 50 1, commodityId := usd, sourceNumber := none },
    bookValue := { amount := dec 5000 2, functionalCommodityId := usd },
    transactionPrice := none, costBasis := none, dimensionMemberIds := [] }
def j2p2 : Posting :=
  { id := ⟨"p2"⟩, ordinal := 2, accountId := ⟨"acc-2"⟩,
    units := { canonicalNumber := rat (-50) 1, commodityId := usd, sourceNumber := none },
    bookValue := { amount := dec (-5000) 2, functionalCommodityId := usd },
    transactionPrice := none, costBasis := none, dimensionMemberIds := [] }

def J1 : JournalTransaction :=
  { id := ⟨"j1"⟩, kind := .ordinary, bookId := book, functionalCommodityId := usd,
    economicAt := ⟨"2026-01-15T00:00:00Z"⟩, accountingDate := ⟨"2026-01-15"⟩,
    settledAt := some ⟨"2026-01-16T00:00:00Z"⟩, recordedAt := ⟨"2026-01-15T00:00:01Z"⟩,
    narration := "narration", postings := [j1p2, j1p1] }
def J2 : JournalTransaction :=
  { id := ⟨"j2"⟩, kind := .ordinary, bookId := book, functionalCommodityId := usd,
    economicAt := ⟨"2026-01-15T00:00:00Z"⟩, accountingDate := ⟨"2026-01-15"⟩,
    settledAt := none, recordedAt := ⟨"2026-01-15T00:00:01Z"⟩,
    narration := "narration", postings := [j2p1, j2p2] }

def derivation : DerivationRecord :=
  { id := ⟨"d1"⟩, policyId := ⟨"pol-1"⟩, policyVersion := ⟨"1.0.0"⟩, algorithmVersion := ⟨"1.0.0"⟩,
    inputHash := h "b1", actorId := ⟨"actor-1"⟩, state := .approved,
    recordedAt := ⟨"2026-01-01T00:00:00Z"⟩,
    evidence := [{ id := ⟨"ev-1"⟩, sourceSystem := "sys", sourceRecordId := "rec", observedAt := ⟨"2026-01-01T00:00:00Z"⟩, contentHash := h "b2" }] }

def booked (journal : JournalTransaction) (command effect : String) (revision sequence : Int) :
    BookedJournal :=
  { journal, commandId := ⟨command⟩, effectKey := effect, bookRevision := revision,
    postingSequence := sequence, fiscalPeriodId := ⟨"fp-1"⟩, policySnapshotHash := h "a1",
    quantizationPolicySnapshotHash := h "a2",
    canonicalHash := hashCanonical (canonicalJournalValue journal), derivations := [derivation] }
def B1 : BookedJournal := booked J1 "cmd-1" "ek1" 3 1
def B2 : BookedJournal := booked J2 "cmd-2" "ek2" 5 2

def qp : QuantizationPolicy :=
  { id := ⟨"qp-1"⟩, version := ⟨"1.0.0"⟩, bookId := book, functionalCommodityId := usd,
    validFrom := ⟨"2026-01-01"⟩, validTo := none, targetScale := 1, roundingMode := .halfEven,
    roundingAccountId := ⟨"acc-r"⟩ }
def rule (id : String) (event : AccountingBasisEvent) (treatment : AccountingBasisTreatment) :
    AccountingBasisRule :=
  { id := ⟨id⟩, contentHash := h ("d" ++ id), event, treatment }
def basisPolicy : AccountingBasisPolicy :=
  { id := ⟨"pol-1"⟩, version := ⟨"1.0.0"⟩, bookId := book, validFrom := ⟨"2026-01-01T00:00:00Z"⟩,
    validTo := none, algorithmVersion := ⟨"1.0.0"⟩, quantizationPolicy := qp,
    capability := { feature := .accountingBasis, status := .supported, implementationVersion := ⟨"1.0.0"⟩, verificationEvidenceIds := [⟨"ev-1"⟩], admittedCombinations := [{ method := some "accrual", frequency := none, convention := none }] },
    basis := .accrual,
    rules := [rule "r-rec" .recognition .recognizeAtAccountingDate, rule "r-tax" .tax .carryThrough,
      rule "r-nc" .nonCash .exclude] }
def bookingPolicy : BookingPolicy :=
  { id := ⟨"bp-1"⟩, bookId := book, version := ⟨"1.0.0"⟩, validFrom := ⟨"2026-01-01T00:00:00Z"⟩,
    validTo := some ⟨"2027-01-01T00:00:00Z"⟩, lotSelection := .fifo, scope := .account,
    scopeKey := "k", requiredDimensionIds := [⟨"dim-1"⟩], implementationVersion := ⟨"1.0.0"⟩,
    capability := { id := ⟨"cap-1"⟩, method := .fifo, scope := .account, status := .supported, implementationVersion := ⟨"1.0.0"⟩, verificationEvidenceIds := [⟨"ev-1"⟩] } }
def acc1 : AccountSnapshot := { id := ⟨"acc-1"⟩, bookId := book, code := "1000", name := "Cash", role := .asset, normalSide := .debit, postingAllowed := true, openedOn := ⟨"2026-01-01"⟩, closedOn := none, parentId := none, allowedCommodityIds := [usd] }
def acc2 : AccountSnapshot := { id := ⟨"acc-2"⟩, bookId := book, code := "2000", name := "Debt", role := .unrealizedGain, normalSide := .credit, postingAllowed := false, openedOn := ⟨"2026-01-01"⟩, closedOn := some ⟨"2026-12-31"⟩, parentId := some ⟨"acc-1"⟩, allowedCommodityIds := [] }
def dim1 : AccountingDimensionSnapshot := { id := ⟨"dim-1"⟩, bookId := book, code := "D", name := "Dim", openedOn := ⟨"2026-01-01"⟩, closedOn := some ⟨"2026-06-30"⟩ }
def mem1 : DimensionMemberSnapshot := { id := ⟨"m1"⟩, dimensionId := ⟨"dim-1"⟩, code := "M1", name := "Member 1", openedOn := ⟨"2026-01-01"⟩, closedOn := some ⟨"2026-06-30"⟩, parentId := some ⟨"m0"⟩ }
def admission : JournalAdmissionSnapshot := { bookId := book, functionalCommodityId := usd, accounts := [acc1, acc2], dimensions := [dim1], dimensionMembers := [mem1], requiredDimensionIds := [⟨"dim-1"⟩], requiredDimensionIdsByPosting := some [("p2", []), ("p1", [⟨"dim-1"⟩])] }
def period1 : FiscalPeriod := { id := ⟨"fp-1"⟩, calendarId := ⟨"cal-1"⟩, fiscalYear := 2026, sequence := 1, label := "Jan", kind := .regular, startsOn := ⟨"2026-01-01"⟩, endsOn := ⟨"2026-01-31"⟩ }
def configFor (policy : AccountingBasisPolicy) : BookConfigurationSnapshot :=
  { revision := 1, effectiveAt := ⟨"2026-01-01T00:00:00Z"⟩,
    executionProfile := some .structuralSourceIdentityV1, stateCommitmentProfile := none,
    periods := [period1], admissionSnapshot := admission, policies := [bookingPolicy],
    quantizationPolicies := [policy.quantizationPolicy],
    accountingPolicySnapshot :=
      { policies := [.accountingBasis policy],
        contentHash := hashAccountingPolicySnapshot [.accountingBasis policy] },
    contentHash := h "c2" }

def ref (id : String) (j : JournalTransaction) (p : Posting) (effect : String) :
    CanonicalPostingReference :=
  createCanonicalPostingReference ⟨id⟩ book j.id p ⟨effect⟩
def evB : BasisSourceEvent :=
  { id := "e-b", event := .recognition, accountingDate := J1.accountingDate,
    source := ref "ref-b" J1 j1p1 "ek1", sourcePosting := j1p1, openItemId := some ⟨"oi-1"⟩,
    settlementId := some ⟨"st-1"⟩, settlementAllocationIds := some [⟨"sa-2"⟩, ⟨"sa-1"⟩] }
def evA : BasisSourceEvent :=
  { id := "e-a", event := .nonCash, accountingDate := J1.accountingDate,
    source := ref "ref-a" J1 j1p2 "ek1", sourcePosting := j1p2, openItemId := none,
    settlementId := none, settlementAllocationIds := none }
def evC : BasisSourceEvent :=
  { id := "e-c", event := .tax, accountingDate := J2.accountingDate,
    source := ref "ref-c" J2 j2p1 "ek2", sourcePosting := j2p1, openItemId := none,
    settlementId := none, settlementAllocationIds := none }
def events : List BasisSourceEvent := [evB, evC, evA]
/-- The read snapshot of the three events over these journals, built as `createAccountingReadSnapshot`
builds it. -/
def mkSnapshot (policy : AccountingBasisPolicy) (journals : List BookedJournal) :
    AccountingReadSnapshot :=
  let population : AccountingReadPopulation :=
    { throughBookRevision := 5, throughPostingSequence := 2,
      policyEffectiveAt := ⟨"2026-02-01T00:00:00Z"⟩, bookStateHash := h "bs",
      sourcePopulationHash := hashAccountingBasisSourcePopulation events,
      configurationSnapshot := configFor policy, journals,
      accountingState := emptyAccountingCanonicalState,
      sourcePostingPopulation := [evC.source, evA.source, evB.source], sourceEvents := events }
  let body : AccountingReadSnapshotBody :=
    { toAccountingReadPopulation := population,
      reportPopulationHash := hashAccountingReadPopulation population }
  { toAccountingReadSnapshotBody := body, contentHash := hashAccountingReadSnapshot body }

def snapshot : AccountingReadSnapshot := mkSnapshot basisPolicy [B2, B1]

/-! ## Sample 2: the settlement ratio and the rejections -/
def j3p1 : Posting := { id := ⟨"p1"⟩, ordinal := 1, accountId := ⟨"acc-1"⟩, units := { canonicalNumber := rat 100 1, commodityId := usd, sourceNumber := none }, bookValue := { amount := dec 10000 2, functionalCommodityId := usd }, transactionPrice := none, costBasis := none, dimensionMemberIds := [] }
def j3p2 : Posting := { id := ⟨"p2"⟩, ordinal := 2, accountId := ⟨"acc-2"⟩, units := { canonicalNumber := rat (-100) 1, commodityId := usd, sourceNumber := none }, bookValue := { amount := dec (-10000) 2, functionalCommodityId := usd }, transactionPrice := none, costBasis := none, dimensionMemberIds := [] }
def J3 : JournalTransaction := { id := ⟨"j3"⟩, kind := .ordinary, bookId := book, functionalCommodityId := usd, economicAt := ⟨"2026-01-15T00:00:00Z"⟩, accountingDate := ⟨"2026-01-15"⟩, settledAt := none, recordedAt := ⟨"2026-01-15T00:00:01Z"⟩, narration := "narration", postings := [j3p1, j3p2] }
def B3 : BookedJournal := booked J3 "cmd-3" "ek3" 3 1
def qp2 : QuantizationPolicy := { id := ⟨"qp-1"⟩, version := ⟨"1.0.0"⟩, bookId := book, functionalCommodityId := usd, validFrom := ⟨"2026-01-01"⟩, validTo := none, targetScale := 2, roundingMode := .halfAwayFromZero, roundingAccountId := ⟨"acc-r"⟩ }
def policy2 : AccountingBasisPolicy := { id := ⟨"pol-2"⟩, version := ⟨"1.0.0"⟩, bookId := book, validFrom := ⟨"2026-01-01T00:00:00Z"⟩, validTo := none, algorithmVersion := ⟨"1.0.0"⟩, quantizationPolicy := qp2, capability := { feature := .accountingBasis, status := .supported, implementationVersion := ⟨"1.0.0"⟩, verificationEvidenceIds := [⟨"ev-1"⟩], admittedCombinations := [{ method := some "cash", frequency := none, convention := none }] }, basis := .cash, rules := [rule "r-rec" .recognition .allocateBySettlementRatio] }
def admission2 : JournalAdmissionSnapshot := { bookId := book, functionalCommodityId := usd, accounts := [], dimensions := [], dimensionMembers := [], requiredDimensionIds := [], requiredDimensionIdsByPosting := none }
def config2 : BookConfigurationSnapshot := { revision := 1, effectiveAt := ⟨"2026-01-01T00:00:00Z"⟩, executionProfile := none, stateCommitmentProfile := none, periods := [], admissionSnapshot := admission2, policies := [], quantizationPolicies := [qp2], accountingPolicySnapshot := { policies := [.accountingBasis policy2], contentHash := hashAccountingPolicySnapshot [.accountingBasis policy2] }, contentHash := h "c3" }
def ref3 (id : String) (p : Posting) : CanonicalPostingReference := createCanonicalPostingReference ⟨id⟩ book J3.id p ⟨"ek3"⟩
def scope1 : SettlementScope := { externalPartyId := "cust", controlAccountId := ⟨"acc-1"⟩ }
def mkOpenItem (body : OpenItemBody) : OpenItem := let o : OpenItem := { toOpenItemBody := body, contentHash := default }; { o with contentHash := accountingBodyHash "OpenItem" o }
def mkSettlement (body : SettlementBody) : Settlement := let o : Settlement := { toSettlementBody := body, contentHash := default }; { o with contentHash := accountingBodyHash "Settlement" o }
def mkAllocation (body : SettlementAllocationBody) : SettlementAllocation := let o : SettlementAllocation := { toSettlementAllocationBody := body, contentHash := default }; { o with contentHash := accountingBodyHash "SettlementAllocation" o }
def OI : OpenItem := mkOpenItem { id := ⟨"oi-1"⟩, bookId := book, kind := .receivable, scope := scope1, recognitionSource := some (ref3 "ref-oi" j3p1), recognitionPostingId := none, recognizedOn := ⟨"2026-01-15"⟩, denominationCommodityId := usd, denomination := rat 100 1, bookValue := rat (-100) 1, derivation := derivation }
def STL : Settlement := mkSettlement { id := ⟨"st-1"⟩, bookId := book, kind := .cash, scope := scope1, settlementSource := none, settlementPostingId := none, settledAt := ⟨"2026-01-20T00:00:00Z"⟩, denominationCommodityId := usd, denomination := rat 60 1, bookValue := rat 60 1, derivation := derivation }
def AL1 : SettlementAllocation := mkAllocation { id := ⟨"alloc-1"⟩, openItemId := ⟨"oi-1"⟩, settlementId := ⟨"st-1"⟩, appliedAt := none, allocatedBookValue := rat 50 1, allocatedOpenQuantity := rat 50 1, allocatedSettlementQuantity := rat 50 1, allocatedOpenItemBookValue := none, allocatedSettlementBookValue := none, settlementMeasurement := none, realizedExchangeDifference := none, valuationPath := none, realizedExchangeEffectKey := none, derivation := derivation }
def AL2 : SettlementAllocation := mkAllocation { id := ⟨"alloc-2"⟩, openItemId := ⟨"oi-1"⟩, settlementId := ⟨"st-1"⟩, appliedAt := none, allocatedBookValue := rat 5 1, allocatedOpenQuantity := rat 10 1, allocatedSettlementQuantity := rat 10 1, allocatedOpenItemBookValue := some (rat 10 1), allocatedSettlementBookValue := none, settlementMeasurement := none, realizedExchangeDifference := none, valuationPath := none, realizedExchangeEffectKey := none, derivation := derivation }
def state2 : AccountingCanonicalState := { emptyAccountingCanonicalState with openItems := [OI], settlements := [STL], settlementAllocations := [AL1, AL2] }
def ref3' (id : String) (j : JournalTransaction) (p : Posting) : CanonicalPostingReference := createCanonicalPostingReference ⟨id⟩ book j.id p ⟨"ek3"⟩
def ev : BasisSourceEvent := { id := "ev-ratio", event := .recognition, accountingDate := J3.accountingDate, source := ref3 "ref-ev" j3p2, sourcePosting := j3p2, openItemId := some ⟨"oi-1"⟩, settlementId := none, settlementAllocationIds := some [⟨"alloc-2"⟩, ⟨"alloc-1"⟩] }
def build (events : List BasisSourceEvent) (population : List CanonicalPostingReference) (over : AccountingReadPopulation → AccountingReadPopulation := id) : AccountingReadSnapshot :=
  let body0 : AccountingReadPopulation := { throughBookRevision := 3, throughPostingSequence := 1, policyEffectiveAt := ⟨"2026-02-01T00:00:00Z"⟩, bookStateHash := h "bs", sourcePopulationHash := hashAccountingBasisSourcePopulation events, configurationSnapshot := config2, journals := [B3], accountingState := state2, sourcePostingPopulation := population, sourceEvents := events }
  let body := over body0
  let sb : AccountingReadSnapshotBody := { toAccountingReadPopulation := body, reportPopulationHash := hashAccountingReadPopulation body }
  { toAccountingReadSnapshotBody := sb, contentHash := hashAccountingReadSnapshot sb }
def r2 (x : ExactRational) : String := s!"{x.numerator}/{x.denominator}"
def show2 (label : String) : Except QuantizeErr BasisProjectionResult → String
  | .error e => s!"{label}: error {repr e}"
  | .ok (.rejected ds) => s!"{label}: rejected " ++ " ; ".intercalate (ds.map fun d => s!"{d.path} :: {d.message.take 40} :: {",".intercalate d.requirementIds}")
  | .ok (.projected pr) => s!"{label}: projected " ++ " ".intercalate (pr.entries.map fun e => s!"[{e.sourceId} {e.treatment.text} inc={r2 e.includedExactAmount} exc={r2 e.excludedExactAmount} rec={match e.recognizedAmount with | none => "none" | some q => s!"{q.amount.coefficient}e{q.amount.scale} res={r2 q.residual}"} ids={"|".intercalate (e.settlementAllocationIds.map (·.value))}]") ++ s!" rc={r2 pr.reconciliation.sourceExactTotal} {r2 pr.reconciliation.includedExactTotal} {r2 pr.reconciliation.excludedExactTotal} {r2 pr.reconciliation.projectedBookValueTotal} {r2 pr.reconciliation.quantizationResidualTotal} hash={pr.contentHash.digest}"
def run2 (label : String) (snapshot : AccountingReadSnapshot) : String :=
  show2 label (projectAccountingBasis [.accountingBasis policy2] policy2.id policy2.version snapshot)
def badPosting : Posting := { j3p2 with bookValue := { j3p2.bookValue with functionalCommodityId := ⟨"EUR"⟩ } }
def badJournal : JournalTransaction := { J3 with postings := [j3p1, badPosting] }
def badBooked : BookedJournal := booked badJournal "cmd-3" "ek3" 3 1
def badEv : BasisSourceEvent := { ev with source := ref3' "ref-ev" badJournal badPosting, sourcePosting := badPosting }

/-! ## Sample 1: the hashes and the projection -/

#guard (hashAccountingPolicySnapshot [.accountingBasis basisPolicy]).digest ==
  "573bee8e546c2e45908e62e6228e5553061b20a1f2fde5242b3f3481df47a0d9"
#guard B1.canonicalHash.digest == "5810eb4ca875970f466fbb0feb204e1c8cdb130112e70613083aeab6621dc942"
#guard B2.canonicalHash.digest == "c2eb3ac0de631afd3c37f16948d49a3d3233728583d158a01e84bd3d0c78b7c1"
#guard evB.source.postingContentHash.digest ==
  "b628bd8fb71a8879fd13d8c592722b75865124f5229ccca2f896941ca942c678"
#guard evB.source.contentHash.digest ==
  "73f0b840cc97ae7ac85617e6de990f490f2a43f73f4e67ba7a75c25117ac7296"
#guard evA.source.contentHash.digest ==
  "1f8c53aacfad57fa4666b8257d89efb4abb9c6db78c34394de2a7701b40cd356"
#guard evC.source.contentHash.digest ==
  "9d73d890715e2f35399ee9484a6c686ea578eb4dffc7e7417aced6e5d1557648"
#guard snapshot.sourcePopulationHash.digest ==
  "c3810a635f8478cae6d3f17aa07add1c704f373c70a6797b4938c25f4d33a8a4"
#guard snapshot.reportPopulationHash.digest ==
  "606f6c300611491bc8c0a7692404111472c7b4e9897ee63f29f8b7acd428b69c"
#guard snapshot.contentHash.digest ==
  "f0849e5e94acdee039c877388edff87fb63ae5fe87b3d1dbbb2306bb7f030120"
#guard (hashCanonical (canonicalize (configFor basisPolicy))).digest ==
  "ecc161144d74d195aaf8cdf40255ac6d7ca3c6d5bb9ff1df014de1cbf4ed2fcd"
#guard (hashCanonical (canonicalize J1)).digest ==
  "f6546905f9003f10b1f52e767eb1401f86c0da0becf94f4771882b2ade6e8243"
#guard (hashCanonical (canonicalize B1)).digest ==
  "10142aedb43bc2a4835fe551d2fcd72da1f3e6520ae4547df78acd95d505391e"
#guard (hashCanonical (canonicalize evB)).digest ==
  "969330b879c7f309b0aa456d2329f58b21a58af349d299522d4d10c9e3835cf0"

def showRat (x : ExactRational) : String := s!"{x.numerator}/{x.denominator}"

def entryLine (e : AccountingBasisProjectionEntry) : String :=
  s!"entry {e.ordinal} = {e.sourceId} {e.treatment.text} inc={showRat e.includedExactAmount} exc={showRat e.excludedExactAmount} rec={match e.recognizedAmount with | none => "none" | some q => s!"{q.amount.coefficient}e{q.amount.scale} res={showRat q.residual}"} ids=[{",".intercalate (e.settlementAllocationIds.map (·.value))}] amount={showRat e.amount}"

def project1 (s : AccountingReadSnapshot) :=
  projectAccountingBasis [.accountingBasis basisPolicy] basisPolicy.id basisPolicy.version s

#guard (match project1 snapshot with
  | .ok (.projected p) => p.entries.map entryLine ==
      ["entry 1 = e-a exclude inc=0/1 exc=-2001/20 rec=none ids=[] amount=0/1",
       "entry 2 = e-b recognizeAtAccountingDate inc=2001/20 exc=0/1 rec=1000e1 res=1/20 ids=[sa-1,sa-2] amount=2001/20",
       "entry 3 = e-c carryThrough inc=50/1 exc=0/1 rec=500e1 res=0/1 ids=[] amount=50/1"]
  | _ => false)
#guard (match project1 snapshot with
  | .ok (.projected p) =>
    [p.reconciliation.sourceExactTotal, p.reconciliation.includedExactTotal,
        p.reconciliation.excludedExactTotal, p.reconciliation.projectedExactTotal,
        p.reconciliation.projectedBookValueTotal, p.reconciliation.quantizationResidualTotal].map
        showRat == ["50/1", "3001/20", "-2001/20", "3001/20", "150/1", "1/20"] &&
      p.reconciliation.contentHash.digest ==
        "e76aa8c009467374d9ac13db99a9db582b3bfc20c0dec8a168eff38fba47cfee" &&
      p.sourceSnapshot.contentHash.digest ==
        "f0849e5e94acdee039c877388edff87fb63ae5fe87b3d1dbbb2306bb7f030120" &&
      p.sourceSnapshot.sourceEvents.map (·.id) == ["e-a", "e-b", "e-c"] &&
      p.sourceSnapshot.journals.map (·.journal.id.value) == ["j2", "j1"] &&
      p.contentHash.digest == "efb5856c79fc8a92a04f1a3af5ac379da358bcf354e2245f057548ac89f5b071"
  | _ => false)

/-! ## Sample 2: the settlement ratio and the rejections -/

#guard run2 "ratio" (build [ev] [ev.source]) ==
  "ratio: projected [ev-ratio allocateBySettlementRatio inc=-60/1 exc=-40/1 rec=-6000e2 res=0/1 ids=alloc-1|alloc-2] rc=-100/1 -60/1 -40/1 -60/1 0/1 hash=3ab0437a77b34a4fb2d210d9ff500e5662a2bcb219739f1002ca4f88f46274a2"
#guard run2 "ratio-no-ids" (build [{ ev with settlementAllocationIds := none }] [ev.source]) ==
  "ratio-no-ids: rejected projection.events :: Settlement-ratio treatment requires the  :: ACC-042.2,ACC-042.3,ACC-042.5"
#guard run2 "ratio-wrong-ids"
    (build [{ ev with settlementAllocationIds := some [⟨"alloc-1"⟩] }] [ev.source]) ==
  "ratio-wrong-ids: rejected projection.events :: Settlement-ratio treatment requires the  :: ACC-042.2,ACC-042.3,ACC-042.5"
#guard run2 "ratio-no-openitem" (build [{ ev with openItemId := none }] [ev.source]) ==
  "ratio-no-openitem: rejected projection.events :: Settlement-ratio treatment requires the  :: ACC-042.2,ACC-042.3,ACC-042.5"
#guard run2 "ratio-unknown-openitem"
    (build [{ ev with openItemId := some ⟨"oi-9"⟩ }] [ev.source]) ==
  "ratio-unknown-openitem: rejected projection.events :: Settlement-ratio treatment requires the  :: ACC-042.2,ACC-042.3,ACC-042.5"
#guard run2 "dup-ids" (build [ev, ev] [ev.source, ev.source]) ==
  "dup-ids: rejected projection.population :: Basis projection requires one complete p :: ACC-042.1,ACC-042.4,ACC-042.5"
#guard run2 "blank-id" (build [{ ev with id := "  " }] [ev.source]) ==
  "blank-id: rejected projection.population :: Basis projection requires one complete p :: ACC-042.1,ACC-042.4,ACC-042.5"
#guard run2 "dup-alloc-ids"
    (build [{ ev with settlementAllocationIds := some [⟨"alloc-1"⟩, ⟨"alloc-1"⟩] }] [ev.source]) ==
  "dup-alloc-ids: rejected projection.population :: Basis projection requires one complete p :: ACC-042.1,ACC-042.4,ACC-042.5"
#guard run2 "tampered-hash" { build [ev] [ev.source] with contentHash := h "zz" } ==
  "tampered-hash: rejected projection.readSnapshot :: Accounting-basis projection requires a c :: ACC-042.1,ACC-042.2,ACC-042.4"
#guard run2 "bad-state-hash"
    (build [ev] [ev.source] fun b =>
      { b with accountingState := { state2 with openItems := [{ OI with contentHash := h "zz" }] } }) ==
  "bad-state-hash: rejected projection.readSnapshot :: Accounting-basis projection requires a c :: ACC-042.1,ACC-042.2,ACC-042.4"
#guard show2 "no-policy"
    (projectAccountingBasis [.accountingBasis policy2] ⟨"nope"⟩ policy2.version
      (build [ev] [ev.source])) ==
  "no-policy: rejected projection.policy :: Complete basis policy is required :: ACC-042.3"
#guard show2 "wrong-version"
    (projectAccountingBasis [.accountingBasis policy2] policy2.id ⟨"2.0.0"⟩
      (build [ev] [ev.source])) ==
  "wrong-version: rejected projection.policy :: Complete basis policy is required :: ACC-042.3"
#guard run2 "commodity-mismatch"
    (build [badEv] [badEv.source] fun b => { b with journals := [badBooked] }) ==
  "commodity-mismatch: rejected projection.events[ev-ratio] :: Every source event must close over its e :: ACC-042.1,ACC-042.2"
#guard run2 "unknown-rule" (build [{ ev with event := .tax }] [ev.source]) ==
  "unknown-rule: rejected projection.events :: Every source event must resolve exactly  :: ACC-042.2,ACC-042.3"
#guard run2 "ratio-seq-off" (build [ev] [ev.source] fun b => { b with throughPostingSequence := 2 }) ==
  "ratio-seq-off: rejected projection.readSnapshot :: Accounting-basis projection requires a c :: ACC-042.1,ACC-042.2,ACC-042.4"

/-! ## Audits -/

/-- A rounding scale of 2000: the TypeScript throws `RangeError: Quantization scale must be between 0 and
1000` from `projectAccountingBasis` (it is not a rejection); the model is `.error .scaleOutOfRange`. -/
def basisPolicyBadScale : AccountingBasisPolicy :=
  { basisPolicy with quantizationPolicy := { qp with targetScale := 2000 } }

#guard (projectAccountingBasis [.accountingBasis basisPolicyBadScale] basisPolicyBadScale.id
  basisPolicyBadScale.version (mkSnapshot basisPolicyBadScale [B2, B1])) == .error .scaleOutOfRange

/-- Two journals with the sequence 1: both the TypeScript and the model refuse the snapshot. -/
def B2tie : BookedJournal := booked J2 "cmd-2" "ek2" 5 1

#guard (match project1 (mkSnapshot basisPolicy [B2tie, B1]) with
  | .ok (.rejected ds) => ds == [basisSnapshotDiagnostic]
  | _ => false)

/- The journals in the other order: the same entries, totals and source snapshot hash, the journals
echoed as they came, and another hash for the projection (the TypeScript printed
`a6033e191582a793b927d24f4ac353a3906aa184ed8a183fe29bf80de1149bd4`). -/
#guard (match project1 (mkSnapshot basisPolicy [B1, B2]) with
  | .ok (.projected p) =>
    p.sourceSnapshot.contentHash.digest ==
        "f0849e5e94acdee039c877388edff87fb63ae5fe87b3d1dbbb2306bb7f030120" &&
      p.sourceSnapshot.journals.map (·.journal.id.value) == ["j1", "j2"] &&
      p.contentHash.digest == "a6033e191582a793b927d24f4ac353a3906aa184ed8a183fe29bf80de1149bd4"
  | _ => false)

end Rastrata.Kernel.BasisCheck

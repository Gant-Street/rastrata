/-
The model of `canonicalize` and of the hashes of `accounting.ts`, run on values built by hand and
compared with the TypeScript. Each digest below is what the TypeScript printed for the same value
under Bun (`canonicalAccountingValue`, `hashAccountingPolicy`, `hashAccountingPolicyArtifact`,
`verifyAccountingPolicyArtifacts`, `hashAccountingPolicySnapshot`, `planAllocationPostings`,
`validateAccountingEffectHash`, `canonicalAccountingStateValue`); a `#guard` fails the build if the
model ever computes another.
-/
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel.CoreExamples

/-- `hashCanonical({ a: "x" })`, a content hash to put in the values below. -/
def someHash : ContentHash := hashCanonical (.record [("a", .string "x")])

/-- A quantization policy at scale 2, half even, without `validTo`. -/
def quantizationPolicy : QuantizationPolicy :=
  { id := ⟨"q1"⟩, version := ⟨"1.0.0"⟩, bookId := ⟨"b1"⟩, functionalCommodityId := ⟨"USD"⟩,
    validFrom := ⟨"2024-01-01"⟩, validTo := none, targetScale := 2, roundingMode := .halfEven,
    roundingAccountId := ⟨"rnd"⟩ }

/-- A capability with two admitted combinations, one of which leaves `method` out. -/
def capability : AccountingCapability :=
  { feature := .inventoryCost, status := .supported, implementationVersion := ⟨"1.0.0"⟩,
    verificationEvidenceIds := [⟨"e1"⟩],
    admittedCombinations := [{ method := some "fifo", frequency := none, convention := none },
      { method := none, frequency := some "monthly", convention := none }] }

/-- A pool whose content hash is the hash of its body. -/
def pool : InventoryPool :=
  let body : InventoryPool := { id := ⟨"pool1"⟩, contentHash := default, accountId := ⟨"inv"⟩ }
  { body with contentHash := accountingBodyHash "InventoryPool" body }

/-- An inventory cost policy without `validTo` and with a rational rate. -/
def policy : InventoryCostPolicy :=
  { id := ⟨"p1"⟩, version := ⟨"1.0.0"⟩, bookId := ⟨"b1"⟩, validFrom := ⟨"2024-01-01T00:00:00Z"⟩,
    validTo := none, algorithmVersion := ⟨"1.0.0"⟩, quantizationPolicy := quantizationPolicy,
    capability := capability, method := .fifo, pools := [pool], shortageTreatment := .reject,
    provisionalBasisMethod := none, provisionalRate := some ⟨1, 3⟩ }

/-- The same policy under another identifier, its pool carrying a hash that is not its body's. -/
def badPolicy : InventoryCostPolicy :=
  { policy with id := ⟨"p0"⟩, pools := [{ pool with contentHash := someHash }] }

/-- An instalment of a schedule. -/
def installment (ordinal : Int) (date : String) (numerator denominator : Int) :
    ScheduledAllocation :=
  { ordinal, accountingDate := ⟨date⟩, amount := ⟨numerator, denominator⟩ }

/-- The content hash and the posted coefficients of a plan, or what was returned instead. -/
def planSummary : Except QuantizeErr AllocationPostingPlanResult → String
  | .ok (.planned plan) =>
    plan.contentHash.digest ++ " " ++ toString (plan.installments.map (·.postedAmount.coefficient))
  | .ok (.rejected _) => "rejected"
  | .error _ => "error"

/-- A derivation with one item of evidence. -/
def derivation : DerivationRecord where
  id := ⟨"d"⟩
  policyId := ⟨"p"⟩
  policyVersion := ⟨"1.0.0"⟩
  algorithmVersion := ⟨"1.0.0"⟩
  inputHash := someHash
  actorId := ⟨"a"⟩
  state := .approved
  recordedAt := ⟨"2024-01-01T00:00:00Z"⟩
  evidence := [⟨⟨"e1"⟩, "s", "r", ⟨"2024-01-01T00:00:00Z"⟩, someHash⟩]

/-- A remeasurement reversal whose content hash is the hash of its body. -/
def reversal : RemeasurementReversal :=
  let body : RemeasurementReversal :=
    { id := ⟨"r1"⟩, originalResultId := ⟨"rr"⟩, originalJournalId := none,
      originalEffectKey := none, reversedOn := ⟨"2024-01-01"⟩, derivation, contentHash := default }
  { body with contentHash := accountingBodyHash "RemeasurementReversal" body }

#guard pool.contentHash.digest ==
  "dbde3f8286aae1c894f5e42b3aff7281ef52e53ac69c00ef45937d5a884048fc"
#guard (hashAccountingPolicy (.inventoryCost policy)).digest ==
  "a6eb2e85df5f61a3177e6d1af5bace6568acddec3e5975755b29e5a1365193af"
#guard verifyAccountingPolicyArtifacts [.inventoryCost policy]
#guard !verifyAccountingPolicyArtifacts [.inventoryCost badPolicy]
#guard (hashAccountingPolicySnapshot [.inventoryCost policy, .inventoryCost badPolicy]).digest ==
  "54936e50f49765ebce11d8a3c2d1aed33100c057d1a7ac7f27632f48acd45ed6"
#guard planSummary (planAllocationPostings
    { exactSourceBasis := ⟨100, 1⟩, exactResidualValue := ⟨10, 1⟩,
      postedSourceBasis := ⟨10000, 2⟩, quantizationPolicy := quantizationPolicy,
      installments := [installment 1 "2024-01-31" 30 1, installment 2 "2024-02-29" 30 1,
        installment 3 "2024-03-31" 30 1] }) ==
  "5f8288a5f08233bb7c43a32945c8391f267107a47aaaa2beb2e2c1342ce1f51d [3000, 3000, 3000]"
#guard planSummary (planAllocationPostings
    { exactSourceBasis := ⟨100, 1⟩, exactResidualValue := ⟨1, 3⟩,
      postedSourceBasis := ⟨10000, 2⟩, quantizationPolicy := quantizationPolicy,
      installments := [installment 1 "2024-01-31" 299 9, installment 2 "2024-02-29" 299 9,
        installment 3 "2024-03-31" 299 9] }) ==
  "31a975a357fa29fbb9229d7c1011d852fc52b00b9ddd9237378e76cb70a352d4 [3322, 3323, 3322]"
#guard reversal.contentHash.digest ==
  "6e55f8546252039c95a61755f08c6b8b27fbcea0efa7195335e882707bdc4053"
#guard validateAccountingEffectHash (.remeasurementReversal reversal) == .ok true
#guard (hashCanonical (canonicalAccountingStateValue emptyAccountingCanonicalState)).digest ==
  "cf4a534e94c7418e77a69553fe0563025a2304dadea87805b1716e9e723c3e27"

end Rastrata.Kernel.CoreExamples

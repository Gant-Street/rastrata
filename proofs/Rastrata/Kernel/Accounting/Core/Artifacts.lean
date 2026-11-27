/-
Laws of the artifact checks of `accounting.ts` (law 2 of the brief of `Accounting/Core.lean`):
`artifactHashValidDigest`, `artifactHashValid`, `verifyAccountingPolicyArtifacts` and
`createAccountingPolicySnapshot`.

- An artifact passes exactly when its `contentHash` is the hash of its body under the type name
  (`artifactHashValid_iff`), which is `hashAccountingPolicyArtifact` of the body.
- `verifyAccountingPolicyArtifacts` accepts exactly when every artifact nested in every policy
  passes (`verifyAccountingPolicyArtifacts_iff`); each of the six kinds of artifact that fails
  makes it fail (one theorem each); the three kinds of policy with no artifacts never make it fail.
- Two artifacts of a kind that both pass and carry the same content hash are the same artifact, or
  a collision of SHA-256 is in hand (`T.eq_of_artifactHashValid`).
- `createAccountingPolicySnapshot` returns the policies with their snapshot hash exactly when they
  verify, and otherwise throws its one `TypeError`.
-/
import Rastrata.Kernel.Accounting.Core.Hashes

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

/-- `artifactHashValidDigest` accepts exactly when the carried hash is the recomputed one. -/
theorem artifactHashValidDigest_iff (type : String) (body : CanonicalValue) (hash : ContentHash) :
    artifactHashValidDigest type body hash = true ↔ hash = artifactHashDigest type body := by
  unfold artifactHashValidDigest
  rw [ContentHash.ext_iff]
  simp only [Bool.and_eq_true, beq_iff_eq]
  constructor
  · rintro ⟨⟨h1, h2⟩, h3⟩
    exact ⟨h1.symm, h2.symm, h3.symm⟩
  · rintro ⟨h1, h2, h3⟩
    exact ⟨⟨h1.symm, h2.symm⟩, h3.symm⟩

/-- `artifactHashValid` accepts exactly when the artifact's content hash is the hash of its body
(everything but the content hash) under the type name. -/
theorem artifactHashValid_iff {α : Type} [CanonicalObject α] [HasContentHash α] (type : String)
    (artifact : α) :
    artifactHashValid type artifact = true ↔
      HasContentHash.contentHash artifact = accountingBodyHash type artifact :=
  artifactHashValidDigest_iff _ _ _

/-- The hash an artifact must carry is `hashAccountingPolicyArtifact` of its body. -/
theorem accountingBodyHash_eq_hashAccountingPolicyArtifact {α : Type} [CanonicalObject α]
    (type : String) (artifact : α) :
    accountingBodyHash type artifact = hashAccountingPolicyArtifact type (bodyValue artifact) :=
  rfl

/-- An inventory pool passes exactly when its content hash is the hash of its body. -/
theorem InventoryPool.artifactHashValid_iff (type : String) (artifact : InventoryPool) :
    artifactHashValid type artifact = true ↔
      artifact.contentHash = accountingBodyHash type artifact :=
  Rastrata.Kernel.artifactHashValid_iff type artifact

/-- Two values of an inventory pool that both pass under the same type name and carry the same content hash
are the same, or a collision of SHA-256 is in hand. -/
theorem InventoryPool.eq_of_artifactHashValid {type : String} {a b : InventoryPool}
    (ha : artifactHashValid type a = true) (hb : artifactHashValid type b = true)
    (h : a.contentHash = b.contentHash) : a = b ∨ HashCollision := by
  rw [InventoryPool.artifactHashValid_iff] at ha hb
  rcases InventoryPool.accountingBodyHash_inj_or_collision (ha.symm.trans (h.trans hb)) with hab | hc
  · left
    rw [← h] at hab
    exact hab
  · exact Or.inr hc

/-- A basis rule passes exactly when its content hash is the hash of its body. -/
theorem AccountingBasisRule.artifactHashValid_iff (type : String) (artifact : AccountingBasisRule) :
    artifactHashValid type artifact = true ↔
      artifact.contentHash = accountingBodyHash type artifact :=
  Rastrata.Kernel.artifactHashValid_iff type artifact

/-- Two values of a basis rule that both pass under the same type name and carry the same content hash
are the same, or a collision of SHA-256 is in hand. -/
theorem AccountingBasisRule.eq_of_artifactHashValid {type : String} {a b : AccountingBasisRule}
    (ha : artifactHashValid type a = true) (hb : artifactHashValid type b = true)
    (h : a.contentHash = b.contentHash) : a = b ∨ HashCollision := by
  rw [AccountingBasisRule.artifactHashValid_iff] at ha hb
  rcases AccountingBasisRule.accountingBodyHash_inj_or_collision (ha.symm.trans (h.trans hb)) with hab | hc
  · left
    rw [← h] at hab
    exact hab
  · exact Or.inr hc

/-- A classification rule passes exactly when its content hash is the hash of its body. -/
theorem MonetaryClassificationRule.artifactHashValid_iff (type : String) (artifact : MonetaryClassificationRule) :
    artifactHashValid type artifact = true ↔
      artifact.contentHash = accountingBodyHash type artifact :=
  Rastrata.Kernel.artifactHashValid_iff type artifact

/-- Two values of a classification rule that both pass under the same type name and carry the same content hash
are the same, or a collision of SHA-256 is in hand. -/
theorem MonetaryClassificationRule.eq_of_artifactHashValid {type : String} {a b : MonetaryClassificationRule}
    (ha : artifactHashValid type a = true) (hb : artifactHashValid type b = true)
    (h : a.contentHash = b.contentHash) : a = b ∨ HashCollision := by
  rw [MonetaryClassificationRule.artifactHashValid_iff] at ha hb
  rcases MonetaryClassificationRule.accountingBodyHash_inj_or_collision (ha.symm.trans (h.trans hb)) with hab | hc
  · left
    rw [← h] at hab
    exact hab
  · exact Or.inr hc

/-- A tax component passes exactly when its content hash is the hash of its body. -/
theorem TaxPolicyComponent.artifactHashValid_iff (type : String) (artifact : TaxPolicyComponent) :
    artifactHashValid type artifact = true ↔
      artifact.contentHash = accountingBodyHash type artifact :=
  Rastrata.Kernel.artifactHashValid_iff type artifact

/-- Two values of a tax component that both pass under the same type name and carry the same content hash
are the same, or a collision of SHA-256 is in hand. -/
theorem TaxPolicyComponent.eq_of_artifactHashValid {type : String} {a b : TaxPolicyComponent}
    (ha : artifactHashValid type a = true) (hb : artifactHashValid type b = true)
    (h : a.contentHash = b.contentHash) : a = b ∨ HashCollision := by
  rw [TaxPolicyComponent.artifactHashValid_iff] at ha hb
  rcases TaxPolicyComponent.accountingBodyHash_inj_or_collision (ha.symm.trans (h.trans hb)) with hab | hc
  · left
    rw [← h] at hab
    exact hab
  · exact Or.inr hc

/-- An account mapping passes exactly when its content hash is the hash of its body. -/
theorem ConsolidationAccountMapping.artifactHashValid_iff (type : String) (artifact : ConsolidationAccountMapping) :
    artifactHashValid type artifact = true ↔
      artifact.contentHash = accountingBodyHash type artifact :=
  Rastrata.Kernel.artifactHashValid_iff type artifact

/-- Two values of an account mapping that both pass under the same type name and carry the same content hash
are the same, or a collision of SHA-256 is in hand. -/
theorem ConsolidationAccountMapping.eq_of_artifactHashValid {type : String} {a b : ConsolidationAccountMapping}
    (ha : artifactHashValid type a = true) (hb : artifactHashValid type b = true)
    (h : a.contentHash = b.contentHash) : a = b ∨ HashCollision := by
  rw [ConsolidationAccountMapping.artifactHashValid_iff] at ha hb
  rcases ConsolidationAccountMapping.accountingBodyHash_inj_or_collision (ha.symm.trans (h.trans hb)) with hab | hc
  · left
    rw [← h] at hab
    exact hab
  · exact Or.inr hc

/-- A translation rule passes exactly when its content hash is the hash of its body. -/
theorem ConsolidationTranslationRule.artifactHashValid_iff (type : String) (artifact : ConsolidationTranslationRule) :
    artifactHashValid type artifact = true ↔
      artifact.contentHash = accountingBodyHash type artifact :=
  Rastrata.Kernel.artifactHashValid_iff type artifact

/-- Two values of a translation rule that both pass under the same type name and carry the same content hash
are the same, or a collision of SHA-256 is in hand. -/
theorem ConsolidationTranslationRule.eq_of_artifactHashValid {type : String} {a b : ConsolidationTranslationRule}
    (ha : artifactHashValid type a = true) (hb : artifactHashValid type b = true)
    (h : a.contentHash = b.contentHash) : a = b ∨ HashCollision := by
  rw [ConsolidationTranslationRule.artifactHashValid_iff] at ha hb
  rcases ConsolidationTranslationRule.accountingBodyHash_inj_or_collision (ha.symm.trans (h.trans hb)) with hab | hc
  · left
    rw [← h] at hab
    exact hab
  · exact Or.inr hc

/-- What `verifyAccountingPolicyArtifacts` asks of one policy: every artifact its kind nests
carries the hash of its body under its type name. -/
def AccountingPolicy.ArtifactsReproducible : AccountingPolicy → Prop
  | .inventoryCost policy =>
    ∀ pool ∈ policy.pools, pool.contentHash = accountingBodyHash "InventoryPool" pool
  | .accountingBasis policy =>
    ∀ rule ∈ policy.rules, rule.contentHash = accountingBodyHash "AccountingBasisRule" rule
  | .monetaryClassification policy =>
    ∀ rule ∈ policy.rules, rule.contentHash = accountingBodyHash "MonetaryClassificationRule" rule
  | .taxDetermination policy =>
    ∀ component ∈ policy.components,
      component.contentHash = accountingBodyHash "TaxPolicyComponent" component
  | .consolidation policy =>
    (∀ mapping ∈ policy.accountMappings,
      mapping.contentHash = accountingBodyHash "ConsolidationAccountMapping" mapping) ∧
    (∀ rule ∈ policy.translationRules,
      rule.contentHash = accountingBodyHash "ConsolidationTranslationRule" rule)
  | .currencyRemeasurement _ => True
  | .inventoryValueAdjustment _ => True
  | .allocationSchedule _ => True

/-- One policy passes exactly when its artifacts are reproducible. -/
theorem AccountingPolicy.artifactsVerified_iff (policy : AccountingPolicy) :
    policy.artifactsVerified = true ↔ policy.ArtifactsReproducible := by
  cases policy <;>
    simp [AccountingPolicy.artifactsVerified, AccountingPolicy.ArtifactsReproducible,
      List.all_eq_true, InventoryPool.artifactHashValid_iff,
      AccountingBasisRule.artifactHashValid_iff, MonetaryClassificationRule.artifactHashValid_iff,
      TaxPolicyComponent.artifactHashValid_iff, ConsolidationAccountMapping.artifactHashValid_iff,
      ConsolidationTranslationRule.artifactHashValid_iff]

/-- `verifyAccountingPolicyArtifacts` accepts exactly when every policy's artifacts are
reproducible. -/
theorem verifyAccountingPolicyArtifacts_iff (policies : List AccountingPolicy) :
    verifyAccountingPolicyArtifacts policies = true ↔
      ∀ policy ∈ policies, policy.ArtifactsReproducible := by
  simp [verifyAccountingPolicyArtifacts, List.all_eq_true, AccountingPolicy.artifactsVerified_iff]

/-- An inventory pool whose content hash is not the hash of its body fails the check. -/
theorem verifyAccountingPolicyArtifacts_false_of_pool {policies : List AccountingPolicy}
    {policy : InventoryCostPolicy} {pool : InventoryPool}
    (hp : .inventoryCost policy ∈ policies) (hpool : pool ∈ policy.pools)
    (hbad : pool.contentHash ≠ accountingBodyHash "InventoryPool" pool) :
    verifyAccountingPolicyArtifacts policies = false := by
  rw [← Bool.not_eq_true, verifyAccountingPolicyArtifacts_iff]
  exact fun h => hbad (h _ hp pool hpool)

/-- A basis rule whose content hash is not the hash of its body fails the check. -/
theorem verifyAccountingPolicyArtifacts_false_of_basisRule {policies : List AccountingPolicy}
    {policy : AccountingBasisPolicy} {rule : AccountingBasisRule}
    (hp : .accountingBasis policy ∈ policies) (hrule : rule ∈ policy.rules)
    (hbad : rule.contentHash ≠ accountingBodyHash "AccountingBasisRule" rule) :
    verifyAccountingPolicyArtifacts policies = false := by
  rw [← Bool.not_eq_true, verifyAccountingPolicyArtifacts_iff]
  exact fun h => hbad (h _ hp rule hrule)

/-- A classification rule whose content hash is not the hash of its body fails the check. -/
theorem verifyAccountingPolicyArtifacts_false_of_classificationRule
    {policies : List AccountingPolicy} {policy : MonetaryClassificationPolicy}
    {rule : MonetaryClassificationRule}
    (hp : .monetaryClassification policy ∈ policies) (hrule : rule ∈ policy.rules)
    (hbad : rule.contentHash ≠ accountingBodyHash "MonetaryClassificationRule" rule) :
    verifyAccountingPolicyArtifacts policies = false := by
  rw [← Bool.not_eq_true, verifyAccountingPolicyArtifacts_iff]
  exact fun h => hbad (h _ hp rule hrule)

/-- A tax component whose content hash is not the hash of its body fails the check. -/
theorem verifyAccountingPolicyArtifacts_false_of_taxComponent {policies : List AccountingPolicy}
    {policy : TaxPolicy} {component : TaxPolicyComponent}
    (hp : .taxDetermination policy ∈ policies) (hcomponent : component ∈ policy.components)
    (hbad : component.contentHash ≠ accountingBodyHash "TaxPolicyComponent" component) :
    verifyAccountingPolicyArtifacts policies = false := by
  rw [← Bool.not_eq_true, verifyAccountingPolicyArtifacts_iff]
  exact fun h => hbad (h _ hp component hcomponent)

/-- An account mapping whose content hash is not the hash of its body fails the check. -/
theorem verifyAccountingPolicyArtifacts_false_of_accountMapping
    {policies : List AccountingPolicy} {policy : ConsolidationPolicy}
    {mapping : ConsolidationAccountMapping}
    (hp : .consolidation policy ∈ policies) (hmapping : mapping ∈ policy.accountMappings)
    (hbad : mapping.contentHash ≠ accountingBodyHash "ConsolidationAccountMapping" mapping) :
    verifyAccountingPolicyArtifacts policies = false := by
  rw [← Bool.not_eq_true, verifyAccountingPolicyArtifacts_iff]
  exact fun h => hbad ((h _ hp).1 mapping hmapping)

/-- A translation rule whose content hash is not the hash of its body fails the check. -/
theorem verifyAccountingPolicyArtifacts_false_of_translationRule
    {policies : List AccountingPolicy} {policy : ConsolidationPolicy}
    {rule : ConsolidationTranslationRule}
    (hp : .consolidation policy ∈ policies) (hrule : rule ∈ policy.translationRules)
    (hbad : rule.contentHash ≠ accountingBodyHash "ConsolidationTranslationRule" rule) :
    verifyAccountingPolicyArtifacts policies = false := by
  rw [← Bool.not_eq_true, verifyAccountingPolicyArtifacts_iff]
  exact fun h => hbad ((h _ hp).2 rule hrule)

/-- A policy of the three kinds that nest no artifact never makes the check fail: the check of a
list with it is the check of the list without it. -/
theorem verifyAccountingPolicyArtifacts_cons_of_no_artifacts (policy : AccountingPolicy)
    (policies : List AccountingPolicy)
    (hkind : policy.kind = .currencyRemeasurement ∨ policy.kind = .inventoryValueAdjustment ∨
      policy.kind = .allocationSchedule) :
    verifyAccountingPolicyArtifacts (policy :: policies) =
      verifyAccountingPolicyArtifacts policies := by
  cases policy <;> simp_all [verifyAccountingPolicyArtifacts, AccountingPolicy.kind,
    AccountingPolicy.artifactsVerified]

/-- `createAccountingPolicySnapshot` returns exactly the policies with their snapshot hash, when
their artifacts verify. -/
theorem createAccountingPolicySnapshot_ok_iff (policies : List AccountingPolicy)
    (snapshot : AccountingPolicySnapshot) :
    createAccountingPolicySnapshot policies = .ok snapshot ↔
      verifyAccountingPolicyArtifacts policies = true ∧
        snapshot = { policies, contentHash := hashAccountingPolicySnapshot policies } := by
  unfold createAccountingPolicySnapshot immutableAccountingValue
  cases h : verifyAccountingPolicyArtifacts policies
  · simp [h]
  · simp only [h, Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, true_and]
    exact ⟨fun hs => hs.symm, fun hs => hs.symm⟩

/-- `createAccountingPolicySnapshot` throws exactly when the artifacts do not verify, and the only
thing it throws is its `TypeError`. -/
theorem createAccountingPolicySnapshot_error_iff (policies : List AccountingPolicy)
    (e : AccountingPolicySnapshotErr) :
    createAccountingPolicySnapshot policies = .error e ↔
      verifyAccountingPolicyArtifacts policies = false := by
  unfold createAccountingPolicySnapshot immutableAccountingValue
  cases e
  cases h : verifyAccountingPolicyArtifacts policies <;> simp [h]

end Rastrata.Kernel

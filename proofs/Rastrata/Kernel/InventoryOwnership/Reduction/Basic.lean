/-
The helpers of `inventory-ownership.ts` (lines 108 to 130 and 1455) as statements, and the laws of
the four content hashes of lines 82 to 91, 268 and 327.

Hashes. Each hash is `accountingHash` of the artifact without its `contentHash`, so it is a
function of every other field, and of nothing else; two artifacts whose hashes are equal have equal
contents, or a collision of SHA-256 is in hand (`hashInventoryPostedAnchor_inj_or_collision` and the
three beside it). No field but `contentHash` is left out of any of the four. A reduction movement
and an acquisition movement are hashed under the same type name, `"InventoryPostedMovement"`; their
kinds are written differently, so their hashes are equal only through a collision
(`hashInventoryPostedReductionMovement_ne_acquisition`).
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Model
import Rastrata.Kernel.InventoryOwnership.Reduction.Lawful

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

namespace InventoryOwnership

/-! ## `reject` -/

/-- A rejection of this module carries one diagnostic, `lot_overallocation`, with the path and the
message it was given and the requirements `ACC-039.7`, `ACC-039.8` and `ACC-039.9`. -/
theorem reject_diagnostics (path message : String) :
    (reject path message).diagnostics =
      [diagnostic .lot_overallocation path message ["ACC-039.7", "ACC-039.8", "ACC-039.9"]] :=
  rfl

/-- Two rejections of this module are the same exactly when their paths and messages are. -/
theorem reject_inj {path₁ message₁ path₂ message₂ : String} :
    reject path₁ message₁ = reject path₂ message₂ ↔ path₁ = path₂ ∧ message₁ = message₂ := by
  simp [reject, diagnostic]

/-! ## Strings -/

/-- A string has a positive length exactly when it is not empty. -/
theorem string_length_pos_iff (text : String) : 0 < text.length ↔ text ≠ "" := by
  rw [Nat.pos_iff_ne_zero, ne_eq, ne_eq, String.length_eq_zero_iff]

/-- A string has length zero exactly when it is empty. -/
theorem string_length_eq_zero_iff (text : String) : text.length = 0 ↔ text = "" :=
  String.length_eq_zero_iff

/-! ## `fullHash` -/

/-- A full hash is exactly a hash of the kind `hashCanonical` produces: the current algorithm and
canonicalization, and a digest of 64 lower-case hexadecimal digits. -/
theorem fullHash_iff (hash : ContentHash) : fullHash hash = true ↔ hash.WF := by
  constructor
  · intro h
    simp only [fullHash, Bool.and_eq_true, beq_iff_eq, List.all_eq_true] at h
    exact ⟨h.1.1.1, h.1.1.2, h.1.2, h.2⟩
  · intro h
    simp only [fullHash, Bool.and_eq_true, beq_iff_eq, List.all_eq_true]
    exact ⟨⟨⟨h.algorithm_eq, h.version_eq⟩, h.digest_length⟩, h.digest_hex⟩

/-- Every hash `hashCanonical` produces is full. -/
theorem fullHash_hashCanonical (value : CanonicalValue) : fullHash (hashCanonical value) = true :=
  (fullHash_iff _).mpr (hashCanonical_wf value)

/-! ## `precedes` and `referenceValid` -/

/-- One artifact precedes another exactly when its revision is earlier, or the revision and the
effect are the same and its ordinal is earlier. -/
theorem precedes_iff (before after : ArtifactOrder) :
    precedes before after = true ↔
      before.bookRevision < after.bookRevision ∨
        (before.bookRevision = after.bookRevision ∧ before.effectKey = after.effectKey ∧
          before.artifactOrdinal < after.artifactOrdinal) := by
  simp [precedes, and_assoc]

/-- No artifact precedes itself. -/
theorem precedes_irrefl (order : ArtifactOrder) : precedes order order = false := by
  simp [precedes]

/-- `precedes` is transitive: it is a strict order. -/
theorem precedes_trans {a b c : ArtifactOrder} (hab : precedes a b = true)
    (hbc : precedes b c = true) : precedes a c = true := by
  rw [precedes_iff] at hab hbc ⊢
  rcases hab with hab | ⟨hab₁, hab₂, hab₃⟩ <;> rcases hbc with hbc | ⟨hbc₁, hbc₂, hbc₃⟩
  · exact Or.inl (lt_trans hab hbc)
  · exact Or.inl (hbc₁ ▸ hab)
  · exact Or.inl (hab₁ ▸ hbc)
  · exact Or.inr ⟨hab₁.trans hbc₁, hab₂.trans hbc₂, lt_trans hab₃ hbc₃⟩

/-- A valid reference has an identifier and an effect key, is of the book, has a positive ordinal
and revision, and carries a full hash. -/
theorem referenceValid_iff (reference : InventoryPostedArtifactReference) (bookId : BookId) :
    referenceValid reference bookId = true ↔
      reference.id ≠ "" ∧ reference.effectKey.value ≠ "" ∧ reference.bookId = bookId ∧
        0 < reference.artifactOrdinal ∧ 0 < reference.bookRevision ∧ reference.contentHash.WF := by
  simp only [referenceValid, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq, fullHash_iff,
    gt_iff_lt, string_length_pos_iff, ne_eq, and_assoc]

/-! ## `postedAnchorVersionValid` -/

/-- An anchor's version is valid exactly when it is `1.0.0` without posted components or `1.1.0`
with them. -/
theorem postedAnchorVersionValid_iff (anchor : InventoryPostedAnchor) :
    postedAnchorVersionValid anchor = true ↔
      (anchor.algorithmVersion.value = "1.0.0" ∧ anchor.postedValue = none) ∨
        (anchor.algorithmVersion.value = "1.1.0" ∧ anchor.postedValue.isSome) := by
  unfold postedAnchorVersionValid
  by_cases h : anchor.algorithmVersion.value = "1.0.0"
  · simp [h]
  · simp [h]

/-! ## Lists -/

/-- A list has no repeated value exactly when `hasDuplicates` is false. -/
theorem hasDuplicates_eq_false_iff {α : Type} [DecidableEq α] (values : List α) :
    hasDuplicates values = false ↔ values.Nodup := by
  simp only [hasDuplicates, bne_eq_false_iff_eq]
  exact Lots.setSize_eq_length_iff values

/-- Dimension identifiers are in order exactly when each is before the next in UTF-16 order. -/
theorem dimensionsOutOfOrder_eq_false_iff (ids : List DimensionMemberId) :
    dimensionsOutOfOrder ids = false ↔
      ids.IsChain (fun a b => compareCanonicalText a.value b.value = .lt) := by
  induction ids with
  | nil => simp only [dimensionsOutOfOrder, true_iff]; exact .nil
  | cons first rest ih =>
    cases rest with
    | nil => simp only [dimensionsOutOfOrder, true_iff]; exact .singleton _
    | cons second rest =>
      simp only [dimensionsOutOfOrder, Bool.or_eq_false_iff, bne_eq_false_iff_eq, ih,
        List.isChain_cons_cons]

/-- For two lists of the same length, `someDiffersAt` is false exactly when they are equal. -/
theorem someDiffersAt_eq_false_iff {α : Type} [DecidableEq α] :
    ∀ {xs ys : List α}, xs.length = ys.length → (someDiffersAt xs ys = false ↔ xs = ys)
  | [], [], _ => by simp [someDiffersAt]
  | [], _ :: _, h => by simp at h
  | _ :: _, [], h => by simp at h
  | x :: xs, y :: ys, h => by
    simp only [List.length_cons, Nat.add_right_cancel_iff] at h
    simp only [someDiffersAt, Bool.or_eq_false_iff, bne_eq_false_iff_eq,
      someDiffersAt_eq_false_iff h, List.cons.injEq]

/-- `sameOwnershipValue` is the equality of the two canonical hashes. -/
theorem sameOwnershipValue_iff {α β : Type} [Canonicalize α] [Canonicalize β] (left : α)
    (right : β) :
    sameOwnershipValue left right = true ↔
      hashCanonical (canonicalize left) = hashCanonical (canonicalize right) := by
  simp [sameOwnershipValue, canonicalAccountingValue, contentHashEquals_iff]

/-- Two values of one lawful type that `sameOwnershipValue` finds alike are equal, or a collision of
SHA-256 is in hand. -/
theorem sameOwnershipValue_eq_or_collision {α : Type} [Canonicalize α] [LawfulCanonicalize α]
    {left right : α} (h : sameOwnershipValue left right = true) : left = right ∨ HashCollision :=
  (hashCanonical_inj_or_collision (LawfulCanonicalize.wf left) (LawfulCanonicalize.wf right)
    ((sameOwnershipValue_iff left right).mp h)).imp LawfulCanonicalize.inj id

/-- Equal values are alike. -/
theorem sameOwnershipValue_self {α : Type} [Canonicalize α] (value : α) :
    sameOwnershipValue value value = true :=
  (sameOwnershipValue_iff value value).mpr rfl

/-- Sorting by a text key keeps the same members. -/
theorem sortByText_perm {α : Type} (key : α → String) (values : List α) :
    (sortByText key values).Perm values :=
  List.mergeSort_perm _ _

/-- The length of a sorted list is the length of the list. -/
theorem sortByText_length {α : Type} (key : α → String) (values : List α) :
    (sortByText key values).length = values.length :=
  (sortByText_perm key values).length_eq

end InventoryOwnership

/-! ## The four hashes -/

/-- An anchor's hash is a function of its content: two anchors with the same fields but
`contentHash` hash alike. -/
theorem hashInventoryPostedAnchor_of_body_eq {a b : InventoryPostedAnchor}
    (h : a.toInventoryPostedAnchorBody = b.toInventoryPostedAnchorBody) :
    hashInventoryPostedAnchor a.toInventoryPostedAnchorBody =
      hashInventoryPostedAnchor b.toInventoryPostedAnchorBody := by
  rw [h]

/-- Two anchor bodies with equal hashes are the same body, or a collision of SHA-256 is in hand:
the hash covers every field of an anchor but `contentHash`. -/
theorem hashInventoryPostedAnchor_inj_or_collision {a b : InventoryPostedAnchorBody}
    (h : hashInventoryPostedAnchor a = hashInventoryPostedAnchor b) : a = b ∨ HashCollision :=
  accountingHash_eq_iff_or_collision "InventoryPostedAnchor" a b h

/-- Two position bodies with equal hashes are the same body, or a collision of SHA-256 is in hand:
the hash covers every field of a position but `contentHash`. -/
theorem hashInventoryPostedPosition_inj_or_collision {a b : InventoryPostedPositionBody}
    (h : hashInventoryPostedPosition a = hashInventoryPostedPosition b) : a = b ∨ HashCollision :=
  accountingHash_eq_iff_or_collision "InventoryPostedPosition" a b h

/-- Two reduction movements whose hash inputs hash alike have the same `monetaryKind`, posting
and every other field but `contentHash`, or a collision of SHA-256 is in hand. -/
theorem hashInventoryPostedReductionMovement_inj_or_collision {a b : MovementHashInput}
    (h : hashInventoryPostedReductionMovement a = hashInventoryPostedReductionMovement b) :
    a = b ∨ HashCollision :=
  accountingHash_eq_iff_or_collision "InventoryPostedMovement" a b h

/-- Two acquisition movements whose hash inputs hash alike have the same `monetaryKind`, posting
and every other field but `contentHash`, or a collision of SHA-256 is in hand. -/
theorem hashInventoryPostedAcquisitionMovement_inj_or_collision
    {a b : InventoryPostedAcquisitionMovementHashInput}
    (h : hashInventoryPostedAcquisitionMovement a = hashInventoryPostedAcquisitionMovement b) :
    a = b ∨ HashCollision :=
  accountingHash_eq_iff_or_collision "InventoryPostedMovement" a b h

/-- A reduction movement and an acquisition movement never hash alike but through a collision of
SHA-256: both are hashed as `"InventoryPostedMovement"`, and their kinds differ. -/
theorem hashInventoryPostedReductionMovement_ne_acquisition {a : MovementHashInput}
    {b : InventoryPostedAcquisitionMovementHashInput}
    (h : hashInventoryPostedReductionMovement a = hashInventoryPostedAcquisitionMovement b) :
    HashCollision := by
  rcases hashCanonical_inj_or_collision (accountingHash_value_wf "InventoryPostedMovement" a)
    (accountingHash_value_wf "InventoryPostedMovement" b) h with hequiv | hcollision
  · exfalso
    have hvalue := object_equiv_forall₂
      (members₁ := [("type", some (.string "InventoryPostedMovement")),
        ("value", some (canonicalize a))])
      (members₂ := [("type", some (.string "InventoryPostedMovement")),
        ("value", some (canonicalize b))]) rfl (by simp) hequiv
    simp only [List.forall₂_cons, List.forall₂_nil_left_iff, and_true, OptEquiv] at hvalue
    have hkind := object_equiv_entryAt (members₁ := a.canonicalMembers)
      (members₂ := b.canonicalMembers) (by cases a <;> simp [MovementHashInput.canonicalMembers,
        JournalLinkedInventoryReductionMovementBody.canonicalMembers,
        InventoryPostedReductionMovementBody.quantityOnlyMembers,
        InventoryPostedReductionMovementBody.canonicalMembers, member, optMember, literalMember])
      (by cases b <;> simp [InventoryPostedAcquisitionMovementHashInput.canonicalMembers,
        JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
        InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
        InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember,
        literalMember]) hvalue.2 "kind"
    cases a <;> cases b <;>
      simp [MovementHashInput.canonicalMembers,
        JournalLinkedInventoryReductionMovementBody.canonicalMembers,
        InventoryPostedReductionMovementBody.quantityOnlyMembers,
        InventoryPostedReductionMovementBody.canonicalMembers,
        InventoryPostedAcquisitionMovementHashInput.canonicalMembers,
        JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers,
        InventoryPostedAcquisitionMovementBody.quantityOnlyMembers,
        InventoryPostedAcquisitionMovementBody.canonicalMembers, member, optMember, literalMember,
        entryAt, OptEquiv, canonicalize, CanonicalValue.Equiv] at hkind <;>
      exact InventoryPostedReductionKind.text_ne_acquisition _ _ hkind
  · exact hcollision

/-- A carried hash passes the check `contentHashEquals(carried, recomputed)` exactly when it is the
recomputed hash. -/
theorem contentHashEquals_carried_iff (carried recomputed : ContentHash) :
    contentHashEquals carried recomputed = true ↔ carried = recomputed :=
  contentHashEquals_iff carried recomputed

end Rastrata.Kernel

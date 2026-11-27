/-
The laws of the validity predicates of `inventory-ownership.ts` lines 1497 to 1677: each
characterised as an iff over the model's own tests in the TypeScript's order; the ordinals of a
valid effect are one, two, three and so on; and the header tests on what the preparing functions
return.
-/
import Rastrata.Kernel.InventoryOwnership.Validation.Model
import Rastrata.Kernel.InventoryOwnership.Effects

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

open InventoryOwnership InventoryOwnershipEffects InventoryOwnershipValidation

/-- A reduction movement is a reduction movement by its kind: telling movements apart by their
constructor is the TypeScript's test of line 1633. -/
theorem isInventoryPostedReductionMovement_reduction (movement : InventoryPostedReductionMovement) :
    isInventoryPostedReductionMovement (.reduction movement) = true := by
  cases movement <;> rename_i m <;> cases hk : m.kind <;>
    simp [isInventoryPostedReductionMovement, InventoryPostedMovement.kind,
      InventoryPostedReductionMovement.kind, InventoryPostedReductionMovement.body, hk,
      InventoryPostedReductionKind.text]

/-- An acquisition movement is not a reduction movement by its kind. -/
theorem isInventoryPostedReductionMovement_acquisition
    (movement : InventoryPostedAcquisitionMovement) :
    isInventoryPostedReductionMovement (.acquisition movement) = false := by
  cases movement <;> rename_i m <;> cases hk : m.kind <;>
    simp [isInventoryPostedReductionMovement, InventoryPostedMovement.kind,
      InventoryPostedAcquisitionMovement.kind, InventoryPostedAcquisitionMovement.body, hk,
      InventoryPostedAcquisitionKind.text]

/-- `ownershipMovementValid` accepts exactly the movements whose shape (lines 1499 to 1509),
recomputed proof (lines 1510 to 1513) and money (lines 1514 to 1516) pass, in that order. -/
theorem ownershipMovementValid_eq_ok_true_iff (movement : InventoryPostedReductionMovement) :
    ownershipMovementValid movement = .ok true ↔
      movementShapeInvalid movement = .ok false ∧ movementRecomputedInvalid movement = .ok false ∧
        movementMonetaryValid movement = .ok true := by
  unfold ownershipMovementValid
  cases h1 : movementShapeInvalid movement with
  | error e => simp
  | ok b1 =>
    cases b1
    · cases h2 : movementRecomputedInvalid movement with
      | error e => simp
      | ok b2 => cases b2 <;> simp
    · simp

/-- `ownershipAcquisitionMovementValid` accepts exactly the movements whose header, after-position,
position fields, incoming sources, recomputed proof and money pass, in that order. -/
theorem ownershipAcquisitionMovementValid_eq_ok_true_iff
    (movement : InventoryPostedAcquisitionMovement) :
    ownershipAcquisitionMovementValid movement = .ok true ↔
      acquisitionHeaderInvalid movement = false ∧
        ownershipPositionValid movement.afterPosition = .ok true ∧
        acquisitionPositionInvalid movement = false ∧ acquisitionIncomingInvalid movement = false ∧
        acquisitionRecomputedInvalid movement = .ok false ∧
        acquisitionMonetaryValid movement = .ok true := by
  unfold ownershipAcquisitionMovementValid
  cases acquisitionHeaderInvalid movement
  · cases hp : ownershipPositionValid movement.afterPosition with
    | error e => simp
    | ok valid =>
      cases valid
      · simp
      · cases acquisitionPositionInvalid movement
        · cases acquisitionIncomingInvalid movement
          · cases hr : acquisitionRecomputedInvalid movement with
            | error e => simp
            | ok bad => cases bad <;> simp
          · simp
        · simp
  · simp

/-- An ownership effect with more movements than the bound is never valid. With
`prepareInventoryOwnershipEffect`, which counts a transfer entry once against that bound but gives it
two movements, this is a gap: an effect of 5001 one-unit transfers is prepared and refused (see the
header of `InventoryOwnership/Validation.lean`). -/
theorem ownershipEffectValid_over_cap {effect : InventoryOwnershipEffect}
    (h : cap < (effectMovements effect).length) : ownershipEffectValid effect = .ok false := by
  have : ownershipEffectHeaderInvalid effect = true := by
    simp [ownershipEffectHeaderInvalid, h]
  simp [ownershipEffectValid, this]

/-- The header test of `ownershipEffectValid` on a prepared effect: its effect key, revision and
hash always pass, so it passes exactly when the effect has at most the bound of new anchors and
between one and the bound of movements. -/
theorem prepared_ownershipEffectHeader {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryOwnershipOperation}
    {prepared : InventoryOwnershipEffectPrepared}
    (h : prepareInventoryOwnershipEffect context sources operations = .ok (.prepared prepared)) :
    ownershipEffectHeaderInvalid prepared.effect = false ↔
      prepared.effect.newAnchors.length ≤ cap ∧ 0 < (effectMovements prepared.effect).length ∧
        (effectMovements prepared.effect).length ≤ cap := by
  obtain ⟨hk, hr, hkey, hrev, -, -, -, -, hh⟩ := prepareInventoryOwnershipEffect_header h
  have hkey' : prepared.effect.effectKey.value.length ≠ 0 := by
    rw [hk]; exact fun h0 => hkey (String.length_eq_zero_iff.mp h0)
  have hrev' : ¬ prepared.effect.bookRevision ≤ 0 := by rw [hr]; omega
  simp only [ownershipEffectHeaderInvalid, hh, contentHashEquals_iff, Bool.or_eq_false_iff,
    decide_eq_false_iff_not, not_lt, hkey', hrev', not_false_eq_true, Bool.not_eq_false',
    and_true, Nat.pos_iff_ne_zero, ne_eq, and_assoc]

/-- The header test of `ownershipReductionEffectValid` on a prepared reduction effect: no new anchor,
its effect key, revision and hash always pass, so it passes exactly when the effect has between one
and the bound of movements. -/
theorem prepared_reductionEffectHeader {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryReductionOperation}
    {prepared : InventoryReductionEffectPrepared}
    (h : prepareInventoryReductionEffect context sources operations = .ok (.prepared prepared)) :
    reductionEffectHeaderInvalid prepared.effect = false ↔
      0 < prepared.effect.journalLinkedMovements.length +
          prepared.effect.quantityOnlyMovements.length ∧
        prepared.effect.journalLinkedMovements.length +
          prepared.effect.quantityOnlyMovements.length ≤ cap := by
  obtain ⟨ownership, -, hp, htyped, hto, -, -⟩ := prepareInventoryReductionEffect_prepared h
  obtain ⟨hk, hr, hkey, hrev, -, -, -, -, hh⟩ := prepareInventoryOwnershipEffect_header hp
  rw [← hto] at hk hr hh
  have hkey' : prepared.effect.effectKey.value.length ≠ 0 := by
    have : prepared.effect.effectKey = context.effectKey := hk
    rw [this]; exact fun h0 => hkey (String.length_eq_zero_iff.mp h0)
  have hrev' : ¬ prepared.effect.bookRevision ≤ 0 := by
    have : prepared.effect.bookRevision = context.bookRevision := hr
    rw [this]; omega
  have hh' : prepared.effect.contentHash =
      hashInventoryReductionOwnershipEffect prepared.effect.toInventoryReductionOwnershipEffectBody :=
    hh
  have ht : prepared.effect.newAnchors = [] := htyped
  simp only [reductionEffectHeaderInvalid, hh', ht, contentHashEquals_iff, Bool.or_eq_false_iff,
    decide_eq_false_iff_not, not_lt, hkey', hrev', not_false_eq_true, Bool.not_eq_false',
    and_true, List.length_nil, bne_self_eq_false, true_and, Nat.pos_iff_ne_zero, ne_eq]

/-- `ownershipReductionEffectValid` accepts exactly the effects whose header passes, whose movements
in ordinal order all pass the loop, and whose two lists are each in increasing ordinal order. -/
theorem ownershipReductionEffectValid_eq_ok_true_iff (effect : InventoryReductionOwnershipEffect) :
    ownershipReductionEffectValid effect = .ok true ↔
      reductionEffectHeaderInvalid effect = false ∧
        ∃ first rest, reductionEffectMovements effect = first :: rest ∧
          reductionEffectLoop effect first 0 { ids := [], allocations := [], current := [] }
            (first :: rest) = .ok true ∧
          ordinalsIncreasing (effect.journalLinkedMovements.map (·.artifactOrdinal)) = true ∧
          ordinalsIncreasing (effect.quantityOnlyMovements.map (·.artifactOrdinal)) = true := by
  unfold ownershipReductionEffectValid
  cases reductionEffectHeaderInvalid effect
  · simp only [Bool.false_eq_true, ↓reduceIte, true_and]
    cases hm : reductionEffectMovements effect with
    | nil => simp
    | cons first rest =>
      simp only [List.cons.injEq, exists_and_left, exists_eq_left', exists_eq', true_and]
      cases hl : reductionEffectLoop effect first 0 { ids := [], allocations := [], current := [] }
          (first :: rest) with
      | error e => simp [hl]
      | ok b => cases b <;> simp [hl]
  · simp

/-- `ownershipEffectValid` accepts exactly the effects whose header passes, whose anchors and
movements in ordinal order all pass the loop, whose anchors are all used, and whose three lists are
each in increasing ordinal order. -/
theorem ownershipEffectValid_eq_ok_true_iff (effect : InventoryOwnershipEffect) :
    ownershipEffectValid effect = .ok true ↔
      ownershipEffectHeaderInvalid effect = false ∧
        ∃ first rest state, effectMovements effect = first :: rest ∧
          ownershipEffectLoop effect first 0 ownershipEffectInitial (effectArtifacts effect) =
            .ok (some state) ∧
          Lots.setSize state.usedAnchors = Lots.setSize (state.anchors.map (·.1)) ∧
          ordinalsIncreasing (effect.newAnchors.map (·.artifactOrdinal)) = true ∧
          ordinalsIncreasing (effect.journalLinkedMovements.map
            (·.toInventoryPostedMovement.artifactOrdinal)) = true ∧
          ordinalsIncreasing (effect.quantityOnlyMovements.map
            (·.toInventoryPostedMovement.artifactOrdinal)) = true := by
  unfold ownershipEffectValid
  cases ownershipEffectHeaderInvalid effect
  · simp only [Bool.false_eq_true, ↓reduceIte, true_and]
    cases hm : effectMovements effect with
    | nil => simp
    | cons first rest =>
      simp only [List.cons.injEq, exists_and_left, exists_eq_left', exists_eq', true_and]
      cases hl : ownershipEffectLoop effect first 0 ownershipEffectInitial (effectArtifacts effect) with
      | error e => simp [hl]
      | ok r =>
        cases r with
        | none => simp [hl]
        | some state => simp [hl, beq_iff_eq, and_assoc]
  · simp

/-- The anchors and movements of an effect that passes the loop are numbered one, two, three, and so
on, without gap or repeat. -/
theorem ownershipEffectLoop_ordinals {effect : InventoryOwnershipEffect}
    {first : InventoryPostedMovement} :
    ∀ {index : Nat} {state : OwnershipEffectCheck} {artifacts : List OwnershipEffectArtifact}
      {state' : OwnershipEffectCheck},
      ownershipEffectLoop effect first index state artifacts = .ok (some state') →
        artifacts.map (·.ordinal) =
          (List.range artifacts.length).map (fun k => ((index + k + 1 : Nat) : Int))
  | _, _, [], _, _ => rfl
  | index, state, artifact :: rest, state', h => by
    unfold ownershipEffectLoop at h
    cases hs : effectArtifactStep effect first state index artifact with
    | error e => simp [hs] at h
    | ok r =>
      cases r with
      | none => simp [hs] at h
      | some next =>
        simp only [hs] at h
        have hord : artifact.ordinal = (index : Int) + 1 := by
          unfold effectArtifactStep at hs
          by_cases ho : artifact.ordinal = (index : Int) + 1
          · exact ho
          · simp [ho] at hs
        rw [List.map_cons, ownershipEffectLoop_ordinals h, List.length_cons, List.range_succ_eq_map,
          List.map_cons, List.map_map, hord, List.cons.injEq]
        refine ⟨by push_cast; ring, List.map_congr_left fun k _ => ?_⟩
        simp only [Function.comp_apply, Nat.succ_eq_add_one]
        push_cast; ring

/-- The movements of a reduction effect that passes the loop are numbered one, two, three, and so on,
without gap or repeat. -/
theorem reductionEffectLoop_ordinals {effect : InventoryReductionOwnershipEffect}
    {first : InventoryPostedReductionMovement} :
    ∀ {index : Nat} {state : ReductionEffectCheck} {movements : List InventoryPostedReductionMovement},
      reductionEffectLoop effect first index state movements = .ok true →
        movements.map (·.artifactOrdinal) =
          (List.range movements.length).map (fun k => ((index + k + 1 : Nat) : Int))
  | _, _, [], _ => rfl
  | index, state, movement :: rest, h => by
    unfold reductionEffectLoop at h
    cases hs : reductionEffectStep effect first state index movement with
    | error e => simp [hs] at h
    | ok r =>
      cases r with
      | none => simp [hs] at h
      | some next =>
        simp only [hs] at h
        have hord : movement.artifactOrdinal = (index : Int) + 1 := by
          unfold reductionEffectStep at hs
          cases hv : ownershipMovementValid movement with
          | error e => simp [hv] at hs
          | ok valid =>
            by_cases ho : movement.artifactOrdinal = (index : Int) + 1
            · exact ho
            · simp [hv, ho] at hs
        rw [List.map_cons, reductionEffectLoop_ordinals h, List.length_cons, List.range_succ_eq_map,
          List.map_cons, List.map_map, hord, List.cons.injEq]
        refine ⟨by push_cast; ring, List.map_congr_left fun k _ => ?_⟩
        simp only [Function.comp_apply, Nat.succ_eq_add_one]
        push_cast; ring

/-- `validateInventoryOwnershipArtifact` checks each kind of artifact with its own predicate. -/
theorem validateInventoryOwnershipArtifact_kinds :
    (∀ anchor, validateInventoryOwnershipArtifact .anchor anchor =
      InventoryOwnershipValidationErr.ofQuantize (ownershipAnchorValid anchor)) ∧
    (∀ position, validateInventoryOwnershipArtifact .position position =
      InventoryOwnershipValidationErr.ofQuantize (ownershipPositionValid position)) ∧
    (∀ movement, validateInventoryOwnershipArtifact .reductionMovement movement =
      InventoryOwnershipValidationErr.ofQuantize (ownershipMovementValid movement)) ∧
    (∀ movement, validateInventoryOwnershipArtifact .acquisitionMovement movement =
      InventoryOwnershipValidationErr.ofQuantize (ownershipAcquisitionMovementValid movement)) ∧
    (∀ effect, validateInventoryOwnershipArtifact .reductionEffect effect =
      InventoryOwnershipValidationErr.ofQuantize (ownershipReductionEffectValid effect)) ∧
    (∀ effect, validateInventoryOwnershipArtifact .ownershipEffect effect =
      ownershipEffectValid effect) :=
  ⟨fun _ => rfl, fun _ => rfl, fun _ => rfl, fun _ => rfl, fun _ => rfl, fun _ => rfl⟩

/-- A reduction movement's header passes exactly when its hash reproduces, its revision and ordinal
are positive, it has an effect key, and its coordinate is valid. -/
theorem movementHeaderInvalid_eq_false_iff (movement : InventoryPostedReductionMovement) :
    movementHeaderInvalid movement = false ↔
      movement.contentHash = hashInventoryPostedReductionMovement movement.hashInput ∧
        0 < movement.bookRevision ∧ 0 < movement.artifactOrdinal ∧
        movement.effectKey.value ≠ "" ∧ ownershipCoordinateValid movement.coordinate = true := by
  simp only [movementHeaderInvalid, Bool.or_eq_false_iff, Bool.not_eq_false', contentHashEquals_iff,
    decide_eq_false_iff_not, not_le, string_length_eq_zero_iff, ne_eq, and_assoc]

/-- An acquisition movement's header passes exactly when its hash reproduces, it has an effect key,
its revision is positive, its ordinal leaves room for its anchor before it, and its coordinate is
valid. -/
theorem acquisitionHeaderInvalid_eq_false_iff (movement : InventoryPostedAcquisitionMovement) :
    acquisitionHeaderInvalid movement = false ↔
      movement.contentHash = hashInventoryPostedAcquisitionMovement movement.hashInput ∧
        movement.effectKey.value ≠ "" ∧ 0 < movement.bookRevision ∧
        1 < movement.artifactOrdinal ∧ ownershipCoordinateValid movement.coordinate = true := by
  simp only [acquisitionHeaderInvalid, Bool.or_eq_false_iff, Bool.not_eq_false',
    contentHashEquals_iff, decide_eq_false_iff_not, not_le, string_length_eq_zero_iff, ne_eq,
    and_assoc]

/-- A quantity-only reduction movement's money passes exactly when it posts nothing. -/
theorem movementMonetaryValid_quantityOnly_iff (movement : QuantityOnlyInventoryReductionMovement) :
    movementMonetaryValid (.quantityOnly movement) = .ok true ↔ movement.postedAmount.toRat = 0 := by
  simp [movementMonetaryValid, ExactDecimal.isZero_iff]

/-- A journal-linked reduction movement's money passes exactly when it posts a negative amount to a
posting of its book, of another effect, whose hash checks. -/
theorem movementMonetaryValid_journalLinked_iff {movement : JournalLinkedInventoryReductionMovement}
    (h : movement.postedAmount.WF) :
    movementMonetaryValid (.journalLinked movement) = .ok true ↔
      movement.postedAmount.toRat < 0 ∧ movement.posting.bookId = movement.coordinate.bookId ∧
        movement.posting.effectKey ≠ movement.effectKey ∧
        validateCanonicalPostingReferenceHash movement.posting = true := by
  obtain ⟨r, hr, hrwf, hrrat⟩ := ExactDecimal.toRational_isOk h
  simp only [movementMonetaryValid, hr, liftExact, Except.ok.injEq, Bool.and_eq_true,
    bne_iff_ne, ne_eq, beq_iff_eq, ExactRational.isNegative_iff hrwf, hrrat, and_assoc]

end Rastrata.Kernel

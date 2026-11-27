/-
The laws of `prepareInventoryOwnershipEffect` and of the reduction-only API (`inventory-ownership.ts`
lines 1137 to 1146 and 1220 to 1443).

A prepared effect passed every stage in order (`prepareInventoryOwnershipEffect_prepared`), is of
the candidate's effect key and revision with its own hash (`prepareInventoryOwnershipEffect_header`),
and its supplied sources are exactly the original holdings it touched (`effectOfConstruction_prepared`).
It throws only what a group throws or the `TypeError` of an absent value
(`prepareInventoryOwnershipEffect_error`). From reduction operations only, it is a reduction effect
with no new anchor, so the unchecked cast is never reached
(`prepareInventoryOwnershipEffect_reductions`, `prepareInventoryReductionEffect_ne_uncheckedCast`,
`prepareInventoryReductionEffect_prepared`).
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Hashes

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

open InventoryOwnership InventoryOwnershipEffects

/-- The last step prepares an effect only when the supplied sources are exactly the original holdings
used; the effect is of the candidate's effect key and revision, its anchors and movements are those
constructed in order, split by monetary kind, and it carries the hash of its own content. -/
theorem effectOfConstruction_prepared {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {state : EffectConstructionState}
    {prepared : InventoryOwnershipEffectPrepared}
    (h : effectOfConstruction context sources state = .prepared prepared) :
    Lots.setSize state.used = sources.length ∧
      prepared.effect.effectKey = context.effectKey ∧
      prepared.effect.bookRevision = context.bookRevision ∧
      prepared.effect.newAnchors = state.newAnchors ∧
      prepared.effect.journalLinkedMovements =
        state.movements.filterMap InventoryPostedMovement.journalLinked? ∧
      prepared.effect.quantityOnlyMovements =
        state.movements.filterMap InventoryPostedMovement.quantityOnly? ∧
      prepared.effect.contentHash =
        hashInventoryOwnershipEffect prepared.effect.toInventoryOwnershipEffectBody ∧
      prepared.newLots = state.newLots := by
  unfold effectOfConstruction at h
  split at h
  · simp at h
  · rename_i hu
    simp only [InventoryOwnershipEffectResult.prepared.injEq] at h
    subst h
    exact ⟨by simpa using hu, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-- An effect is prepared only after every stage passed, in the TypeScript's order: the bounds, the
work of the operations, the original sources, the identities and journal sources, and the
construction of every operation. -/
theorem prepareInventoryOwnershipEffect_prepared {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryOwnershipOperation}
    {prepared : InventoryOwnershipEffectPrepared}
    (h : prepareInventoryOwnershipEffect context sources operations = .ok (.prepared prepared)) :
    ∃ (sourceWork : Nat) (current : List (LotHoldingId × InventoryPostedReductionSource))
      (anchorIds : List InventoryPostedAnchorId) (priorMovementIds : List InventoryPostedMovementId)
      (identities : EffectIdentityState) (state : EffectConstructionState),
      effectBoundsInvalid context sources operations = false ∧
      effectWorkLoop 0 0 0 operations = .proceed sourceWork ∧
      effectSourcesLoop context sourceWork [] [] [] sources =
        .proceed (current, anchorIds, priorMovementIds) ∧
      effectIdentityLoop priorMovementIds (effectInitialIdentities sources current anchorIds)
        operations = .proceed identities ∧
      effectConstructionLoop context (current.map (·.1))
        { current := current, used := [], movements := [], newAnchors := [], newLots := [],
          reductionWork := 0 } operations = .ok (.proceed state) ∧
      effectOfConstruction context sources state = .prepared prepared := by
  unfold prepareInventoryOwnershipEffect at h
  split at h
  · simp at h
  · rename_i hb
    split at h
    · simp at h
    · rename_i sourceWork hw
      split at h
      · simp at h
      · rename_i current anchorIds priorMovementIds hs
        split at h
        · simp at h
        · rename_i identities hi
          split at h
          · simp at h
          · simp at h
          · rename_i state hc
            simp only [Except.ok.injEq] at h
            exact ⟨sourceWork, current, anchorIds, priorMovementIds, identities, state,
              by simpa using hb, hw, hs, hi, hc, h⟩

/-- A reduction operation adds its group's movements and no anchor or lot. -/
theorem effectConstructReduction_proceed {context : InventoryReductionEffectContext}
    {originalIds : List LotHoldingId} {state state' : EffectConstructionState}
    {operation : InventoryReductionOperation}
    (h : effectConstructReduction context originalIds state operation = .ok (.proceed state')) :
    state'.newAnchors = state.newAnchors ∧ state'.newLots = state.newLots ∧
      ∃ group : InventoryPostedReductionGroup,
        state'.movements = state.movements ++ group.movements.map .reduction := by
  unfold effectConstructReduction at h
  repeat' split at h
  all_goals simp only [reduceCtorEq, Except.ok.injEq, OwnershipStep.proceed.injEq] at h
  subst h
  exact ⟨rfl, rfl, _, rfl⟩

/-- An operation throws only what a group function throws, or the `TypeError` of an absent value. -/
theorem effectConstructOperation_error {context : InventoryReductionEffectContext}
    {originalIds : List LotHoldingId} {state : EffectConstructionState}
    {operation : InventoryOwnershipOperation} {e : InventoryOwnershipEffectErr}
    (h : effectConstructOperation context originalIds state operation = .error e) :
    e = .undefinedValue ∨ ∃ inner, e = .ownership inner := by
  have hof : ∀ {α : Type} {x : Except InventoryOwnershipErr α} {e : InventoryOwnershipEffectErr},
      InventoryOwnershipEffectErr.ofOwnership x = .error e → ∃ inner, e = .ownership inner := by
    intro α x e hx
    cases x with
    | error inner => simp only [InventoryOwnershipEffectErr.ofOwnership, Except.error.injEq] at hx
                     exact ⟨inner, hx.symm⟩
    | ok v => simp [InventoryOwnershipEffectErr.ofOwnership] at hx
  cases operation with
  | acquisition operation =>
    simp only [effectConstructOperation, effectConstructAcquisition] at h
    split at h
    · rename_i e' he; simp only [Except.error.injEq] at h; subst h; exact Or.inr (hof he)
    · simp at h
    · split at h
      · simp only [Except.error.injEq] at h; exact Or.inl h.symm
      · simp at h
  | adopt operation =>
    simp only [effectConstructOperation, effectConstructAdoption] at h
    split at h
    · rename_i e' he; simp only [Except.error.injEq] at h; subst h; exact Or.inr (hof he)
    · simp at h
    · split at h
      · simp only [Except.error.injEq] at h; exact Or.inl h.symm
      · simp at h
  | transfer operation =>
    simp only [effectConstructOperation, effectConstructTransfer] at h
    split at h
    · simp at h
    · split at h
      · rename_i e' he; simp only [Except.error.injEq] at h; subst h; exact Or.inr (hof he)
      · simp at h
      · split at h
        · simp only [Except.error.injEq] at h; exact Or.inl h.symm
        · split at h
          · simp only [Except.error.injEq] at h; exact Or.inl h.symm
          · simp at h
  | reduction operation =>
    simp only [effectConstructOperation, effectConstructReduction] at h
    split at h
    · simp at h
    · split at h
      · rename_i e' he; simp only [Except.error.injEq] at h; subst h; exact Or.inr (hof he)
      · simp at h
      · split at h
        · simp only [Except.error.injEq] at h; exact Or.inl h.symm
        · simp at h

/-- The construction loop throws only what a group function throws, or the `TypeError` of an
absent value. -/
theorem effectConstructionLoop_error {context : InventoryReductionEffectContext}
    {originalIds : List LotHoldingId} :
    ∀ {state : EffectConstructionState} {operations : List InventoryOwnershipOperation}
      {e : InventoryOwnershipEffectErr},
      effectConstructionLoop context originalIds state operations = .error e →
        e = .undefinedValue ∨ ∃ inner, e = .ownership inner
  | _, [], _, h => by simp [effectConstructionLoop] at h
  | state, operation :: rest, e, h => by
    unfold effectConstructionLoop at h
    split at h
    · rename_i e' he; simp only [Except.error.injEq] at h; subst h
      exact effectConstructOperation_error he
    · simp at h
    · exact effectConstructionLoop_error h

/-- `prepareInventoryOwnershipEffect` throws only what a group function throws, or the `TypeError` of
an absent value; never `uncheckedCast`. -/
theorem prepareInventoryOwnershipEffect_error {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryOwnershipOperation}
    {e : InventoryOwnershipEffectErr}
    (h : prepareInventoryOwnershipEffect context sources operations = .error e) :
    e = .undefinedValue ∨ ∃ inner, e = .ownership inner := by
  unfold prepareInventoryOwnershipEffect at h
  repeat' split at h
  all_goals try simp only [reduceCtorEq] at h
  rename_i e' he
  simp only [Except.error.injEq] at h
  subst h
  exact effectConstructionLoop_error he

/-- Every movement is a reduction movement. -/
def AllReductions (movements : List InventoryPostedMovement) : Prop :=
  ∀ movement ∈ movements, ∃ reduction, movement = .reduction reduction

/-- Reduction operations construct only reduction movements and no anchor. -/
theorem effectConstructionLoop_reductions {context : InventoryReductionEffectContext}
    {originalIds : List LotHoldingId} :
    ∀ {state state' : EffectConstructionState} {operations : List InventoryReductionOperation},
      effectConstructionLoop context originalIds state (operations.map .reduction) =
          .ok (.proceed state') →
        AllReductions state.movements → state.newAnchors = [] →
          AllReductions state'.movements ∧ state'.newAnchors = []
  | state, state', [], h, hm, ha => by
    simp only [List.map_nil, effectConstructionLoop, Except.ok.injEq,
      OwnershipStep.proceed.injEq] at h
    subst h; exact ⟨hm, ha⟩
  | state, state', operation :: rest, h, hm, ha => by
    simp only [List.map_cons] at h
    unfold effectConstructionLoop at h
    cases hs : effectConstructOperation context originalIds state (.reduction operation) with
    | error e => simp [hs] at h
    | ok step =>
      cases step with
      | rejected r => simp [hs] at h
      | proceed next =>
        simp only [hs] at h
        obtain ⟨hna, -, group, hmv⟩ := effectConstructReduction_proceed hs
        refine effectConstructionLoop_reductions h ?_ (hna.trans ha)
        intro movement hmem
        rw [hmv] at hmem
        rcases List.mem_append.mp hmem with hmem | hmem
        · exact hm movement hmem
        · obtain ⟨r, -, rfl⟩ := List.mem_map.mp hmem
          exact ⟨r, rfl⟩

/-- The journal-linked movements of reduction movements are all reduction movements. -/
theorem journalLinkedReductions_filterMap :
    ∀ {movements : List InventoryPostedMovement}, AllReductions movements →
      (journalLinkedReductions? (movements.filterMap InventoryPostedMovement.journalLinked?)).isSome
  | [], _ => by simp [journalLinkedReductions?]
  | movement :: rest, h => by
    obtain ⟨r, rfl⟩ := h movement List.mem_cons_self
    have ih := journalLinkedReductions_filterMap (movements := rest)
      (fun m hm => h m (List.mem_cons_of_mem _ hm))
    cases r with
    | journalLinked m =>
      simp only [List.filterMap_cons, InventoryPostedMovement.journalLinked?,
        journalLinkedReductions?, JournalLinkedInventoryPostedMovement.asReduction?]
      cases hx : journalLinkedReductions? (rest.filterMap InventoryPostedMovement.journalLinked?) with
      | none => simp [hx] at ih
      | some l => simp
    | quantityOnly m =>
      simpa [List.filterMap_cons, InventoryPostedMovement.journalLinked?] using ih

/-- The quantity-only movements of reduction movements are all reduction movements. -/
theorem quantityOnlyReductions_filterMap :
    ∀ {movements : List InventoryPostedMovement}, AllReductions movements →
      (quantityOnlyReductions? (movements.filterMap InventoryPostedMovement.quantityOnly?)).isSome
  | [], _ => by simp [quantityOnlyReductions?]
  | movement :: rest, h => by
    obtain ⟨r, rfl⟩ := h movement List.mem_cons_self
    have ih := quantityOnlyReductions_filterMap (movements := rest)
      (fun m hm => h m (List.mem_cons_of_mem _ hm))
    cases r with
    | quantityOnly m =>
      simp only [List.filterMap_cons, InventoryPostedMovement.quantityOnly?,
        quantityOnlyReductions?, QuantityOnlyInventoryPostedMovement.asReduction?]
      cases hx : quantityOnlyReductions? (rest.filterMap InventoryPostedMovement.quantityOnly?) with
      | none => simp [hx] at ih
      | some l => simp
    | journalLinked m =>
      simpa [List.filterMap_cons, InventoryPostedMovement.quantityOnly?] using ih

/-- Narrowing journal-linked movements loses nothing. -/
theorem journalLinkedReductions_some :
    ∀ {l : List JournalLinkedInventoryPostedMovement}
      {l' : List JournalLinkedInventoryReductionMovement},
      journalLinkedReductions? l = some l' → l'.map .reduction = l
  | [], l', h => by simp only [journalLinkedReductions?, Option.some.injEq] at h; subst h; rfl
  | movement :: rest, l', h => by
    unfold journalLinkedReductions? at h
    split at h
    · rename_i r rs hr hrs
      simp only [Option.some.injEq] at h
      subst h
      cases movement with
      | reduction m =>
        simp only [JournalLinkedInventoryPostedMovement.asReduction?, Option.some.injEq] at hr
        subst hr
        simp [journalLinkedReductions_some hrs]
      | acquisition m => simp [JournalLinkedInventoryPostedMovement.asReduction?] at hr
    · simp at h

/-- Narrowing quantity-only movements loses nothing. -/
theorem quantityOnlyReductions_some :
    ∀ {l : List QuantityOnlyInventoryPostedMovement}
      {l' : List QuantityOnlyInventoryReductionMovement},
      quantityOnlyReductions? l = some l' → l'.map .reduction = l
  | [], l', h => by simp only [quantityOnlyReductions?, Option.some.injEq] at h; subst h; rfl
  | movement :: rest, l', h => by
    unfold quantityOnlyReductions? at h
    split at h
    · rename_i r rs hr hrs
      simp only [Option.some.injEq] at h
      subst h
      cases movement with
      | reduction m =>
        simp only [QuantityOnlyInventoryPostedMovement.asReduction?, Option.some.injEq] at hr
        subst hr
        simp [quantityOnlyReductions_some hrs]
      | acquisition m => simp [QuantityOnlyInventoryPostedMovement.asReduction?] at hr
    · simp at h

/-- The effect prepared from reduction operations only is a reduction effect: the cast of lines 1145
and 1230 is defined on it, it has no new anchor, and it is the same effect. -/
theorem prepareInventoryOwnershipEffect_reductions {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryReductionOperation}
    {prepared : InventoryOwnershipEffectPrepared}
    (h : prepareInventoryOwnershipEffect context sources (operations.map .reduction) =
      .ok (.prepared prepared)) :
    ∃ effect, prepared.effect.asReductionEffect? = some effect ∧ effect.Typed ∧
      effect.toInventoryOwnershipEffect = prepared.effect := by
  obtain ⟨_, _, _, _, _, state, -, -, -, -, hc, he⟩ := prepareInventoryOwnershipEffect_prepared h
  obtain ⟨hall, hna⟩ := effectConstructionLoop_reductions hc (fun _ hm => by cases hm) rfl
  obtain ⟨-, -, -, hanc, hjl, hqo, -, -⟩ := effectOfConstruction_prepared he
  have hj := journalLinkedReductions_filterMap hall
  have hq := quantityOnlyReductions_filterMap hall
  rw [← hjl] at hj
  rw [← hqo] at hq
  obtain ⟨jl, hjl'⟩ := Option.isSome_iff_exists.mp hj
  obtain ⟨qo, hqo'⟩ := Option.isSome_iff_exists.mp hq
  refine ⟨⟨⟨prepared.effect.effectKey, prepared.effect.bookRevision, prepared.effect.newAnchors, jl,
      qo⟩, prepared.effect.contentHash⟩, by simp only [InventoryOwnershipEffect.asReductionEffect?, hjl', hqo'], ?_, ?_⟩
  · show prepared.effect.newAnchors = []
    rw [hanc, hna]
  · simp only [InventoryReductionOwnershipEffect.toInventoryOwnershipEffect,
      InventoryReductionOwnershipEffectBody.toInventoryOwnershipEffectBody,
      journalLinkedReductions_some hjl', quantityOnlyReductions_some hqo']

/-- The unchecked cast of `prepareInventoryReductionEffect` (line 1230) never misbehaves. -/
theorem prepareInventoryReductionEffect_ne_uncheckedCast {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource}
    {operations : List InventoryReductionOperation} :
    prepareInventoryReductionEffect context sources operations ≠ .error .uncheckedCast := by
  unfold prepareInventoryReductionEffect
  split
  · simp
  · cases hp : prepareInventoryOwnershipEffect context sources (operations.map .reduction) with
    | error e =>
      intro h
      simp only [Except.error.injEq] at h
      subst h
      rcases prepareInventoryOwnershipEffect_error hp with h1 | ⟨inner, h1⟩ <;> cases h1
    | ok result =>
      cases result with
      | rejected r => simp
      | prepared prepared =>
        obtain ⟨effect, he, -, -⟩ := prepareInventoryOwnershipEffect_reductions hp
        simp [narrowPrepared, he]

/-- A prepared reduction effect is the ownership effect prepared from the same operations, with no
new anchor, and the same holdings and positions after it. -/
theorem prepareInventoryReductionEffect_prepared {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryReductionOperation}
    {prepared : InventoryReductionEffectPrepared}
    (h : prepareInventoryReductionEffect context sources operations = .ok (.prepared prepared)) :
    ∃ ownership : InventoryOwnershipEffectPrepared,
      reductionEffectBoundsInvalid sources operations = false ∧
      prepareInventoryOwnershipEffect context sources (operations.map .reduction) =
        .ok (.prepared ownership) ∧
      prepared.effect.Typed ∧ prepared.effect.toInventoryOwnershipEffect = ownership.effect ∧
      prepared.afterHoldings = ownership.afterHoldings ∧
      prepared.afterPositions = ownership.afterPositions := by
  unfold prepareInventoryReductionEffect at h
  split at h
  · simp at h
  · rename_i hb
    cases hp : prepareInventoryOwnershipEffect context sources (operations.map .reduction) with
    | error e => simp [hp] at h
    | ok result =>
      cases result with
      | rejected r => simp [hp] at h
      | prepared ownership =>
        simp only [hp] at h
        obtain ⟨effect, he, htyped, hto⟩ := prepareInventoryOwnershipEffect_reductions hp
        simp only [narrowPrepared, he, Except.ok.injEq, InventoryReductionEffectResult.prepared.injEq] at h
        subst h
        exact ⟨ownership, by simpa using hb, rfl, htyped, hto, rfl, rfl⟩

/-- A prepared effect is of the candidate's committed effect key and revision, from a nonempty
bounded set of operations and bounded sources, and its carried hash is the hash of its content. -/
theorem prepareInventoryOwnershipEffect_header {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryOwnershipOperation}
    {prepared : InventoryOwnershipEffectPrepared}
    (h : prepareInventoryOwnershipEffect context sources operations = .ok (.prepared prepared)) :
    prepared.effect.effectKey = context.effectKey ∧ prepared.effect.bookRevision = context.bookRevision ∧
      context.effectKey.value ≠ "" ∧ 0 < context.bookRevision ∧ context.commandId.value ≠ "" ∧
      sources.length ≤ cap ∧ operations ≠ [] ∧ operations.length ≤ cap ∧
      prepared.effect.contentHash =
        hashInventoryOwnershipEffect prepared.effect.toInventoryOwnershipEffectBody := by
  obtain ⟨_, _, _, _, _, state, hb, -, -, -, -, he⟩ := prepareInventoryOwnershipEffect_prepared h
  obtain ⟨-, hk, hr, -, -, -, hh, -⟩ := effectOfConstruction_prepared he
  simp only [effectBoundsInvalid, Bool.or_eq_false_iff, decide_eq_false_iff_not, not_lt,
    not_le, gt_iff_lt] at hb
  obtain ⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩ := hb
  refine ⟨hk, hr, ?_, h4, ?_, h1, ?_, h3, hh⟩
  · intro he'; exact h5 (by simp [he'])
  · intro he'; exact h6 (by simp [he'])
  · intro he'; exact h2 (by simp [he'])

/-- The bounds rejection (line 1246) is given whenever the bounds test fails. -/
theorem prepareInventoryOwnershipEffect_bounds {context : InventoryReductionEffectContext}
    {sources : List InventoryPostedReductionSource} {operations : List InventoryOwnershipOperation}
    (h : effectBoundsInvalid context sources operations = true) :
    prepareInventoryOwnershipEffect context sources operations =
      .ok (.rejected effectBoundsRejection) := by
  simp [prepareInventoryOwnershipEffect, h]

end Rastrata.Kernel

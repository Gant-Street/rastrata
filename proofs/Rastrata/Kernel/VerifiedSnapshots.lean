/-
Verified configuration snapshot cache: the Lean model of `packages/kernel/src/verified-snapshots.ts`.

JavaScript objects have reference identity and mutable properties; Lean values lack heap identity.
We model object identity by `SnapshotToken` (`Nat`), a snapshot by `Snapshot α` pairing a token
with its current value, the module-level `WeakSet<object>` and counters by `SnapshotCache`, and
`freezeDeep` over an explicit object graph (`ObjectGraph`) tracking frozen tokens.
-/
import Rastrata.Prelude

namespace Rastrata.Kernel

/-- Object identity token, standing in for JavaScript object reference identity (`===` / `WeakSet`). -/
abbrev SnapshotToken := Nat

/-- A snapshot value paired with its object identity token (`snapshot: object`). -/
structure Snapshot (α : Type) where
  token : SnapshotToken
  value : α
  deriving DecidableEq, Repr, Inhabited

/-- `snapshotVerifications` (`verified-snapshots.ts` lines 49–51). -/
structure SnapshotVerifications where
  reused : Nat
  rehashed : Nat
  froze : Nat
  deriving DecidableEq, Repr, Inhabited

/-- Module-level state of `verified-snapshots.ts`: the `WeakSet` of verified object tokens and
the three counters (`reused`, `rehashed`, `froze`). -/
structure SnapshotCache where
  verified : List SnapshotToken
  reused : Nat
  rehashed : Nat
  froze : Nat
  deriving DecidableEq, Repr, Inhabited

/-- Initial empty cache before any snapshots are marked or checked. -/
def SnapshotCache.empty : SnapshotCache :=
  { verified := [], reused := 0, rehashed := 0, froze := 0 }

/-- Reachable heap object graph: `(token, childTokens)` pairs for `Object.values`. -/
abbrev ObjectGraph := List (SnapshotToken × List SnapshotToken)

private def findChildren (t : SnapshotToken) : ObjectGraph → Option (List SnapshotToken)
  | [] => none
  | (k, children) :: rest => if k == t then some children else findChildren t rest

private def eraseToken (t : SnapshotToken) : ObjectGraph → ObjectGraph
  | [] => []
  | (k, children) :: rest =>
    if k == t then eraseToken t rest else (k, children) :: eraseToken t rest

private theorem eraseToken_length_le (t : SnapshotToken) (g : ObjectGraph) :
    (eraseToken t g).length ≤ g.length := by
  induction g with
  | nil => simp [eraseToken]
  | cons hd tl ih =>
    rcases hd with ⟨k, cs⟩
    simp only [eraseToken]
    split
    · simp only [List.length_cons]; omega
    · simp only [List.length_cons]; omega

private theorem eraseToken_length_lt {t : SnapshotToken} {g : ObjectGraph} {cs : List SnapshotToken}
    (h : findChildren t g = some cs) : (eraseToken t g).length < g.length := by
  induction g with
  | nil => simp [findChildren] at h
  | cons hd tl ih =>
    rcases hd with ⟨k, children⟩
    simp only [findChildren] at h
    simp only [eraseToken]
    split at h
    · rename_i heq
      simp only [heq, ↓reduceIte, List.length_cons]
      have := eraseToken_length_le t tl
      omega
    · rename_i hne
      simp only [hne, Bool.false_eq_true, ↓reduceIte, List.length_cons]
      have := ih h
      omega

private def freezeListImpl (ts : List SnapshotToken) (remaining : ObjectGraph)
    (frozen : List SnapshotToken) (froze : Nat) :
    { out : ObjectGraph × List SnapshotToken × Nat // out.1.length ≤ remaining.length } :=
  match ts with
  | [] => ⟨(remaining, frozen, froze), Nat.le_refl _⟩
  | t :: rest =>
    match h : findChildren t remaining with
    | none => freezeListImpl rest remaining frozen froze
    | some children =>
      let remaining₁ := eraseToken t remaining
      have hlt : remaining₁.length < remaining.length := eraseToken_length_lt h
      let r₁ := freezeListImpl children remaining₁ frozen froze
      let frozen₁ := r₁.1.2.1
      let froze₁ := r₁.1.2.2
      let froze₂ := if frozen₁.contains t then froze₁ else froze₁ + 1
      let frozen₂ := if frozen₁.contains t then frozen₁ else t :: frozen₁
      have hlt2 : r₁.1.1.length < remaining.length := Nat.lt_of_le_of_lt r₁.2 hlt
      let r₂ := freezeListImpl rest r₁.1.1 frozen₂ froze₂
      ⟨r₂.1, Nat.le_trans r₂.2 (Nat.le_of_lt hlt2)⟩
termination_by (remaining.length, ts.length)

/-- `freezeDeep` (`verified-snapshots.ts` lines 21–27): freezes every object reachable from
`root` in post-order (avoiding cycles via `seen`), counting objects not yet frozen. -/
def freezeDeep (root : SnapshotToken) (graph : ObjectGraph)
    (frozen : List SnapshotToken) (froze : Nat) : List SnapshotToken × Nat :=
  (freezeListImpl [root] graph frozen froze).1.2

/-- `markVerifiedSnapshot` (`verified-snapshots.ts` lines 31–34): freezes the object graph
reachable from `snapshot` and records `snapshot.token` in the verified cache. -/
def markVerifiedSnapshot {α : Type} (cache : SnapshotCache) (frozen : List SnapshotToken)
    (snapshot : Snapshot α) (graph : ObjectGraph := [(snapshot.token, [])]) :
    SnapshotCache × List SnapshotToken :=
  let (frozen', froze') := freezeDeep snapshot.token graph frozen cache.froze
  let verified' :=
    if cache.verified.contains snapshot.token then cache.verified
    else snapshot.token :: cache.verified
  ({ cache with verified := verified', froze := froze' }, frozen')

/-- `verifiedOr` (`verified-snapshots.ts` lines 38–45): returns `true` and increments `reused`
when `snapshot.token` is cached; otherwise increments `rehashed` and runs `rehash`. -/
def verifiedOr {α : Type} (cache : SnapshotCache) (snapshot : Snapshot α) (rehash : Unit → Bool) :
    Bool × SnapshotCache :=
  if cache.verified.contains snapshot.token then
    (true, { cache with reused := cache.reused + 1 })
  else
    (rehash (), { cache with rehashed := cache.rehashed + 1 })

/-- `snapshotVerifications` (`verified-snapshots.ts` lines 49–51). -/
def snapshotVerifications (cache : SnapshotCache) : SnapshotVerifications :=
  { reused := cache.reused, rehashed := cache.rehashed, froze := cache.froze }

/-! ## Core laws -/

/-- `verifiedOr` returns the same answer as full rehashing whenever every cached token was
verified before marking and any marked snapshot has not mutated since. -/
theorem verifiedOr_eq_rehash {α : Type}
    (cache : SnapshotCache) (snapshot : Snapshot α) (rehash : Unit → Bool)
    (verify : α → Bool) (markedValue : SnapshotToken → Option α)
    (hRehash : rehash () = verify snapshot.value)
    (hMarkedVerified : ∀ t ∈ cache.verified, ∃ v₀, markedValue t = some v₀ ∧ verify v₀ = true)
    (hImmutable : snapshot.token ∈ cache.verified →
      ∀ v₀, markedValue snapshot.token = some v₀ → snapshot.value = v₀) :
    (verifiedOr cache snapshot rehash).1 = verify snapshot.value := by
  unfold verifiedOr
  by_cases hmem : cache.verified.contains snapshot.token
  · simp only [hmem, ↓reduceIte]
    have htok : snapshot.token ∈ cache.verified := List.contains_iff_mem.mp hmem
    obtain ⟨v₀, hmark, hv⟩ := hMarkedVerified snapshot.token htok
    rw [hImmutable htok v₀ hmark, hv]
  · simp only [hmem, Bool.false_eq_true, ↓reduceIte, hRehash]

/-- `verifiedOr` returns `true` and increments `reused` when the snapshot's token is cached. -/
theorem verifiedOr_of_mem {α : Type} (cache : SnapshotCache) (snapshot : Snapshot α)
    (rehash : Unit → Bool) (h : snapshot.token ∈ cache.verified) :
    verifiedOr cache snapshot rehash = (true, { cache with reused := cache.reused + 1 }) := by
  simp [verifiedOr, h]

/-- `verifiedOr` invokes `rehash` and increments `rehashed` when the snapshot's token is not cached. -/
theorem verifiedOr_of_not_mem {α : Type} (cache : SnapshotCache) (snapshot : Snapshot α)
    (rehash : Unit → Bool) (h : snapshot.token ∉ cache.verified) :
    verifiedOr cache snapshot rehash = (rehash (), { cache with rehashed := cache.rehashed + 1 }) := by
  simp [verifiedOr, h]

/-- A copy with a distinct uncached token is never reused even when its payload equals a cached snapshot's. -/
theorem verifiedOr_distinct_identity {α : Type} (cache : SnapshotCache)
    (original copy : Snapshot α) (rehash : Unit → Bool)
    (_hEq : copy.value = original.value) (hNotCached : copy.token ∉ cache.verified) :
    verifiedOr cache copy rehash = (rehash (), { cache with rehashed := cache.rehashed + 1 }) :=
  verifiedOr_of_not_mem cache copy rehash hNotCached

/-- Marking a snapshot records its token in `verified` without changing `reused` or `rehashed`. -/
theorem markVerifiedSnapshot_mem {α : Type} (cache : SnapshotCache)
    (frozen : List SnapshotToken) (snapshot : Snapshot α)
    (graph : ObjectGraph := [(snapshot.token, [])]) :
    let (cache', _) := markVerifiedSnapshot cache frozen snapshot graph
    snapshot.token ∈ cache'.verified ∧
      cache'.reused = cache.reused ∧ cache'.rehashed = cache.rehashed := by
  simp only [markVerifiedSnapshot]
  split
  · rename_i hmem
    exact ⟨List.contains_iff_mem.mp hmem, trivial, trivial⟩
  · exact ⟨by simp, trivial, trivial⟩

private theorem findChildren_mem {t : SnapshotToken} {g : ObjectGraph} {cs : List SnapshotToken}
    (h : findChildren t g = some cs) : ∃ p ∈ g, p.1 = t := by
  induction g with
  | nil => simp [findChildren] at h
  | cons hd tl ih =>
    rcases hd with ⟨k, children⟩
    simp only [findChildren] at h
    split at h
    · rename_i heq; exact ⟨(k, children), by simp, beq_iff_eq.mp heq⟩
    · obtain ⟨p, hp, hp1⟩ := ih h
      exact ⟨p, by simp [hp], hp1⟩

private theorem eraseToken_mem {t : SnapshotToken} {g : ObjectGraph}
    {p : SnapshotToken × List SnapshotToken} (hp : p ∈ eraseToken t g) : p ∈ g := by
  induction g with
  | nil => simp [eraseToken] at hp
  | cons hd tl ih =>
    rcases hd with ⟨k, children⟩
    simp only [eraseToken] at hp
    split at hp
    · simp [ih hp]
    · simp only [List.mem_cons] at hp
      rcases hp with rfl | htl
      · simp
      · simp [ih htl]

private theorem freezeListImpl_spec (ts : List SnapshotToken) (remaining : ObjectGraph)
    (frozen : List SnapshotToken) (froze : Nat) :
    (∀ p ∈ (freezeListImpl ts remaining frozen froze).1.1, p ∈ remaining) ∧
    (∀ x ∈ frozen, x ∈ (freezeListImpl ts remaining frozen froze).1.2.1) ∧
    ((∀ p ∈ remaining, p.1 ∈ frozen) →
      (freezeListImpl ts remaining frozen froze).1.2 = (frozen, froze)) := by
  match ts with
  | [] =>
    simp [freezeListImpl]
  | t :: rest =>
    simp only [freezeListImpl]
    split
    · exact freezeListImpl_spec rest remaining frozen froze
    · rename_i children hfind
      have hlt : (eraseToken t remaining).length < remaining.length := eraseToken_length_lt hfind
      have ih1 := freezeListImpl_spec children (eraseToken t remaining) frozen froze
      set r1 := freezeListImpl children (eraseToken t remaining) frozen froze
      set frozen1 := r1.1.2.1
      set froze1 := r1.1.2.2
      set froze2 := if frozen1.contains t then froze1 else froze1 + 1
      set frozen2 := if frozen1.contains t then frozen1 else t :: frozen1
      have hlt2 : r1.1.1.length < remaining.length := Nat.lt_of_le_of_lt r1.2 hlt
      have ih2 := freezeListImpl_spec rest r1.1.1 frozen2 froze2
      refine ⟨?_, ?_, ?_⟩
      · intro p hp
        exact eraseToken_mem (ih1.1 p (ih2.1 p hp))
      · intro x hx
        apply ih2.2.1
        have hx1 := ih1.2.1 x hx
        dsimp only [frozen2]
        split
        · exact hx1
        · simp [hx1]
      · intro hall
        have hall1 : ∀ p ∈ eraseToken t remaining, p.1 ∈ frozen :=
          fun p hp => hall p (eraseToken_mem hp)
        have hr1 : r1.1.2 = (frozen, froze) := ih1.2.2 hall1
        have hf1 : frozen1 = frozen := congrArg Prod.fst hr1
        have hc1 : froze1 = froze := congrArg Prod.snd hr1
        obtain ⟨p, hp, hp1⟩ := findChildren_mem hfind
        have ht : t ∈ frozen := hp1 ▸ hall p hp
        have hf2 : frozen2 = frozen := by simp [frozen2, hf1, ht]
        have hc2 : froze2 = froze := by simp [froze2, hc1, hf1, ht]
        have hgoal := ih2.2.2 (fun p hp' => hf2 ▸ hall p (eraseToken_mem (ih1.1 p hp')))
        rw [hf2, hc2] at hgoal
        change (freezeListImpl rest r1.1.1 frozen2 froze2).1.2 = (frozen, froze)
        rw [hf2, hc2]
        exact hgoal
termination_by (remaining.length, ts.length)

/-- Re-marking a snapshot whose reachable object graph is already frozen leaves `froze` and
`frozen` unchanged. -/
theorem markVerifiedSnapshot_idempotent_froze {α : Type} (cache : SnapshotCache)
    (frozen : List SnapshotToken) (snapshot : Snapshot α) (graph : ObjectGraph)
    (hAllFrozen : ∀ p ∈ graph, p.1 ∈ frozen) :
    let (cache', frozen') := markVerifiedSnapshot cache frozen snapshot graph
    cache'.froze = cache.froze ∧ frozen' = frozen := by
  simp only [markVerifiedSnapshot, freezeDeep]
  have h := (freezeListImpl_spec [snapshot.token] graph frozen cache.froze).2.2 hAllFrozen
  have hf : (freezeListImpl [snapshot.token] graph frozen cache.froze).1.2.1 = frozen :=
    congrArg Prod.fst h
  have hc : (freezeListImpl [snapshot.token] graph frozen cache.froze).1.2.2 = cache.froze :=
    congrArg Prod.snd h
  exact ⟨hc, hf⟩

/-! ## Reachable traces and proviso counterexamples -/

/-- Runtime state pairing `SnapshotCache` with frozen heap tokens, current token payloads (`heap`),
and the ghost payload recorded when a token was marked (`markedValue`). -/
structure TraceState (α : Type) where
  cache : SnapshotCache
  frozen : List SnapshotToken
  heap : SnapshotToken → Option α
  markedValue : SnapshotToken → Option α

/-- Initial empty runtime state. -/
def TraceState.empty {α : Type} : TraceState α :=
  { cache := SnapshotCache.empty, frozen := [], heap := fun _ => none, markedValue := fun _ => none }

/-- Both provisos hold on a runtime state: every cached token was verified at mark time, and its
current heap payload still equals that mark-time payload. -/
def TraceState.Sound {α : Type} (verify : α → Bool) (st : TraceState α) : Prop :=
  (∀ t ∈ st.cache.verified, ∃ v₀, st.markedValue t = some v₀ ∧ verify v₀ = true) ∧
  (∀ t ∈ st.cache.verified, ∀ v₀, st.markedValue t = some v₀ → st.heap t = some v₀)

/-- Admissible execution steps when snapshots are marked only after verifying and never mutate
afterwards. -/
inductive SafeStep {α : Type} (verify : α → Bool) : TraceState α → TraceState α → Prop where
  | mutateUnmarked (st : TraceState α) (t : SnapshotToken) (v' : α)
      (hNotCached : t ∉ st.cache.verified) :
      SafeStep verify st { st with heap := fun k => if k == t then some v' else st.heap k }
  | mark (st : TraceState α) (s : Snapshot α) (graph : ObjectGraph)
      (hHeap : st.heap s.token = some s.value) (hVerify : verify s.value = true) :
      SafeStep verify st
        (let res := markVerifiedSnapshot st.cache st.frozen s graph
         { st with
           cache := res.1
           frozen := res.2
           markedValue := fun k =>
             if st.cache.verified.contains k then st.markedValue k
             else if k == s.token then some s.value
             else st.markedValue k })
  | check (st : TraceState α) (s : Snapshot α) (rehash : Unit → Bool) :
      SafeStep verify st { st with cache := (verifiedOr st.cache s rehash).2 }

/-- Multi-step execution from `TraceState.empty` under `SafeStep`. -/
inductive SafeTrace {α : Type} (verify : α → Bool) : TraceState α → Prop where
  | init : SafeTrace verify TraceState.empty
  | step {st st' : TraceState α} : SafeTrace verify st → SafeStep verify st st' → SafeTrace verify st'

private theorem safeStep_sound {α : Type} {verify : α → Bool} {st st' : TraceState α}
    (hs : st.Sound verify) (hstep : SafeStep verify st st') : st'.Sound verify := by
  cases hstep with
  | mutateUnmarked t v' hNotCached =>
    refine ⟨hs.1, fun k hk v₀ hv₀ => ?_⟩
    have hne : (k == t) = false := beq_false_of_ne (fun heq => hNotCached (heq ▸ hk))
    simpa [hne] using hs.2 k hk v₀ hv₀
  | mark s graph hHeap hVerify =>
    simp only [TraceState.Sound, markVerifiedSnapshot]
    constructor
    · intro k hk
      split at hk
      · have hkc : st.cache.verified.contains k = true := List.contains_iff_mem.mpr hk
        simp only [hkc, ↓reduceIte]
        exact hs.1 k hk
      · simp only [List.mem_cons] at hk
        rcases hk with rfl | hk'
        · rename_i hnot
          simp only [hnot, Bool.false_eq_true, ↓reduceIte, beq_self_eq_true]
          exact ⟨s.value, rfl, hVerify⟩
        · have hkc : st.cache.verified.contains k = true := List.contains_iff_mem.mpr hk'
          simp only [hkc, ↓reduceIte]
          exact hs.1 k hk'
    · intro k hk v₀ hv₀
      split at hk
      · have hkc : st.cache.verified.contains k = true := List.contains_iff_mem.mpr hk
        simp only [hkc, ↓reduceIte] at hv₀
        exact hs.2 k hk v₀ hv₀
      · simp only [List.mem_cons] at hk
        rcases hk with rfl | hk'
        · rename_i hnot
          simp only [hnot, Bool.false_eq_true, ↓reduceIte, beq_self_eq_true] at hv₀
          cases hv₀
          exact hHeap
        · have hkc : st.cache.verified.contains k = true := List.contains_iff_mem.mpr hk'
          simp only [hkc, ↓reduceIte] at hv₀
          exact hs.2 k hk' v₀ hv₀
  | check s rehash =>
    have hver : (verifiedOr st.cache s rehash).2.verified = st.cache.verified := by
      unfold verifiedOr; split <;> rfl
    exact ⟨fun k hk => hs.1 k (hver ▸ hk), fun k hk => hs.2 k (hver ▸ hk)⟩

private theorem safeTrace_sound {α : Type} {verify : α → Bool} {st : TraceState α}
    (htr : SafeTrace verify st) : st.Sound verify := by
  induction htr with
  | init => exact ⟨fun _ h => by simp [TraceState.empty, SnapshotCache.empty] at h,
                   fun _ h => by simp [TraceState.empty, SnapshotCache.empty] at h⟩
  | step _ hstep ih => exact safeStep_sound ih hstep

/-- Along any execution trace where snapshots are marked only after verifying and never mutate
afterwards, `verifiedOr` always answers what full rehashing (`verify`) answers. -/
theorem safeTrace_verifiedOr_eq_rehash {α : Type} {verify : α → Bool} {st : TraceState α}
    (htr : SafeTrace verify st) (s : Snapshot α) (rehash : Unit → Bool)
    (hHeap : st.heap s.token = some s.value) (hRehash : rehash () = verify s.value) :
    (verifiedOr st.cache s rehash).1 = verify s.value := by
  have hs := safeTrace_sound htr
  refine verifiedOr_eq_rehash st.cache s rehash verify st.markedValue hRehash hs.1 ?_
  intro hmem v₀ hv₀
  have := hs.2 s.token hmem v₀ hv₀
  rw [hHeap] at this
  exact Option.some.inj this

/-- Without Proviso 1 (verify before marking), `markVerifiedSnapshot` lets `verifiedOr` return
`true` on an unverified snapshot whose `rehash` returns `false`. -/
theorem counterexample_unverified_mark :
    let verify : Nat → Bool := fun n => decide (n == 1)
    let bad : Snapshot Nat := { token := 1, value := 0 }
    let (cache', _) := markVerifiedSnapshot SnapshotCache.empty [] bad
    verify bad.value = false ∧
      (verifiedOr cache' bad (fun () => verify bad.value)).1 ≠ verify bad.value := by
  decide

/-- Without Proviso 2 (immutable after marking), mutating a verified snapshot's payload causes
`verifiedOr` to return `true` even when rehashing the mutated payload returns `false`. -/
theorem counterexample_mutated_after_mark :
    let verify : Nat → Bool := fun n => decide (n == 1)
    let good : Snapshot Nat := { token := 1, value := 1 }
    let (cache', _) := markVerifiedSnapshot SnapshotCache.empty [] good
    let mutated : Snapshot Nat := { token := 1, value := 0 }
    verify good.value = true ∧ verify mutated.value = false ∧
      (verifiedOr cache' mutated (fun () => verify mutated.value)).1 ≠ verify mutated.value := by
  decide

end Rastrata.Kernel

/-
In-memory append-only history views: the Lean model of `packages/kernel/src/book-history.ts`
(lines 1 to 277: `HistoryView`, `Shape`, `Keyed`, `First`, `Store`, `Log`, `shapeOf`, `logOf`).

Three layers, as everywhere in this project:

1. Model: `HistoryView`, `Log`, `Store`, `Shape`, `Keyed`, `First`, `shapeOf`, and `logOf`, using an
   explicit `HistoryHeap` to faithfully capture shared mutable `Store` backing, lazy `#array`
   materialization, and `Shape.views` (`WeakMap`) caching.
2. Meaning: `Log.toList` gives the list of elements visible to a log, oldest first
   (`store.items.take log.length`). `HistoryHeap.WF` and `Log.WF` capture constructible invariants.
3. Laws: every `Log` operation agrees with the corresponding `List` operation on `toList`; `append`
   adds items at the end and leaves prior elements unchanged; appending to a later log extends the
   shared store in place without changing any earlier log's `toList`; branching from an older log
   copies its prefix to a fresh store without corrupting any newer log.

Omitted and why:

- `historyStats` (line 65): process-wide counters (`materialized`, `indexed`, `copied`) for tests
  and benchmarks only; none of the semantic, sharing, or branching laws depend on them.
- `JOURNALS`, `REVISIONS`, `RETAINED` (lines 243 to 260), `JOURNAL_LISTS`, `REVISION_LISTS`,
  `PROTOCOLS` (lines 279 to 281), and `journalsOf` through `bookHistoryMaterializations`
  (lines 287 to 396): depend on `BookState`, `BookedJournal`, `RevisionRecord`,
  `RetainedCommandResult`, and `BookProtocolState` from `book.ts`, which are not modelled yet.
-/
import Rastrata.Prelude

namespace Rastrata.Kernel

/-- Errors thrown by `Log` lookups (`RangeError` on unknown lookup name, or key extractor error). -/
inductive HistoryErr where
  | unknownLookup (name : String)
  | keyExtractionFailed (detail : String)
  deriving DecidableEq, Repr, Inhabited

/-- `HistoryView<T>`: read access to a growing list without materializing it as an array. -/
structure HistoryView (T : Type) : Type 1 where
  /-- `HistoryView.length`. -/
  length : Nat
  /-- `HistoryView.at`. Models `Math.trunc(Number(position)) || 0` on integer positions. -/
  atPos : Int → Option T
  /-- `HistoryView.map`. -/
  map : {U : Type} → (T → Nat → U) → List U

/-- `Array.prototype.at` semantics on a `List` for integer positions. -/
def listAt {T : Type} (xs : List T) (position : Int) : Option T :=
  let index := if position < 0 then (xs.length : Int) + position else position
  if 0 ≤ index ∧ index < (xs.length : Int) then xs[index.toNat]? else none

/-- Index-aware map over a `List`, matching `Array.prototype.map((item, position) => ...)`. -/
def listMapIdx {T U : Type} (xs : List T) (transform : T → Nat → U) : List U :=
  go xs 0 []
where
  go : List T → Nat → List U → List U
    | [], _, acc => acc.reverse
    | x :: rest, pos, acc => go rest (pos + 1) (transform x pos :: acc)

/-- A plain list implements `HistoryView` (`"A plain array is one"`). -/
def listHistoryView {T : Type} (xs : List T) : HistoryView T where
  length := xs.length
  atPos := listAt xs
  map := listMapIdx xs

/-- Association-list lookup modelling `Map.prototype.get` and `WeakMap.prototype.get`. -/
def mapGet {K V : Type} [BEq K] (m : List (K × V)) (k : K) : Option V :=
  match m with
  | [] => none
  | (k', v) :: rest => if k' == k then some v else mapGet rest k

/-- Association-list update modelling `Map.prototype.set` and `WeakMap.prototype.set`. -/
def mapSet {K V : Type} [BEq K] (m : List (K × V)) (k : K) (v : V) : List (K × V) :=
  match m with
  | [] => [(k, v)]
  | (k', v') :: rest => if k' == k then (k, v) :: rest else (k', v') :: mapSet rest k v

/-- Positions in `Keyed.positions`: a single position (`number`) or a list (`number[]`). -/
inductive KeyPositions where
  | single (pos : Nat)
  | many (positions : List Nat)
  deriving DecidableEq, Repr, Inhabited

/-- All stored positions in order. -/
def KeyPositions.toList : KeyPositions → List Nat
  | .single pos => [pos]
  | .many ps => ps

/-- `Keyed` (`book-history.ts` lines 46–49): named index over `store.items[0 .. through - 1]`. -/
structure Keyed where
  positions : List (String × KeyPositions)
  through : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `First` (`book-history.ts` lines 51–54): cached first-match scan state. -/
structure First where
  found : Option Nat
  scanned : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `Store<T>` (`book-history.ts` lines 56–62): append-only backing array and its caches. -/
structure Store (T : Type) where
  items : List T
  owned : Bool
  keyed : List (String × Keyed)
  firsts : List (String × First)
  deriving DecidableEq, Repr

instance {T : Type} : Inhabited (Store T) where
  default := ⟨[], false, [], []⟩

/-- Object identity of a JavaScript array in `HistoryHeap`. -/
abbrev ArrayId := Nat

/-- Object identity of a `Store<T>` in `HistoryHeap`. -/
abbrev StoreId := Nat

/-- Object identity of a `Shape<T>`'s `views` `WeakMap` in `HistoryHeap`. -/
abbrev ShapeId := Nat

/-- Object identity of a `Log<T>` instance (for its mutable `#array` slot) in `HistoryHeap`. -/
abbrev LogId := Nat

/-- A JavaScript array in `HistoryHeap`, recording its elements and whether it is frozen. -/
structure JsArray (T : Type) where
  items : List T
  frozen : Bool
  deriving DecidableEq, Repr

instance {T : Type} : Inhabited (JsArray T) where
  default := ⟨[], true⟩

/-- `Shape<T>` (`book-history.ts` lines 39–44): handle identifying a shape's key extractors and `views` map in `HistoryHeap`. -/
structure Shape (T : Type) where
  id : ShapeId
  deriving DecidableEq, Repr, Inhabited

/-- `Log<T>` (`book-history.ts` lines 73–84): length-limited view over a shared `Store<T>`. -/
structure Log (T : Type) where
  id : LogId
  shape : Shape T
  store : StoreId
  length : Nat
  deriving DecidableEq, Repr, Inhabited

/-- Explicit heap modelling mutable `Store`s, JavaScript arrays, `Shape.keys`/`Shape.views`, and `Log.#array`.
`storeShapes` tracks the allocating `Shape` of each `StoreId` for invariants (never read by runtime operations). -/
structure HistoryHeap (T : Type) where
  stores : List (Store T)
  storeShapes : List (Shape T)
  arrays : List (JsArray T)
  shapeKeys : List (String → Option (T → Except HistoryErr (List String)))
  views : List (List (ArrayId × Log T))
  logArrays : List (Option ArrayId)

/-- Empty history heap. -/
def HistoryHeap.empty {T : Type} : HistoryHeap T :=
  ⟨[], [], [], [], [], []⟩

/-- `shapeOf` (`book-history.ts` lines 239–241): create a `Shape<T>` with an empty `views` map. -/
def shapeOf {T : Type} (h : HistoryHeap T)
    (keys : String → Option (T → Except HistoryErr (List String))) : HistoryHeap T × Shape T :=
  ({ h with shapeKeys := h.shapeKeys ++ [keys], views := h.views ++ [[]] }, ⟨h.views.length⟩)

namespace HistoryHeap

/-- Read the key extractors of a `ShapeId`. -/
def getShapeKeys {T : Type} (h : HistoryHeap T) (shid : ShapeId) :
    String → Option (T → Except HistoryErr (List String)) :=
  (h.shapeKeys[shid]?).getD (fun _ => none)

/-- Read a `Store<T>` by `StoreId` (defaulting only outside `WF`). -/
def getStore {T : Type} (h : HistoryHeap T) (sid : StoreId) : Store T :=
  (h.stores[sid]?).getD default

/-- Update a `Store<T>` in place at `sid`. -/
def setStore {T : Type} (h : HistoryHeap T) (sid : StoreId) (s : Store T) : HistoryHeap T :=
  { h with stores := h.stores.set sid s }

/-- Read the allocating `Shape` of a `StoreId` (invariant metadata only). -/
def getStoreShape {T : Type} (h : HistoryHeap T) (sid : StoreId) : Shape T :=
  (h.storeShapes[sid]?).getD default

/-- Allocate a fresh `Store<T>` in the heap, recording its owning `Shape`. -/
def allocStore {T : Type} (h : HistoryHeap T) (s : Store T) (shape : Shape T) :
    HistoryHeap T × StoreId :=
  ({ h with stores := h.stores ++ [s], storeShapes := h.storeShapes ++ [shape] }, h.stores.length)

/-- Read a `JsArray` by `ArrayId` (defaulting only outside `WF`). -/
def getArray {T : Type} (h : HistoryHeap T) (aid : ArrayId) : JsArray T :=
  (h.arrays[aid]?).getD default

/-- Allocate a fresh JavaScript array in the heap. -/
def allocArray {T : Type} (h : HistoryHeap T) (items : List T) (frozen : Bool) :
    HistoryHeap T × ArrayId :=
  ({ h with arrays := h.arrays ++ [⟨items, frozen⟩] }, h.arrays.length)

/-- Mutate an unfrozen JavaScript array in the heap; frozen arrays are unchanged. -/
def mutateArray {T : Type} (h : HistoryHeap T) (aid : ArrayId) (items : List T) :
    HistoryHeap T :=
  let arr := h.getArray aid
  if arr.frozen then h else { h with arrays := h.arrays.set aid { arr with items := items } }

/-- Read the `views` `WeakMap` for `shid`. -/
def getViews {T : Type} (h : HistoryHeap T) (shid : ShapeId) : List (ArrayId × Log T) :=
  (h.views[shid]?).getD []

/-- Update the `views` `WeakMap` for `shid`. -/
def setViews {T : Type} (h : HistoryHeap T) (shid : ShapeId)
    (vs : List (ArrayId × Log T)) : HistoryHeap T :=
  { h with views := h.views.set shid vs }

/-- Read a `Log`'s cached `#array` slot. -/
def getLogArray {T : Type} (h : HistoryHeap T) (lid : LogId) : Option ArrayId :=
  (h.logArrays[lid]?).getD none

/-- Update a `Log`'s cached `#array` slot. -/
def setLogArray {T : Type} (h : HistoryHeap T) (lid : LogId) (aid : Option ArrayId) :
    HistoryHeap T :=
  { h with logArrays := h.logArrays.set lid aid }

/-- Allocate a fresh `Log` instance in the heap (`new Log(...)`). -/
def allocLog {T : Type} (h : HistoryHeap T) (shape : Shape T) (store : StoreId)
    (length : Nat) (arr : Option ArrayId := none) : HistoryHeap T × Log T :=
  ({ h with logArrays := h.logArrays ++ [arr] }, ⟨h.logArrays.length, shape, store, length⟩)

end HistoryHeap

namespace Log

/-- `Log.at` (`book-history.ts` lines 86–91). Models `Math.trunc(Number(position)) || 0` on integer positions. -/
def atPos {T : Type} (h : HistoryHeap T) (log : Log T) (position : Int) : Option T :=
  let index := if position < 0 then (log.length : Int) + position else position
  if 0 ≤ index ∧ index < (log.length : Int) then
    (h.getStore log.store).items[index.toNat]?
  else
    none

def branchPositions (through : Nat) :
    List (String × KeyPositions) → List (String × KeyPositions)
  | [] => []
  | (key, found) :: rest =>
    let tail := branchPositions through rest
    match found with
    | .single p => if p < through then (key, .single p) :: tail else tail
    | .many ps => (key, .many (ps.filter (· < through))) :: tail

def branchKeyed (len : Nat) : List (String × Keyed) → List (String × Keyed)
  | [] => []
  | (name, index) :: rest =>
    let through := min index.through len
    (name, ⟨branchPositions through index.positions, through⟩) :: branchKeyed len rest

def branchFirsts (len : Nat) : List (String × First) → List (String × First)
  | [] => []
  | (name, scan) :: rest =>
    let scan' : First :=
      match scan.found with
      | some f =>
        if f < len then ⟨some f, scan.scanned⟩
        else ⟨none, min scan.scanned len⟩
      | none => ⟨none, min scan.scanned len⟩
    (name, scan') :: branchFirsts len rest

/-- `Log.#branch` (`book-history.ts` lines 107–132). -/
def branch {T : Type} (h : HistoryHeap T) (log : Log T) : Store T :=
  let old := h.getStore log.store
  ⟨old.items.take log.length, true, branchKeyed log.length old.keyed, branchFirsts log.length old.firsts⟩

/-- `Log.append` (`book-history.ts` lines 93–102). -/
def append {T : Type} (h : HistoryHeap T) (log : Log T) (added : List T) :
    HistoryHeap T × Log T :=
  if added.isEmpty then (h, log)
  else
    let old := h.getStore log.store
    let (h1, sid, store) :=
      if !old.owned || old.items.length != log.length then
        let branched := log.branch h
        let (h1, sid) := h.allocStore branched log.shape
        (h1, sid, branched)
      else
        (h, log.store, old)
    let items' := store.items ++ added
    let store' := { store with items := items' }
    let h2 := h1.setStore sid store'
    h2.allocLog log.shape sid items'.length none

def mapSlice {T U : Type} (items : List T) (transform : T → Nat → U)
    (pos limit : Nat) (acc : List U) : List U :=
  if pos < limit then
    match items[pos]? with
    | some item => mapSlice items transform (pos + 1) limit (transform item pos :: acc)
    | none => acc.reverse
  else acc.reverse
termination_by limit - pos

/-- `Log.map` (`book-history.ts` lines 135–141). -/
def map {T U : Type} (h : HistoryHeap T) (log : Log T) (transform : T → Nat → U) : List U :=
  mapSlice (h.getStore log.store).items transform 0 log.length []

def filterSlice {T : Type} (items : List T) (test : T → Bool)
    (pos limit : Nat) (acc : List T) : List T :=
  if pos < limit then
    match items[pos]? with
    | some item =>
      let acc' := if test item then item :: acc else acc
      filterSlice items test (pos + 1) limit acc'
    | none => acc.reverse
  else acc.reverse
termination_by limit - pos

/-- `Log.filter` (`book-history.ts` lines 144–151). -/
def filter {T : Type} (h : HistoryHeap T) (log : Log T) (test : T → Bool) : List T :=
  filterSlice (h.getStore log.store).items test 0 log.length []

/-- View of a `Log` as a `HistoryView<T>` (`book-history.ts` line 73: `implements HistoryView<T>`). -/
def toHistoryView {T : Type} (h : HistoryHeap T) (log : Log T) : HistoryView T where
  length := log.length
  atPos := log.atPos h
  map := fun transform => log.map h transform

def scanFirst {T : Type} (items : List T) (test : T → Bool) (scan : First) : First :=
  match scan.found with
  | some _ => scan
  | none =>
    if _ : scan.scanned < items.length then
      match items[scan.scanned]? with
      | some item =>
        let found' := if test item then some scan.scanned else none
        scanFirst items test ⟨found', scan.scanned + 1⟩
      | none => scan
    else scan
termination_by items.length - scan.scanned

/-- `Log.firstWhere` (`book-history.ts` lines 173–186). -/
def firstWhere {T : Type} (h : HistoryHeap T) (log : Log T) (name : String)
    (test : T → Bool) : HistoryHeap T × Option T :=
  let store := h.getStore log.store
  let initial : First := (mapGet store.firsts name).getD ⟨none, 0⟩
  let updated := scanFirst store.items test initial
  let store' := { store with firsts := mapSet store.firsts name updated }
  let h' := h.setStore log.store store'
  let result :=
    match updated.found with
    | some idx => if idx < log.length then store.items[idx]? else none
    | none => none
  (h', result)

/-- `Log.array` (`book-history.ts` lines 189–197). -/
def array {T : Type} (h : HistoryHeap T) (log : Log T) : HistoryHeap T × ArrayId :=
  match h.getLogArray log.id with
  | some aid => (h, aid)
  | none =>
    let items := (h.getStore log.store).items.take log.length
    let (h1, aid) := h.allocArray items true
    let vs := mapSet (h1.getViews log.shape.id) aid log
    let h2 := (h1.setViews log.shape.id vs).setLogArray log.id (some aid)
    (h2, aid)

def addKeyPosition (positions : List (String × KeyPositions)) (key : String)
    (position : Nat) : List (String × KeyPositions) :=
  match mapGet positions key with
  | none => mapSet positions key (.single position)
  | some (.single found) =>
    if found != position then mapSet positions key (.many [found, position])
    else positions
  | some (.many found) =>
    if found.getLast? != some position then mapSet positions key (.many (found ++ [position]))
    else positions

def addKeysForPosition (positions : List (String × KeyPositions)) (keys : List String)
    (position : Nat) : List (String × KeyPositions) :=
  keys.foldl (fun acc k => addKeyPosition acc k position) positions

def indexStep {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (k : Keyed) :
    Keyed × Except HistoryErr Keyed :=
  if _ : k.through < items.length then
    match items[k.through]? with
    | some item =>
      match keysOf item with
      | .error e => (k, .error e)
      | .ok ks =>
        let positions' := addKeysForPosition k.positions ks k.through
        indexStep items keysOf ⟨positions', k.through + 1⟩
    | none => (k, .ok k)
  else (k, .ok k)
termination_by items.length - k.through

/-- `Log.#keyed` (`book-history.ts` lines 205–229). -/
def keyed {T : Type} (h : HistoryHeap T) (log : Log T) (name : String) :
    HistoryHeap T × Except HistoryErr Keyed :=
  match h.getShapeKeys log.shape.id name with
  | none => (h, .error (.unknownLookup name))
  | some keysOf =>
    let store := h.getStore log.store
    let initial : Keyed := (mapGet store.keyed name).getD ⟨[], 0⟩
    let (finalKeyed, res) := indexStep store.items keysOf initial
    let store' := { store with keyed := mapSet store.keyed name finalKeyed }
    (h.setStore log.store store', res)

/-- `Log.#firstPosition` (`book-history.ts` lines 199–203). -/
def firstPosition {T : Type} (h : HistoryHeap T) (log : Log T) (name key : String) :
    HistoryHeap T × Except HistoryErr (Option Nat) :=
  let (h', res) := log.keyed h name
  match res with
  | .error e => (h', .error e)
  | .ok k =>
    let pos? :=
      match mapGet k.positions key with
      | none => none
      | some (.single p) => some p
      | some (.many ps) => ps.head?
    let bounded :=
      match pos? with
      | some p => if p < log.length then some p else none
      | none => none
    (h', .ok bounded)

/-- `Log.first` (`book-history.ts` lines 154–157). -/
def first {T : Type} (h : HistoryHeap T) (log : Log T) (name key : String) :
    HistoryHeap T × Except HistoryErr (Option T) :=
  let (h', res) := log.firstPosition h name key
  match res with
  | .error e => (h', .error e)
  | .ok none => (h', .ok none)
  | .ok (some p) => (h', .ok ((h'.getStore log.store).items[p]?))

/-- `Log.has` (`book-history.ts` lines 159–161). -/
def has {T : Type} (h : HistoryHeap T) (log : Log T) (name key : String) :
    HistoryHeap T × Except HistoryErr Bool :=
  let (h', res) := log.firstPosition h name key
  (h', res.map Option.isSome)

/-- `Log.all` (`book-history.ts` lines 164–170). -/
def all {T : Type} (h : HistoryHeap T) (log : Log T) (name key : String) :
    HistoryHeap T × Except HistoryErr (List T) :=
  let (h', res) := log.keyed h name
  match res with
  | .error e => (h', .error e)
  | .ok k =>
    let positions : List Nat :=
      match mapGet k.positions key with
      | none => []
      | some (.single p) => [p]
      | some (.many ps) => ps
    let items := (h'.getStore log.store).items
    let out := (positions.filter (· < log.length)).filterMap (fun p => items[p]?)
    (h', .ok out)

/-- Meaning of a log: the list of its elements, oldest first (`store.items.take log.length`). -/
def toList {T : Type} (h : HistoryHeap T) (log : Log T) : List T :=
  (h.getStore log.store).items.take log.length

end Log

/-- `logOf` (`book-history.ts` lines 264–277). -/
def logOf {T : Type} (h : HistoryHeap T) (shape : Shape T) (aid : ArrayId) :
    HistoryHeap T × Log T :=
  match mapGet (h.getViews shape.id) aid with
  | some known => (h, known)
  | none =>
    let arr := h.getArray aid
    let store : Store T := ⟨arr.items, !arr.frozen, [], []⟩
    let (h1, sid) := h.allocStore store shape
    let cached := if arr.frozen then some aid else none
    let (h2, log) := h1.allocLog shape sid arr.items.length cached
    let h3 :=
      if arr.frozen then
        h2.setViews shape.id (mapSet (h2.getViews shape.id) aid log)
      else h2
    (h3, log)

/-! ## Meaning and well-formedness -/

/-- The list of stored positions for `key` in a `Keyed.positions` map (`[]` if absent). -/
def keyPositionsList (positions : List (String × KeyPositions)) (key : String) : List Nat :=
  match mapGet positions key with
  | none => []
  | some kp => kp.toList

/-- Positions `< items.length` where `keysOf` emits `key`, in ascending order. -/
def expectedPositions {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) : List Nat :=
  (List.range items.length).filter fun pos =>
    match items[pos]? with
    | some item =>
      match keysOf item with
      | .ok ks => ks.contains key
      | .error _ => false
    | none => false

/-- Invariant for a `Keyed` index relative to `items` and key extractor `keysOf`. -/
structure Keyed.WF {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (k : Keyed) : Prop where
  through_le : k.through ≤ items.length
  positions_nodup : (k.positions.map Prod.fst).Nodup
  positions_spec : ∀ key : String,
    keyPositionsList k.positions key = expectedPositions (items.take k.through) keysOf key

/-- Structural invariant for a `First` scan relative to `items`. -/
structure First.WF {T : Type} (items : List T) (f : First) : Prop where
  scanned_le : f.scanned ≤ items.length
  found_spec : ∀ idx, f.found = some idx → idx < f.scanned ∧ f.scanned = idx + 1

/-- Semantic agreement of a `First` scan with predicate `test` over `items`. -/
structure First.Matches {T : Type} (items : List T) (test : T → Bool) (f : First) : Prop extends
    First.WF items f where
  found_true : ∀ idx, f.found = some idx →
    ∃ item, items[idx]? = some item ∧ test item = true
  before_false : ∀ j, j < (match f.found with | some idx => idx | none => f.scanned) →
    ∀ item, items[j]? = some item → test item = false

/-- Structural invariant for a `Store<T>`. -/
structure Store.WF {T : Type} (s : Store T) : Prop where
  firsts_wf : ∀ name f, mapGet s.firsts name = some f → First.WF s.items f
  keyed_through_le : ∀ name k, mapGet s.keyed name = some k → k.through ≤ s.items.length

/-- Compatibility between a `Store<T>`'s cached `keyed` indices and a key extractor map. -/
def Store.MatchesShape {T : Type} (s : Store T)
    (keys : String → Option (T → Except HistoryErr (List String))) : Prop :=
  ∀ name k, mapGet s.keyed name = some k →
    ∃ keysOf, keys name = some keysOf ∧ Keyed.WF s.items keysOf k

/-- Well-formedness of a `Log<T>` against a `HistoryHeap<T>`. -/
structure Log.WF {T : Type} (h : HistoryHeap T) (log : Log T) : Prop where
  id_lt : log.id < h.logArrays.length
  shape_lt : log.shape.id < h.views.length
  store_lt : log.store < h.stores.length
  shape_eq : log.shape = h.getStoreShape log.store
  length_le : log.length ≤ (h.getStore log.store).items.length
  array_eq : ∀ aid, h.getLogArray log.id = some aid →
    aid < h.arrays.length ∧
    (h.getArray aid).frozen = true ∧
    (h.getArray aid).items = log.toList h

/-- Well-formedness of the entire `HistoryHeap<T>`. -/
structure HistoryHeap.WF {T : Type} (h : HistoryHeap T) : Prop where
  storeShapes_len : h.storeShapes.length = h.stores.length
  shapeKeys_len : h.shapeKeys.length = h.views.length
  stores_wf : ∀ sid, sid < h.stores.length →
    Store.WF (h.getStore sid) ∧
    Store.MatchesShape (h.getStore sid) (h.getShapeKeys (h.getStoreShape sid).id) ∧
    (h.getStoreShape sid).id < h.views.length
  logArrays_wf : ∀ lid aid, lid < h.logArrays.length → h.getLogArray lid = some aid →
    aid < h.arrays.length ∧ (h.getArray aid).frozen = true
  views_wf : ∀ shid aid l, shid < h.views.length →
    mapGet (h.getViews shid) aid = some l →
    aid < h.arrays.length ∧
    (h.getArray aid).frozen = true ∧
    l.shape.id = shid ∧
    Log.WF h l ∧
    h.getLogArray l.id = some aid ∧
    l.toList h = (h.getArray aid).items

/-! ## Helper lemmas -/

section Helpers

theorem mapGet_mapSet {K V : Type} [BEq K] [LawfulBEq K] (m : List (K × V)) (k k' : K) (v : V) :
    mapGet (mapSet m k v) k' = if k' == k then some v else mapGet m k' := by
  induction m with
  | nil =>
    simp only [mapSet, mapGet]
    by_cases h : k = k'
    · subst h; simp
    · have h1 : (k == k') = false := beq_false_of_ne h
      have h2 : (k' == k) = false := beq_false_of_ne (Ne.symm h)
      simp [h1, h2]
  | cons hd tl ih =>
    rcases hd with ⟨a, b⟩
    simp only [mapSet]
    by_cases ha : a = k
    · subst ha
      simp only [beq_self_eq_true, ↓reduceIte, mapGet]
      by_cases hk : a = k'
      · subst hk; simp
      · have h1 : (a == k') = false := beq_false_of_ne hk
        have h2 : (k' == a) = false := beq_false_of_ne (Ne.symm hk)
        simp [h1, h2]
    · have ha' : (a == k) = false := beq_false_of_ne ha
      simp only [ha', Bool.false_eq_true, ↓reduceIte, mapGet]
      by_cases hak : a = k'
      · subst hak
        have hk : (a == k) = false := beq_false_of_ne ha
        simp [hk]
      · have hak' : (a == k') = false := beq_false_of_ne hak
        simp [hak', ih]

theorem mapGet_mapSet_self {K V : Type} [BEq K] [LawfulBEq K] (m : List (K × V)) (k : K) (v : V) :
    mapGet (mapSet m k v) k = some v := by
  simp [mapGet_mapSet]

theorem mapGet_mapSet_ne {K V : Type} [BEq K] [LawfulBEq K] (m : List (K × V)) {k k' : K}
    (h : k' ≠ k) (v : V) : mapGet (mapSet m k v) k' = mapGet m k' := by
  simp [mapGet_mapSet, h]

theorem listGetD_append_lt {α : Type} [Inhabited α] (xs ys : List α) {i : Nat}
    (hi : i < xs.length) : (xs ++ ys)[i]?.getD default = xs[i]?.getD default := by
  rw [List.getElem?_append_left hi]

theorem listGetD_set_same {α : Type} [Inhabited α] (xs : List α) {i : Nat}
    (hi : i < xs.length) (x : α) : (xs.set i x)[i]?.getD default = x := by
  simp [List.getElem?_set_self hi]

theorem listGetD_set_ne {α : Type} [Inhabited α] (xs : List α) {i j : Nat}
    (hij : i ≠ j) (x : α) : (xs.set i x)[j]?.getD default = xs[j]?.getD default := by
  rw [List.getElem?_set_ne hij]

@[simp] theorem getStore_setStore_same {T : Type} (h : HistoryHeap T) {sid : StoreId}
    (hs : sid < h.stores.length) (s : Store T) : (h.setStore sid s).getStore sid = s := by
  simp [HistoryHeap.getStore, HistoryHeap.setStore, listGetD_set_same _ hs]

@[simp] theorem getStore_setStore_ne {T : Type} (h : HistoryHeap T) {sid sid' : StoreId}
    (hne : sid ≠ sid') (s : Store T) : (h.setStore sid s).getStore sid' = h.getStore sid' := by
  simp [HistoryHeap.getStore, HistoryHeap.setStore, listGetD_set_ne _ hne]

@[simp] theorem getStore_allocStore_same {T : Type} (h : HistoryHeap T) (s : Store T)
    (sh : Shape T) : (h.allocStore s sh).1.getStore (h.allocStore s sh).2 = s := by
  simp [HistoryHeap.getStore, HistoryHeap.allocStore]

@[simp] theorem getStore_allocStore_lt {T : Type} (h : HistoryHeap T) (s : Store T)
    (sh : Shape T) {sid : StoreId} (hs : sid < h.stores.length) :
    (h.allocStore s sh).1.getStore sid = h.getStore sid := by
  simp [HistoryHeap.getStore, HistoryHeap.allocStore, listGetD_append_lt _ _ hs]

@[simp] theorem getStoreShape_allocStore_same {T : Type} (h : HistoryHeap T) (s : Store T)
    (sh : Shape T) (hlen : h.storeShapes.length = h.stores.length) :
    (h.allocStore s sh).1.getStoreShape (h.allocStore s sh).2 = sh := by
  simp [HistoryHeap.getStoreShape, HistoryHeap.allocStore, ← hlen]

@[simp] theorem getStoreShape_allocStore_lt {T : Type} (h : HistoryHeap T) (s : Store T)
    (sh : Shape T) {sid : StoreId} (hs : sid < h.storeShapes.length) :
    (h.allocStore s sh).1.getStoreShape sid = h.getStoreShape sid := by
  simp [HistoryHeap.getStoreShape, HistoryHeap.allocStore, listGetD_append_lt _ _ hs]

@[simp] theorem getLogArray_allocLog_same {T : Type} (h : HistoryHeap T) (sh : Shape T)
    (sid : StoreId) (len : Nat) (arr : Option ArrayId) :
    (h.allocLog sh sid len arr).1.getLogArray (h.allocLog sh sid len arr).2.id = arr := by
  simp [HistoryHeap.getLogArray, HistoryHeap.allocLog]

@[simp] theorem getLogArray_allocLog_lt {T : Type} (h : HistoryHeap T) (sh : Shape T)
    (sid : StoreId) (len : Nat) (arr : Option ArrayId) {lid : LogId}
    (hl : lid < h.logArrays.length) :
    (h.allocLog sh sid len arr).1.getLogArray lid = h.getLogArray lid := by
  simp [HistoryHeap.getLogArray, HistoryHeap.allocLog, List.getElem?_append_left hl]

@[simp] theorem getLogArray_setLogArray_same {T : Type} (h : HistoryHeap T) {lid : LogId}
    (hl : lid < h.logArrays.length) (arr : Option ArrayId) :
    (h.setLogArray lid arr).getLogArray lid = arr := by
  simp [HistoryHeap.getLogArray, HistoryHeap.setLogArray, List.getElem?_set_self hl]

@[simp] theorem getLogArray_setLogArray_ne {T : Type} (h : HistoryHeap T) {lid lid' : LogId}
    (hne : lid ≠ lid') (arr : Option ArrayId) :
    (h.setLogArray lid arr).getLogArray lid' = h.getLogArray lid' := by
  simp [HistoryHeap.getLogArray, HistoryHeap.setLogArray, List.getElem?_set_ne hne]

@[simp] theorem getViews_setViews_same {T : Type} (h : HistoryHeap T) {shid : ShapeId}
    (hs : shid < h.views.length) (vs : List (ArrayId × Log T)) :
    (h.setViews shid vs).getViews shid = vs := by
  simp [HistoryHeap.getViews, HistoryHeap.setViews, List.getElem?_set_self hs]

@[simp] theorem getViews_setViews_ne {T : Type} (h : HistoryHeap T) {shid shid' : ShapeId}
    (hne : shid ≠ shid') (vs : List (ArrayId × Log T)) :
    (h.setViews shid vs).getViews shid' = h.getViews shid' := by
  simp [HistoryHeap.getViews, HistoryHeap.setViews, List.getElem?_set_ne hne]

@[simp] theorem getArray_allocArray_same {T : Type} (h : HistoryHeap T) (items : List T)
    (frozen : Bool) :
    (h.allocArray items frozen).1.getArray (h.allocArray items frozen).2 = ⟨items, frozen⟩ := by
  simp [HistoryHeap.getArray, HistoryHeap.allocArray]

@[simp] theorem getArray_allocArray_lt {T : Type} (h : HistoryHeap T) (items : List T)
    (frozen : Bool) {aid : ArrayId} (ha : aid < h.arrays.length) :
    (h.allocArray items frozen).1.getArray aid = h.getArray aid := by
  simp [HistoryHeap.getArray, HistoryHeap.allocArray, listGetD_append_lt _ _ ha]

theorem mapGet_none_iff_not_mem_fst {K V : Type} [BEq K] [LawfulBEq K]
    (m : List (K × V)) (k : K) : mapGet m k = none ↔ k ∉ m.map Prod.fst := by
  induction m with
  | nil => simp [mapGet]
  | cons hd tl ih =>
    rcases hd with ⟨a, b⟩
    simp only [mapGet, List.map_cons, List.mem_cons, not_or]
    by_cases h : a = k
    · subst h; simp
    · have hb : (a == k) = false := beq_false_of_ne h
      simp [hb, ih, Ne.symm h]

theorem mapSet_fst_mem {K V : Type} [BEq K] [LawfulBEq K] (m : List (K × V)) (k : K) (v : V)
    {x : K} (hx : x ∈ (mapSet m k v).map Prod.fst) : x ∈ m.map Prod.fst ∨ x = k := by
  induction m with
  | nil =>
    simp only [mapSet, List.map_cons, List.map_nil, List.mem_singleton] at hx
    exact Or.inr hx
  | cons hd tl ih =>
    rcases hd with ⟨a, b⟩
    simp only [mapSet] at hx
    by_cases h : a = k
    · subst h
      simp only [beq_self_eq_true, ↓reduceIte, List.map_cons, List.mem_cons] at hx
      rcases hx with rfl | hx
      · right; rfl
      · left; simp [hx]
    · have hb : (a == k) = false := beq_false_of_ne h
      simp only [hb, Bool.false_eq_true, ↓reduceIte, List.map_cons, List.mem_cons] at hx
      rcases hx with rfl | hx
      · left; simp
      · rcases ih hx with h1 | h2
        · left; simp [h1]
        · right; exact h2

theorem mapSet_nodup {K V : Type} [BEq K] [LawfulBEq K] (m : List (K × V)) (k : K) (v : V)
    (hnd : (m.map Prod.fst).Nodup) : ((mapSet m k v).map Prod.fst).Nodup := by
  induction m with
  | nil => simp [mapSet]
  | cons hd tl ih =>
    rcases hd with ⟨a, b⟩
    simp only [List.map_cons, List.nodup_cons] at hnd
    simp only [mapSet]
    by_cases h : a = k
    · subst h
      simp [hnd.1, hnd.2]
    · have hb : (a == k) = false := beq_false_of_ne h
      simp only [hb, Bool.false_eq_true, ↓reduceIte, List.map_cons, List.nodup_cons]
      refine ⟨?_, ih hnd.2⟩
      intro hmem
      rcases mapSet_fst_mem tl k v hmem with h1 | h2
      · exact hnd.1 h1
      · exact h h2

theorem branchPositions_fst_mem (through : Nat) (m : List (String × KeyPositions))
    {x : String} (hx : x ∈ (Log.branchPositions through m).map Prod.fst) :
    x ∈ m.map Prod.fst := by
  induction m with
  | nil => simp [Log.branchPositions] at hx
  | cons hd tl ih =>
    rcases hd with ⟨k, found⟩
    simp only [Log.branchPositions] at hx
    cases found with
    | single p =>
      by_cases hp : p < through
      · simp only [hp, ↓reduceIte, List.map_cons, List.mem_cons] at hx
        rcases hx with rfl | hx
        · simp
        · simp [ih hx]
      · simp only [hp, ↓reduceIte] at hx
        simp [ih hx]
    | many ps =>
      simp only [List.map_cons, List.mem_cons] at hx
      rcases hx with rfl | hx
      · simp
      · simp [ih hx]

theorem branchPositions_nodup (through : Nat) (m : List (String × KeyPositions))
    (hnd : (m.map Prod.fst).Nodup) : ((Log.branchPositions through m).map Prod.fst).Nodup := by
  induction m with
  | nil => simp [Log.branchPositions]
  | cons hd tl ih =>
    rcases hd with ⟨k, found⟩
    simp only [List.map_cons, List.nodup_cons] at hnd
    simp only [Log.branchPositions]
    cases found with
    | single p =>
      dsimp only
      split_ifs
      · simp only [List.map_cons, List.nodup_cons]
        exact ⟨fun hm => hnd.1 (branchPositions_fst_mem through tl hm), ih hnd.2⟩
      · exact ih hnd.2
    | many ps =>
      dsimp only
      simp only [List.map_cons, List.nodup_cons]
      exact ⟨fun hm => hnd.1 (branchPositions_fst_mem through tl hm), ih hnd.2⟩

theorem keyPositionsList_branchPositions (through : Nat) (m : List (String × KeyPositions))
    (hnd : (m.map Prod.fst).Nodup) (key : String) :
    keyPositionsList (Log.branchPositions through m) key =
      (keyPositionsList m key).filter (· < through) := by
  induction m with
  | nil => simp [Log.branchPositions, keyPositionsList, mapGet]
  | cons hd tl ih =>
    rcases hd with ⟨k, found⟩
    simp only [List.map_cons, List.nodup_cons] at hnd
    simp only [Log.branchPositions, keyPositionsList, mapGet]
    by_cases hk : k = key
    · subst hk
      cases found with
      | single p =>
        dsimp only
        by_cases hp : p < through
        · simp [hp, mapGet, KeyPositions.toList]
        · have hnot : k ∉ (Log.branchPositions through tl).map Prod.fst :=
            fun hm => hnd.1 (branchPositions_fst_mem through tl hm)
          have hnone : mapGet (Log.branchPositions through tl) k = none :=
            (mapGet_none_iff_not_mem_fst _ _).mpr hnot
          simp [hp, KeyPositions.toList, hnone]
      | many ps =>
        simp [mapGet, KeyPositions.toList]
    · have hne : (k == key) = false := beq_false_of_ne hk
      cases found with
      | single p =>
        dsimp only
        by_cases hp : p < through
        · simp [hp, mapGet, hne, keyPositionsList] at ih ⊢
          exact ih hnd.2
        · simp [hp, hne, keyPositionsList] at ih ⊢
          exact ih hnd.2
      | many ps =>
        dsimp only
        simp [mapGet, hne, keyPositionsList] at ih ⊢
        exact ih hnd.2

theorem list_filter_range_lt (P : Nat → Bool) (a m : Nat) :
    ((List.range a).filter P).filter (· < m) = (List.range (min a m)).filter P := by
  induction a with
  | zero => simp
  | succ a ih =>
    rw [List.range_succ, List.filter_append, List.filter_append]
    by_cases ham : a < m
    · have hmin : min (a + 1) m = min a m + 1 := by omega
      have hmin2 : min a m = a := by omega
      rw [hmin, List.range_succ, List.filter_append, ih, hmin2]
      by_cases hpa : P a = true <;> simp [hpa, ham]
    · have hmin : min (a + 1) m = min a m := by omega
      rw [hmin, ih]
      by_cases hpa : P a = true <;> simp [hpa, ham]

theorem expectedPositions_lt {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String)
    {p : Nat} (hp : p ∈ expectedPositions items keysOf key) : p < items.length := by
  simp only [expectedPositions, List.mem_filter, List.mem_range] at hp
  exact hp.1

theorem expectedPositions_take_eq {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) (k : Nat) :
    expectedPositions (items.take k) keysOf key =
      (List.range (min k items.length)).filter fun pos =>
        match items[pos]? with
        | some item =>
          match keysOf item with
          | .ok ks => ks.contains key
          | .error _ => false
        | none => false := by
  simp only [expectedPositions, List.length_take]
  apply List.filter_congr
  intro pos hpos
  simp only [List.mem_range] at hpos
  rw [List.getElem?_take_of_lt (by omega)]

theorem expectedPositions_take_filter {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) (n m : Nat) :
    (expectedPositions (items.take n) keysOf key).filter (· < m) =
      expectedPositions (items.take (min n m)) keysOf key := by
  rw [expectedPositions_take_eq, expectedPositions_take_eq, list_filter_range_lt]
  have hmin : min (min n items.length) m = min (min n m) items.length := by omega
  rw [hmin]

theorem expectedPositions_take_append {T : Type} (items added : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) {n : Nat}
    (hn : n ≤ items.length) :
    expectedPositions ((items ++ added).take n) keysOf key =
      expectedPositions (items.take n) keysOf key := by
  rw [List.take_append_of_le_length hn]

theorem expectedPositions_take_succ {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) {n : Nat}
    (hn : n < items.length) {item : T} (hitem : items[n]? = some item)
    {ks : List String} (hks : keysOf item = .ok ks) :
    expectedPositions (items.take (n + 1)) keysOf key =
      if ks.contains key then expectedPositions (items.take n) keysOf key ++ [n]
      else expectedPositions (items.take n) keysOf key := by
  rw [expectedPositions_take_eq, expectedPositions_take_eq]
  have h1 : min (n + 1) items.length = n + 1 := by omega
  have h2 : min n items.length = n := by omega
  rw [h1, h2, List.range_succ, List.filter_append]
  have hsing : List.filter (fun pos =>
      match items[pos]? with
      | some item => match keysOf item with | .ok ks => ks.contains key | .error _ => false
      | none => false) [n] = if ks.contains key then [n] else [] := by
    by_cases hc : key ∈ ks <;> simp [hitem, hks, hc]
  rw [hsing]
  by_cases hc : key ∈ ks <;> simp [hc]

theorem addKeyPosition_nodup (positions : List (String × KeyPositions)) (key : String)
    (pos : Nat) (hnd : (positions.map Prod.fst).Nodup) :
    ((Log.addKeyPosition positions key pos).map Prod.fst).Nodup := by
  unfold Log.addKeyPosition
  cases h : mapGet positions key with
  | none => exact mapSet_nodup positions key _ hnd
  | some kp =>
    cases kp with
    | single found =>
      dsimp only
      split_ifs
      · exact mapSet_nodup positions key _ hnd
      · exact hnd
    | many found =>
      dsimp only
      split_ifs
      · exact mapSet_nodup positions key _ hnd
      · exact hnd

private def AddKeysInv (base : String → List Nat) (pos : Nat)
    (seen : List String) (m : List (String × KeyPositions)) : Prop :=
  (m.map Prod.fst).Nodup ∧
  ∀ k : String, keyPositionsList m k = if k ∈ seen then base k ++ [pos] else base k

private theorem addKeyPosition_preserves_inv (base : String → List Nat) (pos : Nat)
    (hplt : ∀ k p, p ∈ base k → p < pos)
    (seen : List String) (m : List (String × KeyPositions))
    (hinv : AddKeysInv base pos seen m) (key : String) :
    AddKeysInv base pos (key :: seen) (Log.addKeyPosition m key pos) := by
  refine ⟨addKeyPosition_nodup m key pos hinv.1, ?_⟩
  intro k
  by_cases hkk : k = key
  · subst hkk
    have hcur := hinv.2 k
    unfold Log.addKeyPosition
    cases hm : mapGet m k with
    | none =>
      have hnone : keyPositionsList m k = [] := by simp [keyPositionsList, hm]
      rw [hnone] at hcur
      by_cases hmem : k ∈ seen
      · simp [hmem] at hcur
      · simp only [hmem, ↓reduceIte] at hcur
        simp [keyPositionsList, mapGet_mapSet_self, KeyPositions.toList, ← hcur]
    | some kp =>
      cases kp with
      | single found =>
        have hsingle : keyPositionsList m k = [found] := by
          simp [keyPositionsList, hm, KeyPositions.toList]
        rw [hsingle] at hcur
        by_cases hmem : k ∈ seen
        · simp only [hmem, ↓reduceIte] at hcur
          have hlen := congrArg List.length hcur
          simp only [List.length_singleton, List.length_append] at hlen
          have hnil : base k = [] := List.eq_nil_of_length_eq_zero (by omega)
          rw [hnil] at hcur
          have hfp : found = pos := by simpa using hcur
          subst hfp
          simp [keyPositionsList, hm, KeyPositions.toList, ← hnil]
        · simp only [hmem, ↓reduceIte] at hcur
          have hf : found < pos := hplt k found (by rw [← hcur]; simp)
          have hne : (found != pos) = true := bne_iff_ne.mpr (Nat.ne_of_lt hf)
          simp [hne, keyPositionsList, mapGet_mapSet_self, KeyPositions.toList, ← hcur]
      | many found =>
        have hmany : keyPositionsList m k = found := by
          simp [keyPositionsList, hm, KeyPositions.toList]
        rw [hmany] at hcur
        by_cases hmem : k ∈ seen
        · simp only [hmem, ↓reduceIte] at hcur
          have hlast : found.getLast? = some pos := by rw [hcur]; simp [List.getLast?_append]
          simp [hlast]
          simp [keyPositionsList, hm, KeyPositions.toList, hcur]
        · simp only [hmem, ↓reduceIte] at hcur
          have hne : (found.getLast? != some pos) = true := by
            apply bne_iff_ne.mpr
            intro hgl
            have hmemf : pos ∈ found := List.mem_of_getLast? hgl
            have hlt : pos < pos := hplt k pos (by rw [← hcur]; exact hmemf)
            omega
          simp [hne, keyPositionsList, mapGet_mapSet_self, KeyPositions.toList, ← hcur]
  · have hkmem : (k ∈ key :: seen) ↔ (k ∈ seen) := by simp [hkk]
    have hcur := hinv.2 k
    simp only [hkmem, ← hcur]
    unfold Log.addKeyPosition
    cases hm : mapGet m key with
    | none => simp [keyPositionsList, mapGet_mapSet_ne _ hkk]
    | some kp =>
      cases kp with
      | single found =>
        dsimp only
        split_ifs <;> simp [keyPositionsList, mapGet_mapSet_ne _ hkk]
      | many found =>
        dsimp only
        split_ifs <;> simp [keyPositionsList, mapGet_mapSet_ne _ hkk]

theorem addKeysForPosition_spec (positions : List (String × KeyPositions)) (ks : List String)
    (pos : Nat) (hnd : (positions.map Prod.fst).Nodup)
    (hplt : ∀ k p, p ∈ keyPositionsList positions k → p < pos) :
    ((Log.addKeysForPosition positions ks pos).map Prod.fst).Nodup ∧
    ∀ k : String, keyPositionsList (Log.addKeysForPosition positions ks pos) k =
      if ks.contains k then keyPositionsList positions k ++ [pos]
      else keyPositionsList positions k := by
  let base := keyPositionsList positions
  suffices h : ∀ (rem seen : List String) (m : List (String × KeyPositions)),
      AddKeysInv base pos seen m →
      AddKeysInv base pos (rem.reverse ++ seen) (rem.foldl (fun acc k => Log.addKeyPosition acc k pos) m) by
    have h0 : AddKeysInv base pos [] positions := ⟨hnd, by intro k; simp [base]⟩
    have hres := h ks [] positions h0
    refine ⟨hres.1, ?_⟩
    intro k
    have hk := hres.2 k
    simp only [List.append_nil, List.mem_reverse] at hk
    by_cases hmem : k ∈ ks <;> simp [Log.addKeysForPosition, hk, hmem, base]
  intro rem
  induction rem with
  | nil =>
    intro seen m hinv
    simpa using hinv
  | cons hd tl ih =>
    intro seen m hinv
    simp only [List.foldl_cons, List.reverse_cons, List.append_assoc, List.singleton_append]
    exact ih (hd :: seen) (Log.addKeyPosition m hd pos)
      (addKeyPosition_preserves_inv base pos hplt seen m hinv hd)

theorem indexStep_wf {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (k : Keyed)
    (hk : Keyed.WF items keysOf k) :
    let (fk, res) := Log.indexStep items keysOf k
    Keyed.WF items keysOf fk ∧
      (∀ k', res = .ok k' → k' = fk ∧ fk.through = items.length) ∧
      ((∀ item ∈ items, ∃ ks, keysOf item = .ok ks) → res = .ok fk) := by
  suffices h : ∀ (n : Nat) (k : Keyed), items.length - k.through = n → Keyed.WF items keysOf k →
      let (fk, res) := Log.indexStep items keysOf k
      Keyed.WF items keysOf fk ∧
        (∀ k', res = .ok k' → k' = fk ∧ fk.through = items.length) ∧
        ((∀ item ∈ items, ∃ ks, keysOf item = .ok ks) → res = .ok fk) from
    h (items.length - k.through) k rfl hk
  intro n
  induction n with
  | zero =>
    intro k hn hk
    have heq : k.through = items.length := by have := hk.through_le; omega
    unfold Log.indexStep
    simp [heq, hk]
  | succ n ih =>
    intro k hn hk
    have hlt : k.through < items.length := by omega
    obtain ⟨item, hitem⟩ : ∃ item, items[k.through]? = some item :=
      ⟨items[k.through], List.getElem?_eq_getElem hlt⟩
    unfold Log.indexStep
    simp only [hlt, ↓reduceDIte, hitem]
    cases hko : keysOf item with
    | error e =>
      refine ⟨hk, ?_, ?_⟩
      · intro k' he; simp at he
      · intro htot
        obtain ⟨ks, hks⟩ := htot item (List.mem_of_getElem? hitem)
        rw [hko] at hks
        cases hks
    | ok ks =>
      have hplt : ∀ key p, p ∈ keyPositionsList k.positions key → p < k.through := by
        intro key p hp
        rw [hk.positions_spec key] at hp
        have := expectedPositions_lt _ _ _ hp
        rw [List.length_take] at this
        omega
      obtain ⟨hnd', hpos'⟩ := addKeysForPosition_spec k.positions ks k.through hk.positions_nodup hplt
      let kNext : Keyed := ⟨Log.addKeysForPosition k.positions ks k.through, k.through + 1⟩
      have hkNext : Keyed.WF items keysOf kNext := by
        refine ⟨by show k.through + 1 ≤ items.length; omega, hnd', ?_⟩
        intro key
        simp only [kNext]
        rw [hpos' key, hk.positions_spec key, expectedPositions_take_succ items keysOf key hlt hitem hko]
      have hn' : items.length - kNext.through = n := by
        show items.length - (k.through + 1) = n
        omega
      exact ih kNext hn' hkNext

theorem scanFirst_wf {T : Type} (items : List T) (test : T → Bool) (f : First)
    (hf : First.WF items f) : First.WF items (Log.scanFirst items test f) := by
  suffices h : ∀ (n : Nat) (f : First), items.length - f.scanned = n → First.WF items f →
      First.WF items (Log.scanFirst items test f) from
    h (items.length - f.scanned) f rfl hf
  intro n
  induction n with
  | zero =>
    intro f hn hf
    unfold Log.scanFirst
    cases hfound : f.found with
    | some idx => simp [hf]
    | none =>
      have hge : ¬ f.scanned < items.length := by have := hf.scanned_le; omega
      simp [hge, hf]
  | succ n ih =>
    intro f hn hf
    unfold Log.scanFirst
    cases hfound : f.found with
    | some idx => simp [hf]
    | none =>
      have hlt : f.scanned < items.length := by omega
      obtain ⟨item, hitem⟩ : ∃ item, items[f.scanned]? = some item :=
        ⟨items[f.scanned], List.getElem?_eq_getElem hlt⟩
      simp only [hlt, ↓reduceDIte, hitem]
      by_cases htest : test item = true
      · simp only [htest, ↓reduceIte]
        unfold Log.scanFirst
        refine ⟨by show f.scanned + 1 ≤ items.length; omega, ?_⟩
        intro idx hidx
        simp only [Option.some.injEq] at hidx
        subst hidx
        show f.scanned < f.scanned + 1 ∧ f.scanned + 1 = f.scanned + 1
        omega
      · have hf' : First.WF items ⟨none, f.scanned + 1⟩ :=
          ⟨by show f.scanned + 1 ≤ items.length; omega, by intro idx h; simp at h⟩
        simp only [htest, Bool.false_eq_true, ↓reduceIte]
        exact ih ⟨none, f.scanned + 1⟩ (by show items.length - (f.scanned + 1) = n; omega) hf'

theorem scanFirst_matches {T : Type} (items : List T) (test : T → Bool) (f : First)
    (hm : First.Matches items test f) :
    First.Matches items test (Log.scanFirst items test f) ∧
      ((Log.scanFirst items test f).found = none → (Log.scanFirst items test f).scanned = items.length) := by
  suffices h : ∀ (n : Nat) (f : First), items.length - f.scanned = n → First.Matches items test f →
      First.Matches items test (Log.scanFirst items test f) ∧
        ((Log.scanFirst items test f).found = none → (Log.scanFirst items test f).scanned = items.length) from
    h (items.length - f.scanned) f rfl hm
  intro n
  induction n with
  | zero =>
    intro f hn hm
    unfold Log.scanFirst
    cases hfound : f.found with
    | some idx => simp [hm, hfound]
    | none =>
      have heq : f.scanned = items.length := by have := hm.scanned_le; omega
      simp [heq, hm]
  | succ n ih =>
    intro f hn hm
    unfold Log.scanFirst
    cases hfound : f.found with
    | some idx => simp [hm, hfound]
    | none =>
      have hlt : f.scanned < items.length := by omega
      obtain ⟨item, hitem⟩ : ∃ item, items[f.scanned]? = some item :=
        ⟨items[f.scanned], List.getElem?_eq_getElem hlt⟩
      simp only [hlt, ↓reduceDIte, hitem]
      by_cases htest : test item = true
      · simp only [htest, ↓reduceIte]
        unfold Log.scanFirst
        dsimp only
        refine ⟨⟨⟨by show f.scanned + 1 ≤ items.length; omega, ?_⟩, ?_, ?_⟩, ?_⟩
        · intro idx hidx
          simp only [Option.some.injEq] at hidx
          subst hidx
          show f.scanned < f.scanned + 1 ∧ f.scanned + 1 = f.scanned + 1
          omega
        · intro idx hidx
          simp only [Option.some.injEq] at hidx
          subst hidx
          exact ⟨item, hitem, htest⟩
        · intro j hj y hy
          exact hm.before_false j (by simpa [hfound] using hj) y hy
        · intro hnone; simp at hnone
      · simp only [htest, Bool.false_eq_true, ↓reduceIte]
        have hm' : First.Matches items test ⟨none, f.scanned + 1⟩ := by
          refine ⟨⟨by show f.scanned + 1 ≤ items.length; omega, by intro idx h; simp at h⟩, ?_, ?_⟩
          · intro idx h; simp at h
          · intro j hj y hy
            dsimp only at hj
            by_cases hjeq : j = f.scanned
            · subst hjeq
              rw [hitem] at hy
              cases hy
              exact Bool.eq_false_iff.mpr htest
            · exact hm.before_false j (by simp [hfound]; omega) y hy
        exact ih ⟨none, f.scanned + 1⟩ (by show items.length - (f.scanned + 1) = n; omega) hm'

def listMapIdxFrom {T U : Type} (start : Nat) (xs : List T) (transform : T → Nat → U) : List U :=
  match xs with
  | [] => []
  | x :: rest => transform x start :: listMapIdxFrom (start + 1) rest transform

theorem listMapIdx_go_eq {T U : Type} (xs : List T) (pos : Nat) (acc : List U)
    (transform : T → Nat → U) :
    listMapIdx.go transform xs pos acc = acc.reverse ++ listMapIdxFrom pos xs transform := by
  induction xs generalizing pos acc with
  | nil => simp [listMapIdx.go, listMapIdxFrom]
  | cons x rest ih =>
    simp only [listMapIdx.go, listMapIdxFrom, ih, List.reverse_cons, List.append_assoc,
      List.singleton_append]

theorem take_drop_cons {T : Type} (items : List T) {pos limit : Nat}
    (hpl : pos < limit) (hli : limit ≤ items.length) {item : T} (hitem : items[pos]? = some item) :
    (items.take limit).drop pos = item :: (items.take limit).drop (pos + 1) := by
  have hp : pos < (items.take limit).length := by simp [List.length_take]; omega
  have h := List.drop_eq_getElem_cons hp
  have h1 : (items.take limit)[pos]? = some item := by
    rw [List.getElem?_take_of_lt hpl, hitem]
  have h2 := List.getElem?_eq_getElem hp
  rw [h1] at h2
  have hget : (items.take limit)[pos] = item := Option.some.inj h2.symm
  rw [hget] at h
  exact h

theorem mapSlice_eq {T U : Type} (items : List T) (transform : T → Nat → U)
    (pos limit : Nat) (acc : List U) (hpl : pos ≤ limit) (hli : limit ≤ items.length) :
    Log.mapSlice items transform pos limit acc =
      acc.reverse ++ listMapIdxFrom pos ((items.take limit).drop pos) transform := by
  suffices h : ∀ (n : Nat) (pos : Nat) (acc : List U), limit - pos = n → pos ≤ limit →
      Log.mapSlice items transform pos limit acc =
        acc.reverse ++ listMapIdxFrom pos ((items.take limit).drop pos) transform from
    h (limit - pos) pos acc rfl hpl
  intro n
  induction n with
  | zero =>
    intro pos acc hn hpl
    have heq : pos = limit := by omega
    subst heq
    have hdrop : (items.take pos).drop pos = [] :=
      List.drop_eq_nil_of_le (by simp [List.length_take])
    unfold Log.mapSlice
    simp [hdrop, listMapIdxFrom]
  | succ n ih =>
    intro pos acc hn hpl
    have hlt : pos < limit := by omega
    obtain ⟨item, hitem⟩ : ∃ item, items[pos]? = some item :=
      ⟨items[pos], List.getElem?_eq_getElem (by omega)⟩
    unfold Log.mapSlice
    simp only [hlt, ↓reduceIte, hitem]
    rw [ih (pos + 1) (transform item pos :: acc) (by omega) (by omega)]
    rw [take_drop_cons items hlt hli hitem]
    simp [listMapIdxFrom]

theorem filterSlice_eq {T : Type} (items : List T) (test : T → Bool)
    (pos limit : Nat) (acc : List T) (hpl : pos ≤ limit) (hli : limit ≤ items.length) :
    Log.filterSlice items test pos limit acc =
      acc.reverse ++ ((items.take limit).drop pos).filter test := by
  suffices h : ∀ (n : Nat) (pos : Nat) (acc : List T), limit - pos = n → pos ≤ limit →
      Log.filterSlice items test pos limit acc =
        acc.reverse ++ ((items.take limit).drop pos).filter test from
    h (limit - pos) pos acc rfl hpl
  intro n
  induction n with
  | zero =>
    intro pos acc hn hpl
    have heq : pos = limit := by omega
    subst heq
    have hdrop : (items.take pos).drop pos = [] :=
      List.drop_eq_nil_of_le (by simp [List.length_take])
    unfold Log.filterSlice
    simp [hdrop]
  | succ n ih =>
    intro pos acc hn hpl
    have hlt : pos < limit := by omega
    obtain ⟨item, hitem⟩ : ∃ item, items[pos]? = some item :=
      ⟨items[pos], List.getElem?_eq_getElem (by omega)⟩
    unfold Log.filterSlice
    simp only [hlt, ↓reduceIte, hitem]
    rw [take_drop_cons items hlt hli hitem]
    by_cases ht : test item = true
    · simp only [ht, ↓reduceIte, List.filter_cons]
      rw [ih (pos + 1) (item :: acc) (by omega) (by omega)]
      simp
    · simp only [ht, Bool.false_eq_true, ↓reduceIte, List.filter_cons]
      exact ih (pos + 1) acc (by omega) (by omega)

end Helpers

/-! ## Well-formedness preservation -/

section WellFormedness

theorem HistoryHeap.empty_wf {T : Type} : (HistoryHeap.empty : HistoryHeap T).WF := by
  refine ⟨rfl, rfl, ?_, ?_, ?_⟩
  · intro sid hs; simp [HistoryHeap.empty] at hs
  · intro lid aid hl; simp [HistoryHeap.empty] at hl
  · intro shid aid l hs; simp [HistoryHeap.empty] at hs

theorem shapeOf_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (keys : String → Option (T → Except HistoryErr (List String))) :
    let (h', sh) := shapeOf h keys
    h'.WF ∧ sh.id < h'.views.length ∧
      (∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h) := by
  dsimp only [shapeOf]
  let h' : HistoryHeap T :=
    { stores := h.stores, storeShapes := h.storeShapes, arrays := h.arrays,
      shapeKeys := h.shapeKeys ++ [keys], views := h.views ++ [[]], logArrays := h.logArrays }
  have hpres : ∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h := by
    intro l hl
    refine ⟨⟨hl.id_lt, ?_, hl.store_lt, hl.shape_eq, hl.length_le, hl.array_eq⟩, rfl⟩
    simpa [h'] using Nat.lt_succ_of_lt hl.shape_lt
  have hwf' : h'.WF := by
    refine ⟨hwf.storeShapes_len, by simp [h', hwf.shapeKeys_len], ?_, hwf.logArrays_wf, ?_⟩
    · intro sid hs
      obtain ⟨h1, h2, h3⟩ := hwf.stores_wf sid hs
      have hkeys_lt : (h.getStoreShape sid).id < h.shapeKeys.length := by
        rw [hwf.shapeKeys_len]; exact h3
      have hkeys_eq : h'.getShapeKeys (h'.getStoreShape sid).id = h.getShapeKeys (h.getStoreShape sid).id := by
        show (h.shapeKeys ++ [keys])[(h.getStoreShape sid).id]?.getD (fun _ => none) =
          h.shapeKeys[(h.getStoreShape sid).id]?.getD (fun _ => none)
        rw [List.getElem?_append_left hkeys_lt]
      refine ⟨h1, ?_, by simpa [h', HistoryHeap.getStoreShape] using Nat.lt_succ_of_lt h3⟩
      rw [hkeys_eq]
      exact h2
    · intro shid aid l hsh hm
      have hsh' : shid < (h.views ++ [[]]).length := hsh
      by_cases hlt : shid < h.views.length
      · have hm' : mapGet (h.getViews shid) aid = some l := by
          simpa [h', HistoryHeap.getViews, List.getElem?_append_left hlt] using hm
        obtain ⟨ha1, ha2, ha3, hlwf, hla, htl⟩ := hwf.views_wf shid aid l hlt hm'
        exact ⟨ha1, ha2, ha3, (hpres l hlwf).1, hla, htl⟩
      · have heq : shid = h.views.length := by
          simp only [List.length_append, List.length_singleton] at hsh'
          omega
        subst heq
        simp [h', HistoryHeap.getViews, mapGet] at hm
  exact ⟨hwf', by show h.views.length < (h.views ++ [[]]).length; simp, hpres⟩

theorem allocArray_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (items : List T) (frozen : Bool) :
    let (h', aid) := h.allocArray items frozen
    h'.WF ∧ aid < h'.arrays.length ∧
      (∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h) := by
  dsimp only [HistoryHeap.allocArray]
  let arr : JsArray T := ⟨items, frozen⟩
  let h' : HistoryHeap T :=
    { stores := h.stores, storeShapes := h.storeShapes,
      arrays := h.arrays ++ [arr], shapeKeys := h.shapeKeys, views := h.views,
      logArrays := h.logArrays }
  have harr_lt : ∀ {aid'}, aid' < h.arrays.length → h'.getArray aid' = h.getArray aid' := by
    intro aid' ha
    simp [h', HistoryHeap.getArray, listGetD_append_lt _ _ ha]
  have hpres : ∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h := by
    intro l hl
    refine ⟨⟨hl.id_lt, hl.shape_lt, hl.store_lt, hl.shape_eq, hl.length_le, ?_⟩, rfl⟩
    intro aid' ha'
    obtain ⟨h1, h2, h3⟩ := hl.array_eq aid' ha'
    rw [harr_lt h1]
    exact ⟨by simpa [h'] using Nat.lt_succ_of_lt h1, h2, h3⟩
  have hwf' : h'.WF := by
    refine ⟨hwf.storeShapes_len, hwf.shapeKeys_len, hwf.stores_wf, ?_, ?_⟩
    · intro lid aid hl ha
      obtain ⟨h1, h2⟩ := hwf.logArrays_wf lid aid hl ha
      rw [harr_lt h1]
      exact ⟨by simpa [h'] using Nat.lt_succ_of_lt h1, h2⟩
    · intro shid aid l hsh hm
      obtain ⟨ha1, ha2, ha3, hlwf, hla, htl⟩ := hwf.views_wf shid aid l hsh hm
      rw [harr_lt ha1]
      exact ⟨by simpa [h'] using Nat.lt_succ_of_lt ha1, ha2, ha3, (hpres l hlwf).1, hla, htl⟩
  exact ⟨hwf', by simp, hpres⟩

theorem mutateArray_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (aid : ArrayId) (items : List T) :
    (h.mutateArray aid items).WF ∧
      (∀ l : Log T, l.WF h → l.WF (h.mutateArray aid items) ∧ l.toList (h.mutateArray aid items) = l.toList h) := by
  unfold HistoryHeap.mutateArray
  by_cases hf : (h.getArray aid).frozen = true
  · simp [hf, hwf]
  · have hfn : (h.getArray aid).frozen = false := Bool.eq_false_iff.mpr hf
    simp only [hfn, Bool.false_eq_true, ↓reduceIte]
    let h' : HistoryHeap T :=
      { stores := h.stores, storeShapes := h.storeShapes,
        arrays := h.arrays.set aid ⟨items, false⟩, shapeKeys := h.shapeKeys,
        views := h.views, logArrays := h.logArrays }
    have hne_arr : ∀ aid', aid' < h.arrays.length → (h.getArray aid').frozen = true → aid ≠ aid' := by
      intro aid' _ hf' heq
      subst heq
      exact hf hf'
    have harr_ne : ∀ aid', aid' < h.arrays.length → (h.getArray aid').frozen = true →
        h'.getArray aid' = h.getArray aid' := by
      intro aid' hlt hf'
      simp [h', HistoryHeap.getArray, listGetD_set_ne _ (hne_arr aid' hlt hf')]
    have hpres : ∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h := by
      intro l hl
      refine ⟨⟨hl.id_lt, hl.shape_lt, hl.store_lt, hl.shape_eq, hl.length_le, ?_⟩, rfl⟩
      intro aid' ha'
      obtain ⟨h1, h2, h3⟩ := hl.array_eq aid' ha'
      rw [harr_ne aid' h1 h2]
      exact ⟨by show aid' < (h.arrays.set aid ⟨items, false⟩).length; simp; exact h1, h2, h3⟩
    have hwf' : h'.WF := by
      refine ⟨hwf.storeShapes_len, hwf.shapeKeys_len, hwf.stores_wf, ?_, ?_⟩
      · intro lid aid' hl ha'
        obtain ⟨h1, h2⟩ := hwf.logArrays_wf lid aid' hl ha'
        rw [harr_ne aid' h1 h2]
        exact ⟨by show aid' < (h.arrays.set aid ⟨items, false⟩).length; simp; exact h1, h2⟩
      · intro shid aid' l hsh hm
        obtain ⟨ha1, ha2, ha3, hlwf, hla, htl⟩ := hwf.views_wf shid aid' l hsh hm
        rw [harr_ne aid' ha1 ha2]
        exact ⟨by show aid' < (h.arrays.set aid ⟨items, false⟩).length; simp; exact ha1,
          ha2, ha3, (hpres l hlwf).1, hla, htl⟩
    exact ⟨hwf', hpres⟩

theorem allocStore_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (s : Store T) (sh : Shape T)
    (hs : Store.WF s) (hm : Store.MatchesShape s (h.getShapeKeys sh.id))
    (hsh : sh.id < h.views.length) :
    (h.allocStore s sh).1.WF ∧ (h.allocStore s sh).2 = h.stores.length ∧
      (h.allocStore s sh).2 < (h.allocStore s sh).1.stores.length ∧
      (∀ l : Log T, l.WF h →
        l.WF (h.allocStore s sh).1 ∧ l.toList (h.allocStore s sh).1 = l.toList h) := by
  dsimp only [HistoryHeap.allocStore]
  let h' : HistoryHeap T :=
    { stores := h.stores ++ [s], storeShapes := h.storeShapes ++ [sh],
      arrays := h.arrays, shapeKeys := h.shapeKeys, views := h.views, logArrays := h.logArrays }
  have hpres : ∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h := by
    intro l hl
    have hst : h'.getStore l.store = h.getStore l.store := getStore_allocStore_lt h s sh hl.store_lt
    have hsh' : h'.getStoreShape l.store = h.getStoreShape l.store :=
      getStoreShape_allocStore_lt h s sh (by rw [hwf.storeShapes_len]; exact hl.store_lt)
    have htl : l.toList h' = l.toList h := by simp [Log.toList, hst]
    refine ⟨⟨hl.id_lt, hl.shape_lt, by simpa [h'] using Nat.lt_succ_of_lt hl.store_lt,
      by rw [hsh']; exact hl.shape_eq, by rw [hst]; exact hl.length_le,
      by intro aid ha; rw [htl]; exact hl.array_eq aid ha⟩, htl⟩
  have hwf' : h'.WF := by
    refine ⟨by simp [h', hwf.storeShapes_len], hwf.shapeKeys_len, ?_, hwf.logArrays_wf, ?_⟩
    · intro sid hs_lt
      by_cases hlt : sid < h.stores.length
      · have hst : h'.getStore sid = h.getStore sid := getStore_allocStore_lt h s sh hlt
        have hsh' : h'.getStoreShape sid = h.getStoreShape sid :=
          getStoreShape_allocStore_lt h s sh (by rw [hwf.storeShapes_len]; exact hlt)
        rw [hst, hsh']
        exact hwf.stores_wf sid hlt
      · have heq : sid = h.stores.length := by
          simp only [h', List.length_append, List.length_singleton] at hs_lt
          omega
        subst heq
        have hst : h'.getStore h.stores.length = s := getStore_allocStore_same h s sh
        have hsh' : h'.getStoreShape h.stores.length = sh :=
          getStoreShape_allocStore_same h s sh hwf.storeShapes_len
        rw [hst, hsh']
        exact ⟨hs, hm, hsh⟩
    · intro shid aid l hsh' hmap
      obtain ⟨ha1, ha2, ha3, hlwf, hla, htl⟩ := hwf.views_wf shid aid l hsh' hmap
      have hp := hpres l hlwf
      exact ⟨ha1, ha2, ha3, hp.1, hla, by rw [hp.2]; exact htl⟩
  exact ⟨hwf', rfl, by simp, hpres⟩

theorem setStore_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    {sid : StoreId} (hsid : sid < h.stores.length) (s' : Store T)
    (hs : Store.WF s') (hm : Store.MatchesShape s' (h.getShapeKeys (h.getStoreShape sid).id))
    (hlen : (h.getStore sid).items.length ≤ s'.items.length)
    (hpref : ∀ len, len ≤ (h.getStore sid).items.length → s'.items.take len = (h.getStore sid).items.take len) :
    (h.setStore sid s').WF ∧
      (∀ l : Log T, l.WF h → l.WF (h.setStore sid s') ∧ l.toList (h.setStore sid s') = l.toList h) := by
  let h' := h.setStore sid s'
  have hpres : ∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h := by
    intro l hl
    by_cases hls : l.store = sid
    · have hst : h'.getStore l.store = s' := by rw [hls]; exact getStore_setStore_same h hsid s'
      have hlen_l : l.length ≤ (h.getStore sid).items.length := by rw [← hls]; exact hl.length_le
      have htl : l.toList h' = l.toList h := by
        simp only [Log.toList, hst]
        rw [hpref l.length hlen_l, hls]
      refine ⟨⟨hl.id_lt, hl.shape_lt, by simp only [h', HistoryHeap.setStore, List.length_set]; exact hl.store_lt,
        hl.shape_eq, by rw [hst]; omega, by intro aid ha; rw [htl]; exact hl.array_eq aid ha⟩, htl⟩
    · have hst : h'.getStore l.store = h.getStore l.store := getStore_setStore_ne h (Ne.symm hls) s'
      have htl : l.toList h' = l.toList h := by simp [Log.toList, hst]
      refine ⟨⟨hl.id_lt, hl.shape_lt, by simp only [h', HistoryHeap.setStore, List.length_set]; exact hl.store_lt,
        hl.shape_eq, by rw [hst]; exact hl.length_le,
        by intro aid ha; rw [htl]; exact hl.array_eq aid ha⟩, htl⟩
  have hwf' : h'.WF := by
    refine ⟨by simp [h', HistoryHeap.setStore, hwf.storeShapes_len], hwf.shapeKeys_len, ?_, hwf.logArrays_wf, ?_⟩
    · intro sid' hs'
      have hs'' : sid' < h.stores.length := by simpa [h', HistoryHeap.setStore] using hs'
      by_cases heq : sid' = sid
      · subst heq
        rw [getStore_setStore_same h hsid s']
        exact ⟨hs, hm, (hwf.stores_wf sid' hsid).2.2⟩
      · rw [getStore_setStore_ne h (Ne.symm heq) s']
        exact hwf.stores_wf sid' hs''
    · intro shid aid l hsh hmap
      obtain ⟨ha1, ha2, ha3, hlwf, hla, htl⟩ := hwf.views_wf shid aid l hsh hmap
      have hp := hpres l hlwf
      exact ⟨ha1, ha2, ha3, hp.1, hla, by rw [hp.2]; exact htl⟩
  exact ⟨hwf', hpres⟩

theorem allocLog_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (shape : Shape T) (sid : StoreId) (len : Nat) (arr : Option ArrayId)
    (hsh : shape.id < h.views.length) (hsid : sid < h.stores.length)
    (hsheq : shape = h.getStoreShape sid) (hlen : len ≤ (h.getStore sid).items.length)
    (harr : ∀ aid, arr = some aid →
      aid < h.arrays.length ∧ (h.getArray aid).frozen = true ∧
      (h.getArray aid).items = (h.getStore sid).items.take len) :
    (h.allocLog shape sid len arr).1.WF ∧
      (h.allocLog shape sid len arr).2.WF (h.allocLog shape sid len arr).1 ∧
      (∀ l : Log T, l.WF h →
        l.WF (h.allocLog shape sid len arr).1 ∧
        l.toList (h.allocLog shape sid len arr).1 = l.toList h) := by
  dsimp only [HistoryHeap.allocLog]
  let h' : HistoryHeap T :=
    { stores := h.stores, storeShapes := h.storeShapes, arrays := h.arrays,
      shapeKeys := h.shapeKeys, views := h.views, logArrays := h.logArrays ++ [arr] }
  let log : Log T := ⟨h.logArrays.length, shape, sid, len⟩
  have hpres : ∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h := by
    intro l hl
    refine ⟨⟨by simpa [h'] using Nat.lt_succ_of_lt hl.id_lt, hl.shape_lt, hl.store_lt,
      hl.shape_eq, hl.length_le, ?_⟩, rfl⟩
    intro aid ha
    have ha' : h.getLogArray l.id = some aid := by
      simpa [h', HistoryHeap.getLogArray, List.getElem?_append_left hl.id_lt] using ha
    exact hl.array_eq aid ha'
  have hlog : log.WF h' := by
    refine ⟨by simp [h', log], hsh, hsid, hsheq, hlen, ?_⟩
    intro aid ha
    have ha' : arr = some aid := by simpa [h', log, HistoryHeap.getLogArray] using ha
    exact harr aid ha'
  have hwf' : h'.WF := by
    refine ⟨hwf.storeShapes_len, hwf.shapeKeys_len, hwf.stores_wf, ?_, ?_⟩
    · intro lid aid hl ha
      by_cases hlt : lid < h.logArrays.length
      · have ha' : h.getLogArray lid = some aid := by
          simpa [h', HistoryHeap.getLogArray, List.getElem?_append_left hlt] using ha
        exact hwf.logArrays_wf lid aid hlt ha'
      · have heq : lid = h.logArrays.length := by
          simp only [h', List.length_append, List.length_singleton] at hl
          omega
        subst heq
        have ha' : arr = some aid := by simpa [h', HistoryHeap.getLogArray] using ha
        obtain ⟨h1, h2, _⟩ := harr aid ha'
        exact ⟨h1, h2⟩
    · intro shid aid l hsh' hmap
      obtain ⟨ha1, ha2, ha3, hlwf, hla, htl⟩ := hwf.views_wf shid aid l hsh' hmap
      have hp := hpres l hlwf
      have hla' : h'.getLogArray l.id = some aid := by
        simpa [h', HistoryHeap.getLogArray, List.getElem?_append_left hlwf.id_lt] using hla
      exact ⟨ha1, ha2, ha3, hp.1, hla', htl⟩
  exact ⟨hwf', hlog, hpres⟩

theorem setViews_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    {shid : ShapeId} (hsh : shid < h.views.length) (aid : ArrayId) (l : Log T)
    (ha1 : aid < h.arrays.length) (ha2 : (h.getArray aid).frozen = true)
    (ha3 : l.shape.id = shid) (hlwf : l.WF h) (hla : h.getLogArray l.id = some aid)
    (htl : l.toList h = (h.getArray aid).items) :
    let h' := h.setViews shid (mapSet (h.getViews shid) aid l)
    h'.WF ∧ (∀ l0 : Log T, l0.WF h → l0.WF h' ∧ l0.toList h' = l0.toList h) := by
  let h' : HistoryHeap T :=
    { stores := h.stores, storeShapes := h.storeShapes, arrays := h.arrays,
      shapeKeys := h.shapeKeys, views := h.views.set shid (mapSet (h.getViews shid) aid l),
      logArrays := h.logArrays }
  have hpres : ∀ l0 : Log T, l0.WF h → l0.WF h' ∧ l0.toList h' = l0.toList h := by
    intro l0 hl0
    exact ⟨⟨hl0.id_lt, by simpa [h'] using hl0.shape_lt, hl0.store_lt, hl0.shape_eq,
      hl0.length_le, hl0.array_eq⟩, rfl⟩
  have hwf' : h'.WF := by
    refine ⟨hwf.storeShapes_len, by simpa [h'] using hwf.shapeKeys_len, ?_, hwf.logArrays_wf, ?_⟩
    · intro sid hs
      obtain ⟨s1, s2, s3⟩ := hwf.stores_wf sid hs
      exact ⟨s1, s2, by simpa [h', HistoryHeap.getStoreShape] using s3⟩
    intro shid' aid' l' hsh' hmap
    have hsh'' : shid' < h.views.length := by simpa [h'] using hsh'
    by_cases heq : shid' = shid
    · subst heq
      have hget : h'.getViews shid' = mapSet (h.getViews shid') aid l :=
        getViews_setViews_same h hsh _
      rw [hget, mapGet_mapSet] at hmap
      by_cases haeq : aid' = aid
      · subst haeq
        simp only [beq_self_eq_true, ↓reduceIte, Option.some.injEq] at hmap
        subst hmap
        exact ⟨ha1, ha2, ha3, (hpres l hlwf).1, hla, htl⟩
      · have hb : (aid' == aid) = false := beq_false_of_ne haeq
        simp only [hb, Bool.false_eq_true, ↓reduceIte] at hmap
        obtain ⟨b1, b2, b3, blwf, bla, btl⟩ := hwf.views_wf shid' aid' l' hsh'' hmap
        exact ⟨b1, b2, b3, (hpres l' blwf).1, bla, btl⟩
    · have hget : h'.getViews shid' = h.getViews shid' :=
        getViews_setViews_ne h (Ne.symm heq) _
      rw [hget] at hmap
      obtain ⟨b1, b2, b3, blwf, bla, btl⟩ := hwf.views_wf shid' aid' l' hsh'' hmap
      exact ⟨b1, b2, b3, (hpres l' blwf).1, bla, btl⟩
  exact ⟨hwf', hpres⟩

theorem setLogArray_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    {lid : LogId} (hlid : lid < h.logArrays.length) (hnone : h.getLogArray lid = none)
    {aid : ArrayId} (ha1 : aid < h.arrays.length) (ha2 : (h.getArray aid).frozen = true) :
    let h' := h.setLogArray lid (some aid)
    h'.WF ∧
      (∀ l : Log T, l.WF h → (l.id ≠ lid ∨ (h.getArray aid).items = l.toList h) →
        l.WF h' ∧ l.toList h' = l.toList h) := by
  let h' : HistoryHeap T :=
    { stores := h.stores, storeShapes := h.storeShapes, arrays := h.arrays,
      shapeKeys := h.shapeKeys, views := h.views, logArrays := h.logArrays.set lid (some aid) }
  have hpres : ∀ l : Log T, l.WF h →
      (l.id ≠ lid ∨ (h.getArray aid).items = l.toList h) →
      l.WF h' ∧ l.toList h' = l.toList h := by
    intro l hl hcond
    refine ⟨⟨by simpa [h'] using hl.id_lt, hl.shape_lt, hl.store_lt, hl.shape_eq, hl.length_le, ?_⟩, rfl⟩
    intro aid' ha'
    by_cases hid : l.id = lid
    · subst hid
      have hget : h'.getLogArray l.id = some aid := getLogArray_setLogArray_same h hlid (some aid)
      rw [hget] at ha'
      simp only [Option.some.injEq] at ha'
      subst ha'
      rcases hcond with hne | heq
      · exact absurd rfl hne
      · exact ⟨ha1, ha2, heq⟩
    · have hget : h'.getLogArray l.id = h.getLogArray l.id :=
        getLogArray_setLogArray_ne h (Ne.symm hid) (some aid)
      rw [hget] at ha'
      exact hl.array_eq aid' ha'
  have hwf' : h'.WF := by
    refine ⟨hwf.storeShapes_len, hwf.shapeKeys_len, hwf.stores_wf, ?_, ?_⟩
    · intro lid' aid' hl' ha'
      have hl'' : lid' < h.logArrays.length := by simpa [h'] using hl'
      have hheq : h' = h.setLogArray lid (some aid) := rfl
      by_cases heq : lid' = lid
      · subst heq
        rw [hheq, getLogArray_setLogArray_same h hlid (some aid)] at ha'
        simp only [Option.some.injEq] at ha'
        subst ha'
        exact ⟨ha1, ha2⟩
      · rw [hheq, getLogArray_setLogArray_ne h (Ne.symm heq) (some aid)] at ha'
        exact hwf.logArrays_wf lid' aid' hl'' ha'
    · intro shid aid' l hsh hmap
      obtain ⟨b1, b2, b3, blwf, bla, btl⟩ := hwf.views_wf shid aid' l hsh hmap
      have hne : l.id ≠ lid := by
        intro heq
        rw [heq, hnone] at bla
        cases bla
      have hheq : h' = h.setLogArray lid (some aid) := rfl
      have hla' : h'.getLogArray l.id = some aid' := by
        rw [hheq, getLogArray_setLogArray_ne h (Ne.symm hne) (some aid)]
        exact bla
      exact ⟨b1, b2, b3, (hpres l blwf (Or.inl hne)).1, hla', btl⟩
  exact ⟨hwf', hpres⟩

private theorem logOf_alloc_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (shape : Shape T) (hsh : shape.id < h.views.length)
    (aid : ArrayId) (haid : aid < h.arrays.length) (frz : Bool)
    (hfrz : (h.getArray aid).frozen = frz) :
    let store : Store T := ⟨(h.getArray aid).items, !frz, [], []⟩
    let h1 := (h.allocStore store shape).1
    let sid := (h.allocStore store shape).2
    let cached := if frz then some aid else none
    let h2 := (h1.allocLog shape sid (h.getArray aid).items.length cached).1
    let log := (h1.allocLog shape sid (h.getArray aid).items.length cached).2
    h2.WF ∧ log.WF h2 ∧ log.shape = shape ∧
      log.toList h2 = (h.getArray aid).items ∧
      (∀ l : Log T, l.WF h → l.WF h2 ∧ l.toList h2 = l.toList h) := by
  intro store h1 sid cached h2 log
  have hs : Store.WF store :=
    ⟨fun _ _ h => by simp [store, mapGet] at h, fun _ _ h => by simp [store, mapGet] at h⟩
  have hms : Store.MatchesShape store (h.getShapeKeys shape.id) :=
    fun _ _ h => by simp [store, mapGet] at h
  obtain ⟨h1_wf, _, hsid_lt, hpres1⟩ := allocStore_wf h hwf store shape hs hms hsh
  have hsh1 : shape.id < h1.views.length := hsh
  have hsheq1 : shape = h1.getStoreShape sid := by
    simpa [h1, sid] using (getStoreShape_allocStore_same h store shape hwf.storeShapes_len).symm
  have hst1 : h1.getStore sid = store := getStore_allocStore_same h store shape
  have hlen1 : (h.getArray aid).items.length ≤ (h1.getStore sid).items.length := by
    simp [hst1, store]
  have harr1 : ∀ aid', cached = some aid' →
      aid' < h1.arrays.length ∧ (h1.getArray aid').frozen = true ∧
      (h1.getArray aid').items = (h1.getStore sid).items.take (h.getArray aid).items.length := by
    intro aid' ha'
    dsimp only [cached] at ha'
    cases frz
    · simp at ha'
    · simp only [↓reduceIte, Option.some.injEq] at ha'
      subst ha'
      have harr_eq : h1.getArray aid = h.getArray aid := rfl
      rw [harr_eq]
      refine ⟨haid, hfrz, ?_⟩
      simp [hst1, store]
  obtain ⟨h2_wf, hlog2, hpres2⟩ :=
    allocLog_wf h1 h1_wf shape sid (h.getArray aid).items.length cached hsh1 hsid_lt hsheq1 hlen1 harr1
  have hlog_tl : log.toList h2 = (h.getArray aid).items := by
    change (h1.getStore sid).items.take (h.getArray aid).items.length = (h.getArray aid).items
    rw [hst1]
    simp [store]
  refine ⟨h2_wf, hlog2, rfl, hlog_tl, ?_⟩
  intro l hl
  obtain ⟨hl1, htl1⟩ := hpres1 l hl
  obtain ⟨hl2, htl2⟩ := hpres2 l hl1
  exact ⟨hl2, by rw [htl2, htl1]⟩

theorem logOf_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (shape : Shape T) (hsh : shape.id < h.views.length)
    (aid : ArrayId) (haid : aid < h.arrays.length) :
    (logOf h shape aid).1.WF ∧ (logOf h shape aid).2.WF (logOf h shape aid).1 ∧
      (logOf h shape aid).2.shape = shape ∧
      (logOf h shape aid).2.toList (logOf h shape aid).1 = (h.getArray aid).items ∧
      (∀ l : Log T, l.WF h →
        l.WF (logOf h shape aid).1 ∧ l.toList (logOf h shape aid).1 = l.toList h) := by
  unfold logOf
  cases hm : mapGet (h.getViews shape.id) aid with
  | some known =>
    obtain ⟨_, _, hshid, hlwf, _, htl⟩ := hwf.views_wf shape.id aid known hsh hm
    have hsheq : known.shape = shape := by
      cases hks : known.shape
      cases hs : shape
      simp [hks, hs] at hshid
      simp [hshid]
    exact ⟨hwf, hlwf, hsheq, htl, fun l hl => ⟨hl, rfl⟩⟩
  | none =>
    cases hfrz : (h.getArray aid).frozen
    · simp only [hfrz, Bool.false_eq_true, ↓reduceIte]
      exact logOf_alloc_wf h hwf shape hsh aid haid false hfrz
    · simp only [hfrz, ↓reduceIte]
      obtain ⟨h2_wf, hlog2, _, hlog_tl, hpres2⟩ := logOf_alloc_wf h hwf shape hsh aid haid true hfrz
      simp only [↓reduceIte] at h2_wf hlog2 hlog_tl hpres2
      have hla :
          ((h.allocStore ⟨(h.getArray aid).items, !true, [], []⟩ shape).1.allocLog shape
              (h.allocStore ⟨(h.getArray aid).items, !true, [], []⟩ shape).2
              (h.getArray aid).items.length (some aid)).1.getLogArray
            ((h.allocStore ⟨(h.getArray aid).items, !true, [], []⟩ shape).1.allocLog shape
              (h.allocStore ⟨(h.getArray aid).items, !true, [], []⟩ shape).2
              (h.getArray aid).items.length (some aid)).2.id = some aid :=
        getLogArray_allocLog_same _ _ _ _ _
      obtain ⟨h3_wf, hpres3⟩ := setViews_wf _ h2_wf hsh aid _ haid hfrz rfl hlog2 hla hlog_tl
      refine ⟨h3_wf, (hpres3 _ hlog2).1, rfl, ?_, ?_⟩
      · rw [(hpres3 _ hlog2).2, hlog_tl]
      · intro l hl
        obtain ⟨hl2, htl2⟩ := hpres2 l hl
        obtain ⟨hl3, htl3⟩ := hpres3 l hl2
        exact ⟨hl3, by rw [htl3, htl2]⟩

/-- Agreement of a `Store`'s cached `firsts[name]` with predicate `test`. -/
def Store.FirstMatches {T : Type} (s : Store T) (name : String) (test : T → Bool) : Prop :=
  ∀ f, mapGet s.firsts name = some f → First.Matches s.items test f

theorem mapGet_branchKeyed (len : Nat) (m : List (String × Keyed)) (name : String) :
    mapGet (Log.branchKeyed len m) name =
      (mapGet m name).map fun idx =>
        let t := min idx.through len
        ⟨Log.branchPositions t idx.positions, t⟩ := by
  induction m with
  | nil => simp [Log.branchKeyed, mapGet]
  | cons hd tl ih =>
    rcases hd with ⟨k, idx⟩
    simp only [Log.branchKeyed, mapGet]
    by_cases hk : k = name
    · subst hk; simp
    · have hb : (k == name) = false := beq_false_of_ne hk
      simp [hb, ih]

theorem mapGet_branchFirsts (len : Nat) (m : List (String × First)) (name : String) :
    mapGet (Log.branchFirsts len m) name =
      (mapGet m name).map fun scan =>
        match scan.found with
        | some f => if f < len then ⟨some f, scan.scanned⟩ else ⟨none, min scan.scanned len⟩
        | none => ⟨none, min scan.scanned len⟩ := by
  induction m with
  | nil => simp [Log.branchFirsts, mapGet]
  | cons hd tl ih =>
    rcases hd with ⟨k, scan⟩
    simp only [Log.branchFirsts, mapGet]
    by_cases hk : k = name
    · subst hk; simp
    · have hb : (k == name) = false := beq_false_of_ne hk
      simp [hb, ih]

theorem Log.branch_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF) (log : Log T) (hlog : log.WF h) :
    let b := log.branch h
    b.items = log.toList h ∧ b.owned = true ∧ Store.WF b ∧
      Store.MatchesShape b (h.getShapeKeys log.shape.id) := by
  dsimp only [Log.branch]
  have hst := hwf.stores_wf log.store hlog.store_lt
  have hlen : ((h.getStore log.store).items.take log.length).length = log.length := by
    simp [List.length_take, hlog.length_le]
  refine ⟨rfl, rfl, ⟨?_, ?_⟩, ?_⟩
  · intro name f hf
    rw [mapGet_branchFirsts] at hf
    cases hget : mapGet (h.getStore log.store).firsts name with
    | none => simp [hget] at hf
    | some scan =>
      rw [hget] at hf
      have hfwf := hst.1.firsts_wf name scan hget
      simp only [Option.map_some, Option.some.injEq] at hf
      dsimp only
      rw [← hf]
      cases hsf : scan.found with
      | none =>
        refine ⟨by rw [hlen]; simp, by intro idx hidx; simp at hidx⟩
      | some idx =>
        have hspec := hfwf.found_spec idx hsf
        dsimp only
        split_ifs with hlt
        · refine ⟨by show scan.scanned ≤ (List.take log.length (h.getStore log.store).items).length; rw [hlen]; omega, ?_⟩
          intro idx' hidx'
          simp only [Option.some.injEq] at hidx'
          subst hidx'
          exact hspec
        · refine ⟨by rw [hlen]; simp, by intro idx' hidx'; simp at hidx'⟩
  · intro name k hk
    rw [mapGet_branchKeyed] at hk
    cases hget : mapGet (h.getStore log.store).keyed name with
    | none => simp [hget] at hk
    | some idx =>
      rw [hget] at hk
      simp only [Option.map_some, Option.some.injEq] at hk
      rw [← hk, hlen]
      exact Nat.min_le_right _ _
  · intro name k hk
    rw [mapGet_branchKeyed] at hk
    cases hget : mapGet (h.getStore log.store).keyed name with
    | none => simp [hget] at hk
    | some idx =>
      rw [hget] at hk
      simp only [Option.map_some, Option.some.injEq] at hk
      have hms := hst.2.1
      rw [← hlog.shape_eq] at hms
      obtain ⟨keysOf, hko, hkwf⟩ := hms name idx hget
      refine ⟨keysOf, hko, ?_⟩
      rw [← hk]
      refine ⟨by dsimp; rw [hlen]; exact Nat.min_le_right _ _, branchPositions_nodup _ _ hkwf.positions_nodup, ?_⟩
      intro key
      dsimp only
      rw [keyPositionsList_branchPositions _ _ hkwf.positions_nodup, hkwf.positions_spec key,
        expectedPositions_take_filter, List.take_take]
      have hm1 : min idx.through (min idx.through log.length) = min (min idx.through log.length) log.length := by
        omega
      rw [hm1]

theorem Log.branch_firstMatches {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h)
    (name : String) (test : T → Bool)
    (hm : Store.FirstMatches (h.getStore log.store) name test) :
    Store.FirstMatches (log.branch h) name test := by
  intro f hf
  simp only [Log.branch, mapGet_branchFirsts] at hf
  cases hget : mapGet (h.getStore log.store).firsts name with
  | none => simp [hget] at hf
  | some scan =>
    rw [hget] at hf
    have hsm := hm scan hget
    simp only [Option.map_some, Option.some.injEq] at hf
    have hitems : (log.branch h).items = (h.getStore log.store).items.take log.length := rfl
    have hlen : (log.branch h).items.length = log.length := by
      have := hlog.length_le
      rw [hitems, List.length_take]
      omega
    rw [← hf]
    cases hsf : scan.found with
    | none =>
      refine ⟨⟨by rw [hlen]; simp, by intro idx hidx; simp at hidx⟩,
        by intro idx hidx; simp at hidx, ?_⟩
      intro j hj y hy
      dsimp only at hj
      have hjlt : j < log.length := by omega
      rw [hitems, List.getElem?_take_of_lt hjlt] at hy
      exact hsm.before_false j (by simp [hsf]; omega) y hy
    | some idx =>
      have hspec := hsm.found_spec idx hsf
      dsimp only
      split_ifs with hlt
      · refine ⟨⟨by show scan.scanned ≤ (log.branch h).items.length; rw [hlen]; omega, ?_⟩, ?_, ?_⟩
        · intro idx' hidx'
          simp only [Option.some.injEq] at hidx'
          subst hidx'
          exact hspec
        · intro idx' hidx'
          simp only [Option.some.injEq] at hidx'
          subst hidx'
          rw [hitems, List.getElem?_take_of_lt hlt]
          exact hsm.found_true idx hsf
        · intro j hj y hy
          dsimp only at hj
          rw [hitems, List.getElem?_take_of_lt (by omega)] at hy
          exact hsm.before_false j (by simp [hsf]; exact hj) y hy
      · refine ⟨⟨by rw [hlen]; simp, by intro idx' hidx'; simp at hidx'⟩,
          by intro idx' hidx'; simp at hidx', ?_⟩
        intro j hj y hy
        dsimp only at hj
        have hjlt : j < log.length := by omega
        rw [hitems, List.getElem?_take_of_lt hjlt] at hy
        exact hsm.before_false j (by simp [hsf]; omega) y hy

theorem store_extend_wf {T : Type} (s : Store T)
    (keys : String → Option (T → Except HistoryErr (List String)))
    (hs : Store.WF s) (hm : Store.MatchesShape s keys) (added : List T) :
    let s' := { s with items := s.items ++ added }
    Store.WF s' ∧ Store.MatchesShape s' keys ∧
      s.items.length ≤ s'.items.length ∧
      (∀ len, len ≤ s.items.length → s'.items.take len = s.items.take len) := by
  refine ⟨⟨?_, ?_⟩, ?_, by simp, fun len hlen => List.take_append_of_le_length hlen⟩
  · intro name f hf
    have hfwf := hs.firsts_wf name f hf
    exact ⟨by simp; have := hfwf.scanned_le; omega, hfwf.found_spec⟩
  · intro name k hk
    have hkt := hs.keyed_through_le name k hk
    simp; omega
  · intro name k hk
    obtain ⟨keysOf, hko, hkwf⟩ := hm name k hk
    refine ⟨keysOf, hko, ⟨by simp; have := hkwf.through_le; omega, hkwf.positions_nodup, ?_⟩⟩
    intro key
    dsimp only
    rw [List.take_append_of_le_length hkwf.through_le]
    exact hkwf.positions_spec key

theorem store_extend_firstMatches {T : Type} (s : Store T) (_hs : Store.WF s)
    (name : String) (test : T → Bool) (added : List T)
    (hm : Store.FirstMatches s name test) :
    Store.FirstMatches { s with items := s.items ++ added } name test := by
  intro f hf
  have hsm := hm f hf
  refine ⟨⟨by simp; have := hsm.scanned_le; omega, hsm.found_spec⟩, ?_, ?_⟩
  · intro idx hidx
    have hlt : idx < s.items.length := by
      have := hsm.found_spec idx hidx
      have := hsm.scanned_le
      omega
    dsimp only
    rw [List.getElem?_append_left hlt]
    exact hsm.found_true idx hidx
  · intro j hj y hy
    have hbound : (match f.found with | some idx => idx | none => f.scanned) ≤ s.items.length := by
      cases hsf : f.found with
      | none => simpa using hsm.scanned_le
      | some idx =>
        have h1 := hsm.found_spec idx hsf
        have h2 := hsm.scanned_le
        dsimp only
        omega
    have hjlt : j < s.items.length := Nat.lt_of_lt_of_le hj hbound
    dsimp only at hy
    rw [List.getElem?_append_left hjlt] at hy
    exact hsm.before_false j hj y hy

private theorem append_tail_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (shape : Shape T) {sid : StoreId} (hsid : sid < h.stores.length)
    (hsh : shape.id < h.views.length) (hsheq : shape = h.getStoreShape sid)
    (store : Store T) (hstore : h.getStore sid = store) (added : List T) :
    let items' := store.items ++ added
    let h2 := h.setStore sid { store with items := items' }
    let res := h2.allocLog shape sid items'.length none
    res.1.WF ∧ res.2.WF res.1 ∧ res.2.shape = shape ∧
      res.2.toList res.1 = store.items ++ added ∧
      (∀ l : Log T, l.WF h → l.WF res.1 ∧ l.toList res.1 = l.toList h) := by
  intro items' h2 res
  have hst := hwf.stores_wf sid hsid
  rw [hstore] at hst
  have hms : Store.MatchesShape store (h.getShapeKeys (h.getStoreShape sid).id) := hst.2.1
  obtain ⟨hs', hm', hlen', hpref'⟩ := store_extend_wf store _ hst.1 hms added
  have hlen'' : (h.getStore sid).items.length ≤ ({ store with items := items' } : Store T).items.length := by
    rw [hstore]; exact hlen'
  have hpref'' : ∀ len, len ≤ (h.getStore sid).items.length →
      ({ store with items := items' } : Store T).items.take len = (h.getStore sid).items.take len := by
    intro len hl; rw [hstore]; exact hpref' len (by rw [← hstore]; exact hl)
  obtain ⟨h2_wf, hpres2⟩ := setStore_wf h hwf hsid { store with items := items' } hs' hm' hlen'' hpref''
  have hsh2 : shape.id < h2.views.length := hsh
  have hsid2 : sid < h2.stores.length := by simpa [h2, HistoryHeap.setStore] using hsid
  have hsheq2 : shape = h2.getStoreShape sid := hsheq
  have hget2 : h2.getStore sid = { store with items := items' } := getStore_setStore_same h hsid _
  have hlen2 : items'.length ≤ (h2.getStore sid).items.length := by rw [hget2]
  have harr2 : ∀ aid, (none : Option ArrayId) = some aid →
      aid < h2.arrays.length ∧ (h2.getArray aid).frozen = true ∧
      (h2.getArray aid).items = (h2.getStore sid).items.take items'.length := fun _ ha => by cases ha
  obtain ⟨h3_wf, hlog3, hpres3⟩ := allocLog_wf h2 h2_wf shape sid items'.length none hsh2 hsid2 hsheq2 hlen2 harr2
  have htl : res.2.toList res.1 = store.items ++ added := by
    change (h2.getStore sid).items.take items'.length = items'
    rw [hget2]
    simp [items']
  refine ⟨h3_wf, hlog3, rfl, htl, ?_⟩
  intro l hl
  obtain ⟨hl2, htl2⟩ := hpres2 l hl
  obtain ⟨hl3, htl3⟩ := hpres3 l hl2
  exact ⟨hl3, by rw [htl3, htl2]⟩

theorem Log.append_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (added : List T) :
    (log.append h added).1.WF ∧ (log.append h added).2.WF (log.append h added).1 ∧
      (log.append h added).2.shape = log.shape ∧
      (log.append h added).2.toList (log.append h added).1 = log.toList h ++ added ∧
      (∀ l : Log T, l.WF h →
        l.WF (log.append h added).1 ∧ l.toList (log.append h added).1 = l.toList h) := by
  unfold Log.append
  by_cases hemp : added.isEmpty = true
  · have hnil : added = [] := List.isEmpty_iff.mp hemp
    subst hnil
    simp [hwf, hlog]
  · have hne : added.isEmpty = false := Bool.eq_false_iff.mpr hemp
    simp only [hne, Bool.false_eq_true, ↓reduceIte]
    by_cases hbr : (!((h.getStore log.store).owned) || (h.getStore log.store).items.length != log.length) = true
    · simp only [hbr, ↓reduceIte]
      obtain ⟨hitems, _, hbs, hbm⟩ := Log.branch_wf h hwf log hlog
      obtain ⟨h1_wf, _, hsid_lt, hpres1⟩ := allocStore_wf h hwf (log.branch h) log.shape hbs hbm hlog.shape_lt
      let h1 := (h.allocStore (log.branch h) log.shape).1
      let sid := (h.allocStore (log.branch h) log.shape).2
      have hsh1 : log.shape.id < h1.views.length := hlog.shape_lt
      have hsheq1 : log.shape = h1.getStoreShape sid := by
        simpa [h1, sid] using (getStoreShape_allocStore_same h (log.branch h) log.shape hwf.storeShapes_len).symm
      have hget1 : h1.getStore sid = log.branch h := getStore_allocStore_same h (log.branch h) log.shape
      have htail := append_tail_wf h1 h1_wf log.shape hsid_lt hsh1 hsheq1 (log.branch h) hget1 added
      refine ⟨htail.1, htail.2.1, htail.2.2.1, ?_, ?_⟩
      · rw [htail.2.2.2.1, hitems]
      · intro l hl
        obtain ⟨hl1, htl1⟩ := hpres1 l hl
        obtain ⟨hl2, htl2⟩ := htail.2.2.2.2 l hl1
        exact ⟨hl2, by rw [htl2, htl1]⟩
    · have hnbr : (!((h.getStore log.store).owned) || (h.getStore log.store).items.length != log.length) = false :=
        Bool.eq_false_iff.mpr hbr
      have hlen_eq : (h.getStore log.store).items.length = log.length := by
        simp only [Bool.or_eq_false_eq_eq_false_and_eq_false, bne_eq_false_iff_eq] at hnbr
        exact hnbr.2
      simp only [hnbr, Bool.false_eq_true, ↓reduceIte]
      have htail := append_tail_wf h hwf log.shape hlog.store_lt hlog.shape_lt hlog.shape_eq (h.getStore log.store) rfl added
      have htake : (h.getStore log.store).items = log.toList h := by
        simp [Log.toList, ← hlen_eq]
      refine ⟨htail.1, htail.2.1, htail.2.2.1, ?_, htail.2.2.2.2⟩
      rw [htail.2.2.2.1, htake]

theorem Log.array_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) :
    let (h', aid) := log.array h
    h'.WF ∧ aid < h'.arrays.length ∧ (h'.getArray aid).frozen = true ∧
      (h'.getArray aid).items = log.toList h ∧
      h'.getLogArray log.id = some aid ∧
      (h.getLogArray log.id = none → mapGet (h'.getViews log.shape.id) aid = some log) ∧
      (∀ l : Log T, l.WF h → (l.id ≠ log.id ∨ l.toList h = log.toList h) →
        l.WF h' ∧ l.toList h' = l.toList h) := by
  unfold Log.array
  cases hla : h.getLogArray log.id with
  | some aid =>
    obtain ⟨ha1, ha2, ha3⟩ := hlog.array_eq aid hla
    refine ⟨hwf, ha1, ha2, ha3, hla, fun hn => by simp at hn, fun l hl _ => ⟨hl, rfl⟩⟩
  | none =>
    dsimp only
    let items := (h.getStore log.store).items.take log.length
    obtain ⟨h1_wf, haid_lt, hpres1⟩ := allocArray_wf h hwf items true
    let h1 := (h.allocArray items true).1
    let aid := (h.allocArray items true).2
    have hlog1 : log.WF h1 := (hpres1 log hlog).1
    have hlog_tl1 : log.toList h1 = items := rfl
    have harr1 : h1.getArray aid = ⟨items, true⟩ := getArray_allocArray_same h items true
    have ha1 : aid < h1.arrays.length := haid_lt
    have ha2 : (h1.getArray aid).frozen = true := by simp [harr1]
    have hnone1 : h1.getLogArray log.id = none := hla
    obtain ⟨h2_wf, hpres2⟩ := setLogArray_wf h1 h1_wf hlog1.id_lt hnone1 ha1 ha2
    let h2 := h1.setLogArray log.id (some aid)
    have hlog2 : log.WF h2 := (hpres2 log hlog1 (Or.inr (by simp [harr1, hlog_tl1]))).1
    have hsh2 : log.shape.id < h2.views.length := hlog2.shape_lt
    have ha2_lt : aid < h2.arrays.length := ha1
    have ha2_fr : (h2.getArray aid).frozen = true := ha2
    have hla2 : h2.getLogArray log.id = some aid := getLogArray_setLogArray_same h1 hlog1.id_lt (some aid)
    have htl2 : log.toList h2 = (h2.getArray aid).items := by
      change log.toList h1 = (h1.getArray aid).items
      rw [harr1, hlog_tl1]
    obtain ⟨h3_wf, hpres3⟩ := setViews_wf h2 h2_wf hsh2 aid log ha2_lt ha2_fr rfl hlog2 hla2 htl2
    let h3 := h2.setViews log.shape.id (mapSet (h2.getViews log.shape.id) aid log)
    have hcomm : (h1.setViews log.shape.id (mapSet (h1.getViews log.shape.id) aid log)).setLogArray log.id (some aid) = h3 := rfl
    rw [hcomm]
    refine ⟨h3_wf, ha2_lt, ha2_fr, ?_, hla2, ?_, ?_⟩
    · change (h1.getArray aid).items = log.toList h
      rw [harr1]
      rfl
    · intro _
      change mapGet (h3.getViews log.shape.id) aid = some log
      rw [show h3.getViews log.shape.id = mapSet (h2.getViews log.shape.id) aid log from
        getViews_setViews_same h2 hsh2 _]
      exact mapGet_mapSet_self _ _ _
    · intro l hl hcond
      obtain ⟨hl1, htl1⟩ := hpres1 l hl
      have hcond1 : l.id ≠ log.id ∨ (h1.getArray aid).items = l.toList h1 := by
        rcases hcond with hne | heq
        · exact Or.inl hne
        · exact Or.inr (by rw [harr1]; change items = l.toList h; rw [heq]; rfl)
      obtain ⟨hl2, htl2⟩ := hpres2 l hl1 hcond1
      obtain ⟨hl3, htl3⟩ := hpres3 l hl2
      exact ⟨hl3, by rw [htl3, htl2]; rfl⟩

theorem Log.firstWhere_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name : String) (test : T → Bool) :
    let h' := (log.firstWhere h name test).1
    h'.WF ∧ (∀ l : Log T, l.WF h → l.WF h' ∧ l.toList h' = l.toList h) := by
  dsimp only [Log.firstWhere]
  have hst := hwf.stores_wf log.store hlog.store_lt
  have hinit : First.WF (h.getStore log.store).items
      ((mapGet (h.getStore log.store).firsts name).getD ⟨none, 0⟩) := by
    cases hf : mapGet (h.getStore log.store).firsts name with
    | none => exact ⟨Nat.zero_le _, fun idx h => by simp at h⟩
    | some f => exact hst.1.firsts_wf name f hf
  have hupd := scanFirst_wf (h.getStore log.store).items test _ hinit
  let store' : Store T :=
    { h.getStore log.store with
      firsts := mapSet (h.getStore log.store).firsts name
        (Log.scanFirst (h.getStore log.store).items test
          ((mapGet (h.getStore log.store).firsts name).getD ⟨none, 0⟩)) }
  have hs' : Store.WF store' := by
    refine ⟨?_, hst.1.keyed_through_le⟩
    intro n f hf
    dsimp only [store'] at hf
    rw [mapGet_mapSet] at hf
    by_cases hn : n = name
    · subst hn
      simp only [beq_self_eq_true, ↓reduceIte, Option.some.injEq] at hf
      rw [← hf]
      exact hupd
    · have hb : (n == name) = false := beq_false_of_ne hn
      simp only [hb, Bool.false_eq_true, ↓reduceIte] at hf
      exact hst.1.firsts_wf n f hf
  have hm' : Store.MatchesShape store' (h.getShapeKeys (h.getStoreShape log.store).id) := hst.2.1
  exact setStore_wf h hwf hlog.store_lt store' hs' hm' (le_refl _) (fun _ _ => rfl)

theorem Log.keyed_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name : String) :
    (log.keyed h name).1.WF ∧
      (∀ l : Log T, l.WF h → l.WF (log.keyed h name).1 ∧ l.toList (log.keyed h name).1 = l.toList h) ∧
      (∀ k, (log.keyed h name).2 = .ok k →
        ∃ keysOf, h.getShapeKeys log.shape.id name = some keysOf ∧
          Keyed.WF (h.getStore log.store).items keysOf k ∧
          k.through = (h.getStore log.store).items.length) ∧
      (∀ keysOf, h.getShapeKeys log.shape.id name = some keysOf →
        (∀ item ∈ (h.getStore log.store).items, ∃ ks, keysOf item = .ok ks) →
        ∃ k, (log.keyed h name).2 = .ok k) := by
  unfold Log.keyed
  cases hkeys : h.getShapeKeys log.shape.id name with
  | none =>
    dsimp only
    refine ⟨hwf, fun l hl => ⟨hl, rfl⟩, ?_, ?_⟩
    · intro k hk; cases hk
    · intro _ hnone; cases hnone
  | some keysOf =>
    dsimp only
    have hst := hwf.stores_wf log.store hlog.store_lt
    have hinit : Keyed.WF (h.getStore log.store).items keysOf
        ((mapGet (h.getStore log.store).keyed name).getD ⟨[], 0⟩) := by
      cases hk0 : mapGet (h.getStore log.store).keyed name with
      | none =>
        refine ⟨Nat.zero_le _, by simp, ?_⟩
        intro key
        simp [keyPositionsList, mapGet, expectedPositions]
      | some k0 =>
        have hms := hst.2.1
        rw [← hlog.shape_eq] at hms
        obtain ⟨keysOf', hko', hkwf⟩ := hms name k0 hk0
        rw [hkeys] at hko'
        cases hko'
        exact hkwf
    have hstep := indexStep_wf (h.getStore log.store).items keysOf _ hinit
    dsimp only at hstep
    let fk := (Log.indexStep (h.getStore log.store).items keysOf
      ((mapGet (h.getStore log.store).keyed name).getD ⟨[], 0⟩)).1
    let store' : Store T :=
      { h.getStore log.store with keyed := mapSet (h.getStore log.store).keyed name fk }
    have hs' : Store.WF store' := by
      refine ⟨hst.1.firsts_wf, ?_⟩
      intro n k hk
      dsimp only [store'] at hk
      rw [mapGet_mapSet] at hk
      by_cases hn : n = name
      · subst hn
        simp only [beq_self_eq_true, ↓reduceIte, Option.some.injEq] at hk
        rw [← hk]
        exact hstep.1.through_le
      · have hb : (n == name) = false := beq_false_of_ne hn
        simp only [hb, Bool.false_eq_true, ↓reduceIte] at hk
        exact hst.1.keyed_through_le n k hk
    have hm' : Store.MatchesShape store' (h.getShapeKeys (h.getStoreShape log.store).id) := by
      intro n k hk
      dsimp only [store'] at hk
      rw [mapGet_mapSet] at hk
      by_cases hn : n = name
      · subst hn
        simp only [beq_self_eq_true, ↓reduceIte, Option.some.injEq] at hk
        rw [← hk, ← hlog.shape_eq]
        exact ⟨keysOf, hkeys, hstep.1⟩
      · have hb : (n == name) = false := beq_false_of_ne hn
        simp only [hb, Bool.false_eq_true, ↓reduceIte] at hk
        exact hst.2.1 n k hk
    obtain ⟨h'_wf, hpres⟩ := setStore_wf h hwf hlog.store_lt store' hs' hm' (le_refl _) (fun _ _ => rfl)
    refine ⟨h'_wf, hpres, ?_, ?_⟩
    · intro k hk
      obtain ⟨rfl, hth⟩ := hstep.2.1 k hk
      exact ⟨keysOf, rfl, hstep.1, hth⟩
    · intro keysOf' hko' htot
      cases hko'
      exact ⟨fk, hstep.2.2 htot⟩

theorem Log.firstPosition_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String) :
    (log.firstPosition h name key).1.WF ∧
      (∀ l : Log T, l.WF h → l.WF (log.firstPosition h name key).1 ∧
        l.toList (log.firstPosition h name key).1 = l.toList h) := by
  have hk := Log.keyed_wf h hwf log hlog name
  dsimp only [Log.firstPosition]
  cases hres : (log.keyed h name).2 <;> exact ⟨hk.1, hk.2.1⟩

theorem Log.first_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String) :
    (log.first h name key).1.WF ∧
      (∀ l : Log T, l.WF h → l.WF (log.first h name key).1 ∧
        l.toList (log.first h name key).1 = l.toList h) := by
  have hp := Log.firstPosition_wf h hwf log hlog name key
  dsimp only [Log.first]
  cases hres : (log.firstPosition h name key).2 with
  | error _ => exact hp
  | ok o => cases o <;> exact hp

theorem Log.has_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String) :
    (log.has h name key).1.WF ∧
      (∀ l : Log T, l.WF h → l.WF (log.has h name key).1 ∧
        l.toList (log.has h name key).1 = l.toList h) :=
  Log.firstPosition_wf h hwf log hlog name key

theorem Log.all_wf {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String) :
    (log.all h name key).1.WF ∧
      (∀ l : Log T, l.WF h → l.WF (log.all h name key).1 ∧
        l.toList (log.all h name key).1 = l.toList h) := by
  have hk := Log.keyed_wf h hwf log hlog name
  dsimp only [Log.all]
  cases hres : (log.keyed h name).2 <;> exact ⟨hk.1, hk.2.1⟩

end WellFormedness

/-! ## Laws: agreement with list operations -/

section ListAgreement

/-- A log's length is the number of entries in the list it stands for. -/
theorem Log.toList_length {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h) :
    (log.toList h).length = log.length := by
  simp [Log.toList, List.length_take, hlog.length_le]

/-- Reading an entry by positive or negative position returns the same entry as indexing the list
from the start or the end. -/
theorem Log.atPos_eq_listAt {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h)
    (position : Int) :
    log.atPos h position = listAt (log.toList h) position := by
  simp only [Log.atPos, listAt, Log.toList_length h log hlog]
  by_cases hneg : position < 0 <;> simp only [hneg, ↓reduceIte]
  · split_ifs with hcond
    · have hlt : ((log.length : Int) + position).toNat < log.length := by omega
      simp only [Log.toList]
      rw [List.getElem?_take_of_lt hlt]
    · rfl
  · split_ifs with hcond
    · have hlt : position.toNat < log.length := by omega
      simp only [Log.toList]
      rw [List.getElem?_take_of_lt hlt]
    · rfl

/-- Reading a nonnegative position returns that entry from the log's list, or nothing past the end. -/
theorem Log.atPos_nat {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h) (i : Nat) :
    log.atPos h i = (log.toList h)[i]? := by
  rw [Log.atPos_eq_listAt h log hlog i]
  simp only [listAt, Log.toList_length h log hlog]
  have hnonneg : ¬ ((i : Int) < 0) := by omega
  simp only [hnonneg, ↓reduceIte, Int.toNat_natCast]
  by_cases hlt : i < log.length
  · have hc : (0 : Int) ≤ (i : Int) ∧ (i : Int) < (log.length : Int) := by omega
    simp [hc]
  · have hc : ¬ ((0 : Int) ≤ (i : Int) ∧ (i : Int) < (log.length : Int)) := by omega
    have hge : (log.toList h).length ≤ i := by rw [Log.toList_length h log hlog]; omega
    simp [List.getElem?_eq_none hge]

/-- Reading position minus one returns the last entry in the log, or nothing when the log is empty. -/
theorem Log.atPos_neg_one {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h) :
    log.atPos h (-1) = (log.toList h).getLast? := by
  rw [Log.atPos_eq_listAt h log hlog (-1)]
  simp only [listAt, Log.toList_length h log hlog]
  have hneg : (-1 : Int) < 0 := by omega
  simp only [hneg, ↓reduceIte]
  cases hlen : log.length with
  | zero =>
    have hnil : log.toList h = [] := List.eq_nil_of_length_eq_zero (by rw [Log.toList_length h log hlog, hlen])
    simp [hnil]
  | succ n =>
    have hc : (0 : Int) ≤ (n.succ : Int) + (-1 : Int) ∧ (n.succ : Int) + (-1 : Int) < (n.succ : Int) := by omega
    have hidx : ((n.succ : Int) + (-1 : Int)).toNat = n := by omega
    simp only [hc, and_self, ↓reduceIte, hidx]
    have htl_len : (log.toList h).length = n + 1 := by rw [Log.toList_length h log hlog, hlen]
    rw [List.getLast?_eq_getElem?]
    simp [htl_len]

/-- Mapping over a log visits its entries in order with their positions, matching mapping over its list. -/
theorem Log.map_eq_listMapIdx {T U : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h)
    (transform : T → Nat → U) :
    log.map h transform = listMapIdx (log.toList h) transform := by
  unfold Log.map listMapIdx
  rw [mapSlice_eq _ _ _ _ _ (Nat.zero_le _) hlog.length_le, listMapIdx_go_eq]
  simp [Log.toList]

/-- Mapping a transform that ignores position gives the same result as mapping over the log's list. -/
theorem Log.map_const_eq_listMap {T U : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h)
    (f : T → U) :
    log.map h (fun x _ => f x) = (log.toList h).map f := by
  rw [Log.map_eq_listMapIdx h log hlog]
  suffices gen : ∀ (start : Nat) (xs : List T),
      listMapIdxFrom start xs (fun x _ => f x) = xs.map f by
    simp only [listMapIdx, listMapIdx_go_eq, List.reverse_nil, List.nil_append]
    exact gen 0 (log.toList h)
  intro start xs
  induction xs generalizing start with
  | nil => simp [listMapIdxFrom]
  | cons x rest ih => simp [listMapIdxFrom, ih]

/-- Filtering a log keeps the entries that pass the test in order, matching filtering its list. -/
theorem Log.filter_eq_listFilter {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h)
    (test : T → Bool) :
    log.filter h test = (log.toList h).filter test := by
  unfold Log.filter
  rw [filterSlice_eq _ _ _ _ _ (Nat.zero_le _) hlog.length_le]
  simp [Log.toList]

/-- Viewing a log as a history view agrees on length, indexing, and mapping with viewing its list directly. -/
theorem Log.toHistoryView_eq {T : Type} (h : HistoryHeap T) (log : Log T) (hlog : log.WF h) :
    (log.toHistoryView h).length = (listHistoryView (log.toList h)).length ∧
      (∀ i, (log.toHistoryView h).atPos i = (listHistoryView (log.toList h)).atPos i) ∧
      (∀ {U : Type} (f : T → Nat → U),
        (log.toHistoryView h).map f = (listHistoryView (log.toList h)).map f) :=
  ⟨(Log.toList_length h log hlog).symm,
    fun i => Log.atPos_eq_listAt h log hlog i,
    fun f => Log.map_eq_listMapIdx h log hlog f⟩

/-- Materializing a log yields a frozen array whose elements are the log's list, and repeating it
returns the same array without changing the heap. -/
theorem Log.array_spec {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) :
    let (h', aid) := log.array h
    (h'.getArray aid).frozen = true ∧ (h'.getArray aid).items = log.toList h ∧
      log.array h' = (h', aid) := by
  have awf := Log.array_wf h hwf log hlog
  dsimp only at awf
  refine ⟨awf.2.2.1, awf.2.2.2.1, ?_⟩
  change (match (log.array h).1.getLogArray log.id with
    | some aid => ((log.array h).1, aid)
    | none =>
      let items := ((log.array h).1.getStore log.store).items.take log.length
      let (h1, aid) := (log.array h).1.allocArray items true
      let vs := mapSet (h1.getViews log.shape.id) aid log
      let h2 := (h1.setViews log.shape.id vs).setLogArray log.id (some aid)
      (h2, aid)) = ((log.array h).1, (log.array h).2)
  rw [awf.2.2.2.2.1]

/-- Materializing a log that has not been materialized yet registers it so `logOf` returns the same log. -/
theorem Log.array_logOf_roundtrip {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (hnone : h.getLogArray log.id = none) :
    let (h', aid) := log.array h
    logOf h' log.shape aid = (h', log) := by
  have awf := Log.array_wf h hwf log hlog
  dsimp only at awf
  have hm := awf.2.2.2.2.2.1 hnone
  unfold logOf
  simp [hm]

private theorem list_find_of_idx {T : Type} (xs : List T) (test : T → Bool)
    (idx : Nat) (hlt : idx < xs.length) (x : T) (hx : xs[idx]? = some x)
    (ht : test x = true) (hprev : ∀ j, j < idx → ∀ y, xs[j]? = some y → test y = false) :
    xs.find? test = some x := by
  induction xs generalizing idx with
  | nil => simp at hlt
  | cons a rest ih =>
    cases idx with
    | zero =>
      simp only [List.getElem?_cons_zero, Option.some.injEq] at hx
      subst hx
      simp [List.find?, ht]
    | succ k =>
      have ha : test a = false := hprev 0 (Nat.zero_lt_succ k) a rfl
      simp only [List.find?, ha]
      apply ih k (by simp at hlt; omega) (by simpa using hx)
      intro j hj y hy
      exact hprev (j + 1) (Nat.succ_lt_succ hj) y (by simpa using hy)

private theorem list_find_none_of_all_false {T : Type} (xs : List T) (test : T → Bool)
    (hall : ∀ j, j < xs.length → ∀ y, xs[j]? = some y → test y = false) :
    xs.find? test = none := by
  induction xs with
  | nil => simp
  | cons a rest ih =>
    have ha : test a = false := hall 0 (by simp) a rfl
    simp only [List.find?, ha]
    apply ih
    intro j hj y hy
    exact hall (j + 1) (by simp at hj ⊢; omega) y (by simpa using hy)

/-- Finding the first matching entry under a consistent named test agrees with searching the
log's list. -/
theorem Log.firstWhere_eq_find? {T : Type} (h : HistoryHeap T) (_hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name : String) (test : T → Bool)
    (hm : Store.FirstMatches (h.getStore log.store) name test) :
    (log.firstWhere h name test).2 = (log.toList h).find? test := by
  dsimp only [Log.firstWhere]
  have hinit : First.Matches (h.getStore log.store).items test
      ((mapGet (h.getStore log.store).firsts name).getD ⟨none, 0⟩) := by
    cases hf : mapGet (h.getStore log.store).firsts name with
    | none =>
      refine ⟨⟨Nat.zero_le _, fun _ h => by simp at h⟩, fun _ h => by simp at h, fun j hj => by simp at hj⟩
    | some f => exact hm f hf
  obtain ⟨hres, hnone⟩ := scanFirst_matches (h.getStore log.store).items test _ hinit
  cases hsf : (Log.scanFirst (h.getStore log.store).items test
      ((mapGet (h.getStore log.store).firsts name).getD ⟨none, 0⟩)).found with
  | none =>
    simp only
    symm
    apply list_find_none_of_all_false
    intro j hj y hy
    rw [Log.toList_length h log hlog] at hj
    simp only [Log.toList] at hy
    rw [List.getElem?_take_of_lt hj] at hy
    have hsc := hnone hsf
    exact hres.before_false j (by simp [hsf, hsc]; exact Nat.lt_of_lt_of_le hj hlog.length_le) y hy
  | some idx =>
    simp only
    by_cases hlt : idx < log.length
    · simp only [hlt, ↓reduceIte]
      obtain ⟨item, hitem, htest⟩ := hres.found_true idx hsf
      rw [hitem]
      symm
      apply list_find_of_idx (log.toList h) test idx (by rw [Log.toList_length h log hlog]; exact hlt)
      · simp only [Log.toList]; rw [List.getElem?_take_of_lt hlt]; exact hitem
      · exact htest
      · intro j hj y hy
        simp only [Log.toList] at hy
        rw [List.getElem?_take_of_lt (Nat.lt_trans hj hlt)] at hy
        exact hres.before_false j (by simp [hsf]; exact hj) y hy
    · simp only [hlt, ↓reduceIte]
      symm
      apply list_find_none_of_all_false
      intro j hj y hy
      rw [Log.toList_length h log hlog] at hj
      simp only [Log.toList] at hy
      rw [List.getElem?_take_of_lt hj] at hy
      exact hres.before_false j (by simp [hsf]; omega) y hy

/-- Calling `firstWhere` with a different test under an already-cached `name` returns the earlier
test's cached entry rather than searching with the new test. -/
theorem Log.firstWhere_stale_cache {T : Type} (h : HistoryHeap T) (_hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name : String) (test1 test2 : T → Bool)
    {item : T} (h1 : (log.firstWhere h name test1).2 = some item) :
    (log.firstWhere (log.firstWhere h name test1).1 name test2).2 = some item := by
  dsimp only [Log.firstWhere] at h1 ⊢
  let upd1 := Log.scanFirst (h.getStore log.store).items test1
    ((mapGet (h.getStore log.store).firsts name).getD ⟨none, 0⟩)
  let store1 : Store T :=
    { h.getStore log.store with firsts := mapSet (h.getStore log.store).firsts name upd1 }
  have hget : (h.setStore log.store store1).getStore log.store = store1 :=
    getStore_setStore_same h hlog.store_lt store1
  cases hsf : upd1.found with
  | none => simp [upd1, hsf] at h1
  | some idx =>
    have hlt : idx < log.length := by
      by_cases hc : idx < log.length
      · exact hc
      · simp [upd1, hsf, hc] at h1
    have hitem : (h.getStore log.store).items[idx]? = some item := by
      simpa [upd1, hsf, hlt] using h1
    have hscan2 : Log.scanFirst store1.items test2
        ((mapGet store1.firsts name).getD ⟨none, 0⟩) = upd1 := by
      simp only [store1, mapGet_mapSet_self, Option.getD]
      unfold Log.scanFirst
      simp [hsf]
    change (match (Log.scanFirst ((h.setStore log.store store1).getStore log.store).items test2
        ((mapGet ((h.setStore log.store store1).getStore log.store).firsts name).getD ⟨none, 0⟩)).found with
      | some idx => if idx < log.length then ((h.setStore log.store store1).getStore log.store).items[idx]? else none
      | none => none) = some item
    rw [hget, hscan2, hsf]
    simp [hlt, store1, hitem]

/-- Asking a named lookup not registered on the log's shape fails with an unknown-lookup error. -/
theorem Log.keyed_unknownLookup {T : Type} (h : HistoryHeap T) (log : Log T) (name : String)
    (hnone : h.getShapeKeys log.shape.id name = none) :
    log.keyed h name = (h, .error (.unknownLookup name)) := by
  simp [Log.keyed, hnone]

/-- If reading keys fails on an entry (even beyond this log's end in a shared store), the lookup
errors while keeping earlier entries indexed consistently. -/
theorem Log.keyed_partial_error {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name : String) {e : HistoryErr}
    (herr : (log.keyed h name).2 = .error e) :
    (log.keyed h name).1.WF ∧
      (e = .unknownLookup name ∨
        ∃ keysOf k, h.getShapeKeys log.shape.id name = some keysOf ∧
          mapGet ((log.keyed h name).1.getStore log.store).keyed name = some k ∧
          Keyed.WF (h.getStore log.store).items keysOf k) := by
  have hkwf := Log.keyed_wf h hwf log hlog name
  refine ⟨hkwf.1, ?_⟩
  unfold Log.keyed at herr ⊢
  cases hkeys : h.getShapeKeys log.shape.id name with
  | none =>
    simp only [hkeys] at herr
    cases herr
    exact Or.inl rfl
  | some keysOf =>
    right
    have hst := hwf.stores_wf log.store hlog.store_lt
    have hinit : Keyed.WF (h.getStore log.store).items keysOf
        ((mapGet (h.getStore log.store).keyed name).getD ⟨[], 0⟩) := by
      cases hk0 : mapGet (h.getStore log.store).keyed name with
      | none =>
        exact ⟨Nat.zero_le _, by simp, fun key => by simp [keyPositionsList, mapGet, expectedPositions]⟩
      | some k0 =>
        have hms := hst.2.1
        rw [← hlog.shape_eq] at hms
        obtain ⟨keysOf', hko', hk0wf⟩ := hms name k0 hk0
        rw [hkeys] at hko'
        cases hko'
        exact hk0wf
    have hstep := indexStep_wf (h.getStore log.store).items keysOf _ hinit
    dsimp only at hstep
    let fk := (Log.indexStep (h.getStore log.store).items keysOf
      ((mapGet (h.getStore log.store).keyed name).getD ⟨[], 0⟩)).1
    refine ⟨keysOf, fk, rfl, ?_, hstep.1⟩
    dsimp only
    rw [getStore_setStore_same h hlog.store_lt]
    simp [mapGet_mapSet_self, fk]

/-- Whether `keysOf` emits `key` on `item` without failing. -/
def itemHasKey {T : Type} (keysOf : T → Except HistoryErr (List String))
    (key : String) (item : T) : Bool :=
  match keysOf item with
  | .ok ks => ks.contains key
  | .error _ => false

private theorem pairwise_lt_range (n : Nat) : (List.range n).Pairwise (· < ·) := by
  induction n with
  | zero => simp
  | succ k ih =>
    rw [List.range_succ, List.pairwise_append]
    exact ⟨ih, by simp, fun a ha b hb => by simp at hb; subst hb; exact List.mem_range.mp ha⟩

private theorem expectedPositions_pairwise {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) :
    (expectedPositions items keysOf key).Pairwise (· < ·) :=
  List.Pairwise.filter _ (pairwise_lt_range items.length)

private theorem expectedPositions_take_succ_any {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) {n : Nat}
    (hn : n < items.length) {item : T} (hitem : items[n]? = some item) :
    expectedPositions (items.take (n + 1)) keysOf key =
      if itemHasKey keysOf key item then expectedPositions (items.take n) keysOf key ++ [n]
      else expectedPositions (items.take n) keysOf key := by
  rw [expectedPositions_take_eq, expectedPositions_take_eq]
  have h1 : min (n + 1) items.length = n + 1 := by omega
  have h2 : min n items.length = n := by omega
  rw [h1, h2, List.range_succ, List.filter_append]
  have hsing : List.filter (fun pos =>
      match items[pos]? with
      | some item => match keysOf item with | .ok ks => ks.contains key | .error _ => false
      | none => false) [n] = if itemHasKey keysOf key item then [n] else [] := by
    simp only [List.filter_cons, List.filter_nil, hitem]
    cases hko : keysOf item with
    | error e => simp [itemHasKey, hko]
    | ok ks => by_cases hc : key ∈ ks <;> simp [itemHasKey, hko, hc]
  rw [hsing]
  by_cases hc : itemHasKey keysOf key item = true <;> simp [hc]

private theorem expectedPositions_filterMap {T : Type} (xs : List T)
    (keysOf : T → Except HistoryErr (List String)) (key : String) :
    (expectedPositions xs keysOf key).filterMap (fun p => xs[p]?) =
      xs.filter (itemHasKey keysOf key) := by
  suffices h : ∀ n, n ≤ xs.length →
      (expectedPositions (xs.take n) keysOf key).filterMap (fun p => xs[p]?) =
        (xs.take n).filter (itemHasKey keysOf key) by
    simpa [List.take_length] using h xs.length (le_refl _)
  intro n hn
  induction n with
  | zero => simp [expectedPositions]
  | succ k ih =>
    have hk : k < xs.length := by omega
    have hitem : xs[k]? = some xs[k] := List.getElem?_eq_getElem hk
    rw [expectedPositions_take_succ_any xs keysOf key hk hitem, List.take_succ_eq_append_getElem hk,
      List.filter_append]
    by_cases hc : itemHasKey keysOf key xs[k] = true
    · simp only [hc, ↓reduceIte, List.filterMap_append, List.filterMap_cons, hitem,
        List.filterMap_nil, List.filter_cons, List.filter_nil]
      rw [ih (by omega)]
    · have hcf : itemHasKey keysOf key xs[k] = false := Bool.eq_false_iff.mpr hc
      simp only [hcf, Bool.false_eq_true, ↓reduceIte, List.filter_cons, List.filter_nil, List.append_nil]
      exact ih (by omega)

private theorem pairwise_head?_filter_lt (ps : List Nat) (len : Nat)
    (hpw : ps.Pairwise (· < ·)) :
    (match ps.head? with | some p => if p < len then some p else none | none => none) =
      (ps.filter (· < len)).head? := by
  cases ps with
  | nil => simp
  | cons p rest =>
    simp only [List.head?_cons, List.filter_cons]
    by_cases hp : p < len
    · simp [hp]
    · have hall : rest.filter (· < len) = [] := by
        rw [List.filter_eq_nil_iff]
        intro q hq
        have hlt := (List.pairwise_cons.mp hpw).1 q hq
        simp; omega
      simp [hp, hall]

private theorem filter_head?_eq_find? {T : Type} (xs : List T) (p : T → Bool) :
    (xs.filter p).head? = xs.find? p := by
  induction xs with
  | nil => simp
  | cons x rest ih =>
    by_cases hx : p x = true
    · simp [hx]
    · simp [Bool.eq_false_iff.mpr hx, ih]

private theorem filter_head?_isSome_eq_any {T : Type} (xs : List T) (p : T → Bool) :
    (xs.filter p).head?.isSome = xs.any p := by
  induction xs with
  | nil => simp
  | cons x rest ih =>
    by_cases hx : p x = true
    · simp [hx]
    · simp only [List.filter_cons, Bool.eq_false_iff.mpr hx, Bool.false_eq_true, ↓reduceIte,
        List.any_cons, Bool.false_or, ih]

/-- Collecting all entries matching a key in a named lookup agrees with filtering the log's list
when key extraction succeeds on every entry in the backing store. -/
theorem Log.all_eq_filter {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String)
    {keysOf : T → Except HistoryErr (List String)}
    (hkeys : h.getShapeKeys log.shape.id name = some keysOf)
    (htot : ∀ item ∈ (h.getStore log.store).items, ∃ ks, keysOf item = .ok ks) :
    (log.all h name key).2 = .ok ((log.toList h).filter (itemHasKey keysOf key)) := by
  have hkwf := Log.keyed_wf h hwf log hlog name
  obtain ⟨k, hk⟩ := hkwf.2.2.2 keysOf hkeys htot
  obtain ⟨keysOf', hko', hk_wf, hth⟩ := hkwf.2.2.1 k hk
  rw [hkeys] at hko'
  cases hko'
  dsimp only [Log.all]
  rw [hk]
  simp only
  have hpos : (match mapGet k.positions key with
      | none => []
      | some (.single p) => [p]
      | some (.many ps) => ps) = keyPositionsList k.positions key := by
    cases hmg : mapGet k.positions key with
    | none => simp [hmg, keyPositionsList]
    | some kp => cases kp <;> simp [hmg, keyPositionsList, KeyPositions.toList]
  have hkp : keyPositionsList k.positions key = expectedPositions (h.getStore log.store).items keysOf key := by
    rw [hk_wf.positions_spec key, hth, List.take_length]
  rw [hpos, hkp]
  have hf_take : (expectedPositions (h.getStore log.store).items keysOf key).filter (· < log.length) =
      expectedPositions (log.toList h) keysOf key := by
    conv_lhs => rw [← List.take_length (l := (h.getStore log.store).items)]
    rw [expectedPositions_take_filter, Nat.min_eq_right hlog.length_le]
    rfl
  rw [hf_take]
  have hfm : ((expectedPositions (log.toList h) keysOf key).filterMap
      (fun p => ((log.keyed h name).1.getStore log.store).items[p]?)) =
      (expectedPositions (log.toList h) keysOf key).filterMap (fun p => (log.toList h)[p]?) := by
    have hst_eq : ((log.keyed h name).1.getStore log.store).items = (h.getStore log.store).items := by
      unfold Log.keyed
      rw [hkeys]
      dsimp only
      rw [getStore_setStore_same h hlog.store_lt]
    rw [hst_eq]
    apply List.filterMap_congr
    intro p hp
    have hplt : p < log.length := by
      have := expectedPositions_lt _ _ _ hp
      rwa [Log.toList_length h log hlog] at this
    simp only [Log.toList]
    rw [List.getElem?_take_of_lt hplt]
  change Except.ok ((expectedPositions (log.toList h) keysOf key).filterMap
    (fun p => ((log.keyed h name).1.getStore log.store).items[p]?)) = _
  rw [hfm, expectedPositions_filterMap]

private theorem Log.firstPosition_eq_head? {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String)
    {keysOf : T → Except HistoryErr (List String)}
    (hkeys : h.getShapeKeys log.shape.id name = some keysOf)
    (htot : ∀ item ∈ (h.getStore log.store).items, ∃ ks, keysOf item = .ok ks) :
    (log.firstPosition h name key).2 =
      .ok (expectedPositions (log.toList h) keysOf key).head? := by
  have hkwf := Log.keyed_wf h hwf log hlog name
  obtain ⟨k, hk⟩ := hkwf.2.2.2 keysOf hkeys htot
  obtain ⟨keysOf', hko', hk_wf, hth⟩ := hkwf.2.2.1 k hk
  rw [hkeys] at hko'
  cases hko'
  have hpos_head : (match mapGet k.positions key with
      | none => none
      | some (.single p) => some p
      | some (.many ps) => ps.head?) = (keyPositionsList k.positions key).head? := by
    cases hmg : mapGet k.positions key with
    | none => simp [hmg, keyPositionsList]
    | some kp => cases kp <;> simp [hmg, keyPositionsList, KeyPositions.toList]
  have hkp : keyPositionsList k.positions key = expectedPositions (h.getStore log.store).items keysOf key := by
    rw [hk_wf.positions_spec key, hth, List.take_length]
  dsimp only [Log.firstPosition]
  rw [hk]
  simp only
  rw [hpos_head, hkp, pairwise_head?_filter_lt _ _ (expectedPositions_pairwise _ _ _)]
  conv_lhs => rw [← List.take_length (l := (h.getStore log.store).items)]
  rw [expectedPositions_take_filter, Nat.min_eq_right hlog.length_le]
  rfl

/-- Finding the first entry matching a key in a named lookup agrees with searching the log's list
when key extraction succeeds on every entry in the backing store. -/
theorem Log.first_eq_find? {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String)
    {keysOf : T → Except HistoryErr (List String)}
    (hkeys : h.getShapeKeys log.shape.id name = some keysOf)
    (htot : ∀ item ∈ (h.getStore log.store).items, ∃ ks, keysOf item = .ok ks) :
    (log.first h name key).2 = .ok ((log.toList h).find? (itemHasKey keysOf key)) := by
  have hst_eq : ((log.keyed h name).1.getStore log.store).items = (h.getStore log.store).items := by
    unfold Log.keyed; rw [hkeys]; dsimp only; rw [getStore_setStore_same h hlog.store_lt]
  have hfp := Log.firstPosition_eq_head? h hwf log hlog name key hkeys htot
  have hfp_st : (log.firstPosition h name key).1 = (log.keyed h name).1 := by
    dsimp only [Log.firstPosition]; cases (log.keyed h name).2 <;> rfl
  have hhead : ((expectedPositions (log.toList h) keysOf key).head?).bind
      (fun p => (h.getStore log.store).items[p]?) = (log.toList h).find? (itemHasKey keysOf key) := by
    have hfm := expectedPositions_filterMap (log.toList h) keysOf key
    rw [← filter_head?_eq_find?, ← hfm]
    cases hps : expectedPositions (log.toList h) keysOf key with
    | nil => simp
    | cons p rest =>
      have hp : p ∈ expectedPositions (log.toList h) keysOf key := by rw [hps]; simp
      have hplt : p < log.length := by
        have := expectedPositions_lt _ _ _ hp
        rwa [Log.toList_length h log hlog] at this
      have hpeq : (log.toList h)[p]? = (h.getStore log.store).items[p]? := by
        simp only [Log.toList]; rw [List.getElem?_take_of_lt hplt]
      have hp_len : p < (h.getStore log.store).items.length := Nat.lt_of_lt_of_le hplt hlog.length_le
      obtain ⟨it, hit⟩ : ∃ it, (h.getStore log.store).items[p]? = some it :=
        ⟨(h.getStore log.store).items[p], List.getElem?_eq_getElem hp_len⟩
      simp [hpeq, hit]
  dsimp only [Log.first]
  rw [hfp]
  cases hhd : (expectedPositions (log.toList h) keysOf key).head? with
  | none =>
    simp only
    rw [← hhead, hhd]
    rfl
  | some p =>
    simp only
    rw [hfp_st, hst_eq, ← hhead, hhd]
    rfl

/-- Checking whether any entry carries a key in a named lookup agrees with testing the log's list
when key extraction succeeds on every entry in the backing store. -/
theorem Log.has_eq_any {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (name key : String)
    {keysOf : T → Except HistoryErr (List String)}
    (hkeys : h.getShapeKeys log.shape.id name = some keysOf)
    (htot : ∀ item ∈ (h.getStore log.store).items, ∃ ks, keysOf item = .ok ks) :
    (log.has h name key).2 = .ok ((log.toList h).any (itemHasKey keysOf key)) := by
  have hfp := Log.firstPosition_eq_head? h hwf log hlog name key hkeys htot
  dsimp only [Log.has]
  rw [hfp]
  have hfm := expectedPositions_filterMap (log.toList h) keysOf key
  have his : (expectedPositions (log.toList h) keysOf key).head?.isSome =
      ((log.toList h).filter (itemHasKey keysOf key)).head?.isSome := by
    rw [← hfm]
    cases hps : expectedPositions (log.toList h) keysOf key with
    | nil => simp
    | cons p rest =>
      have hp : p ∈ expectedPositions (log.toList h) keysOf key := by rw [hps]; simp
      have hplt : p < (log.toList h).length := expectedPositions_lt _ _ _ hp
      obtain ⟨it, hit⟩ : ∃ it, (log.toList h)[p]? = some it :=
        ⟨(log.toList h)[p], List.getElem?_eq_getElem hplt⟩
      simp [hit]
  change Except.ok (expectedPositions (log.toList h) keysOf key).head?.isSome = _
  rw [his, filter_head?_isSome_eq_any]

end ListAgreement

/-! ## Laws: appending -/

section AppendLaws

/-- Appending an empty list returns the original log without modifying the heap. -/
theorem Log.append_empty {T : Type} (h : HistoryHeap T) (log : Log T) :
    log.append h [] = (h, log) := by
  simp [Log.append]

/-- Appending entries yields a new log whose list is the prior list followed by those entries. -/
theorem Log.append_toList {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (added : List T)
    {h' : HistoryHeap T} {log' : Log T} (hres : log.append h added = (h', log')) :
    log'.toList h' = log.toList h ++ added := by
  have hawf := Log.append_wf h hwf log hlog added
  rw [hres] at hawf
  exact hawf.2.2.2.1

/-- Appending a single entry adds it at the end and leaves all prior entries unchanged. -/
theorem Log.append_single {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (item : T)
    {h' : HistoryHeap T} {log' : Log T} (hres : log.append h [item] = (h', log')) :
    log'.toList h' = log.toList h ++ [item] ∧
      log'.length = log.length + 1 ∧
      (∀ i : Nat, i < log.length → log'.atPos h' i = log.atPos h i) ∧
      log'.atPos h' (-1) = some item := by
  have hawf := Log.append_wf h hwf log hlog [item]
  rw [hres] at hawf
  have hlen : log'.length = log.length + 1 := by
    rw [← Log.toList_length h' log' hawf.2.1, hawf.2.2.2.1, List.length_append,
      List.length_singleton, Log.toList_length h log hlog]
  refine ⟨hawf.2.2.2.1, hlen, ?_, ?_⟩
  · intro i hi
    rw [Log.atPos_nat h' log' hawf.2.1, Log.atPos_nat h log hlog, hawf.2.2.2.1]
    have hlt : i < (log.toList h).length := by rw [Log.toList_length h log hlog]; exact hi
    exact List.getElem?_append_left hlt
  · rw [Log.atPos_neg_one h' log' hawf.2.1, hawf.2.2.2.1, List.getLast?_append_of_ne_nil _ (by simp)]
    simp

/-- Every position that existed before an append still holds the same entry in the new log. -/
theorem Log.append_atPos_prior {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (added : List T) {i : Nat} (hi : i < log.length)
    {h' : HistoryHeap T} {log' : Log T} (hres : log.append h added = (h', log')) :
    log'.atPos h' i = log.atPos h i := by
  have hawf := Log.append_wf h hwf log hlog added
  rw [hres] at hawf
  rw [Log.atPos_nat h' log' hawf.2.1, Log.atPos_nat h log hlog, hawf.2.2.2.1]
  have hlt : i < (log.toList h).length := by rw [Log.toList_length h log hlog]; exact hi
  exact List.getElem?_append_left hlt

/-- Each newly appended entry sits at its offset after the prior length. -/
theorem Log.append_atPos_added {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (log : Log T) (hlog : log.WF h) (added : List T) (j : Nat)
    {h' : HistoryHeap T} {log' : Log T} (hres : log.append h added = (h', log')) :
    log'.atPos h' (log.length + j : Nat) = added[j]? := by
  have hawf := Log.append_wf h hwf log hlog added
  rw [hres] at hawf
  rw [Log.atPos_nat h' log' hawf.2.1, hawf.2.2.2.1]
  have hlen : (log.toList h).length = log.length := Log.toList_length h log hlog
  rw [List.getElem?_append_right (by omega), hlen]
  simp

end AppendLaws

/-! ## Laws: shared storage and stability of earlier logs -/

section SharingLaws

/-- When a log owns its store and sits at the end of it, appending a nonempty list extends that
shared store in place without allocating a new store. -/
theorem Log.append_shares_store_at_head {T : Type} (h : HistoryHeap T) (log : Log T)
    (howned : (h.getStore log.store).owned = true)
    (hat_head : (h.getStore log.store).items.length = log.length)
    (added : List T) (hne : added ≠ [])
    {h' : HistoryHeap T} {log' : Log T} (hres : log.append h added = (h', log')) :
    log'.store = log.store ∧ h'.stores.length = h.stores.length ∧
      (h'.getStore log.store).owned = true ∧
      (h'.getStore log.store).items.length = log'.length := by
  have hemp : added.isEmpty = false := by
    cases added with
    | nil => exact absurd rfl hne
    | cons _ _ => rfl
  have hbr : (!((h.getStore log.store).owned) || (h.getStore log.store).items.length != log.length) = false := by
    simp [howned, hat_head]
  unfold Log.append at hres
  simp only [hemp, Bool.false_eq_true, ↓reduceIte, hbr] at hres
  dsimp only [HistoryHeap.allocLog, HistoryHeap.setStore] at hres
  cases hres
  have hlt : log.store < h.stores.length := by
    by_contra hge
    have hnone : h.stores[log.store]? = none := List.getElem?_eq_none (Nat.le_of_not_lt hge)
    have hget0 : (h.getStore log.store).owned = false := by
      simp [HistoryHeap.getStore, hnone]; rfl
    rw [hget0] at howned
    cases howned
  have hget : (h.setStore log.store { h.getStore log.store with items := (h.getStore log.store).items ++ added }).getStore log.store =
      { h.getStore log.store with items := (h.getStore log.store).items ++ added } :=
    getStore_setStore_same h hlt _
  refine ⟨rfl, by simp, ?_, ?_⟩
  · change ((h.setStore log.store { h.getStore log.store with items := (h.getStore log.store).items ++ added }).getStore log.store).owned = true
    rw [hget]
    exact howned
  · change ((h.setStore log.store { h.getStore log.store with items := (h.getStore log.store).items ++ added }).getStore log.store).items.length =
      ((h.getStore log.store).items ++ added).length
    rw [hget]

/-- Appending to any log, including a later log that shares the same backing store, leaves every
earlier valid log's list, length, indexing, mapping, filtering, and history view unchanged. -/
theorem Log.earlier_unchanged_after_append {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (earlier later : Log T) (hearlier : earlier.WF h) (hlater : later.WF h)
    (added : List T) {h' : HistoryHeap T} {log' : Log T}
    (hres : later.append h added = (h', log')) :
    earlier.WF h' ∧ earlier.toList h' = earlier.toList h ∧
      (∀ i, earlier.atPos h' i = earlier.atPos h i) ∧
      (∀ {U : Type} (f : T → Nat → U), earlier.map h' f = earlier.map h f) ∧
      (∀ p, earlier.filter h' p = earlier.filter h p) ∧
      (earlier.toHistoryView h').length = (earlier.toHistoryView h).length := by
  have hawf := Log.append_wf h hwf later hlater added
  rw [hres] at hawf
  obtain ⟨hwf', htl⟩ := hawf.2.2.2.2 earlier hearlier
  refine ⟨hwf', htl, ?_, ?_, ?_, rfl⟩
  · intro i
    rw [Log.atPos_eq_listAt h' earlier hwf', Log.atPos_eq_listAt h earlier hearlier, htl]
  · intro U f
    rw [Log.map_eq_listMapIdx h' earlier hwf', Log.map_eq_listMapIdx h earlier hearlier, htl]
  · intro p
    rw [Log.filter_eq_listFilter h' earlier hwf', Log.filter_eq_listFilter h earlier hearlier, htl]

/-- Materializing, scanning, or indexing a log leaves every earlier valid log's list unchanged. -/
theorem Log.earlier_unchanged_after_queries {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (earlier later : Log T) (hearlier : earlier.WF h) (hlater : later.WF h)
    (hne_id : earlier.id ≠ later.id) (name key : String) (test : T → Bool) :
    earlier.toList (later.array h).1 = earlier.toList h ∧
      earlier.toList (later.firstWhere h name test).1 = earlier.toList h ∧
      earlier.toList (later.keyed h name).1 = earlier.toList h ∧
      earlier.toList (later.first h name key).1 = earlier.toList h ∧
      earlier.toList (later.has h name key).1 = earlier.toList h ∧
      earlier.toList (later.all h name key).1 = earlier.toList h :=
  ⟨((Log.array_wf h hwf later hlater).2.2.2.2.2.2 earlier hearlier (Or.inl hne_id)).2,
    ((Log.firstWhere_wf h hwf later hlater name test).2 earlier hearlier).2,
    ((Log.keyed_wf h hwf later hlater name).2.1 earlier hearlier).2,
    ((Log.first_wf h hwf later hlater name key).2 earlier hearlier).2,
    ((Log.has_wf h hwf later hlater name key).2 earlier hearlier).2,
    ((Log.all_wf h hwf later hlater name key).2 earlier hearlier).2⟩

/-- Mutating an unfrozen JavaScript array after creating a log from it leaves the log's list unchanged. -/
theorem Log.unfrozen_mutation_isolated {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (shape : Shape T) (hsh : shape.id < h.views.length)
    (aid : ArrayId) (haid : aid < h.arrays.length) (newItems : List T)
    {h1 : HistoryHeap T} {log : Log T} (hlo_eq : logOf h shape aid = (h1, log)) :
    let h2 := h1.mutateArray aid newItems
    log.WF h2 ∧ log.toList h2 = (h.getArray aid).items := by
  have hlo := logOf_wf h hwf shape hsh aid haid
  rw [hlo_eq] at hlo
  have hm := mutateArray_wf h1 hlo.1 aid newItems
  have hlog2 := hm.2 log hlo.2.1
  exact ⟨hlog2.1, by rw [hlog2.2, hlo.2.2.2.1]⟩

/-- Appending a nonempty list to a log backed by a frozen array leaves the frozen array untouched
and gives the new log its own owned store. -/
theorem Log.frozen_append_branches {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (shape : Shape T) (hsh : shape.id < h.views.length)
    (aid : ArrayId) (haid : aid < h.arrays.length) (hf : (h.getArray aid).frozen = true)
    (hnone : mapGet (h.getViews shape.id) aid = none)
    (added : List T) (hne : added ≠ [])
    {h1 h2 : HistoryHeap T} {log0 log1 : Log T}
    (hlo_eq : logOf h shape aid = (h1, log0))
    (happ_eq : log0.append h1 added = (h2, log1)) :
    log1.store ≠ log0.store ∧ (h2.getStore log1.store).owned = true ∧
      h2.getArray aid = h.getArray aid ∧ log1.toList h2 = (h.getArray aid).items ++ added := by
  have hlo := logOf_wf h hwf shape hsh aid haid
  rw [hlo_eq] at hlo
  have howned0 : (h1.getStore log0.store).owned = false := by
    unfold logOf at hlo_eq
    simp only [hnone, hf, ↓reduceIte, HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setViews] at hlo_eq
    injection hlo_eq with hh1 hlog0
    rw [← hh1, ← hlog0]
    simp [HistoryHeap.getStore]
  have hemp : added.isEmpty = false := by
    cases added with
    | nil => exact absurd rfl hne
    | cons _ _ => rfl
  have hbr : (!((h1.getStore log0.store).owned) || (h1.getStore log0.store).items.length != log0.length) = true := by
    simp [howned0]
  have hlo_arr : h1.getArray aid = h.getArray aid := by
    unfold logOf at hlo_eq
    simp only [hnone, hf, ↓reduceIte, HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setViews] at hlo_eq
    injection hlo_eq with hh1 _
    rw [← hh1]
    rfl
  have happ := Log.append_wf h1 hlo.1 log0 hlo.2.1 added
  rw [happ_eq] at happ
  have hlog1_store : log1.store = h1.stores.length := by
    unfold Log.append at happ_eq
    simp only [hemp, Bool.false_eq_true, ↓reduceIte, hbr,
      HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setStore] at happ_eq
    injection happ_eq with _ hlog1
    rw [← hlog1]
  have hstore0_lt : log0.store < h1.stores.length := hlo.2.1.store_lt
  have howned1 : (h2.getStore log1.store).owned = true := by
    unfold Log.append at happ_eq
    simp only [hemp, Bool.false_eq_true, ↓reduceIte, hbr,
      HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setStore] at happ_eq
    injection happ_eq with hh2 hlog1
    rw [← hh2, ← hlog1]
    have hlt : h1.stores.length < (h1.stores ++ [log0.branch h1]).length := by simp
    simp [HistoryHeap.getStore, Log.branch]
  have harr2 : h2.getArray aid = h1.getArray aid := by
    unfold Log.append at happ_eq
    simp only [hemp, Bool.false_eq_true, ↓reduceIte, hbr,
      HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setStore] at happ_eq
    injection happ_eq with hh2 _
    rw [← hh2]
    rfl
  refine ⟨by rw [hlog1_store]; exact Nat.ne_of_gt hstore0_lt, howned1, by rw [harr2, hlo_arr], ?_⟩
  rw [happ.2.2.2.1, hlo.2.2.2.1]

end SharingLaws

/-! ## Laws: branching from an earlier log and edge-case behaviors -/

section BranchingLaws

/-- Appending a nonempty list to a log whose length differs from its backing store's length
allocates a fresh owned store and leaves the old store untouched. -/
theorem Log.append_branches_when_behind {T : Type} (h : HistoryHeap T)
    (log : Log T) (hlog : log.WF h)
    (hbehind : (h.getStore log.store).items.length ≠ log.length)
    (added : List T) (hne : added ≠ [])
    {h' : HistoryHeap T} {branch : Log T}
    (happ : log.append h added = (h', branch)) :
    branch.store = h.stores.length ∧ branch.store ≠ log.store ∧
      h'.stores.length = h.stores.length + 1 ∧
      (h'.getStore branch.store).owned = true ∧
      h'.getStore log.store = h.getStore log.store := by
  have hemp : added.isEmpty = false := by
    cases added with
    | nil => exact absurd rfl hne
    | cons _ _ => rfl
  have hbr : (!((h.getStore log.store).owned) || (h.getStore log.store).items.length != log.length) = true := by
    simp [bne_iff_ne.mpr hbehind]
  unfold Log.append at happ
  simp only [hemp, Bool.false_eq_true, ↓reduceIte, hbr,
    HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setStore] at happ
  have hstore_lt : log.store < h.stores.length := hlog.store_lt
  injection happ with hh' hbr_log
  rw [← hh', ← hbr_log]
  refine ⟨rfl, Nat.ne_of_gt hstore_lt, by simp, ?_, ?_⟩
  · simp [HistoryHeap.getStore, Log.branch]
  · simp only [HistoryHeap.getStore]
    rw [listGetD_set_ne _ (Nat.ne_of_gt hstore_lt), listGetD_append_lt _ _ hstore_lt]

/-- Appending to an earlier log after a later log has extended their shared store branches onto a
fresh owned store, leaves both the earlier and newer logs unchanged, and keeps further appends
on the branch isolated from the newer log. -/
theorem Log.branch_does_not_corrupt_newer {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (older : Log T) (holder : older.WF h)
    (added1 added2 : List T) (hne1 : added1 ≠ []) (hne2 : added2 ≠ [])
    {h1 h2 : HistoryHeap T} {newer branch : Log T}
    (happ1 : older.append h added1 = (h1, newer))
    (happ2 : older.append h1 added2 = (h2, branch)) :
    h2.WF ∧ older.WF h2 ∧ newer.WF h2 ∧ branch.WF h2 ∧
      branch.store ≠ newer.store ∧ branch.store ≠ older.store ∧
      older.toList h2 = older.toList h ∧
      newer.toList h2 = older.toList h ++ added1 ∧
      branch.toList h2 = older.toList h ++ added2 ∧
      (∀ added3 {h3 : HistoryHeap T} {branch' : Log T},
        branch.append h2 added3 = (h3, branch') →
        newer.WF h3 ∧ newer.toList h3 = older.toList h ++ added1) := by
  have hw1 := Log.append_wf h hwf older holder added1
  rw [happ1] at hw1
  have h1_older := hw1.2.2.2.2 older holder
  have hw2 := Log.append_wf h1 hw1.1 older h1_older.1 added2
  rw [happ2] at hw2
  have h2_older := hw2.2.2.2.2 older h1_older.1
  have h2_newer := hw2.2.2.2.2 newer hw1.2.1
  have hemp1 : added1.isEmpty = false := by
    cases added1 with | nil => exact absurd rfl hne1 | cons _ _ => rfl
  have hemp2 : added2.isEmpty = false := by
    cases added2 with | nil => exact absurd rfl hne2 | cons _ _ => rfl
  have hst1_older : (!((h1.getStore older.store).owned) ||
      (h1.getStore older.store).items.length != older.length) = true := by
    by_cases hbr1 : (!((h.getStore older.store).owned) ||
        (h.getStore older.store).items.length != older.length) = true
    · have hget_old : h1.getStore older.store = h.getStore older.store := by
        unfold Log.append at happ1
        simp only [hemp1, Bool.false_eq_true, ↓reduceIte, hbr1,
          HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setStore] at happ1
        injection happ1 with hh1 _
        rw [← hh1]
        simp only [HistoryHeap.getStore]
        rw [listGetD_set_ne _ (Nat.ne_of_gt holder.store_lt),
          listGetD_append_lt _ _ holder.store_lt]
      rw [hget_old]
      exact hbr1
    · have hnbr1 : (!((h.getStore older.store).owned) ||
          (h.getStore older.store).items.length != older.length) = false :=
        Bool.eq_false_iff.mpr hbr1
      have hlen0 : (h.getStore older.store).items.length = older.length := by
        simp only [Bool.or_eq_false_eq_eq_false_and_eq_false, bne_eq_false_iff_eq] at hnbr1
        exact hnbr1.2
      have hitems1 : (h1.getStore older.store).items = (h.getStore older.store).items ++ added1 := by
        unfold Log.append at happ1
        simp only [hemp1, Bool.false_eq_true, ↓reduceIte, hnbr1, HistoryHeap.allocLog] at happ1
        injection happ1 with hh1 _
        rw [← hh1]
        change ((h.setStore older.store { h.getStore older.store with
            items := (h.getStore older.store).items ++ added1 }).getStore older.store).items = _
        rw [getStore_setStore_same h holder.store_lt]
      have hlen1 : (h1.getStore older.store).items.length ≠ older.length := by
        rw [hitems1, List.length_append, hlen0]
        have hpos : 0 < added1.length := List.length_pos_of_ne_nil hne1
        omega
      simp [bne_iff_ne.mpr hlen1]
  have hbr_store : branch.store = h1.stores.length := by
    unfold Log.append at happ2
    simp only [hemp2, Bool.false_eq_true, ↓reduceIte, hst1_older,
      HistoryHeap.allocStore, HistoryHeap.allocLog, HistoryHeap.setStore] at happ2
    injection happ2 with _ hbr_log
    rw [← hbr_log]
  refine ⟨hw2.1, h2_older.1, h2_newer.1, hw2.2.1,
    by rw [hbr_store]; exact Nat.ne_of_gt hw1.2.1.store_lt,
    by rw [hbr_store]; exact Nat.ne_of_gt h1_older.1.store_lt,
    by rw [h2_older.2, h1_older.2],
    by rw [h2_newer.2, hw1.2.2.2.1],
    by rw [hw2.2.2.2.1, h1_older.2], ?_⟩
  intro added3 h3 branch' happ3
  have hw3 := Log.append_wf h2 hw2.1 branch hw2.2.1 added3
  rw [happ3] at hw3
  have h3_newer := hw3.2.2.2.2 newer h2_newer.1
  exact ⟨h3_newer.1, by rw [h3_newer.2, h2_newer.2, hw1.2.2.2.1]⟩

private theorem indexStep_error_if_prefix_ok {T : Type} (items : List T)
    (keysOf : T → Except HistoryErr (List String))
    {p : Nat} {bad : T} {err : HistoryErr}
    (hp : p < items.length) (hbad : items[p]? = some bad) (herr : keysOf bad = .error err)
    (hok : ∀ j < p, ∀ it, items[j]? = some it → ∃ ks, keysOf it = .ok ks)
    (k : Keyed) (hkl : k.through ≤ p) :
    (Log.indexStep items keysOf k).2 = .error err := by
  suffices h : ∀ n (k : Keyed), p - k.through = n → k.through ≤ p →
      (Log.indexStep items keysOf k).2 = .error err from
    h (p - k.through) k rfl hkl
  intro n
  induction n with
  | zero =>
    intro k hn hle
    have heq : k.through = p := by omega
    unfold Log.indexStep
    simp only [heq, hp, ↓reduceDIte, hbad, herr]
  | succ n ih =>
    intro k hn hle
    have hlt_p : k.through < p := by omega
    have hlt : k.through < items.length := Nat.lt_trans hlt_p hp
    obtain ⟨it, hit⟩ : ∃ it, items[k.through]? = some it :=
      ⟨items[k.through], List.getElem?_eq_getElem hlt⟩
    obtain ⟨ks, hks⟩ := hok k.through hlt_p it hit
    unfold Log.indexStep
    simp only [hlt, ↓reduceDIte, hit, hks]
    exact ih ⟨Log.addKeysForPosition k.positions ks k.through, k.through + 1⟩
      (by dsimp only; omega) (by dsimp only; omega)

/-- Because `#keyed` indexes the entire backing store past `log.length`, appending an unindexable
entry to a later shared-store view causes key lookups on an earlier view to error even though
every entry in the earlier view succeeds. -/
theorem Log.keyed_scans_beyond_length {T : Type} (h : HistoryHeap T) (hwf : h.WF)
    (older : Log T) (holder : older.WF h)
    (howned : (h.getStore older.store).owned = true)
    (hat_head : (h.getStore older.store).items.length = older.length)
    (name key : String) {keysOf : T → Except HistoryErr (List String)}
    (hkeys : h.getShapeKeys older.shape.id name = some keysOf)
    (hok : ∀ item ∈ older.toList h, ∃ ks, keysOf item = .ok ks)
    (bad : T) {err : HistoryErr} (hbad_err : keysOf bad = .error err)
    {h1 : HistoryHeap T} {later : Log T} (happ : older.append h [bad] = (h1, later)) :
    older.toList h1 = older.toList h ∧
      (older.keyed h1 name).2 = .error err ∧
      (older.has h1 name key).2 = .error err := by
  have hw1 := Log.append_wf h hwf older holder [bad]
  rw [happ] at hw1
  have h1_older := hw1.2.2.2.2 older holder
  have hbr : (!((h.getStore older.store).owned) ||
      (h.getStore older.store).items.length != older.length) = false := by
    simp [howned, hat_head]
  have hst1 : h1.getStore older.store =
      { h.getStore older.store with items := (h.getStore older.store).items ++ [bad] } := by
    unfold Log.append at happ
    simp only [List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte, hbr, HistoryHeap.allocLog] at happ
    injection happ with hh1 _
    rw [← hh1]
    exact getStore_setStore_same h holder.store_lt _
  have hshk1 : h1.getShapeKeys older.shape.id name = some keysOf := by
    unfold Log.append at happ
    simp only [List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte, hbr, HistoryHeap.allocLog] at happ
    injection happ with hh1 _
    rw [← hh1]
    exact hkeys
  have hlen1 : older.length < (h1.getStore older.store).items.length := by
    rw [hst1]
    dsimp only
    rw [List.length_append, hat_head]
    simp
  have hbad_at : (h1.getStore older.store).items[older.length]? = some bad := by
    rw [hst1]
    dsimp only
    rw [← hat_head, List.getElem?_append_right (le_refl _)]
    simp
  have hok_prefix : ∀ j < older.length, ∀ it, (h1.getStore older.store).items[j]? = some it →
      ∃ ks, keysOf it = .ok ks := by
    intro j hj it hit
    rw [hst1] at hit
    dsimp only at hit
    have hj' : j < (h.getStore older.store).items.length := by omega
    rw [List.getElem?_append_left hj'] at hit
    have hmem : it ∈ older.toList h := by
      simp only [Log.toList, ← hat_head, List.take_length]
      exact List.mem_of_getElem? hit
    exact hok it hmem
  have hkl : ((mapGet (h1.getStore older.store).keyed name).getD ⟨[], 0⟩).through ≤ older.length := by
    cases hk0 : mapGet (h.getStore older.store).keyed name with
    | none => simp [hst1, hk0]
    | some k0 =>
      have hms := (hwf.stores_wf older.store holder.store_lt).2.1
      rw [← holder.shape_eq] at hms
      obtain ⟨_, _, hk0wf⟩ := hms name k0 hk0
      have hth := hk0wf.through_le
      rw [hat_head] at hth
      simpa [hst1, hk0] using hth
  have hkeyed_err : (older.keyed h1 name).2 = .error err := by
    unfold Log.keyed
    rw [hshk1]
    exact indexStep_error_if_prefix_ok (h1.getStore older.store).items keysOf
      hlen1 hbad_at hbad_err hok_prefix _ hkl
  have hhas_err : (older.has h1 name key).2 = .error err := by
    dsimp only [Log.has, Log.firstPosition]
    rw [hkeyed_err]
    rfl
  exact ⟨h1_older.2, hkeyed_err, hhas_err⟩

end BranchingLaws

end Rastrata.Kernel

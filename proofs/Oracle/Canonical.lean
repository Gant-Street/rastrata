/-
The oracle's side of `packages/kernel/src/canonical.ts`: how canonical values and JavaScript strings
travel between the TypeScript test and the Lean model, and the entries of the dispatch table.

Everything on the wire is ASCII, so neither JSON implementation's handling of Unicode can hide or
invent a difference:

- a string is the lowercase hexadecimal of its UTF-16 code units, four digits a unit (`"é"` is
  `"00650301"`); this carries every JavaScript string, a lone surrogate included;
- bytes are lowercase hexadecimal, two digits a byte;
- an integer is a decimal string, as in the number oracle;
- a canonical value is a tagged object: `{"t":"null"}`, `{"t":"bool","v":true}`,
  `{"t":"int","v":"-12"}`, `{"t":"string","v":<string>}`, `{"t":"bytes","v":<bytes>}`,
  `{"t":"array","v":[<value>, ...]}` and `{"t":"record","v":[[<string>, <value>], ...]}`. A record is
  a list of pairs, so the order of its keys and a repeated key both reach the model as they were sent;
- a content hash is `{"algorithm":<string>,"canonicalizationVersion":<string>,"digest":<string>}`.

A Lean `String` is a sequence of Unicode scalar values and cannot hold a lone surrogate. An argument
with one is not a protocol error: it is decoded to `Carried.loneSurrogate` and every entry answers it
with the error `model_has_no_lone_surrogate`, which no TypeScript outcome equals, so the test sees the
gap instead of a silently repaired string.
-/
import Rastrata.Kernel.Canonical
import Oracle.Dispatch

namespace Oracle

open Rastrata.Kernel

/-! ## Hexadecimal and UTF-16 -/

private def hexValue (c : Char) : Option Nat :=
  let n := c.toNat
  if 0x30 ≤ n ∧ n ≤ 0x39 then some (n - 0x30)
  else if 0x61 ≤ n ∧ n ≤ 0x66 then some (n - 0x61 + 10)
  else none

private def hexDigitChar (n : Nat) : Char :=
  if n < 10 then Char.ofNat (0x30 + n) else Char.ofNat (0x61 + (n - 10))

private def hexToBytesAux (acc : ByteArray) : List Char → Option ByteArray
  | [] => some acc
  | [_] => none
  | a :: b :: rest =>
    match hexValue a, hexValue b with
    | some x, some y => hexToBytesAux (acc.push (UInt8.ofNat (x * 16 + y))) rest
    | _, _ => none

/-- Bytes from lowercase hexadecimal, two digits a byte. -/
def hexToBytes (s : String) : Option ByteArray :=
  hexToBytesAux ByteArray.empty s.toList

/-- Lowercase hexadecimal of bytes, two digits a byte. Written here, not taken from the model. -/
def bytesToHexWire (bytes : ByteArray) : String :=
  String.ofList (bytes.data.toList.flatMap fun b =>
    [hexDigitChar (b.toNat / 16), hexDigitChar (b.toNat % 16)])

private def hexToUnitsAux (acc : Array Nat) : List Char → Option (Array Nat)
  | [] => some acc
  | a :: b :: c :: d :: rest =>
    match hexValue a, hexValue b, hexValue c, hexValue d with
    | some w, some x, some y, some z =>
      hexToUnitsAux (acc.push (((w * 16 + x) * 16 + y) * 16 + z)) rest
    | _, _, _, _ => none
  | _ => none

/-- Scalar values from UTF-16 code units; `none` when a surrogate is not half of a pair. -/
private def unitsToCharsAux (acc : Array Char) : List Nat → Option (Array Char)
  | [] => some acc
  | u :: rest =>
    if 0xD800 ≤ u ∧ u ≤ 0xDBFF then
      match rest with
      | v :: rest' =>
        if 0xDC00 ≤ v ∧ v ≤ 0xDFFF then
          unitsToCharsAux (acc.push (Char.ofNat (0x10000 + (u - 0xD800) * 0x400 + (v - 0xDC00)))) rest'
        else none
      | [] => none
    else if 0xDC00 ≤ u ∧ u ≤ 0xDFFF then none
    else unitsToCharsAux (acc.push (Char.ofNat u)) rest

private def charToUnits (c : Char) : List Nat :=
  let n := c.toNat
  if n < 0x10000 then [n]
  else [0xD800 + (n - 0x10000) / 0x400, 0xDC00 + (n - 0x10000) % 0x400]

private def unitToHex (u : Nat) : List Char :=
  [hexDigitChar (u / 0x1000 % 16), hexDigitChar (u / 0x100 % 16), hexDigitChar (u / 0x10 % 16),
    hexDigitChar (u % 16)]

/-- The wire form of a Lean string: the hexadecimal of its UTF-16 code units. Written here, not taken
from the model's `stringToUTF16`, which is one of the things compared. -/
def stringToWire (s : String) : String :=
  String.ofList (s.toList.flatMap fun c => (charToUnits c).flatMap unitToHex)

/-! ## Decoding arguments -/

/-- Why an argument could not be given to the model. -/
inductive DecodeErr where
  /-- The request is malformed: a fault of the test, never a finding. -/
  | protocol (message : String)
  /-- The request is well formed and has a string that a Lean `String` cannot hold. -/
  | loneSurrogate

/-- An argument of the model's type `α` as it arrived: the value, or the news that it has a string
with a lone surrogate, which the model has no value for. -/
inductive Carried (α : Type) where
  | value (a : α)
  | loneSurrogate

private def liftJson {α : Type} (r : Except String α) : Except DecodeErr α :=
  match r with
  | .ok a => .ok a
  | .error e => .error (.protocol e)

/-- A string from its wire form. -/
def decodeText (j : Lean.Json) : Except DecodeErr String := do
  let hex ← liftJson j.getStr?
  match hexToUnitsAux #[] hex.toList with
  | none => .error (.protocol s!"expected UTF-16 code units as hexadecimal, four digits a unit, got: {hex}")
  | some units =>
    match unitsToCharsAux #[] units.toList with
    | none => .error .loneSurrogate
    | some chars => .ok (String.ofList chars.toList)

/-- Bytes from their wire form. -/
def decodeBytes (j : Lean.Json) : Except DecodeErr ByteArray := do
  let hex ← liftJson j.getStr?
  match hexToBytes hex with
  | none => .error (.protocol s!"expected bytes as hexadecimal, two digits a byte, got: {hex}")
  | some bytes => .ok bytes

/-- Deepest nesting of a canonical value the oracle decodes. The test stays far below it. -/
def maxValueDepth : Nat := 4096

mutual
  /-- A canonical value from its tagged wire form. The first argument bounds the nesting. -/
  def decodeValueAux : Nat → Lean.Json → Except DecodeErr CanonicalValue
    | 0, _ => .error (.protocol "canonical value nested too deeply")
    | fuel + 1, j => do
      let tag ← liftJson (j.getObjVal? "t" >>= Lean.Json.getStr?)
      if tag == "null" then
        pure .null
      else
        let v ← liftJson (j.getObjVal? "v")
        if tag == "bool" then
          pure (.bool (← liftJson v.getBool?))
        else if tag == "int" then
          let s ← liftJson v.getStr?
          match s.toInt? with
          | some n => pure (.int n)
          | none => .error (.protocol s!"expected decimal integer string, got: {s}")
        else if tag == "string" then
          pure (.string (← decodeText v))
        else if tag == "bytes" then
          pure (.bytes (← decodeBytes v))
        else if tag == "array" then
          let members ← liftJson v.getArr?
          pure (.array (← decodeValuesAux fuel members.toList))
        else if tag == "record" then
          let entries ← liftJson v.getArr?
          pure (.record (← decodeEntriesAux fuel entries.toList))
        else
          .error (.protocol s!"unknown canonical value tag: {tag}")

  /-- The members of an array, in order. -/
  def decodeValuesAux : Nat → List Lean.Json → Except DecodeErr (List CanonicalValue)
    | _, [] => pure []
    | fuel, j :: rest => do
      let value ← decodeValueAux fuel j
      let values ← decodeValuesAux fuel rest
      pure (value :: values)

  /-- The entries of a record, in the order sent, repeated keys kept. -/
  def decodeEntriesAux : Nat → List Lean.Json → Except DecodeErr (List (String × CanonicalValue))
    | _, [] => pure []
    | fuel, j :: rest => do
      let pair ← liftJson j.getArr?
      if _ : pair.size = 2 then
        let key ← decodeText pair[0]
        let value ← decodeValueAux fuel pair[1]
        let entries ← decodeEntriesAux fuel rest
        pure ((key, value) :: entries)
      else
        .error (.protocol s!"expected a [key, value] pair, got {pair.size} members")
end

private def carry {α : Type} (r : Except DecodeErr α) : Except String (Carried α) :=
  match r with
  | .ok a => .ok (.value a)
  | .error .loneSurrogate => .ok .loneSurrogate
  | .error (.protocol e) => .error e

instance : FromOracleJson (Carried String) where
  fromOracleJson j := carry (decodeText j)

instance : FromOracleJson (Carried CanonicalValue) where
  fromOracleJson j := carry (decodeValueAux maxValueDepth j)

instance : FromOracleJson (Carried (List CanonicalValue)) where
  fromOracleJson j := carry do
    let members ← liftJson j.getArr?
    decodeValuesAux maxValueDepth members.toList

instance : FromOracleJson (Carried (List (String × CanonicalValue))) where
  fromOracleJson j := carry do
    let entries ← liftJson j.getArr?
    decodeEntriesAux maxValueDepth entries.toList

instance : FromOracleJson (Carried ContentHash) where
  fromOracleJson j := carry do
    let algorithm ← decodeText (← liftJson (j.getObjVal? "algorithm"))
    let version ← decodeText (← liftJson (j.getObjVal? "canonicalizationVersion"))
    let digest ← decodeText (← liftJson (j.getObjVal? "digest"))
    pure { algorithm := algorithm, canonicalizationVersion := version, digest := digest }

/-! ## Encoding results -/

/-- A string result, sent in the wire form of a string. -/
structure Text where
  value : String

instance : ToOracleJson Text where
  toOracleJson t := Lean.Json.str (stringToWire t.value)

instance : ToOracleJson ByteArray where
  toOracleJson bytes := Lean.Json.str (bytesToHexWire bytes)

instance : ToOracleJson ContentHash where
  toOracleJson h := Lean.Json.mkObj
    [ ("algorithm", Lean.Json.str (stringToWire h.algorithm))
    , ("canonicalizationVersion", Lean.Json.str (stringToWire h.canonicalizationVersion))
    , ("digest", Lean.Json.str (stringToWire h.digest))
    ]

/-- The model's errors and the one the wire adds. -/
inductive CanonicalOracleErr where
  | model (e : CanonicalErr)
  | loneSurrogate

instance : ToOracleError CanonicalOracleErr where
  toErrorCode
    | .model .canonicalIdentityConflict => "canonical_identity_conflict"
    | .model .invalidCanonicalSequenceField => "invalid_canonical_sequence_field"
    | .model .invalidCanonicalEncoding => "invalid_canonical_encoding"
    | .loneSurrogate => "model_has_no_lone_surrogate"

private def arrived {α : Type} (c : Carried α) : Except CanonicalOracleErr α :=
  match c with
  | .value a => .ok a
  | .loneSurrogate => .error .loneSurrogate

private def model {α : Type} (r : Except CanonicalErr α) : Except CanonicalOracleErr α :=
  match r with
  | .ok a => .ok a
  | .error e => .error (.model e)

/-! ## The entries -/

namespace CanonicalEntry

/-- `identifier`. The kind is a type-level tag in the TypeScript and plays no part in the result. -/
def identifier (value : Carried String) : Except CanonicalOracleErr Text := do
  let id ← model (Rastrata.Kernel.identifier "" (← arrived value))
  pure ⟨id.value⟩

/-- `canonicalEncode`. -/
def canonicalEncode (value : Carried CanonicalValue) : Except CanonicalOracleErr ByteArray := do
  pure (Rastrata.Kernel.canonicalEncode (← arrived value))

/-- `hashCanonical`. -/
def hashCanonical (value : Carried CanonicalValue) : Except CanonicalOracleErr ContentHash := do
  pure (Rastrata.Kernel.hashCanonical (← arrived value))

/-- `hashCanonicalSequenceField`. -/
def hashCanonicalSequenceField (fields : Carried (List (String × CanonicalValue)))
    (field : Carried String) (length : Int) (values : Carried (List CanonicalValue)) :
    Except CanonicalOracleErr ContentHash := do
  model (Rastrata.Kernel.hashCanonicalSequenceField (← arrived fields) (← arrived field) length
    (← arrived values))

/-- `compareCanonicalText`. -/
def compareCanonicalText (left right : Carried String) : Except CanonicalOracleErr Ordering := do
  pure (Rastrata.Kernel.compareCanonicalText (← arrived left) (← arrived right))

/-- `contentHashEquals`. -/
def contentHashEquals (left right : Carried ContentHash) : Except CanonicalOracleErr Bool := do
  pure (Rastrata.Kernel.contentHashEquals (← arrived left) (← arrived right))

/-- `toNFC`: the model's own `String.prototype.normalize("NFC")`, which `identifier` only shows as
a yes or a no. -/
def toNFC (value : Carried String) : Except CanonicalOracleErr Text := do
  pure ⟨Rastrata.Kernel.toNFC (← arrived value)⟩

/-- `jsTrim`: the model's own `String.prototype.trim()`. -/
def jsTrim (value : Carried String) : Except CanonicalOracleErr Text := do
  pure ⟨Rastrata.Kernel.jsTrim (← arrived value)⟩

end CanonicalEntry

/-- The canonical module's entries of the dispatch table. An entry whose name ends in `.each` takes
one argument, a list of argument lists, and answers each in turn (`each`), so that a sweep of every
code point is a few hundred requests and not a million. -/
def canonicalEntries : List (String × Handler) :=
  [ ("identifier", fn1 CanonicalEntry.identifier)
  , ("canonicalEncode", fn1 CanonicalEntry.canonicalEncode)
  , ("hashCanonical", fn1 CanonicalEntry.hashCanonical)
  , ("hashCanonicalSequenceField", fn4 CanonicalEntry.hashCanonicalSequenceField)
  , ("compareCanonicalText", fn2 CanonicalEntry.compareCanonicalText)
  , ("contentHashEquals", fn2 CanonicalEntry.contentHashEquals)
  , ("toNFC", fn1 CanonicalEntry.toNFC)
  , ("jsTrim", fn1 CanonicalEntry.jsTrim)
  , ("identifier.each", each (fn1 CanonicalEntry.identifier))
  , ("toNFC.each", each (fn1 CanonicalEntry.toNFC))
  , ("jsTrim.each", each (fn1 CanonicalEntry.jsTrim))
  , ("compareCanonicalText.each", each (fn2 CanonicalEntry.compareCanonicalText))
  ]

end Oracle

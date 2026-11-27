/-
SHA-256 implementation over `ByteArray`, following FIPS 180-4.

Executable in pure Lean 4 (no `partial`, `unsafe`, `extern`, or `native_decide`),
checked against the NIST FIPS 180-4 test vectors with `#guard`.
-/
import Rastrata.Prelude

namespace Rastrata.Kernel

namespace Sha256

private def rotr (x : UInt32) (n : UInt32) : UInt32 :=
  (x >>> n) ||| (x <<< (32 - n))

private def roundConstants : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

private structure State where
  h0 : UInt32
  h1 : UInt32
  h2 : UInt32
  h3 : UInt32
  h4 : UInt32
  h5 : UInt32
  h6 : UInt32
  h7 : UInt32

private def initState : State :=
  ⟨0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19⟩

private def padMessage (msg : ByteArray) : ByteArray := Id.run do
  let len := msg.size
  let zeroCount := (119 - (len % 64)) % 64
  let bitLen : UInt64 := len.toUInt64 * 8
  let mut tail := ByteArray.emptyWithCapacity (1 + zeroCount + 8)
  tail := tail.push 0x80
  for _ in [:zeroCount] do
    tail := tail.push 0
  for i in [:8] do
    let shift : UInt64 := ((7 - i) * 8).toUInt64
    tail := tail.push (bitLen >>> shift).toUInt8
  return msg ++ tail

private def readWordBE (b : ByteArray) (off : Nat) : UInt32 :=
  ((b.get! off).toUInt32 <<< 24) |||
  ((b.get! (off + 1)).toUInt32 <<< 16) |||
  ((b.get! (off + 2)).toUInt32 <<< 8) |||
  (b.get! (off + 3)).toUInt32

private def compressBlock (st : State) (block : ByteArray) (base : Nat) : State := Id.run do
  let mut w := Array.replicate 64 (0 : UInt32)
  for t in [:16] do
    w := w.set! t (readWordBE block (base + t * 4))
  for t in [16:64] do
    let w2 := w[t - 2]!
    let w7 := w[t - 7]!
    let w15 := w[t - 15]!
    let w16 := w[t - 16]!
    let s0 := rotr w15 7 ^^^ rotr w15 18 ^^^ (w15 >>> 3)
    let s1 := rotr w2 17 ^^^ rotr w2 19 ^^^ (w2 >>> 10)
    w := w.set! t (s1 + w7 + s0 + w16)
  let mut a := st.h0
  let mut b := st.h1
  let mut c := st.h2
  let mut d := st.h3
  let mut e := st.h4
  let mut f := st.h5
  let mut g := st.h6
  let mut h := st.h7
  for t in [:64] do
    let bigS1 := rotr e 6 ^^^ rotr e 11 ^^^ rotr e 25
    let ch := (e &&& f) ^^^ ((~~~e) &&& g)
    let temp1 := h + bigS1 + ch + roundConstants[t]! + w[t]!
    let bigS0 := rotr a 2 ^^^ rotr a 13 ^^^ rotr a 22
    let maj := (a &&& b) ^^^ (a &&& c) ^^^ (b &&& c)
    let temp2 := bigS0 + maj
    h := g
    g := f
    f := e
    e := d + temp1
    d := c
    c := b
    b := a
    a := temp1 + temp2
  return ⟨st.h0 + a, st.h1 + b, st.h2 + c, st.h3 + d,
          st.h4 + e, st.h5 + f, st.h6 + g, st.h7 + h⟩

private def pushWordBE (out : ByteArray) (w : UInt32) : ByteArray :=
  out
    |>.push (w >>> 24).toUInt8
    |>.push (w >>> 16).toUInt8
    |>.push (w >>> 8).toUInt8
    |>.push w.toUInt8

private def compressBlocks (padded : ByteArray) : State := Id.run do
  let blocks := padded.size / 64
  let mut st := initState
  for b in [:blocks] do
    st := compressBlock st padded (b * 64)
  return st

private def stateToBytes (st : State) : ByteArray :=
  ByteArray.empty
    |> (pushWordBE · st.h0)
    |> (pushWordBE · st.h1)
    |> (pushWordBE · st.h2)
    |> (pushWordBE · st.h3)
    |> (pushWordBE · st.h4)
    |> (pushWordBE · st.h5)
    |> (pushWordBE · st.h6)
    |> (pushWordBE · st.h7)

def hexDigit (n : UInt8) : Char :=
  if n < 10 then Char.ofNat ('0'.toNat + n.toNat)
  else Char.ofNat ('a'.toNat + (n.toNat - 10))

def byteToHex (b : UInt8) : List Char :=
  [hexDigit (b >>> 4), hexDigit (b &&& 0x0f)]

end Sha256

/-- SHA-256 digest of a byte sequence, returning a 32-byte `ByteArray`. -/
def sha256 (msg : ByteArray) : ByteArray :=
  Sha256.stateToBytes (Sha256.compressBlocks (Sha256.padMessage msg))

/-- Lowercase hexadecimal representation of a `ByteArray`. -/
def bytesToHex (bs : ByteArray) : String :=
  String.ofList (bs.data.toList.flatMap Sha256.byteToHex)

/-- SHA-256 digest of a byte sequence as a 64-character lowercase hex string. -/
def sha256Hex (msg : ByteArray) : String :=
  bytesToHex (sha256 msg)

/-- A SHA-256 collision: two distinct byte sequences with the same digest. -/
def HashCollision : Prop :=
  ∃ a b : ByteArray, a ≠ b ∧ sha256 a = sha256 b

theorem sha256_size (msg : ByteArray) : (sha256 msg).size = 32 := by
  simp [sha256, Sha256.stateToBytes, Sha256.pushWordBE, ByteArray.size_push]

private lemma hexDigit_toNat {n : UInt8} (hn : n.toNat < 16) :
    (Sha256.hexDigit n).toNat =
      if n.toNat < 10 then 48 + n.toNat else 97 + (n.toNat - 10) := by
  unfold Sha256.hexDigit
  have h0 : '0'.toNat = 48 := rfl
  have ha : 'a'.toNat = 97 := rfl
  by_cases h : n < 10
  · have h' : n.toNat < 10 := UInt8.lt_iff_toNat_lt.mp h
    simp only [h, ↓reduceIte, h', Char.toNat_ofNat, h0]
    have hv : (48 + n.toNat).isValidChar := by simp [Nat.isValidChar]; omega
    simp [hv]
  · have h' : ¬ n.toNat < 10 := fun hlt => h (UInt8.lt_iff_toNat_lt.mpr hlt)
    simp only [h, ↓reduceIte, h', Char.toNat_ofNat, ha]
    have hv : (97 + (n.toNat - 10)).isValidChar := by simp [Nat.isValidChar]; omega
    simp [hv]

private lemma hexDigit_inj {a b : UInt8} (ha : a.toNat < 16) (hb : b.toNat < 16)
    (h : Sha256.hexDigit a = Sha256.hexDigit b) : a = b := by
  have hc : (Sha256.hexDigit a).toNat = (Sha256.hexDigit b).toNat := congrArg Char.toNat h
  rw [hexDigit_toNat ha, hexDigit_toNat hb] at hc
  apply UInt8.toNat_inj.mp
  split_ifs at hc <;> omega

private lemma byteToHex_inj {a b : UInt8} (h : Sha256.byteToHex a = Sha256.byteToHex b) :
    a = b := by
  simp only [Sha256.byteToHex, List.cons.injEq, and_true] at h
  have ha := UInt8.toNat_lt a
  have hb := UInt8.toNat_lt b
  have h1 : (a >>> 4).toNat < 16 := by
    rw [UInt8.toNat_shiftRight]; simp [Nat.shiftRight_eq_div_pow]; omega
  have h2 : (b >>> 4).toNat < 16 := by
    rw [UInt8.toNat_shiftRight]; simp [Nat.shiftRight_eq_div_pow]; omega
  have h3 : (a &&& 0x0f).toNat < 16 := by
    rw [UInt8.toNat_and]
    change a.toNat &&& (2 ^ 4 - 1) < 16
    rw [Nat.and_two_pow_sub_one_eq_mod]
    exact Nat.mod_lt _ (by omega)
  have h4 : (b &&& 0x0f).toNat < 16 := by
    rw [UInt8.toNat_and]
    change b.toNat &&& (2 ^ 4 - 1) < 16
    rw [Nat.and_two_pow_sub_one_eq_mod]
    exact Nat.mod_lt _ (by omega)
  have eqHi := congrArg UInt8.toNat (hexDigit_inj h1 h2 h.1)
  have eqLo := congrArg UInt8.toNat (hexDigit_inj h3 h4 h.2)
  rw [UInt8.toNat_shiftRight, UInt8.toNat_shiftRight] at eqHi
  change a.toNat >>> 4 = b.toNat >>> 4 at eqHi
  rw [Nat.shiftRight_eq_div_pow, Nat.shiftRight_eq_div_pow] at eqHi
  rw [UInt8.toNat_and, UInt8.toNat_and] at eqLo
  change a.toNat &&& (2 ^ 4 - 1) = b.toNat &&& (2 ^ 4 - 1) at eqLo
  rw [Nat.and_two_pow_sub_one_eq_mod, Nat.and_two_pow_sub_one_eq_mod] at eqLo
  apply UInt8.toNat_inj.mp
  omega

private lemma flatMap_byteToHex_inj : ∀ {l1 l2 : List UInt8},
    l1.flatMap Sha256.byteToHex = l2.flatMap Sha256.byteToHex → l1 = l2
  | [], [], _ => rfl
  | [], _ :: _, h => by simp [Sha256.byteToHex] at h
  | _ :: _, [], h => by simp [Sha256.byteToHex] at h
  | a :: t1, b :: t2, h => by
    simp only [List.flatMap_cons, Sha256.byteToHex, List.cons_append, List.nil_append,
      List.cons.injEq] at h
    have hab : a = b := byteToHex_inj (by simp [Sha256.byteToHex, h.1, h.2.1])
    have ht := flatMap_byteToHex_inj h.2.2
    rw [hab, ht]

theorem bytesToHex_inj {a b : ByteArray} (h : bytesToHex a = bytesToHex b) : a = b := by
  have h1 : (bytesToHex a).toList = (bytesToHex b).toList := congrArg String.toList h
  simp only [bytesToHex, String.toList_ofList] at h1
  have h2 := flatMap_byteToHex_inj h1
  exact ByteArray.ext (Array.toList_inj.mp h2)

theorem sha256Hex_eq_iff (a b : ByteArray) :
    sha256Hex a = sha256Hex b ↔ sha256 a = sha256 b :=
  ⟨fun h => bytesToHex_inj h, fun h => congrArg bytesToHex h⟩

theorem bytesToHex_length (bs : ByteArray) : (bytesToHex bs).length = 2 * bs.size := by
  rw [bytesToHex, String.length_ofList]
  have hlen : ∀ l : List UInt8, (l.flatMap Sha256.byteToHex).length = 2 * l.length := by
    intro l
    induction l with
    | nil => simp
    | cons _ _ ih => simp [Sha256.byteToHex, ih]; omega
  rw [hlen, Array.length_toList, ByteArray.size]

theorem sha256Hex_length (msg : ByteArray) : (sha256Hex msg).length = 64 := by
  rw [sha256Hex, bytesToHex_length, sha256_size]

def isLowerHexChar (c : Char) : Bool :=
  ('0' ≤ c && c ≤ '9') || ('a' ≤ c && c ≤ 'f')

private lemma hexDigit_isLowerHex {n : UInt8} (hn : n.toNat < 16) :
    isLowerHexChar (Sha256.hexDigit n) = true := by
  have hc := hexDigit_toNat hn
  have h0 : '0'.toNat = 48 := rfl
  have h9 : '9'.toNat = 57 := rfl
  have ha : 'a'.toNat = 97 := rfl
  have hf : 'f'.toNat = 102 := rfl
  change decide ('0'.toNat ≤ (Sha256.hexDigit n).toNat) &&
    decide ((Sha256.hexDigit n).toNat ≤ '9'.toNat) ||
    decide ('a'.toNat ≤ (Sha256.hexDigit n).toNat) &&
    decide ((Sha256.hexDigit n).toNat ≤ 'f'.toNat) = true
  simp only [Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, h0, h9, ha, hf]
  split_ifs at hc with h
  · left; omega
  · right; omega

theorem bytesToHex_isLowerHex (bs : ByteArray) :
    ∀ c ∈ (bytesToHex bs).toList, isLowerHexChar c = true := by
  intro c hc
  rw [bytesToHex, String.toList_ofList, List.mem_flatMap] at hc
  rcases hc with ⟨b, _, hmem⟩
  simp only [Sha256.byteToHex, List.mem_cons, List.not_mem_nil, or_false] at hmem
  rcases hmem with rfl | rfl
  · apply hexDigit_isLowerHex
    rw [UInt8.toNat_shiftRight]; simp [Nat.shiftRight_eq_div_pow]; have := UInt8.toNat_lt b; omega
  · apply hexDigit_isLowerHex
    rw [UInt8.toNat_and]
    change b.toNat &&& (2 ^ 4 - 1) < 16
    rw [Nat.and_two_pow_sub_one_eq_mod]
    exact Nat.mod_lt _ (by omega)

theorem sha256Hex_isLowerHex (msg : ByteArray) :
    ∀ c ∈ (sha256Hex msg).toList, isLowerHexChar c = true :=
  bytesToHex_isLowerHex (sha256 msg)

-- NIST FIPS 180-4 SHA-256 test vectors
#guard sha256Hex "".toUTF8 ==
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

#guard sha256Hex "abc".toUTF8 ==
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

#guard sha256Hex "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".toUTF8 ==
  "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"

#guard sha256Hex (ByteArray.mk (Array.replicate 1000000 0x61)) ==
  "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"

end Rastrata.Kernel

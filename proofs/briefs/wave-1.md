# Wave 1: numbers, rounding, the vocabulary, the comparison

Goal of the whole work: a Lean 4 model of the accounting kernel in `packages/kernel/src` (TypeScript) with every
law of it proved, and the model run against the TypeScript on the same inputs. Read `proofs/README.md` first and
follow it to the letter; it holds the rules and the traps. Read the TypeScript you model in full before writing.

This wave has five workstreams. Run them at the same time, one worker each, every worker on
`gemini-4-hydrogen-xhigh`. At most five workers build at once.

All workers work in this same checkout, in `proofs/`, each only in its own files. Do not give a worker its own
copy or worktree of the repository: `proofs/.lake` holds a 7 GB build of Mathlib that must not be copied or
fetched again. Nobody commits, pushes or runs `bun run ship`.

Each workstream adds one line, `import Rastrata.Kernel.<Module>`, to `proofs/Rastrata.lean` for each file it
creates, and changes nothing else there.

## 1. Numeric: prove the contract

File: `proofs/Rastrata/Kernel/Numeric.lean` (the only workstream that edits it), new file
`proofs/Rastrata/Kernel/NumericText.lean`.

- Replace every `sorry` in `Numeric.lean` with a proof. The definitions and the theorem statements are fixed.
  Helper lemmas may be added. If a statement is false, do not change it: prove what is true beside it under a new
  name and report it.
- Add and prove: an operation whose exact result has a numerator and a denominator within the admitted size
  returns `.ok` (so the only failure of `add`, `multiply`, `subtract`, `divide` is the size limit or division by
  zero); `compare` is a total order on constructible values that agrees with `<` on meanings.
- In `NumericText.lean` model `ExactDecimal.parse` and both `toString` methods of `numeric.ts`, and prove that
  parsing the text of a constructible decimal gives the same decimal back.

## 2. Quantization: rounding

File: `proofs/Rastrata/Kernel/Quantization.lean`. Source: `packages/kernel/src/quantization.ts`.

The policy record there carries identifiers, a version and dates that workstream 4 is porting now. Model the
arithmetic over a small record `QuantizationRule` (`targetScale : Int`, `roundingMode : RoundingMode`); the next
wave puts the full policy over it. Model `roundedCoefficient`, `quantize` and the arithmetic of
`quantizeCumulativePostedShare` (same checks, same order; a rejection is a value, not a proof obligation).

Prove, for every rounding mode and every constructible value:

- the amount plus the residual is exactly the value;
- the amount is within one unit of the target scale of the value, and within half a unit for the two half modes;
- each mode's own rule: floor never above and ceiling never below the value, toward zero never larger in
  magnitude, half away from zero and half even differ only on an exact tie, and half even gives an even
  coefficient on a tie;
- a value already representable at the scale comes back unchanged with a zero residual;
- rounding is monotone: a larger value never rounds to a smaller amount;
- cumulative shares: for fractions 0 = f0 ≤ f1 ≤ ... ≤ fn = 1 of a representable non-negative total, the posted
  amounts of the n successive shares add up to the total exactly, each posted amount is non-negative, and each is
  within one unit of its exact share.

## 3. Canonical: the canonical value, its bytes and the hash

File: `proofs/Rastrata/Kernel/Canonical.lean`, `proofs/Rastrata/Kernel/Sha256.lean`.
Source: `packages/kernel/src/canonical.ts`.

- Model the canonical value type, the canonical encoding to bytes, `identifier`, and `hashCanonical`.
- Write SHA-256 in Lean as an executable function over bytes, with `#guard` checks against the published test
  vectors (empty input, "abc", the 448-bit and the million-`a` vector if it runs in under ten seconds).
- Prove: the encoding is a function of the value alone (key order and the like do not change it, where the
  TypeScript promises that); the encoding is injective on canonical values, so different values have different
  bytes; decoding where the TypeScript has it is the inverse.
- **Never assume the hash is injective. It is not, and a theorem that assumes it proves nothing.** Define
  `HashCollision : Prop := ∃ a b : ByteArray, a ≠ b ∧ sha256 a = sha256 b`, and state every law about hashes in
  the form "equal hashes, therefore equal values, or else a `HashCollision`".

## 4. Vocabulary: the types the rest is written in

Files: `proofs/Rastrata/Kernel/Journal/Types.lean`, `proofs/Rastrata/Kernel/Policy/Types.lean`.
Sources: `packages/kernel/src/journal.ts` up to and including `diagnostic` (the types, the identifier makers,
`localDate`, `instant`, the diagnostic codes), and every type and constructor-validator of
`packages/kernel/src/policy.ts`.

- Every exported type becomes a Lean structure or inductive with the same field names; a branded string type is
  a structure around a `String`. Every diagnostic code is a constructor of one inductive.
- Model the validators (`localDate`, `instant`, identifier rules) exactly, including what they reject, and prove
  for each that it accepts exactly the stated format. For `localDate`: an accepted date is a real calendar date,
  and the order of two accepted dates as strings is their order as dates.
- No law about journals yet: admission is the next wave. Workstream 3 owns the canonical value; where a journal
  type needs it, leave that function for the next wave rather than editing workstream 3's file.

## 5. Oracle: run the model against the TypeScript

Files: `proofs/Oracle.lean` (and `proofs/Oracle/*.lean`), a new `[[lean_exe]]` named `oracle` in
`proofs/lakefile.toml`, `packages/kernel/test-lean/*.ts`, and one script line in `packages/kernel/package.json`.

- `oracle` reads one JSON object a line on standard input (`{"id", "fn", "args"}`) and writes one a line
  (`{"id", "ok": result}` or `{"id", "error": code}`). Integers travel as decimal strings. Start with every
  function of `Numeric.lean`; make adding a function one entry in one table, because every later module is added.
- `packages/kernel/test-lean/numeric.test.ts` (run by a new script `test:lean`, not by the ordinary `bun test` of
  the package: check how the package's test script selects files and keep this one out of it) starts the oracle
  once, generates inputs with `fast-check` (add it as a dev dependency of `packages/kernel`), sends the same
  inputs to the TypeScript and to the oracle, and fails on the first difference with the shrunk input. Include
  inputs at the limits: zero, negatives, 16,384-bit magnitudes and one bit beyond, scale 1000 and 1001, zero and
  negative denominators. At least 2,000 cases a function, deterministic seed.
- Dependencies are installed (`node_modules` is present). Run only `bun test` on your own new file.
- Report every difference you find between the model and the TypeScript. Do not change either to hide one.

## Done means

From `proofs/`: `python3 check.py` prints `proofs: ok` (it builds everything, and fails on any `sorry`, forbidden
word or changed committed declaration), and `bun run test:lean` passes in `packages/kernel`.

End with a report, one section a workstream: the files; each law proved, as one plain sentence; anything not
proved and why; and every place the TypeScript does something a law did not expect (file, line, input, result).

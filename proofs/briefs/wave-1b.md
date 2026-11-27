# Wave 1, second run: finish the numbers, the rounding and the vocabulary

Read `proofs/README.md` first and follow it to the letter. It has three rules that were added because the first
run broke them: a file always builds (unfinished proofs are `sorry`, and you build after every theorem); every
build runs under the time limit; no proof makes Lean compute with the 16,384-bit limit.

The first run was stopped by the model's quota 44 minutes in. What it left:

- Done and checked: `Sha256.lean`, `Canonical.lean`, the `oracle` executable and `packages/kernel/test-lean`
  (16 tests pass). Do not change them.
- `Rastrata/Kernel/Numeric.lean` is back to its committed state: the model and the 24 contract statements, all
  `sorry`. The first run's attempt at the proofs is `briefs/Numeric.attempt-1.lean.txt`; it was never built, it has
  about thirty errors, and its last part made a build run for two and a half hours. Use it for ideas, not as a base.
- `Rastrata/Kernel/Quantization.lean`, `Journal/Types.lean` and `Policy/Types.lean` are drafts that do not build
  (60 errors and more each). Their definitions may be kept; every proof in them is unchecked.

The workstreams and their laws are in `proofs/briefs/wave-1.md` (sections 1, 2 and 4); they have not changed.
The quota is small, so this run is four workers, one each, on `gemini-4-hydrogen-xhigh`, plus the coordinator;
no monitor worker. All work in this checkout, each only in its own files. Nobody commits, pushes or ships.

Order of work for every worker, so that a stop at any moment leaves something usable:

1. Make your file build, with `sorry` for every proof that fails. Say so on the board. This comes before anything
   else, because the other workers' files import the numbers.
2. Prove the statements one at a time, most important first, building after each.
3. Only then add the further laws of your section.

1. **numeric**: `Numeric.lean` (the contract first, in the order it is written), then the further laws of section
   1, then `NumericText.lean`. The first run found that the size is checked before a fraction is reduced, so
   `ExactRational.of (2 ^ 16384) 2` is refused although the reduced value fits: state that as a theorem with
   `maxExactIntegerBits` as a name, and report it.
2. **quantization**: `Quantization.lean`.
3. **vocabulary**: `Journal/Types.lean` and `Policy/Types.lean`. Definitions that build come first; the laws of
   the validators after.

4. **oracle**: `Canonical.lean` is proved but has never been run against the TypeScript, and it carries its own
   Unicode normalisation, whitespace and control-character tables whose agreement with JavaScript is exactly what
   a proof cannot show. Add `identifier`, `canonicalEncode`, `hashCanonical`, `hashCanonicalSequenceField`,
   `compareCanonicalText` and `contentHashEquals` to the oracle (`proofs/Oracle/Canonical.lean`, one entry each in
   `Oracle/Dispatch.lean`) and write `packages/kernel/test-lean/canonical.test.ts` on the pattern of
   `numeric.test.ts`: generated canonical values of every kind, nested, with record keys in every order; strings
   from the whole of Unicode, weighted toward combining marks, Hangul, unpaired-looking sequences, every kind of
   JavaScript whitespace at the ends, and control characters. The bytes and the digest must be equal, byte for
   byte. Do not edit `Canonical.lean`: report each difference with the input that shows it.

When a file builds without `sorry`, add its `import` line to `proofs/Rastrata.lean`.

Done means: from `proofs/`, `python3 check.py` prints `proofs: ok`, and `bun run test:lean` passes in `packages/kernel`. End with the report the first brief asks for.

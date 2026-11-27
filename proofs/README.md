# Proofs of the kernel

The accounting kernel (`packages/kernel/src`) is TypeScript. This folder holds its Lean 4 model and the proofs
of its laws. A proof here is about the Lean model; the model is tied to the shipped TypeScript by running both on
the same inputs and failing when they differ (`Oracle`, and the comparison test in `packages/kernel`).

Lean 4.36 and Mathlib 4.36 are pinned (`lean-toolchain`, `lakefile.toml`, `lake-manifest.json`).

## Three layers, in every module

1. **Model.** One Lean definition for each TypeScript function, with the same name, in a file named after the
   TypeScript file (`numeric.ts` is `Rastrata/Kernel/Numeric.lean`). Its doc comment names the TypeScript member.
   It is executable and does what the TypeScript does: the same checks in the same order, the same result for
   every input, `.error` where the TypeScript throws, a rejection with the same diagnostic code where it rejects.
2. **Meaning.** What a value means as mathematics (`ExactRational.toRat`), and what a constructible value
   satisfies (`WF`).
3. **Laws.** Theorems about the model, stated through the meaning. Each has a doc comment that says the law in one
   plain sentence a bookkeeper would recognise.

## Rules

- No `sorry`, `admit`, `axiom`, `native_decide`, `partial`, `unsafe`, `implemented_by` or `extern` in a finished
  file. `Classical` reasoning in a proof is fine; the three standard axioms are the only ones allowed.
- A law's hypotheses are only what the code guarantees: that inputs are constructible (`WF`) and that the calls
  returned `.ok`. Never assume what the code is supposed to check; prove that it checks it.
- **When a law turns out false for what the TypeScript does, do not bend the model or weaken the law in silence.**
  Keep the model faithful, prove the strongest true law, and report the gap: the TypeScript file and line, the
  input, what happens and what was expected. A found defect is the most useful thing this work produces.
- A declaration that is committed is fixed: its statement or definition is not changed, only proved. If one is
  wrong, say so in your report and leave it.
- Never `import Mathlib`. Import `Rastrata.Prelude`, and a specific Mathlib module when you need more.
- Build only your own module, and always under a time limit:
  `perl -e 'alarm 300; exec @ARGV' lake build Rastrata.Kernel.<Module>` from this folder. A build takes seconds; one
  that reaches the limit is a defect in the last thing you wrote, not something to wait for. Do not run
  `lake update`, `lake clean` or `lake exe cache`, and never delete `.lake`.
- **A file always builds.** Write one definition or one theorem, build, then write the next. A proof you have not
  finished is `sorry`, never text that does not compile, so that the modules that import yours keep building and
  the work survives if you are stopped. Never write more than about fifty lines between two builds.
- **Never make Lean compute with the size limit.** `2 ^ maxExactIntegerBits` is a number of 16,384 binary digits: a
  `decide`, `norm_num`, `simp`, `rfl`, `change` or `omega` that evaluates it, or a power near it, can run for hours
  (one did). Keep `maxExactIntegerBits` and `maxDecimalScale` as names in proofs and reason with the laws of
  powers (`Nat.pow_lt_pow_right`, `pow_add`); state a witness with the names, not with the digits.
- Say on the swarm's board what you finished after each theorem group, and say it at once when you are blocked.
- Edit only the files you were given. Do not edit the TypeScript in `packages/kernel/src`. Do not commit, push or
  run `bun run ship`; the orchestrator checks the work and commits it.
- The machine has 16 GiB and other agents on it: one build at a time for each worker, and no test suite of the
  repository unless your brief says so.

## What the TypeScript does that Lean does differently

- BigInt `/` and `%` truncate toward zero: use `jsDiv` and `jsMod`, never `/` and `%` on `Int`.
- Strings compare by UTF-16 code unit in JavaScript (`<`, `localeCompare` is not used), by code point in Lean.
- A `Map` and a `Set` iterate in insertion order. `Array.prototype.sort` is stable.
- A loop becomes structural recursion or a fold. Where the TypeScript bounds a loop, use the same bound.
- `Object.freeze` and the object identity of results are not modelled.

## Checking

`python3 check.py` builds everything, fails on any `sorry` or forbidden word, and fails when a declaration that
was committed has been changed. `python3 check.py --allow-sorry` is for work in progress.

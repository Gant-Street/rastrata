# Posted inventory values

Read `proofs/README.md` first and follow it to the letter: a file always builds (an unfinished proof is `sorry`,
never text that does not compile; build after every definition and every theorem, never more than about fifty lines
between two builds), every build runs under the time limit, and no proof makes Lean compute with a huge number. A
worker's file that was never built counts as not written.

This is a small swarm on purpose, because the model's quota is small: one worker plus the coordinator, on
`gemini-4-hydrogen-xhigh`; no monitor worker. The worker works in this checkout, in `proofs/`, only in its own file.
Do not give it its own copy or worktree of the repository (`proofs/.lake` holds a 7 GB build of Mathlib). Nobody
commits, pushes or runs `bun run ship`. Nobody edits `proofs/Rastrata.lean`, the files under `proofs/Rastrata/Kernel/`
that exist already, the oracle, or the TypeScript. Other agents are working in this checkout on other files: do not
touch or import files you were not told to import.

Build command, from `proofs/`:
`perl -e 'alarm 300; exec @ARGV' lake build Rastrata.Kernel.<Module> 2>&1 | grep -v "module system"`

## inventory-posted-values

File: `proofs/Rastrata/Kernel/InventoryPostedValues.lean`. Source: `packages/kernel/src/inventory-posted-values.ts`
(132 lines, read all of it). It imports: `Rastrata.Kernel.Numeric`, `NumericLimits`, `Canonical`, `Journal.Types`,
`Quantization`, `QuantizationBalanced` (for `QuantizationPolicy`, `QuantizationPolicy.quantizeCumulativePostedShare`,
`QuantizationPolicy.rule`, the share laws `cumulativeShares_sum`, `quantize_*`). Read the heads and the theorem
statements of `Quantization.lean` and `QuantizationBalanced.lean` first (you use their theorems as they stand; never
edit them), and read the finished `Lots.lean` header for the style of a model with its assumptions listed.

Model faithfully, in the order of the TypeScript: `InventoryPostedValueBudget`, `ValueRejection` (a rejection is a
value: one diagnostic, code `inventory_value_adjustment_violation`, with the path and the requirement ids as written),
the private `share` (no checks: the TypeScript calls it only after validating), `InventoryPostedValueAllocation`,
`allocateInventoryPostedValue`, `InventoryAllowanceChange`, `adjustInventoryPostedAllowance`. Every exact-number
operation that can throw in the TypeScript is `.error` in the model; `Object.freeze` and the copies
`{ ...suppliedPolicy }` are not modelled (say so).

Laws to state and prove, for constructible (`WF`) inputs and calls that returned `.ok`:

1. `allocateInventoryPostedValue`, when it returns `allocated`:
   - `consumed.basis + remaining.basis = supplied.basis` and `consumed.allowance + remaining.allowance =
     supplied.allowance`, exactly (as meanings, `toRat`);
   - basis plus allowance equals carrying for the movement and for the remainder: `consumed.basis +
     consumed.allowance = carryingConsumed` and `remaining.basis + remaining.allowance = carryingRemaining`;
   - the allowance parts are never positive and the consumed basis is never negative; the remaining carrying is
     never negative;
   - terminal depletion: when `afterFraction` means 1, everything remaining is zero, so each posted component is
     consumed exactly; when `beforeFraction = afterFraction` nothing is consumed;
   - for a chain of fractions 0 = f0 ≤ f1 ≤ ... ≤ fn = 1 (as in `cumulativeShares_sum`), the consumed bases of the n
     successive allocations that each start from the previous remaining budget...: state precisely what the
     TypeScript guarantees when the caller keeps fractions "relative to the original epoch quantity" (read the doc
     comment) and prove the sum identity that is true, which is that the n consumed amounts add up to the supplied
     budget when each call receives the ORIGINAL budget and consecutive fractions;
   - each consumed carrying amount is within one unit of the exact share (`quantize` laws), and the posted share of
     the allowance magnitude is within one unit of its exact share;
   - when it returns `rejected`, the exact condition: a policy or fraction the cumulative share rejects, or a
     budget that is not representable in the policy, or a positive allowance, or a negative net carrying value (one
     iff theorem over the model's own conditions); and that the only `.error` is the size limit.
2. `adjustInventoryPostedAllowance`, when it returns `adjusted`:
   - `after.basis = before.basis` and `after.allowance = before.allowance + postedChange`, `postedMinusEconomic =
     postedChange - economicChange`, exactly;
   - `after.allowance` is never positive (a write-down never takes the allowance above zero, a reversal never takes
     it above zero or restores more than the remaining allowance), and the carrying value after is never negative;
   - a write-down has `postedChange ≤ 0`, a write-down of the whole carrying value (fraction 1) reaches zero net
     carrying value, and a reversal of the whole remaining allowance (fraction 1) restores `after.allowance = 0`;
   - the posted change is within one unit of the exact fraction of the posted carrying value (or posted allowance)
     that the economic change is of the economic one;
   - rejections: exactly when (one iff theorem over the model's own conditions: sign, nonnegativity, kind).
3. Every claim in a doc comment of the TypeScript ("Full write-downs therefore reach zero", "basis + allowance =
   carrying for every movement and remainder", "terminal depletion consumes each actual posted component exactly")
   is either proved, or disproved with a witness (found by running the real function in a one-off script in your
   scratch directory under `bun`), and reported with the line.

Each theorem gets a one-sentence plain doc comment. If a law is false for what the TypeScript does, do not bend the
model: prove the strongest true version and report the gap (file, line, input, result).

Scratch files go only in `/private/tmp/claude-501/-Users-eric--herdr-worktrees-rastrata-lean/cae2d16e-e645-4cc6-9a7b-31b78ef0cc36/scratchpad/wave4a/`.

## Done means

The file builds with no `sorry`, no `axiom`, no `native_decide`, and no `import Mathlib` (import `Rastrata.Prelude`
through the kernel files, and a specific Mathlib module when needed). The coordinator builds the file itself before
reporting, and reports: the file; what is modelled and left out; each law as one plain sentence with its theorem
name; the exact result of the final build (errors and `sorry` warnings); anything not proved and why; every place the
TypeScript does something a law did not expect (file, line, input, result).

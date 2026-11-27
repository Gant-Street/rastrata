# The append-only history, the time-zone list, the verified-snapshot cache

Read `proofs/README.md` first and follow it to the letter: a file always builds (an unfinished proof is `sorry`,
never text that does not compile; build after every definition and every theorem, never more than about fifty
lines between two builds), every build runs under the time limit, and no proof makes Lean compute with a huge
number. A worker's file that was never built counts as not written.

This is a small swarm on purpose, because the model's quota is small: two workers, one workstream each, on
`gemini-4-hydrogen-xhigh`, plus the coordinator; no monitor worker. Both work in this checkout, in `proofs/`,
each only in its own files. Do not give a worker its own copy or worktree of the repository (`proofs/.lake`
holds a 7 GB build of Mathlib). Nobody commits, pushes or runs `bun run ship`. Nobody edits `proofs/Rastrata.lean`,
the files under `proofs/Rastrata/Kernel/` that exist already, the oracle, or the TypeScript. Other agents are
working in this checkout on other files (`Journal/Admission.lean`, `QuantizationBalanced.lean`, `Lots.lean`,
`Valuation.lean`, `Policy.lean`, `Oracle/`): do not touch or import them.

Build command, from `proofs/`:
`perl -e 'alarm 300; exec @ARGV' lake build Rastrata.Kernel.<Module> 2>&1 | grep -v "module system"`

## 1. history: the append-only log

File: `proofs/Rastrata/Kernel/BookHistory.lean`. Source: `packages/kernel/src/book-history.ts`, the class
`Log<T>` and the `HistoryView` it implements, with everything they use (about the first 286 lines). The
functions below that line (`journalsOf` and the rest) tie the log to the book's state, which is not modelled
yet: leave them, and say so.

- Model `Log` as the TypeScript builds it (its fields, its sharing between a state and the next one, `append`,
  `length`, `at`, `last`, iteration, slicing, materialising to an array, and whatever else the class has), not as
  a plain list. The meaning of a log is the list of its elements, oldest first (`toList`).
- Laws: every operation agrees with the same operation on the list (`at i` is the list's element, `length` is its
  length, `last` its last, a slice its slice, materialising gives the list); `append` adds exactly one element at
  the end and changes nothing before it; **an earlier log is not changed by appending to a later one**, whatever
  storage they share (state the sharing the TypeScript has, and prove that a view taken before an append still
  means the same list after it); a branch that appends to an old log does not corrupt a newer one, or, if the
  TypeScript forbids or mishandles that, prove exactly what happens and report it with the line.
- The counters (`historyStats`) are bookkeeping for tests: model them only if a law needs them, and say which.

## 2. zones: the time-zone list and the snapshot cache

Files: `proofs/Rastrata/Kernel/IanaTimezones.lean`, `proofs/Rastrata/Kernel/VerifiedSnapshots.lean`.
Sources: `packages/kernel/src/iana-timezones.ts`, `packages/kernel/src/verified-snapshots.ts`.

- `IanaTimezones.lean`: the list of names exactly as the TypeScript has it, in the same order, and
  `isKnownIanaTimeZone` exactly as it decides (read how it compares: case, exact match, a set or a search).
  Prove: the function answers true exactly for the names in the list; the list has no duplicate; every name is
  ASCII (or report the ones that are not). Then check the Lean list against the TypeScript list mechanically:
  write a one-off script in the scratch directory given below that prints both and compares them, run it, and
  report its output. Do not type the names by hand: generate the Lean list from the TypeScript file with a script.
- `VerifiedSnapshots.lean`: the cache remembers objects that were verified, by identity. A Lean value has no
  identity, so model the cache as a set of tokens and a snapshot as a value with a token. Prove the one law that
  matters: `verifiedOr` answers what rehashing would answer, provided a snapshot is only ever marked after it
  verified and is immutable afterwards; and say plainly, with the line, what in the TypeScript guarantees those
  two provisos and what does not (that is a finding if nothing does).

Scratch files go only in `/private/tmp/claude-501/-Users-eric--herdr-worktrees-rastrata-lean/cae2d16e-e645-4cc6-9a7b-31b78ef0cc36/scratchpad/wave5a/<your name>/`.

## Done means

Each file builds with no `sorry`, no `axiom`, no `native_decide`, and no `import Mathlib` (import
`Rastrata.Prelude`, and a specific Mathlib module when needed). The coordinator builds every file itself before
reporting, and reports, one section a workstream: the files; what is modelled and what is left out; each law as
one plain sentence with its theorem name; the exact result of the final build (errors and `sorry` warnings);
anything not proved and why; every place the TypeScript does something a law did not expect (file, line, input,
result).

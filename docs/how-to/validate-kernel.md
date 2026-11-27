# Validate the accounting kernel

Use this procedure after changing the TypeScript kernel, SysML model, golden company,
verification-case catalog, or validator. The Bun version is pinned in `.bun-version`.

## Install the pinned dependencies

From the repository root:

```sh
bun ci
```

This installs the exact versions in `bun.lock` and fails if the manifest and lockfile
disagree.

## Run the complete check

```sh
bun run check
```

The command type-checks the kernel with TypeScript, validates the SysML and
golden-company artifacts, runs the fast Bun suite with LCOV instrumentation,
requires exactly 100% function and line coverage in every
`packages/kernel/src/*.ts` production module, and verifies the 102-entry semantic
trace against live named exports and actual fixture executors.

It also runs workspace tests, dependency-boundary checks, and repository tooling
tests. Package checks are orchestrated by Turborepo with caching disabled; the
root-relative coverage/packages/kernel/spec/trace gates retain their existing paths and thresholds.

The Bun suite executes every one of the original 37 admitting/rejecting SysML design
oracles, and the two later ones for the chain-head state commitment (V14 and I25), and
verifies that all 30 original Ring A/B requirements map to both polarities through
`packages/kernel/test/kernel-requirement-coverage.json`. The I06 oracle scans the
semantic core for ambient I/O, wall-clock, randomness, environment, and
Node-platform dependencies. The durable-codec cases also round-trip canonical state,
revalidate revision hashes and command/effect topology, and reject unknown fields or
invalid domain scalar types under the pinned codec version.

For the complete engineering release gate, including licensed SysIDE diagnostics,
the decade soak, mutation-infrastructure self-tests, and all-module mutation analysis:

```sh
bun run check:release
```

## Run the repeatable closure check

To run only the model closure check:

```sh
python3 packages/kernel/scripts/validate-spec.py
```

The command succeeds only when requirement scope and traceability, paired kernel
oracles, and the exact golden-company calculations remain consistent. The frozen
historical baseline contains 30 executable kernel requirements and 37 executable
design cases (the catalog now also holds the two chain-head state commitment oracles,
39 in all); its fixture contains 17 book revisions and net income of 15,400 cents.

The same command checks the unified target design: all 47 parent `ACC-*` requirements,
all 55 atomic children of ACC-039 through ACC-047, architectural responsibility and
verification closure, and 18 bounded design groups containing 65 isolated scenarios.
The accounting extension is implemented: its 65 scenarios have executable
conformance mappings, its nine parent requirements have dual-polarity coverage, and
its fixture catalog has status `implemented-and-executable`.

## Check the SysML model

Open `packages/kernel/spec/rastrata-accounting-backend.sysml` with SysIDE and request project
diagnostics. Syntax, reference, and semantic diagnostic counts must all be zero.

For a repeatable language-server check using the installed SysIDE Editor:

```sh
python3 packages/kernel/scripts/check-syside-diagnostics.py
```

The checker first proves that valid, syntax-invalid, and unresolved-reference
controls behave correctly. It validates an exact saved copy of the self-contained
kernel model with an isolated semantic canary, consumes the actual published
diagnostics, and removes only that canary's expected diagnostic. Missing reports,
timeouts, malformed messages, and undemonstrated semantic validation fail closed.
The original model is never modified. This matters because SysIDE 0.10.3 can return
an empty response to the unadvertised diagnostic-pull endpoint even when its
published diagnostics contain errors. The old pull-only check was not reliable.

SysIDE Editor's own [installation verification](https://docs.sensmetry.com/editor/install/)
also uses an unresolved-type example to demonstrate real semantic diagnostics.
If the kernel is split into files with relative imports, extend the staged model
closure before relying on this single-file checker.

The standalone SysIDE command requires a Modeler license. If one is configured, the
equivalent repository-root check is:

```sh
syside check packages/kernel/spec/rastrata-accounting-backend.sysml
```

## Check repository hygiene

```sh
git diff --check
git status --short
```

Review every reported file. Generated caches and local `references/` checkouts must
not be committed.

For the current decision and exact measured checkpoint, see the
[kernel closure record](../reference/reviews/kernel-v1/production-closure.md).
The [earlier validation record](../reference/reviews/kernel-v1/validation-record.md)
is historical evidence, not certification of subsequently changed code.

# Accounting engine compatibility lab

This lab turns the source-level trade study into repeatable behavioral evidence. It
does not ask whether Beancount, hledger, and Ledger can print similar reports. It asks
whether the same economic facts produce the same accepted state, lot allocation,
basis, gain, valuation, and failure behavior.

The reference commits are pinned in
[source register](../../../../docs/reference/source-register.md). The
checkouts under `references/` are inputs pinned as optional Git submodules. Build products
must stay outside this repository.

## Method

Each fixture contains:

- `case.md`: engine-independent facts, invariant, and what the probe is testing;
- one or more native input files per engine;
- commands in `lab.json`, including policy variants when a behavior is not a file
  property.

`run_lab.py` captures stdout, stderr, and exit status without normalizing away a
semantic difference. The Beancount probe loads and books the file through its Python
API and emits typed JSON; command-line success alone would hide inferred postings and
resolved costs.

This is a compatibility laboratory, not an interchange promise. An engine may be
marked unsupported when it lacks a concept. A transformed representation is not
treated as native semantic parity.

## Running the pinned engines

Set these variables to binaries built from the commits in the reference register:

```sh
export BEANCOUNT_PYTHON=/path/to/beancount-venv/bin/python
export HLEDGER_BIN=/path/to/hledger
export LEDGER_BIN=/path/to/ledger
python3 packages/kernel/spec/research/run_lab.py \
  --output /tmp/rastrata-accounting-engine-results
python3 packages/kernel/spec/research/verify_results.py \
  /tmp/rastrata-accounting-engine-results
```

For the 2026-08-24 study on macOS, the disposable paths were:

```text
BEANCOUNT_PYTHON=/tmp/rastrata-ledger-lab/beancount-venv/bin/python
HLEDGER_BIN=/tmp/rastrata-ledger-lab/hledger-bin/hledger
LEDGER_BIN=/tmp/rastrata-ledger-lab/ledger-build-2/ledger
```

The runner refuses to overwrite an existing output directory. Use a fresh path for
every run so historical evidence cannot be silently replaced.

The verifier checks the pinned behavioral contract, including expected rejection.
See [`observations.md`](observations.md) for the evidence-backed synthesis.

## Interpretation rules

1. Acceptance is not correctness. Inspect the resolved postings and balances.
2. A CLI option is part of the semantic configuration and is always captured.
3. Defaults are tested separately from explicitly selected policies.
4. Display output is evidence about interchange fidelity, not necessarily internal
   arithmetic.
5. Source-order sensitivity is a failure unless order is an explicit economic field.
6. Expected rejection is a useful result when it fails closed for the right reason.

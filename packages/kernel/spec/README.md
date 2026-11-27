# Backend system model

`rastrata-accounting-backend.sysml` is written in OMG SysML v2 textual notation. It
contains the single target design for the accounting kernel. ACC-001 through ACC-047
have an audited executable implementation baseline. The model contains:

- semantic requirements and stable requirement IDs;
- exact numeric, book, fiscal-period, opening, journal, dimension, lot, correction, close,
  report-population, policy-capability, valuation-path, evidence, and reconciliation
  types;
- the pure command-evaluation authority and its boundary from non-booking source resolution;
- the portable command/commit boundary and serialized book authority;
- the backend logical architecture and responsibility boundaries;
- golden-company, adversarial, replay, close, projection, cross-book, storage-parity,
  and reference-traceability verification objectives.
- requirements for deterministic inventory costing, provisional inventory
  recosting, open-item settlement, cash/accrual projection, currency remeasurement,
  generic allocation schedules, supplied-policy tax determination, consolidation, and
  the accounting/workflow boundary.

The model is aligned with the official 2026-07 SysML v2 release examples and textual
grammar. It intentionally avoids encoding implementation-language or deployment choices
that have not earned their place through a trade study.

There is no parallel v2 model. All requirements live in `Requirements` and retain
stable `ACC-*` IDs. Customer/vendor records, document delivery, bank feeds,
rate acquisition, tax-jurisdiction selection and filing, asset-register custody,
payroll, AI, UI, authorization, hosting, and database selection remain outside. They
may supply evidence or typed commands but cannot become alternate posting authorities.

Run the bounded closure checks with:

```sh
python3 packages/kernel/scripts/validate-spec.py
```

The validator preserves the 30-requirement executable baseline while enforcing all 47
parent requirement definitions, 55 atomic children for ACC-039 through ACC-047, their
architectural responsibilities and verification objectives, and 18 bounded design
groups containing 65 isolated scenarios. The
design cases are executable-support claims only for the capability-gated methods
proven by their implementation, conformance mapping, and coverage gates.

The complementary closure audit is
[`../docs/reference/reviews/kernel-v1/closure-audit.md`](../../../docs/reference/reviews/kernel-v1/closure-audit.md), and its
executable acceptance catalog is
[`kernel-v1-verification-cases.json`](kernel-v1-verification-cases.json).
The accounting-extension executable specifications are
[`kernel-design-verification-cases.json`](kernel-design-verification-cases.json), and the scope
decision is
[`../docs/reference/reviews/kernel/design-scope.md`](../../../docs/reference/reviews/kernel/design-scope.md).
The accounting evidence and explicit non-adoptions are recorded in
[`../docs/reference/reviews/kernel/accounting-reference-review.md`](../../../docs/reference/reviews/kernel/accounting-reference-review.md).

Use the [validation guide](../../../docs/how-to/validate-kernel.md) to check changes and
the [current closure record](../../../docs/reference/reviews/kernel-v1/production-closure.md) for the
measured release verdict. The [earlier validation record](../../../docs/reference/reviews/kernel-v1/validation-record.md)
preserves historical evidence, not certification of subsequently changed code.

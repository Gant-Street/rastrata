# Production ledger system design

Scope: the durable execution boundary around the frozen accounting kernel, not a
second accounting engine and not the application workflows. The target is one
SQLite-backed Durable Object as the posting authority for each book.

Status: the initial bounded design milestone was verified on 2026-09-05. The
capacity-driven G1 extension now models optional independent-archive durability,
publication/reconciliation, and indexed-view coverage/cutover/pins/reclamation.
It also models the proposed indexed-kernel profile/logical commitments and complete
context admission, with a deliberately open runtime verification obligation. See
the [representation boundary](state-access-contract.md#indexed-representation-boundary).
The full representation design, implementation conformance and production readiness
remain open. See the [archive review](design-review.md#archive-publication-model-extension)
and [indexed-view review](design-review.md#indexed-view-model-extension).
The separate [native SQL current-state candidate](design-review.md#native-cloudflare-development-verification--2026-09-07)
is now scoped by PL-022/L25. It measures ordinary-journal performance with SQLite-owned
indexes and transactions; it does not close full recovery or enable production.

## Goal and working sequence

1. Review pinned references and platform failure assumptions; settle design choices.
2. Model typed boundaries, lifecycle, invariants, and concrete verification cases.
3. Audit failure paths, restore authority, identity, bounds, and unnecessary scope.
4. Run semantic SysIDE checks and executable design checks with negative controls.
5. Record the exact design verdict and remaining runtime implementation obligations.

This is not a production runtime closure record. Existing prototype tests remain
separate evidence; the [design review](design-review.md) records the audit and scope.

## Ownership

- `rastrata-production-ledger.sysml`: ledger requirements and their formal contracts.
- `verification-cases.json`: concrete design cases, including counterexamples. Fixture
  schema `rastrata-ledger-design-v2` names the state machine for every lifecycle trace;
  this is a checker-format change, not a second kernel, accounting version or ledger fork.
- `design-review.md`: decisions, reference evidence, audit findings, and verdict.
- `workload-contract.md`: proposed business acceptance profiles, quantitative derivation,
  capacity/atomicity design gaps and owner decisions; not executed performance evidence.
- `state-access-contract.md`: audited command dependencies, complete/negative-read and
  hash-compatibility obligations, plus open correctness findings; not an implemented
  indexed evaluator or semantic traceability proof.

The kernel's model is imported by reference from `../../kernel/spec/`; no accounting
types or command variants are copied. Cross-system context and implementation
status remain in [the ledger reference](../../../docs/reference/production-ledger.md).

Production workload targets, Cloudflare account selection, operational ownership,
and remote validation remain deployment gates. Evaluation workloads are not SLAs.

## Verify

From the repository root:

```sh
bun run --cwd packages/ledger check:spec
bun run --cwd packages/ledger check:syside
bun run check
```

The first command checks the model's bounded scalar and lifecycle subset, exact
fixtures, objective mappings and adversarial checker controls. SysIDE checks full
syntax/semantics and real cross-file workspace imports. The root release check
requires both ledger SysIDE and the existing kernel release gates.

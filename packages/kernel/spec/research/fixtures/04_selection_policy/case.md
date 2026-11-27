# Explicit lot-selection policies

Facts: three lots contain 2 UNIT at 10 USD (oldest), 2 UNIT at 30 USD, and 2 UNIT
at 20 USD (newest). Dispose of 3 UNIT at 40 USD each.

Invariant: FIFO consumes 2@10 + 1@30; LIFO consumes 2@20 + 1@30; HIFO consumes
2@30 + 1@20. Quantity and allocated basis must be conserved when a disposal spans
lots.

Probe: explicit FIFO, LIFO, and HIFO behavior. Missing policy support is recorded as
unsupported, not emulated with a report option.

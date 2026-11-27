# Ambiguous reduction under defaults

Facts: acquire one UNIT at 10 USD and a second at 20 USD, then dispose of one UNIT
for 30 USD without identifying a lot.

Invariant: ambiguity must fail closed unless a selected, versioned policy resolves
it. A default that chooses a lot is an accounting policy, not a parser convenience.

Probe: each engine's unconfigured behavior. Ledger is additionally rerun with an
explicit FIFO flag to separate capability from default behavior.

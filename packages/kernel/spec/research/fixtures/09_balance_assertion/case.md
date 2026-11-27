# Balance assertion is evidence

Facts: cash is 100 USD. A later assertion claims it is 99 USD without recording an
economic event.

Invariant: the assertion must fail and must not synthesize a 1 USD adjustment. An
assertion observes ledger state; it never changes that state.

Probe: failure behavior and any automatically generated posting.

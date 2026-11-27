# Single missing amount

Facts: on 2025-01-02, 123.450 USD enters cash as opening equity. The equity
posting omits its amount.

Invariant: exactly one missing amount may be inferred as -123.450 USD. The written
scale of the explicit amount is source evidence even if a renderer shortens it.

Probe: acceptance, inferred amount, and preservation or loss of decimal scale.

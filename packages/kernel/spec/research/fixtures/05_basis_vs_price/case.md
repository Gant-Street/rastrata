# Cost basis is not transaction price

Facts: acquire 2 UNIT at 10 USD each, then sell 1 UNIT at 16 USD.

Invariant: remaining units retain 10 USD basis and realized gain is exactly 6 USD.
The 16 USD sale price must not overwrite lot basis or become a market observation
without an explicit derivation.

Probe: resolved reduction, remaining lot, and gain representation.

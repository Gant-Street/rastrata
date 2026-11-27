# Specific identification

Facts: acquire one UNIT at 10 USD on 2025-01-02 and one at 20 USD on 2025-02-02.
Dispose of the second acquisition for 30 USD.

Invariant: the explicit selector consumes only the 2025-02-02 acquisition and
realizes 10 USD gain. Under a SPECID policy, a reduction without a selector must
fail rather than fall back to FIFO.

Probe: selector representation and fail-closed behavior when selection evidence is
missing.

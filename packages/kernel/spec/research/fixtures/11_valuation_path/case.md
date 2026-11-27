# Valuation path provenance

Facts: hold 1 AAA. At the valuation date, 1 AAA = 2 BBB and 1 BBB = 3 USD. There
is no direct AAA/USD observation.

Invariant: a 6 USD value is valid only with the selected two-edge path and both
observations recorded. Booking must not depend on this reporting valuation.

Probe: automatic graph traversal, caller-specified intermediate currencies, and the
absence of path provenance in ordinary formatted output.

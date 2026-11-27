# Virtual postings

Facts: record a real 10 USD cash expense and an additional 10 USD memo allocation
that must not affect the canonical trial balance.

Invariant: Rastrata's booked journal contains only real balanced postings. Memo,
budget, and analytical allocations are derived read models with explicit lineage.

Probe: native virtual-posting syntax and whether ordinary versus real-only reports
silently include different state.

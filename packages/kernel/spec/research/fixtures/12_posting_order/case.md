# Posting order must not select economic meaning

Facts: acquire 400 EUR for 480 USD at an explicit 1.2 USD/EUR transaction price.
The two files per engine differ only in posting order.

Invariant: both orders produce the same booked facts and USD valuation. Ordering is
presentation; transaction price is semantic evidence.

Probe: acceptance and valuation equality after reversing the postings. This also
guards Ledger's historical issue where inferred primary commodity depended on order.

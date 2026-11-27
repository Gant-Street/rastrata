# Account lifetime

Facts: an account is opened on 2025-01-10, but a transaction uses it on 2025-01-05.

Invariant: canonical booking rejects use outside the account's economic lifetime.
Declaration existence alone is insufficient; its validity interval matters.

Probe: native lifecycle semantics versus declaration-only or unrestricted accounts.

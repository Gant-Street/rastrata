# Synthetic ledger development deployment

An isolated Cloudflare Worker with one SQLite-backed Durable Object for a fixed
synthetic book. This is a development verification harness, **not the application
API**, and must never accept real accounting data. It imports only the kernel and
ledger public APIs; the local ledger test handler is not deployed.

See [deploy and verify the development ledger](../../docs/how-to/deploy-development-ledger.md)
for credentials, commands, access expiry, and verification limits.

`src/` owns the restricted gateway and synthetic scenario, `test/` checks admission
and the real local Workers runtime, and `scripts/` owns deployment and remote checks.
Root checks include the local tests. Cloud deployment is always explicit.

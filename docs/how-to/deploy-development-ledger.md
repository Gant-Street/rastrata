# Deploy and verify the development ledger

Use this to exercise the ledger prototype on real Cloudflare SQLite-backed Durable
Objects. It uses only `rastrata-ledger-dev`, preserving its `SyntheticBook` namespace
and adding a separate `SyntheticNativeBook` namespace for the native SQL candidate.
It is not a production rollout or a general accounting API.

## Prerequisites

- Install the repository's pinned Bun version and run `bun ci`.
- Configure the account's workers.dev subdomain in Cloudflare.
- Put `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the root `.env`.
  Scope the token to the intended account with Workers Scripts Edit access.
- Run `bun run check` before deployment. No plan upgrade, DNS changes, custom
  domain, R2 bucket, or CI deployment is part of this procedure.

Cloudflare usage is subject to the account's existing plan. The harness limits
durable growth to three legacy outcomes and four native outcomes, but repeated
HTTP requests can still consume request/CPU allowances. There is no hard billing
cap implemented here. Do not publish the access token or run load tests without
agreeing on a separate budget.

## Deploy

From the repository root:

```sh
bun run --cwd apps/ledger-acceptance deploy
```

The deployment script generates a separate 256-bit development access secret in
the gitignored root `.env.ledger-dev`, with owner-only file permissions. It stores
that secret in the Worker, never the Cloudflare management token. Existing local
development credentials are reused on reruns. A same-named existing Worker without
the local credential file requires manual inspection before adoption.

The script deploys the Worker, runs both remote smoke checks, deploys a replacement
version, and verifies unchanged legacy head/aggregate hash and native head/outcome
bytes. The additive `v2-native-smoke` migration neither renames nor deletes the
existing namespace. It
prints the development URL and UTC expiry, but never credentials. An interrupted
or failed deployment can leave the development resources in place; inspect the
reported stage and rerun after resolving the cause. A failed smoke check is not a
successful deployment verification.

Access expires 24 hours after running the deployment script. The checked-in
configuration has an expired default, so direct deployment without explicit
configuration fails closed. Expiry disables the HTTP harness; it does not delete
Cloudflare resources or their stored synthetic data.

## Verify again

```sh
bun run --cwd apps/ledger-acceptance smoke:remote
```

The command reads the generated credentials locally and sends the secret in an
Authorization header over HTTPS; it does not place credentials in the URL or follow
redirects. Visiting the printed URL in a browser without that header is expected
to be denied. There is no UI in this deployment.

Authenticated routes are `GET /health`, `GET /state`, and `POST /smoke`. The harness
rejects query parameters and nonempty bodies. Callers cannot select a tenant, book,
command, date, or amount. The fixed scenario activates a zero-balance book, posts
a synthetic $100 sale, retains an unbalanced-journal rejection, and retries both
the accepted and rejected commands. Repeated calls add no new outcomes.

`GET /native/state` and `POST /native/smoke` exercise the same fixed scenario in
the separate native namespace. Both gateway and object enforce the same secret,
expiry and no-payload rules; the native object bounds its pending queue to 16 and
returns 429 above that limit. Expiry is checked after queueing and at the storage
boundary. The verifier compares actual retained command/result/revision bytes with
direct full-kernel execution, reconstructs every scoped native hash-chain edge from
the exact stored genesis and outcomes, and rejects tampered receipts and heads.
The deployment output records two whole-scenario HTTP durations, distinguishing
newly retained results from retries. These are not individual-save measurements or
a production latency acceptance test.

After that scenario is initialized, `POST /native/save` executes one fixed $100
follow-up journal and subsequently only retries it. It cannot create arbitrary
commands or initialize another book. The verifier checks the exact original result,
the fourth retained outcome, unchanged first-three-outcome prefix, and persistence
after redeployment. Its HTTP round-trip timing measures this single operation,
including network and routing; the scenario's provisioning and other commands are
outside that timer. One fresh save and one retry do not establish a latency SLO.

The verifier checks exact original kernel results, outcome sequences 1/2/3,
financial revision 2, unchanged retry outcomes, and equality of the complete durable
aggregate hash with direct local kernel execution. Local tests additionally replace
the workerd process and exercise concurrent calls and access failures.

## Interpret the evidence

A passing smoke run demonstrates the deployed prototype's bounded happy path,
rejection retention, idempotency, and persistence across redeployment. Redeployment
does not prove forced object eviction, abrupt crash survival, provider outage
recovery, independent backup restoration, capacity, or satisfaction of every ledger
SysML requirement. These remain separate production-ledger implementation and
verification work. The synthetic-only secret is not the future tenant authorization
system, and there is no external provisioning catalog or restore fence yet. The
native harness does not enable unsupported command families, R2 backup/restore,
production authentication, production load tests or customer books.

To stop access immediately, disable the Worker route or remove its development
secret in Cloudflare. Namespace deletion is deliberately not automated: it destroys
stored synthetic books and needs explicit target confirmation.

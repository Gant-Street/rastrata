# Application service

Shared bookkeeping workflows and report queries over the authorized ledger. The
service owns draft/operation state and accounting orchestration; clients never
write ledger tables or invent a second calculation authority.

- `@rastrata/application` exports the runtime-independent service and persistence
  port.
- `@rastrata/application/contracts` exports browser-safe data contracts.
- `@rastrata/application/client-contracts` exports generated operation inputs, outputs
  and versioned request/response types for TypeScript clients.
- `@rastrata/application/local` supplies the explicit local Bun/SQLite adapter and
  server-held development credentials.
- `@rastrata/application/http` supplies the versioned application boundary.
- `@rastrata/application/schema` publishes the operation catalog and schemas.
- `@rastrata/application/legacy-http` groups the existing browser routes over the same workflows.
- `@rastrata/application/reports` exports the shared report compiler.

The local adapter uses the existing web application's tables and book scope, so
the extraction preserves local books, retained commands, drafts and receipts.
Local access is a development mode, not hosted user authentication.

`drafts.recover` reopens the same draft at a new version after a durable posting
rejection. Supply its `draftId`, `expectedVersion`, `postingOperationId`, and a new
request operation identity. It requires the `draft` permission and changes no
posted balances. Identical retries return the original recovered draft snapshot.
The draft links to the rejected attempt with `recoveredFromOperationId`; the old
plan, command and outcome remain available through `operations.get`, and replaying
its commit returns the original receipt even after recovery or discard. Prepare
the returned version under a new posting identity and review it before committing.
Unresolved and committed postings cannot be recovered for editing; inspect or
retry an uncertain posting using its exact original identity and input.

Drafts may include `source: { id, description, evidenceReference? }`. The source ID
is case-sensitive and scoped to the selected book (1–128 ASCII letters, digits,
`_` or `-`, starting with a letter/digit). The original description and optional
evidence reference are retained with a server-computed canonical fingerprint.
Reusing that ID with different facts returns `source_identity_conflict`; journal
lines, narration and accounting date remain editable before posting. An evidence
reference is plain data: no file is uploaded, fetched or validated against an
external system.

`sources.get` accepts `sourceId` and an optional linked-draft `page`;
`sources.list` accepts optional `page` and literal `text`. Both require `read`,
use pages of 25, and report the source's posting identity, journal and status.
Registration shares the draft write transaction and needs `draft`; preparation and
posting still need `post`. A preview reserves no posting. Commit atomically claims
the source before ledger dispatch. An uncertain owner blocks other attempts;
a durable rejection permits fresh review under a new operation identity. A
successful source remains consumed after a linked reversal.

Tagged drafts return `journalId`, which differs from the product draft ID. The
financial identity is derived from the book and source ID and enforced by the
existing kernel journal uniqueness rule. Posted journal details expose durable
source ID/fingerprint provenance, inherited by linked reversals. Retained commands,
outcomes and pinned reports are not rewritten. The source inspector projects the
latest product state; use journal/report revisions for historical financial reads.

References remain freeform. Untagged manual entries retain their existing behavior
and have no source duplicate protection. Distinct source IDs are not automatically
recognized as the same economic event: clients must select a stable identity from
the user's evidence and clarify ambiguous matches rather than minting another ID.
There is no importer, receipt storage, similarity matcher or replacement-journal
workflow in this milestone.

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application test
```

See the [terminal scope](../../docs/reference/terminal-app-scope.md) for the API and
terminal client work built on this package.

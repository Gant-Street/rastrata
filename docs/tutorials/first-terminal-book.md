# Your first book through the terminal

Use a fresh synthetic book for this tutorial. It is the same manual bookkeeping
scenario as the [browser tutorial](first-book.md). The terminal executable requires
the independently running Bun application service. Install Bun/Go from the pinned
version files; the shell snippets also use `jq` to carry IDs between commands.

```sh
bun ci
bun run --cwd apps/terminal build
RASTRATA_LOCAL_DB=/tmp/rastrata-terminal-example.sqlite bun run dev:api
```

In another terminal, from the repository root:

```sh
rastrata_cli=apps/terminal/dist/rastrata
$rastrata_cli context
$rastrata_cli capabilities
$rastrata_cli schema journal.prepare
$rastrata_cli book setup --input apps/terminal/examples/setup.json
```

Setup is explicit and happens once. Starting either service or client does not
seed a book. Use an unused SQLite path for a new example; the default API path
preserves the existing book in `apps/web/.local/book.sqlite`.

Create a draft, prepare its exact effects, inspect them, and commit that plan:

```sh
$rastrata_cli drafts create --input apps/terminal/examples/opening.json > /tmp/rastrata-draft.json
jq '{draftId: .data.id, expectedVersion: .data.version}' /tmp/rastrata-draft.json |
  $rastrata_cli journal prepare --input - > /tmp/rastrata-plan.json
cat /tmp/rastrata-plan.json
$rastrata_cli operations commit \
  "$(jq -r '.data.planId' /tmp/rastrata-plan.json)" \
  "$(jq -r '.data.planHash' /tmp/rastrata-plan.json)"
```

Opening balances use a balanced journal: Cash debit `1000.00`, Owner capital
credit `1000.00`. Draft and preview leave posted balances unchanged. Repeat these
three steps using `examples/income.json`, then `examples/expense.json`.

```sh
$rastrata_cli journal list
$rastrata_cli reports all --as-of 2026-01-31 > /tmp/rastrata-reports.json
$rastrata_cli reports trial-balance --as-of 2026-01-31 --format csv
jq '.data | {accountId: "1000", asOf, revision: .bookRevision, populationHash,
  from: "2026-01-01", to: "2026-01-31"}' /tmp/rastrata-reports.json |
  $rastrata_cli activity --input -
```

Expected figures: Cash `1150.00`, net income `150.00`, assets `1150.00` and equity
including earnings `1150.00`. The trial balance totals are `1200.00` on both sides.
Activity retains the report's revision/population even after later postings.

Use `journal get ID` to inspect the expense. Prepare its immutable reversal:

```sh
# Replace EXPENSE_ID with the posted journal ID from journal list.
printf '%s\n' '{"journalId":"EXPENSE_ID","accountingDate":"2026-01-17","reason":"Entered in error"}' |
  $rastrata_cli journal prepare-reverse --input - > /tmp/rastrata-reversal.json
cat /tmp/rastrata-reversal.json
$rastrata_cli operations commit \
  "$(jq -r '.data.planId' /tmp/rastrata-reversal.json)" \
  "$(jq -r '.data.planHash' /tmp/rastrata-reversal.json)"
```

Cash becomes `1200.00` and net income `200.00`. Both journals remain linked.
`accounts prepare-create` and `accounts prepare-change` review prospective chart
changes; use their schemas for inputs and the same commit command afterward.
`periods prepare` takes `{periodId, operation: "close"|"reopen", reason}`. January
is `period-01`; a closed period rejects journal posting until reopened with a reason.

After any interrupted write, inspect its original identity:

```sh
$rastrata_cli operations requests
$rastrata_cli operations status OPERATION_ID
$rastrata_cli operations resume OPERATION_ID
```

Resume uses the retained bytes and never invents a new identity. A repeated commit
returns the existing outcome. A stale draft version conflicts; a stale book plan
is rejected. After `operations status` confirms a durable rejection, inspect its
draft and reopen that same draft at the next version:

```sh
# Replace the IDs and version with the retained attempt and current draft.
printf '%s\n' '{"draftId":"DRAFT_ID","expectedVersion":1,"postingOperationId":"REJECTED_OPERATION_ID"}' |
  $rastrata_cli drafts recover --input -
```

Recovery changes no balances and preserves the old receipt. Edit the returned
version if needed, prepare it under a new posting identity, inspect the new
preview and explicitly commit. A lost recovery reply uses `operations resume`
with the recovery request's original identity. An unresolved or committed
posting cannot be reopened for editing.

Inspect the original event before proposing another posting:

```sh
$rastrata_cli sources get capital-001
$rastrata_cli sources list
```

The source's `journalId` is the financial journal identity; use it for journal
inspection or reversal, rather than the draft ID. Keep the same source descriptor
when editing. Another request ID cannot rebook this identified event. A reversal
retains its source link and does not make the source available for reuse. Existing
untagged manual journals and distinct source IDs have no economic deduplication.

Stop and restart the API with the same database, then rerun reports. Connect the
web with `RASTRATA_API_URL=http://127.0.0.1:4010 bun run dev:web` to inspect the same
book at `http://127.0.0.1:4000`.

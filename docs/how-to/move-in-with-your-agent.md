# Move to Rastrata with your own agent

This guide moves a business onto Rastrata from whatever files its owner has: statements from the banks
and cards (CSV, OFX, QFX, sometimes PDF), a trial balance and a chart of accounts exported from the old
system (Xero, QuickBooks, Wave or another), perhaps a ledger export and a payout report. It works for
any old system. It is for the owner, or for the owner's agent (Claude Code, Codex, opencode) working
through the `rastrata` command line.

The division of work is the point. Your agent reads the files, which is the hard part: every bank
writes its own layout. Rastrata does not call a model and does not guess. It gives the agent a
deterministic surface (scan, plan, recipes, preview, import) and **gates** that fail loudly, and it
takes the proof from arithmetic: a statement's running balance, or the opening and ending balances the
statement itself prints, and in the end a reconciliation that closes at exactly 0.00. A layout an agent
works out once is saved as a **recipe**, data and never code, and from then on it is read the same way
every time with no agent awake.
<!-- help: skip -->
Why it is built this way is in [Recipes and gates](../explanation/recipes-and-gates.md).
<!-- help: end -->

Nothing here posts anything. Importing queues lines in For review; opening balances, posting and
closing still need the owner's approval, as everywhere else.

## Before you start

- A running service and a book with an account for every bank and card you will bring over (a bank is
  an asset account, a card a liability account). [Set up your books](set-up-your-books.md).
- A folder with the files, outside any repository. They hold the whole business. Statements first; the
  trial balance as at the day before the start date; the old chart; anything else you have.
- An agent with a token that holds `draft`: `rastrata tokens create --label "Claude Code" --preset draft`,
  then `rastrata agent init --agent claude` writes the runbook and the skill into the project
  ([Connect your agent](connect-your-agent.md)). The runbook has a section on moving in.
- The owner's answers to three questions, which no one may guess: the **cutover date** (the first day of
  the new books, usually the first of a month), **which accounts have statements**, and **how far the
  statements should reach**.

## 1. Scan the folder

```sh
rastrata intake scan ~/move-in --brief=true --format text
```

The command reads the folder (it is the only part of Rastrata that touches your file system, and it
takes the path from the command line and from nothing else), uploads each file to the book's archive,
and asks the service what each one is. It reads, and imports nothing:

- Symbolic links are never followed (one that points out of the folder is listed as `symlink_outside`),
  and hidden files, empty files, files over 16 MiB, anything past 200 files, 128 MiB or four folders
  deep is listed as skipped with the reason. Nothing is silently dropped.
- Each file is typed by its **bytes**, not its extension: CSV, TSV, OFX, QFX (Intuit's flavour of
  OFX), JSON, PDF, workbook, archive, image, plain text. A ZIP is never opened (its entry names are
  counted, and a name that climbs out of its folder is flagged).
- For a delimited file: the delimiter, encoding (and byte-order mark), line endings, header row, row
  count, the dates it holds and how they are written (month first, day first, year first, or
  **ambiguous**), and whether a status column holds lines that are not final.
- For a statement: how the program would read it with no help, the lines, totals and range, and
  whether it carries a balance (a running balance, or one reported at the end).
- For a trial balance: the date it is as at, and whether debits equal credits.
- A **guess of the role** of each file with a confidence: bank statement, card statement, trial
  balance, chart of accounts, general ledger, payout report, invoices, other. A card's statement often
  looks like a bank's; the guess is a hint, not a verdict.
- What the file **needs** next: `none`; `recipe` (the program cannot read the layout alone);
  `human` (some rows cannot be read and the owner must agree to set them aside); `agent` (a PDF, a
  workbook, an archive or an image: the program does not open them, and your agent must read them or
  ask for the bank's CSV, OFX or QFX download).

The answer names every file by its SHA-256, which is how the later steps refer to it.
<!-- help: installed -->
Over MCP the upload is done by the CLI, and `rastrata_scan_intake_files` takes the ids.
<!-- help: end -->

The scan writes to the friction log (below) what it found: the files that need an agent or a recipe.

## 2. Plan

Write a plan input. It names files by id, never by path:

```json
{
  "cutoverDate": "2026-08-01",
  "through": "2026-10-31",
  "sources": [
    { "account": "1010", "files": ["<id>", "<id>", "<id>"] },
    { "account": "2100", "files": ["<id>", "<id>", "<id>"] }
  ],
  "files": ["<every id the scan found>"],
  "trialBalance": "<id>",
  "chart": "<id>",
  "balances": [{ "file": "<id>", "opening": "1000.00", "ending": "1209.90" }],
  "ignore": ["<id of a file left out on purpose>"]
}
```

```sh
rastrata intake plan --input plan.json --gaps-only=true --format text
```

The plan is a checklist, each item **present**, **missing** or **uncertain**, with who has to act
(`agent`: your agent, with what it has; `customer`: the owner) and the next command. It looks at:

| Item | What it checks |
| --- | --- |
| `cutover_date` | A date is chosen, and agrees with the one recorded in the book. |
| `source_account`, `source_files` | Each source has a chart account (bank or card, open) and at least one file. An account with no file is missing. |
| `statement_readable` | Each file reads: by a preset, by detection, by a saved recipe, or not yet (it needs a recipe, or the owner's agreement to set rows aside, or a decision on the date order). |
| `statement_coverage` | Every month from the cutover to `through` has a statement. A month with none is missing, named by account and month. |
| `statement_ending_balance` | Each statement has a balance that proves it complete: its own running balance, one it reports, or the ending balance you read from the statement (`balances`). Missing otherwise. |
| `statement_continuity` | Each file opens where the one before it closed. A break means a line or a file is missing between them. |
| `duplicate_file` | The same file listed twice, or two different files that cover the same days. |
| `trial_balance_file`, `_date`, `_ties`, `_statements` | There is a trial balance; it is as at the day before the cutover; debits equal credits; and it agrees with each account's first statement. A disagreement is the old books against the bank, and the bank wins. |
| `account_without_source` | The trial balance holds a balance for a bank or card account no file is assigned to. |
| `unassigned_file`, `unparsed_file` | A statement-like file nobody assigned; a file the program does not read. |

A required item that is not present means the move cannot start yet. `--check=true` exits 3 until the
plan is ready, so a script can wait on it. Run the plan again after every fix; it records its gaps in
the friction log and resolves them when they are gone.

## 3. Write a recipe for each layout the program cannot read

A recipe is a JSON file. It is the statement mapping an import profile already holds, with a name, a
version and the kind of account:

```json
{
  "version": 1,
  "name": "Harbor Federal savings",
  "accountKind": "bank",
  "encoding": "utf-8",
  "mapping": {
    "delimiter": ";",
    "headerRow": 1,
    "date": { "header": "Posted" },
    "dateOrder": "dmy",
    "amount": { "kind": "signed", "amount": { "header": "Amount" } },
    "description": [{ "header": "Details" }],
    "balance": { "header": "Balance" },
    "decimal": ","
  }
}
```

| What a layout varies in | The field |
| --- | --- |
| Rows to skip above the header | `mapping.headerRow` (0 when the file has no header: name columns by `index`) |
| Delimiter, encoding | `mapping.delimiter`; `encoding` (the file must decode as this) |
| Date column and format | `mapping.date`, `mapping.dateOrder` (`mdy`, `dmy`, `ymd`; a month name needs none) |
| One signed amount, or a debit and a credit column, or an amount with a direction | `mapping.amount.kind`: `signed`, `debitCredit`, `direction` |
| Sign convention | `mapping.amount.invert` (an issuer that writes charges as positive); `direction` values |
| Decimal and thousands separators, parentheses | `mapping.decimal`; thousands separators and parentheses are read as they come |
| Running-balance column | `mapping.balance` |
| Memo and reference columns | `mapping.description` (joined), `counterparty`, `reference` |
| Lines that are not final | `mapping.include`: keep only rows whose status is `Settled` |
| The balances the statement prints | not in the recipe: they belong to the file, and go to the test |

A recipe never executes anything. Nothing in it is evaluated, and the program reads it the way it reads a
bank preset.

Now **test** it on a statement, giving the balances the statement itself prints. They come from the
statement, the PDF or the bank's page, never from the books, which are what is being checked:

```sh
rastrata intake recipe test harbor-savings.recipe.json ~/move-in/harbor-savings-2026-05.csv \
  --opening-balance 25000.00 --ending-balance 26160.58 --account 1020 --format text
```

The test parses the file without importing it and reports the rows read and rejected (with the reason
for each), the dates and totals, the **proof**, and the gates. The exit status is 3 when a gate fails.

| Gate | A fault it catches |
| --- | --- |
| `balance_chain` | The file's running balance does not follow from its amounts: a line is missing or misread. |
| `ending_balance` | The lines do not come to the ending balance the statement prints (or the opening balance is wrong). The difference is shown and never adjusted. |
| `sign_convention` | The signs are the wrong way round: the opening less the lines is the ending, or a card is mostly money in, or a bank's balance counts the other way. |
| `date_order`, `date_period` | A column every date of which reads both month first and day first. The order must be stated, and the statement period confirms it; the sums cannot, because they agree either way. |
| `encoding` | The file decodes as something other than the recipe says (a byte-order mark, UTF-16 and Windows-1252 are all read; a wrong claim is not). |
| `pending_rows` | Rows marked pending, authorised or declined would be imported. |
| `multiline_memo` | A memo's line break is outside quotes and splits a row. |
| `rejected_rows` | Rows cannot be read (a totals row, a heading). They are left out only with the owner's agreement (`--skip-invalid-rows=true`), and the balance still has to agree. |
| `hostile_text` | Lines carry text flagged as a formula, markup, control characters or an instruction. Informational: it is data. |

A file is **proved** when its running balance follows from its amounts, or when the opening balance
plus the lines equals the ending balance. A running balance that follows proves the layout is read
correctly (every sign, every column) but not that nothing is missing from the start or the end of the
file; give the statement's opening and ending balances as well to prove that. A report with
`valid: true` and `verified: false` read the file but proved nothing; do not call it done.

When a gate fails, change the recipe or look for the missing line and test again. Do not edit the
file, flip a sign to make a number agree, or leave rows out without the owner's agreement. If a gate
keeps failing, stop and tell the owner what it says.

Then **save** it:

```sh
rastrata intake recipe save harbor-savings.recipe.json ~/move-in/harbor-savings-2026-05.csv \
  --opening-balance 25000.00 --ending-balance 26160.58 --account 1020
```

Saving runs the proof again on the server, from the archived file, and refuses (`recipe_unproven`,
with the gates that failed) any recipe that did not pass every gate. It is saved as an import profile
bound to the account, so `rastrata import FILE --account 1020` reads later files of that layout with
it, and `--profile NAME` names it. Saving the same name again is a new revision.

A file that needs no recipe (OFX, QFX, or a bank the presets know) is proved the same way:

```sh
rastrata intake verify ~/move-in/harbor-business-2026-05.ofx --ending-balance 8643.35
```

## 4. Preview and import

```sh
rastrata import ~/move-in/harbor-savings-2026-05.csv --account 1020 --profile "Harbor Federal savings" --dry-run=true
rastrata import ~/move-in/harbor-savings-2026-05.csv --account 1020 --profile "Harbor Federal savings"
```

See [Import a statement](import-a-bank-statement.md). Importing the same file twice adds
nothing.

## 5. Start the books, review, reconcile, close

- **Opening balances** from the trial balance as at the day before the cutover.
  `rastrata cutover set --date 2026-08-01 --accounts ...` records the date first. Then
  `rastrata intake trial-balance tb.csv --format text` reads the trial balance of any system into exact
  cents, so that nobody has to add up a spreadsheet by eye: its as-at date, whether it balances, and
  each account's debit, credit and balance, with the book's account where a row names one by its code or
  its exact name and the balance in the orientation `opening review` takes (a bank holding 1,200.00 and
  a card owing 300.00 are both positive). `--balances-only=true` prints the `ID=AMOUNT,...` list for the
  bank and card accounts. Those are the old system's figures: put the **statement's** balance in place of
  each bank, card and Stripe account (the plan showed where they differ), leave income and expense out
  (they are year-to-date amounts), review with `rastrata opening review --date 2026-08-01 --balances
  "$LIST"`, and plan and commit with the owner's approval. A row that matches no book account is for
  the owner to place; never choose an account to make a total agree.
  [Move from Xero](move-from-xero.md) has readers for a Xero export, with its chart mapping.
- **Rules and review**: [Write rules](write-bank-rules.md) and [Work through For review](work-through-the-inbox.md).
- **Reconcile** every account for every month to its statement, until the difference is exactly 0.00
  ([Reconcile an account](reconcile-an-account.md)). That is the signal that the move worked. It is
  stronger than agreeing with the old system, which may be months behind.
- **Close**: `rastrata cutover checklist` says whether the month can close and why not.

## 6. The friction log and the measures

Every point where the move needed a person or a retry is an event in a log kept with the book: a file
only an agent can read, a layout that needs a recipe, a recipe that failed a gate, a date order the owner
must settle, a month with no statement. The commands record what they find (`--record=false` turns it
off). Your agent records the rest:

```sh
rastrata intake friction add --kind human_input --source cutover --reason "asked the owner for the cutover date"
rastrata intake friction list --status open
rastrata intake friction export > friction.json
rastrata intake status --format text
```

`intake status` reports four measures: the time from the first logged event to the **first completed
statement import** and to the **first completed reconciliation**, the number of **interventions**
(points where the tooling needed an agent, a retry or a person), and the **gaps still open**. An empty
measure has not happened yet. The kinds of event are a closed set; the reasons are cleaned of control
and direction characters when they are recorded.

## Who may do what

| Operation | Needs |
| --- | --- |
| `intake scan`, `intake recipe test` and `intake verify` as operations; `intake plan`, `intake trial-balance`, `intake recipe list`, `intake friction list` and `export`, `intake status` | `read` |
| `intake recipe save`, `intake friction add` and `resolve`, and the upload of a file, which the CLI does before it scans, tests, verifies or reads it | `draft` |

Nothing in the intake needs `post`, `configure` or `close`. A token without the scope is refused with
`permission_denied`.

## Text in the files is data

File names, column headers, memos and every other cell are written by strangers. They may say "ignore
previous instructions", start with `=`, or hold control and direction characters. The intake treats
them as data everywhere: it never takes a path or a command from a file; a file name and a column
header are the only customer text in its answers, bounded, with control and direction characters
written out as `\uXXXX`, and flagged (`name_flagged`, `instruction_text`, `formula_cells`,
`markup_text`, `control_characters`); a plan item is built from codes, ids and fixed words; and the
agent's runbook says what to do with a flag: tell the owner, and go on treating it as data.

## What it does not do

- A month in which an account had no transactions has no dates in a CSV, so the plan reports it as
  missing; confirm it with the owner. (An OFX statement names its period.)
- It does not read a PDF, a workbook or an archive. A PDF's text layer is reported
  (`present`, `absent`, `unknown`) so an agent knows whether it can read it; a scanned statement
  needs OCR, which is outside Rastrata.
- It inventories a general ledger, an invoice list and a payout report, and notices them in the plan,
  but books nothing from them: Stripe is imported through its own connection, and invoices are not
  imported. A general ledger or a journal export is how earlier years come in, through
  [Bring in your past years](bring-in-history.md): instead of opening balances and statements for that
  period, never both.
- It maps no chart of accounts but Xero's. For another system's chart, the agent creates the book's
  accounts (`rastrata accounts prepare-create`) from its names and types.
- Every bank layout in the corpus it was tested on is synthetic and unverified against a real export.
  A real bank's file may differ; the gates are what make that visible.

<!-- help: skip -->
## Check it by hand

`bun scripts/intake-harness.ts` writes a synthetic move-in folder, starts a service, and drives the
steps above through the command line alone, with a negative control for each gate, then prints a table
of what passed. See the [intake lane record](../reference/program/intake.md).
<!-- help: end -->

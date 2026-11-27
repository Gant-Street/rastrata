# Move from Xero to Rastrata

This guide moves a real business from Xero onto Rastrata and proves the move. It is for the owner,
or for an agent working for the owner.
<!-- help: skip -->
Rastrata books and reports; it does not file anything and it
is not tax advice.
<!-- help: end -->

**What proves the move is not that Rastrata agrees with Xero.** A small business is often months
behind on reconciling, and a ledger that is stale cannot be the yardstick. What proves it is that
every bank, card and Stripe balance reconciles to its own statement at exactly 0.00, month after
month. Xero is a second check, and only for the periods and accounts in which Xero was itself
reconciled. The rest is marked "not comparable", and every difference found is either explained to
the cent or logged as a gap until a person has looked at it.

Xero is never changed. Nothing here writes to it, and nothing needs its login.

Moving from another system, or having your own agent do the reading of the files? See [Move to Rastrata with your own agent](move-in-with-your-agent.md), which works for any old system.

## Two ways to move

**Bring every entry across.** Every journal Xero holds comes into Rastrata dated as it was, year by year, each
year tied to Xero's trial balance at its last day, and your books run from the day the business started. This is
the move for a business that wants its whole history in one place. It needs three exports from Xero and a book with
no entries yet:

| What | Where in Xero | Notes |
| --- | --- | --- |
| The chart of accounts | Accounting, Advanced, Chart of accounts, Export | Import it first (Settings, Bring in your books, Import from Xero): the kind of each account (asset, liability, equity, income, expense) comes from Xero's types, and an account you map to one of the book's stays mapped. |
| The Journal Report, one fiscal year at a time | Reporting, All reports, Journal Report (under Taxes and balances), set the date range to the year, Export, Excel | Xero's reports export as PDF, Excel or Google Sheets, never CSV; the Excel file is read as it comes. One file a year keeps each under the size a workspace takes in one go. Bring the years in oldest first: an account that first appears in a later year is added then, open from that year's first day. |
| The Trial Balance at the last day of each year | Reporting, All reports, Trial Balance, set the date, Export, Excel | The proof: Settings, Bring in your books, Bring in history, Compare with your old books. |

Then **Settings, Bring in your books, Bring in history**: choose the first year's journal file, say for each account the book lacks what
kind it is (Xero's type is suggested), import, compare with the trial balance at that year's end, close the year
([Close a fiscal year](close-a-fiscal-year.md)), and go on to the next year. The whole path is in [Bring in your
past years](bring-in-history.md). Xero's unreconciled bank lines are not journals and do not come across: from the
last day each account was reconciled in Xero, its statements come into Rastrata as [statement files](import-a-bank-statement.md)
or through the bank connection, starting the day after that account's last reconciled line (a line in both would be
counted twice).

**Start from a date.** The books begin on a day of your choosing, with Xero's trial balance for the day before as
the opening balances, and the earlier years stay in Xero. This is the move for a business that wants a clean start
and a short tie-out. Everything below is that way.

Everything below is done with commands, and the same steps are on screen: **Import from Xero**
(`/xero`) for the chart, the trial balance, the account transactions and where Xero was reconciled,
**Compare with Xero** (`/tie-out`) for the comparison, and **Things to check** (`/gaps`), the three steps of
**Settings, Bring in your books**, under **Moving from Xero**. Each file is read and shown before anything is kept.

## Before you start

You need a book set up on Rastrata with a chart of accounts
([Set up your books](set-up-your-books.md)), and from Xero:

| What | Where in Xero | Used for |
| --- | --- | --- |
| The chart of accounts | Accounting, Chart of accounts, Export (the CSV of the import template) | Mapping Xero's accounts onto the book's |
| A trial balance as at the day before the start date | Reporting, Trial Balance, set the date, Export, CSV | The opening balances |
| A trial balance at each month end after the start date | the same report | The tie-out |
| Account Transactions for each month after the start date (all accounts, one month, CSV) | Reporting, Account Transactions, Export, CSV | The tie-out's line by line explanations |
| The date each bank and card account was reconciled through in Xero | Accounting, Bank accounts, Reconcile | Where Xero can be trusted |

From each bank, card and Stripe account you need its statement for the day before the start date
and for each month after.

Save the files to a folder outside the repository. They hold the whole business: do not paste or
send them anywhere.

Each request Rastrata takes carries about 120,000 characters, so export one month of account
transactions at a time. A chart or a trial balance is a few thousand characters.

## The first time, with your own files

The readers were written from Xero's documentation, so the first real export of each kind is a
check, not a formality. Do this once, before you rely on anything:

1. **Save each export to a folder outside the repository.** If Xero offers a report only as Excel,
   open it and save it as CSV (UTF-8) without changing anything in it.
2. **Preview before you keep.** Every file is read and shown first, on screen (`/xero`) or with the
   command without `--import`, and nothing is stored until you say so. Read three things: the
   columns it found (the disclosure "How the columns were read" under the file on screen, or the
   `Columns read:` line that starts the command's text output; a header you expected that is missing is
   the most likely difference), the problems it lists (each on its row), and the dates it read (a US
   organization writes 03/04/2026 as March 4: say so with `--date-order mdy`, or choose "Month first"
   on the screen).
3. **Check the totals the file prints against what was read.** A trial balance must balance on every
   column, and each account block of Account Transactions must add up to its Total row; a file
   where they do not is missing rows and is refused. Export it again; do not edit it.
4. **Do the chart first**, then the trial balance as at the day before the start date, then one month of
   account transactions. Each step uses the one before.
5. **If a file does not read**, do not paste it anywhere. The preview's problem codes and the names of
   the columns it found carry no business data, and a fix is made against a made-up file of the same
   shape. The title lines of an export carry the organization's name: leave those out of anything you
   share.

When Xero has not been kept up to date, most months will compare as "not comparable": the tie-out
only trusts Xero through the date it was reconciled, and says so. That is the right answer, not a
failure. The proof of the move is the statements.

## 1. Choose the start date

The start date is the first day of the new books. It is usually the first day of a month: the day
after a month end for which you will have statements. On the screen it starts as the day your books
begin; change it only if you leave Xero later than that. Record it, naming the accounts that have
statements, so that earlier bank history is set aside in For review (visibly, and restorable) and
each account's imports start on the start date:

```sh
rastrata cutover set --date 2026-08-01 --accounts 1000,1010,2000
```

## 2. Map Xero's chart onto the book's

```sh
rastrata xero chart --file chart.csv --format text
```

The preview reads the file without changing anything. For each Xero account it says which account
of the book it would be, and how sure it is:

- **certain**: you chose it, or the code and the name are both the same;
- **likely**: the name is the same, whatever the code, in the same kind of account (a Xero credit
  card is a "Bank" account there and a liability here, and that is understood);
- **check**: only a code or a similar name; it is shown as a possibility and never applied;
- **none**: nothing in the book resembles it. For these the preview suggests what to create from
  Xero's type and the chart templates (so Stripe fees keep the role key the Stripe connection finds
  them by).

Codes mean different things in different charts, so a name is the stronger evidence. Read the list,
then save what you accept, and decide the rest:

```sh
rastrata xero chart --file chart.csv --import --accept likely --map 820=2500 --skip 999
```

`--map CODE=ACCOUNT` maps a Xero account to an account of the book (by its id or code). `--skip CODE`
leaves a Xero account out on purpose. Several Xero accounts may be mapped to one account of the
book. Change a decision later with `rastrata xero mapping set`, and see where it stands with
`rastrata xero status`. A new export of the chart keeps every decision.

## 3. Start the books from opening balances

Take the Xero trial balance as at the day before the start date:

```sh
rastrata xero trial-balance --file tb-july.csv --format text
```

It shows each account's balance in the way the book reads it (a bank holding 1,200.00 and a card
owing 300.00 are both positive) and says what it left out and why:

- income and expense balances, which are year-to-date amounts and would show in the month the
  start date falls in (add `--include-profit-loss` to carry them);
- Xero's retained earnings, and any Xero account you have not mapped: the offset account carries
  what the balances do not explain, and the preview says how much that is;
- anything on a trial balance that does not balance, which is refused: a trial balance always
  balances, so rows are missing.

**Xero's bank balances are Xero's books, not the banks' statements.** For every bank, card and
Stripe account, replace the balance with the statement balance at the end of the day before the
start date. That is the number the reconciliation will prove. `--balances-only` prints the balances
in the form `opening review` takes, and `--statement ID=AMOUNT,...` puts each statement balance in
place of Xero's. Then review and post:

```sh
BALANCES=$(rastrata xero trial-balance --file tb-july.csv --balances-only --statement 1000=12000.00,2000=523.10)
rastrata opening review --date 2026-08-01 --balances "$BALANCES"
rastrata opening plan   --date 2026-08-01 --balances "$BALANCES"
rastrata operations commit PLAN_ID PLAN_HASH
```

The review shows the exact entry, with the calculated offset, before anything posts, and the date it
will carry: the day before the start date, because the balances are those at the start of the
first day (the start date itself when the book begins that day). If you already entered opening
balances by hand against Opening balance equity, dated before the start date, the review says so and
offers no second entry, since the balances would count twice.
<!-- help: skip -->
See the [lane record](../reference/program/shadow.md) for what each check means.
<!-- help: end -->

## 4. Import the statements and reconcile

From the start date on, work as you would on any month: import each statement
([Import a statement](import-a-bank-statement.md)), work through For review
([Work through For review](work-through-the-inbox.md)), and reconcile each account to its statement
until it closes at exactly 0.00 ([Reconcile an account](reconcile-an-account.md)). Then ask:

```sh
rastrata cutover checklist --format text
```

It says whether the month can close, and why not if it cannot. Two month ends closed and reconciled
is the shadow run: after it, Rastrata has proven the move on its own evidence.

## 5. Compare with Xero where Xero was reconciled

For each month after the start date, give Rastrata what Xero says:

```sh
rastrata xero trial-balance --file tb-august.csv --import
rastrata xero transactions --file at-august.csv --date-order mdy --import
rastrata xero reconciled --set 090=2026-08-31,091=2026-08-31
```

`--date-order mdy` is for a US organization: a date like 03/04/2026 is March 4 there, and the file
cannot say so itself unless a day is above 12. Previewing a file first (the same command without
`--import`) shows how it was read, row by row, and what could not be read. Running Balance, Gross
and tax columns are ignored: Xero's running balance is not reliable, so every figure comes from the
Debit and Credit columns.

Then:

```sh
rastrata xero tie-out --format text
```

For each account in each period it says one of three things:

- **matches**: the same figure in both books, to the cent;
- **differs**: and then which lines are in one book and not the other (paired by exact amount, a few
  days apart at most), plus what the two books already disagreed about when the period began, so the
  difference is the sum of things a person can look at. If lines do not account for all of it, the
  rest is said to be unexplained;
- **not comparable**: and why. Most often it is that Xero's bank accounts were not all reconciled
  through the end of the period, or the account has nothing mapped to it, or nothing from Xero
  covers the period.

A cash-basis book differs from Xero's accrual figures by the unpaid invoices and bills: the report
says so.

## 6. Keep a list of things to check and close it

```sh
rastrata xero tie-out --record
rastrata gaps list --format text
rastrata gaps close 7 --resolution "Xero entered the same fee twice; Rastrata is right (statement line 14)"
```

Recording adds each difference to Things to check once: running it again adds only what is new and
never reopens a gap that was closed. You can add your own (`rastrata gaps add --title ...`) for
anything you find that is not yet right, such as something Xero did that Rastrata does not. A gap
is closed only with a note saying what was found, and it stays in the log with who closed it.

The move is done when two months are reconciled to their statements, the checklist says they can
close, and no gap is open.

## When something does not read

- **"No header row was found"**: the file is not the export it was taken for, or it is not CSV.
  Previewing shows the columns that were found; the readers look in the first 20 to 40 rows.
- **"Every date in the file reads both as month-first and as day-first"**: say `--date-order mdy`
  or `dmy`.
- **"The columns do not balance"**: a trial balance that does not balance is missing rows. Export
  it again; do not edit it.
- **"A row is missing or was left out"** on a transaction block: the block's lines do not add up to
  the Total row Xero printed, so a row was lost. Export that month again.
- **A file with unreadable rows** is refused unless you add `--skip-unreadable`; the rows left out
  are listed in the preview.
- **A line differs and the descriptions look alike**: lines pair by exact amount within a few days
  (`--tolerance N` changes the days). A bank fee that Xero dated on the statement date and Rastrata
  on the transaction date still pairs.

## What the files look like

Xero documents the chart of accounts import template: `*Code, *Name, *Type, *Tax Code`, and
optionally `Description, Dashboard, Expense Claims, Enable Payments, Balance` (a code is up to 10
characters, a name up to 150; `Type` is one of Xero's account types). The Trial Balance report has
Debit, Credit, YTD Debit and YTD Credit columns, under title lines and with a Total row. The Account
Transactions report has a block for each account under the columns `Date, Source, Description,
Reference, Debit, Credit, Running Balance, Gross` and a tax column. The readers find the header and
read columns by name, so a column more or less, or another order, does not matter; what they cannot
read they say.

Sources: Xero Central, "Import a chart of accounts" and "Account Transactions report"; Xero's
description of the Trial Balance report. The Running Balance behavior is described by Xero's own
community manager in the Xero Product Ideas thread "Account Transactions Report - Running Balance
calculation".

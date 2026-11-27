# How the statements are built

For anyone who wants to know why a figure in Rastrata can be trusted, or who is changing the code that
produces it. To read the statements, see [Read your financial statements](../how-to/read-financial-statements.md).
The code is in `packages/application/src/reports/`; the screen is `apps/web/src/routes/reports.tsx`
over the components in `packages/ui/src/reports/`.

## A statement is a function of four things

Every statement is computed from the kernel's immutable journals and from nothing else:

1. one **book revision** (the state of the book at a point in its history),
2. a **date range** (and an as-of date),
3. the **basis** the book is kept on, and
4. for the cash flow only, the **account tags** in force.

Nothing in a statement is stored. Compile the same inputs twice and you get the same figures byte for
byte; change one input and the figures, and the fingerprint described next, change.

Money never leaves integer cents. The compiler sums postings as `bigint` cents, never a number, a
decimal library or a tolerance; a figure is a string with exactly two decimals on every wire. The
browser formats it with `BigInt` and `Intl`, so a sixteen-digit figure shows as it was stored.

## The population hash

Each report carries a **population hash**: a SHA-256 over the compiler version, the book's id, the
book state's own hash, the chart in force on the date, the revision and posting sequence, the basis,
the as-of date, the start of the range and the dates of the fiscal year. It answers "what exactly was
this built from?". A comparison column carries the hash its range would have on its own, and asking
for a comparison never changes the current column's hash. The cash flow adds the hash of the account
tag map to the ledger population it is built from, so changing a tag changes it. The version string
(`rastrata-core-report-v2`, `rastrata-cash-flow-v2`) is part of every hash, so a figure produced by a
different algorithm is never mistaken for a reproduction.

On screen the hash is not part of the figures a person reads: it is under **Report details** at the foot of a
report, a fold that says only its name until it is opened; inside are the book revision and the hash, with a
Copy button on its row. A printed report and the CSV file carry it too, and a report laid out by month lists
the hash of each of its columns.

The hash is how drill-through stays honest. Opening the activity behind an amount passes the report's
as-of date, range start and hash; the service rebuilds the hash from the current book and refuses
(`report_population_changed`) when they differ, so an account's lines are never shown under a report
they do not belong to. A period close records the hash of the report it closed on.

### Current book, not a pinned revision

The screen, and every call that omits `revision`, reads the **current** book with an as-of date.
Reading an older revision replays the ledger to that point, which costs about a millisecond an entry for
a book made since 2026-10-07 and was quadratic in the number of journals before (see [the scale limit](../reference/program/main.md#the-scale-limit-and-what-we-do-about-it)).
So a pinned read is for callers that must reproduce an old report exactly (an agent verifying a
close, `rastrata reports --revision N`), and `activity.get` takes `revision` only as an option. The
price of reading the current book is that a report on screen can be older than the book; the page
says so when it finds out (a drill-through or a download) and offers to read it again, instead of
showing an old number as current.

### Reading again without moving the page

Changing the dates reads the statement again. The screen keeps the figures it has, marked busy
(`aria-busy`, and after a fifth of a second the accent colour sweeps along the statement's top
rule), and swaps the new ones in place, so the
picker, the tabs and the pager keep the focus a person has. It reads through plain signals
(`apps/web/src/loader.ts`) and not `createResource`: a resource that is read while it loads
suspends the router's boundary, which detaches the whole page and drops focus. Each read is keyed by
its request. The three statements of one population share one read, so moving between the profit and
loss, the balance sheet and the trial balance asks the service nothing, and an answer that arrives
after a newer question is ignored, so a slow read of February can never replace November.

## Fiscal years come from the periods

A book's periods carry a fiscal year and dates. The compiler groups the regular periods by fiscal
year and takes the first start and last end of each, so a year that starts in October, a quarterly
book and a calendar extended later all work without a year written into the code. A date no period
covers fails with `calendar_not_configured` (409), naming the date and the range the calendar does
cover. Adjustment periods lie inside regular ones and never define where a year starts or ends.

## Earnings roll forward by computation

Rastrata does **not** post closing entries. The balance sheet's equity is the book's equity accounts
(contributed capital, draws) plus two calculated lines:

- *retained earnings from earlier fiscal years*: every income and expense posting before the start of
  the fiscal year the date is in, and
- *earnings this fiscal year to date*: the same, from the start of the year to the date.

The trial balance shows income and expense accounts for the fiscal year to date and adds one
calculated line for earlier years' earnings, so it still balances. The profit and loss of any year or
range can therefore be reproduced from the postings alone, with no synthetic journal in the book.

The trade-off, which the launch plan weighs against GnuCash's closing entries, is that a close does
not move earnings into an account: the lock date is the close. A book that already contains a
`closing` journal is refused (`closing_entries_unsupported`) instead of being read wrongly. An account
that carries an income or expense balance across a year boundary starts the new year at zero in the
ledger views, which is what makes the lines behind a statement amount add up to it.

## Basis

A report is labelled with the book's own basis, the kernel's `primaryBasis`, fixed when the book is
created. The other basis is refused with `basis_unavailable` and a reason. Converting a cash-basis
book to accrual needs the receivables, payables and accruals it never recorded; converting an
accrual book to cash needs the date each was settled. Both need open items, which arrive with
invoicing, and the launch plan defers them. Nothing is approximated.

## Comparatives

A range of whole calendar months is compared with the same number of months before it; any other range
with the same number of days immediately before it; the previous-year comparison moves both ends back
twelve months and keeps an end-of-month end at the end of that month (February 29 against February
28). A comparison that would start before the calendar is a warning, never a column of zeros.

## Shares of income

Asked for with `share: "income"`, every row and total of the profit and loss also carries its share of the
period's total income, and of the comparison period's against that period's own income. A share is a
function of figures the report already has, so it is not part of the population: the same report with and
without shares has one hash, and a report that is not asked for a share is byte for byte what it was.

The arithmetic is on integers. An amount is cents in a `bigint`; its share in tenths of a percent is the
amount times 1,000 over the income, rounded to a whole number of tenths with a tie going away from zero (0.25%
is 0.3% and −0.25% is −0.3%), and written as text with one decimal. There is no division of a floating-point
number anywhere, so the result is exact at any size, which a float is not: 9,994,999,999,999,999.99 of
9,999,999,999,999,999.99 is 99.9%, one cent short of the tie, and a float calls it 100.0%. A period whose
income is zero or less has no share to take: its lines carry none and the report carries a warning that says
so, rather than a share of nothing.

## The cash flow

The indirect statement rests on one identity. Every journal balances, so over any range the changes
of all accounts sum to zero, and therefore

> change in cash = net income - (the ledger-signed changes of every other balance-sheet account).

Each of those changes goes to exactly one section, chosen by the account's **cash-flow tag**
(`cash`, `operating`, `investing`, `financing`, `noncash`, read through `readAccountTags`), so the
sections add up to the change in the accounts tagged cash with no residual. `noncash` accounts
(accumulated depreciation) are an add-back inside operating, and `operating` accounts are working
capital. An account that moved and has no tag is shown under **Not classified**, flagged and
warned about; it must be somewhere for the arithmetic to hold, and it is never guessed into a
section. With no account tagged cash there is nothing to tie to, so the statement says why and shows
nothing. A tag on an income or expense account has no effect (net income already carries them) and is
reported as such. A recorded tag revision (`tagsRevision`) pins the tags so a report reproduces after
tags change. Gains and losses on disposals stay in net income and the asset's whole change is shown
under investing; an accountant may present them differently.

The opening entry is the position the books start from, not activity. The entry the opening tools
post (its source id starts `opening-`) and any correction of it are taken out of every change in a
range that contains them. The tools date the entry the day before the cutover, so a statement that
starts on the cutover date never contains it, and its cash at the start of the period is the
opening cash. When the cutover is the first day of the book's calendar there is no day before, the
entry is dated that day, and it falls inside the first range: the statement then holds the opening
cash in the cash at the start of the period, no opening profit and loss in net income, and no
Opening balance equity line under financing, and a warning (`opening_position`) says so.

## Checks the compiler makes on itself

A statement is refused rather than shown if it does not hold: the trial balance must balance and
assets must equal liabilities plus equity (`report_does_not_tie`); the cash flow must tie to the cash
accounts; and whenever a report includes every journal of the book, its per-account totals are
compared with the book's balances worked out from its revisions the way the kernel works them out
(`report_integrity_failure`). The service works those balances out as it replays the ledger, one
revision at a time, so a report never has to go back over the whole book for them; the kernel's own
function, which re-reads every revision and re-checks every hash and link, is what a full
verification (the backup verification, `rastrata verify`, the restore drill) compares them with, and
the tests compare them with it at every step of random books. The lane record says in plain words
what that does and does not guard
([hostread](../reference/program/hosting/hostread.md), "What 'independently rebuilt' means now").
The screen also checks the accounting equation and the cash tie again in the browser with exact cents. It
says nothing while they hold (the totals of the statement already show it, and the cash flow ends with the
cash it started and ended with), and says so at the top, with the difference, if either ever disagreed.

## Text from the book is data

Account names, narrations and book names are attacker-controlled. In a CSV file every text cell that
begins with `=`, `+`, `-`, `@`, a tab or a line break gets a leading quote, so a spreadsheet opens it
as text; a money cell is validated to be a plain decimal and written as it is, so negative figures
stay numbers; the file name is built only from fixed words and validated dates. On screen the same
text is plain text, never markup. The CSV is rendered once, in `reports/csv.ts`, and the command line
and the browser both print that file.

## What it costs

The compiler works on a verified state that the service has already read. A book state is almost
always the state before it plus one command, so the compiler keeps what it works out from a book (its
journals in date order, every account's postings added up by date, the chart in force over time, the
opening entry and the kernel's balances to check against) and carries it from one state to the next
by the revisions between them (`reports/ledger.ts`; the lane record is
[hostread](../reference/program/hosting/hostread.md)). The first report on a book in a process builds
all of it, which costs the book and nothing like the kernel's rebuild of its balances: 3 ms at a
thousand journals, about 10 ms at 5,000 and 45 ms at 20,000, because the replay that precedes it has
carried the balances along. Every report after that costs the posting, not the book. Measured with
`N=5000 bun packages/application/bench/reads.ts` (the time from a posting being committed to the
report being answered, in process, on a laptop shared with four other agents) and, for the first
column, with `bench/cold-load.ts` (a fresh process that replays a copy of the book file):

| Journals | First report after the book is opened | A report after one more posting | Seven reports (Home) after one more posting |
| ---: | ---: | ---: | ---: |
| 1,000 | 3 ms | 2 ms | 4 ms |
| 5,000 | 10 ms | 2 ms | 4 ms |
| 20,000 | 45 ms | 2 ms | 3 ms |

Before 2026-10-08 the second column was 39 ms, 203 ms and 708 ms, and the third 40, 269 and 892: the
kernel's balances were rebuilt from every revision of the book for every new state (35 microseconds
a revision, 93% of the time), and every report walked every posting of the book. The first column
was 35 ms, 170 ms and 720 to 790 ms until the balances were carried through the replay: one block of
the event loop, which on a server that holds many books stalled the others. The ledger replay that
precedes the first read is the kernel's and linear for a book made since 2026-10-07 (0.7 s at a
thousand journals on a quiet machine, 17 to 19 s at 20,000); `bench/reports.ts` times the statements
alone, once the state is in hand.

## What is not done

- Converting between bases, until invoicing brings open items.
- Several currencies in one report; a book has one currency (USD, EUR or GBP) and says which.
- Budgets, segments and classes, and statements of changes in equity.
- Server-side PDF: "Print or save as PDF" uses the browser's own print, with a print stylesheet that
  produces a plain ink-on-white page.
- Tax advice or any filing: a statement is a bookkeeping report.

# Read your financial statements

For anyone who keeps books in Rastrata and wants to see how the business is doing: choose the
dates, read each statement, lay it out by month, follow a figure back to the entries behind it, and
take a copy to a spreadsheet, a printer or an accountant.
<!-- help: skip -->
How the figures are built, and why they can
be trusted, is in [How the statements are built](../explanation/financial-statements.md).

Rastrata books and reports. It does not give tax advice, file anything or predict. A statement is a
bookkeeping report; which method, which year or which line a tax return uses is a question for your
tax adviser or the IRS instructions.
<!-- help: end -->

## Open Reports and choose the dates

Open **Reports** in the main navigation. It is a list of every report in three groups: **Statements**
(Profit and loss, Balance sheet, Cash flow), **Detail** (Trial balance, General ledger, Money by payee)
and **Tax time**. Choose one and it opens as its own page: its name, one row of choices (**Date range**,
**Compare**, **View** and **Export**) and then the table, so the
first figures are on screen without scrolling. **Reports** in the bar returns to the list, and the next
report you open keeps the dates and the comparison you were reading.

A statement opens on the **fiscal year to date**: from the first day of
the fiscal year the book is in, to today. If today is outside the book's fiscal calendar, the page
shows the nearest whole fiscal year instead. The line above the table says what you are looking at:
the statement, the book, the dates and the basis ("Willow Lane Studio · Jan 1 to Oct 4, 2026 · Cash
basis").

**Date range** offers the periods a bookkeeper asks for:

- **This month** and **Last month**.
- **This quarter** and **Last quarter**. A quarter is three months of the book's own fiscal year, so a
  book whose year starts in October has October to December as its first quarter.
- **This fiscal year to date**, the default, and **Last fiscal year**.
- **Custom**, which shows **From** and **To**, started on the dates you were looking at. A date that is
  not real, a start after the end, or a date outside the book's calendar is named in plain words beside
  the field, and nothing is requested until the dates are usable.

A period that the book's calendar does not reach (a month before the books began, "Last fiscal year" in
the first year) is listed and says "not in this book's calendar". To read any other month, choose
**Custom** and type its first and last day.

The statement, the dates, the comparison, how the figures are laid out, whether amounts are shown as a
share of income and the page of the general ledger are kept in the address of the page. Copy the link, reload, or press Back, and you land on the
same figures. A link made by an older version, with `period=month:2026-03`, still opens that month.

Changing the dates, the comparison or the page reads the figures again. The figures on screen stay
where they are, and the heavy rule at the top of the statement sweeps with colour if the read is
slow, until the new ones arrive. Nothing around them moves and the control you were using keeps the
keyboard focus, so you can go on from where you were.

## Compare two periods

**Compare** adds a second column and a **Change** column to the profit and loss, the balance sheet and
the cash flow:

- **Previous period** compares a range of whole months with the same number of months before it
  (March with February, a quarter with the quarter before, a year with the year before). Any other
  range is compared with the same number of days immediately before it.
- **Previous year** moves both ends back twelve months. February 29 compares with the end of February.

A comparison that would start before the book's first fiscal period is not shown as a column of
zeros. The page says there is nothing to compare with.

Each comparison column is exactly the report that range would give on its own, and asking for a
comparison never changes the figures in the current column.

## See each amount as a share of income

**% of income** is a choice in **View**, beside Export, on the profit and loss. Turn
it on and each amount is followed by a column that says what share of total income it is, to one decimal: advertising of
1,510.00 on income of 5,000.00 reads "1,510.00" and then "30.2%". It answers questions such as "what
share of my income went to advertising?" and "how much of each dollar I earned did I keep?".

- **How it is worked out.** The share of an amount is the amount divided by **total income** for the same
  dates, as a percentage rounded to one decimal. A tie goes away from zero, on both sides: 0.25% is
  0.3% and −0.25% is −0.3%. It is worked out from whole cents, never from a floating-point number, so it
  is exact at any size. The page does not work it out: it shows the figure the books made, and an agent or
  a script asks for the same figure (`share` set to `income`) instead of dividing.
- **Total income** is the "Total income" line of the same report, the accounts of type income, and it is
  always 100.0%. Gains are lines of their own, not income here, and are shown as a share of income like any
  other line, so "Total income and gains" can be a little over 100.0%.
- **Expenses are positive shares of income**, and **net income** is the share that was kept: 53.4% means
  that 53.4 cents of each dollar of income were left after the expenses. When the books lost money it is
  negative: a loss of 1,470.00 on income of 5,000.00 is −29.4%. A refund into an expense account gives that
  account a negative share.
- **With Compare**, each period has a share column of its own, divided by its own period's income. Last
  March's advertising is a share of last March's income, not of this March's, so a change in what you spent
  and a change in what you earned are not mixed up.
- **When there is no income** (nothing was earned in the dates, or refunds outran sales) there is nothing to
  take a share of. The column stays, every cell shows a dash, and the page says "No income to compare
  with". The amounts are as they were. Choose dates that include income to see the shares.
- **Months in columns and shares do not combine**, because a share for each month would double the
  columns. Choosing one in **View** takes the tick off the other.
- **The address keeps it** (`share=income`), so a link reproduces the view, and it stays when you go to
  another statement and come back. Only the profit and loss has income to take a share of; the other
  statements do not offer it.
- **The file has the same figures.** **Download CSV** adds a "% of income" column beside the amount, and
  with Compare a "Comparative % of income" column beside the comparison. When a period has no income the
  columns are there and empty, and a `Warning` line under the table says why. The share cells are plain
  numbers with one decimal (`30.2`, `-29.4`), so a spreadsheet can use them.

## Lay a statement out by month

**View**, then **By month**, gives a column for each calendar month the dates touch and a last column for
the whole range; choose it again for one column for the dates. It is offered for the profit and loss and
the balance sheet. A trial balance is a position on one day and a general ledger is a list of postings, so
neither has months, and they have no View.

- Every month is read from the same version of your books, so the columns agree with each other and with
  the total. The page checks that the months add up to the total and says so, in words, if they do not.
- A range that starts or ends inside a month shows that month as a column of its own dates ("Oct 1 to Oct
  5, 2026"). On the balance sheet each month shows the position at the end of the month, and a partial
  month the position on the last date.
- **Compare** and months in columns do not combine: with **By month** on, Compare is off and says
  why. Turn **By month** off to compare.
- The page shows up to 24 months at a time. A longer range says so and asks you to shorten it or show the
  total.
- A figure in a month's column opens the transactions of that month, in that month's version of the
  books.

## Read each statement

The row of tabs holds five statements. Above each table is a line that says what it is: the statement,
the book, the dates and the **basis** (cash or accrual), with a note beside the basis that explains it.

**Profit and loss.** Income, gains and expenses for the dates you chose, each group with its total,
then **net income**, the largest figure on the page. Accounts that had no activity are left out; choose
**Accounts with no activity** in **View** to bring them back.

**Balance sheet.** Assets, liabilities and equity as of the last date. The totals show the **accounting
equation**: total assets equal total liabilities and equity. The page says nothing about it while it
holds; if it ever did not, it would say so at the top with the difference and tell you not to rely on
the report. Two lines of equity are **calculated, not posted**: retained
earnings from earlier fiscal years, and earnings so far this fiscal year. Rastrata never posts a
closing entry; it works these out from the entries each time, so every year's profit and loss can
always be reproduced.

**Cash flow.** The indirect method for the dates you chose: net income, adjusted for non-cash items
and changes in working capital, then investing and financing, down to the **net change in cash**, then
the cash at the start and at the end of the period. They come from the accounts tagged **cash**; the
page checks that the start plus the change equals the end, and speaks only if it does not.

- An account that moved and has no cash-flow tag appears under **Not classified**, flagged "Needs a
  tag", with a warning. Rastrata never guesses where it belongs. Open **Accounts**, give it a
  cash-flow tag, and read the statement again.
- If no account is tagged cash, the statement is not shown and the page says why.
- Gains and losses on selling an asset stay inside net income, and the whole change in the asset is
  shown under investing. An accountant may present them differently.

**Trial balance.** Every account's debit or credit as of the last date, and the total: the two sides
are equal, and the page speaks only if they are not. Income and expense accounts show the fiscal year to date; the earnings
of earlier years appear as one calculated line so the two sides still balance.

**General ledger.** Every account with its opening balance, debits, credits and closing balance for
the dates you chose, then the postings themselves, grouped by account with a running balance, a
hundred lines to a page. An asset, liability or equity account carries its balance from the start of
the book; an income or expense account starts each fiscal year at zero, because the earnings of
earlier years are in retained earnings.

Negative figures are in parentheses, as on a printed statement, and are announced as "negative" by a
screen reader. Figures are exact to the cent; nothing is rounded or converted.

### Cash basis and accrual basis

The basis is set once, when the book is created, and every statement says which one it is on.
Rastrata cannot show a cash-basis book on the accrual basis or the other way round, because the
conversion needs records the book does not keep (the receivables and payables of an accrual book, or
the date each one was settled). A request for the other basis is refused with that reason rather than
approximated.

### Report details: the proof

Under each report is a closed line that says only **Report details**. Open it for the **book revision**,
the whole **fingerprint** (the population hash) with a **Copy** button on its row, the basis, the
currency and the fiscal year. The fingerprint is of
exactly what the report was built from: the book at that revision, the dates, the basis and, for the
cash flow, the account tags. The same books, dates and basis always give the same fingerprint, so anyone
can check that a report is the one that was made. The CSV file carries the same two facts, and a printed
report has them as one plain line at the foot. A report laid out by month lists the fingerprint of each
column too.

## Follow a figure to the entries behind it

Every amount that comes from an account is a link: it is underlined when you point at it, says "View
transactions" in a tooltip, and a screen reader hears where it goes. Choose it to open the **Account
activity** for that account and those dates: the balance before, each posting with a running balance, and
the balance after, which equals the figure you clicked. Choose a posting to open its **journal entry**,
which is checked against the report you came from. **Back to the report** returns to the same statement
and dates.

An amount in a comparison column opens the activity for the comparison dates, and an amount in a month's
column opens that month.

If the book changed after the report was read (an entry posted in another window, for instance), the
activity page says **The book has changed** and offers **Read the report again**. The report on
screen is older than the book, so it is not shown as current.

## Download or print a statement

**Export** opens a short list:

- **Download CSV** saves the statement you are looking at as a file for a spreadsheet or an
  accountant. It starts with the book, currency, basis, dates, book revision and population hash, so
  the file can be traced to the figures it came from. Text that a spreadsheet could run as a formula
  (a name beginning with `=`, `+`, `-` or `@`) is saved with a leading quote so it opens as text. The
  file is UTF-8 with a byte order mark, so accented names open correctly in Excel. The general ledger
  file holds every line, not one page. A report laid out by month downloads as it is on screen, one
  column for each month and the total, and says which dates and which fingerprint each column was read
  from. Dates in a file stay in the form `2026-03-31`: a file is data.
- **Print or save as PDF** prints the statement on a plain white page, in black ink, without the menu
  or controls, whatever theme the screen is in. Choose "Save as PDF" in the print dialog for a file.

If the book changed between the screen and the download, the page tells you the file is newer than
what is on screen.

## From the terminal and for an agent

```sh
rastrata reports calendar
rastrata reports profit-loss --as-of 2026-06-30
rastrata reports profit-loss --as-of 2026-06-30 --from 2026-04-01 --compare previous-year
rastrata reports profit-loss --as-of 2026-06-30 --share income
rastrata reports profit-loss --as-of 2026-06-30 --share income --format csv > profit-loss-shares.csv
rastrata reports balance-sheet --as-of 2026-06-30
rastrata reports cash-flow --as-of 2026-06-30
rastrata reports general-ledger --as-of 2026-06-30 --page 2
rastrata reports trial-balance --as-of 2026-06-30 --format csv > trial-balance.csv
```

`reports all` returns the trial balance, profit and loss and balance sheet together. The default is
JSON, one envelope per call. `--share income` gives every row and total of the profit and loss a `share`
(and a `comparativeShare` in a comparison), as text with one decimal; the other statements refuse it. `--format csv` prints the file Rastrata renders, the same one the page
downloads. An agent reads the same statements.

Statements read the current book. Pass `--revision N` only to reproduce a report exactly as it was at
an earlier revision; that replays history and is slow in a large book. The page does the same for a
report by month: it reads the whole range once and then each month at that revision.

## When something does not look right

| You see | It means | Do |
| --- | --- | --- |
| "Those dates are outside the book's fiscal calendar" | The book has no fiscal period covering a date you chose. | Choose dates inside the calendar named on the page. A later year is covered once an entry is recorded in it: the calendar grows with your entries, and a report never grows it. |
| "Choose dates from Oct 1, 2025 to Sep 30, 2026, the dates this book's fiscal calendar covers." | A custom date is outside the calendar. | Change it. |
| "Not available with months in columns." beside Compare | **By month** is on in View. | Turn it off to compare. |
| "No income to compare with" | The dates have no income, or less than none, so there is nothing to take a share of. | Choose dates that include income, or read the amounts. |
| "No income in the comparison period" | The period before has no income, so its amounts have no share. | Read its amounts, or compare with another period. |
| "That is too many months to lay out" | The range has more than 24 months. | Choose a shorter range, or show the total. |
| "The months do not add up to the total" | The monthly figures and the total disagree. This should never happen. | Do not rely on the report. Read it again and, if it stays, keep the page and report it. |
| "Needs a tag" on a cash-flow line | An account that moved has no cash-flow tag. | Tag it on Accounts and read the statement again. |
| "The cash flow cannot be shown yet" | No account is tagged cash. | Tag your bank and cash accounts on Accounts. |
| "The book has changed" | An entry was posted after this report was read. | Choose **Read the report again**. |
| "Does not balance" | The report compiler and the book disagree. This should never happen. | Do not rely on the report. Keep the page and report it. |

# Import a bank statement

This guide takes a statement file from your bank or card issuer to transactions waiting for review.
Importing never posts anything. Every transaction is reviewed in For review first, and recorded when
you accept it.

You need a configured book. The statement goes into the account in your books for that bank or card; when
your books have none yet, the account picker's "New account…" makes it on the spot, named as you like, so the
first import is the whole of the setup.

## 1. Download the file

Download the account's activity from your bank's website as one of:

- **CSV** (a spreadsheet file), the universal fallback;
- **OFX**, **QFX** or **QBO**, the formats Quicken and QuickBooks read. Prefer these when your bank
  offers them: every transaction carries the bank's own identifier, so importing the same
  transaction twice is impossible, and the file states the account's balance.

A PDF statement, an Excel workbook or a screenshot cannot be imported. Download the CSV or OFX
version instead. A file can be up to 16 MiB; download a shorter date range if yours is larger.

## 2. Preview it

On the web, open **Transactions**, then **Import statement** (Search finds it by name too; an account's
own page has the same button). Choose the account and the file, side by side; what you imported before is
listed below them. Once the file is read the page is about it: the file's name and the account, one
sentence that says what was found ("15 new transactions, Oct 1 to Oct 29, 2026. The statement ends at
5,411.40."), **Import 15 transactions**, and the first rows to compare with your statement (**Show all**
lists the rest). Anything that stands in the way is said above the button. **Details** holds how the file
was read, its totals, the balance check, the notes, the columns and the start date; it opens by itself
when the columns need choosing. A new book's Home has the same door: **Import a statement**, beside
**Connect a bank**. From a terminal:

```sh
rastrata import ~/Downloads/Chase1234_Activity.csv --account "Chase Checking" --dry-run=true
```

`--account` takes the chart account's id, its code or its exact name. The preview tells you, in
plain words and in JSON, what it found, and writes nothing:

- the format, and which bank's layout it recognised (or which columns it chose);
- how many transactions are **new**, how many were **already imported**, and how many were kept out
  on purpose (before your start date, or caught up);
- money in, money out, and the first and last dates;
- the **balance check**: what the statement says the balance was, what your books say, and the
  difference. A difference is shown, never fixed. Until your opening balance is entered, a
  difference of that size is expected;
- every problem, with the row it is about, as a spreadsheet numbers rows.

Read the preview before you import. In particular check:

1. **The signs.** Money into the account is positive; a bank withdrawal or a credit card charge is
   negative. If every charge on your card looks positive, your issuer writes it that way (American
   Express does): choose the American Express layout, or **Flip the sign of every amount**, under
   **Details**, **Change how the columns are read** (`--preset amex-card` from a terminal).
2. **The dates.** A file in which every date could be month/day or day/month (all of 03/04/2026,
   05/06/2026) is refused until you choose the order. Rastrata never guesses.
3. **The first transactions.** Compare them with your statement.

## 3. Import it

On the web, choose **Import N transactions**. From a terminal:

```sh
rastrata import ~/Downloads/Chase1234_Activity.csv --account "Chase Checking"
```

The answer is "N transactions are waiting in For review". Nothing was posted.

Import the same file again, or a later file that overlaps it, and only the transactions you do not have
yet are added. Two identical charges on the same day are two transactions, as they should be.

### If a file has rows that cannot be read

A row with an amount that has more than two decimal places (cents are never rounded), a date that is
not a date, or no amount is listed with its row number, and the import stops until you decide. Fix
the file or the column choices, or import the rest and leave those rows out
(`--skip-invalid-rows=true`). The rows left out are listed in the preview, and the balance check will
show a difference until you enter them.

### Starting your books part-way through the history

`--start-on 2026-01-01` (or **Start date**, under **Details**, **Start date and history** on the web) records every transaction dated before that day
as excluded, so that overlap detection still recognises them and nothing is silently dropped.
`--catch-up=true` adopts a whole file as history without queueing any of it, for the first import
when you have already entered those months by hand. Both are visible in For review and can be undone
there.

## Choosing the columns of a CSV

Rastrata recognises the layouts below by their header row. When a file is from one of those banks
but says so nowhere (American Express's three columns, Date, Description and Amount, could be any
bank's), choose **Bank or card layout** under **Details**, **Change how the columns are read** on the web, or
`--preset ID` from a terminal (`rastrata import presets` lists the ids). When it does not recognise a
file at all, the preview shows the file's columns with a few sample values, and you choose which
column holds the date, the amount (one signed column, or one for money out and one for money in, or an amount with a
direction), and the description. The preview updates as you choose. **Save these choices for this
account** keeps them, and the next file with those columns is read the same way
(`rastrata import FILE --account ID --profile NAME`; `rastrata import profiles` lists them).

Columns are found by name, so a bank that reorders its columns, or lets you choose them, still
works. A column the bank may leave out can be marked optional.

## Supported formats

Every preset below is **unverified**: it was built from how the bank's export is documented by third
parties and by the bank's own help pages, and tested against synthetic files shaped like it, because
no real statement from these banks was available. The preview says "unverified" wherever a preset
is named. If your bank's file does not read correctly, choose the columns by hand, and tell us what
the file looks like so the preset can be corrected.

| Source | Format | Notes |
| --- | --- | --- |
| Chase checking, savings, business checking | CSV | Details, Posting Date, Description, Amount, Type, Balance, Check or Slip #. Newest first. |
| Chase credit card | CSV | Transaction Date, Post Date, Description, Category, Type, Amount, Memo. Charges negative. |
| Rho business account and card | CSV | Rho lets you choose columns when you export. Needs Date, Amount and Status; only settled rows are imported. |
| Chase, any OFX-capable bank | OFX, QFX, QBO | OFX 1.x (SGML) and 2.x (XML) and Intuit's QFX and QBO. Checking, savings and credit cards. |
| Mercury | CSV | Date (UTC), Description, Amount, Status and more. Only sent rows are imported. |
| Bank of America checking, savings | CSV | A summary block, then Date, Description, Amount, Running Bal. |
| Bank of America credit card | CSV | Posted Date, Reference Number, Payee, Address, Amount. |
| Wells Fargo checking, savings | CSV | No header row: date, amount, a star, check number, description. |
| American Express | CSV | Date, Description, Amount. Charges are positive: choose the American Express preset. |
| Capital One credit card | CSV | Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit. |
| Capital One 360 | CSV | Account Number, Transaction Date, Transaction Amount, Transaction Type, ... |
| Citi credit card | CSV | Status, Date, Description, Debit, Credit. |
| U.S. Bank | CSV | Date, Transaction, Name, Memo, Amount. |
| Charles Schwab Bank | CSV | Date, Status, Type, CheckNumber, Description, Withdrawal, Deposit, RunningBalance. |
| Relay, Brex, any other CSV | CSV | Choose the columns by hand (a file with Date, Description and Amount columns is read without asking). Relay and Brex do not publish the columns of their exports, so they have no preset yet. Delimiters (comma, semicolon, tab, pipe), a byte order mark, UTF-8, UTF-16 and Windows-1252 text, quoted fields, thousands separators, parentheses for negatives and a decimal comma are all handled. |

### Credit cards

A credit card is a liability account. Rastrata keeps one convention for every account: money into the
account is positive and money out is negative, so a card charge is negative and a payment is
positive, and a card that owes 500.00 has a balance of -500.00. Issuers differ: Chase and Bank of
America already write charges as negative; American Express writes them as positive; Capital One and
Citi use separate Debit and Credit columns. The presets know this. For a file they do not know, the
preview warns when most transactions on a card are positive, and when a card's reported balance is the wrong
way round.

### What a file can hold, and what is kept

- Descriptions, payee names and references are kept exactly as the bank wrote them, up to 1000
  characters. The raw file is kept whole, addressed by its SHA-256, so transactions can be regenerated later.
- Text in a file is written by strangers. A description that looks like a spreadsheet formula, HTML,
  invisible or direction-changing characters, or an instruction to a person or an assistant is
  flagged in the preview. It is shown and stored as plain text and never acted on.
- Amounts are exact: more than two decimals is an error, never a rounding. Dates are the day the bank
  wrote, never moved by a time zone.
- A statement in another currency than your book is held for review, not converted.
- Importing one account as both a CSV and an OFX file for the same period counts every transaction twice,
  because the two formats carry different identifiers. Use one format per account, or set the start
  date at the first day not yet imported.

## From an agent

Moving a whole business in, with a folder of files and several layouts? [Move to Rastrata with your own agent](move-in-with-your-agent.md) scans the folder, plans the move, and proves a recipe for each layout against the balances the statements print.

An agent runs the same commands (`rastrata import FILE --account ID --dry-run=true`, then without
the flag). The bookkeeping skill tells agents to preview first, to treat every cell as data, and never
to skip rows without the owner's agreement.

## Limits

<!-- help: installed -->
- 16 MiB per file and 100,000 transactions in the version on your own computer. A business with a few thousand transactions a year is far below this.
<!-- help: end -->
<!-- help: hosted -->
- On the hosted service one request may change about a megabyte of the books once packed, so a file of more than about 5,000 transactions (measured: 5,000 went in, 8,000 were refused), or a file that does not pack well and runs to more than two or three megabytes, is refused with a message that says to send it in smaller parts. Download a shorter date range, such as a quarter, and import each; a second import of the same lines adds nothing.
<!-- help: end -->
- Statements are read by one parser per format; if a file is refused, the message names the row.
- OFX investment statements are not imported. PDF and Excel are not imported.

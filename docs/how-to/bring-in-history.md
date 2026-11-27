# Bring in your past years

Your books before Rastrata can come with you: every entry of the old system, dated as it was, tied to the old
books year by year. Do this for a business that has years of history, or when you move to Rastrata partway
through its life and want the earlier years in one place.

It is for the owner, or for the owner's agent working through the `rastrata` command line. The
agent does the part that needs reading (making one file from the old system); Rastrata does the rest and
proves it with arithmetic. In the browser, **Settings, Bring in your books, Bring in history** does steps 1 and 2 below: choose the
file, see what it would do, say where each account goes, import. The command line does the same, and is how an
agent does it.

## What you need

- A book with no entry yet. A book made in the browser has a calendar from 2000, so any year since then can
  come in. Its chart does not have to match the old one: each account of the file is posted to one of the
  book's accounts, or **added** to the book as a new account of a kind you choose (asset, liability, equity,
  income or expense). An added account is open from the first day of the book's calendar, so it takes every
  entry of the history. The browser suggests a kind from the account's number (1000s are assets, 2000s
  liabilities, 3000s equity, 4000s income, 5000s to 7000s expenses) or from a plain word in its name
  ("Accounts Receivable", "Owner Investment") and asks about the rest. Accounts can be added only while the
  book has no entry, because an account added later cannot take an entry dated before it; so bring in the
  oldest part of a long history first. An account that first appears in a later part is added then, open from
  that part's first day: a part can add accounts as long as every entry already in the book is dated before the
  part begins. Adding accounts needs the configure permission as well as post.
- A journal file: a CSV, or an Excel file (.xlsx), with one row for each line of an entry. Any old system can
  make it (a Xero journal report, a QuickBooks journal, a general-ledger export; an agent can turn any of them
  into this). An Excel file is read as the table of its first sheet, dates and amounts as the cells hold them.

  | Column | Needed | Notes |
  | --- | --- | --- |
  | Date | yes | `2019-03-14`, or `03/14/2019` and `14/03/2019` (the dates say which; if they cannot, month first is assumed and said). |
  | Account | yes | A code (`Account Code`), a name (`Account`), or both, such as `1000 - Checking`. |
  | Debit and Credit | yes | Two columns, or one signed `Amount` (a debit is positive). |
  | Journal, Reference, Description | no | `Journal` (or `Trans #`, `Entry No`) names the entry; a row with no date or number belongs to the entry above it, as QuickBooks writes its splits. Without it, a balanced entry followed by a new date is a new entry. |

  **From Xero** the file is the Journal Report (Reporting, All reports, Journal Report), with the date range set
  to the year and **Export, Excel** (Xero's reports export as PDF, Excel or Google Sheets, never CSV); the
  title rows, the "ID 106 …" row above each journal (its narration), the Total rows, the dash where there is
  no amount, and the dates are read as they come. Tick Description in Columns if you want each line's own
  words as well. Import Xero's chart of accounts first (Settings, Bring in your books, Import from Xero): the kind of each
  account the book lacks is then Xero's own, and an account you mapped onto one of the book's is posted there.

  An entry needs at least two lines and its debits must equal its credits. An entry that does not is never
  guessed at: it is named with its row number and the file is not imported until it is right.
- The old system's trial balance at the end of each year, as a CSV or an Excel file with an account and a debit
  and a credit (from Xero: Reporting, Trial Balance, set the date, Export, Excel).
  This is the proof, and the reason to ask for it: the file's own entries always agree with themselves.

## 1. Preview

```sh
rastrata history preview history.csv
```

Nothing is changed. It uploads the file (once; the same bytes are the same file) and says how many entries and
lines it found, the years they fall in, how each account of the file maps to the book's accounts, every
problem with its row, and anything the book already holds that the history would meet. The file is **ready**
when nothing is wrong, every account is mapped and the book has no entry in those dates that is not from this
file.

An account of the file the book names differently is mapped in a small JSON file and passed with
`--map-file`: `{"Sales income": "4000"}` posts the file's "Sales income" to the book's account 4000, and
`{"Bank Fees": "+expense"}` adds "Bank Fees" to the book as an expense account (`+asset`, `+liability`,
`+equity`, `+income` or `+expense`). The preview says which accounts it would add, and a kind it suggests for
each account the book lacks. Give `--map-file` to `import` as well, so the same accounts are added.

History goes into dates the book has no entries in. If the book already has entries in those dates, the
preview says so and nothing is posted; if an opening entry stands for everything before some date, history
from before that date would be counted twice, and the preview says that too. Entries after the file's last
date are fine: bring in the earlier years and keep working.

## 2. Import

```sh
rastrata history import history.csv
```

It posts the entries in chunks (twenty to start, more while the book takes them quickly, fewer when it says a call was too much) until none is left, saying how far it got, and the books begin on the first day of
the file. The entries are dated as they were, and each is posted under an identity taken from the file and its
number, so running the command again, after an interruption or on purpose, posts only what is missing and
never an entry twice. If the book refuses an entry (a closed period, a date before the book's first day), the command
stops there, says which, and everything before it stays posted. A file is at most 16 MiB, and on a hosted workspace about 4 MiB (some 40,000 entries; a book keeps an upload in
one entry of its record, and a larger file is refused with the advice to split it); a longer history is sent in
parts of a few years each, in order of date, oldest first.

## 3. Tie each year to the old books

```sh
rastrata history tie-out trial-balance-2016.csv --as-of 2016-12-31
```

It compares the book's balance of every account at that date with the old system's trial balance and names every
difference. In the browser it is the second half of **Bring in history**: choose the trial balance,
give its date, and Compare. Do it for the last day of each year. A year that does not tie is a problem in the file or the old
books, found while it is cheap to fix.

## 4. Close the years

Once a year ties, close it ([Close a fiscal year](close-a-fiscal-year.md)) so no one changes it by accident.
Closing posts no entries: earnings roll forward by computation.

## What it does not do

- It does not bring in invoices, bills or their payments as documents: Rastrata keeps entries. An accrual
  history comes in as the entries it is.
- It does not merge two histories or add to a year that already has entries: the book must have no entry in
  the dates of the file. To fix a year, reverse and enter again in the book as for any correction.
- It does not change the book's currency, its cash or accrual basis, or its fiscal year once an entry exists.
  History that changed any of them comes in on the book's settings; to make the book the old books' way,
  set up a new book with the right settings first (the fiscal year can also be changed in Settings until the
  first entry) and bring the history into that.
- A book made before the calendar reached back to 2000 has the calendar it has: the preview says when a date
  is before it.

<!-- help: skip -->
Why it is built this way, and what was measured, is in [Bringing in history](../reference/program/history-import.md).
<!-- help: end -->

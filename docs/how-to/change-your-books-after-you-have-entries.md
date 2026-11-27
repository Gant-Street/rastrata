# Change your accounting method, fiscal year or currency after you have entries

A book keeps one currency, one cash-or-accrual method and one fiscal-year month for as long as it has entries.
The fiscal-year month can still be changed until the first entry is posted (Settings, Business), and the method
and the currency are chosen when the book is made. When the books must be kept another way later (an accountant
asks for accrual, the business changes its year, it starts to bill in another currency), the way is to **rebuild
them in a new book** with the settings you want. Every entry comes across, dated as it was, and the old books
prove it with their own trial balances.

This is for the owner, or the owner's agent through the `rastrata` command line. It is a few minutes of work for
a small business and does not touch the old book, which stays as it is until you stop using it.

## What comes across and what does not

- **Comes across:** every entry, with its date, accounts, amounts, reference and description, and the accounts
  they use (added to the new book).
- **Is set up again:** bank connections and statement imports (the entries they made come across, the
  connections do not), rules, reconciliations, who has access, agents, Stripe. These belong to the old book.
- **Does not carry the old source of an entry.** An entry that came from a bank line comes across as an entry
  of the history, not as that bank line. Keep the old book, or its export, for the audit trail.

## 1. Export the old books

The general ledger is the whole history in the form the importer reads. For the first day you have entries to
today:

```sh
rastrata reports general-ledger --from 2019-01-01 --as-of 2026-12-31 --format csv > ledger.csv
```

Also make a trial balance of the old book at the end of each year, to prove the new one against:

```sh
rastrata reports trial-balance --as-of 2019-12-31 --format csv > tb-2019.csv
```

## 2. Make the new book

<!-- help: hosted -->
Make another workspace with the settings you want.
<!-- help: end -->
<!-- help: installed -->
Make a book with the settings you want: another workspace in the browser, or, for an agent, the book setup tool
(`rastrata_setup_book`) with the method, the fiscal-year month and the currency.
<!-- help: end -->
Leave it with no entries: the import adds the accounts of the old books to it, and an account cannot be added
once a book has entries.

## 3. Bring the entries in

```sh
rastrata history preview ledger.csv
rastrata history import ledger.csv
```

Or in the browser, **Settings, Bring in your books, Bring in history**. The accounts of the file are added to the new book as they
were named, each as the kind of account the old book had (the preview suggests it; confirm it). See
[Bring in your past years](bring-in-history.md) for what the preview says and what it refuses.

## 4. Tie each year to the old books

```sh
rastrata history tie-out tb-2019.csv --as-of 2019-12-31
```

The entries are the same, so every year ties to the cent; a year that does not tie names the account and by how
much, which is a problem to find before you stop using the old book.

## 5. Close the years and move over

Close each year ([Close a fiscal year](close-a-fiscal-year.md)), then do the day-to-day work in the new book. Keep
the old book, or its [open export](back-up-and-restore.md), for as long as you must keep records.

## When it is not worth it

A book with a short history and few entries is quickest to rebuild. A book whose bank connections, rules and
reconciliations took months to set up has more to set up again: ask first whether the report you need (for
example an accrual view for one tax return) can be made from the entries you have, which an accountant can do
from the [accountant pack](work-with-your-accountant.md) without changing your books.

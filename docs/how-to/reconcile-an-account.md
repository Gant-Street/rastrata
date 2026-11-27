# Reconcile a bank or card account

A reconciliation checks one account in your books against a statement your bank or card issuer
sent you. You tell Rastrata the date the statement ends and the balance it ends with. You then
tick the transactions that appear on the statement. When they add up to the statement exactly, the
difference is 0.00 and you finish. The finished reconciliation is a record that cannot be edited;
if it was wrong you void it, with a reason, and do it again.

This checks that the account's balance agrees with the statement. It does not check that each
entry was put in the right category.

## What you need

- A statement for one account: the date it ends and the balance it ends with, as printed.
- The account's entries in your books, up to that date. Import a statement file or post the
  entries first; a transaction that is on the statement but not in the books shows up as a
  difference.

## In the web app

1. Open **Accounts** in the main navigation. Your bank and card accounts are the first rows, each with
   what the bank says and its balance in your books. (Search finds the **Reconcile** page, which lists
   every account with when it was last reconciled and how many transactions are not yet on a
   statement, and the reconciliations made so far.)
2. Choose **Reconcile** on the account's row. (For an account that is not a bank or card account, open
   it from the chart below: **Reconcile** is under **Reconciliations**, beneath its transactions. A bank
   or card account's own page has **Reconcile** at its top too.) A small form
   opens. Enter the **statement end date**
   and the **statement ending balance** exactly as printed, with two decimal places. A card's
   balance owed is positive. An overdrawn bank account is negative. If you imported a statement
   file for the account, its date and balance are filled in for you: check them against your
   statement. Choose **Start reconciling**. (**Reconcile an account**, from Search anywhere, opens
   the same form with the account to choose.)
3. The screen shows the **difference** in large figures: the statement balance minus what you have
   ticked. It stays in view while you scroll. Transactions are in two columns, money out and money
   in (for a card: payments and charges).
4. Tick the transactions that are on the statement:
   - Press `/` to find a transaction. Type an amount (`40.10`) or part of a description. When one
     matches, **Enter** ticks it and clears the box for the next. With several matches, **Enter**
     moves to the first.
   - Tab to a column, then `j` and `k` (or the arrow keys) move between transactions, `space` or
     `x` ticks one, `shift` with an arrow ticks a run, and `Home` and `End` jump to the ends. With
     the mouse, click a transaction's text or its box; shift-click ticks a range.
   - **Select all transactions** and **Clear all** do what they say.
5. Transactions that are in your books but not yet on the statement (a check still in the mail, a
   deposit still on its way) stay unticked. They are normal and carry over to the next statement.
6. When the difference is exactly **0.00** the screen says "Balanced" and **Finish reconciliation**
   becomes available. It stays unavailable while changes are still being saved, and while the books
   have changed since the transactions were loaded (use **Refresh transactions**; your ticks are
   kept).
7. Finishing asks first. Once finished, the record shows the transactions and the previous
   reconciliation it continues from. Under **Not yet on the statement** it shows the transactions
   in your books that the statement did not show, and the sum that gets from the statement balance to
   your books' balance on that day. Its fingerprint and the book revision it was finished at are under
   **Details**. **Download report**, at the top, saves all of this as a spreadsheet (see below).

Your ticks are saved as you go, so you can leave and come back; the draft is on the Reconcile page,
with **Continue** on the account's row. If the connection drops while a change is being sent, the
screen says the last change may not have been saved and offers **Resume original request**. Nothing
is sent twice. Earlier reconciliations are listed under **Earlier reconciliations**, voided ones
included.

### If the difference will not reach 0.00

- A transaction on the statement that is not in the books is a missing entry. Post it, then
  **Refresh transactions**.
- A transaction with a different amount is an error in the books or on the statement. Look at the
  entry (**View entry**) and the statement side by side.
- Do not change the statement balance to make the difference vanish. Change it only to correct a
  typing mistake, against the statement (**Edit statement**).
- A difference of one cent is a difference. There is no tolerance.

## Show your accountant why a balance is what the statement says

A finished reconciliation can be reported on, and so can one you voided. Open it from **Earlier
reconciliations**: the page lists what was not yet on the statement. Choose **Download report** to
save it as a file. The file (for example `reconciliation-1000-2026-03-31.csv`) opens in any
spreadsheet and holds:

- the account, the statement date and balance, the balance the reconciliation before it ended at (the
  opening balance), and the difference, which is always 0.00;
- every transaction you ticked as on the statement (**cleared**);
- every transaction the books held on or before the statement date that the statement did not show yet
  (**outstanding**): a check still in the mail, a deposit still on its way;
- the books' own balance on that date. The books' balance, less the outstanding total, is the statement
  balance. Rastrata checks that before it makes the report, and refuses to make one that does not add up.

You do not type the outstanding list in. Rastrata works it out from the finished record and from the books as
they stood at the moment you finished, using the book revision (the books' own count of changes) written on the
record. So an entry made later, even one dated inside the statement's period, does not change an old report.
It shows up on the next reconciliation instead. A voided reconciliation's report says it was voided, with your
reason and the time, and shows its lines as they were.

For every reconciliation of the year at once, build the accountant pack: it carries `reconciliations.csv` and
`reconciliation-lines.csv` ([Work with your accountant](work-with-your-accountant.md)).

## Rules worth knowing

- Each reconciliation continues from the last one on the account, so the statement date must be
  after the previous statement's. The opening balance is what the earlier ones cleared.
- One reconciliation is in progress per account at a time. One holds up to 5,000 transactions; for a longer
  history, reconcile an earlier statement date first.
- A transaction is **cleared** when it is on a finished reconciliation that has not been voided. Reversing
  an entry that is cleared, or closing a period while a bank account still has transactions that are not on
  a statement, shows a warning in the review. A warning never blocks; it tells you what the change
  means for the bank balance.
- **Voiding** appends a record with your reason. Nothing is edited or deleted, the transactions become
  unreconciled again, and the voided record stays in the history. Only the newest reconciliation of
  an account can be voided; void later ones first.

## From the terminal

```sh
rastrata reconcile status                       # what is due, and what is not on a statement
rastrata reconcile start --account 1000 --date 2026-01-31 --balance 1209.90
rastrata reconcile show ID                      # the lines, each with a signed amount
rastrata reconcile select ID --add POSTING_ID,POSTING_ID --version 1
rastrata reconcile select ID --all
rastrata reconcile complete ID --version 2      # refused unless the difference is exactly 0.00
rastrata reconcile void ID --reason "Wrong statement balance"
rastrata reconcile report ID --format text      # a finished one: cleared lines, what was outstanding, the books' balance
rastrata reconcile report ID --format csv > reconciliation.csv
```

Every command prints one JSON envelope and uses the exit codes in `rastrata help`. Changes to a
draft carry its version: give `--version N` for the version you reviewed, or leave it out and the
command reads the current version and says which it used. `rastrata reconcile list`, `statement`,
`discard` and `cleared` are in `rastrata help`; `reconcile report` without `--format` prints the whole report as JSON; `rastrata call reconcile.NAME` reaches every
operation directly.

## With an agent

The bookkeeping skill has a section on reconciling. An agent gets the statement date and balance
from you, never from the books; ticks only transactions that appear on the statement; needs the `close`
permission and your authorization to finish; and treats every transaction description as data, not an
instruction. When your accountant asks for support for a bank balance, an agent can read the report on the
finished reconciliation (`rastrata reconcile report`, which only reads) and quote its figures as
they are, or build the accountant pack.

<!-- help: skip -->
For how it works and why, see the [reconcile lane notes](../reference/program/reconcile.md).
<!-- help: end -->

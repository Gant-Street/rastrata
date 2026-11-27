# Close a fiscal year

Closing a fiscal year locks each of its periods so nothing more can be posted into them, and records, for
each period, the figures the books showed when it was closed. It posts no entries and moves no balances:
each year's earnings carry forward by computation, so the books look the same after the close as before
it.
<!-- help: skip -->
For why, see [Closing a year without closing entries](../explanation/year-end-without-closing-entries.md).
<!-- help: end -->

<!-- help: skip -->
Rastrata books and reports; it does not give tax advice.
<!-- help: end -->
Whether a year should be closed, and when, is
between you and your accountant.

This guide covers the web app first, then the command line and an agent. It also says how the calendar grows,
and covers reopening a period, because a closed year sometimes has to be corrected.

## Before you start

Nothing below stops you from closing a year: the checklist tells you what it knows and you decide. It is
still worth doing the things it asks about first.

1. **Reconcile your bank and card accounts** to the last day of the year
   ([Reconcile an account](reconcile-an-account.md)). The checklist names each tracked account that has transactions
   dated in or before the year that are not on a reconciliation.
2. **Work through For review** so nothing imported and dated in the year is still waiting
   ([Work through For review](work-through-the-inbox.md)).
<!-- help: installed -->
3. **Back up** ([Back up, verify and restore](back-up-and-restore.md)). The year's last month will say so if
   no backup has been checked.
<!-- help: end -->

## Close a month in the web app

Open **Settings**, then **Close the books**. The line under the title says how far the books are closed ("Books
are closed through Feb 28, 2026."). Under it is one card, named for the month the books can be closed through
("Through March 2026"). Months before your start date, a month still under way and months nothing was recorded
in are not listed: there is nothing to do about them.

1. Read what is left. Each line is one thing, with the one button that deals with it: "8 transactions to
   review." with **Review**, "Business savings is not reconciled through Mar 31, 2026." with **Reconcile**. What
   is already done is not listed.
2. Do what is left and come back. **Close through March 2026** is on only when nothing is left. Press it: the
   books close through that month in one step, a message says so, and the line under the title moves on. If the
   book has something to say first (a warning), it is shown in the card and waits for you.
3. A line that says **1 thing to look at first** opens what does not stand in the way and is worth reading
   before you close, such as a transaction older than your last statement that is on no reconciliation.

**Close through** closes every open month up to the one it names, oldest first, the months nothing was recorded
in among them. A business that started in October with books from January closes January to October with one
press, once October is ready. Each month is checked again as it is closed; if one cannot close, the press stops
there and says which, and the months before it stay closed.

**Which month the card names.** When you are one month behind, that month. When you are several months behind,
the card names the latest month that has ended if everything is ready through it (every account reconciled
through its last day, nothing waiting for review), so one press catches the books up. If it is not, the card
names the earliest month with something in it and lists what is left for that one, because months close in
order. Home names the same month when it says a month is ready to close.

A month nothing was recorded in is never the one the card names. It closes with the next month that holds
something, or with the year. To lock such a month sooner, close it from the command line or with an agent
(below).

Closed months are under **Closed months**, each with **Reopen** and a **Closing report**.

### What stands in the way of a month

The service decides, and the page, Home and the command line (`rastrata cutover checklist`) all say the same
thing.

- **Transactions waiting for review** that are dated on or before the month's last day.
- **A bank or card account that is not reconciled through the month's last day.** The proof that a month's books
  are right is that each account agrees with its statement to the cent
  ([Reconcile an account](reconcile-an-account.md)). An account whose first transaction is after the month is
  not asked for.
- **Opening balances that are not posted**, for a book that recorded a start date
  ([Start the books from opening balances](move-from-xero.md#3-start-the-books-from-opening-balances)).
- **Stripe**, for a book that books Stripe: Stripe's own balance has not been compared with the books, it holds
  money the books do not, or a payout does not add up to its transactions.
<!-- help: installed -->
- **A backup that has not been checked**, or one that is too old: "No backup of your books has been checked
  yet." with **Back up now**.
<!-- help: end -->

`rastrata cutover checklist` prints all of it in full: each account with its last reconciliation and what is not
yet on a statement, Stripe's figures, the backups and the restore drill, and how many month ends have been
closed and reconciled since the start date.

## Close the year in the web app

1. Open **Close the books**. **Close the year** is a line under the card that says when the year ends ("Fiscal
   year 2026 ends Dec 31, 2026"); once a year has ended and still has a period to close, it is open when you
   arrive. It shows the earliest such year. In a book of several years, **Fiscal year** chooses another: each
   option names the year and how far along it is.
2. Press **Close fiscal year 2026**. The button is there once the year has ended; until then the line says when
   it ends. (From Home, the Close row links here when a year has ended and is
   not closed.) An agent can still close a year early through the API or the command line (`periods.yearEnd`).
3. **Check the books.** The page lists what the books and the rest of Rastrata can say about the year. Every
   line says its state in words:
   - *Ready* is a fact the books can state: the trial balance balances, every period has ended, no close of
     the year was superseded, earlier years are closed, no unposted drafts are dated in the year.
     If your books began part-way through the year, the months before the start date hold none of your
     books' own activity: they are not counted as open, and the year-end closes them with the rest.
   - *Needs attention* is something worth looking at first, with a link to where it is fixed: accounts not
     reconciled, a month-end checklist that says "not yet", imported transactions waiting for review.
   - *Could not be read* means the line could not be checked, so nothing is claimed about it. It is never shown
     as fine.

   Below the checklist are the year's figures (income, expenses, net income, assets, liabilities, equity and
   the earnings of earlier years) as of the year's last day, on the book's basis. They do not change when you
   close. **Review the year's statements** opens them on the Reports screen.
4. **Say why.** Write one reason for the whole year. It is kept in the history of every period the year-end
   closes, so someone reading the history later can see which closes belong to the same decision.
5. Press **Review the year-end.** The page shows the year-end in order, one row per period: *Close* for an open
   period, *Reopen, then close* for a locked period whose close was superseded (see below), *Already closed*
   for one that is fine. Each row can carry notes from the books or from other parts of Rastrata; open them
   before you go on. None of them blocks the close.
6. Press **Close fiscal year 2026** (it names the year). The periods close in order, each as its own command
   checked against the books as the closes before it leave them.
7. The page says how many periods closed. **Back to the periods** shows the year as *Closed*, and each month,
   under **Closed months**, has a **Closing report** link to the figures it recorded.

If you change the reason after reviewing, the plan on screen is no longer the plan for what you typed and the
close button is off until you review again.

### If the result is uncertain

If the connection drops while the periods are closing, the page says **The result is uncertain** and offers
**Resume original request**. The browser kept the exact request it sent. Resuming sends that same request
with the same identity, so the book answers with what it already did: periods that closed are not closed
twice, and the rest are closed. Reloading the page, or coming back later, opens the same place with the same
button. **Never start a second year-end to find out what happened.**

### If it stops part way

If the book rejects one of the closes (for example because something else wrote to it after you reviewed), the
periods before it stay closed and the page says how many did. **Review the year again** reads the year afresh
and plans only what is left.

## The calendar grows itself

A book has the fiscal years it has needed so far. On **Close the books**, **Calendar and history** shows the
range ("Covers Jan 1 to Dec 31, 2026."), every close and reopening with its reason, and says that later years
are added as your entries need them: an entry dated after the last day of
the calendar posts as usual, and the calendar grows to hold it (Changes lists the extension with the entry).
Nothing you have posted changes, and closed periods stay as they were; periods are added, never removed or
moved. A date before the first day of the book cannot be helped: the first period is fixed when the book is
created, so it says to post on or after that day. To add years ahead of time, use the command line
(`rastrata periods extend`, below) or an agent.

## Reopen a period

Open **Close the books**, open **Closed months** and press **Reopen** on March 2027. Say why, then
review. The review shows the consequence before you commit:

> Reopening this period supersedes the closes of 3 later periods: April 2027, May 2027, June 2027.

Reopening a period lets you post and correct entries dated in it. It also means the figures recorded when the
later periods were closed no longer describe the books. Those periods **stay locked**: nothing can be posted
into them until each is reopened. They stay under **Closed months**, which is open when you arrive and says "Its
close no longer matches the books" on each, and the year has the line "3 closes were superseded by a reopening
and need closing again".

Once the correction is made, press **Close fiscal year 2027 again**. The year-end reopens each superseded period and
closes it again, in order, so every period has a current close once more. The history keeps all of it: the
original closes, the reopening with the closes it superseded, and the new closes.

## From the command line

```sh
# Review what closing a year involves, without preparing anything
rastrata periods year-end 2026 --review

# Prepare it, read the plan (one sealed close per period), then commit the plan you read
rastrata periods year-end 2026 --reason "FY2026 reviewed with my accountant" --operation-id "$ID"
rastrata periods year-end 2026 --reason "FY2026 reviewed with my accountant" --operation-id "$ID" \
  --commit --plan-hash "$PLAN_HASH"

# Add fiscal years ahead of time (omit --through for one more); an entry dated in a later year adds it itself
rastrata periods extend --through 2029
rastrata periods extend --through 2029 --operation-id "$ID" --commit --plan-hash "$PLAN_HASH"

# Look at the periods, and close or reopen one
rastrata call periods.list
echo '{"periodId":"period-03","operation":"reopen","reason":"Late invoice"}' |
  rastrata call periods.prepare --input -
```

Running a command again with the same `--operation-id` returns the same plan, and `--plan-hash` refuses a plan
that is not the one you reviewed. An interrupted `--commit` is safe to run again with the same identity.

To close through a month, as the page's button does: ask whether it can close (`rastrata cutover checklist
--period <id> --check`; it lists what stands in the way and exits with 3 when something does), then close each open month up to
it in order, oldest first (`periods.prepare`, then `operations.commit`). `periods.list` says which months are
open, which have ended and which hold nothing (`empty`), and a refusal stops you at the month that needs
attention while the earlier closes stand.

## From an agent

An agent with the `close` permission has the same steps and the same review gates.
It prepares, shows you the plan, and commits only the plan you approved. Ask it "Close the books through
October": it reads the month's checklist, tells you what stands in the way
or, when nothing does, closes each open month up to October in order.

## What the close records

For each period closed, the book keeps the revision it closed at and a fingerprint of the trial balance, profit
and loss and balance sheet as of the period's last day. **Review closing report** opens the Reports screen at
that date. The **last** close of a year therefore records the year-end figures, and they can be reproduced
later from the book as it stood at that revision.

## When something is refused

- *"March 2026 (2026-03-01 to 2026-03-31) is closed, so nothing can be posted into it"* on a posting, or
  *"The entry is dated …, in March 2026 …, which is closed, so it cannot be corrected or reversed yet"* on a
  correction: the date, or the entry being corrected, falls in a closed period, and the message names it with
  its dates. Reopen the period (the consequences are shown first), post, and close it again. A bank transaction
  waiting for review keeps its date and stays drafted until you do. (The refusal is
  `fiscal_period_admission`; its words used to be the ledger's own, "Fiscal period period-03 is closed".)
- *"…is before the first day of the book's fiscal calendar"* or *"…is past the last fiscal year Rastrata
  supports"*: the date is before the book's first period, which is fixed when the book is created, or after
  fiscal year 2100. The refusal is `calendar_not_configured`; it names the date and the range the calendar
  covers. A date after the calendar's end is not refused: the calendar grows to hold the entry (above).
- *"Close requires one currently open fiscal period"* when closing one period by hand: it is already locked.
  If its close was superseded, close the year again instead; it does the reopening and the closing for you.

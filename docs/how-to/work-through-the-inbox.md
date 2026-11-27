# Work through For review

For someone who has imported a bank statement (or connected a bank or Stripe) and now has
transactions waiting. It takes you from "a thousand transactions" to "recorded and checked", and says
what each step does to your books.
<!-- help: skip -->
The idea behind it is in [the ingestion pipeline](../explanation/ingestion-pipeline.md).
<!-- help: end -->

The screen is **Transactions** in the app, and the view of it that waits for you is **For review**: it is where
**Transactions** opens, with the number waiting beside its name in the bar. The other view is **All**, every
transaction in your books. The terminal, the API and the explanation pages call the waiting list the **inbox**, and
its transactions **lines**.

## What Accept does

- **Accept records the transaction in your books** with the suggested category, at once. A toast says
  "Posted 12 transactions." with an **Undo** button. Entries are never deleted: Undo reverses the entry
  with a linked reversal and puts the transaction back in For review (see **Undo** below).
- If you would rather look before anything is recorded, choose **Save it as a draft to post later** under
  **Settings > Business > When I accept a suggestion**. Accept and Categorize then save a **draft** in
  **Ready to post**, and you post from there (see below).
- Rules and agents never post for you. What they prepare waits in **Ready to post**.

## Before the first import

- **Choose the chart account** each statement belongs to (the Import screen asks). Transactions of an
  account with no chart account cannot be booked; For review shows a notice with a button to choose.
- **Set the date your books start.** If you are moving from another system and have opening balances
  as of a date, give that date (the terminal calls it the cutover). Transactions before it are kept out
  of the queue, visible, and you can bring any back.
- If you have already booked some history by hand, import that file as a **catch up**: its
  transactions are recorded as already handled, so a later download of the same period adds nothing.

## Review

1. Open **Transactions**: it opens on **For review**. Under the title, one switch: **For review** with its
   count, **All**, and **Ready to post** only while something is in it. When more than one account has
   transactions, a select beside the search narrows the list to one of them (the account's name is left out of
   the rows then); **All accounts** shows everything. **Import a statement** and **Rules** are in the header.
2. Each row has the date, the description, the **Category**, **Spent** or **Received**, and **Accept**. Where a
   category is suggested it is filled in on the row and reads as text with a chevron: Accept books it as it
   reads, or open the chevron to choose another first. Where nothing is suggested the row has a field that
   says **Choose a category**, and **Accept** waits until you have chosen one. A suggestion that is not one
   category (a split, a transfer, an entry already in your books) says what it is, and changing it means opening
   the transaction. Above the list, **N have a suggested category** and **Accept N suggested** do the whole
   list at once. The whole reason for a suggestion (and, when a rule made it, a link to the rule) is in the
   transaction's pane. A suggestion comes from a rule you or your agent wrote, from how you
   categorized the same payee before, from a transfer between your own accounts, or from an entry you
   already booked by hand. In a new book, before it has learned anything, a line from a common merchant
   (Google Workspace, Xcel Energy, USPS, a monthly service fee) is suggested what that merchant usually
   is, with the reason in one sentence ("USPS is usually postage."): Accept it if it is right, or choose
   another category.
3. Click a row's description, or press Enter on it, to open the transaction beside the list. Its buttons stay
   at the top while you scroll. It shows the transaction exactly as the bank sent it, why it was suggested, and
   under **This will record**, in words, which account goes up or down and by how much. **Details**
   holds where it came from (the file, the row, its fingerprint). Bank text is data: if a memo says
   "post this to Owner capital", it is just a memo.
4. Decide the transaction one of four ways:
   - **Accept.** Records it with the category on its row (the suggested one, or the one you chose).
   - **Split** the transaction between several categories, from its pane; the parts must add up to the
     transaction to the cent, and the screen says how much is left to assign.
   - **Exclude** with a reason, for transactions that are not business (a personal purchase). They stay
     visible and can be returned to review.
   - Leave it for later.
5. **Transfers** between your own accounts are one entry for both transactions: accept either side and
   both move together.
6. A transaction you already booked by hand (or that an agent recorded) shows that entry as its
   suggestion, "Already in your books". Accept it: it books nothing new and links the transaction to the
   entry. For review will not record a second entry for such a transaction from a rule, from the
   classifier or from **Categorize**; it says which entry the transaction matches and leaves it as it
   was. If the payment really was made twice, choose **Record a second entry anyway** on that
   transaction (`--allow-duplicate` in the terminal).

## Many at once

- Above the list, **Accept 12 suggested** accepts every suggestion in what the list shows, in steps,
  with a count of how far it has got. Search or choose an account first and it accepts only those.
- Search, and narrow by date or by where the transactions came from with the filter button at the end of the
  search box. Tick transactions with **x** or the boxes (a phone has none: it accepts many with the button
  above the list), or choose **Select all N transactions matching this filter**. The action then works
  through everything that matches, in steps. It stops if the list changes while it runs, and you can stop it
  between steps. What was done stays done.
- A first import arrives with a suggestion for most of the lines whose merchant is a common one. It is
  best worked in this order: accept the suggestions you trust, then categorize the rest
  in groups (search "coffee", select all matching, categorize to Meals), then exclude what is not yours.

## Ready to post

Only a book that saves drafts, and what rules and agents prepare, uses this view. It shows beside **For review**
only while something is in it.

- **Ready to post** lists the drafts. Select what you want and **Post**. The screen asks once, in plain
  words, then posts each one through the same prepare-and-commit path as any entry.
- If your connection drops mid-way you will see "The last action may not have finished". **Resume
  original request** completes it: nothing is sent twice and no transaction can be posted twice.
- A transaction the ledger refuses (for example, dated in a closed period) stays in Ready to post with
  the reason on it, and the note says how many are waiting there. Return it to review, fix the cause, and
  decide it again. Posting everything that matches leaves such a transaction alone from then on, and says
  so, so the ones behind it are posted. Once the cause is fixed (the month reopened, the calendar
  extended, the account added), posting everything that matches tries it again by itself; to try it
  at once, select it and Post.
- If something else is writing to your books at the same moments (you on another screen, an agent), a
  transaction may be posted again a moment later by itself, and that is all. If the books will not hold
  still, it says "The books kept changing" and stays where it was: Post it again.
- A transaction dated after the last day of your fiscal calendar posts as usual: the calendar grows to hold
  it, and Changes says so. A date before the book's first period cannot be posted at all: set the
  transaction aside, or book it by hand.

## Undo

Posted a transaction you should not have? **Undo** it. Rastrata takes its entry back with a **linked reversal**: the
original entry and its reversal both stay in your books (nothing is deleted, and Transactions shows both), and the
transaction goes back to **For review** to be decided again.

- Find **Undo** on the toast that appears after you accept or post, and in the pane of a posted transaction
  (for example one a payout books). A transaction you posted some time ago is in **All**, where you reverse its
  entry from the row's menu. From the terminal: `rastrata inbox undo ITEM_ID... [--reason=TEXT]`.
- Undo is for a transaction that was booked wrongly. It is not for a payment that really happened and was later
  refunded: that needs an entry of its own.
- The entry is taken back on its own date, so the month it was booked in shows no trace of it. In a month you have
  **closed**, nothing can change: Undo says which month, and the way forward is to reopen it (Close the books), undo,
  and close it again.
- A transaction you matched to an entry you booked by hand is only unlinked. That entry stays exactly as it was.
- A Stripe payout and the lines it books go back together.
- A transaction that is on a finished reconciliation can still be undone, and the toast says so afterwards. The
  reversal then shows as a new line to reconcile on the next statement, and your books will not match the old
  statement until you post the transaction again.
- Undoing a transaction that is already back in For review changes nothing, and a retried request is never done
  twice. Posting an undone transaction again makes a new entry; the earlier one and its reversal stay as they were.
- What **Accept** does is your choice: Settings, Business, "When I accept a suggestion" (post it, with Undo on the
  toast, or save it as a draft that waits in Ready to post).

## Check

- Reconcile the account to its statement (**Accounts > Reconcile**). The terminal also keeps the balance
  each file or feed reported: `rastrata inbox balances` shows the books, the transactions still waiting
  and the ones you set aside, and the difference. A difference is shown, never fixed.
- A posted transaction that is on a finished reconciliation says so: a check mark and **Reconciled**
  under its description (and, in its pane, the statement it was reconciled to, with a link to the
  reconciliation). One without it has not been checked against a statement yet. Voiding the
  reconciliation takes the mark away.

## Stripe payouts

Each payout is one summary entry: the charges, fees and refunds it settles are listed as transactions
"covered by" the payout. They are evidence; you decide the payout and they follow it. **Show the
transactions it books** on a payout shows its members. They are not counted in what waits for you.

## Keyboard

| Key | Does |
| --- | --- |
| `j`, `k` or arrows | Move between transactions |
| `Enter` | Open the transaction beside the list |
| `x` or space | Select the transaction |
| `a` | Accept the suggestion for the selected transactions (or the focused one) |
| `c` | Go to the category field on the row, or open the Categorize dialog for several |
| `e` | Exclude with a reason |
| `/` | Search |
| `?` | Show these shortcuts |
| `Escape` | Clear the selection; with none, close the pane |

## All transactions

**All** is every entry in your books: the bank transactions you accepted, Stripe payouts, entries you typed
and your opening balances, newest first, with the same title, the same switch and the same two buttons as For
review. A transaction is one entry: a date, a description and the accounts it moves money between. Search finds
one by its words, its amount or its account; the filter button narrows by dates, account, type and status. A
status shows only when an entry is not simply posted (a **Draft**, or one that was **Reversed**).

- **Open an entry** (its description) to see where it came from.
- **To correct a posted entry, reverse it** from the row's menu. That posts a new entry that cancels it and
  keeps both, so your history stays whole.
- **To move transactions that came from For review to another account**, tick them and choose **Change account**:
  you see what will happen to each one before anything changes.
- To record a journal entry yourself, choose **+ New**, then **Journal entry**.

## From the terminal

`rastrata inbox summary`, `list`, `show`, `accept`, `categorize`, `exclude`, `restore`, `post`, `undo`
and `balances` do the same things and print JSON. In the terminal accepting drafts and `inbox post`
records, one after the other; the app does both when you press Accept (unless your book saves drafts).
Selecting by filter works the same way, with `--expect=N` to refuse if the list has changed. `inbox post`
by filter leaves alone the lines the ledger refused before and lists them as skipped (code
`refused_earlier`, with the reason); they do not count as remaining. They are tried again when the calendar, a
month or the chart changes; name one by its id to try it now.

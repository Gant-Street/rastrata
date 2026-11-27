# How Rastrata books Stripe

For anyone who sells through Stripe and wants to know exactly what lands in the books, and why it
can be trusted. This explains the model. To set it up, see [Connect Stripe](../how-to/connect-stripe.md).
<!-- help: hosted -->
To read Stripe with a key of your own instead, see [Book Stripe in a hosted workspace](../how-to/book-stripe-in-a-hosted-workspace.md).
<!-- help: end -->
<!-- help: skip -->
The lane's working record is [reference/program/stripe.md](../reference/program/stripe.md).

Rastrata books and reports. It does not calculate or file sales tax, give tax advice, or predict
anything.
<!-- help: end -->

Where a tax figure appears below, it is a figure Stripe itself reported.

## One entry per payout

Stripe pays you out in lumps. A payout of $93.31 on Monday is the net of dozens of movements: sales
less Stripe's fees, a refund, a dispute. Rastrata books each payout as **one entry**, made of the
movements Stripe says that payout paid out, added up account by account. This is the convention A2X
made standard for Stripe and Amazon, and it is what an accountant expects to see: one number that
matches one bank deposit, with sales, fees, refunds, disputes and sales tax already in the right
accounts.

The detail is not thrown away. Every Stripe movement (a balance transaction, with its own
identifier and its `reporting_category`: `charge`, `refund`, `dispute`, `fee` and about forty more)
is still imported. It sits in For review as **evidence**, shown as covered by its payout, with Stripe's
exact figures and the archived page it came from. You can see what any payout was made of. You cannot
post, categorise or exclude one of them on its own: it follows its payout, so nothing can be booked
twice.

**Why one entry per payout and not one per charge.** The cost of the book grows with the number of
entries in it, and a journal per charge makes a book several times bigger for no new information.
<!-- help: skip -->
When this was decided, replaying a book from its first entry took about 22 seconds at 1,000 entries
and about 90 at 2,000, and a book above about 1,600 journals could no longer be saved as a snapshot.
Since 2026-10-07 a new book is read back at about a millisecond an entry, so the number is no longer a
limit ([the scale record](../reference/program/main.md#the-scale-limit-and-what-we-do-about-it)), but
the choice stands: it is how the books of a payout-based business are kept (the A2X convention), and a
smaller book is still a faster one.
<!-- help: end -->
A small online business has about 2,000 Stripe transactions a year
but only about 250 payouts. One entry per payout is a fraction of one per transaction, and the books
still carry every figure. Each payout's entry names the transactions it stands for (their count and a
SHA-256 over their identifiers and amounts), so anyone can recompute it from the archived pages.

## Eight accounts, found by role key

Every payout entry uses these roles. Your chart gives each one an account. The online business
template creates and tags them; you can use your own.

| Role | Normally | What it holds |
| --- | --- | --- |
| Payouts in transit (`payouts.in-transit`) | Asset | Money Stripe has sent that the bank has not shown yet |
| Sales (`revenue.sales`) | Income | Gross sales excluding tax |
| Sales tax payable (`tax.sales`) | Liability | Sales tax Stripe reported collecting |
| Refunds (`refunds`) | Income, contra | Money returned to customers, shown as negative revenue |
| Chargebacks (`chargebacks`) | Expense | Disputed amounts you lost |
| Stripe fees (`stripe.fees`) | Expense | Processing fees, network costs, dispute fees, tax on fees |
| Other Stripe adjustments (`stripe.adjustments`) | Expense or income | Optional: adjustments, top-ups and reserves inside a payout |
| Stripe balance (`stripe.balance`) | Asset | The account Stripe's lines belong to; used for lines a person categorises (a payout made by hand) |

**Which account is which** is decided by the chart's *role key* tag, never by an account's name or
code. For each role, Rastrata uses the account you chose in Settings, and if you chose none, the one
open account that carries that role key **on the date of the entry**. A key that moves to another
account on a date is followed. If no open account carries a key, or two do, or the account is closed
or the wrong kind, Rastrata says which role and why, and does not sync or propose until it is settled.
It never picks by guesswork.

## What a payout becomes

A payout of $93.31 that carried six movements: three
ordinary $20.00 sales, one $21.65 sale where Stripe reported $1.65 sales tax, one $42.00 sale with no
tax figure, a $5.00 refund and a separate $0.50 Stripe fee. It arrives on 9 March, and the entry is
dated that day:

| Account | Debit | Credit |
| --- | --- | --- |
| Payouts in transit | 93.31 | |
| Sales | | 102.00 |
| Sales tax payable | | 1.65 |
| Refunds | 5.00 | |
| Stripe fees | 5.34 | |

It balances to exactly 0.00. Payouts in transit is the payout, the net Stripe actually sent. Sales
is gross sales before tax, Stripe fees is every fee (the fees on each sale and the $0.50 on its own),
and the refund is shown as a refund, so the books show what you sold and what it cost, not just what
arrived.

A payout that carried disputes shows them: two lost disputes of $20.00 and $25.00 with $15.00 dispute
fees are $45.00 of chargebacks and $30.00 of the fees, in the same one entry.

When the bank shows the deposit, one more entry clears it:

| Account | Debit | Credit |
| --- | --- | --- |
| Checking | 93.31 | |
| Payouts in transit | | 93.31 |

Payouts in transit then holds only what Stripe has sent that the bank has not shown yet.

## How a payout is checked to the cent

Stripe lists the movements it paid out in each automatic payout. Rastrata adds up their `net` and
compares it with the payout amount. They must be equal exactly: there is no tolerance and no
rounding. Then every entry must balance to exactly 0.00, and the legs of the movements added up
role by role must be the legs of the payout's entry. If any of that fails, the payout is reported
with what is wrong and its difference, and nothing is booked or forced:

- **The movements do not add up** to the payout (a mismatch): shown with the difference.
- **A movement cannot be split exactly** (an amount that does not fit hundredths, a net that is not
  amount minus fee): the payout is reported as unusable.
- **Stripe lists nothing** for it: nothing to book.

## Money Stripe holds that is not yet paid out

Movements that no payout has carried yet are **not in the books**: they are booked, together with
the others, when their payout is made. The balance check shows them as *in Stripe, not yet paid
out*, and compares Stripe's own balance (available plus pending) with that figure. They should
agree to the cent. When they do not, the difference is money Rastrata has not seen: movements older
than the first day you chose to import and not yet paid out, or newer than the last sync. A payout
made just after the first day still carries earlier movements, and its entry includes them, so its
figures are right.

## Held for you, not guessed

- **A payout made by hand.** Stripe does not say what a manual payout contains, so it cannot be
  split. It arrives as one line on the Stripe balance for you to categorise.
- **A payout in another currency.** Held for review, never converted.
- **A payout Stripe has not finished itemising.** It waits and is booked on a later sync.
- **A payout with an adjustment, top-up or reserve** (movements Rastrata does not book by itself)
  is shown without a proposal until an account is chosen for other Stripe adjustments, so it never
  lands somewhere by accident.

## How a payout is matched to its bank deposit

A deposit matches a payout when the amount is exactly equal and its date is within a few days of the
payout's arrival date (two by default). For review then proposes the clearing entry above.

Small daily payouts often have the same amount ($19.12 again and again): a business whose charges
cost the same gets payouts that net the same, every day. So equal amounts are the normal case, and
Rastrata pairs them rather than giving up. Every payout and every deposit of an amount are paired
**one to one**, once, for the whole book: as many as can be paired, and among the ways to pair as many,
the one with the dates **closest** overall, so a run of daily payouts pairs day to day and a steady
one-day bank lag pairs each payout with the deposit a day later. When two ways are equally close the
earlier payout takes the earlier deposit (payouts arrive in the order they are sent), and the
proposal says so. The entry is the same whichever payout a deposit cleared (bank in, payouts in
transit out), so a tie costs nothing in the books; it only decides which payout is recorded as
arrived.

A pairing can still be in doubt: another deposit or payout of the amount, with nothing of its own to
pair with, is just as close (a deposit that is not Stripe's, say, or a deposit that never reached the
file). The pairing is made all the same, at a lower confidence, and the reason says it is a choice
between equals: look at the bank line before accepting it.

A payout counts as matched when its deposit has been accepted in For review so that it clears payouts
in transit: from the proposal, which names the payout, or by hand (a deposit you categorised to
payouts in transit settles the payout it is paired with). The Stripe screen lists the payouts still
waiting for a deposit, which is the list to check against your bank statement; a payout Stripe
returned expects none, and one held for you is matched by hand. A payout sent in the last day or two
is expected to be waiting; one whose arrival date and matching window have passed is **overdue**
(`overdue` in the status, and a note in the cutover checklist that says it is not normal), and is
worth a look at the bank.

## When the money is dated

Each entry is dated on the day its payout **arrives**, in UTC (Stripe reports the arrival date as a
date), and the movements inside it are not dated on the days they happened. So a month's revenue is
the payouts that arrived in it. For a business that reports on the cash basis that is the right
answer. On the accrual basis, a payout that arrives on the 1st carries sales from the last days of the
previous month, and those sales are in the new month's books. A month-end split of such a payout
(the way A2X offers) is not built yet.

## What Rastrata does not guess

- **Tax.** The sales tax split uses only the figure Stripe reports on the Checkout Session or the
  invoice that took the payment, and only when that payment matches the charge exactly. A payment
  made another way has no figure: all of it is booked as sales and the sync counts it, so you can see
  how many. A partial refund of a taxed sale is booked whole to refunds, because Stripe does not say
  how much tax came back; adjust it by hand if tax was refunded.
- **Currency.** A payout in a currency other than the book's is held for you and never converted.
- **Anything it does not book itself.** Categories such as top-ups, reserves and unclassified
  adjustments go to the adjustments account if you chose one, and are otherwise left for you.
- **Text.** Descriptions, metadata and customer details from Stripe are untrusted data. Entries are
  built from Stripe's identifiers and figures; free text is shown to you, never obeyed.

## What is not handled yet

- A month-end split of a payout that spans two periods.
- Subscriptions on the accrual basis: revenue is booked when Stripe pays out, not spread over the
  period served (no deferred revenue).
- Gains and losses from currency conversion.
- Stripe Connect platforms (transfers, application fees), Issuing, Treasury and Climate activity.
- Sales tax calculation, remittance and filing. Tax is a liability to track; the product does not
  file anything.
- Payments received through Stripe's Link or other products that do not create balance
  transactions; those appear only when Stripe pays them out.

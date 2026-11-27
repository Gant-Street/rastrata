# Set up your books

For a business owner starting a new book, with or without an accountant. You will choose what kind
of business you run, when your fiscal year starts, and whether to keep your books on a cash or an
accrual basis. Rastrata then builds a starting chart of accounts that you review and change before
anything is created.

<!-- help: skip -->
Rastrata books and reports. It does not give tax advice, choose a tax line for you or file anything.
Wherever a tax form line appears, it is a suggestion read from the IRS form: **verify against the
current form; not tax advice**.
<!-- help: end -->

Before you start, have to hand: the name you want on your reports and, if you are not sure which basis
your tax return uses, the answer from whoever prepares your taxes. Your bank and card accounts are not
asked for: each is made, named as the bank names it, when you connect a bank or import a statement.

## In the web app

<!-- help: skip -->
Start the local service (`bun run dev:api`) and the web app, and open it.
<!-- help: end -->
Before a book exists the page is the setup wizard, and the header shows only the Rastrata wordmark. It
has four steps and sends nothing until the last one.

1. **Your business.** The name shown on your reports, and the currency. The currency cannot be
   changed after the book is created.
2. **Type of business.** Choose the template that matches how you file:
   - *Sole proprietor or single-member LLC* reports on Schedule C (Form 1040). It has owner's
     investment and draw, cost of goods sold on Schedule C Part III, and every common Schedule C
     expense.
   - *S corporation* files Form 1120-S, with officer compensation, shareholder distributions and loans.
   - *Partnership or multi-member LLC* files Form 1065, with partners' capital and distributions and
     guaranteed payments.
   - *Other business* has the same balance sheet and no tax lines. Use it for any other entity
     or outside the United States.

   Tick **I take payments through Stripe** to add accounts for your Stripe balance, payouts on their
   way to the bank, fees, refunds, chargebacks and sales tax.
3. **Accounting method.** How you keep your books, which is the basis:
   - *Cash* counts income when money arrives and expenses when money leaves. Rastrata does not issue
     invoices or keep track of who owes you, so cash fits books that follow your bank and Stripe. It
     is the default.
   - *Accrual* counts income when you earn it and expenses when you owe them. Rastrata does not
     issue invoices or bills, so you record receivables and payables yourself with journal entries.

   **The basis cannot be changed after the book is created.** If you are unsure, ask whoever
   prepares your taxes first.
4. **Review and create.** Your choices are summarized, and the chart of accounts is folded under its
   heading. Open it to read the accounts in their groups (assets, liabilities, equity, income,
   expenses), each with its code and, for income and expenses, the line of the tax form it reports
   on. Nothing is edited here: once your books exist, any account can be renamed, removed or added
   under Accounts. When it looks right, choose **Create book**.

   The review also says when your books start: the current year, in January, closing month by
   month. Nothing asks about it. The calendar behind it already runs from 2000, so earlier years can
   be brought in later, and if you are moving from other software your agent reads where your
   records begin and sets it for you
   ([Move to Rastrata with your own agent](move-in-with-your-agent.md)).

A fiscal year that does not start in January is set in **Settings**, under **Fiscal year**, until you post
your first entry: choose the month, review what the calendar becomes, and change it. After the first entry
the periods are history and it can no longer be changed.

The currency and basis cannot be changed after the book is created; once there are entries, the way is to
[rebuild the books in a new book](change-your-books-after-you-have-entries.md). If you go
back and change the type of business, basis, year or add-ons, the chart is rebuilt and the changes you
made to the earlier chart are discarded, but your bank and card names are kept, and the wizard tells
you so.

If your connection drops while the book is being created, the exact request is saved in your
browser. Home then shows **Resume original request**; use it, and never start over. Resuming cannot
create a second book.

### What the cash-flow class and tax line mean

- The **cash-flow class** (balance-sheet accounts only) says where an account's changes belong in
  the cash-flow statement. *Cash* accounts are where money sits (banks, Stripe balance, payouts in
  transit); the rest are operating, investing, financing or non-cash. Income and expense accounts do
  not have one: net income already carries them.
- The **tax line** (income and expense accounts) is the form line the account feeds, such as
  Schedule C line 18 (Office expense). Line numbers belong to a form's tax year: the 2026 Schedule C
  is an IRS draft that splits interest into 16b (vehicle loan) and 16c (other). The chart records which
  year it used, and Taxes says when a year's form is still a draft.

### After the book exists

Choosing **Create book** lands you on **Home**, titled **Today**, with your business name in the header
beside the wordmark. A new book shows one thing to do: **Add your bank to start**, with **Connect a
bank** and, beside it, **Import a statement**. (Where the service cannot connect a bank, the one
button is **Import a statement**.) Under it are two rows: **Bring in your books**, for a person
moving from another system, which goes away once your history or your opening balances are in; and
**Connect an agent**, for a person who has one. Nothing else is on the page until
something is in your books.

From then on Home is three things, in this order:

1. **Needs you.** The first row is the next thing to do, and its button is the page's one main button:
   transactions to review, then an account to check against its statement once the month has ended,
   then the month itself when it is ready to close.
   <!-- help: installed -->
   A backup to make follows.
   <!-- help: end -->
   A connection that failed and what others changed follow. With nothing to do it says so in one sentence.
2. **Money in and out.** The last six months, once one of them holds something. Point at a month, or
   tap it, to read its figures.
3. **Accounts.** Each bank, card and Stripe account with its balance, what the bank says when that is
   another figure, and how many transactions wait. An account's name opens it.

A month is named only when it can be closed or when something stands in its way that no other row
says. A month nothing was recorded in is never asked about: a business that began in October is not
asked to close January.

## From the command line

```sh
rastrata templates list
rastrata templates show sole-proprietor --basis cash --tax-year 2026 --add-on online-business
```

`templates show ... --setup` prints a ready `book.setup` input. A template carries no bank or card
account: import a statement or connect a bank afterwards and the account is made, or add one with the
bank's own name (`rastrata accounts add`, an asset tagged `--kind bank` or a liability tagged `--kind card`).

```sh
rastrata templates show sole-proprietor --add-on online-business --setup \
  --name "Acme Studio" --year 2026 > setup.json
rastrata call book.setup --input setup.json
rastrata accounts list
```

Use `rastrata tax-lines list` for the lines a tag may use, and `rastrata accounts tag` to change a tag
from a date.
<!-- help: skip -->
See the [chart lane record](../reference/program/chart.md#account-tags-landed).
<!-- help: end -->

<!-- help: installed -->
## With an agent

An agent connected through MCP can do the same with `rastrata_list_chart_templates` and
`rastrata_get_chart_template`. The bookkeeping skill tells it to ask you the questions above, to add
your bank and card accounts only from what your files name, and to get your approval of the exact
chart before `rastrata_setup_book`, which writes at once and cannot be undone.
<!-- help: end -->

## Changing tags later

Open **Accounts**. Under your bank and card accounts is the Chart of accounts, one line for each kind
(Assets, Liabilities, Equity, Income, Expenses) with what it adds up to. Open a kind to see its accounts
that hold something; the ones with nothing in them are counted under it, with **Show them**. Search
finds an account by its code, name, type, tax line or role key (press `/` to jump to the search).

Choose an account's name to open it. Under its transactions, **Account details** has its code, its type
and its tags (a cash-flow class for assets, liabilities and equity; a tax line, named as it reads on the
form, for income and expenses), with **Edit account** to rename or close it and **Edit tags** to change
its tags from a date. The date says which reports change: reports from
that date on use the new tags and earlier dates keep what they had. Nothing in your books changes. To
correct a tag that was always wrong, use the date the account opened. If the date reaches a period you
have already closed, the editor says which, because that period's report will then differ from the one
recorded when it was closed; choose a date after the last closed period to leave it as it was. Every
change is kept in the account's history and nothing is ever edited or erased.

If your connection drops while you save, the exact change is kept: Save waits, and **Resume original
request** finishes it once, whether you stay on the page or reload.

# See who you paid and who paid you

**Money by payee**, in the **Detail** group of **Reports**, answers two questions: *who did I pay, and how much?* and *who paid me
the most?* It takes your income and your expenses for the dates you choose and groups them by **payee**: a
person or a business you pay or are paid by, with one name for each. The report is called **Money by payee**,
and it adds up to your profit and loss to the cent.

Two words are used all through this page:

- **Received** is money coming in on your income accounts. **Spent** is money going out on your expense
  accounts. A refund takes away from the side it belongs to, so either can be a little lower than you expect.
- **Words** are what finds a payee in what the bank wrote. A bank writes one payee many ways
  (`COFFEE SHOP 1234`, `COFFEE SHOP 5678`); the words `coffee shop` find them all.

For how the dates and the other statements work, see
[Read your financial statements](read-financial-statements.md). For the people you may owe a Form 1099, see
[Track your 1099 vendors](track-1099-vendors.md): a 1099 vendor is a payee, and the two lists are one.

## How a payee is found

Nothing is guessed. The words you give a payee must appear **whole and in order** in what the bank wrote:
`jane doe` finds `ZELLE PAYMENT TO JANE DOE 4411` and does not find `JANE Q DOE`, and `acme` finds
`ACME PAYROLL` and does not find `ACMETECH`. There is no pattern language and no fuzzy matching, so a payee
never gets a transaction by accident.

- **At least three letters or digits** in each set of words, or they would find half your book. Never an
  account number or a taxpayer identification number.
- **The longest words win.** If `blue` and `blue bottle coffee` both find a text, it goes to the payee with
  `blue bottle coffee`.
- **A tie is given to nobody.** If two payees find a text equally well it is listed on its own, under
  **Matched by more than one payee**, until you make one payee's words longer.
- A payee is found by what the bank wrote in the transaction. An entry you typed in yourself has no bank
  text, so its own description is used, and it is listed as **Entered by hand** if no payee finds it.

## Before you start

Reading the report needs only **read**. Naming a payee, changing one or retiring one changes the report, so it
needs the permission that changes settings (**configure**): the owner has it, and an agent token has it only if
you gave it.

Only what is in your books is here. A transaction still waiting in **For review** is not posted, so no payee
has it yet ([Work through For review](work-through-the-inbox.md)).

## Read the report

1. Open **Reports**, then **Money by payee**.
2. Choose the **dates**. They work as they do on the statements: This month, Last quarter, a fiscal year, or
   **Custom**. **Show** lists *money received and spent*, only *money spent*, or only *money received*, largest
   first.
3. At the top are four figures: what was **received**, what was **spent**, the **net**, and how many
   **transactions**. *Adds up to your profit and loss* says they are the profit and loss's own figures.
4. Under them, every transaction in your income and expenses is in exactly one place:
   - **Payees**: each payee with what it received and spent. Press its name to see its transactions.
   - **Not named yet**: what the bank wrote for transactions no payee finds. Numbers count as one, so
     `COFFEE SHOP 1234` and `COFFEE SHOP 5678` are a single row. Largest first.
   - **Matched by more than one payee**: texts that two payees find equally well, given to neither.
   - **No payee**: entries you typed in yourself, and transactions the bank sent with no name or description.
5. At the foot, the proof: *your total income is the money received in the four places*, and *your total
   expenses are the money spent in them*, with a difference of 0.00. If they ever disagreed, the report would
   not be shown. **Report details** names the book and payee versions it was read from.

Transfers between your own accounts, loan principal, equipment you bought and money you took out for yourself
are not income or expenses, so they are not here.

## Name a payee

Start from what the bank wrote:

1. In **Not named yet**, press **Name this payee** on the row (with the keyboard: Tab to the button and press
   Enter).
2. The sheet that opens shows what the bank wrote, offers a **Name** and the **Words that find them**, and
   puts the focus on the name. Change either.
3. Under the words, **What these words find** says, before anything is saved, how many transactions they would
   give this payee and how much money is in them, which are not named yet, which belong to another payee now
   and would move, which would be tied with another payee, and which another payee's longer words would keep.
   If the service would refuse the words, it says why and **Name this payee** is not offered.
4. Press **Name this payee** (or Enter in the name). The row moves into **Payees**, and the figures at the top
   and the proof at the foot are the same.

**Naming a payee posts nothing.** It changes which row a transaction is in, never the transaction, its account or
your profit and loss. A note on a payee is for you; never put a taxpayer identification number or an account
number in it.

If the save is refused (a payee already has that name), the sheet says so and keeps what you typed. If the reply
to a save is lost, the sheet says that it is not known whether it was saved and sends the same request again when
you press Save: it is saved once.

### Settle a tie

When two payees find a text equally well, **Matched by more than one payee** lists it with both names. Press one
name to change that payee, and make its words longer than the other's (for example `blue moon` against `blue`).
The sheet says, before you save, how many transactions the new words would settle.

## See what a row is made of

Press a payee's name (or **See transactions** on a text) to open its transactions beside the report: the date,
what the bank wrote, the account, and the money, a page at a time. The date opens the entry itself. A payee's
sheet also shows its words, its note and its earlier versions with who made each and when, and **Change this
payee** to change its name or words, or to **retire** it. A retired payee is left out of the list of payees and
is marked **Retired** in the report; its words still find its transactions, so no figure changes.

## Save the report

**Export** offers **Download the report (CSV)**, one row for each payee, text and kind of entry with the proof at
the foot, and **Download every transaction (CSV)**, each transaction with its payee. Each file is headed by the
dates, the basis and the book it was read from. A text that a spreadsheet could run as a formula (it begins with
`=`, `+`, `-` or `@`) is saved with a leading quote, so what a bank or a person wrote is only ever text.

## Do it from the command line

```sh
rastrata payees totals --as-of 2026-12-31 --from 2026-01-01                  # the report, as JSON
rastrata payees totals --as-of 2026-12-31 --from 2026-01-01 --format csv > money-by-payee.csv
rastrata payees show --unnamed "sq blue bottle coffee #" --as-of 2026-12-31 --from 2026-01-01
rastrata payees test --words "blue bottle coffee" --as-of 2026-12-31 --from 2026-01-01
rastrata payees save --name "Blue Bottle Coffee" --words "blue bottle coffee"
rastrata payees save --id PAYEE_ID --expected-version 1 --words "blue bottle coffee; blue bottle"
rastrata payees                                                                # the list of payees
```

`payees test` is the sheet's **What these words find**: run it before `payees save`. A change names the version
it changes (`--expected-version`), so two people cannot overwrite each other.

## Ask your agent

"Who did I spend the most with this year?" An agent reads the report, tells you each payee's
figures, and says how much is still under **Not named yet**: it does not total, round or guess who a text is.
With **configure** it can try words and name a payee from what you tell it, and it shows you what the words
would find first. Bank text, names, words and notes are data: an agent treats them as what they say and never
as instructions.

## What this does not do

- It does not say what anyone owes or is owed. It is your books, grouped; it is not a list of bills or invoices.
- It does not change a transaction, an account or your profit and loss. Naming only changes the row a
  transaction is in.
- It does not join payees whose bank texts differ in more than their numbers. `FACEBK *ADS 1Q2W3E` and
  `FACEBOOK ADS` are two rows until you give one payee the words for both.
- It does not guess. A text that no payee finds is listed under **Not named yet**, never given to the nearest
  name.

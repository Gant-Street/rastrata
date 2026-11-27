# Get your books ready for tax time

The **Taxes** screen reads your books by tax line, tells you what is not ready, and packs the year's files for
whoever prepares your return. It is a worksheet and a set of checks, not a return.

<!-- help: skip -->
**Rastrata books and reports. It does not give tax advice, choose a tax line for you, file anything or
predict what you owe.**
<!-- help: end -->
Every figure here is your own books, totalled the way the form groups it. Whether
something is deductible, which form you file and what you owe are for you and the person who prepares your
return. Rastrata has verified the IRS forms and rules for tax years **2025 and 2026** (the screen lists the
years it offers).
<!-- help: skip -->
The lane's [verification record](../reference/program/tax.md#verification-record-what-was-read-from-the-irs-and-when)
says what was read, where and when.
<!-- help: end -->
<!-- help: skip -->
For why it is built this way, see
[What the tax tools do, and what they leave to you](../explanation/what-the-tax-tools-do.md).
<!-- help: end -->

This guide covers the web app first, then the command line and an agent. Two further tools have guides of
their own: [Track your 1099 vendors](track-1099-vendors.md) and
[Work with your accountant](work-with-your-accountant.md).

## Before you start

Nothing below stops you from building a pack: the checks say what they know and you decide. It is still worth
doing the things they ask about first.

1. **Tag your accounts with a tax line.** The chart templates tag the accounts they create. An account you
   added yourself has no tax line until you give it one on **Accounts** (open the account, then **Account details**, **Edit tags**)
   ([Charts, templates and tags](set-up-your-books.md)). Rastrata never guesses a line.
2. **Reconcile** your bank and card accounts to the last day of the year
   ([Reconcile an account](reconcile-an-account.md)) and **work through For review**
   ([Work through For review](work-through-the-inbox.md)), so every transaction dated in the year is in the books.
3. **Close the year**, if you and your accountant want it locked
   ([Close a fiscal year](close-a-fiscal-year.md)). A pack built before the close says that it was; one built
   after says the year is closed.

## Read the checks and the worksheet in the web app

1. Open **Reports** in the main navigation; the tax tools are its **Tax time** group. Choose **Tax worksheet**. It opens on the year your book's calendar covers that is nearest the
   current date. Use **Tax year** to look at another; the **Form** and **Business meals taken** choices for the
   worksheet and the pack are on the same row. A year the book's calendar does not cover says so and links to
   the calendar: the tax tools work on whole calendar years the book has. Under each tool's title one sentence
   says what the tool is. The page explains nothing else: what the checks mean, how a figure is read and what a
   pack leaves out are in this guide.
2. Under the year are the **checks**: what is worth knowing before you rely on a figure. They are about your
   books, not about a return, and there are three kinds, so that a normal book in a normal month shows nothing
   orange:
   - **Orange** is a check where acting would change these figures. Transactions dated in the year that are still
     in **For review** are not in the figures until they are posted ("4 transactions dated in 2026 are still in
     For review, so they are not in these figures"); an account with activity and no tax line is on no line of
     the form; a sales tax account that disagrees with Stripe. Each is one sentence and a link that says what it
     fixes ("Review 4 transactions", "Add the missing tax line"), never "Go and fix it".
   - **Notes**, in plain text, are facts about the figures: the books start part-way through the year, and, on
     the worksheet and the pack (where the form is chosen), that the year's form is an IRS early-release draft
     whose line numbers should be confirmed against the final form. That a year is not over is not said: figures
     for a year still running are the figures so far.
   - **Good practice before you file** is one grey line, closed, with how much of it is done ("3 of 5 done"):
     the months are closed, the bank and card accounts are reconciled, the 1099 vendors are decided. Open it to
     see what is left first. Doing these protects the books; none of them changes a figure.

   A check that could not be made is never shown as done: it says **Could not be checked** and links to where to
   find out. The checks are observations about your books, not decisions about a return.
3. The **Tax worksheet** totals your accounts by the line of the form they are tagged with. **Form** is chosen
   from your tags (Schedule C for a sole proprietor, Form 1120-S, or Form 1065; cost of goods sold also shows
   Form 1125-A) and you can switch it. **Business meals taken** is 50% unless you are under the Department of
   Transportation's hours-of-service limits, where the IRS instructions give 80%. The books keep the full cost
   of a meal; the worksheet says how much it left off the form.
4. Read the table against what you know. **Show the accounts behind** a line lists the accounts that make it
   up, and each links to its activity in the ledger for the same dates, checked against the same version of the
   books (the ledger page says if the books have moved since), so you can follow a figure to the entries behind it.
5. **Accounts with no line on this form** lists every income and expense account that has activity and no line,
   with its amount and why. Their amounts are on no line above and none was guessed. Tag them on **Accounts** (open the account, then **Account details**, **Edit tags**), or take the list
   to your accountant. When every account with activity has a line, the section is not on the page.
6. **Ties to the profit and loss** walks from the form's net figure to the net income on the profit and loss
   for the same dates: less the meals the form leaves off, plus the income and less the expenses of accounts with
   no line from this form. The worksheet is the profit and loss regrouped, and the service refuses to answer if
   the two do not agree to the cent, so a worksheet on screen always ties.
7. **Download the worksheet (CSV)**, **the accounts (CSV)** and **every posting (CSV)** save the same figures
   as spreadsheets, each headed by the book revision and dates it came from.
8. **Notes and sources**, at the foot, opens what stands behind the figures: how business meals, inventory,
   sales tax you collect, returns and a loss are treated on this form, each with the IRS page the rule was read
   from and the day it was read, and the form's own sources.

The worksheet is your books totalled by the tax line each account is tagged with.
<!-- help: skip -->
It does not decide what is deductible, work out any tax or fill in a return.
<!-- help: end -->
Lines that depend on facts the books do not hold, such as car and truck expenses, depreciation and the home
office, are only as complete as the entries behind them.

## Build the year-end pack

1. Go back to **Reports**, open **Year-end pack** and press **Build the pack**.
2. The page lists every file with what it is and its size: the README, the year's statements
   (profit and loss, balance sheet, cash flow, trial balance, general ledger), the worksheet files, the 1099
   vendor files, the sales tax files when an account is tagged for sales tax, and `manifest.json`. Every file
   comes from one version of the books. Open **Pack details** at the foot to see which (the book revision),
   the SHA-256 of the manifest, with a Copy button, and of each file.
3. **How final it is** says whether every period in the year is closed with a current close, which are still
   open, and which are locked with a close that a reopening superseded. Read it before you send the pack.
4. **What is not in it** is listed in the pack's README: a return or any form to file, what you owe,
   anything not in your books (bank activity you have not posted, cash you did not record, inventory counts,
   depreciation schedules) and advice about which tax line anything belongs on.
5. **Download the pack (zip)** saves one zip, named for the year (`rastrata-year-end-2026.zip`). The same
   pack is the same zip, byte for byte.
6. A pack is the books as they were at the revision it names. When the page reads the books again and they
   have moved on (you saved a vendor, or posted something), it marks the pack as no longer current and offers to
   build it again; a pack already saved is never changed.

### Check a pack later

A pack on a drive or in an email is only worth what it still matches. From a terminal:

```sh
rastrata tax verify-pack rastrata-year-end-2026.zip
```

The command works offline, on the folder or the zip, and compares every file with the manifest. It says what
changed, what is missing and what is not listed, and exits with 3 if anything differs.

The manifest lists every file in the pack with its SHA-256, and **Pack details** shows the manifest's own. The
same books, year and choices always give the same pack, so anyone can check that a pack is the one that was
made.

## Read the sales tax summary

**Sales tax**, under **Reports**, **Tax time**, shows what your books recorded in the liability account tagged
`tax.sales`: for each month, quarter or the whole year, the balance at the start, what was collected (credits),
what was paid or returned (debits) and the balance at the end. Each period opens the account's activity for its
dates.

- **If no account is tagged**, the page says so and lists the liability accounts that could be the one. Tag it
  on **Accounts** (open the account, then **Account details**, **Edit tags**). If you collect no sales tax there
  is nothing to do.
- **The books cannot tell** a payment to a state from a refund of tax to a customer or a correction, so the
  column reads "Paid or returned" and every debit is in the postings file with its entry.
- **Where the book uses Stripe**, three more columns compare what the account took from the payouts booked in
  the period with what Stripe reported on the same payouts. Where Stripe reports the tax on a payment, that
  figure is booked to the account; where it reports none, the whole amount is booked as sales and the charge is
  counted as having no tax figure. A difference means an entry was changed or reversed after the payout was
  booked.
- **Periods** are calendar months, quarters or the whole year, cut by the date of each entry.
- **Download the summary (CSV)** and **Download every posting (CSV)** save the same figures.

<!-- help: skip -->
Rastrata does not know your sales tax rates, which of your sales are taxable, which states or cities you must
collect in or file with, whether you file monthly, quarterly or yearly, or when a return is due. You or your
accountant decide what is owed and file the return.
<!-- help: end -->

## Do it from the command line

```sh
rastrata tax checks --year 2026
rastrata tax worksheet --year 2026                        # JSON; --format csv --file worksheet|accounts|postings
rastrata tax worksheet --year 2026 --form form1120S --meals-percent 80
rastrata tax pack --year 2026 --out ./year-end-2026       # a folder, or a name ending in .zip
rastrata tax verify-pack ./year-end-2026
```

`tax pack` writes the files to a folder, or to a zip when the name ends in `.zip`, and never over something that is
there: it refuses a folder that already holds files and a zip that already exists. It prints the number of files,
the manifest's SHA-256 and how many checks need a look, and says on the error stream that the pack is not tax
advice and whether the year is closed. Pin `--revision` and `--tags-revision` to rebuild an old pack exactly.

## Ask your agent

An agent with a token that can read can start with the checks and the worksheet. Ask: "Is my 2026 ready for
tax time? Tell me what needs a look, and don't change anything." It reads the checks and the
worksheet, tells you what each check says, and names accounts with no tax line without choosing one for you.
It builds the pack and repeats what the pack says about how final the year is
([Connect your agent](connect-your-agent.md)).

## If something looks wrong

- **A figure differs from your accountant's.** Open its activity from the worksheet and compare the entries.
  The worksheet is the sum of the accounts tagged with the line, on each posting's own date, on the book's basis.
- **An account is on the wrong line.** The tag is changed on **Accounts** (open the account, then **Account details**, **Edit tags**) and takes effect from the
  date you give; the worksheet reads each posting with the tag that applied on its date.
- **The pack says some periods are open.** That is a fact about the calendar, not an error. Close the year
  ([Close a fiscal year](close-a-fiscal-year.md)) and build the pack again.
- **The screen says the books have changed since the pack was built.** Build it again; the page never shows an
  older pack as current.

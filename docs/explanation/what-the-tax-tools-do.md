# What the tax tools do, and what they leave to you

Rastrata has a Tax screen, a handful of commands and tools for an agent, and a set of files it builds for
whoever prepares a return. This page explains the thinking behind them: what they claim, what they refuse to
claim, and the choices that follow. For the steps, see
[Get your books ready for tax time](../how-to/get-your-books-ready-for-tax-time.md),
[Track your 1099 vendors](../how-to/track-1099-vendors.md) and
[Work with your accountant](../how-to/work-with-your-accountant.md). For what was read from the IRS, where and
when, see the lane's [verification record](../reference/program/tax.md#verification-record-what-was-read-from-the-irs-and-when).

## The line it draws

**Rastrata books and reports. It does not give tax advice, file anything or predict what anyone owes.** That is
one sentence, and it is in every file the tax tools write and in what an agent is told to say. A screen does not
repeat it: each tool says in one sentence what it is, and what it is not is here and in the how-tos.

The reason is not caution for its own sake. A set of books is a record of what happened: money in, money out,
which account each belongs to. A return is a set of decisions about what those facts mean under rules that depend
on the kind of business, the year, the state, elections the owner made and facts the books do not hold. A tool
that blurs the two does harm in the quiet way: it shows a figure in a box that looks official, and a person
trusts it. So the tools do the first part as well as they can, and say where the second begins.

What they can do is considerable. They regroup the books by the line of the form each account is tagged with,
tie that regrouping to the profit and loss to the cent, say what is not ready, count payments against a threshold,
and put everything in files that agree with each other and with the books they came from. Every one of those is a
statement about the books.

## The worksheet is the profit and loss, regrouped

A tax worksheet totals the accounts by the **tax line tag** each carries (a Schedule C line, a Form 1120-S line, a
Form 1065 line). It is built from the same posted journals as the statements, by the same code, so it is not a second
opinion about the books. The tags are dated: a posting counts under the tag its account had on the posting's own
date, so changing a tag later changes the years from that date and leaves earlier years alone.

Two properties matter more than any feature:

- **It ties, or it is not shown.** The net on the worksheet, plus the income and less the expenses of accounts with no
  line from this form, is the profit and loss's net income. Every term is exact cents. If it does not tie, the
  service refuses to answer; it never shows a worksheet with a difference in it.
- **It never guesses a line.** An account with activity and no line from the form is listed with its amount and why
  it has no line (no tag, a tag of another form, a line this year's form does not have). Nothing is put on a line
  to make the totals look complete. Which line an account belongs on is a decision for the owner and whoever
  prepares the return.

Where the form itself asks for something the books do not hold, the worksheet says so rather than approximating:
inventory (Schedule C lines 35 and 41, Form 1125-A lines 1 and 7) shows 0.00 and a note says the books do not know
it. Business meals are a good example of what the books do know: they keep the full cost, and the worksheet applies
the percentage the IRS instructions give (50% in most cases, 80% under the Department of Transportation's
hours-of-service limits) and says how much it left off, so the difference is visible and nothing is lost.

A year's form can be an IRS early-release draft rather than the final form. The worksheet says so, and a check flags
it. For 2026 the instructions for Schedule C had not been published when this was read, so the meals text is the 2025
rule and the worksheet says that too.

## "Could not be checked" is never "fine"

The screen opens with checks: are the periods closed, is anything still waiting in the Inbox, are the bank and card
accounts reconciled, do accounts with activity have a line, do vendors need a decision, does the sales tax account
agree with Stripe. A check has three states in words, and the third matters most. When Rastrata could not make a
check (a service it needed could not be read, nothing is tracked, no account is marked) it says *Could not be
checked*. It is counted among the things that need a look, and it is never shown as fine. A readiness list that
shows green for a check it did not make is worse than none.

## A pack is one version of the books, said plainly

The year-end pack is a folder of files: the statements, the worksheet and its accounts and postings, the 1099 and
sales tax lists where they exist, a README and a manifest. Three decisions shape it.

**One version.** Every file is read from the same book revision, and the manifest records that revision, the tag
map and the report populations the figures came from, with each file's size and SHA-256. A person can check the
files against the manifest offline (`rastrata tax verify-pack`) without Rastrata, and can trace a figure to its
entries because the populations match the ones the Reports and ledger screens use.

**Deterministic.** No file contains a clock reading or a name chosen by the machine, and the zip stores its files
with a fixed timestamp. The same books, tags, dates and form give the same bytes, and pinning the revision rebuilds an
old pack exactly. A pack that changes when nothing changed cannot be compared with another.

**It says how final it is.** A year can be closed (its periods locked, with a close recorded for each), part closed,
or open, and a close can have been superseded when someone reopened a period. The pack says which, in the words the
Periods screen uses, with the revision and report population of the last close. It does not call a year final, and
it does not guess. A pack built before a close is the books before it, and the page marks it as no longer current once the books
move on.

Inside the pack, the README lists what is **not** in it: a return, a computed tax, anything not in the books, advice.
A file that says what it leaves out is harder to mistake for more than it is.

## 1099 vendors: counting what the books can know

The 1099 list asks a narrow question: how much was each person paid in the year, from the accounts the owner says
hold payments that may need a form, and how does that compare with the IRS threshold? The IRS pages read for this
give $600 for payments made before 2026 and $2,000 for payments made in 2026, and publish no figure beyond that, so
the tools offer 2025 and 2026 and say so for any other year instead of carrying a number forward.

Some choices follow from what a bank line can and cannot say:

- **Only marked accounts count.** Nothing is counted because it looks like a contractor. The owner marks the accounts,
  with a suggestion drawn from the lines the IRS instructions tie to 1099 reporting, and that is a hint.
- **Payment method is not knowable from the bank.** The IRS says payments by credit or debit card or through a payment
  app are reported by the processor on Form 1099-K, not by the payer. A bank line for a debit card payment looks like
  any other. So a payment from a card account is left out, a vendor can be recorded as paid by card, and until a
  vendor's payment method is confirmed a total at or over the threshold is flagged as not certain. The tool would
  rather say "not certain" than state a total it cannot stand behind.
- **Matching is plain.** A vendor is found in a bank line by words that appear whole and in order, longest first, and
  a tie gives the payment to nobody. There is no pattern language and no fuzzy matching, because a wrong match is a
  wrong total and the owner has to be able to see why a payment went where it did.
- **No taxpayer identification number, ever.** There is no field for one and a request that names one is refused. A
  list of names and totals is useful to an accountant; a database of identification numbers is a liability the tool
  has no business creating. The W-9 is recorded as received or not and when, never what it says.
- **Who decided is kept.** A vendor's record is append-only: every change is a new version with who made it and when,
  so a decision about whether someone needs a form can be traced to the person who made it.

## Sales tax: what the books recorded, and nothing about what is owed

The sales tax summary reads the liability account the owner tagged `tax.sales`: its balance at the start of each
period, what was credited (collected), what was debited (paid or returned) and the balance at the end, tied to the
ledger. Where the book uses Stripe it also shows what Stripe reported as tax on the payouts booked in the period, and
a difference means an entry was changed after the payout was booked.

Rastrata does not know sales tax rates, which sales are taxable, where a business must file or when a return is due.
The files it writes say so in plain words, and so does the how-to. A debit to the account could be a payment to a state, a refund
of tax to a customer or a correction, and the books cannot tell which, so the summary says "paid or returned". The
person or their accountant decides and files.

## The accountant: drafts, as a set

The hand-off goes two ways. The pack the accountant receives is plain files (the chart, every journal with where it
came from, the trial balance and ledger, a header-only template), so they can open it without Rastrata, and the
provenance columns say where each entry came from: for a bank line, the provider, account and transaction, and the
bank's own words.

What comes back is a CSV of adjusting entries, and the import is built around not trusting it:

- **Drafts, never postings.** An import creates drafts for the owner to read. Posting stays a separate act with its
  own permission, so a file from outside the building cannot change the books by being imported.
- **A set, not a pile.** Any problem anywhere refuses the whole file. An accountant's entries belong together, and half
  of them can be worse than none. The preview says exactly what is wrong, row by row and column by column, and a person
  fixes the file; nothing is repaired by guessing.
- **The same file twice makes nothing new.** An entry's identity is its id: the same id with the same figures is
  "already imported" and the same id with different figures is a conflict, which is refused with a message to give the
  corrected entry a new id. The ledger itself guarantees a source posts only once, so this holds even if a file is
  renamed or its lines are reordered.
- **What was shown is what is imported.** The import carries the fingerprint of the preview and checks it inside its
  own transaction. If the file or the books changed in between, nothing is imported.
- **The file is hostile data.** It may be huge, malformed, written for another locale or aimed at a model. Dates are
  year-month-day only and amounts are plain two-place decimals only, because `03/04/2026` and `250,00` mean different
  things in different places and a guess is a wrong entry. Cells are reduced to plain text, text that a spreadsheet
  could run as a formula is neutralised wherever a file is written, an account is only ever the chart's own, and
  nothing in the file is run or opened.

## What this costs

- **Two years only.** The forms and rules were read for 2025 and 2026. A third year needs someone to read the new forms
  and add them; the tools say a year is unsupported rather than reuse last year's lines.
- **Three forms only.** Schedule C, Form 1120-S and Form 1065, with Form 1125-A for cost of goods sold. The forms'
  other schedules (Form 4562 for depreciation, for one) and the rest of a return are outside it.
- **A worksheet needs tags.** The chart templates tag the accounts they create; anything else waits for a person to
  choose. That is a deliberate cost: a worksheet that guessed would be quicker and wrong in the way that is hardest to
  find.
- **A pack is only as complete as the books.** Bank activity not yet imported, cash not recorded, inventory counts and
  depreciation are not in it and the README says so.
- **Some rules were not verified.** The statute section that raised the 1099 threshold was named by one search summary
  and by none of the IRS pages read, so the product cites the pages and not the section. Anything else that could not
  be confirmed is listed in the verification record and is not stated by the product as a rule.

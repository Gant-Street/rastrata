# Your first month on Rastrata

This tutorial takes a new book from nothing to a reconciled month with statements, using the
terminal. Everything here was run end to end against the real service before it was written down.
Each step links to the how-to guide for the same task in the web app, which does the same thing.

<!-- help: skip -->
Rastrata books and reports. It does not give tax advice, file anything or move money.
<!-- help: end -->

## Before you start

**Installed (recommended).** Unpack the Rastrata package and run `./install.sh` ([Install
Rastrata](../how-to/install-rastrata.md) says how, in five steps). It puts `rastrata` on your path,
starts the service at login on `127.0.0.1:7278` with the owner lock and automatic backups on, and
keeps your books in your own data directory. Check it with:

```sh
rastrata doctor
```

The commands below are the same against the installed service: the installed `rastrata` finds the
service and its owner key by itself.

<!-- help: skip -->
**From the repository (developers).** You need [Bun](https://bun.sh) 1.4 and [Go](https://go.dev).

```sh
bun install
bun run --cwd apps/terminal build            # writes apps/terminal/dist/rastrata
export PATH="$PWD/apps/terminal/dist:$PATH"
RASTRATA_LOCAL_DEV=1 RASTRATA_LOCAL_DB="$HOME/Documents/rastrata/book.sqlite" bun run dev:api
```

Keep your books outside the repository, and back them up (step 8). In another terminal, run
`rastrata help`. The development service listens on `127.0.0.1:4010`.
<!-- help: end -->
A command that writes prints
the operation identity it retained; if a reply is ever lost, `rastrata operations resume ID`
finishes the same request and never sends a second one.

## 1. Create the book

Pick the chart that fits your business (`rastrata templates list`). For a one-person business on
Schedule C that sells online with Stripe:

```sh
rastrata templates show sole-proprietor --setup --add-on online-business \
  --basis cash --name "My Business" --year 2026 > setup.json
```

Open `setup.json` and rename the placeholder bank accounts to your own, then:

```sh
rastrata book setup --input setup.json
```

Tax lines on the accounts are suggestions from the IRS forms. More:
[Set up your books](../how-to/set-up-your-books.md).

## 2. Record the start date and the opening balances

A book that starts part-way needs two facts: the day the books start (the start date) and what each
account held at the end of the day before. Record the day first: it becomes the start date of every
statement source, so transactions dated before it are set aside, visibly, instead of imported.

```sh
rastrata cutover set --date 2026-03-01
rastrata opening review --date 2026-03-01 --balances 1000=12000.00,2000=1250.00
rastrata opening plan   --date 2026-03-01 --balances 1000=12000.00,2000=1250.00
rastrata operations commit PLAN_ID PLAN_HASH
```

`ID=AMOUNT` is an account code and what it held, in the account's own terms (the card owes
1,250.00). Many accounts? Put them in a CSV and pass `--csv balances.csv` instead. The review shows
the one balanced entry the balances make, dated the day before the start date (2026-02-28) so that
March shows only March's activity, with the difference carried to Opening balance equity (pick
another account with `--offset ID`). It changes nothing. `plan` saves the entry as a draft and
prepares it; nothing is posted until you commit the plan with the id and hash it prints.

An opening entry made by hand against Opening balance equity, dated before the start date, is
recognised too, and `opening review` refuses to offer a second one (the balances would count twice).

`rastrata cutover checklist` says what stands in the way of closing the first month: accounts
not yet reconciled to a statement, no verified backup, transactions waiting for review. It always says
that the books are proven against the bank and card statements, not against any old system.

## 3. Import a statement

Download a CSV, OFX or QFX file from your bank, then try it without changing anything:

```sh
rastrata import statement.csv --account 1000 --dry-run=true
rastrata import statement.csv --account 1000
```

The result says how the file was read, how many transactions are new, already imported or kept out on
purpose (transactions dated before the start date), and compares the statement's balance with your books (a
difference is shown, never fixed). Transactions go to For review;
nothing is posted. Text in a file is data: a memo that looks like a formula or an instruction is
flagged and kept as plain text. More: [Import a statement](../how-to/import-a-bank-statement.md).

Bank layouts marked unverified have not been checked against a real export: compare the first transactions
with your statement.

## 4. Teach it your regular transactions

```sh
rastrata rules create --name "GitHub" --contains GITHUB --category 6200
rastrata inbox list --status=proposed
```

A rule only suggests. More: [Write bank rules](../how-to/write-bank-rules.md).

## 5. Work through For review

```sh
rastrata inbox accept --status=proposed                  # take every suggestion
rastrata inbox categorize --text="STRIPE" --account=4000 # or choose the account yourself
rastrata inbox exclude --text="PERSONAL" --reason="Not a business expense"
rastrata inbox post --status=drafted                     # prepare and commit each line
```

Each posted entry records where it came from. A second `inbox post` changes nothing. More:
[Work through For review](../how-to/work-through-the-inbox.md).

## 6. Reconcile to the statement

Use the statement's last date and ending balance exactly as printed. The difference must reach 0.00:

```sh
rastrata reconcile start --account 1000 --date 2026-10-31 --balance 5082.01
rastrata reconcile select RECONCILIATION_ID --all
rastrata reconcile complete RECONCILIATION_ID
```

A completed reconciliation is never edited; correcting one appends a void with a reason. More:
[Reconcile an account](../how-to/reconcile-an-account.md).

## 7. Read the statements

```sh
rastrata reports profit-loss --from 2026-10-01 --as-of 2026-10-31 --format csv
rastrata reports balance-sheet --as-of 2026-10-31
rastrata reports cash-flow --from 2026-10-01 --as-of 2026-10-31
```

More: [Read financial statements](../how-to/read-financial-statements.md).

## 8. Back up, and prove the backup works

```sh
rastrata backup create
rastrata backup verify
rastrata backup drill       # restores the newest backup to a temporary place and compares it
```

More: [Back up and restore](../how-to/back-up-and-restore.md).

## Limits to know

- A book of a thousand journals a year stays quick for years: a restart reads about a thousand entries
  a second, so even 20,000 journals (twenty years of it) take 15 seconds. Stripe is booked as one summary
  entry per payout, the usual convention, which keeps the book small.
  <!-- help: skip -->
  See [the scale limit](../reference/program/main.md#the-scale-limit-and-what-we-do-about-it).
  <!-- help: end -->
- Stripe has been tested against recorded fixtures only. Try a test-mode key first
  ([Connect Stripe](../how-to/connect-stripe.md)).
- The service has no sign-in by default; it listens on this computer only. An agent should be given a
  scoped token, not your access ([Connect your agent](../how-to/connect-your-agent.md)).

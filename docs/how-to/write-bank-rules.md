# Write rules for recurring transactions

A rule suggests the same category for the same merchant every time. You write it once, and every later
transaction that matches it arrives in For review with a suggestion and the reason for it. A rule only
suggests: nothing is recorded until you accept the suggestion in For review, and it then goes through
the same path as any entry.

This guide takes you from a transaction in For review to a rule you have checked against your own books,
then shows how to order, change and retire rules, and how to read the local classifier that handles what
rules do not. You need a configured book with some transactions in For review or some posted history (see
[Import a statement](import-a-bank-statement.md)).

## 1. Start from a transaction

The easiest start is a transaction you have just categorized. Its pane in For review links to **Create a
rule from this transaction**, which opens the rule editor at `/rules/new?item=ITEM_ID`; you can open that
address yourself with any For review transaction's id. Rastrata drops what changes from month to month
(numbers, dates, reference ids, payment-rail words, trailing cities) and keeps the part that stays, so
`GITHUB, INC. SAN FRANCISCO CA 4829104` becomes "description contains github". If you had already
recorded the transaction, the rule suggests that category too, and it says what earlier transactions like
it were recorded to. A transaction that cannot be read starts a blank rule, and the editor says so.

You can also open **Transactions**, then **Rules** (beside **Import a statement** in the header), and choose **New rule** (Search finds **Bank rule** too),
or, from a terminal, generalize a transaction yourself:

```sh
rastrata rules suggest --description "GITHUB, INC. SAN FRANCISCO CA 4829104" --amount -21.00
rastrata rules suggest --item ITEM_ID --category ACCOUNT_ID
```

The suggestion is a draft; nothing is saved until you create it.

## 2. Say when a transaction matches

Under **When a transaction**, each condition tests one thing about a bank transaction:

| Test | How | Notes |
| --- | --- | --- |
| Description, counterparty, reference | contains, is exactly, starts with, ends with, contains the word (and the "does not" form of each) | Compared without regard to case, accents or punctuation, so `Github, Inc.` and `GITHUB INC` are the same. |
| Amount | is between, at least, at most, exactly (and the "not" forms) | The size of the amount in exact cents, whether money comes in or goes out. Both ends are included. Use a direction test for the sign. |
| Direction | is money in / money out | |
| Account | is a bank or card account | The account the transaction is on. |
| Source | CSV, OFX, QFX, a bank connection, Stripe | Where the transaction came from. |

There are no regular expressions. Type the words to look for. "Contains the word `aws`" matches
`AWS EMEA` and not `LAWS OF MOTION`; "contains `aws`" matches both.

With several conditions, choose whether **all** or **any** of them must hold. A **group** nests one
level, for the cases that need both: for example, an amount of at least 100.00 **and** (the
description contains `aws` **or** `google cloud`).

Under **Applies to**, tick **Only some accounts** to limit the rule to transactions on those accounts.
Left alone, a rule applies to a transaction on any account.

## 3. Say what to suggest

Under **Then suggest**, choose one:

- **Put it in a category.** The transaction is recorded against the account you choose.
- **Split it across accounts.** Give each part an account and what it takes: a percentage of what
  remains, a fixed amount, or the rest. Fixed amounts come first, percentages divide what remains,
  and the part that takes the rest gets any cents the rounding leaves, so the parts always add up
  exactly. The editor shows the exact parts for an example amount.
- **Treat it as a transfer between my accounts.** For a card payment or a move to savings; choose the
  other account.
- **Set it aside, out of the books.** For something that is not a business transaction, with a reason
  that is kept with the decision.

The **description for the entry** is the text on the entry. Use `{merchant}`, `{description}`,
`{counterparty}`, `{reference}`, `{date}` and `{amount}`; the buttons under the box insert them where
the cursor is, and `{{` writes a literal `{`. It is only ever filled with text; nothing in it is run.
Under the box the editor shows how it reads on the first matching transaction.

## 4. Read the check before you save

Beside the form, **What this rule would do** counts, as you type, what the rule would match in For
review and in your posted history over the last 30, 90, 180 or 365 days:

- **Matches 14 of the 212 transactions.** The whole point of the check: a rule that matches nothing is
  probably wrong, and one that matches far more than you expected is too broad.
- **N of the M matching posted transactions were recorded where this rule would record them.** Past
  decisions are the best evidence you have. If some were recorded somewhere else, those samples say
  **Recorded elsewhere** and show where. Either the rule is wrong, or those transactions were.
- **Transactions that match but an earlier rule decides first**, and **transactions the rule cannot be
  applied to** (an account since closed), each with a reason.
- **Samples**, showing the entry the rule would suggest for each matching transaction.

The check changes nothing. When the rule is not finished it says so and waits.

**Try a transaction** lets you type or paste a description and an amount (for example, a memo from an
email) and see what the rule does with it: whether it applies, which conditions held and which did not,
and the entry and description it would suggest. What you paste is only compared; it is never run.

## 5. Put the specific rule above the general one

The first enabled rule that matches a transaction decides, so order is the point of the **Rules**
screen. Each row shows its position, its name, **When** it applies and **Then** what it suggests, in words,
**Used** (how often it matched), and a switch. Under the name it says who made it: **You**, or the agent's
name. **Performance** under **Used** opens three counts over the transactions waiting in For review and the
last 90 days of posted history:

- **Matched**: the transactions its conditions match.
- **Decided**: the transactions it decides, because it is the first enabled rule to match.
- **Overridden**: transactions it matches that an earlier rule decides instead.

A rule that matches nothing is dead; a rule that decides nothing is hidden behind an earlier one.
One line under the title says how many of the recent transactions a rule decides, and **How the rules are
doing**, under the list, has the counts behind it.

Change the order with the move buttons on a row, or press **Alt with the up or down arrow** on any
control in the row. Each move is announced and saved; a reply that is lost is resumed, never sent
twice.

From a terminal:

```sh
rastrata rules list --usage                      # in order, with what each matched and decided
rastrata rules move RULE_ID --to 1               # position 1 is decided first
rastrata rules reorder ID1 ID2 ID3               # set the whole order
```

## 6. Edit, switch off, delete

Open a rule from the list to edit it. Every save is a new revision, and the **History** at the bottom
says who made each one (a person, or an agent and its name), when, and which parts changed. If the
rule changed while you were editing, you are told and nothing is overwritten.

- **The switch** in the list turns a rule off and keeps it, so you can turn it on again. Prefer it when
  you may want the rule back.
- **Delete** retires a rule: it stops suggesting at once, its history stays readable, and it cannot
  be switched back on. You can say why.

A rule that has problems today (it suggests an account that has since closed, say) says **Needs
attention** in the list, with the reason. It stays where it is and proposes
nothing until you fix it, rather than letting a rule below it decide.

## 7. From a terminal, or for an agent

Agents write rules instead of judging every transaction. Everything above is available as `rastrata rules`
commands:

```sh
rastrata rules suggest --description "AWS EMEA SARL LUXEMBOURG 5599" --amount -50.00 --category 6200 > rule.json
rastrata rules test --input rule.json --try-description "AWS EMEA 9001" --try-amount -12.40
rastrata rules create --input rule.json --agent "Claude"
```

`rules suggest` prints a draft that `rules test` and `rules create` accept as they are. Test before
you create: `agreement.differed` should be near zero. A rule made with a scoped agent token is always
recorded as made by that agent; a rule made with the owner's own access says who made it with
`--agent NAME` (or `RASTRATA_AGENT`), and is recorded as a person if nothing is said. Either way it
is a record for a reviewer, not an access control.

## 8. The local classifier

For transactions no rule decides, the **Suggested accounts** card on the Rules page suggests the
account similar transactions went to before. It learns from your own posted transactions and your
decisions in For review, and calls no model. Like a rule, it only suggests. The
card appears once it has learned something; on a book with nothing posted, the Rules page is the list
of rules alone.

- The classifier learns again by itself when For review is opened after transactions were posted or
  decided, so there is nothing to press; the card says when the book has moved on since it last
  learned. The one exception is a history too long to learn from on its own at once (more than 5,000
  transactions, after a large import): the card says so, and **Train now** learns from all of it.
  From the command line, `rastrata classifier train` does the same in any state.
- **How well it does on your books** replays your own history in date order: each transaction is suggested
  for by a classifier that had learned only from the transactions before it. **Right when it suggests** is
  precision (right suggestions among those made); **Transactions it got right** is recall. The counts are
  exact. "If you only trusted the surest suggestions" shows the trade-off at each confidence; **By
  account** and **What it gets wrong most often** show where it is weak. The figures are shown once
  there are transactions to score.
- **When it may suggest** are the thresholds. Raising them makes it quieter and more accurate;
  saving them measures the classifier again so the figures belong to the settings in force.
  <!-- help: skip -->
  Defaults are in [the explanation](../explanation/rules-and-the-classifier.md).
  <!-- help: end -->

With too little history it says it is not ready rather than guessing. A confidence orders
suggestions; it is not a promise. Trust the figures measured on your own books.

It does not count words that most of an account's transactions share, such as your own account's name when
the bank writes it into every row, and a transaction with nothing else it recognises gets no suggestion. If
one payer or merchant makes up most of an account's transactions, that is a job for a rule.

```sh
rastrata classifier status
rastrata classifier train
rastrata classifier evaluate --min-agreement 95   # what a stricter setting would have done
rastrata classifier configure --min-agreement 95
```

## What to check

1. Create a rule from a transaction and read the check. The numbers should be ones you can explain.
2. Put a general rule below a specific one and look at **Overridden**.
3. Try a transaction you know should not match.
4. Make a deliberate mistake (a split that adds up to 90 percent): the editor lists the problem and
   links to it, and nothing is saved.
5. Run `rastrata rules list --usage` and compare it with the screen: they are the same
   measurement.

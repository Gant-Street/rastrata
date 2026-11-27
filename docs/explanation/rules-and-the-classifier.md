# Rules and the local classifier

Most bank lines are the same decision made again: the same merchant, the same account. Rastrata's
position is that a person (or an agent) should make that decision once, as a rule that can be read,
tested and changed, and should not judge every line. This page explains how rules and the local
classifier work, why they are built the way they are, what they measure about themselves, and where
they stop. The practical steps are in [How to write rules for recurring
lines](../how-to/write-bank-rules.md).

Rules, the classifier and the starter list only ever **suggest**. They are registered as proposers with the
Inbox's registry (see [the ingestion pipeline](ingestion-pipeline.md)); a suggestion becomes an entry only
when a person, or an agent with the right grant, accepts it, and it then goes through draft, prepare
and commit like everything else. None of them can post, and none is given any way to.

## Where a suggestion comes from, in order

A line has at most the suggestions of the first of these that has one:

1. **A rule.** Exact, written by a person or an agent, and the owner's word. A line a rule decides is
   suggested what the rule says and nothing else, even if the rule's account has since closed.
2. **The other matchers.** A transfer between your own accounts, a posted entry that is the same
   money, a payout from Stripe: each is exact about what it matches.
3. **The classifier.** What this book's own history shows (below).
4. **The starter list.** What a merchant is usually, from a list built into Rastrata. It is asked last,
   and only for a line nothing above had a suggestion for, so a book that has learned something always
   prefers what it learned, and a book that has learned nothing yet (a first import) is not shown a page
   of blank decisions.

### The starter list

The list is a few hundred common US merchants and the words banks use for fees (Google Workspace, Xcel
Energy, State Farm, USPS, Gusto, a monthly service fee), each with the kind of category it usually is:
software, utilities, insurance, postage, payroll, bank fees, rent, meals, travel and a few more. It is
data in the repository: nothing is fetched, and nothing about your book leaves it.

- **It prefers to say nothing.** A name is found as whole words in what the bank wrote, so a store number,
  a town or the words "ACH DEBIT" in front change nothing and "PARENT" is not "RENT". A merchant that
  sells many kinds of thing (Costco, Amazon, Walmart) is left out on purpose, as is a line that names
  two merchants of different kinds, and a line that says it is a place to eat is only ever meals
  (ADOBE GRILL is not software).
- **It maps the kind to your chart, not to a code.** Every book has its own accounts, made from a
  template and then renamed. The kind goes to the account that carries a role key (a payout from Stripe
  goes to the account its payouts wait in), then to the one account on the tax line that means the kind
  and nothing else (Schedule C line 25 is utilities), then to the one account whose name says so
  ("Software and subscriptions"). Two accounts that could be meant, a closed account, an account not yet
  open on the line's date, or none at all, is no suggestion: an S corporation's payroll debit is not
  guessed, because wages and officers' pay are two lines of its return.
- **It never calls money in an expense.** A refund from a software merchant gets nothing, and neither
  does a debit that looks like a payout.
- **It defers to the book.** It says nothing where a rule decides the line, where the book has booked
  this merchant to another account before, and, once Stripe has told the book about its payouts, for a
  deposit Stripe's own matcher pairs exactly.
- **It says why in one sentence and claims no figure.** "USPS is usually postage." The confidence is a
  fixed 50, below anything a rule or the classifier gives, so "best suggestions first" puts these last.

Its suggestions are named `starter` in the data (`inbox list`, `inbox show`, the API), which is how an
agent tells a starter suggestion from a learned one: `--proposer=starter` picks them, and
`--min-confidence=60` leaves them out. In the browser, "Accept N suggested" counts them like any other,
and accepting a line goes through the book's setting for what Accept does (post it, undoable, or keep a
draft), so a wrong guess is one Undo away and nothing was posted without a person pressing Accept.

## How a rule decides

A rule has conditions on one bank line (description, counterparty, reference, amount, direction, the
account it is on, where it came from), an optional limit to some accounts, an action, and a place in
an order. For each line the **first enabled rule, in order, whose scope and conditions match decides**.
Rules below it are not consulted, which is why a specific rule belongs above a general one.

Three consequences are worth stating because they were decisions, not accidents:

- **A rule that decides but cannot be applied proposes nothing.** If the first matching rule books to
  an account that has since closed, the line gets no suggestion from rules; it does not fall through
  to a rule below that would book it somewhere the owner never intended. The rule is flagged
  **Needs attention** in the list so it gets fixed. (The proposer contract has no channel for saying
  why nothing was proposed, so the flag lives on the rule.)
- **Negation is the exact complement.** Every text operator compares the same canonical form of both
  sides, so "does not contain X" holds exactly when "contains X" does not. A line with no counterparty
  has empty text there, so "counterparty does not contain X" holds.
- **Order is data the owner can see.** The Rules screen measures each rule over the lines waiting in
  the Inbox and the last 90 days of posted history: lines **matched**, lines it **decides**, and lines
  an earlier rule takes from it (**overridden**). A rule that matches nothing is dead; one that
  decides nothing is hidden behind an earlier rule.

### Text, and why there are no regular expressions

A bank memo is written by strangers: it may contain markup, control characters, right-to-left
overrides, invisible characters, or an instruction to an assistant. Rules treat it as data and
nothing else. Text is compared in a **canonical form**: Unicode compatibility-normalised, lower-cased,
accents and invisible or bidirectional-control characters dropped, and every run of anything that is
not a letter or digit collapsed to one space. `Github, Inc.`, `GITHUB INC` and `github-inc` are the
same text. The operators are contains, is exactly, starts with, ends with, and contains the whole
word; all of them scan the canonical text once, in linear time.

There are **no regular expressions**, and that is a decision:

- A pattern is a program. A pattern written by a person or an agent, run over thousands of lines of
  hostile text, can take exponential time on a crafted memo, and nothing in a pattern says what it
  will do to a reader who is not a programmer.
- The cases that matter in bookkeeping are covered without them: a merchant's name (contains, whole
  word), a family of names (any of, in a group), an amount range in exact cents, a direction, an
  account. A rule you cannot read at a glance is a rule you will not trust.
- Text from a bank line is never interpolated into a query, markup, a command, a pattern or a prompt.
  The only patterns in the system are fixed ones that validate the shape of numbers and identifiers.

A narration template (`Software: {merchant}`) is data too: placeholders are replaced by the named
field of the line, with control characters stripped and the length clipped, and nothing is
evaluated.

### Money is exact

Amounts are decimal strings and integer cents, never floating point. An amount condition compares the
absolute amount in exact cents, inclusive at both ends. A **split** divides a line by these rules, in
order: fixed amounts are taken first; what remains is divided by percentage, in hundredths of a
percent (`33.33 + 33.33 + 33.34` is a valid 100.00); a part marked **rest** takes whatever is left, so
the cents lost to rounding land there, visibly; with no rest part, the cents lost to rounding go one
each to the largest fractional remainders, ties to the earlier part. The parts are asserted to sum to
the line exactly, or the split is refused. The editor runs the same function to show the exact parts
of an example amount.

### Who made a rule

Every rule and every revision records who made it, person or agent, and when. With a scoped agent
token the author is always that agent and cannot be changed by the request: an agent cannot present
itself as a person. With the owner's own access the author is whatever `madeBy` says (a person if
nothing is said), which is self-reported; it is provenance for a reviewer, not an access control.
Earlier revisions are never edited or removed, and a deleted rule stays readable with its history.

## Testing a rule before it exists

`rules.test` (and the live check in the editor) runs the same engine that proposes, pointed at the
Inbox and at posted history, and counts without doing anything: lines matched, how many an earlier
rule takes, how many the rule cannot be applied to, whether past bookings **agree** with where the
rule would book (a posted line booked to the account the rule would choose counts as agreeing), and
samples showing the entry the rule would propose. Counts add up: matched = applies + shadowed +
unusable. A line typed into **Try a line** goes through the same code and comes back as applies,
shadowed, unusable or no match, with the conditions that held and those that did not.

Measured in the test suite on the development machine (an Apple-silicon Mac), with no browser: 300
rules over 5,000 lines in 208 ms; a `rules.test` over an Inbox of 2,600 lines in 59 ms, of which
reading the Inbox is 12 ms.

## The local classifier

For lines no rule decides, the classifier suggests the account similar lines went to before. It is
small on purpose: a **naive Bayes** model over the canonical words of a line's description and
counterparty, one class per chart account, with Laplace (add-one) smoothing and a prior from how often
each account is used. It is deterministic (only addition, subtraction, multiplication and division,
no random numbers and no floating-point surprises at a threshold), it runs on your computer and it
calls no model. Direction (money in or out) is a separate factor, not a word, so a long memo is not
penalised for having more words.

What it learns from is the book's own record: posted journals, and the decisions made in the Inbox
that have not been posted yet. Each posted line is read the way the Inbox shows it, so training and
suggesting read a line the same way.

### When it may suggest

A model that ranks accounts is not enough to decide to speak. The classifier suggests only when the
**most reliable word** in the line has a good record: of the earlier lines containing that word, at
least **agreement** percent went to the same account (default 90), that word has been seen at least
**lines behind it** times (default 3), the account leads the runner-up by at least **margin** points
(default 10), and the line has at least **known words** words the model has seen (default 1). If not,
it says nothing. A line in a new merchant, or one that an ambiguous merchant (Amazon, Costco, Google)
could belong to several accounts, gets no suggestion rather than a guess.

Words that every line has are not evidence. Some bank files write your own account's name into each
description (Rho does: every row carries "Willow Lane Studio Rho Checking"), so every line contains
"checking" and "rho". If what has been booked so far all went to one account, those words would look
like a perfect record for it, and a merchant the classifier has never seen would be suggested that
account with real confidence. So a word contained in **80 percent or more** of the lines learned from
the line's own bank or card account (once at least five lines have been learned from it), or of all
the lines learned, is left out entirely: it does not count in the score, in the record behind a
suggestion, or in the words the model must have seen. Each example is therefore learned with the
account it was on, which is why training reads that too. A line with nothing else the model has seen
gets no suggestion. A payer or merchant that makes up most of an account's lines is a job for a rule,
which is exact; the classifier is for the long tail.

The confidence shown with a suggestion is Laplace's rule of succession over that record: `(n + 1) /
(N + 2)` as a whole percent, never above 99. Three agreeing lines out of three is 80, eighteen out of
eighteen is 95, seventy out of a hundred is 69. It is a statement about the evidence, not a
probability estimate from a model, and it is shown with the strongest words as the reason.

### When it learns

The classifier learns on its own. When For review is read (listed, opened or summarised) with
transactions waiting, and the books or the Inbox's decisions have moved on since it last learned, it
learns again first, and only then suggests. So a merchant you categorise once in
For review is suggested for the merchant's next line, and a batch you post is learned from before the
next statement is reviewed. A change's own refresh (accepting a line, posting a batch) does not learn,
so a run of changes does not pay for it on every call; the next reader does, once. Nothing is written
when the classifier is switched off, when there is nothing to learn from yet, or when the learning
would write more than it may at once (5,000 example rows: a hosted book's request is one log entry of
bounded size, and For review must never be refused for a learning done on the side). In that last
case the status says how many rows are held back (`heldBack`, with a note), and that is the one state
in which the Suggested accounts card on the Rules page has a button: Train now learns from all of
them. Everywhere else the card has nothing to press, because it learns by itself; and on a book it has
learned nothing from the card is not shown at all. What it learns from is kept as a difference, so a
learning after a few new postings writes a few rows and not the whole history, and reads only what
changed, so it costs those postings and not the size of the book. The model is derived
data, so learning again is always safe and changes no entry. `rastrata classifier train` does the same
at once, in every state, for an agent that wants the next suggestions to reflect what it has just
posted.

### What it measures about itself

Its figures are **measured** when the Suggested accounts card is read, and when you train it on
request, and not at each learning, which only works out what changed. The measurement **replays** the
book's history in date order: each line is suggested for by a
classifier that has learned only from the lines before it, and then it learns that line. The first
lines, with nothing to go on, are learned from and not scored. The report is exact counts: **precision**
(right suggestions among those made), **recall** (lines that received a right suggestion among all
scored), coverage, a sweep over the confidence shown, and the same figures per account, with the most
common confusions. Changing a threshold measures again, so the card never shows figures for settings
that are no longer in force.

On the synthetic fixture the test suite builds (eighteen months, about 1,400 lines to sixteen
accounts, hard on purpose: ambiguous merchants, memos full of store numbers and reference ids,
vendors that appear once, and two lines in a hundred booked wrongly by a tired person), at the
defaults:

| | Result |
| --- | --- |
| Lines scored (349 learned before scoring) | 1,049 |
| Suggested / right | 836 / 825 |
| Precision | 98.68% |
| Recall | 78.64% |
| Across five seeds | precision 97.08–98.14%, recall 72.83–77.12% |
| With no mis-bookings in the history | precision 99.52%, recall 80.15% |
| Only suggestions at confidence 90 or more | precision 98.95%, recall 63.20% |
| Only suggestions at confidence 99 | 28 suggested, 28 right |
| Cost | trained on 11,184 lines in 39 ms; replayed 1,398 lines in 20 ms; proposed for 1,398 lines in 25 ms |

The figures did not move when words that most lines share were left out: the fixture has none, which
is the point of leaving them out only when they are there.

These are measurements of a fixture, not claims about any book. The Rules screen shows the same
measurement on your own history, and that is the figure to trust. It will be lower for a book with
less history, more one-off merchants, or genuinely ambiguous accounts, and the card says so when no
account has enough earlier lines for it to say anything.

The thresholds are configuration, and the defaults were chosen with this harness: raising agreement
trades recall for precision, and the margin is 10 because a larger one (40 was tried) cost recall
without improving precision across seeds.

## What this does not do

- **No regular expressions, no scripting, no arbitrary conditions.** A rule you cannot read is a rule
  you cannot test.
- **No learning from amounts.** The classifier reads words. Amount, day of month and account are
  available to rules, not to the classifier.
- **No automatic posting.** There is no setting that lets a rule or the classifier book a line.
- **Self-reported authorship for the owner.** With the owner's own access an author is a declaration.
  A scoped token cannot be spoofed.
- **No drag-and-drop reorder.** Order changes with move buttons and with Alt and the arrow keys;
  both are announced.
- **Measures are bounded.** The usage figures read the Inbox up to a limit per request and the last
  90 days of posted history; when the Inbox is larger the screen says the counts cover the first
  lines. A book with more than 500 active rules is asked to fold them.
- **One book, one process.** The classifier model is derived data, rebuilt from examples held in the
  book and held in memory per service; it is safe to retrain and gives the same answer for the same
  history.

## Checking it by hand

```sh
rastrata rules list --usage                          # order, matched, decided, overridden
rastrata rules test RULE_ID --try-description "GITHUB 42" --try-amount -4.00
rastrata classifier train && rastrata classifier status
rastrata classifier evaluate --min-agreement 95      # the effect of a stricter setting, no change
```

The tests behind these statements are in `packages/application/test/rules-*.test.ts` (engine,
operations, proposers, classifier and the evaluation harness, authorship, Inbox integration),
`packages/ui/unit/rules.test.ts` and `apps/web/tests/unit/rules-draft.test.ts` (the editor's
mapping), and the browser flow in `apps/web/tests/browser/rules.spec.ts`.

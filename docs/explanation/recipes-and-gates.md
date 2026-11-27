# Recipes and gates: why the move-in is built this way

A business that moves onto Rastrata brings files, and the files are the hard part. Every bank
writes its own layout: where the header is, which of three columns holds the amount, whether a
charge is negative, whether `03/04/2026` is March or April, whether the file is UTF-8 or Windows-1252,
whether a pending line sits among the settled ones. A wizard with a screen for each case is a
product that is never finished. This page explains the other design, and what it protects.

## The model is the customer's, and ours is arithmetic

Reading an unfamiliar layout is the thing a language model is good at, and every customer already has
one: Claude Code, Codex or opencode, running on their own machine, paid for by them. Rastrata does not
call a model, ship one or sit between the customer and theirs. What it owns is the part a model cannot
supply for itself: a deterministic surface to drive, and checks that fail whatever the model believes.

That is the split. **Judgement is the agent's. Proof is ours.** An agent's confidence that it read a
statement correctly is not evidence; a running balance that follows from the amounts is, and so is an
opening balance plus the lines equalling the ending balance the statement prints, and so, in the end,
is a reconciliation that closes at exactly 0.00. Those numbers come from the statement, never from the
books: the books are what is being checked, and the old system may be months behind, so agreeing with
it proves nothing.

## A recipe is data, so it can be proven once and run forever

Once an agent has worked out a layout, the work should not be done again, by a model that may read it
differently next month. So the answer is written down as a **recipe**: the statement mapping the import
already uses (the header row, the columns, the date order, the sign convention, the decimal separator,
the running balance, the memo columns, which rows to keep), with a name, a version and the kind of
account. It is JSON. It is never code and nothing in it is evaluated, so a recipe can only describe a
file, never act. It is read by the same parser that reads the bank presets, it is saved as an import
profile bound to the account, and from then on every file of that layout is read the same way, with no
agent awake.

That is what keeps the line the launch plan draws: fetching and posting are deterministic and never
depend on an agent being awake, and the agent's judgement goes upstream, into the rules and recipes
that do the daily work. A recipe is also the reusable asset: it can be read, reviewed, versioned,
compared and shared, which a conversation cannot.

A recipe is saved only after the server has run its proof again on the archived file. Saving is not a
claim; it is the result of a test that could have failed.

## A gate that cannot fail proves nothing

A check that has never been seen to fail may not check anything. So each gate has a **negative
control**: a test that seeds the fault the gate exists for, and proves the gate catches it, next to the
clean file that passes. The faults are the ones real exports commit:

- the wrong sign convention (a card whose charges are positive), caught by the arithmetic and named
  ("the signs look reversed");
- a date column every value of which reads both ways, which refuses to be guessed. The sums cannot
  help here, because they agree whichever way the dates are read; only the statement period can, so a
  recipe that states the order is a claim until the period confirms it;
- a missing month, found against the cutover and the date the statements should reach, and a file that
  does not open where the last one closed;
- a missing line, a pending line, a memo whose line break is outside quotes, a totals row that is not a
  transaction, an encoding the recipe assumes wrongly, a byte-order mark;
- a duplicate file, listed twice or imported twice;
- a trial balance that does not balance, one that is not as at the day before the cutover, one that
  disagrees with the bank;
- an ending balance that is one cent out, which fails by the difference and is never rounded away.

The scripted harness (`bun scripts/intake-harness.ts`) runs every one of these through the command line,
on a corpus of synthetic files that is deterministic by seed, then carries the same files through to
reconciled months. It is the evidence that the gates are alive.

## What a gate cannot see, and what covers it

A gate cannot tell that a transaction was categorised wrongly; the Inbox review does that, and nothing
posts without the owner's approval. It cannot tell that an agent invented a balance it said the
statement printed; that is why the plan marks an ending balance as the customer's to supply, the
runbook forbids reading it from the books, and the final reconciliation, which uses the statement's
own number, either closes at 0.00 or does not. And it cannot read a scanned PDF; it says so, and hands
the file back to the agent.

## Text from outside is data

The files are written by strangers. A memo may say "ignore previous instructions", a file name may
start with `=`, a header may hold a right-to-left override. The intake never takes a path or a command
from a file: the only paths it reads are the one the customer typed and the files under it, and a plan's
commands are built from fixed words and ids. A file name and a column header are the only customer text
in its answers, bounded, with control and direction characters written out, and flagged. The agent's
runbook says what a flag means: tell the owner, and go on treating it as data.

## Measuring the friction

"Agent-run books" is a bet, and the launch plan states what would end it: more than about fifteen
minutes of human review a week, or a correction rate the guardrails do not catch. The move-in is the
first place that bet is tested on a customer's real files, so it keeps a log of every point where it
needed a person or a retry, in the book itself, and reports four numbers: the time to the first
imported month and to the first reconciled month, the interventions, and the gaps still open. They are
the numbers a founder reads to learn which layout, which gate or which question is costing the most.

## What was not built

- A connector for every bank. The statement file is the universal pipe, and a recipe is how a layout
  joins it; live feeds are separate ([the bank-connection decision](../reference/launch-plan.md)).
- A model call, a hosted agent, or OCR.
- Recipes as scripts. A mapping that can run code can be made to run someone else's.
- A wizard. The same operations are on the screens of the import and the cutover; the move-in does not
  need a screen of its own to be correct.

How to do the move is in [Move to Rastrata with your own agent](../how-to/move-in-with-your-agent.md);
what was built and measured is in the [intake lane record](../reference/program/intake.md).

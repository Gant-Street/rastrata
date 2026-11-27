# Closing a year without closing entries

Most accounting software ends a year by posting a journal that zeroes every income and expense account into
equity, so the next year's accounts start at nothing. Rastrata does not. Closing a fiscal year **locks its
periods and records what the books showed**; it posts nothing and moves no balance. This page explains what
that means, why it was chosen, what the kernel decides that the screens have to show honestly, and what it
costs. For the steps, see [Close a fiscal year](../how-to/close-a-fiscal-year.md).

## What a close is

A close is a command in the book's own record, like a posting. For one fiscal period it does two things:

1. **It locks the period.** From then on a journal dated in the period is refused (`Fiscal period … is
   closed`), whether it is new, a correction or a reversal. Locking is the kernel's rule, not the screen's.
2. **It records what the books said.** The close keeps the book revision it was made at and a fingerprint (the
   report population hash) of the trial balance, profit and loss and balance sheet as of the period's last
   day. The fingerprint is not a copy of the figures. It is what lets someone later ask the book for those
   statements as they stood at that revision and check they are the same ones.

A fiscal year is closed by closing each of its periods, in order. The last close records the year-end
population.

## Why there are no closing entries

GnuCash's Close Book assistant is the usual alternative. It posts flagged closing entries that move each income
and expense balance into an equity account, which does give the next year a clean start. It also leaves the
book with synthetic journals that nobody entered: every report that wants the year's real activity has to
know to skip them, and a year that is reopened to correct a late invoice has to have them reversed first.

Rastrata keeps the journals as people wrote them. The balance sheet's equity is the book's equity accounts
plus **earnings of earlier fiscal years**, computed from the journals and the periods, plus the current year's
earnings so far
([Earnings roll forward by computation](financial-statements.md#earnings-roll-forward-by-computation)). So:

- A year's profit and loss is a sum over the real entries dated in it, always. It does not change when the
  year is closed, and nothing has to be reversed to reopen it.
- Reopening a period to correct it needs no reversing journal, because there was no closing journal.
- The cost is that every report must do the roll-forward correctly. That is the reports' job, and it is
  checked: the accounting equation is asserted on every statement.

## What the kernel decides, and what the screen has to say

Two kernel rules shape the Periods screen. They are easy to get wrong, and getting them wrong looks like a
book that is closed when it is not.

**A period is locked when its own most recent transition is a close.** That is the whole rule for refusing a
posting.

**Reopening a period supersedes the closes of every period that ends on or after it.** Those periods' recorded
figures no longer describe the books once the earlier one is corrected, so the kernel marks the closes as
superseded. It does **not** unlock those periods. Each stays locked until it is reopened on its own.

So a closed period is in one of two states, and the screen, the CLI and the API keep them apart:

| State | Locked | Its close | Shown as |
| --- | --- | --- | --- |
| Closed | yes | current: it still describes the books | *Closed* |
| Closed, close superseded | yes | superseded by a reopening: it no longer does | *Closed, close superseded* |
| Open | no | none | *Open* |

`periods.list` gives each period `status` (`"closed"` means locked) and `closeSuperseded`; a fiscal year is
*Closed* only when every period is locked **with a current close**. Reopening one period therefore never makes
a year look closed when its later periods are quietly out of date, and it never makes them look open when they
cannot be posted to. To put a superseded period right you reopen it and close it again. The year-end does that
in one step: *Close the year again* plans a reopening and a close for each superseded period, in order.

## Why a year-end is a chain of commands

The kernel closes exactly one period per command. A year-end is therefore twelve commands (or four, for a
quarterly book), and the guided flow is built around that rather than hiding it:

- **Each close is sealed against the book as the closes before it will leave it.** Close *k* of the year
  expects the book at revision *R + k − 1*. Each step is previewed on that chained state and carries its own
  plan, hash and warnings, exactly like a close made alone.
- **The identities are derived.** A step's identity is a function of the year-end's identity, the period and
  whether it is a close or a reopening. Asking again after a crash, or after a reply was lost, finds the steps
  already made instead of making new ones.
- **The commit is resumable and never repeats a step.** Committing runs the steps in order. A close that
  already committed returns its original receipt. The commit stops at the first close the book rejects (for
  example because something else wrote to the book after the review) and says how many periods closed. Those
  stay closed; a fresh review plans only what is left.

The cost of building on single-period commands is that a year-end is **not atomic**. If the connection drops
or the book rejects the fifth close, five periods are closed and seven are not, and the screen says so rather
than pretending otherwise. A kernel command that closes a whole year at once would be atomic, but the kernel
is frozen and the single-period close is the rule its history already uses, so the year-end stays honest about
being a sequence.

## The calendar only grows forward

A book's periods are defined when it is created and extended as postings need them, or a fiscal year at a
time by hand (`periods.extend`). The
kernel allows a configuration change only **prospectively** (effective after every journal the book holds),
requires the periods to be gap-free and unique, and treats the opening boundary as immutable. So a calendar can
be extended, never shortened or moved, and **a book cannot be posted to before its first period**. Someone who
wants earlier history sets the first fiscal year earlier when the book is created. A close stores the
configuration in force when it was made, so extending the calendar later leaves every earlier close exactly as
it was.

A posting dated after the calendar's end grows the calendar through that fiscal year as part of the posting,
under the poster's name (a `calendar.extended` change). A posting dated before the first period, or past
fiscal year 2100, fails with `calendar_not_configured`, naming the date and the range the calendar covers.

## What it costs

A close records a population hash by running the statements over the book as it stood. The book keeps an
incremental read model, so reading after a posting or a close is cheap. The first read of a book that has to
be replayed from its record is linear in the number of journals for a book made since 2026-10-07 (about a
millisecond an entry), and was quadratic before (every command hashed the whole state). On the development
machine, a five-year October book with a few thousand journals builds in seconds, reads each year's
statements in about a second or less, and takes tens of seconds to prepare and commit a year-end; when that
measurement was made, the first full replay of a three-thousand-journal book took many minutes while the
machine was busy, and now takes a few seconds. The numbers, and how to reproduce them, are in the
[calendar lane record](../reference/program/calendar.md#scale).

## What it does not do

It does not file anything or give tax advice. It does not lock a period against *reading*: reports for a
closed period are always available. It does not stop you from closing a year that has things outstanding:
the checklist says what it knows and you decide.

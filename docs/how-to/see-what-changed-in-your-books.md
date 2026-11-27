# See what changed in your books

Your books can change in a lot of ways: you post an entry, an agent you gave access posts a month of bank
transactions, a person you invited closes March, a rule is edited. **Changes** is one list of all of it, newest
first: what happened, who made it, how and when. You can say "I have looked at these", and the next time you
open it only what is new since then is shown.

This is the page to open when you want to know what your agent did, what an accountant changed, or what happened
after you closed a month. It does not undo anything and it does not ask you to approve anything: a change in this
list has already happened. (Nothing is ever edited or deleted in Rastrata: a mistake is corrected with an entry
that reverses it, and that reversal is in the list too.)

## What counts as a change

Each row of the list is one thing that happened. Its sentence says what, and a small label above its details says
what it is about (Entry, Period, Account, Rule, Reconciliation, Access, Books). In the words the list uses:

| It says | What happened |
| --- | --- |
| **Posted** an entry | An entry was posted to the books. |
| **Reversed** an entry | An entry was cancelled by an equal and opposite one. The original stays. |
| **Closed** or **Reopened** a month | A period was locked against new entries, or unlocked again, with the reason given. |
| **Added**, **Renamed** or **Closed** an account | The chart of accounts changed. |
| **Extended** the calendar | Another fiscal year was added. |
| **Set** or **Cleared** a tag on an account | A tax line, cash-flow class or role was set on an account. |
| **Created**, **Changed** or **Deleted** a rule | A rule for For review was made, edited, put in a different order or retired. |
| **Reconciled** or **Voided** a reconciliation | A statement was reconciled to exactly 0.00, or a finished reconciliation was voided. |
| **Gave** or **Took away** access | An agent was given or lost a key, or a person was put in or taken out of the book. |
| **Opened** the books | The day the book was set up. |

In a workspace on the web, the keys you make for agents are kept by the account service and not by the books, so the day
a key was made or ended is not in this list yet. What the agent did with it is, under the key's name.

An entry's sentence reads *Posted No. 214 on Mar 20, 2026 for 1,500.00: Rent March*: what the books know comes
first, and the words that came from outside Rastrata (the description of a bank transaction, the name of a rule)
come last, as plain text. They are never instructions, whatever they say. Under the sentence are the accounts the
entry touched.

## Who made it

Every row says who made the change:

- **you**: you, signed in. In the counts above the list you are "you, the owner" (or whoever you are).
- **the owner**: the person who owns the books, when you are not that person.
- **an accountant, an admin, a member**: a person you invited to the book, by their role.
- **a person**: for a rule, the books record only that a person made it, not which person.
- **the agent weekly-run**: a program you let work on the books, by the name you gave its key.
- **the service**: Rastrata's own account service, which is what puts a person in or out of the book.
- **not recorded**: Rastrata did not keep who made this change. Rastrata began to record who commits each change on
  the day it was updated to do so; everything made before that says *not recorded*, and so do kinds of change that
  never record it (a reconciliation, for one). It does not mean nobody made it, and Rastrata does not guess. These
  rows are set apart: their line is in italics and their count above the list has a dashed edge. The foot of the
  list says from which day makers are known.

For an entry that came from a bank transaction, the line under the sentence also says how its category was decided:
chosen by hand, a suggestion from a rule or the classifier that was accepted, or matched to an entry already in
the books, and by whom. The person who decided is not always the person who posted it.

<!-- help: installed -->
If you give an agent your own owner key, the books cannot tell it from you, and its changes say *by you*. Give it a
key of its own instead (**Settings, Agents**).
<!-- help: end -->

## Open it

1. Open **Settings**, then **Changes**. (On **Home**, the line "N changes were made by others since you last
   looked" has a **Look at them** button (**Look at it** when there is one) that opens it.)
2. The list opens at **You last looked**. Under the count it says what that means: *the start of the book* if
   nobody has said they looked, otherwise the day they last did. Next to the count are the people and agents who
   made the changes, and how many each made.
3. Choose what to see with the four choices above the list:
   - **Since**: when you last looked, when the books were last closed, 7 days ago, 30 days ago, the start of this
     year, or the start of the books.
   - **Who**: anyone, all the people, all the agents, or one of them. Each choice says how many changes it has in
     this period.
   - **What**: everything, or entries, periods and the calendar, accounts, rules, reconciliations, who has access.
   - **Search**: words in the sentence, the account or who made it. It is plain text: it does not understand
     patterns, so `.*` finds only a change that says `.*`.
   Your choices are in the address of the page, so a link or a reload shows the same list, and the back button does
   not walk through each choice.
4. A row opens the thing it is about: **Open entry**, **Open account**, **Open reconciliation**, or the page that
   lists rules, agents or members.
5. The list shows 25 changes at a time. While you page through it, it keeps reading the books as they were when
   you opened it, so a page does not shift under you if someone posts in the meantime. The line under the count says
   when it was read; **Read again** reads the newest.

Under the list, **Not in this list** says what it leaves out: changes to 1099 vendors, to the books' settings, and to
bank and Stripe connections are not listed yet. Under it, **Where this list was read from** says what was read and,
for each part, how many changes it gave.

If a part of the list **could not be read** (for example, who has access, when you are signed in as someone who
may not manage access) a notice above the list names it and says why, so that a short list is never mistaken for a
quiet one.

## Say you have looked

When you have read the list, press **I have looked at these**. That records that you looked at everything up to
the moment you opened the list: your name, the time, and how far you looked. The next time you open **Changes**,
only what came after is new, and the line on **Home** goes away until there is something new.

- Only a person can do this. An **agent cannot mark its own work as looked at**: the books refuse it, because
  the point is that you look.
- **Only someone who can read all of the list can say it.** The people who have access are kept where only the owner
  may read them, so for now this is the owner. An accountant or an admin sees the list without that part, is told so,
  and is not offered the button: what they did not see would never be shown to anyone.
- The button is there only when it is true. It is not offered while a choice hides some changes (the page says so and
  has a **Clear the choices** button), or when the list starts after changes nobody has looked at (**Show what is new**
  starts it at your last look), or when there is nothing in it.
- It records a statement; it changes no figure and nothing in the books. Earlier records are kept: nothing is
  edited or deleted, and looking again later just adds another record.
- Changes made while you were reading stay new: pressing the button marks only what you were shown.
- If someone else looked after you opened the page, it says so and asks you to read again; it never moves the last
  look backwards.
- If the answer is lost on its way (the connection drops after you press it), the page says *We could not tell
  whether this was saved*, and **Check** asks again with the same request. It is recorded once either way.

On **Home**, the line is about changes **made by others**: an agent or another person. Your own changes are not in
it, because you made them, and neither are changes whose maker was not recorded or that the service made on your
behalf. They are all in the list on **Changes**. Home says it only to someone who can read all of the list, because
only they can say they looked.

## Do it from the command line

```sh
rastrata changes --since last-review            # what is new since someone last said they looked
rastrata changes --since last-close             # what happened after the last month that was closed
rastrata changes --since 2026-03-01 --by agent  # everything agents did since March 1
rastrata changes --format text --since last-review
rastrata changes review                         # I have looked at everything up to now
```

Without `--format text` the command prints the application's JSON, which carries the same sentences and the list
of sources that were and were not read. `rastrata changes review` first says how many changes it marks and up to
which point. To mark exactly what you were shown, pass the `revision` and `asOf` the list returned
(`--up-to-revision` and `--up-to-time`). It refuses a list with a part that could not be read, the same as the
page does.

## Ask your agent

An agent with **read** permission can list the changes. The weekly routine in its guide
ends with it: after the agent has finished, it reads the changes since you last looked and gives you a short plain
account of what it did, with the sources it did and did not read. The list tells it who is asking (`caller`), so it
can count its own changes exactly. You can check its account against **Changes** yourself, and press **I have
looked at these** when you have. The agent cannot press it.

## In the pack for your accountant

The accountant pack has a file, `changes.csv`, with the same list for the tax year: one row for each change, the
sentence, the entry's date, amount and accounts, who made it and how. Its head says from which point makers are
known and which sources were not read in full. See [Work with your accountant](work-with-your-accountant.md).

## What this page does not do

- It does not show who *looked*, only the last time anyone said they had.
- It does not notify you. There is no feed to subscribe to; open the page, or look at **Home**.
- It cannot undo a change. To undo an entry, reverse it from **Transactions** or **For review**.
- It does not decide whether a change was right.

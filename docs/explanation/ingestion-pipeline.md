# The ingestion pipeline

Every money movement that does not start in Rastrata (a line on a bank statement, a transaction from
a bank feed, a charge or payout from Stripe) comes in through one pipeline. This page explains how
it works and why it is built the way it is. The operations are listed in
[the ingest lane's reference](../reference/program/ingest.md); the commands are
`rastrata inbox ...`.

The short version: a source hands over a payload, the pipeline keeps the raw bytes, works out which
lines are new, and puts them in the **Inbox**. Rules, the classifier and a few built-in matchers
*suggest* what each line is. A person (or an agent they have authorized) decides. A decision becomes
a draft, and the draft is posted the way every entry is posted: prepared, reviewed, committed. At no
point does anything post by itself, and at no point can a line be posted twice.

## The flow

1. **Fetch.** A statement file is uploaded, or a connector pulls a page from Stripe or a bank feed.
   Fetching never depends on an agent being awake.
2. **Archive.** The raw payload is stored whole, addressed by its SHA-256. Entries can be
   regenerated later with better rules, and every figure traces to the bytes the provider sent.
   hledger's `import` archives its input for the same reason.
3. **Normalise.** A parser (for a file) or a connector turns the payload into lines: a date, a
   signed amount with exactly two decimals, a currency, the text exactly as received, and the
   position of the line in the payload. Parsers are pure functions of bytes and never touch the book.
4. **Check identity.** Which of these lines do we already have? (See below: this is the hard part.)
5. **Store.** New lines become Inbox items in one transaction. Lines we already have are reported as
   duplicates. Lines dated before the cutover date are stored too, as excluded.
6. **Propose.** Every registered proposer is asked what each open item could be. Proposals are
   checked, stored with their reasons, and shown. They only suggest.
7. **Decide.** Categorize (an account or a split), accept a suggestion, match to an entry that is
   already booked, or exclude with a reason. A decision that books something becomes a draft.
8. **Post.** The draft is prepared (the exact command is sealed under a durable identity and its
   effects previewed) and committed under the plan hash that was reviewed. The journal carries the
   line's provenance.

This follows the shape Bigcapital found in its bank-transactions modules (a raw line, recognised by
rules as a suggestion, then categorised, matched or excluded) and GnuCash's import matcher
(scored candidates with visible reasons). Two things it deliberately does differently are noted
where they come up.

## Knowing what is new

Two cases, and they need different answers.

**The provider gives lines an identifier** (an OFX `FITID`, a SimpleFIN transaction id, a Stripe
balance transaction id). Then the identifier is the identity, and it is a **hard uniqueness key in
the database**: `UNIQUE (provider, account_key, provider_id)`. A repeat can never become a second
row, even if the application code had a bug. This is the first lesson of both references: Bigcapital
stores `plaid_transaction_id` with no unique constraint, so a replay duplicates, and its `modified`
lines are inserted as new rows. Here a line whose identifier is already known is a **duplicate**. If
the provider now reports different financial content for the same identifier (another amount, another
date), the line is **not** overwritten and not silently ignored: the original is kept, flagged
"changed at the provider", and the new version is recorded so a person can look. A changed
description alone is cosmetic.

**The provider gives no identifier** (a bank's CSV). hledger's documentation is blunt about it: this
is not deduplication, because "it's generally not possible to reliably detect duplicates in bank
CSV". Two coffees for the same price on the same day are two purchases, not one purchase listed
twice. hledger instead remembers, per file, the latest date it imported and how many lines fell on
that date, and skips what it has seen. That works while files only grow at the new end.

The pipeline adapts the same idea so it also survives what real downloads do:

- A line's identity is its **date, signed amount and currency**. Lines with the same identity are
  *counted*, per provider account. If three are already stored and today's file lists three, all
  three are already imported. If it lists four, one is new. This is hledger's "skip the first N on
  that date", applied to every date and amount instead of only the latest date, so an older line that
  arrives late is still imported, and an overlapping statement or a re-download adds nothing.
- Two purchases for the same amount on one day are two lines (a count of two), imported as two, and
  recognised as two ever after. The database enforces it with a second unique index on
  `(provider, account_key, fingerprint, occurrence)`.
- The **description is not part of the identity**. Banks and our own parsers change how old
  descriptions read; if they were part of the identity, correcting a bank preset would re-import a
  year. The description only decides which stored line a file line pairs with when several share a
  date and amount: lines with equal text pair first, then in order. That keeps the text of the line
  that is genuinely new.
- Nothing guesses at "close enough". A different date or a different amount is a different line. If
  a bank re-dates a transaction between downloads we will see it twice, and the **balance check**
  (below) is where it shows.

The assumptions are hledger's: a file is a contiguous window of the account's lines, and a line keeps
its date and amount between downloads. When they do not hold, the books and the bank disagree, and
the pipeline says so rather than hiding it. A randomised test imports any set of overlapping windows
in any order and checks that every real line is imported exactly once.

## The cutover date and catching up

The book does not start at the beginning of time. It starts from opening balances at a chosen date,
and the bank history before that date must not become Inbox work. Each provider account has a
**cutover date**, set when it is connected or first imported (or changed later). Lines dated before
it are stored as **excluded** with the reason "before the cutover date": visible, restorable, counted
as already imported when the file comes again, and never silently dropped. Moving the date later
excludes the queued lines before it; moving it earlier brings back lines the old date kept out.

hledger's `--catchup` has the same purpose from the other side: when you have been keeping some
history by hand, mark everything in a file as already imported. A **catch-up** batch records every
line as excluded ("caught up") so later imports recognise them and none is queued.

## The Inbox

An item is one line with a status:

| Status | Meaning |
| --- | --- |
| `new` | Waiting; no suggestion yet. |
| `proposed` | Waiting; at least one suggestion. |
| `drafted` | A decision has been made and a draft entry exists. Not posted. |
| `posted` | A journal exists for it (posted from here, or matched to one that was). |
| `excluded` | Set aside, with a code (`manual`, `before_cutover`, `catch_up`) and a reason. |

Exclusion is a first-class state, because a bank account carries lines that are not the business's
(Bigcapital keeps "exclude" as a stage for the same reason). Nothing is deleted. Every change is
recorded with who, when and why, and `inbox.get` shows the history.

A first import is a few hundred to a couple of thousand lines, nothing categorised. So bulk is the
main flow: every action takes either a list of ids or **a filter** ("everything matching this"),
guarded by the count the person saw: if the list has changed since, the action is refused rather than
acting on a different set. Each call does a bounded amount of work and says how many items remain.

## Suggestions

A **proposer** is a pure, deterministic function from an item (and the chart, and what is nearby) to
suggestions. Rules, the classifier, the Stripe payout matcher and two built-ins register with
`registerProposer`; the pipeline asks each one per item, in name order, and never lets one break the
Inbox: an error is isolated and shown as a problem on the item.

A suggestion is checked before it is stored: its legs add up to exactly 0.00, the bank side moves
the line's own account by exactly the line's amount, every account exists and accepts postings on the
line's date, and it carries at least one reason. A suggestion that fails is dropped and the item shows
why. Money is exact decimals throughout: GnuCash compares doubles with an epsilon and Bigcapital
forgives 0.01 to cover floating point, and both are ways to book the wrong thing.

Suggestions are stored, and they go stale in three ways, each handled without a refresh button: a
proposer's own inputs changed (its `revision` string changes), the ledger gained or lost an entry a
line might be (a person booked something by hand, or reversed an entry), or the lines around an item
changed (the other side of a transfer arrived). Only the lines an entry could be a match for are
proposed again, not the whole Inbox. A stale item is proposed again the next time the Inbox is read;
5,000 open lines take a few hundred milliseconds.

The two built-ins:

- **Transfers.** A line whose exact opposite amount appears on another of your accounts within a
  window (5 days by default) is proposed as a transfer. Accepting it makes **one** entry for both
  lines, and both become drafted and then posted together, so the common bank-feed mistake of booking
  a transfer twice cannot happen. When several lines are equally near the confidence is held down and
  the reason says so.
- **Existing entries.** A line that is the bank's record of an entry someone already booked (a check
  written by hand, an invoice payment recorded by an agent) is proposed as a match. Candidates have a
  posting on the line's account for exactly the line's amount and are scored the way GnuCash's matcher
  scores: same day, nearby, a reference or check number in common, shared words. The weights, the
  window and the threshold are configuration with tests, and every score carries its reasons.
  Accepting a match records the link; it posts nothing, and an entry can be linked to only one line.
  A match is always the first suggestion on its line, whatever else is suggested and however
  confidently, because every other suggestion would make a new entry for a payment that is already in
  the books. So the Inbox never does that for the person: categorizing such a line, or accepting a rule's
  or the classifier's suggestion for it (by name, by proposer, by threshold or in bulk), is skipped with
  the code `match_exists` and a message that names the entry. Only saying so on purpose
  (`allowDuplicate`, "Draft a second entry anyway" on the screen) drafts a second entry, for the rare
  payment that really was made twice. Showing the match and booking nothing is the default.

## Lines that one entry books

A provider can settle many movements with one. Stripe pays out a batch of charges, fees and refunds as a
single payout, and the books carry **one summary entry per payout**, not one per charge. The balance
transactions are still imported: they are the evidence, and a person can see exactly what a payout was
made of. Each carries the identifier of its payout and is shown as *covered by* it. A covered line is
never decided or posted on its own: it follows its payout. Accepting the payout drafts the payout and all
the lines it books together; posting posts one entry and marks them all posted with it; excluding or
restoring the payout does the same. They are not counted as work to review.

This is also the lever on the book's size. The accounting kernel's cost per entry grows with the number of
entries in the book, so a book with a journal for every charge would be slow for a business with a busy
Stripe account. One journal per payout keeps a year of Stripe to about one entry per payout.

## Posting, and why a line cannot be posted twice

`inbox.post` is the only operation in the pipeline that touches the ledger, and it does exactly what
the Journal screen does: prepare the saved draft, then commit with the reviewed plan hash. Three
independent layers keep a line from being posted twice:

1. **The ledger.** Every Inbox line has a source identity, `ingest-<provider>-<hash>`, derived from
   where the line came from and never from its text. The ledger refuses a second journal for the same
   source identity and refuses the same identity with different facts.
2. **Retained identities.** The identity of a posting is derived from its draft (its id and its
   version), not invented per call. After a lost reply or a crash the same call finds the retained
   operation and resumes it: a committed posting is recognised and not repeated, a posting the
   ledger refused for what the entry is stays refused with the ledger's reason, an uncertain one is
   committed again under the same identity and the ledger answers with its first outcome.
3. **The Inbox.** A posted line cannot be categorised, excluded or restored; a drafted one belongs to
   one draft.

A posted journal carries provenance in its source event: `ingest:<batchId>:<rawIndex>` names the
batch (and through it the archived file's SHA-256) and the position of the line. A figure traces to
the entry, the entry to the line, the line to the bytes the provider sent.

Posting a transfer's two lines posts one journal. A posting the ledger refuses (a closed period, say)
leaves the line drafted with the ledger's reason on it; restoring the line discards the draft and
returns it to review.

### When the book moves under a posting, and when a line is refused for good

A posting is made in two steps: the entry is evaluated against the book as it is, and then committed.
If another write lands in between (the Journal screen, an agent, a second client of the Inbox), the
ledger refuses the commit, because the book is no longer the one the entry was evaluated against.
That says nothing about the entry. But the ledger keeps every refusal against the identity it was
made under, and the identity of a posting is derived from its draft, so a refusal of this kind used to
stick: every later `inbox.post` found it and gave it back without looking at the entry again, and the
line could only be returned to review and decided again.

It no longer sticks. When the only thing a refusal says is that the book moved on, `inbox.post`
opens the draft again (the draft's version moves, and with it the identity of the posting; the entry
is the same), evaluates the entry against the book as it is, and commits it: up to four times in one
call. If the book will not hold still, the line is reported as `posting_conflict` and left as it was,
to be posted again. The refusals stay in the book's record as what they were, refusals that changed
nothing, and the ledger still refuses a second journal for the same source, so none of this can post a
line twice. Calls of the Inbox on one book also take turns to prepare and commit, so they do not
make each other's plans stale; a write from anywhere else still can, and is met the same way. A book
that kept such a refusal from before is put right by the next `inbox.post`, with no restore.

A refusal about the entry itself (a closed period, a date before the book's first day, an account that
cannot be posted to) is not that. It stays refused, with the ledger's words, and `inbox.post` by
filter does not try the line again while the books are as they were: it works on the lines that have
not failed first, leaves the refused ones alone, and says so in its report (skipped, with the code
`refused_earlier` and the reason), without counting them as left to do. The lines behind a refused
one are therefore reached, and a client that posts until nothing remains does end. The books are as
they were until the calendar is extended, a month is closed or reopened, or the chart is changed:
then the next `inbox.post` by filter tries the refused lines again by itself, so "fix the cause,
then post again" needs no list of lines. Naming a line (posting it by its id) tries it at once;
returning it to review clears what was kept against it. A refusal the ledger has made for good
(the entry was sent and refused) stays with the posting it was made under: such a line is restored
and decided again.

### Taking a posted line back, and posting it again

`inbox.undo` reverses the line's entry with a linked reversal and returns the line to review. A
reversal does not free the line's source identity: the ledger refuses a second journal for it, so
the line could never be posted again. Each line therefore has a **generation**, and the identity
its entry carries is the line's own identity at generation 0 and that identity with `-r1`, `-r2`
after the first and second undo. The generation moves in the same transaction that returns the line
to review, and only when an entry of the earlier generation was reversed, so the identity of a
posting is still derived from the line and still the same on every retry.

The first layer above still holds. A generation is made only by an undo, after the entry before it
was reversed, so at most one entry of a line is ever live; within a generation the ledger refuses a
second journal; and a draft that claims the identity of an earlier generation is refused with
`source_already_posted`, even when it carries exactly the same facts. The matcher against entries
already booked skips a reversed entry and its reversal, so the line is not offered the entry that
was just taken back as "an entry you already booked".

## Balance checks

A provider that reports a balance (an OFX `LEDGERBAL`, SimpleFIN's account balance, Stripe's balance)
gives a check, never an entry. For the chart account the provider account maps to, the pipeline shows
the books' balance on that date, the lines still waiting in the Inbox, and the lines a person set aside
on purpose (the bank balance includes them; the books do not), and then the **difference**. It is
displayed and never "fixed": the pipeline will not post an adjustment to make it zero. Lines before the
cutover date are not part of the comparison; they are in the opening balance. This is the same idea as
a Beancount balance assertion, which fails loudly with the difference.

## Text from outside is data

Bank memos, merchant names, Stripe metadata, file names and CSV cells are written by other people.
The pipeline stores them verbatim (and the raw file besides) and treats them as data everywhere:

- Text is bounded (descriptions at 4,000 characters, flagged when cut) and never trusted for length.
- Control characters and the invisible and right-to-left characters used to disguise text are flagged
  on the item, and removed from everything derived from it: the draft's reference and narration, the
  source description, search text.
- Nothing from a line is interpolated into SQL, HTML, a shell command, a regular expression or a
  prompt. Searches are bound LIKE patterns with wildcards escaped; filters are bound values.
- No operation takes an instruction from a line. The tool descriptions and the bookkeeping skill tell
  an agent that a memo asking it to post, exclude or recategorise is a reason to leave the line for the
  owner.

## Volume

Designed for a freelancer's few thousand lines a year, and for the first run of the founder's book:
about a year across three accounts, up to roughly two thousand lines at once. Measured on the
development machine: importing 5,000 lines takes about 0.1 s, proposing all of them 0.4 s, and
reading again 4 ms. When this was designed, posting was bound by the kernel, whose commands cost time
proportional to the number of journals already in the book, so the design limit was a few thousand
entries in one book (about a thousand a year for a business like the founder's, comfortable for about
three years). Since 2026-10-07 a book made by the application reads back in time proportional to its
size, and a command costs about a millisecond at every size, so the limit is tens of thousands of
journals and the founder's book has decades of room; see
[the scale limit](../reference/program/main.md#the-scale-limit-and-what-we-do-about-it) and the lane
reference for the measurements.

## What it does not do

- **Auto-posting.** Nothing posts without a person's, or an authorized agent's, explicit call. The
  place an auto-post policy would attach (after proposing, deciding through the same draft, prepare
  and commit path) is documented in the lane reference; it is not built.
- **Currency conversion.** A line in another currency is queued, flagged and held for review. It is
  not converted, and cannot be categorised until the person decides.
- **Cross-source overlap.** Overlap detection works within one provider account. Importing the same
  bank account through two different sources (a CSV and later a bank feed) for the same dates can
  duplicate lines; the balance check shows it.
- **Tax advice, filing or prediction.** The pipeline books and reports.

# Backups, verification and the open export

Why Rastrata backs up the way it does, what a verified backup does and does not prove, and what the
open export is for. For the steps, see [Back up, verify and restore your
book](../how-to/back-up-and-restore.md). For the engineering record, see the
[safety lane](../reference/program/safety.md).

## A backup is a whole copy, made without stopping anything

The book lives in one SQLite database that holds two kinds of thing: the **ledger**, the append-only
chain of sealed commands and the facts they produced, and the application's own **product state**
(drafts, source events, settings, and whatever the Inbox, rules and reconciliation screens keep). A
backup copies both, in one consistent view, so a restored book is the book you had, not a book that
has to be put back together.

Copying the file with `cp` is not a safe way to do that. The database runs in write-ahead mode, so a
committed change may live in a second file that a plain copy does not take, and a copy made while a
write is happening can be inconsistent. SQLite's `VACUUM INTO` reads one consistent snapshot and
writes it as a single self-contained file, and it does so on its own connection, in a worker thread:
it neither waits for the service's writes nor holds them up. A test posts journals while a backup
runs and checks that the backup replays.

A backup has two files: the snapshot and a manifest written after it. The manifest records when it
was made, how far the ledger had got (the sequence, the book revision and the **chain hash**), the
schema versions, and the snapshot's SHA-256, and carries a hash of itself. A snapshot without a
manifest is not a backup; it is listed as an unrecorded file and never trusted.

## What verification proves, and what it does not

Verification does not look at the backup file in place. It hashes it, runs SQLite's integrity check
on it read-only, compares the ledger position stored inside with the manifest, and then copies it and
**replays the ledger on the copy**, through the same code that serves every read of the live book:
each retained command is run again in the accounting kernel and its result is compared, byte for byte,
with the result the ledger kept. The replay also walks the hash chain, so a missing, altered or
reordered outcome fails.

That proves:

- the file is the file that was written (a flipped byte anywhere fails the hash, and the costly replay
  is skipped because the file is already known to be bad);
- the file is a database SQLite can read, with the ledger the manifest names;
- the ledger replays, to the same chain hash, so the books in the backup are the books the kernel
  derives from the commands in it. A backup whose manifest was rewritten to match a damaged ledger
  still fails, at the replay.

It does not prove that the books are *right* (a wrong entry replays perfectly), that the backup is
somewhere safe, or that nobody with access to your user account altered both a backup and its
manifest and re-sealed it consistently: the manifest's hash stops accidents, not an attacker who can
write to the folder. For that, keep a copy elsewhere.

Replaying takes time, and it should be said plainly why: the kernel re-derives the state for every
command and compares it with what the ledger recorded. For a book made since 2026-10-07 each command
costs the same whatever the book holds, so a replay takes about a second for every thousand entries:
under a second for a few hundred journals, 4 seconds for 5,000 and 15 for 20,000. For a book made
before then the kernel hashed the whole state for every command, so a replay costs about the square of
the book: about 0.3 seconds for 100 journals, 5 for 500, 22 for 1,000 and minutes beyond several
thousand. Verification and the drill therefore run off the service's thread and report progress with an
estimate instead of a spinner (the estimate follows how the book's kind grows), and the replay time of
the last verification is recorded and shown.

## The restore drill

A backup you have never restored is a hope. The drill restores the newest backup into a temporary
directory the way a real restore would (copy, check the copy is identical), replays it, and then
compares it with the live book at the same point in history: the ledger's position, the **kernel's own
revision chain** at that revision (a second chain, independent of how the ledger stores outcomes), and
the balance of every account. Changes made since the backup are counted and reported, not held against
it. A backup that is from a different book fails at the chain; one whose accounts do not match fails at
the balances. One replay does all of it.

## Restore is offline and cautious

Restoring replaces files, so it is a command you run with the service stopped, not a button. It
verifies first and installs nothing unless everything passes. It never overwrites a database unless you
say `--replace`, and then it keeps a copy of what it replaces, including the write-ahead files, which
belong to the old database and would be applied to the new one if left behind. It refuses outright if
the database is open in another process, because replacing a database that is in use corrupts it. The
file it installs is the verified backup byte for byte, and its hash is checked again after writing.

## Backups that do not depend on you remembering

The local service takes a backup each day it is running and once more when it stops, verifies it,
keeps the newest of each recent day, week and month, and records what it did (a failure is shown on the
screen with its reason). It does this in the background and never inside a request. When nothing in the
database has changed since the newest backup (the snapshot would be byte-for-byte the same) it does not
keep a second copy, and it only repeats the verification, so what Home says stays honest:
it asks for a backup only when none has passed its check or the last one that did is old, and the step
"Verify a backup" is ticked because a backup of your book actually passed.

## The open export

A backup is for getting your books back with Rastrata. The **open export** is for the other promise: a
person can always take their books and leave. It is a folder of ordinary files with a README that
explains them: the journals as JSON lines (with their lines, sources, references, reversals and
provenance), the chart, the general ledger and the trial balance as CSV, the source events, and
`commands.jsonl`, every sealed command with the chain hash it produced. A manifest and a `SHA256SUMS`
file let anyone check the folder with standard tools.

The export is also enough to rebuild the book. `import-export` provisions the book's starting record
into a new database and replays every command in order; the chain hash after each must equal the one
the export recorded, and the new database is moved into place only when the last one equals the
export's head. A rebuilt book is therefore the same book, proved by a hash, not a plausible copy. It
also re-creates the application's index of what was done (so an old operation identity is found and a
posted source still cannot be posted twice) and the references the journals were given.

Beside the ledger the export holds the business's own records, as plain files: every reconciliation that was
completed or voided with the lines it cleared, the rules and the deleted rules, the payees, the tags on the accounts
and the history of what changed in the books. They are for reading and keeping; rebuilding a book uses the journals'
commands alone. What an export does not hold is working state: drafts, Inbox items, connections to banks and payment
providers, who has access and other settings. A backup holds those. The CSV files neutralise any text that begins like a spreadsheet
formula, because narrations and names can come from bank memos and other outside text; money columns
are plain decimals, so negative figures stay numbers.

## Limits, said plainly

- Backups and exports are not encrypted. They hold your whole business: keep them where the disk's own
  protection covers them.
- The default backup folder is on the same disk as the book. The screen says so; copy it elsewhere.
- Creating backups and exports needs the `configure` permission; changing the automatic settings needs
  the owner's own access (`provision`). An agent token can be given the first knowingly and never the
  second.
- Backups and exports are produced by the local service. A hosted ledger would need its own.

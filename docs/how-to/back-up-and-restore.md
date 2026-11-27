# Back up, verify and restore your book

How to keep your books safe, check that the backups work, get your books back after a bad day, and
take your data out.
<!-- help: skip -->
For what a backup is and what verification proves, see
[Backups, verification and the open export](../explanation/backups-and-the-open-export.md).
<!-- help: end -->

Everything here works from the **Backups** screen (Settings, Backups and export), from the command
line, or through an agent.
<!-- help: skip -->
The commands assume the service is running (`bun run dev:api`) unless
they say offline.
<!-- help: end -->

## See how safe your books are

Open **Backups** in the navigation (Settings, Backups and export). The screen opens with one sentence
about the book (your books are backed up and checked, your backups need attention, or your books are not
safely backed up), then every warning with what to do. **Back up now** is the button beside the page's title.
Under the warnings are **Check the newest backup** and **Test a restore**, and where you stand: the newest
backup, the newest backup that passed verification, the last restore test, whether automatic backups run,
and the backup folder. Below are your
backups (each with its checks one click away), the export, the automatic backup settings and a reminder of
how to restore. A check or a restore test shows what it is doing, how far it has got and an estimate of
what is left, and your books stay usable while it runs. The Home screen shows a card with the last verified
backup, and warns when no backup has been verified for 48 hours.

```sh
rastrata backup status
```

## Back up now

A backup is a complete copy of your books: every entry and everything the application keeps
beside them (drafts, source events, settings). It does not interrupt anything you are doing.

```sh
rastrata backup create
```

A backup lands in a folder beside your database (`backups/<book>/`), or in `RASTRATA_BACKUP_DIR`.
Each is one `.sqlite` file and one `.manifest.json` that records when it was made, how far the ledger
had got, and the file's SHA-256. The folder is private to your user.

**Keep backups somewhere else as well** (another drive, or storage you trust). A backup on the same
disk as your book does not protect you from that disk failing, and the screen says so when it sees it.
With an installed Rastrata (see [Install Rastrata](install-rastrata.md)), one command moves the folder:
`rastrata backup folder /Volumes/Backup/rastrata`; `rastrata doctor` points it out while the backups
are on your books' own disk. Backups are not encrypted.

Automatic backups run once a day while the service is running, and once more when it stops. You do
not need to keep it running all day: if it was off at the usual time, it backs up when it starts.

## Verify a backup

A backup you have not verified may not restore. Verification opens a copy of the backup, never the
backup itself, and checks four things: the file against its manifest, SQLite's own integrity check,
the ledger's position against the manifest, and then it **replays every command in your ledger** and
checks that each gives exactly the result the ledger recorded.

```sh
rastrata backup verify            # the newest backup
rastrata backup verify BACKUP_ID
```

The replay takes longer the bigger the book. For a book made since 2026-10-07 it takes about a second for
every thousand entries: under a second for a few hundred journals, 4 seconds for 5,000 and 15 for 20,000.
For a book made before then it grows with the square: about 0.3 seconds for 100 journals, 5 seconds for
500, 22 seconds for 1,000 and minutes for several thousand. The screen and the command show progress and
an estimate, and your books stay usable meanwhile, because the work runs on its own thread. Automatic
backups are verified for you unless you turn that off.

If a check fails, the result says which and why, and the backup is marked as not to be relied on.
Take a new backup and verify it. Do not delete the failed one until you have a good one: it may still
hold something recoverable.

## Test a restore (the restore drill)

A drill proves that your newest backup rebuilds the books you have now, without touching them. It
restores the backup into a temporary directory the way a real restore would, replays it, then
compares its head, its chain and the balance of every account with your live books at the same
point. Changes made since the backup are reported but not counted against it.

```sh
rastrata backup drill
```

Run one after setting up, and now and then. The result is recorded and shown on the screen.

## Change the automatic backups

On the Backups screen, or (the owner only; an agent token cannot) with a settings file:

```sh
rastrata backup status      # shows the current settings
rastrata backup configure --input settings.json
```

`settings.json`:

```json
{
  "enabled": true,
  "intervalHours": 24,
  "onShutdown": true,
  "verifyAfterBackup": true,
  "keepDaily": 7,
  "keepWeekly": 4,
  "keepMonthly": 12,
  "warnAfterHours": 48
}
```

Retention keeps the newest automatic backup of each of the last 7 days, 4 weeks and 12 months that
have one. It never removes a backup you made by hand, the newest backup, or the newest backup that
passed verification. Lowering the numbers deletes older automatic backups at the next clean-up.

## Get your books back after a bad day

Restoring is done with the service **stopped**, from the command line, on purpose: it replaces files.

```sh
rastrata restore latest --to /path/to/book.sqlite --replace
```

- `latest` is the newest backup in the backup folder; you can name a backup id or a backup file
  instead. Put the options after it.
- It **verifies first**, exactly as above, and installs nothing unless every check passes.
- It **refuses to overwrite** an existing database unless you pass `--replace`; with it, it first
  keeps everything it replaces (the database and its write-ahead files) in a folder named
  `book.sqlite.replaced-<time>` beside it, and it refuses outright if another process, usually the
  service, has that database open.
- Restore to a new path first (without `--replace`) if you would like to look before you replace.

Then start the service on the restored database. The first time it reads the book it may replay the
whole ledger: seconds for a small book, minutes for a big one (the command tells you how long its own
check took, and the first start takes about as long). It happens once.

Add `--quick` to skip the replay in the command when you are in a hurry: the file checks still run,
and the service replays the ledger when it starts anyway.

**If you installed Rastrata** (see [Install Rastrata](install-rastrata.md)) the tool is inside the
`rastrata-service` program beside the command, and the command already knows where your book and its
backups are, so after stopping the service it is just:

```sh
rastrata stop
rastrata restore latest --replace
rastrata start
```

`rastrata restore` refuses, and says to stop the service, if the service has the book open. Backups
you moved with `rastrata backup folder` are looked for there.
<!-- help: skip -->
In a copy built from the repository the
command needs the offline tool, which runs from the repository (it finds `apps/api/src/tool.ts` and
needs Bun on the path), or from `RASTRATA_TOOL` set to a command that runs it, and `--to` is required.
<!-- help: end -->

A backup holds everything in the book's database, including the access you had given agents. Agent
tokens are stored as hashes, so no secret is in a backup, but a token you **revoked after the backup was
made is valid again** after a restore. The command says so when the restored book has active tokens: run
`rastrata tokens list` and revoke it again. The Stripe key and the owner key file are private files beside the
database, not in it, so a backup does not hold them: keep your own copy.

If you changed the books after the backup was taken, those changes are not in it. A client's retained
requests (`rastrata operations requests`) may then name operations the restored book never saw:
check them before resuming any.

## Export your books

An export is the open copy: files anyone can read, and that Rastrata can rebuild a book from.

```sh
rastrata export create
rastrata export verify /path/to/export        # offline
rastrata import-export /path/to/export --to /path/to/new.sqlite   # offline
```

An export is a folder with a `README.md` that explains each file, a `manifest.json` with hashes,
the journals, the chart, the general ledger, the trial balance, the source events and every sealed
command. `shasum -a 256 -c SHA256SUMS` checks it without Rastrata. `import-export` replays the
commands into a new database and stops unless the last chain hash equals the one recorded in the
export, so a rebuilt book is the same book, proved by that hash. It never overwrites a database.

An export holds the books, not the working state (drafts, For review items, rules and settings). A backup
holds everything. The spreadsheet files neutralise any text a spreadsheet would run as a formula; the
JSON files keep the exact text.

## When something is wrong

| You see | It means | Do |
| --- | --- | --- |
| "never backed up" | There is no backup. | Back up now, then verify. |
| "No backup has passed verification" | Backups exist but none has been checked. | Verify the newest. |
| "failed verification" | The newest backup is damaged or does not replay. | Take a new backup and verify it; keep the old one for now. |
| "not enough free space" | The backup folder's disk is full. | Free space, or point `RASTRATA_BACKUP_DIR` at a bigger disk. |
| "the newest backup is ahead of this book" | The book was restored from an older copy or replaced. | Check which is right before relying on either. |
| `restore_target_in_use` | The database is open in another process. | Stop the service, then restore. |
| "A job is already running" | A backup, verification or drill is in progress. | Wait for it; the screen shows its progress. |

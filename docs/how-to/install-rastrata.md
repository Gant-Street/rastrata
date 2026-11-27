# Install Rastrata

For anyone who wants to run Rastrata on their own computer without cloning the repository or
installing a programming tool. You unpack one file, run one script, and open an address in your
browser. This page also covers starting, stopping, updating and removing it. What the install keeps
where, and what the owner lock does and does not protect, is in
[Your data directory and the owner lock](../explanation/data-directory-and-owner-lock.md).

Rastrata books and reports. It does not give tax advice or file anything.

## What you need

- **A Mac with Apple silicon** (the first supported target), or **a Linux computer with an x64
  processor and systemd**. The Linux package builds and passes its tests against a stand-in for
  systemd; it has not yet been run on a real Linux machine, so treat Linux as a preview.
- A Terminal window. You do not need an administrator password, `sudo`, a network connection, Bun, Go
  or the repository. The installer refuses to run as root: Rastrata is installed for one person and
  changes nothing outside your home directory.
- The package for your computer, `rastrata-VERSION-OS-ARCH.tar.gz` (for example
  `rastrata-0.1.0-darwin-arm64.tar.gz`), and the `.sha256` file that sits beside it. Where packages are
  published is not decided yet. To build one from the repository, run `bun run package`; it writes the
  two files to `dist/`.

## Install

1. Check the download (optional but quick). In the folder that holds both files:

   ```sh
   shasum -a 256 -c rastrata-0.1.0-darwin-arm64.tar.gz.sha256
   ```

   It should say `OK`. On Linux use `sha256sum -c` instead.

2. Unpack it and run the installer:

   ```sh
   tar -xzf rastrata-0.1.0-darwin-arm64.tar.gz
   cd rastrata-0.1.0-darwin-arm64
   ./install.sh
   ```

   Use the Terminal's `tar` rather than double-clicking the file: a Mac may put a download "quarantine"
   mark on files it unpacks itself and then refuse to run the programs. If it does, run
   `xattr -dr com.apple.quarantine rastrata-0.1.0-darwin-arm64` and start again.

3. The installer checks that the package is for this computer and that no file was damaged (it checks
   every file against `SHA256SUMS`), copies two programs into `~/.local/bin`, sets Rastrata up to start
   when you log in, starts it, waits until it answers and prints where to open it:

   ```text
   Rastrata 0.1.0 is installed and running.

     Open it:    http://127.0.0.1:7278   (or run: rastrata open)
     Your data:  /Users/you/Library/Application Support/Rastrata
     It starts when you log in and restarts if it stops (launchd: ~/Library/LaunchAgents/com.rastrata.service.plist).
     The owner lock is on: the key is in ~/Library/Application Support/Rastrata/owner.key.
   ```

   If `~/.local/bin` is not on your `PATH` it says so and prints the line to add to `~/.zshrc` or
   `~/.bashrc`. Open a new Terminal afterwards so the `rastrata` command is found. On a Mac you may
   also see a notice that a background item was added: that is Rastrata's login item. If it has been
   switched off (`launchctl disable` does that), `rastrata start` says so and gives the one command
   that switches it back on.

4. Open `http://127.0.0.1:7278`, or run `rastrata open`. A new book shows the setup wizard: follow
   [Set up your books](set-up-your-books.md).

5. Run `rastrata doctor`. A fresh install should have no `FAIL`. One `WARN` is expected once your
   books exist: the backups are on the same disk as your books (see
   [Keep your backups on another drive](#keep-your-backups-on-another-drive)).

Installing again over an installed copy is allowed and keeps your books, your owner key and your
settings. To use another port (7278 is the default), or to keep your books somewhere other than the
default place, say so when you install:

```sh
./install.sh --port 7300
./install.sh --data-dir /Volumes/Books/rastrata
```

To put the two programs somewhere other than `~/.local/bin`, set `RASTRATA_BIN_DIR` for the installer
(`RASTRATA_BIN_DIR=~/bin ./install.sh`); every later command finds them beside the one you run.

## What the install put where

| What | Where |
| --- | --- |
| The command line tool and the service | `~/.local/bin/rastrata` and `~/.local/bin/rastrata-service` |
| The login item (macOS) | `~/Library/LaunchAgents/com.rastrata.service.plist` |
| The login item (Linux) | `~/.config/systemd/user/rastrata.service` |
| Your books, backups, owner key, settings and logs | Your **data directory**: `~/Library/Application Support/Rastrata` on macOS, `${XDG_DATA_HOME:-~/.local/share}/rastrata` on Linux |
| The address | `http://127.0.0.1:7278`, on this computer only |

The service listens on `127.0.0.1` and nowhere else. Another computer on your network cannot reach it,
and there is no setting that makes it listen more widely.

## Everyday use

You do not start Rastrata yourself: it starts when you log in and starts again if it stops without
being asked to. These commands look after it. At a terminal they print plain text; piped into another
program, or with `--format json`, they print JSON.

| Command | What it does |
| --- | --- |
| `rastrata status` | Says whether it is running, at which address, which release, and where your data is. Exits 3 if it is not running. |
| `rastrata open` | Opens the web app in your browser, starting the service first if it is stopped. `--print` shows the address instead. |
| `rastrata doctor` | Checks the install and tells you what to do about anything wrong. See [What doctor checks](#what-doctor-checks). |
| `rastrata logs` | Shows the last 50 lines of the service's log. `--lines N` for more, `--follow` to keep watching, `--stdio` for what the process itself printed. |
| `rastrata stop` | Stops it now. It takes a last backup first. It starts again at your next login. |
| `rastrata start` | Starts it now and waits until it answers. |
| `rastrata backup folder PATH` | Keeps backups on another drive. |
| `rastrata update --from FILE` | Installs a newer package. See [Update](#update). |
| `rastrata uninstall` | Removes the login item and the programs. Your books stay. |

**After it starts**, the service reads your book once, in the background, so that the first page you
open does not have to wait for it. A small book takes a second or two; a book of a thousand journals
about a second when its last snapshot is not up to date, and one of 20,000 about 15 seconds. A book made
before 2026-10-07 takes about twenty seconds at a thousand journals and more beyond. All of it takes
longer on a busy computer. While it reads, the service answers, but whatever needs the book waits and
then goes on by itself:
`rastrata status` says "It is reading your books, about 40 seconds", the web app's footer says the same
and counts down, and `rastrata doctor` has a *Book* row. If it cannot read the book (a damaged file) it
stays up and says so in the same three places, and `rastrata doctor` gives the steps.

The `rastrata` you installed already knows where the service is and reads the owner key from your data
directory, so `rastrata context`, `rastrata reports ...` and the rest of the [command line](../reference/terminal-app-scope.md)
work with nothing to configure.

A copy of Rastrata built from the repository (`bun run dev:api`) is a different thing: it listens on
port 4010, keeps its book in the repository and is never touched by the installed one. You can run both.

## What doctor checks

`rastrata doctor` reads and asks; it changes nothing. It never prints your owner key, only whether
there is one and who can read the file.

| Check | A failure means |
| --- | --- |
| Login item | It is not set to start at login, or it is set up but not running. |
| Answers | Nothing is listening on the port, or another program is using it. |
| Version | The command, the installed service program and the running service are not the same release (for example after an update that was not restarted). |
| Book | The service could not read your books when it started: a failure, with the steps to look at the log and restore the newest verified backup. While it is still reading them it is a warning (wait, then ask again); otherwise it says how long the last start took. |
| Environment | A variable in your shell (`RASTRATA_API_URL`, `RASTRATA_OWNER_KEY_FILE`, `RASTRATA_TOKEN`) makes the `rastrata` command talk to something other than the installed service, or act as an agent token. Warnings, with what to unset. A shell set up for development often has one. |
| Data directory | It is missing, belongs to someone else, or other users can open it (a warning, with the `chmod 700` line). |
| Free space | Less than 50 MB is free where your books are (a warning below 500 MB or five times the size of the book). |
| Owner lock | The service is **open** (a request with no credentials was accepted), the key file can be read by other users, there is no key file, or the key is not the one the running service uses. |
| Backups | There is no backup, none has passed verification, or the newest verified one is older than the 48 hours the Backups screen allows. |
| Backup place | The backups are on the same disk as your books. A warning, with the one-line fix. |
| Capacity | How much one book holds: its journals, what its saved snapshot is, and about how long a restart takes. A warning only when a restart would take a minute, which for a book made since 2026-10-07 is tens of thousands of journals; for an older book also from 60% of the 16 MB its snapshot can be. See [How big a book can get](#how-big-a-book-can-get). |

It exits with status 3 if anything failed and 0 otherwise; warnings are advice.

## How big a book can get

A book made since 2026-10-07 has no limit in journals that you will meet before tens of thousands.
When the service starts it reads the whole book once, at about a millisecond for every entry in it:
under a second for a few hundred journals, about 4 seconds at 5,000 and about 15 at 20,000. It does
that while nobody is waiting (see [Everyday use](#everyday-use)), so what you notice is the footer
counting down, not a page that hangs.

To shorten that read the service saves a copy of the whole verified book, a snapshot, every 100
entries and when it stops, so a restart reads one file and then only what is new. A snapshot can be at
most 16 MB, which is about 1,600 journals of two lines. That is a limit on the snapshot, not on the
book: past it the service keeps the last snapshot it saved, and a restart reads that and the entries
made since, which costs the same millisecond an entry. `rastrata doctor` (the *Capacity* row) says what
the snapshot is and what a restart costs, as a fact rather than a warning, and warns only when a
restart would take a minute (about 60,000 entries). The time it gives comes from the replay your last
backup check timed on this computer, scaled to the size of the book now; until a backup of at least a
hundred entries has been checked it is the rule of thumb of a millisecond an entry, and the message
says which. A book with a few hundred journals a year has years of room.

A book made before 2026-10-07 (the package built on 2026-10-06 made some) is the older kind: reading it
from the start grows with the square of its size, about 22 seconds at a thousand journals, about 90 at
two thousand and minutes beyond three thousand, so it is comfortable to roughly a thousand to two
thousand journals. For such a book doctor keeps its warning from 60% of the 16 MB, and says in a
sentence that books made now are faster. A book cannot be converted yet. What to expect and what is
planned is in
[the scale limit](../reference/program/main.md#the-scale-limit-and-what-we-do-about-it).

## Keep your backups on another drive

Rastrata backs your books up by itself: about five seconds after it starts, then whenever one is due
(daily by default), and once more when it stops. It verifies them in the background. Out of the box
the backups are in your data directory, on the same disk as your books, and they are **not
encrypted**. A disk that fails takes both, and anyone who can read the folder can read your books.

Point them at a drive you trust with one command:

```sh
rastrata backup folder /Volumes/Backup/rastrata
```

It checks that the folder can be written (making it, private to you with mode 700, if it does not
exist), saves the choice in your settings file and restarts the service so it takes effect. Backups already made stay where they were;
copy them over if you want them together. `rastrata backup folder` with no path shows where they go now,
and `rastrata backup folder --reset` goes back to the default. If `RASTRATA_BACKUP_DIR` is set in the
service's environment it wins over the setting. The rest, including restoring, is in
[Back up, verify and restore your book](back-up-and-restore.md).

## Update

Updating needs no network: you give it a newer package file.

```sh
rastrata update --from ~/Downloads/rastrata-0.1.1-darwin-arm64.tar.gz
```

It does these steps, and stops at the first that fails:

1. **Checks the package** before it touches anything: the name, the `.sha256` file beside it, the shape
   of every entry in the archive (it refuses links, paths that climb out of the folder and anything
   that is not a plain file), and `SHA256SUMS` against every file inside. It also runs the new
   programs to see that they run on this computer and say the release they should.
2. **Takes a backup** of your books through the running service and waits for it. If that fails,
   nothing has changed.
3. **Stops** the service (which takes its own last backup), puts the new programs in place, and starts
   the new version with its own login item.
4. **Checks** that the release that answers is the new one. If it does not start, the old programs are
   put back and started again, and the command says so.

The old programs are kept beside the new ones as `rastrata.previous` and `rastrata-service.previous`.

An older package is refused unless you add `--allow-downgrade`: a book that a newer release has opened
may not open in an older one, so only do that with a verified backup in hand. Your books are never
touched by the programs being replaced; they are in the data directory.

## Uninstall

```sh
rastrata uninstall
```

It stops the service, removes the login item and removes the programs from `~/.local/bin` (and their
`.previous` copies). **It never touches your books**: the data directory, with the book, the backups
and the owner key, stays where it was, and the command tells you where. To start again later, run
`install.sh` from a package. To delete your books, which cannot be undone, delete the data directory
yourself, and only if you have a copy of the backups you want to keep.

## When something is wrong

Run `rastrata doctor` first; it names the problem and the command that fixes it. For the rest:

| You see | It means | Do |
| --- | --- | --- |
| `install: the files do not match SHA256SUMS` | The package was damaged or changed after it was built. | Download it again. |
| `install: this package is for darwin-arm64, and this computer is ...` | You have the package for another kind of computer. | Get the one for yours. |
| `rastrata does not run here` and a mention of quarantine | The Mac blocked programs that came from a download. | `xattr -dr com.apple.quarantine <the unpacked folder>`, then `./install.sh` again. |
| `another program is using port 7278` | Something else listens there. | `rastrata install --port 7300` (any free port). The command line follows the new port by itself. |
| `It is reading your books, about 40 seconds` (from `rastrata status` or the footer) | The service has just started and is reading your book. | Wait. It answers meanwhile, and the pages that need the book open when it is done. A command that waits more than 15 seconds says `Rastrata is not answering`; `rastrata status` then says the same thing. |
| `The service is up but could not read your books` (from `rastrata doctor`) | The ledger in `book.sqlite` is damaged, or was edited. Nothing was changed. | `rastrata logs` for the details. To go back to the newest verified backup: `rastrata stop`, `rastrata restore latest --replace`, `rastrata start`. |
| `Rastrata is not answering` from any command | The service is stopped or has crashed. | `rastrata status`, then `rastrata start`; `rastrata logs` says why it stopped. |
| `installed, but the service did not answer ... within 45 seconds` | It started and stopped, or is replaying a very large book. | `rastrata logs` and `rastrata logs --stdio`. |
| `The owner key file ... can be read by other users` | The key file's permissions were loosened, so the lock would protect nothing; the service refuses to start. | `chmod 600` the file it names, then `rastrata start`. |
| `the key in ... is not the one the running service uses` | The key file was replaced while the service ran. | `rastrata stop`, then `rastrata start`. |
| On Linux, `systemd cannot be reached for your user` | There is no systemd user session (a plain SSH login, a container). | Log in with a session that has one, or run `loginctl enable-linger $USER`. |

## For developers

Everything above is built from the repository:

- `bun run build:service` writes the service executable (`dist/rastrata-service`): Bun's single-file
  compile with the web app inside, about 67 MB.
- `bun run package` writes `dist/rastrata-VERSION-OS-ARCH.tar.gz` and its `.sha256`. `--target
  linux-amd64` builds the Linux package (Bun fetches the other system's runtime the first time).
  The same inputs give the same archive bytes.
- `apps/api/test/installed.test.ts` runs the compiled service in a home of its own, and
  `apps/api/test/package.test.ts` builds the package, unpacks it, runs `install.sh` against stand-ins
  for `launchctl` and `systemctl` that really start the program, and drives every command above,
  including an update, a refused downgrade, a damaged package and an uninstall.
- The engineering record, decisions and open issues are in [the install lane](../reference/program/install.md).

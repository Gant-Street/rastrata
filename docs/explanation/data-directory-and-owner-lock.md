# Your data directory and the owner lock

For anyone who has installed Rastrata and wants to know where their books are, who can reach them,
and what the "owner lock" does and does not protect. The steps are in
[Install Rastrata](../how-to/install-rastrata.md). How an agent is given limited access is in
[Agent access](agent-access.md); this page is about the installed service, whose defaults are the
safe ones.

## Where everything is

Everything that belongs to one person is in one **data directory**, found by one rule:

| System | Data directory |
| --- | --- |
| macOS | `~/Library/Application Support/Rastrata` |
| Linux | `$XDG_DATA_HOME/rastrata`, else `~/.local/share/rastrata` |

```text
Rastrata/
  book.sqlite            your books: the ledger and everything the application keeps beside it
  book.sqlite-wal, -shm  SQLite's write-ahead files, present while the service runs
  backups/book/          backups, each a .sqlite file with a .manifest.json beside it
  exports/book/          open exports, when you make one
  owner.key              the owner key (made the first time the service starts)
  config.json            settings, only if you changed something: the port, a backup folder
  stripe.key             your Stripe key, only if you connected Stripe (the Stripe lane's file)
  simplefin.access       your SimpleFIN bank connection, only if you connected a bank feed (the bank feed lane's file; in no backup or export)
  logs/service.log       what the service did (start, stop, errors); rotated at 2 MiB, three kept
  logs/service-stdio.log what the process itself printed, which is normally nothing
```

The directory and its `logs` folder are made **private to you** (mode 700). The service runs with a
umask of 077, so every file it creates, the book included, is readable by you alone. A directory that
already exists is never changed: if other users can open it, `rastrata doctor` says so, with the
`chmod 700` line, and the service logs a warning.

Why one directory and not a database server's usual places: it is the unit you back up, move and
delete, it needs no administrator, and a person can find it. Why per user: the books belong to one
person, and a service started at login runs as that person.

### Moving things

Every part has its own setting. They must be **absolute paths**: a service started at login does not
run in a directory a relative path could mean anything in, so a relative one (or `~/Books`, which no
program expands for a login item) is refused with a message that says so.

| To move | Set | Notes |
| --- | --- | --- |
| The whole directory | `RASTRATA_DATA_DIR`, or `rastrata install --data-dir DIR` | The installer records it in the login item, and the command line reads it back from there, so commands run from a shell without the variable still look in the right place. |
| The book | `RASTRATA_LOCAL_DB` | Backups and exports follow it, in `backups/<name>/` and `exports/<name>/` beside it, named after the file. |
| The backups | `rastrata backup folder PATH`, or `RASTRATA_BACKUP_DIR` | The command saves it in `config.json` as `backupDir` and restarts the service. The environment variable wins over the file. |
| The exports | `RASTRATA_EXPORT_DIR` | |
| The owner key | `RASTRATA_OWNER_KEY_FILE` | |
| The log folder | `RASTRATA_LOG_DIR` | |
| The port | `rastrata install --port N`, or `RASTRATA_API_PORT` | Saved in `config.json` as `port`; the command line follows it. The default is 7278, which is not the development API's port 4010, so a checkout and a real book never meet by accident. |

A login item does not see your shell's variables. The one thing it is given is the data directory
(`rastrata install --data-dir` records it in the login item), and the port and the backup folder are
read from `config.json`. The other variables move parts of a service you start **by hand**
(`rastrata-service`). When the `rastrata` command looks after the login item it ignores them, so a
shell set up for development (`RASTRATA_LOCAL_DB`, `RASTRATA_API_PORT` and the like) cannot send it to
places the installed service never uses; `rastrata doctor` warns about the three variables that change
what the command line itself does: `RASTRATA_API_URL`, `RASTRATA_OWNER_KEY_FILE` and `RASTRATA_TOKEN`.

The service and the command line each have their own copy of this rule (TypeScript in
`apps/api/src/data-directory.ts`, Go in `apps/terminal/internal/service/paths.go`), and both are tested
against the same list of cases (`apps/api/test/data-directory.vectors.json`), so they cannot disagree
about where your books are.

Nothing here is encrypted. Backups, the book and the key are plain files protected only by who may
open them. Turn on your disk's encryption (FileVault on a Mac, LUKS on Linux) and keep the backup
folder on a disk you trust.

Two things not to do with the files. Do not keep `book.sqlite` in a folder that a sync service (iCloud
Drive, Dropbox) or a file-copy tool watches: they copy the book while the service is writing to it, and
a copy taken in the middle may not open. Copy the **backups** instead: each backup is a finished file
that is never changed afterwards, so a synced folder (or a plain copy to another drive) is a good place
for them, which is what `rastrata backup folder` is for. And do not delete or move `book.sqlite`'s
`-wal` file while the service runs; stop it first (`rastrata stop`).

## The owner lock

The service has two kinds of caller: you, the owner, and an agent you gave a token to. The lock is
what makes the first kind prove itself.

- **On by default.** The first time the service starts it makes an **owner key** (`rso_` and 43
  characters of randomness) in `owner.key`, readable only by you. A request that carries no
  credentials is refused with `401 authentication_required`; the owner key opens the owner's access;
  an agent token opens only what the token allows (`read`, `draft`, `post`, `configure`, `correct`,
  `close`, never `provision`). A credential that is present and wrong is a 401 as well, never "no
  credentials". If `owner.key` can be read by other users the service refuses to start and says how
  to fix it, because the lock would protect nothing. The key is never written to the log, to an
  error or to `rastrata doctor` (which says only that the file exists and who can read it).
- **The web app.** Your browser sends no key, and the page holds none. The service attaches the key to
  a request on its behalf **only** when the request comes from its own app: the browser says
  `Sec-Fetch-Site: same-origin` on its own fetches (the Chromium, Firefox and WebKit engines all do;
  the app was checked in all three, with reads, writes and an upload), or, in a browser too old to say
  it, sends an `Origin` equal to the service's own. A request that already carries a credential keeps
  it: a token is never upgraded to the owner, and a wrong key stays wrong.
- **The command line.** The installed `rastrata` reads the key from your data directory by itself, so
  every command works with nothing configured. `RASTRATA_TOKEN` wins if it is set, so an agent that
  inherited your shell but was given a token still acts as the token.
- **Any other program with no token** is refused, and told what to do.

### The Host rule

A web page on another site can make your own browser talk to `127.0.0.1` ("DNS rebinding": its
address is changed to point there after the page has loaded). Such a request looks same-origin to the
browser, and would otherwise be handed the key. So **every** request, to every route, must carry a
`Host` of `127.0.0.1`, `localhost` or `[::1]` followed by the service's own port; anything else gets
`421` before the request is read. The responses also say they must not be framed
(`frame-ancestors 'none'`, `X-Frame-Options: DENY`) or read by another site
(`Cross-Origin-Resource-Policy: same-origin`), and the page's scripts are limited to the app's own
file and its one inline script, allowed by its hash.

### What the lock does and does not protect

Any program, or any other user, on the computer can send those headers, so the lock bounds a
well-behaved agent configured with a token, not hostile software or other accounts on a shared
computer. The real boundary arrives with hosting.

In plainer terms:

- It **does** stop a web page you visit from reaching your books through your browser, and it stops a
  program (or an agent) that has no key and no token from using them, and from silently acting as you
  when it forgot its token. It keeps an agent that was given a token on its token.
- It does **not** stop a program running as you: it can read `owner.key` (a file in your account) or
  simply send the browser's headers. An agent that runs as you and goes looking can act as you.
- It does **not** separate user accounts on a shared computer. The service listens on the loopback
  address, which every account on the machine can reach, and an account that sends the app's headers
  is treated as the app. **Do not install Rastrata on a computer you share with people you do not
  trust.** Until hosting arrives, give each person their own computer or their own login on a
  computer only they use.
- It does **not** encrypt anything on disk.

Until hosting, the habits that matter are: give an agent only a token and keep your owner key out of
its environment; start it with `draft` access, so that you approve what is posted; read the agent
activity list on the Agent access screen or with `rastrata tokens activity`; keep the disk encrypted;
and keep a copy of your backups on a drive you trust.

## Why it listens on this computer only

The service binds `127.0.0.1` and nothing can change that: there is no setting for the address, on
purpose. A bookkeeping service that a mistyped option exposes to a café's network is worse than one
that is slightly harder to reach from your phone. Reaching it from another device is a hosting
feature, which will have sign-in; it is not a setting on this one.

## What is logged

`logs/service.log` records what the service did: that it started and on which address, where the data
and backups are, that backups ran or failed, that it stopped, and unexpected errors with a short stack.
It never records a request, an operation's contents, a bank memo, a file name from an import or any
credential. Anything that did come from outside (inside an error message, say) is written on one line
with control characters removed, so text from a bank cannot rewrite your screen when you read the log
with `rastrata logs`, which removes them again on the way out.

## What is not here yet

- **Hosting and sign-in**, which is where a real boundary between people and programs comes from.
- **Encryption at rest** for the book and the backups.
- **An MCP server in the package.** An agent uses the `rastrata` command with its token; `rastrata
  agent init` leaves out the MCP entry in the installed build unless you ask for it.
- **A macOS package signed and notarised by Apple**, so a package that came from a browser download
  may need `xattr -dr com.apple.quarantine` the first time.
- **A Linux package that has run on a real Linux machine**; it is built and tested against a stand-in
  for systemd.

# Local application API

The independently started Bun service owns the local book and serves the web,
CLI and TUI. Authentication is deferred; this explicit development mode binds
to loopback and grants the fixed local operator the supported business permissions.

```sh
bun run dev:api
RASTRATA_API_URL=http://127.0.0.1:4010 bun run dev:web
```

The API listens at `http://127.0.0.1:4010`. `RASTRATA_API_PORT` changes its port.
`RASTRATA_LOCAL_DB` changes its SQLite path. The default remains
`apps/web/.local/book.sqlite`, preserving existing local books. Stop the previous
local web server before migrating; this service is the single owner of the book.
The frontend no longer opens the database. Neither starting process seeds a book.

`GET /v1/schema` publishes the language-neutral contract. Every workflow uses
`POST /v1/<operation>` with `{version, bookId, input, operationId?}`; writes require
a UUID. Preparation retains an immutable plan, its hash and expected revision;
`operations.commit` requires that plan ID and hash. A lost reply is recovered with
`operations.get` and an identical retry. Input changes require a new identity.
Commit enforces the permission associated with the recorded plan kind.

`POST /v1/batch` with `{version, requests: [{name, body}]}` carries up to 40 **reads** together and answers
`{responses: [{status, body}]}`: for each request, in order, the status and body its own route gives the same `body`.
A write named in a batch is refused without being run (`batch_reads_only`), and each read is checked for its permission as
it would be alone. The web app sends the reads a screen asks for in the same moment this way, so that a page pays one round
trip, one check of the credential and one place in the book's queue (docs/reference/program/performance.md); the command line
and an agent may do the same, or keep calling the operations one by one.

`/api/*` is the compatibility grouping for current browser screens. It calls the
same application workflows and includes the API version response header. The
canonical operation catalog and JSON responses are in `packages/application`.

The default book ID is `local-book`. Clients cannot change the server-owned
scope or actor through request fields. Do not expose this unauthenticated local
mode beyond loopback.

## The installed service

`src/rastrata-service.ts` is the entry of the installed product: the same server and the same
application, with the web app served from the same process and the safe defaults on. It is compiled
into one executable (`bun run build:service`, `tooling/build-service.ts`), put in a package with the
command line tool (`bun run package`, `tooling/package.ts`) and installed with `install.sh`; see
[Install Rastrata](../../docs/how-to/install-rastrata.md) and the engineering record,
[the install lane](../../docs/reference/program/install.md).

```sh
rastrata-service [serve]     # what the login item runs: 127.0.0.1:7278, the lock on, backups on
rastrata-service version
rastrata-service paths       # where this user's data is kept, as JSON
rastrata-service tool ...    # the offline tool: restore, import-export, check-export (no Bun needed)
```

It differs from `bun run dev:api` in its defaults. It listens on **7278** (`RASTRATA_API_PORT` or
`config.json` change it); its data is in the per-user data directory (`RASTRATA_DATA_DIR`, the other
`RASTRATA_*` paths, and [the explanation](../../docs/explanation/data-directory-and-owner-lock.md)); the owner lock
is **on** (the key is made in the data directory on first run; a key file others can read stops the
start); automatic backups are on; every request must name `127.0.0.1`, `localhost` or `[::1]` and the
server's own port in its `Host` header (421 otherwise); and the web app's own requests, and only
those, are given the owner key by the service. `/health` answers `{ok, service, version}` and is never
locked. The service never reads a `.env` or `bunfig.toml` from the directory it is started in.

## Agent tokens and the owner lock

A request with no `Authorization` header is the runtime's owner, as above. `Authorization: Bearer
rst_<id>_<secret>` is an agent token: it holds only the permissions the owner gave it (never
`provision`), only on `/v1`, and a credential that is present but refused is a 401 that never falls
back to the owner. The owner creates and revokes tokens with `tokens.create|list|revoke|activity`
(`rastrata tokens ...`, or the Agent access screen). See [Agent access](../../docs/explanation/agent-access.md).

`RASTRATA_OWNER_KEY_FILE` locks the owner: the service creates the file (mode 0600) if it is missing
and then refuses requests that carry neither the owner key nor a token. It is off by default. The CLI,
the web server and the MCP server read the same variable. On one computer a program running as you
can read that file, so the lock bounds a well-behaved agent configured with a token, not hostile
software. `/health` is never locked.

## Backups, restore and the open export

The service backs the book up on its own while it runs. About five seconds after it starts, and then once
a minute, it checks whether a backup is due (there is none yet, the newest is missing or failed its check,
or the interval, 24 hours by default, has passed since the newest), and when it is stopped with Ctrl-C or
SIGTERM it takes a last one. A backup is a consistent snapshot of the whole book database, taken on a
worker thread so requests keep being answered, with a manifest beside it. The backups the timer takes are
verified in the background; the one at shutdown is only taken, because a check would hold the process up.
The interval, the shutdown backup, the retention and the warning time are settings on the Backups screen
(owner access only). They are described in
[Back up, verify and restore your book](../../docs/how-to/back-up-and-restore.md); the engineering record is
[the safety lane](../../docs/reference/program/safety.md).

- `RASTRATA_BACKUP_DIR` and `RASTRATA_EXPORT_DIR` choose where backups and exports go. The defaults are
  `backups/<book>/` and `exports/<book>/` beside the database (`<book>` is the database file's name without
  its extension). Put the backup folder on another drive, or in a synced folder, so one failure does not
  take both. The offline restore looks in the same place when it is given `latest` or a backup id; its
  `--backup-dir` option overrides it.
- `RASTRATA_BACKUPS=off` turns the automatic backups off (a throwaway book, a test). The operations
  (`backup.*`, `export.*`) still work.
- `RASTRATA_SAFETY_WAIT_MS` (0 to 30000, default 4000) is how long a long operation waits for its job
  before answering `running`; a test sets it to 0 to see a job's progress on a small book.
- `bun apps/api/src/tool.ts` is the offline tool behind `rastrata restore`, `rastrata import-export` and
  `rastrata export verify`: it works on files, with the service stopped, and prints one JSON envelope on
  stdout with progress on stderr.

A compiled service must list `packages/application/src/local/snapshot-worker.ts` and `verify-worker.ts` as
extra entry points (they run in worker threads) and carry the tool for the restore command.

## A book in a log (an experiment for the hosted design; off unless asked for)

`RASTRATA_BOOK_STORE=r2log://<book id>?bulk=<where>&tail=<where>` starts the same server on a book that lives
in a hash-chained log (`packages/booklog`, [the record](../../docs/reference/program/hosting/hoststore.md))
instead of a file. `RASTRATA_LOCAL_DEV=1` is still needed, the server still listens on loopback only, and the
local product above is not changed by it. A request that changes the book is answered only after its entry is
in the tail; a read is served from a cache under a lease; a cold start reads the book from the bulk store and
the log; a process that loses the lease stops writing; one book to a process.

```sh
RASTRATA_LOCAL_DEV=1 RASTRATA_API_PORT=4011 \
  RASTRATA_BOOK_STORE='r2log://tenant-1?bulk=file:///tmp/bucket&tail=objects' bun apps/api/src/main.ts
```

- `bulk=` (or `RASTRATA_BOOK_BULK`): `file:///dir`, `s3://host[:port]/bucket[/prefix]` (`s3s://` for https; R2, OCI,
  MinIO), `https://host` (the bulk gateway of the tail Worker, `apps/tail-worker`), or `memory`. For an s3 store the key
  comes from `RASTRATA_BOOK_S3_KEY_ID`, `RASTRATA_BOOK_S3_SECRET` and `RASTRATA_BOOK_S3_REGION` (default `auto`), never
  from the URL. **The gateway needs no S3 key**: it takes the tail's token (`RASTRATA_BOOK_TAIL_TOKEN` or
  `RASTRATA_BOOK_TAIL_TOKEN_FILE`), keeps the objects in R2 behind the Worker, can create and read them and cannot overwrite
  or delete one, so a pod that holds the token cannot erase a book. A bearer token is sent only over `https://` (or `http://`
  to this computer, for tests); any other `http://` address is refused at startup, in the tail's address as in this one, and
  neither client follows a redirect.
- `tail=` (or `RASTRATA_BOOK_TAIL`): `postgres://...`; `https://tail.rastrata.com` (the Durable Object tail
  [Worker](../tail-worker), or `http://127.0.0.1:port` for a Worker served on this computer; `do:` before either is the
  older spelling and takes any http address); `objects` (no tail: the bulk store itself, slow, no leases); or
  `memory`. Put a Postgres password in the environment variable, not in the URL.
- A Durable Object tail needs its bearer token: `RASTRATA_BOOK_TAIL_TOKEN`, or `RASTRATA_BOOK_TAIL_TOKEN_FILE`, a file
  that holds it (a Secret mounted in a pod; the trailing newline is ignored); not both. The token is sent only as
  the `Authorization` header of a call to the tail and appears in no log, error, `/control` answer or metric.
  `RASTRATA_BOOK_TAIL_TIMEOUT_MS` is how long one call to it may take (default 3000, 100 to 60000).
- **Idle release.** `RASTRATA_BOOK_IDLE_RELEASE_MS` (default 60000, a minute, on a Durable Object tail, 0, meaning off, on any
  other and on a standby): a process that has had no request for that long gives the book's lease up and stops
  renewing it, and takes it again, catching up with whatever was written meanwhile, when the next request comes. A
  lease is renewed every third of its length (5 s: every 1.7 s), which is 2,160 renewals an hour for a book that is merely
  open, each a Worker request, a Durable Object request and a row written at Cloudflare ($0.0031 an hour beyond the Workers Paid plan's allowances, $2.25 a month for a book held around the clock). Do not combine it with a standby that promotes itself:
  it would take the book at the first release. A standby also polls the tail (`RASTRATA_BOOK_FOLLOW_MS`, default 250
  ms: 345,600 requests a day), so on the free plan run one process and no standby.
- **Books in use are open before a server is ready.** A hosted server that serves many books tells the servers after it which it has open (a small list in the bulk store, `service/hot/`, written when the set changes, every thirty minutes at the longest, and as it stops; the tail Worker's bulk gateway takes this one shape outside `books/`) and, when it starts, opens
  the books the lists name, the ones used last first, **without taking their leases** (so books that the pods it replaces still hold can be opened beside them), before `/ready` answers 200: up to `RASTRATA_PREWARM_BOOKS` books (default 12; 0 opens none and tells no one) and for at most
  `RASTRATA_PREWARM_MS` (default 15000; what is not open by then goes on opening behind it). The first request for a book takes its lease and reads what the log has gained, instead of reading the book from its snapshot. A book that is not on a list, a bucket that cannot be read and a list that
  is not one cost nothing: the book opens with its first request. See [many books](../../docs/reference/program/hosting/many-books.md).
- **A tail that fails is not called again and again.** In front of a Durable Object tail sits a circuit breaker: after
  three failures in a row (a 5xx, a 429, a timeout, an HTML page such as Cloudflare's error 1027, a refused token) every call fails at
  once, without a request, for a wait that begins at a second, doubles each time a probe fails, is capped at a minute
  and is drawn between half and all of its length; then one call goes through, and an answer closes the breaker. While
  it is open a person is told, whatever they were doing, `503 service_limit`: "Service limit reached, try again
  later." with a `Retry-After`; a write whose request had gone out and was not answered is told `commit_uncertain`,
  as before. `RASTRATA_BOOK_TAIL_BREAKER=off` turns it off (for an experiment that injects its own faults).
  `/control/status` shows the breaker (`state`, counts) and the metric `tail.breaker` counts the calls
  it refused. A `/v1` failure is answered in the application's own shape (the identities the client sent, echoed),
  which is what the web client shows.
- An entry (a request's changes, packed) may be at most 1 MiB on a Durable Object tail, since the tail keeps an entry
  in one row of a SQLite database; a larger one is refused with `413 entry_too_large` before anything is sent.
- `cache=` / `RASTRATA_BOOK_CACHE` is the folder for the cache file (default: a folder in the system temp
  folder), `prefix=` / `RASTRATA_BOOK_PREFIX` the key prefix in the bulk store, `RASTRATA_BOOK_WARM=1` (the experiments' entry; the product entry refuses it) opens and
  reads the book as soon as the server is listening, `snapshotEvery=` / `RASTRATA_BOOK_SNAPSHOT_EVERY` takes a
  snapshot of the book every that many entries (default 0, never) so that a cold start replays a bounded log.
- `RASTRATA_BOOK_LEASE_MS` is how long a lease lasts (default 5,000): a book whose holder dies waits this long, at most,
  for a process to take it (a shorter lease means a shorter wait and more renewals; renewal is every third of it).
- `RASTRATA_BOOK_STANDBY=1` starts the process as a standby: it reads the book, builds the application on it and
  warms it, keeps all of that current with the log, serves nothing (`503 book_standby`), and takes the book over
  by itself as soon as its lease is free (`RASTRATA_BOOK_PROMOTE=manual` waits to be told, by
  `POST /control/promote`; `RASTRATA_BOOK_FOLLOW_MS` is how often it looks, 250). It warms once the log has been
  still for 300 ms, since warming is a replay of the whole ledger.
- `RASTRATA_BOOK_CONTROL=1` adds `GET /control/status` (which tail and store, the process's role, whether the
  book is open, the faults in force), `GET /control/tail` (`{depth, ageSeconds, bytes, seq, sealedThrough}`),
  `POST /control/evict` (stop the book cleanly and delete its cache file, so the next request is a cold start),
  `POST /control/fault {kind, seconds}` with `kind` `pause` (freeze the process), `tail` or `r2` (every call
  to that store fails) or `clear`, and the two halves of a handover: `POST /control/drain` (writes are refused
  with `503 book_draining`, reads go on) and `POST /control/release {exit?}` (stop the book cleanly and give the
  lease up). With an owner key set they need it too. Nothing returns an address or a key.
- A tail that has lost the book (its head is behind a snapshot or a sealed segment in the bulk store) is
  refused with `503 tail_behind`, not served as a new empty book; it has to be restored from the bulk store.
- `bun apps/api/src/hosted-import.ts --file book.sqlite` (with `RASTRATA_BOOK_STORE` set) puts a closed book
  file into the log as the book's beginning.

A server never prints or logs a credential: a store is named by its kind (`s3`, `postgres`) and nothing more.

## The hosted product server (accounts, many books, a pod, a tunnel)

`src/hosted-main.ts` is the same hosted server as a product, started from the environment alone: it is what the
image in `deploy/hosted` runs at `https://app.rastrata.com` (the record, with the whole environment contract and what
was measured, is [the hostedprod lane](../../docs/reference/program/hosting/hostedprod.md)). It is **one service**, locked and for accounts: there are no
switches for member tokens, many books or agent tokens, and a setting that is needed is required, each named when it is missing (exit 78).

```sh
RASTRATA_BOOK_STORE=r2log://rastrata-main RASTRATA_BOOK_TAIL=https://tail.rastrata.com \
  RASTRATA_BOOK_TAIL_TOKEN_FILE=/var/run/secrets/rastrata/tail-token RASTRATA_BOOK_BULK=... \
  RASTRATA_BIND=0.0.0.0 RASTRATA_API_PORT=8080 RASTRATA_ALLOWED_HOSTS=app.rastrata.com \
  RASTRATA_PUBLIC_ORIGIN=https://app.rastrata.com RASTRATA_OWNER_KEY=rso_... \
  RASTRATA_SERVICE_KEY_SHA256S=<64 hex digits> bun src/hosted-main.ts
```

- **Who it answers to.** `RASTRATA_BIND` (default `127.0.0.1`), `RASTRATA_ALLOWED_HOSTS` (the Host names it answers to, a
  `421` for any other; the loopback names only while bound to loopback) and `RASTRATA_PUBLIC_ORIGIN` (required: behind the tunnel the
  browser's `Origin` is `https://app.rastrata.com` while the pod sees plain http: the scheme of an `Origin` is compared with
  this, and its host must be the host the request was sent to, a `403` otherwise; it also names who signs the tokens and where their keys are). `X-Forwarded-*` is never believed.
- **The web app** is served beside `/v1` and `/api` (`RASTRATA_WEB_DIR`, default the build in `apps/web/dist`). The service is locked, so it sends a browser that the control plane has not
  signed in (the hint cookie it sets) the sign-in page (`signin.html` of the build) at every address that would have been the app, and the app only once it has; a browser that came from another website,
  which does not send the cookie, is given a page that asks again at once from here. The files under `/assets/` are open to all (hashed
  names, no data); the book is behind the API. The service does not start with a build that has no sign-in page.
- **The operator's key.** `RASTRATA_OWNER_KEY` (or `_FILE`) locks the service and opens the first book (`RASTRATA_BOOK_STORE`'s) as a bearer; with it `/health` tells the operator the detail a stranger
  is not told. There is no sign-in with it for a browser (no `/session/owner`, no cookie), and no agent token is a bearer: an agent has a key of the control plane's that is exchanged for a token.
- **Member tokens and the control plane's key** (always). A person of a workspace signs in at the control Worker and sends the signed token it gives them for a book as a bearer;
  the front door checks it against `<origin>/auth/jwks` before the book is asked, and the book finds the person's role in its own
  member table. `RASTRATA_SERVICE_KEY_SHA256S` (required) lists the digests of the keys the control plane may send as a bearer (`rsv_...`) to change who is in the book; that key can call the four
  `members.*` operations and nothing else. See docs/reference/program/hosting/member-access.md.
- **Many books** (always). One pod serves the books a member token names (its `bid`) and the books the control plane's key names in the
  header `x-rastrata-book`, besides the first: a book is opened when its first request arrives, closed when nobody has used it for `RASTRATA_BOOKS_IDLE_MS` (6
  hours, 10 minutes while the pod is more than three quarters full) and, the least recently used first, when the books held pass `RASTRATA_BOOKS_WARM_MB` or `RASTRATA_BOOKS_MAX`; each book has its own limits
  (`RASTRATA_BOOKS_INFLIGHT`, `RASTRATA_BOOKS_RATE`), and cold loads go through a gate (`RASTRATA_BOOKS_LOADS`); the numbers are optional.
  See docs/reference/program/hosting/many-books.md, and `bun load/many-books.ts` to measure it.
- **Probes.** `GET /live` (the process answers) and `GET /ready` (it can serve: listening, not shutting down) take any Host
  and no session, and depend on neither the lease nor the tail: a quiet book has let its lease go, and a tail outage is told to
  the person as `503 service_limit`, not by taking the pod out of its Service. `/health` is as it was.
- **Stopping.** SIGTERM stops listening, lets the requests in flight finish (10 s at most), seals what the tail holds and
  gives the lease back (15 s at most), and exits 0, inside 28 s (a pod is given 60); exit 78 means the settings are wrong.
- **The image.** `bun scripts/build-hosted-image.ts` builds `deploy/hosted/Dockerfile` for linux/arm64 and prints its digest;
  `bun scripts/smoke-hosted-image.ts` runs it with a read-only root file system on memory stores and checks the probes, the
  sign-in, a write and a read, and the stop. Nothing is pushed.

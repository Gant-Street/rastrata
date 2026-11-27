/** The API server with its book in a log instead of a file: `RASTRATA_BOOK_STORE=r2log://<book id>`.
 * Off unless that is set; the local product is the other branch of `main.ts` and is not changed.
 *
 * What it serves is the same `/v1/*` (and the browser's older `/api/*`) through the same application,
 * but the book's storage is a hash-chained log (packages/booklog): a request that changes the book is
 * answered only after its entry is in the tail (the write barrier at the end of the request), a read
 * is served from a cache under a lease, a cold start reads the book from the bulk store, and a
 * process that loses the lease stops writing. One book per process, as the local server has one, unless it is asked to serve
 * many (`books`, hosted-books.ts): then the others are opened on demand, within a memory budget, beside the first.
 *
 *   RASTRATA_BOOK_STORE=r2log://<book id>?bulk=<where>&tail=<where>&cache=<dir>&prefix=<key prefix>
 *   RASTRATA_BOOK_BULK    (or bulk=)   file:///dir | s3://host[:port]/bucket[/prefix] | s3s://... (https) | memory |
 *                          https://host (the bulk gateway of the tail Worker, apps/tail-worker: the same token as the
 *                          tail, no S3 key, nothing that can delete; http:// only on this computer)
 *   RASTRATA_BOOK_TAIL    (or tail=)   postgres://... | https://host | http://127.0.0.1:port | objects | memory
 *                          (https:// and http:// name a Durable Object tail Worker, apps/tail-worker; `do:` before
 *                          either is the older spelling and accepts any http address)
 *   RASTRATA_BOOK_CACHE   (or cache=)  the folder for the cache file (default: the system temp folder)
 *   RASTRATA_BOOK_PREFIX  (or prefix=) the key prefix in the bulk store, empty or ending in a slash
 *   RASTRATA_BOOK_SNAPSHOT_EVERY (or snapshotEvery=) take a snapshot of the book every this many entries
 *                          (default 0: only the one the import made), so that a cold start replays a bounded log
 *   RASTRATA_BOOK_S3_KEY_ID / RASTRATA_BOOK_S3_SECRET / RASTRATA_BOOK_S3_REGION   for s3 stores
 *   RASTRATA_BOOK_TAIL_TOKEN   the bearer token of a Durable Object tail, or
 *   RASTRATA_BOOK_TAIL_TOKEN_FILE   a file that holds it (a mounted Secret; a trailing newline is ignored)
 *   RASTRATA_BOOK_TAIL_TIMEOUT_MS   how long one call to a Durable Object tail may take (default 3000)
 *   RASTRATA_BOOK_TAIL_BREAKER=off   no circuit breaker in front of a Durable Object tail (default on; for an experiment
 *                          that injects its own faults)
 *   RASTRATA_BOOK_IDLE_RELEASE_MS   give the lease up after this long without a request, and take it again with the
 *                          next (default 60000, a minute, on a Durable Object tail: a held book costs by the clock, $0.0031 an hour at
 *                          Cloudflare's rates beyond the plan's allowances, and the book is ready again before the page asks, see
 *                          IDLE_RELEASE_MS; 0 turns it off; not for a process that has a standby, which would take the book)
 *   RASTRATA_BOOK_REVIEW_CHECK_MS   how often a book that is open is asked whether the verifier has stopped it (default 300000, a list of one
 *                          key in the bucket; 0 asks at every request and the request waits for the answer; otherwise the request that finds the
 *                          question due does not wait for it, and the next request finds the answer). A book that is not open is asked each time it is opened.
 *   RASTRATA_BOOK_CONTROL=1    the control surface for load and fault experiments (see hosted-control.ts)
 *   RASTRATA_BOOK_LEASE_MS     how long a lease lasts (default 5000): after a holder dies, the book waits this long, at most. A request for a book
 *                              that another process holds waits for it that long and a second and a half before it is refused (`book_busy`)
 *   RASTRATA_BOOK_STANDBY=1    follow the book without serving it, warm, and take it over by itself when its
 *                              lease is free (RASTRATA_BOOK_PROMOTE=manual: only when told to, by
 *                              POST /control/promote); RASTRATA_BOOK_FOLLOW_MS how often it looks (250)
 *
 * Credentials come from the environment, never from the URL (a URL ends up in a process listing), and
 * nothing here prints or logs one: a store is named by its kind (`s3`, `postgres`, `do`) and nothing more.
 * `memory` stores are for trials: they live as long as the process.
 *
 * Two ways to run it. The experiments start it from `main.ts` (RASTRATA_LOCAL_DEV=1): loopback only, no web
 * app, the control routes if asked. The product server starts it from `hosted-main.ts`, from the environment
 * alone: it listens where it is told (`bind`), answers only to the hosts it is given and to an Origin that is
 * its own behind a tunnel (hosted-serving.ts), serves the web app beside `/v1` and `/api`, lets the owner
 * sign in for a browser with a session cookie (hosted-session.ts), answers `/live` and `/ready` for its
 * orchestrator, and on SIGTERM says it is leaving (`/ready` answers 503), goes on answering for a moment so that the pod's Service has time to stop sending
 * it requests, then stops listening, finishes what it is doing, seals and gives the lease back (`announceStop` and `stop`; hosted-main.ts has the times).
 * The record is docs/reference/program/hosting/hostedprod.md. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentClaims,
  constantTimeEqual,
  isBookIdentifier,
  hasMemberHint,
  isServiceKey,
  SERVICE_CALL,
  parseAuthorization,
  sha256Hex,
} from "@rastrata/application/agent";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  PRINCIPAL_HEADER,
  agentReadsLogFirst,
  changesBook,
  createExportGate,
  openHostedService,
  type CarriedState,
  type HostedService,
  type HostedServiceOptions,
  LedgerReplayError,
  vouch,
} from "@rastrata/application/hosted";
import {
  type MemberTokenVerifier,
  looksLikeMemberToken,
  memberTokenVerifier,
} from "@rastrata/application/member-token";
import { MAX_UPLOAD_BYTES } from "@rastrata/application/http";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import {
  ActivationLimiter,
  BOOK_ID,
  BookClosedError,
  BookKeys,
  BookUnderReviewError,
  DURABLE_OBJECT_MAX_ENTRY_BYTES,
  DurableObjectLogTier,
  FileObjectStore,
  GuardedLogTier,
  HotBooks,
  HttpObjectStore,
  keepWarm,
  MeteredLogTier,
  MeteredObjectStore,
  ObjectStoreLogTier,
  PostgresLogTier,
  S3ObjectStore,
  steadyFetch,
  type SteadyFetch,
  assertNotUnderReview,
  hostedFailure,
  type GuardOptions,
  type HostedBook,
  type HostedApplication,
  type HostedBookOptions,
  type HostedFailure,
  LeaseHeldElsewhereError,
  type LogTier,
  type ObjectStore,
} from "@rastrata/booklog";
import { VERSION } from "./version.ts";
import { stopBook, WholeReads } from "./whole-read.ts";
import { MemoryLogTier, MemoryObjectStore } from "@rastrata/booklog/testing";
import { configureTelemetry, shutdownTelemetry, telemetryEnabled } from "@rastrata/telemetry";
import { controlRoutes, FaultSwitch, faultyStore, faultyTier } from "./hosted-control.ts";
import {
  activationBytesFor,
  BookRegistry,
  BooksRefused,
  type BooksSettings,
  defaultBooksSettings,
  type Lease,
} from "./hosted-books.ts";
import { Serving, type ServingOptions } from "./hosted-serving.ts";
import {
  advertisedAddress,
  FORWARDED_HEADER,
  PEER_PATH,
  PeerLost,
  Peers,
  peerKeyFrom,
} from "./hosted-peers.ts";
import { BookSlot, HeldByPeerError } from "./hosted-slot.ts";
import {
  clientAddress,
  ownerSessions,
  sameSecret,
  type CredentialSource,
  type OwnerSessions,
  type SessionOptions,
} from "./hosted-session.ts";
import { healthTelemetry, observeHttp } from "./telemetry.ts";
import { hardened, type WebApp } from "./web.ts";

export interface BookStoreConfig {
  readonly bookId: string;
  readonly bulk: string;
  readonly tail: string;
  readonly cache: string;
  /** Empty, or ending in a slash. */
  readonly prefix: string;
  /** A snapshot of the book is taken every this many entries; 0 for never. */
  readonly snapshotEvery: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The bulk store's own path after the bucket, as a key prefix (`s3://host/bucket/runs/x` is `runs/x/`). */
function prefixOfBulk(bulk: string): string {
  if (!/^s3s?:/.test(bulk)) return "";
  try {
    const path = new URL(bulk.replace(/^s3s?:/, "http:")).pathname.replace(/^\/+|\/+$/g, "");
    const [, ...rest] = path.split("/");
    return rest.length > 0 ? `${rest.join("/")}/` : "";
  } catch {
    return "";
  }
}

/** Read the configuration from `RASTRATA_BOOK_STORE` (and the variables beside it). Throws, saying
 * what is missing, and never repeats a value that may be a credential. */
export function parseBookStore(value: string, env: Environment = process.env): BookStoreConfig {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "RASTRATA_BOOK_STORE must be a URL of the form r2log://<book id>?bulk=...&tail=...",
    );
  }
  if (url.protocol !== "r2log:") throw new Error("RASTRATA_BOOK_STORE must start with r2log://");
  const bookId = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ""));
  if (!BOOK_ID.test(bookId))
    throw new Error("RASTRATA_BOOK_STORE names no book (r2log://<book id>)");
  const pick = (name: string, variable: string): string | undefined =>
    url.searchParams.get(name) || env[variable] || undefined;
  const bulk = pick("bulk", "RASTRATA_BOOK_BULK");
  const tail = pick("tail", "RASTRATA_BOOK_TAIL");
  if (!bulk) throw new Error("The bulk store is not named (bulk= or RASTRATA_BOOK_BULK)");
  if (!tail) throw new Error("The tail is not named (tail= or RASTRATA_BOOK_TAIL)");
  let prefix = pick("prefix", "RASTRATA_BOOK_PREFIX") ?? prefixOfBulk(bulk);
  if (prefix && !prefix.endsWith("/")) prefix = `${prefix}/`;
  try {
    // `.` and `..` are legal characters in a key and would be paths in a directory store.
    if (prefix.split("/").some((part) => part === "." || part === ".."))
      throw new RangeError("dots");
    new BookKeys(prefix, bookId);
  } catch {
    throw new Error("The key prefix must be empty or made of folders ending in a slash (a/b/)");
  }
  const every = Number(pick("snapshotEvery", "RASTRATA_BOOK_SNAPSHOT_EVERY") ?? "0");
  if (!Number.isInteger(every) || every < 0 || every > 1_000_000)
    throw new Error("snapshotEvery must be a whole number of entries, 0 for never");
  return {
    bookId,
    bulk,
    tail,
    cache: pick("cache", "RASTRATA_BOOK_CACHE") ?? join(tmpdir(), "rastrata-books"),
    prefix,
    snapshotEvery: every,
  };
}

/** What kind of store a configuration names, for /control/status and /health: never an address. */
export const kindOf = (where: string, role: "tail" | "bulk" = "tail"): string => {
  const kind = where.split(":")[0] ?? "";
  // A Durable Object tail (or the bulk gateway beside it) is named by its address, which is not for a status page.
  return kind === "https" || kind === "http" ? (role === "bulk" ? "gateway" : "do") : kind;
};

export function openBulkStore(
  config: BookStoreConfig,
  env: Environment = process.env,
  /** How a gateway somewhere else is called (packages/booklog/src/steady-fetch.ts); a store on this computer has no use for it. */
  steady?: SteadyFetch,
): ObjectStore {
  const where = config.bulk;
  if (where.startsWith("file:")) return new FileObjectStore(fileURLToPath(where));
  if (where === "memory" || where === "memory:") return new MemoryObjectStore();
  if (where.startsWith("s3:") || where.startsWith("s3s:")) {
    const url = new URL(where.replace(/^s3s:/, "https:").replace(/^s3:/, "http:"));
    const bucket = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (!bucket) throw new Error("The s3 store names no bucket (s3://host/bucket/prefix)");
    const keyId = env.RASTRATA_BOOK_S3_KEY_ID;
    const secret = env.RASTRATA_BOOK_S3_SECRET;
    if (!keyId || !secret)
      throw new Error(
        "RASTRATA_BOOK_S3_KEY_ID and RASTRATA_BOOK_S3_SECRET are needed for an s3 store",
      );
    return new S3ObjectStore({
      endpoint: `${url.protocol}//${url.host}`,
      bucket,
      accessKeyId: keyId,
      secretAccessKey: secret,
      region: env.RASTRATA_BOOK_S3_REGION ?? "auto",
    });
  }
  if (/^https?:\/\//.test(where)) {
    const baseUrl = webAddress(where, "The bulk store address", "a bulk store");
    const token = tailToken(env);
    if (!token)
      throw new Error(
        "A bulk store over https needs the tail's token: RASTRATA_BOOK_TAIL_TOKEN or RASTRATA_BOOK_TAIL_TOKEN_FILE",
      );
    return new HttpObjectStore({ baseUrl, token, ...(steady ? { steady } : {}) });
  }
  throw new Error(
    "The bulk store must be file:///dir, s3://host/bucket/prefix, s3s://host/bucket/prefix, https://host or memory",
  );
}

export interface OpenedTail {
  readonly tier: LogTier;
  /** Close connections the tail holds. */
  close(): Promise<void>;
  /** A service over the network, with limits and outages of its own (a Durable Object tail): the server
   * puts a circuit breaker in front of it, and gives a book's lease up when nobody is using it. */
  readonly remote: boolean;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
/** The bearer token of a Durable Object tail: `RASTRATA_BOOK_TAIL_TOKEN`, or the contents of the file
 * `RASTRATA_BOOK_TAIL_TOKEN_FILE` names (a Secret mounted in a pod ends with a newline, which is not
 * part of it). Says what is wrong with the setting, and never what the token is. */
export function tailToken(env: Environment): string | undefined {
  const direct = env.RASTRATA_BOOK_TAIL_TOKEN;
  const file = env.RASTRATA_BOOK_TAIL_TOKEN_FILE;
  if (direct && file)
    throw new Error("Set RASTRATA_BOOK_TAIL_TOKEN or RASTRATA_BOOK_TAIL_TOKEN_FILE, not both");
  let token = direct;
  if (file) {
    try {
      token = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error("RASTRATA_BOOK_TAIL_TOKEN_FILE cannot be read");
    }
    if (!token) throw new Error("RASTRATA_BOOK_TAIL_TOKEN_FILE is empty");
  }
  if (token && !/^[\x21-\x7e]+$/.test(token))
    throw new Error("The tail token must be made of printable characters, without spaces");
  return token || undefined;
}

/** A service's web address with nothing but its origin and path: `https://host`, or `http://` only on this
 * computer (the tests and `wrangler dev`), so that a token is never sent in the open. It carries no name or
 * password: the token is a setting of its own. `what` starts a message ("The tail address"), `kind` ends
 * one ("a tail"). */
function webAddress(text: string, what: string, kind: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.username || url.password)
    throw new Error(
      `${what} must not carry a name or a password: the token is a setting of its own`,
    );
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.includes(url.hostname))
    throw new Error(
      `${kind[0]?.toUpperCase()}${kind.slice(1)} over http must be on this computer; a service is reached over https`,
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The address of a Durable Object tail, or null when `where` names another kind of tail. `https://host`
 * is the Worker (`http://` only on this computer); `do:` before either is the older spelling and follows
 * the same rule. */
function durableObjectAddress(where: string): string | null {
  const legacy = where.startsWith("do:");
  const text = legacy ? where.slice(3) : where;
  if (!/^https?:\/\//.test(text)) {
    if (legacy) throw new Error("A durable object tail is do:http://host:port or do:https://host");
    return null;
  }
  return webAddress(text, "The tail address", "a tail");
}

export async function openTail(
  config: BookStoreConfig,
  bulk: ObjectStore,
  env: Environment = process.env,
  /** How a tail somewhere else is called (packages/booklog/src/steady-fetch.ts). */
  steady?: SteadyFetch,
): Promise<OpenedTail> {
  const where = config.tail;
  if (where === "memory" || where === "memory:")
    return { tier: new MemoryLogTier(), close: async () => {}, remote: false };
  if (where === "objects" || where === "objects:")
    return {
      tier: new ObjectStoreLogTier(bulk, { prefix: config.prefix }),
      close: async () => {},
      remote: false,
    };
  if (where.startsWith("postgres:") || where.startsWith("postgresql:")) {
    const postgres = await PostgresLogTier.connect(where, { max: 4, createSchema: true });
    return { tier: postgres, close: () => postgres.close(), remote: false };
  }
  const baseUrl = durableObjectAddress(where);
  if (baseUrl) {
    const token = tailToken(env);
    if (!token && baseUrl.startsWith("https:"))
      throw new Error(
        "A tail over https needs its token: RASTRATA_BOOK_TAIL_TOKEN or RASTRATA_BOOK_TAIL_TOKEN_FILE",
      );
    const timeout = env.RASTRATA_BOOK_TAIL_TIMEOUT_MS;
    const timeoutMs = timeout === undefined || timeout === "" ? 3000 : Number(timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
      throw new Error("RASTRATA_BOOK_TAIL_TIMEOUT_MS must be from 100 to 60000");
    return {
      tier: new DurableObjectLogTier({
        baseUrl,
        timeoutMs,
        ...(token ? { token } : {}),
        ...(steady ? { steady } : {}),
      }),
      close: async () => {},
      remote: true,
    };
  }
  throw new Error("The tail must be postgres://..., https://..., objects or memory");
}

/** The checks that have been said to have ended well, so that one carried from an application to the one that replaces it is said once. */
const reportedChecks = new WeakSet<Promise<void>>();

/** A book whose ledger does not replay is a book under review, as the verifier's own finding would make it: the application says `LedgerReplayError` (the check it makes behind its answers found an outcome that
 * does not execute to what the ledger stored), and here that becomes `BookUnderReviewError`, so that a write that waited for the check is refused with `423 book_under_review` and the book's slot (hosted-slot.ts)
 * stops the book. Anything else the check fails with is passed on as it is. */
function reviewedWhenUnsound(
  service: HostedService,
  bookId: string,
  log: (line: string) => void,
): HostedService {
  const asReview = (error: unknown): unknown =>
    error instanceof LedgerReplayError ? new BookUnderReviewError(bookId) : error;
  let seen: { readonly from: Promise<void>; readonly as: Promise<void> } | null = null;
  return {
    ...service,
    beforeWrite: () =>
      service.beforeWrite().catch((error: unknown) => {
        throw asReview(error);
      }),
    verification: () => {
      const check = service.verification();
      if (check === null) return null;
      // The same promise each time it is asked for the same check, so that it is watched once.
      if (seen?.from !== check) {
        seen = {
          from: check,
          as: check.catch((error: unknown) => {
            throw asReview(error);
          }),
        };
        if (!reportedChecks.has(check)) {
          reportedChecks.add(check);
          const began = performance.now();
          check.then(
            () =>
              log(
                `${bookId} was checked ${Math.round(performance.now() - began)} ms after its first answer: ${service.service.readStats.verified} outcomes executed again, none differs`,
              ),
            () => {},
          );
        }
      }
      return seen.as;
    },
  };
}

/** How long a pod holds a book's lease after its last request, on a Durable Object tail: a minute, which is what the production manifest names too. A hold costs by the clock and not by use: a renewal every 1.7 s
 * (2,160 an hour), each a Worker request, a Durable Object request and a row written, which at Cloudflare's rates beyond the plan's allowances is $0.0031 an hour, $2.25 a month for a book held around the clock, and
 * about two cents a month more for a person who visits once a day if the hold is fifteen minutes and not one. Fifteen minutes was asked for and withdrawn: the wait it would have saved a returning visitor (the first
 * read after a lapse, 61 to 397 ms in five visits timed on 2026-11-21) is gone without it, because the page asks for its token before its own code has arrived, which has the service open the book (control-worker: src/token.ts), and a
 * starting server opens the books in use before it is ready (`BookSlot.prewarm`). While one pod holds a book the other hands requests to it (`hosted-peers.ts`).
 * See "The lease and the hold" in docs/reference/program/performance.md. */
export const IDLE_RELEASE_MS = 60_000;

/** What a starting server does about the books in use (hot-books.ts, `BookSlot.prewarm`). */
export interface PrewarmOptions {
  /** The most books it opens before it says it is ready (default 12; 0 opens none and tells no one what it has open). */
  readonly books?: number;
  /** How long it waits for them, in milliseconds (default 15,000): what is not open by then goes on opening behind it, and the server is ready. */
  readonly budgetMs?: number;
  /** How often it looks at what it has open, to tell the servers after it, in milliseconds (default 30,000). */
  readonly checkMs?: number;
}

export interface HostedServerOptions {
  readonly config: BookStoreConfig;
  /** 0 asks for any free port. */
  readonly port: number;
  readonly ownerKey?: string;
  /** Whether an agent token is accepted as a bearer (default: yes). A token is checked against the book, and a request
   * that reaches the book takes its lease back from the tail and keeps it for the idle time before it can be refused, so
   * on a public address anyone who knows it could hold a book open with made-up credentials, at about 52,000 Worker
   * requests and Durable Object rows written a day, and spend the account's free allowance. With `false` the only
   * bearer the front door opens the book for is the owner key, compared here with no book, and anything else is refused
   * before the book is asked. A browser's session is the owner key's too. It has an effect only with an owner key. */
  readonly agentTokens?: boolean;
  /** Member tokens: a person of a workspace signs in at the control plane and sends the signed token it gives them for this book as a
   * bearer. The front door checks it (signature, issuer, audience, expiry, and that it is for this book) before the book is asked, so a
   * made-up or expired token costs the tail nothing, and the book then finds the person's role in its own member table. `origin` is the
   * app's own address, which names the issuer and where the public keys are; `verifier` is for tests. Off unless given, and only with
   * an owner key (an open service has no one to vouch for). */
  readonly memberTokens?:
    | { readonly origin: string; readonly verifier?: MemberTokenVerifier }
    | undefined;
  /** The SHA-256 digests (hex) of the keys the control plane may present as a bearer (`rsv_...`): the key of the one who changes who is in the
   * book. A key that is not here is refused before the book is asked. */
  readonly serviceKeys?: readonly string[] | undefined;
  /** Serve more than the one book: a member token for another book opens that book, and the control plane's key names the book it works on in the
   * header `x-rastrata-book`. Books are opened when their first request arrives, closed when nobody uses them, and held to the memory budget
   * and the per-book limits in `settings` (see hosted-books.ts). It needs the owner key, member tokens and no agent tokens (`agentTokens:
   * false`), and it is not for a standby or the experiment routes. The record is docs/reference/program/hosting/many-books.md. */
  readonly books?: { readonly settings?: Partial<BooksSettings> } | undefined;
  readonly env?: Environment;
  /** Open the book and read it once as soon as the server is listening, so that the first person to
   * ask does not wait for the cold start. */
  readonly warm?: boolean;
  /** Follow the book without serving it: read it, build the application on it and warm that, keep
   * all of it current with the log, and be ready to take the book over. Requests are refused with
   * `book_standby` until it has. */
  readonly standby?: boolean;
  /** A standby takes the book by itself as soon as its lease is free (the default), or only when
   * told to (`POST /control/promote`). */
  readonly promote?: "auto" | "manual";
  /** How often a standby looks at the log, in milliseconds (default 250). */
  readonly followMs?: number;
  /** How long a lease lasts, in milliseconds (default 5,000). */
  readonly leaseMs?: number;
  /** How long a request waits for a book that another process holds, in milliseconds, before it is refused with `book_busy` (default: the lease time and a second and a half, which is
   * long enough for the lease of a holder that was killed to lapse; 0 refuses at once). The new pod of an update is asked for books the old one still holds until the old one has stopped. */
  readonly leaseWaitMs?: number;
  /** `false`: a request for a book that another pod holds waits for the book, as it did before there could be two pods. By default, with an owner key to check the other pod by, the pod hands the request
   * to the pod that holds the book (hosted-peers.ts). For tests. */
  readonly peers?: false;
  /** What `POST /control/release {exit: true}` does once the book is given up: the process ends. */
  readonly exit?: () => void;
  /** Serve the control routes (see hosted-control.ts). */
  readonly control?: boolean;
  readonly telemetry?: false;
  /** Give the lease up after this long without a request, and take it again with the next (see
   * RASTRATA_BOOK_IDLE_RELEASE_MS in the header). Default: a minute (`IDLE_RELEASE_MS`) on a Durable Object
   * tail, off on any other and on a standby. */
  readonly idleReleaseMs?: number;
  /** How long a book that is open goes without being asked whether the verifier has stopped it, in milliseconds (default 300,000, which is
   * a list of one key in the bucket for each open book every five minutes; 0 asks at every request). A book that is not open is asked
   * each time it is opened. See RASTRATA_BOOK_REVIEW_CHECK_MS in the header. */
  readonly reviewCheckMs?: number;
  /** The books a starting server opens before it says it is ready, those the servers before it had open and were using (hot-books.ts); on by default for a server that serves many books, `false`
   * leaves it out. See RASTRATA_PREWARM_BOOKS and RASTRATA_PREWARM_MS in the header. */
  readonly prewarm?: PrewarmOptions | false;
  /** The circuit breaker in front of the tail: on by default for a Durable Object tail (the options
   * tune it), off for any other; `false` turns it off, an object turns it on. */
  readonly guard?: GuardOptions | false;
  /** For tests: replace the stores the configuration names. */
  readonly stores?: { readonly bulk?: ObjectStore; readonly tail?: LogTier };
  /** Where the server listens and who it answers to (see hosted-serving.ts). The default is this computer
   * only, answering to its loopback names. A server that listens beyond it needs `allowedHosts` and an
   * `ownerKey`: an open book is never offered to a network. */
  readonly serving?: ServingOptions;
  /** The built web app, served beside `/v1` and `/api` (see web.ts). */
  readonly web?: WebApp | null;
  /** The owner's sign-in for a browser: `POST /session/owner` and `DELETE /session` (hosted-session.ts).
   * On whenever there is an owner key; `false` leaves it out, and an object tunes it. */
  readonly sessions?: SessionOptions | false;
  /** How a read applies the book's outcomes: `full` (the default: every outcome is executed again, behind the first answer, and a write waits for that, see `HostedServiceOptions.verifyBehind`) or
   * `trusted` (the stored revisions applied and never executed again, which is only safe while a verifier re-executes the book). */
  readonly replay?: "full" | "trusted";
  /** Called with every application service this server makes, before it serves (`HostedServiceOptions.wire`): for a test that changes what a ledger answers. */
  readonly wire?: HostedServiceOptions["wire"];
  /** Told what happens in words, without a credential or an address of a store: a sign-in, a refusal. */
  readonly log?: (line: string) => void;
}

/** The answer for a `/v1/` request the book could not take, in the shape the application's own clients
 * read (they check that the answer is for the book and the operation they asked about, and show the
 * message): what they sent echoed, and the failure in the application's form. The browser's older
 * `/api/` routes get the plain one. */
function unavailableAnswer(
  failure: Pick<HostedFailure, "message" | "retryable" | "status" | "retryAfterSeconds"> & {
    readonly code: string;
  },
  context: { readonly request: Request; readonly body: Uint8Array | null },
): Response {
  if (!new URL(context.request.url).pathname.startsWith("/v1/"))
    return Response.json(
      {
        ok: false,
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      },
      {
        status: failure.status,
        headers: {
          "cache-control": "no-store",
          ...(failure.retryable ? { "retry-after": String(failure.retryAfterSeconds ?? 1) } : {}),
        },
      },
    );
  let bookId = "local-book";
  let operationId: string | undefined;
  try {
    const sent = JSON.parse(new TextDecoder().decode(context.body ?? new Uint8Array())) as {
      bookId?: unknown;
      operationId?: unknown;
    };
    if (typeof sent.bookId === "string") bookId = sent.bookId;
    if (typeof sent.operationId === "string") operationId = sent.operationId;
  } catch {
    // Not JSON: the application would have refused it too.
  }
  return Response.json(
    {
      version: APPLICATION_API_VERSION,
      bookId,
      ...(operationId ? { operationId } : {}),
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        details: [],
        retryable: failure.retryable,
      },
    },
    {
      status: failure.status,
      headers: {
        "cache-control": "no-store",
        ...(failure.retryable ? { "retry-after": String(failure.retryAfterSeconds ?? 1) } : {}),
      },
    },
  );
}

/** The largest body of a request to `/v1` or `/api`, as the application takes it (the statement upload
 * has its own limit). A body is read in full before the application sees the request, so the limit is
 * enforced here, ahead of it. */
const MAX_BODY_BYTES = 131072;
/** Where, inside the cache folder, the exports of each book are made and kept for a while (one folder a book). */
const EXPORTS_FOLDER = "exports";

/** The body of a request, or `"too large"` when it is longer than `limit`. Read as it arrives, so a
 * body that goes on and on is not held. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null | "too large"> {
  if (request.body === null || request.method === "GET" || request.method === "HEAD") return null;
  if (Number(request.headers.get("content-length") ?? "0") > limit) return "too large";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return "too large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Start the server. It listens on 127.0.0.1 unless `serving` says otherwise. The book is opened (its
 * lease taken, its cache made current) when the first request needs it, or at once with `warm`, and
 * again after an eviction. */
export async function startHostedApplicationServer(options: HostedServerOptions) {
  // What can be refused is refused before anything is opened or started.
  const serving = new Serving(options.serving);
  if (!serving.loopback && !options.ownerKey)
    throw new Error(
      "RASTRATA_OWNER_KEY is needed when the server listens beyond this computer: an unlocked book is not offered to a network",
    );
  if (options.books !== undefined) {
    if (options.ownerKey === undefined)
      throw new Error("Many books need the owner key: an unlocked service holds the one book");
    if (!options.memberTokens)
      throw new Error(
        "Many books need member tokens: they are what names a book besides the first",
      );
    if (options.agentTokens !== false)
      throw new Error(
        "Many books do not take agent tokens: a token is checked against its book, and a made-up one would open books for nobody",
      );
    if (options.standby || options.control)
      throw new Error("Many books are not for a standby or the experiment routes");
  }
  const log = options.log ?? (() => {});
  const sessions: OwnerSessions | null =
    options.ownerKey && options.sessions !== false
      ? ownerSessions(options.ownerKey, { ...(options.sessions ?? {}), log })
      : null;
  const credentials: CredentialSource | null = sessions;
  const env = options.env ?? process.env;
  const config = options.config;
  const ownsTelemetry =
    options.telemetry !== false &&
    !telemetryEnabled() &&
    (await configureTelemetry({ serviceName: "rastrata-api", env }));
  mkdirSync(config.cache, { recursive: true });
  const cachePath = join(config.cache, `${config.bookId}.sqlite`);
  // The exports a book made are kept in a folder of its own for an hour, to be downloaded; the ones a process that stopped left are not wanted by a process that has
  // nothing open, whatever their age.
  rmSync(join(config.cache, EXPORTS_FOLDER), { recursive: true, force: true });
  // A container that restarts keeps its folder, and the caches of the books the last process held would stay until the disk is full. Nothing
  // is open yet, so every cache but the first book's goes (a cache is made again from the log). Only files named as books are named are touched.
  if (options.books !== undefined) {
    let removed = 0;
    for (const file of readdirSync(config.cache)) {
      const name = /^(.+)\.sqlite(-wal|-shm)?$/.exec(file)?.[1];
      if (name === undefined || name === config.bookId || !isBookIdentifier(name)) continue;
      rmSync(join(config.cache, file), { force: true });
      removed += 1;
    }
    if (removed > 0) options.log?.(`removed ${removed} cache files left by an earlier process`);
  }
  const faults = { tail: new FaultSwitch(), bulk: new FaultSwitch() };
  // The faults sit inside the metering, so that a failed call is counted as the failure it stands for.
  // The stores of a service are called over HTTP, and a pod may ask them for nothing for hours: a call that does not answer at once is sent again on a new connection, the stores are asked a
  // question that costs nothing a few times a minute, and a call that was slow is written down (packages/booklog/src/steady-fetch.ts).
  const steady = steadyFetch({ log: (line) => options.log?.(line) });
  const bulk = new MeteredObjectStore(
    faultyStore(options.stores?.bulk ?? openBulkStore(config, env, steady), faults.bulk),
    { keepSamples: false },
  );
  const opened: OpenedTail = options.stores?.tail
    ? { tier: options.stores.tail, close: async () => {}, remote: false }
    : await openTail(config, bulk, env, steady);
  const stopWarm = keepWarm({
    steady,
    urls: [
      ...(options.stores?.tail ? [] : [config.tail.replace(/^do:/, "")]),
      ...(options.stores?.bulk ? [] : [config.bulk]),
    ]
      .filter((where) => /^https?:\/\//.test(where))
      .map((where) => `${new URL(where).origin}/health`),
  });
  // The faults sit inside the metering and the breaker outside it: the metering counts the calls that
  // were made, and the breaker is what stands between a failing tail and everything that would call it.
  const metered = new MeteredLogTier(faultyTier(opened.tier, faults.tail));
  const guardOptions = options.guard === undefined ? (opened.remote ? {} : false) : options.guard;
  const guard = guardOptions === false ? null : new GuardedLogTier(metered, guardOptions);
  const tail: LogTier = guard ?? metered;
  const idleReleaseMs =
    options.idleReleaseMs ?? (opened.remote && !options.standby ? IDLE_RELEASE_MS : 0);
  if (!Number.isInteger(idleReleaseMs) || idleReleaseMs < 0)
    throw new Error("RASTRATA_BOOK_IDLE_RELEASE_MS must be a number of milliseconds, 0 for never");
  // A pod that starts beside the one it replaces, or after one that was killed, is asked for books that are still held. It waits for them as long as a lease lasts, and a little more.
  const leaseWaitMs = options.leaseWaitMs ?? (options.leaseMs ?? 5000) + 1500;
  if (!Number.isInteger(leaseWaitMs) || leaseWaitMs < 0)
    throw new Error("leaseWaitMs must be a number of milliseconds, 0 for none");
  // A process incarnation is a lease holder: a restarted pod must not look like the one before it, and two servers
  // must never look like each other. The host, the process and the moment do not say that by themselves: two
  // servers one process makes in the same millisecond had one name, and the second then took the first's lease
  // for its own and handed it nothing. The random part is what makes the name this server's alone.
  const holder = `${hostname()}#${process.pid}#${Date.now().toString(36)}#${randomBytes(6).toString("hex")}`;
  let incarnation = 0;
  let stopping = false;
  /** The other pods of the service, when there can be any: the owner key is what a pod proves to another that it is a pod of the service by. */
  const peers =
    options.ownerKey !== undefined && options.peers !== false
      ? new Peers({ key: peerKeyFrom(options.ownerKey), holder })
      : null;
  /** The end of the name of a lease holder: `@address:port`, once the server is listening, so that the lease says where the book is served. */
  let advertised = "";
  /** The server has said it is about to stop (`announceStop`): it is not ready, and asks for connections to be closed, but it goes on serving. */
  let leaving = false;

  /** What a first screen asks of the application, so that it has built what it keeps in memory. A
   * standby does this on a followed cache, so that taking the book over finds it ready. */
  const warmRequest = (url: string): Request =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.ownerKey ? { authorization: `Bearer ${options.ownerKey}` } : {}),
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input: { page: 1, status: "Posted" },
      }),
    });
  const warmApplication = async (application: HostedApplication): Promise<void> => {
    try {
      const response = await application.fetch(warmRequest("http://127.0.0.1/v1/journal.list"));
      await response.arrayBuffer();
    } catch {
      // Best effort: a book that is not set up yet has nothing to warm.
    }
  };

  /** This process's secret for telling the application who it has vouched for: made at start, held by no caller. */
  const principalSecret = randomBytes(32).toString("base64url");
  const booksSettings = options.books
    ? defaultBooksSettings(undefined, options.books.settings ?? {})
    : null;
  /** Making an export reads a whole book and writes it out: the books of a pod take turns at it, one at a time. */
  const exportGate = createExportGate(1);
  /** The cold loads of every book go through one gate, so that a pod that is asked for many books at once opens a few at a time. */
  const limiter = booksSettings
    ? new ActivationLimiter({
        maxConcurrent: booksSettings.loads,
        memoryBudgetBytes: booksSettings.loadBytes,
      })
    : null;
  const bookOptions = (
    bookId: string,
    bookCache: string,
    loadBytes?: number,
  ): HostedBookOptions => {
    incarnation += 1;
    return {
      tier: tail,
      bulk,
      bookId,
      ...(config.prefix ? { prefix: config.prefix } : {}),
      holder: `${holder}.${incarnation}${advertised}`,
      path: bookCache,
      schema: APPLICATION_SCHEMA,
      exclude: APPLICATION_DERIVED,
      sealing: { delayMs: 2000 },
      ...(options.leaseMs ? { lease: { ttlMs: options.leaseMs } } : {}),
      ...(idleReleaseMs > 0 ? { idleReleaseMs } : {}),
      // An entry is one row of the Durable Object's database: a request that would pass its limit is
      // refused with a clear error, before anything is sent.
      ...(opened.remote ? { commit: { maxStoredEntryBytes: DURABLE_OBJECT_MAX_ENTRY_BYTES } } : {}),
      ...(limiter ? { limiter } : {}),
      ...(limiter && loadBytes !== undefined ? { limiterBytes: loadBytes } : {}),
      unavailable: unavailableAnswer,
      // A book that finds another pod holds it by the time a request comes is not a case for a page that says it is busy: the request is handed to that pod, or the book is waited for (`serve`).
      heldElsewhere: "throw" as const,
      ...(config.snapshotEvery > 0 ? { snapshots: { everyEntries: config.snapshotEvery } } : {}),
      readEffects: { mode: "defer", deferMs: 2000 },
      effects: agentReadsLogFirst,
      open: async (db, _reason, carried) =>
        reviewedWhenUnsound(
          await openHostedService(db, bookCache, {
            ...(carried ? { carry: carried as CarriedState } : {}),
            // A pod set to `full` re-executes every outcome of a book at every cold open: now behind the first answer, with a write waiting for it, and not in front of it.
            ...(options.replay !== "trusted" ? { verifyBehind: true } : {}),
            ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}),
            ...(options.wire ? { wire: options.wire } : {}),
            principalSecret,
            // A pod with many books has no credential that is one tenant's alone: the Stripe key and the bank connection come from the process or from the
            // folder every book is in, so they are off (see `credentials` in local/open.ts).
            local: {
              ...(options.replay === "trusted" ? { replay: "trusted" as const } : {}),
              ...(options.books !== undefined ? { credentials: "none" as const } : {}),
              // The pod keeps the backups of a book (the log is the backup), so it makes none; it makes the open export, for a person to take their books away.
              exports: {
                directory: join(config.cache, EXPORTS_FOLDER, basename(bookCache, ".sqlite")),
                gate: exportGate,
              },
            },
          }),
          bookId,
          log,
        ),
      changesBook,
      warm: warmApplication,
    };
  };
  /** Which books this process has read whole, from their first entry, in the background after the first open (whole-read.ts). */
  const wholeReads = new WholeReads({
    tier: tail,
    schema: APPLICATION_SCHEMA,
    stopping: () => stopping,
    bulk,
    keys: (id) => new BookKeys(config.prefix ?? "", id),
    build: `pod ${VERSION}`,
    log,
  });
  const wholeReadOf = (id: string) => ({
    wholeRead: {
      first: () => wholeReads.first(id),
      opened: () => wholeReads.opened(id),
      failed: (error: unknown) => wholeReads.failed(id, error),
    },
  });
  /** What a slot does when the check made behind a book's answers finds that its ledger does not replay: the stop is written as the verifier writes one, and from then on no pod serves the book (423) until a person has
   * cleared it. */
  const unsoundOf = (id: string) => ({
    unsound: async () => {
      const stopped = await stopBook(
        { bulk, keys: new BookKeys(config.prefix ?? "", id), build: `pod ${VERSION}` },
        { kind: "replay_failed", seq: 0, check: "ledger_replay" },
      );
      log(
        stopped
          ? `${id} is stopped: its ledger does not replay (found by the check behind its first answer); it is not served until a person has cleared it`
          : `${id} does not replay (found by the check behind its first answer) and the stop could not be written`,
      );
    },
  });
  /** The book this server is named for: the owner's, and the one a standby, a hand-over and the control routes are about. */
  const home = new BookSlot({
    id: config.bookId,
    cachePath,
    ...(options.standby ? { standby: true } : {}),
    ...(options.promote ? { promote: options.promote } : {}),
    ...(options.followMs !== undefined ? { followMs: options.followMs } : {}),
    bookOptions: () => bookOptions(config.bookId, cachePath),
    stopping: () => stopping,
    leaseWaitMs,
    ...(peers
      ? { peerHolds: async (heldBy: string) => (await peers.resolve(heldBy)) !== null }
      : {}),
    // A book the verifier has stopped is not opened, and one that is open is closed within `reviewCheckMs` (see packages/booklog/src/review.ts).
    beforeOpen: () => assertNotUnderReview(bulk, new BookKeys(config.prefix ?? "", config.bookId)),
    recheckMs: options.reviewCheckMs ?? 300_000,
    ...wholeReadOf(config.bookId),
    ...unsoundOf(config.bookId),
  });
  /** The other books, when the server is asked to serve more than one. */
  const registry =
    booksSettings && limiter
      ? new BookRegistry<BookSlot>({
          settings: booksSettings,
          queued: () => limiter.stats.queued,
          make: (id, sizeHint) => {
            // The name becomes a file name here and a key in the object store: held to the control plane's shape, which has no dot and no slash.
            if (!isBookIdentifier(id)) throw new RangeError("Bad book identifier");
            const bookCache = join(config.cache, `${id}.sqlite`);
            return new BookSlot({
              id,
              cachePath: bookCache,
              bookOptions: () => {
                // A book held before is gated for what it took then, not for what the length of its log suggests.
                const known = sizeHint();
                return bookOptions(
                  id,
                  bookCache,
                  known === undefined ? undefined : activationBytesFor(known),
                );
              },
              stopping: () => stopping,
              leaseWaitMs,
              ...(peers
                ? { peerHolds: async (heldBy: string) => (await peers.resolve(heldBy)) !== null }
                : {}),
              beforeOpen: () => assertNotUnderReview(bulk, new BookKeys(config.prefix ?? "", id)),
              recheckMs: options.reviewCheckMs ?? 300_000,
              ...wholeReadOf(id),
              ...unsoundOf(id),
            });
          },
        })
      : null;

  // ---- the books in use are open before the server says it is ready, and the servers that start after it are told which they are (hot-books.ts) --------------------------------
  const prewarmOptions = options.prewarm === false ? null : (options.prewarm ?? {});
  // As many as a setting may ask for: a book that is on the list was used in the last thirty days, and the ones that are not open when the time is up go on opening behind the server.
  const prewarmBooks = Math.max(0, Math.floor(prewarmOptions?.books ?? 64));
  const prewarmBudgetMs = Math.max(0, Math.floor(prewarmOptions?.budgetMs ?? 15_000));
  const hot =
    registry && prewarmOptions && prewarmBooks > 0
      ? new HotBooks({ bulk, prefix: config.prefix ?? "", holder, log })
      : null;
  /** Open the books the servers before this one had open and were using, newest use first, without taking them (`BookSlot.prewarm`): the first request takes the lease and reads what the log has gained
   * since, which is a round trip and not a cold open. Through the registry, so that the memory budget and the cold loads' gate hold as they do for a request; a server that is full stops. Never throws. */
  const prewarmHot = async (): Promise<void> => {
    if (!hot || !registry || !booksSettings) return;
    const began = performance.now();
    const wanted = (await hot.recent())
      .filter((book) => book.id !== config.bookId)
      .slice(0, prewarmBooks);
    if (wanted.length === 0) return;
    let next = 0;
    let opened = 0;
    let full = false;
    const warmed: BookSlot[] = [];
    const work = async (): Promise<void> => {
      for (;;) {
        const book = wanted[next++];
        if (book === undefined || full || stopping) return;
        try {
          const lease = await registry.acquire(book.id, "service", { evict: false });
          try {
            if (await lease.slot.prewarm()) {
              opened += 1;
              warmed.push(lease.slot);
            }
          } finally {
            lease.release();
          }
          // Opening a book is not using it: it was last used when the list says, and is closed for being idle, and left off the next list, as if it had been open since.
          registry.markUsed(book.id, book.at);
        } catch (error) {
          if (error instanceof BooksRefused && error.failure.code === "server_busy") full = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, booksSettings.loads) }, work));
    const openedIn = Math.round(performance.now() - began);
    // The checks that go on behind a book's first answer (every outcome of its ledger executed again, and its log read from the first entry) are waited for too, within the same time: they are over before the
    // first person asks, and do not take the processor from the page that is being drawn.
    await Promise.allSettled([
      ...warmed.map((slot) => slot.checking() ?? Promise.resolve()),
      wholeReads.settled(),
    ]);
    log(
      `prewarm: ${opened} of ${wanted.length} books in use are open, in ${openedIn} ms, and checked behind in ${Math.round(performance.now() - began)} ms`,
    );
  };
  /** Tell the servers that start after this one which books it has open: when the set has changed, and at least every thirty minutes, so that a list in the last ninety is always there for a server
   * that is running. Never throws. */
  const HOT_HEARTBEAT_MS = 30 * 60_000;
  let hotSaid = "";
  let hotSaidAt = 0;
  let telling: Promise<void> | null = null;
  const tellHot = async (force = false): Promise<void> => {
    if (!hot || !registry) return;
    // The last word of a server that stops is its own: it does not ride on a look that began before it and was not asked to write. (It did, when the two met: the runners, at a load of
    // 4, saw a server stop in the moment its timer was looking, and leave no last list.)
    if (force && telling) await telling;
    telling ??= (async () => {
      const books = registry.hot();
      const names = books
        .map((book) => book.id)
        .sort()
        .join(",");
      const now = Date.now();
      // A server that has never had a book open has nothing to say; one that had and has none says so.
      if (names === "" && hotSaid === "") return;
      if (!force && names === hotSaid && now - hotSaidAt < HOT_HEARTBEAT_MS) return;
      if (await hot.publish(books)) {
        hotSaid = names;
        hotSaidAt = now;
      }
    })()
      .catch(() => {})
      .finally(() => {
        telling = null;
      });
    return telling;
  };
  const hotTimer = hot
    ? setInterval(() => void tellHot(), Math.max(1000, prewarmOptions?.checkMs ?? 30_000))
    : null;
  (hotTimer as unknown as { unref?: () => void } | null)?.unref?.();

  const kind = { bulk: kindOf(config.bulk, "bulk"), tail: kindOf(config.tail) };
  const control = options.control
    ? controlRoutes({
        bookId: config.bookId,
        faults,
        evict: () => home.evict(),
        kind,
        tailStatus: () => (home.book ? home.book.runtime.tailStatus() : null),
        stats: () => (home.book ? home.book.runtime.stats : null),
        role: () => home.role,
        drain: () => home.drain(),
        release: () => home.handOver(),
        promote: () => home.takeOver(),
        exit: () => options.exit?.(),
        extra: () => ({
          tail_calls: metered.counts,
          // The calls to the stores over HTTP: how many were sent a second time, and the slowest.
          store_calls: steady.stats(),
          breaker: guard ? guard.status() : null,
          idle_release_ms: idleReleaseMs,
          lease: home.book
            ? { fence: home.book.runtime.lease.fence, valid: home.book.runtime.lease.valid() }
            : null,
          following: home.following
            ? { seq: home.following.runtime.head.seq, warmed: home.following.warmed }
            : null,
        }),
        ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}),
      })
    : null;

  /** One line for something that should be rare and that a person may have felt (a request turned away, a book opened while someone waited): twenty a minute at most, so that a bad minute is said
   * and does not fill the log. Before 2026-11-22 none of it was written down, and a visit that took ten seconds left two lines that said nothing was wrong. */
  const rare = { minute: 0, lines: 0 };
  const sayRare = (line: string): void => {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== rare.minute) {
      rare.minute = minute;
      rare.lines = 0;
    }
    rare.lines += 1;
    if (rare.lines <= 20) log(line);
  };
  /** What was asked, for such a line: the operation's path and nothing a caller chose beyond it. */
  const asked = (request: Request): string => {
    try {
      return new URL(request.url).pathname.replace(/[^A-Za-z0-9/._-]/g, "_").slice(0, 60);
    } catch {
      return "?";
    }
  };
  /** The answer for a request when the book could not be opened. */
  const notOpened = (
    error: unknown,
    context: { readonly request: Request; readonly body: Uint8Array | null },
  ): Response => {
    const failure = hostedFailure(error) ?? {
      code: "book_unavailable",
      message: "The book could not be opened; try again shortly.",
      retryable: true,
      status: 503,
    };
    sayRare(`refused: ${failure.code} ${asked(context.request)}`);
    return unavailableAnswer(failure, context);
  };
  /** What came of handing a request to the pod that holds its book: its answer; that it could not be done, so that the book is to be waited for; that the pod went away before it answered (the
   * person is told to send it again, and the request is not done a second time here); or that it was not a case for handing on. */
  type HandedOn =
    | { readonly kind: "answered"; readonly response: Response }
    | { readonly kind: "retry" }
    | { readonly kind: "lost" }
    | { readonly kind: "none" };
  const handOn = async (
    error: LeaseHeldElsewhereError,
    original: Request | undefined,
    bytes: Uint8Array | null,
    book: string,
    /** Called when it is known where the book is, or that it cannot be known: before the other pod has answered. */
    learned?: () => void,
  ): Promise<HandedOn> => {
    if (!peers || !original || original.headers.has(FORWARDED_HEADER)) return { kind: "none" };
    let target: Awaited<ReturnType<Peers["resolve"]>>;
    try {
      target = await peers.resolve(error.heldBy);
      if (target !== null) peers.remember(book, target);
    } finally {
      learned?.();
    }
    if (target === null) return { kind: "retry" };
    try {
      const response = await peers.forward(original, bytes, target);
      return response === null ? { kind: "retry" } : { kind: "answered", response };
    } catch (failure) {
      if (failure instanceof PeerLost) return { kind: "lost" };
      throw failure;
    }
  };
  /** The books that a request is opening, so that the one line about it is written once. */
  const opening = new Set<string>();
  /** For a book that is open here without its lease: the request that is asking the tail who holds it, which the others wait for. */
  const finding = new Map<string, Promise<void>>();
  /** The books being opened behind a request that was handed to another pod. */
  const behind = new Set<string>();
  /** A book this pod was asked for and handed to the pod that holds it is opened here too, without being taken (`BookSlot.prewarm`): the lease is let go after a quiet minute, and the next request
   * may reach this pod, which then takes the book with a round trip. Before, it read the book from its snapshot and its log while the person waited, with the book open in the memory of the pod
   * beside it (the second pod, ten minutes after the founder's visit of 2026-11-22). Through the registry, so that the memory budget holds, and never by closing another book for the room. */
  const openBehind = (slot: BookSlot): void => {
    if (!registry || slot === home || slot.open || stopping || behind.has(slot.id)) return;
    behind.add(slot.id);
    void (async () => {
      try {
        const lease = await registry.acquire(slot.id, "service", { evict: false });
        try {
          await lease.slot.prewarm();
        } finally {
          lease.release();
        }
      } catch {
        // Not now (the pod is full, or busy): the book is opened by the request that needs it.
      } finally {
        behind.delete(slot.id);
      }
    })();
  };
  /** Serve one request on the book, opening it if need be. `bytes` is its body, read already. A request
   * that reaches a book in the moment it is being stopped (an eviction) was not started, so it goes once
   * to the book that replaces it. When another pod of the service holds the book, `original` (the request
   * as the caller sent it, which that pod checks for itself) is handed to it; when the holder cannot be
   * handed a request, the book is waited for, as long as `leaseWaitMs` allows. The refusal comes in two
   * places: when the book is opened, and when a book that is open here, and let its lease go while it was
   * quiet, finds that another pod has taken it. */
  const serve = async (
    slot: BookSlot,
    incoming: Request,
    bytes: Uint8Array | null,
    original?: Request,
  ): Promise<Response> => {
    const copy = () =>
      new Request(incoming.url, {
        method: incoming.method,
        headers: new Headers(incoming.headers),
        ...(bytes ? { body: bytes as BodyInit } : {}),
        signal: incoming.signal,
      });
    const handsOn =
      peers !== null && original !== undefined && !original.headers.has(FORWARDED_HEADER);
    /** The request, answered by the pod that was found to hold the book a moment ago, without asking the tail who holds it again; null when no pod is known to, or it could not be given the request. */
    const viaHolder = async (): Promise<Response | null> => {
      if (!peers || !original || !handsOn) return null;
      const holder = peers.holderOf(slot.id);
      if (holder === null) return null;
      try {
        const response = await peers.forward(original, bytes, holder);
        if (response !== null) openBehind(slot);
        return response;
      } catch (failure) {
        if (failure instanceof PeerLost)
          return notOpened(new LeaseHeldElsewhereError(holder.key, 0), {
            request: incoming,
            body: bytes,
          });
        throw failure;
      }
    };
    // A book that another pod was found to hold a moment ago, and that this pod does not hold, is asked of that pod.
    if (!slot.book?.runtime.lease.valid()) {
      const answered = await viaHolder();
      if (answered !== null) return answered;
    }
    const waitUntil = Date.now() + leaseWaitMs;
    let closedOnce = false;
    for (;;) {
      let served: HostedBook;
      // A book that is opened while a request waits for it is written down, once, with how long it took.
      const cold = !slot.open && !opening.has(slot.id);
      const began = performance.now();
      if (cold) opening.add(slot.id);
      try {
        served = await slot.current();
        if (cold)
          sayRare(
            `opened: ${slot.id} for a request, in ${Math.round(performance.now() - began)} ms`,
          );
      } catch (error) {
        // Another pod of the service holds the book: the request goes to that pod. If that pod cannot be reached the book is waited for, as with one pod.
        const handed =
          error instanceof HeldByPeerError
            ? await handOn(error, original, bytes, slot.id)
            : ({ kind: "none" } as const);
        if (handed.kind === "answered") {
          openBehind(slot);
          return handed.response;
        }
        if (handed.kind !== "retry") return notOpened(error, { request: incoming, body: bytes });
        try {
          served = await slot.current();
        } catch (again) {
          return notOpened(again, { request: incoming, body: bytes });
        }
      } finally {
        if (cold) opening.delete(slot.id);
      }
      // The book is open here and its lease is not held (it was let go while the book was quiet): the tail is asked who holds it now. The page asks for some twenty things at once, and each of
      // them used to ask the tail, one after another (a dozen questions in the half second of one page, seen live on 2026-11-22). One asks, the rest wait for what it learns, and when that is
      // "another pod" they go to that pod, all at once.
      let learned: (() => void) | null = null;
      if (handsOn && !served.runtime.lease.valid()) {
        const first = finding.get(slot.id);
        if (first) {
          await first;
          const answered = await viaHolder();
          if (answered !== null) return answered;
        } else {
          finding.set(
            slot.id,
            new Promise<void>((done) => {
              learned = () => {
                finding.delete(slot.id);
                done();
              };
            }),
          );
        }
      }
      const known = (): void => {
        const tell = learned as (() => void) | null;
        learned = null;
        tell?.();
      };
      try {
        const response = await served.fetch(copy());
        peers?.forget(slot.id);
        return response;
      } catch (error) {
        if (error instanceof BookClosedError && !closedOnce) {
          closedOnce = true;
          continue;
        }
        if (!(error instanceof LeaseHeldElsewhereError)) throw error;
        // The book is open here, its lease was given up while it was quiet, and another process has it now.
        const handed = await handOn(error, original, bytes, slot.id, known);
        if (handed.kind === "answered") return handed.response;
        if (
          handed.kind === "lost" ||
          stopping ||
          original?.headers.has(FORWARDED_HEADER) ||
          Date.now() >= waitUntil
        )
          return notOpened(error, { request: incoming, body: bytes });
        await Bun.sleep(Math.min(250, Math.max(0, waitUntil - Date.now())));
      } finally {
        known();
      }
    }
  };

  /** Paths that belong to a service and are never the web app's: a deep link is answered with the app, and
   * these must not be (`/auth/` is the control Worker's, which the edge sends elsewhere). */
  const RESERVED = ["/auth", "/session", "/control", "/health", "/live", "/ready", PEER_PATH];
  const reserved = (path: string): boolean =>
    RESERVED.some((name) => path === name || path.startsWith(`${name}/`));
  /** A read of the application's page, or of a file it is made of. It is the same public code for everyone, and the
   * data is behind the API, which asks for a credential on every request, so what a browser says about where such a
   * request came from cannot make the answer more or less private. That is also not a thing a browser keeps steady:
   * a script or a stylesheet is fetched with the page's own `Origin`, a page opened from another site or by another
   * kind of browser is asked for with none, or with `null`. So the page is answered whatever the `Origin` says, and
   * the front door of the product is never a line of JSON. Everything that reads or changes a book, the sign-in
   * and every request that is not a read keep the check. */
  const readsPage = (request: Request, path: string): boolean =>
    !!options.web &&
    (request.method === "GET" || request.method === "HEAD") &&
    !path.startsWith("/v1/") &&
    !path.startsWith("/api/") &&
    !reserved(path);
  /** What a refusal of an `Origin` tells the log: where in the service it was asked, how the browser said it came, and
   * the `Origin` it named (bounded). Never an address, a query, an identifier from a path or anything of a body. At most
   * one line a minute for the same asking, so that a flood is one line and not a flood. */
  const refusedOrigins = new Map<string, number>();
  const logOriginRefusal = (request: Request, path: string, origin: string): void => {
    const area =
      ["/v1", "/api", "/session", "/control", "/auth", "/health", "/live", "/ready"].find(
        (name) => path === name || path.startsWith(`${name}/`),
      ) ?? "page";
    const site = request.headers.get("sec-fetch-site") ?? "-";
    const named = origin.replace(/[^\x21-\x7e]/g, "?").slice(0, 80);
    const key = `${request.method} ${area} ${site} ${named}`;
    const now = Date.now();
    if (now - (refusedOrigins.get(key) ?? 0) < 60_000) return;
    if (refusedOrigins.size >= 200) refusedOrigins.clear();
    refusedOrigins.set(key, now);
    log(`refused: origin_denied ${request.method} ${area} site=${site} origin=${named}`);
  };
  const refusedWith = (
    failure: Parameters<typeof unavailableAnswer>[0],
    request: Request,
    body: Uint8Array | null,
  ) => unavailableAnswer(failure, { request, body });
  /** An answer to a request whose body was not read to its end. The connection is closed after it:
   * a body left unread keeps its connection busy as far as the server is concerned, and a stop that
   * waits for the requests in flight would wait for it. */
  const unread = (response: Response): Response => {
    response.headers.set("connection", "close");
    return response;
  };
  /** What the application would say to a request with no credentials, said before its body is read. */
  const SIGN_IN_REQUIRED = {
    code: "authentication_required",
    message: "Sign in to use this service.",
    retryable: false,
    status: 401,
  } as const;
  /** What it would say to a bearer that is not the owner key, in its own words, and the same said of an agent
   * token on a server that takes none. */
  const NOT_ACCEPTED = {
    code: "token_invalid",
    message: "The credentials were not accepted",
    retryable: false,
    status: 401,
  } as const;
  /** The control plane's key names the book it works on in this header; nothing else reads it, and it is removed from every request. */
  const BOOK_HEADER = SERVICE_CALL.bookHeader;
  const BOOK_REQUIRED = {
    code: "book_required",
    message: "Name the book in the x-rastrata-book header",
    retryable: false,
    status: 400,
  } as const;
  const BOOK_INVALID = {
    code: "book_invalid",
    message: "The x-rastrata-book header is not the name of a book",
    retryable: false,
    status: 400,
  } as const;
  /** The control plane's key named a book this server does not serve (it serves one). */
  const NOT_SERVED = {
    code: "book_scope_mismatch",
    message: "This server does not serve that book",
    retryable: false,
    status: 403,
  } as const;
  /** A signed token that is good but is for another book: not this pod's to open. */
  const WRONG_BOOK = {
    code: "book_scope_mismatch",
    message: "This token is for another book",
    retryable: false,
    status: 403,
  } as const;
  /** The control plane's keys could not be read, so nothing is known of the token: not its fault, and worth another try. */
  const KEYS_UNAVAILABLE = {
    code: "sign_in_unavailable",
    message: "Sign-in could not be checked just now. Try again in a moment",
    retryable: true,
    status: 503,
  } as const;
  const TOKENS_NOT_ACCEPTED = {
    ...NOT_ACCEPTED,
    message:
      "The credentials were not accepted: this server takes the owner key, not an agent token",
  } as const;
  /** What the front door made of a bearer. `owner`: it goes on to the book, which decides as it always has (every bearer does while agent
   * tokens are accepted or nothing is locked). `member` and `service`: the process checked the credential itself and vouches for who it is
   * (a signed token, which names its book; the control plane's key, which names it in a header). `token` and `refused` (an agent token on a
   * server that takes none; anything that is not the owner key) and `other_book` (a good token for a book this server does not serve) are
   * refused here with no book asked: see `agentTokens`. */
  type Door =
    | { readonly kind: "owner" | "token" | "refused" | "other_book" | "unavailable" }
    | {
        readonly kind: "member";
        readonly userId: string;
        readonly bookId: string;
        /** The token was made for an agent key of this person: the key and what it may do. */
        readonly agent?: AgentClaims;
      }
    | { readonly kind: "service" };
  const verifier =
    options.ownerKey !== undefined && options.memberTokens
      ? (options.memberTokens.verifier ??
        memberTokenVerifier({ origin: options.memberTokens.origin }))
      : null;
  const serviceKeyDigests = options.ownerKey !== undefined ? [...(options.serviceKeys ?? [])] : [];
  const bearerAtTheDoor = async (header: string | null): Promise<Door> => {
    const ownerKey = options.ownerKey;
    if (ownerKey === undefined) return { kind: "owner" };
    const presented = /^Bearer +(\S+)$/i.exec(header ?? "")?.[1];
    if (presented !== undefined) {
      if (verifier && looksLikeMemberToken(presented)) {
        const verdict = await verifier.verify(presented);
        if (verdict.kind === "unavailable") return { kind: "unavailable" };
        if (verdict.kind === "refused") return { kind: "refused" };
        return verdict.claims.bid === config.bookId || registry
          ? {
              kind: "member",
              userId: verdict.claims.sub,
              bookId: verdict.claims.bid,
              ...(verdict.claims.agent ? { agent: verdict.claims.agent } : {}),
            }
          : { kind: "other_book" };
      }
      if (serviceKeyDigests.length > 0 && isServiceKey(presented)) {
        const digest = await sha256Hex(presented);
        // Every digest is compared, whichever matches, so the time does not say which.
        let matched = false;
        for (const known of serviceKeyDigests) if (constantTimeEqual(digest, known)) matched = true;
        return matched ? { kind: "service" } : { kind: "refused" };
      }
    }
    if (options.agentTokens !== false) return { kind: "owner" };
    const credential = parseAuthorization(header);
    if (credential.kind === "ownerKey" && constantTimeEqual(credential.key, ownerKey))
      return { kind: "owner" };
    return credential.kind === "token" ? { kind: "token" } : { kind: "refused" };
  };

  /** Which book a request is for. The credential decides, and nothing a caller sends can move it: the owner (the key or the session) has the home book;
   * a member has the book the signed token names; the control plane's key names its book in a header, which no other credential's request is
   * read for. A book other than the home book comes from the registry, which may refuse the request. */
  type Choice =
    | { readonly kind: "home" }
    | { readonly kind: "registry"; readonly bookId: string; readonly caller: "member" | "service" }
    | { readonly kind: "refuse"; readonly failure: Parameters<typeof unavailableAnswer>[0] };
  const chooseBook = (door: Door, named: string | null, known: boolean): Choice => {
    if (!known) return { kind: "home" };
    if (door.kind === "member")
      return door.bookId === config.bookId
        ? { kind: "home" }
        : { kind: "registry", bookId: door.bookId, caller: "member" };
    if (door.kind === "service") {
      const header = named?.trim() ?? "";
      if (header === "")
        return registry ? { kind: "refuse", failure: BOOK_REQUIRED } : { kind: "home" };
      if (header === config.bookId) return { kind: "home" };
      if (!registry) return { kind: "refuse", failure: NOT_SERVED };
      if (!isBookIdentifier(header)) return { kind: "refuse", failure: BOOK_INVALID };
      return { kind: "registry", bookId: header, caller: "service" };
    }
    return { kind: "home" };
  };

  /** `/v1` and `/api`: the application, for a caller who has a credential. A browser has a session
   * (a cookie, which becomes the owner's credential here and goes no further); the command line and an
   * agent send a bearer, which is used as it is. */
  const application = async (incoming: Request, url: URL, unlocked: boolean): Promise<Response> => {
    const bearer = incoming.headers.has("authorization");
    if (!bearer && credentials?.refuses(incoming))
      return unread(
        refusedWith(
          {
            code: "origin_denied",
            message: "Cross-site access to the application is not enabled",
            retryable: false,
            status: 403,
          },
          incoming,
          null,
        ),
      );
    const credential = bearer ? null : (credentials?.credential(incoming) ?? null);
    // A bearer that cannot open the door is no credential at all here: it gets the refusal of a request with none,
    // read no further than that one is, and never wakes the book.
    const door: Door = bearer
      ? await bearerAtTheDoor(incoming.headers.get("authorization"))
      : { kind: "owner" };
    const known =
      (bearer && (door.kind === "owner" || door.kind === "member" || door.kind === "service")) ||
      credential !== null;
    const upload = url.pathname === "/v1/uploads";
    // A book the server keeps besides the first is taken from the registry before the body is read: a request that comes too fast, or when the pod
    // is full, is turned away at the cost of the small request it is.
    const choice = chooseBook(door, incoming.headers.get(BOOK_HEADER), known);
    let slot = home;
    let lease: Lease<BookSlot> | null = null;
    let turnedAway: Parameters<typeof unavailableAnswer>[0] | null =
      choice.kind === "refuse" ? choice.failure : null;
    let broke: unknown = null;
    if (choice.kind === "registry" && registry) {
      try {
        lease = await registry.acquire(choice.bookId, choice.caller);
        slot = lease.slot;
      } catch (error) {
        if (error instanceof BooksRefused) turnedAway = error.failure;
        else broke = error;
      }
    }
    try {
      // The body is read as it arrives and no further than the application takes: a caller with no
      // credential never costs more than the small request it was allowed to make.
      const body = await readBody(
        incoming,
        upload && known && !turnedAway && !broke ? MAX_UPLOAD_BYTES + 4096 : MAX_BODY_BYTES,
      );
      // An owner with a lock and a caller with nothing to show: the answer the application would give,
      // in its own shape (the identities the page sent, echoed), without waking the book for it.
      if (unlocked && !known) {
        const failure = !bearer
          ? SIGN_IN_REQUIRED
          : door.kind === "token"
            ? TOKENS_NOT_ACCEPTED
            : door.kind === "other_book"
              ? WRONG_BOOK
              : door.kind === "unavailable"
                ? KEYS_UNAVAILABLE
                : NOT_ACCEPTED;
        const answer = refusedWith(failure, incoming, body === "too large" ? null : body);
        return body === "too large" ? unread(answer) : answer;
      }
      if (turnedAway) {
        if (turnedAway.code === "rate_limited" || turnedAway.code === "server_busy")
          sayRare(`refused: ${turnedAway.code} ${asked(incoming)}`);
        const answer = refusedWith(turnedAway, incoming, body === "too large" ? null : body);
        return body === "too large" ? unread(answer) : answer;
      }
      if (broke !== null)
        return notOpened(broke, { request: incoming, body: body === "too large" ? null : body });
      if (body === "too large") {
        if (!url.pathname.startsWith("/v1/"))
          return unread(Response.json({ error: "Request too large" }, { status: 413 }));
        return unread(
          refusedWith(
            {
              code: "request_too_large",
              message: upload ? "Request exceeds 16 MiB" : "Request exceeds 128 KiB",
              retryable: false,
              status: 413,
            },
            incoming,
            null,
          ),
        );
      }
      const headers = new Headers(incoming.headers);
      headers.delete("cookie");
      // Whatever a caller sent in the headers that tell the application who is calling and which book goes no further: only this process puts them there.
      headers.delete(PRINCIPAL_HEADER);
      headers.delete(BOOK_HEADER);
      if (credential) headers.set("authorization", credential);
      if (door.kind === "member" || door.kind === "service") {
        headers.delete("authorization");
        headers.set(
          PRINCIPAL_HEADER,
          vouch(
            principalSecret,
            door.kind === "service"
              ? { kind: "service", name: "control" }
              : door.agent
                ? {
                    kind: "agent",
                    userId: door.userId,
                    keyId: door.agent.keyId,
                    scopes: door.agent.scopes,
                    name: door.agent.name,
                    expires: Math.floor(Date.parse(door.agent.expiresAt) / 1000),
                  }
                : { kind: "member", userId: door.userId },
          ),
        );
      }
      const forwarded = new Request(serving.publicUrl(url), {
        method: incoming.method,
        headers,
        signal: incoming.signal,
      });
      return await serve(slot, forwarded, body, incoming);
    } finally {
      lease?.release();
    }
  };

  const route = async (incoming: Request, socketAddress: string | undefined): Promise<Response> => {
    // The Host is checked before the URL is read: a hostile one can make the URL unreadable.
    const host = incoming.headers.get("host") ?? "";
    const denied = () =>
      Response.json(
        { error: "Host not allowed: use the address the service printed", code: "host_denied" },
        { status: 421 },
      );
    if (!serving.hostAllowed(host)) return denied();
    let url: URL;
    try {
      url = new URL(incoming.url);
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    const path = url.pathname;
    const origin = incoming.headers.get("origin");
    if (origin && !readsPage(incoming, path) && !serving.originAllowed(origin, host, url)) {
      logOriginRefusal(incoming, path, origin);
      return Response.json(
        { error: "Application origin denied", code: "origin_denied" },
        { status: 403 },
      );
    }
    if (path === "/health" && incoming.method === "GET") {
      // What anyone may read: that the service is up and what its page may offer (the page reads this before anyone has signed in). Which book it serves, with what stores, how many are open and
      // how the telemetry is doing are the operator's, and are told to the owner's key; a service with no owner key (loopback development) tells everyone, as it always did.
      const presented = /^Bearer +(\S+)$/i.exec(incoming.headers.get("authorization") ?? "")?.[1];
      const detailed =
        options.ownerKey === undefined ||
        (presented !== undefined && sameSecret(presented, options.ownerKey));
      const offered = {
        // Whether people sign in with accounts (the page looks for the control plane's sign-in) and not only with the owner's key.
        ...(options.memberTokens ? { accounts: true } : {}),
        // The log is the book's backup and the platform keeps it: the pod makes none, and the page offers none (it offers the open export).
        backups: false,
        // Only the owner's key and people's tokens open a book here, so the page offers no agent access, unless people sign in with accounts: then an agent has a key of its own that the
        // control plane exchanges for a token (docs/reference/program/hosting/agents.md), and the page offers the keys.
        ...(options.ownerKey !== undefined && options.agentTokens === false && !options.memberTokens
          ? { agents: false }
          : {}),
        // A bank or Stripe credential kept beside the books would be every book's (see `credentials` in local/open.ts): the page offers no connection.
        ...(registry ? { connections: false } : {}),
      };
      return Response.json(
        {
          ok: true,
          // The commit the image was built from (the release pipeline waits for it after a release); not a secret, the repository is.
          ...(env.RASTRATA_REVISION ? { revision: env.RASTRATA_REVISION } : {}),
          hosted: detailed
            ? {
                book: config.bookId,
                open: home.book !== null,
                role: home.role,
                ...kind,
                ...offered,
                ...(registry
                  ? { books: { open: registry.stats().open, max: registry.stats().maxBooks } }
                  : {}),
                ...(peers ? { peers: peers.stats() } : {}),
              }
            : offered,
          ...(detailed ? healthTelemetry() : {}),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (sessions && (path === "/session" || path.startsWith("/session/"))) {
      const answered = await sessions.handle(incoming, url, clientAddress(incoming, socketAddress));
      if (answered) return answered;
    }
    if (control && path.startsWith("/control/")) return control(incoming, url);
    if (path.startsWith("/v1/") || path.startsWith("/api/"))
      return application(incoming, url, options.ownerKey !== undefined);
    // A locked service sends the app only to a browser that has signed in: anyone else is sent the sign-in page (see
    // `WebApp.serve`). The session is the cookie's; the book is behind the API, which asks for it on every request.
    const page = reserved(path)
      ? null
      : (options.web?.serve(
          incoming,
          options.ownerKey !== undefined
            ? {
                // The owner's session (when the server has sessions), or, on a service with accounts, the hint the control plane sets when a person signs in. The hint cannot be
                // checked here, unlocks nothing and can be made by anyone: it only decides between the sign-in page and the application's shell, whose data is behind the API.
                signedIn:
                  (sessions !== null && sessions.credential(incoming) !== null) ||
                  (options.memberTokens !== undefined &&
                    hasMemberHint(incoming.headers.get("cookie"))),
              }
            : undefined,
        ) ?? null);
    return (
      page ??
      new Response("Not found", {
        status: 404,
        // Never kept: a path that is not there now may be after the next release (a page of a new build asks the pods for files, and a pod of the old build does not have them yet), and
        // Cloudflare keeps a 404 for a file it serves, and tells the browser to keep it for hours, when the answer says nothing.
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      })
    );
  };

  /** Whether the server can serve: it is listening, with the web app read, and it is not shutting down.
   * Nothing else: not the lease (a quiet book has let it go) and not the tail (an outage is told to the
   * person as a service limit, and a pod taken out of its Service for it would be a Cloudflare 502). */
  let ready = false;
  /** `/live` and `/ready`, for the orchestrator. They are answered on any Host (a probe names the pod's own
   * address), need no session, and tell nothing but whether the process can serve. */
  const probe = (request: Request): Response | null => {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return null;
    }
    if (path !== "/live" && path !== "/ready") return null;
    const up = path === "/live" || (ready && !stopping && !leaving);
    const answer = up
      ? { ok: true }
      : { ok: false, ready: false, reason: stopping || leaving ? "shutting_down" : "starting" };
    return new Response(request.method === "HEAD" ? null : JSON.stringify(answer), {
      status: up ? 200 : 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
  /** While the server is leaving, every answer asks for its connection to be closed (HTTP says so with `connection: close`, and the server closes it after the answer). The client then makes its
   * next request on a new connection, which the Service sends to a pod that is staying, and not down one it keeps open to this pod. */
  const closing = (response: Response): Response => {
    if (!leaving || response.headers.get("connection")?.toLowerCase() === "close") return response;
    const headers = new Headers(response.headers);
    headers.set("connection", "close");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  /** The headers of a product server's answers (see web.ts), and the promise to keep to https. */
  const hstsValue = "max-age=31536000";
  const finish = (response: Response): Response => {
    if (!options.web) return response;
    const answered = hardened(response);
    if (serving.https && !answered.headers.has("strict-transport-security"))
      try {
        answered.headers.set("strict-transport-security", hstsValue);
      } catch {
        // A response whose headers cannot be changed is sent as it is.
      }
    return answered;
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: serving.bind,
      port: options.port,
      maxRequestBodySize: MAX_UPLOAD_BYTES + 4096,
      // The first read of a large book replays its ledger, and a request that waits for it sends nothing meanwhile.
      idleTimeout: 255,
      fetch: (request, bound) => {
        const probed = probe(request) ?? peers?.ping(request) ?? null;
        if (probed) return closing(probed);
        return observeHttp(request, () => route(request, bound.requestIP(request)?.address))
          .then(finish)
          .then(closing);
      },
    });
  } catch (error) {
    await registry?.stop().catch(() => {});
    await opened.close().catch(() => {});
    if (ownsTelemetry) await shutdownTelemetry();
    throw error;
  }
  serving.listening(server.port as number);
  if (peers) {
    const address = advertisedAddress(serving.bind, server.port as number);
    if (address) advertised = `@${address}`;
  }
  // The books in use are opened before the server says it is ready, as long as the budget allows; what is not open by then goes on opening behind it. A server that has nothing to open, no list or
  // a bucket that does not answer, goes on at once. Then the servers after this one are told what it has open.
  if (hot) {
    const opening = prewarmHot().catch(() => {});
    await within(opening, prewarmBudgetMs);
    void opening.then(() => tellHot(true));
  }
  ready = true;
  if (options.standby) home.startFollowing();
  else if (options.warm)
    void home
      .current()
      .then((warmed) =>
        warmed.fetch(warmRequest(`http://127.0.0.1:${server.port}/v1/journal.list`)),
      )
      .catch(() => {});

  let stopped: Promise<void> | null = null;
  let clean: boolean | null = null;
  return {
    server,
    get book() {
      return home.book;
    },
    get role() {
      return home.role;
    },
    /** The registry of the books besides the first, when the server serves more than one. */
    get books() {
      return registry;
    },
    /** After `stop`: whether the book was sealed and its lease given back (false when the bound ran out). */
    get clean() {
      return clean;
    },
    evict: () => home.evict(),
    /** Say that the server is about to stop: `/ready` answers 503 from now on, so that the orchestrator takes it out of the Service, and every answer asks for its connection to be
     * closed. It goes on serving, books included: a request that was already on its way is answered. `stop` ends it. */
    announceStop(): void {
      leaving = true;
    },
    /** Stop listening, let what is being answered finish, seal what the tail holds, give the lease back.
     * `graceMs` bounds the wait for requests in flight (the rest are cut off) and `closeMs` the sealing
     * and the release (a book that could not be closed in time is left to the next holder: its lease
     * lapses by itself). Without a bound, each waits as long as it takes. */
    stop(
      stopOptions: { readonly graceMs?: number; readonly closeMs?: number } = {},
    ): Promise<void> {
      stopped ??= (async () => {
        stopping = true;
        const closing = server.stop();
        if (stopOptions.graceMs === undefined) await closing;
        else {
          await within(closing, stopOptions.graceMs);
          void server.stop(true).catch(() => {});
        }
        const closeAll = (async () => {
          if (hotTimer) clearInterval(hotTimer);
          stopWarm();
          await within(tellHot(true), 2_000);
          await Promise.all([home.stop(), registry ? registry.stop() : Promise.resolve()]);
          await opened.close().catch(() => {});
        })();
        if (stopOptions.closeMs === undefined) {
          await closeAll;
          clean = true;
        } else {
          clean = (await within(closeAll, stopOptions.closeMs)).done;
          if (!clean) log("shutdown: the book could not be sealed and released in time");
        }
        if (ownsTelemetry) await shutdownTelemetry();
      })();
      return stopped;
    },
  };
}

/** What `work` came to if it came to anything within `ms`. */
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ readonly done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

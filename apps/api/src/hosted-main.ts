#!/usr/bin/env bun
/** The product server, started from the environment alone: what the image runs.
 *
 * It is one thing, a service for accounts. People sign in at the control plane (the Worker `rastrata-control`, at /auth), which signs a token
 * for one workspace; this server checks the token against the control plane's published keys and serves the workspace's book, opening a book
 * when its first request arrives and closing it when nobody uses it. The control plane tells it who is in a workspace with a key of its own.
 * There are no switches for any of that: a setting that is needed is required and a missing one stops the start with a message that names it.
 *
 *   RASTRATA_PUBLIC_ORIGIN         https://app.rastrata.com: the scheme and host people use; it names who signs the tokens and where their
 *                                  public keys are, so it is required
 *   RASTRATA_SERVICE_KEY_SHA256S   the SHA-256 digests (hex, comma separated) of the keys the control plane may present as a bearer
 *                                  to change who is in a book, or RASTRATA_SERVICE_KEY_SHA256S_FILE, a file that holds them (required)
 *   RASTRATA_OWNER_KEY             the operator's key, or RASTRATA_OWNER_KEY_FILE, a file that holds it (required). It locks the service, and
 *                                  with it the operator opens the first book and reads /health in detail. No one signs in with it in a
 *                                  browser, and a person's own token never needs it.
 *   RASTRATA_BOOK_STORE            r2log://<book id>             (required: the first book, and the place the others are kept)
 *   RASTRATA_BOOK_TAIL, _BULK, _CACHE, _SNAPSHOT_EVERY, _TAIL_TOKEN(_FILE), _TAIL_TIMEOUT_MS   see hosted.ts
 *   RASTRATA_API_PORT              the port (default 8080; 0 for any free port)
 *   RASTRATA_BIND                  the address to listen on (default 127.0.0.1; 0.0.0.0 in a pod)
 *   RASTRATA_ALLOWED_HOSTS         the hostnames it answers to, comma separated (needed beyond loopback)
 *   RASTRATA_BOOK_LEASE_MS         how long a lease lasts (default 5000)
 *   RASTRATA_BOOK_IDLE_RELEASE_MS  give the lease up after this long without a request (default 60000 on a
 *                                  Durable Object tail, which the production manifest names too)
 *   RASTRATA_BOOK_REVIEW_CHECK_MS  how often a book that is open is asked whether the verifier has stopped it (default 300000; 0 at every request)
 *   RASTRATA_PREWARM_BOOKS         the most books a starting server opens, without taking them, before it says it is ready: those the servers before it had open and were using (default 12; 0 opens none)
 *   RASTRATA_PREWARM_MS            how long it waits for them (default 15000); what is not open by then goes on opening behind it
 *   RASTRATA_SHUTDOWN_QUIET_MS     how long a pod that is told to stop goes on answering, not ready, before it stops listening (default 3000; 0 to stop at once)
 *   RASTRATA_BOOKS_MAX             the most books held open besides the first (default 256)
 *   RASTRATA_BOOKS_WARM_MB         the memory the books held open may be expected to take together (default: from the container's memory limit)
 *   RASTRATA_BOOKS_IDLE_MS         close a book nobody has asked for in this long (default 2592000000, thirty days)
 *   RASTRATA_BOOKS_LOADS           cold loads at once (default 2)
 *   RASTRATA_BOOKS_QUEUE           requests that may wait for a cold load before the answer is "busy" (default 64; 0 for no limit)
 *   RASTRATA_BOOKS_INFLIGHT        requests at once for one book (default 128)
 *   RASTRATA_BOOKS_RATE            requests a second for one book (default 30; a burst of three times that is allowed)
 *   RASTRATA_REPLAY                full (the default: the first read of a book applies the stored revisions and every outcome is executed again behind it, a write waiting for that) or trusted (never executed again)
 *   RASTRATA_BOOK_TAIL_BREAKER=off no circuit breaker in front of the tail (experiments only)
 *   RASTRATA_WEB_DIR               the built web app (default: web/ beside this file, else apps/web/dist)
 *
 * Switches this entry once had are gone, and setting one is a refusal to start (REMOVED below) and not a setting that is ignored:
 * RASTRATA_MEMBER_TOKENS and RASTRATA_BOOKS (the service always takes member tokens and serves many books), RASTRATA_AGENT_TOKENS (it takes no
 * agent token as a bearer: an agent has a key of the control plane's that is exchanged for a token), RASTRATA_BOOK_WARM (the first book is
 * not opened ahead of a request), and RASTRATA_BOOK_WHOLE_READ_ENTRIES (a book is never rebuilt from the first entry of its log before it answers: the log of every book is
 * read from the first entry in the background, right after the book's first open by the process). The experiment routes (`RASTRATA_BOOK_CONTROL`) and a standby (`RASTRATA_BOOK_STANDBY`) are not served
 * by this entry either, and asking for them is a refusal to start. Nothing printed here is a key, a token or the
 * address of a store.
 *
 * SIGTERM and SIGINT stop it cleanly. It says it is leaving (`/ready` answers 503, and every answer asks for its connection to be closed) and goes on answering for the quiet time, three
 * seconds, which is how long the Service takes to stop sending it requests and lets a pod that is starting beside it be ready. Then it stops listening, lets the requests in flight finish (ten
 * seconds at most), seals what the tail holds and gives the lease back (fifteen seconds at most), and exits 0, all inside twenty-eight seconds after the quiet time; a pod is given sixty.
 * Exit 78 means the settings are wrong. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isOwnerKey } from "@rastrata/application/agent";
import {
  type HostedServerOptions,
  kindOf,
  parseBookStore,
  startHostedApplicationServer,
} from "./hosted.ts";
import { type BooksSettings, CROWDED_IDLE_MS, defaultBooksSettings } from "./hosted-books.ts";
import { servingFromEnvironment } from "./hosted-serving.ts";
import { loadWebApp } from "./web.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** The wait for requests in flight, the wait for sealing and giving the lease back, and the moment the
 * process leaves whatever it is doing, counted from the end of the quiet time. With the quiet time (at most twenty seconds) they add up to less than the pod's sixty seconds. */
export const SHUTDOWN_GRACE_MS = 10_000;
export const SHUTDOWN_CLOSE_MS = 15_000;
export const SHUTDOWN_DEADLINE_MS = 28_000;
/** How long a pod that has been told to stop goes on answering, not ready, before it stops listening: the time the cluster takes to take it out of the Service on every node. In an update the new pod is
 * ready by then and has been sent the requests the old one is no longer sent, and waits for the books the old one still holds. */
export const SHUTDOWN_QUIET_MS = 3_000;

/** The EX_CONFIG exit status: the settings are wrong and running again will not fix it by itself. */
const CONFIGURATION_ERROR = 78;

class ConfigurationError extends Error {}

function whole(name: string, value: string | undefined, low: number, high: number) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!/^[0-9]+$/.test(value) || number < low || number > high)
    throw new ConfigurationError(`${name} must be a whole number from ${low} to ${high}`);
  return number;
}

/** The owner key: `RASTRATA_OWNER_KEY`, or the contents of the file `RASTRATA_OWNER_KEY_FILE` names (a
 * Secret mounted in a pod ends with a newline, which is not part of it). Says what is wrong with the
 * setting, and never what the key is. */
export function ownerKeyFrom(env: Environment): string | undefined {
  const direct = env.RASTRATA_OWNER_KEY?.trim();
  const file = env.RASTRATA_OWNER_KEY_FILE;
  if (direct && file)
    throw new ConfigurationError("Set RASTRATA_OWNER_KEY or RASTRATA_OWNER_KEY_FILE, not both");
  let key = direct;
  if (file) {
    try {
      key = readFileSync(file, "utf8").trim();
    } catch {
      throw new ConfigurationError("RASTRATA_OWNER_KEY_FILE cannot be read");
    }
  }
  if (!key) return undefined;
  if (!isOwnerKey(key))
    throw new ConfigurationError("The owner key is not an owner key (rso_ and 43 characters)");
  return key;
}

/** The directory of the built web app, or null when there is none. A directory named with
 * `RASTRATA_WEB_DIR` has to have one. */
async function webAppFor(env: Environment) {
  const named = env.RASTRATA_WEB_DIR;
  if (named) {
    const web = await loadWebApp(resolve(named), { accounts: true });
    if (!web) throw new ConfigurationError("RASTRATA_WEB_DIR has no web app (no index.html)");
    return web;
  }
  const embedded = resolve(import.meta.dir, "web");
  return loadWebApp(existsSync(embedded) ? embedded : resolve(import.meta.dir, "../../web/dist"), {
    accounts: true,
  });
}

/** The digests of the control plane's keys: `RASTRATA_SERVICE_KEY_SHA256S`, or the contents of the file
 * `RASTRATA_SERVICE_KEY_SHA256S_FILE` names. Each is 64 lower-case hexadecimal characters; two are listed while a key is rotated. Says what is
 * wrong with the setting and never what a digest is. */
export function serviceKeyDigestsFrom(env: Environment): readonly string[] {
  const direct = env.RASTRATA_SERVICE_KEY_SHA256S?.trim();
  const file = env.RASTRATA_SERVICE_KEY_SHA256S_FILE;
  if (direct && file)
    throw new ConfigurationError(
      "Set RASTRATA_SERVICE_KEY_SHA256S or RASTRATA_SERVICE_KEY_SHA256S_FILE, not both",
    );
  let text = direct;
  if (file) {
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      throw new ConfigurationError("RASTRATA_SERVICE_KEY_SHA256S_FILE cannot be read");
    }
  }
  if (!text) return [];
  const digests = text.split(",").map((digest) => digest.trim());
  if (digests.some((digest) => !/^[0-9a-f]{64}$/.test(digest)))
    throw new ConfigurationError(
      "RASTRATA_SERVICE_KEY_SHA256S lists SHA-256 digests: 64 lower-case hexadecimal characters each, separated by commas",
    );
  return digests;
}

/** The numbers that tune the registry of books, each held to a range. Every one is optional, and the defaults come from the container's memory limit. */
export function booksSettingsFrom(env: Environment): Partial<BooksSettings> {
  const maxBooks = whole("RASTRATA_BOOKS_MAX", env.RASTRATA_BOOKS_MAX, 1, 10_000);
  const warmMb = whole("RASTRATA_BOOKS_WARM_MB", env.RASTRATA_BOOKS_WARM_MB, 16, 1_000_000);
  const idleMs = whole(
    "RASTRATA_BOOKS_IDLE_MS",
    env.RASTRATA_BOOKS_IDLE_MS,
    10_000,
    60 * 86_400_000,
  );
  const loads = whole("RASTRATA_BOOKS_LOADS", env.RASTRATA_BOOKS_LOADS, 1, 16);
  const loadQueue = whole("RASTRATA_BOOKS_QUEUE", env.RASTRATA_BOOKS_QUEUE, 0, 10_000);
  const inflight = whole("RASTRATA_BOOKS_INFLIGHT", env.RASTRATA_BOOKS_INFLIGHT, 1, 1000);
  const rate = whole("RASTRATA_BOOKS_RATE", env.RASTRATA_BOOKS_RATE, 1, 10_000);
  return {
    ...(maxBooks !== undefined ? { maxBooks } : {}),
    ...(warmMb !== undefined ? { warmBudgetBytes: warmMb * 2 ** 20 } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
    ...(loads !== undefined ? { loads } : {}),
    ...(loadQueue !== undefined ? { loadQueue } : {}),
    ...(inflight !== undefined ? { inflight } : {}),
    ...(rate !== undefined ? { rate, burst: rate * 3 } : {}),
  };
}

export interface ProductSettings {
  readonly options: HostedServerOptions;
  /** How long the process goes on answering, not ready, after it is told to stop (see {@link SHUTDOWN_QUIET_MS}). */
  readonly quietMs: number;
  /** What to say at start, line by line: nothing in it is a credential. */
  readonly lines: readonly string[];
}

/** A length of time in the unit a person would say it in: "30 days", "6 hours", "10 minutes". */
function idleFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 2 * 1440 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** What the server will do with many books, in words, as the numbers came out (the container's memory limit decides the defaults). */
function booksLine(settings: BooksSettings): string {
  const megabytes = (bytes: number) => Math.round(bytes / 2 ** 20);
  return (
    `books: many (up to ${settings.maxBooks} open besides the first, about ${megabytes(settings.warmBudgetBytes)} MB of them warm, ` +
    `${settings.loads} cold loads at a time, closed after ${idleFor(settings.idleMs)} idle (${idleFor(Math.min(CROWDED_IDLE_MS, settings.idleMs))} while the pod is crowded), ` +
    `${settings.rate} requests a second and ${settings.inflight} at once for each)`
  );
}

/** Settings this entry once read. Each was a switch between two services, and the service is now only the one, so a setting that is still given is a manifest out of date, and
 * is refused: a name that nothing reads is how a service comes to do something other than what its manifest says. */
const REMOVED: Readonly<Record<string, string>> = {
  RASTRATA_MEMBER_TOKENS: "the service always takes member tokens",
  RASTRATA_BOOKS: "the service always serves many books",
  RASTRATA_AGENT_TOKENS:
    "no agent token is a bearer here: an agent has a key of the control plane's, which is exchanged for a token",
  RASTRATA_BOOK_WARM: "the first book is opened with its first request and not ahead of it",
  RASTRATA_BOOK_WHOLE_READ_ENTRIES:
    "no book is rebuilt from the first entry of its log before it answers; the log of every book is read in the background after its first open",
};

/** Everything the environment says, as the options of the server and what to tell the log. Throws a
 * `ConfigurationError` that names the setting and does not repeat a value that may be a credential. */
export async function productSettings(
  env: Environment = process.env,
  log: (line: string) => void = () => {},
): Promise<ProductSettings> {
  for (const [name, why] of Object.entries(REMOVED))
    if ((env[name] ?? "") !== "")
      throw new ConfigurationError(`${name} is not a setting any more: ${why}`);
  const store = env.RASTRATA_BOOK_STORE;
  if (!store) throw new ConfigurationError("RASTRATA_BOOK_STORE is needed (r2log://<book id>)");
  if (env.RASTRATA_BOOK_CONTROL === "1" || env.RASTRATA_BOOK_STANDBY === "1")
    throw new ConfigurationError(
      "RASTRATA_BOOK_CONTROL and RASTRATA_BOOK_STANDBY are for the experiments (apps/api/src/main.ts): the product server serves neither",
    );
  let config: ReturnType<typeof parseBookStore>;
  try {
    config = parseBookStore(store, env);
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : String(error));
  }
  const port = whole("RASTRATA_API_PORT", env.RASTRATA_API_PORT, 0, 65535) ?? 8080;
  const leaseMs = whole("RASTRATA_BOOK_LEASE_MS", env.RASTRATA_BOOK_LEASE_MS, 1000, 300_000);
  const idleReleaseMs = whole(
    "RASTRATA_BOOK_IDLE_RELEASE_MS",
    env.RASTRATA_BOOK_IDLE_RELEASE_MS,
    0,
    86_400_000,
  );
  const reviewCheckMs = whole(
    "RASTRATA_BOOK_REVIEW_CHECK_MS",
    env.RASTRATA_BOOK_REVIEW_CHECK_MS,
    0,
    86_400_000,
  );
  const prewarmBooks = whole("RASTRATA_PREWARM_BOOKS", env.RASTRATA_PREWARM_BOOKS, 0, 64);
  const prewarmMs = whole("RASTRATA_PREWARM_MS", env.RASTRATA_PREWARM_MS, 0, 120_000);
  const quietMs =
    whole("RASTRATA_SHUTDOWN_QUIET_MS", env.RASTRATA_SHUTDOWN_QUIET_MS, 0, 20_000) ??
    SHUTDOWN_QUIET_MS;
  const replay = env.RASTRATA_REPLAY || "full";
  if (replay !== "full" && replay !== "trusted")
    throw new ConfigurationError("RASTRATA_REPLAY must be full or trusted");
  // The service is locked and takes accounts, always. What it needs for that is required, and each is said by name.
  const ownerKey = ownerKeyFrom(env);
  if (!ownerKey)
    throw new ConfigurationError(
      "RASTRATA_OWNER_KEY is needed: it locks the service (a book is never offered without a lock) and is the operator's key for the first book",
    );
  const serving = servingFromEnvironment(env);
  const origin = serving.publicOrigin;
  if (!origin)
    throw new ConfigurationError(
      "RASTRATA_PUBLIC_ORIGIN is needed: it names who signs the tokens and where their keys are",
    );
  const serviceKeys = serviceKeyDigestsFrom(env);
  if (serviceKeys.length === 0)
    throw new ConfigurationError(
      "RASTRATA_SERVICE_KEY_SHA256S is needed: it is how the control plane tells the service who is in a workspace (the SHA-256 of its key)",
    );
  const web = await webAppFor(env);
  // A locked service sends a browser that is not signed in the sign-in page, and never the app. A build with no
  // such page would send the app to anyone, so the service does not start with one.
  if (web && !web.signIn)
    throw new ConfigurationError(
      "The web app has no sign-in page (signin.html) and the service is locked: build the web app again",
    );
  const books = booksSettingsFrom(env);
  const options: HostedServerOptions = {
    config,
    port,
    env,
    serving,
    web,
    replay,
    log,
    // No agent token is a bearer (an agent has a key of the control plane's, exchanged for a token), and a browser has no session of the owner's: a person has
    // a token of the control plane's and nothing else, so there is no password for a browser to type and no pilot sign-in left to reach.
    agentTokens: false,
    sessions: false,
    memberTokens: { origin },
    serviceKeys,
    books: { settings: books },
    ownerKey,
    ...(leaseMs !== undefined ? { leaseMs } : {}),
    ...(idleReleaseMs !== undefined ? { idleReleaseMs } : {}),
    ...(reviewCheckMs !== undefined ? { reviewCheckMs } : {}),
    ...(prewarmBooks !== undefined || prewarmMs !== undefined
      ? {
          prewarm: {
            ...(prewarmBooks !== undefined ? { books: prewarmBooks } : {}),
            ...(prewarmMs !== undefined ? { budgetMs: prewarmMs } : {}),
          },
        }
      : {}),
    ...(env.RASTRATA_BOOK_TAIL_BREAKER === "off" ? { guard: false as const } : {}),
  };
  const lines = [
    `book ${config.bookId}, tail ${kindOf(config.tail)}, bulk store ${kindOf(config.bulk)}, cache in ${config.cache}`,
    `answering to ${serving.allowedHosts?.join(", ") ?? "this computer"}, public address ${origin}`,
    `accounts: member tokens signed by ${origin}/auth, checked against its published keys; the control plane's key: ${serviceKeys.length} accepted`,
    "the operator's key opens the first book as a bearer; there is no sign-in with it for a browser and no agent token is a bearer",
    booksLine(defaultBooksSettings(undefined, books)),
    web ? `web app: ${web.files} files` : "web app: none found, the API only",
    replay === "trusted"
      ? "replay: trusted (the book is not re-executed when it is read: only safe while a verifier re-executes it)"
      : "replay: full",
  ];
  return { options, quietMs, lines };
}

/** Run the server until it is stopped. */
export async function runHostedServer(env: Environment = process.env): Promise<void> {
  const log = (line: string) => console.info(line);
  let settings: ProductSettings;
  try {
    settings = await productSettings(env, log);
  } catch (error) {
    console.error(
      `Rastrata could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(error instanceof ConfigurationError ? CONFIGURATION_ERROR : 1);
  }
  // The key is held by the server now; nothing else in the process needs it in the environment.
  if (env === process.env) Reflect.deleteProperty(process.env, "RASTRATA_OWNER_KEY");
  let hosted: Awaited<ReturnType<typeof startHostedApplicationServer>>;
  try {
    hosted = await startHostedApplicationServer(settings.options);
  } catch (error) {
    console.error(
      `Rastrata could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(
      error instanceof Error && /^RASTRATA_/.test(error.message) ? CONFIGURATION_ERROR : 1,
    );
  }
  console.info(`Rastrata hosted server: listening on ${hosted.server.url}`);
  for (const line of settings.lines) console.info(`  ${line}`);

  let ending = false;
  const end = (signal: string) => {
    if (ending) return;
    ending = true;
    console.info(
      `Rastrata hosted server: ${signal}, leaving (not ready, still answering for ${settings.quietMs} ms), then stopping`,
    );
    // Whatever happens below, the process is gone before the pod's grace period is.
    setTimeout(() => {
      console.error("Rastrata hosted server: shutdown did not finish in time, leaving");
      process.exit(1);
    }, settings.quietMs + SHUTDOWN_DEADLINE_MS).unref();
    // Not ready from now on, so that the Service stops sending requests here; it answers the ones already on their way until the quiet time is over.
    hosted.announceStop();
    setTimeout(() => {
      hosted.stop({ graceMs: SHUTDOWN_GRACE_MS, closeMs: SHUTDOWN_CLOSE_MS }).then(
        () => {
          console.info(
            hosted.clean
              ? "Rastrata hosted server: stopped, the book is sealed and its lease given back"
              : "Rastrata hosted server: stopped, the book could not be sealed in time (its lease lapses by itself)",
          );
          process.exit(hosted.clean ? 0 : 1);
        },
        (error: unknown) => {
          console.error(
            `Rastrata hosted server: stopping failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(1);
        },
      );
    }, settings.quietMs);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => end(signal));
  // Anything unexpected ends the process, so that it is started again: a process that holds a book and
  // is in an unknown state is worse than one that lets go of it.
  const fatal = (error: unknown) => {
    console.error(
      `Rastrata hosted server: unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

if (import.meta.main) await runHostedServer();

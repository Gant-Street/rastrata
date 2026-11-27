import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  configureLocalDatabase,
  LOCAL_ACTOR,
  LOCAL_BOOK_SCOPE,
  openLocalLedger,
  type OutcomePageObserved,
} from "./ledger.ts";
import { createHostedExportHost, type HostedExportOptions } from "./hosted-exports.ts";
import { createLocalSafetyHost, type LocalSafetyOptions } from "./safety-host.ts";
import { localCredentialStore, localSimplefinStandIn } from "./simplefin-credential.ts";
import { localStripeApiUrl, localStripeKeySource } from "./stripe-key.ts";
import { ApplicationService, type ReplayMode, type VerifiedView } from "../service.ts";
import { prepareSlices } from "../slices/prepare.ts";
import { observeOpen } from "../telemetry.ts";
import { configureBankfeedRuntime } from "../slices/bankfeed/runtime.ts";
import { configureStripeRuntime } from "../slices/stripe/runtime.ts";

export interface LocalOpenOptions {
  /** Replaces the system clock, for tests that depend on today's date. */
  readonly now?: () => Date;
  /** Offer backups, restore drills and exports (the default, with the folders beside the
   * database). `false` leaves the port out, as the scratch copies a verification opens do. */
  readonly safety?: false | LocalSafetyOptions;
  /** With `safety` off: still offer exports, made in a folder of the book's own and kept for an hour to be downloaded (a hosted pod, which keeps its own backups). */
  readonly exports?: HostedExportOptions;
  /** Told the position of every page of outcomes read: the progress of a replay. */
  readonly observe?: (page: OutcomePageObserved) => void;
  /** Keep a snapshot of the verified book state in product state (`app_read_snapshots`) so a restart
   * replays only the newest outcomes. On by default, as a local book wants it. A hosted cache turns
   * it off: its snapshot is the SQLite file in the object store. Without it, a cold read of a book
   * between about 1,600 and 10,000 journals does not make the one attempt to encode a state past the
   * kernel's 16 MiB cap, an attempt that costs 470 to 670 MB of transient memory. */
  readonly snapshots?: boolean;
  /** How reads apply the ledger's outcomes: "full" (the default) executes every one again, "trusted"
   * applies the stored revisions of a book with the chain-head commitment without executing them, the
   * way a hosted pod opens a book after an eviction. `readAggregate(undefined, { verify: "full" })`
   * is the check on a trusted service. A trusted service writes no read snapshot. See `ReplayMode`. */
  readonly replay?: ReplayMode;
  /** Called with the open database once its pragmas are set and before the ledger touches it: the
   * hook for a host that attaches something to the connection (the hosted book log's change
   * capture, a different `synchronous` setting). It runs inside the open and may throw to refuse. */
  readonly onDatabase?: (db: Database) => void;
  /** Use this open connection instead of opening the file. The host (the hosted book log) has set it
   * up (pragmas, change capture) and owns it: every statement of the book runs on it, so the host can
   * hold a whole request in one transaction, and the service never closes it, not when it is closed
   * and not when the open fails. A host that changes the database under the service (catching up on
   * the log) opens a new service on the same connection. */
  readonly database?: Database;
  /** The verified state of the service this one replaces, when the host makes a new service on a connection whose database has moved on under the old (see `ApplicationServiceOptions.view`). */
  readonly view?: VerifiedView | null;
  /** The check of the ledger under way in the service this one replaces, handed on with its view (see `ApplicationServiceOptions.verifying`). */
  readonly verifying?: Promise<void> | null;
  /** Answer from the stored revisions and check the whole ledger behind the first answer (see `ApplicationServiceOptions.verifyBehind`); it sets `replay: "trusted"`. */
  readonly verifyBehind?: boolean;
  /** Make the tables of every slice now, as part of opening, instead of when each is first used.
   * A host that keeps a log of every change to the book wants the schema to change at one known
   * moment, so that a read is never a schema change. Off by default: a book in a file makes its
   * tables as it goes. */
  readonly prepareSlices?: boolean;
  /** Where the Stripe key and the bank feed's access URL come from. `local` (the default): the environment and private files in the folder the book is in, which
   * is right for one person's computer and for a process that holds one book. `none`: nowhere. A process that holds many books has no place for a credential
   * that is one tenant's alone: the environment is the process's, and a file in the folder is in every book's folder. With `none` the Stripe lane finds no key and the
   * bank feed has no private place to keep a connection, so neither can be used and neither can be given another tenant's. */
  readonly credentials?: "local" | "none";
}

/** Explicit local-development adapter. Credentials and the physical database
 * stay in this process; terminal and browser clients never receive them. */
export class LocalBookService extends ApplicationService {
  /** Open a book. With telemetry on, the open is timed and the service instrumented once, here
   * (see ../telemetry.ts); with it off this is `openBook` and nothing else. */
  static open(path: string, options: LocalOpenOptions = {}): Promise<LocalBookService> {
    return observeOpen(() => LocalBookService.openBook(path, options));
  }

  private static async openBook(
    path: string,
    options: LocalOpenOptions,
  ): Promise<LocalBookService> {
    if (!options.database) mkdirSync(dirname(path), { recursive: true });
    const db = options.database ?? new Database(path, { create: true });
    if (!options.database) configureLocalDatabase(db);
    try {
      options.onDatabase?.(db);
      const local = await openLocalLedger(db, options.observe);
      const service = new LocalBookService({
        ...(options.now ? { now: options.now } : {}),
        // A connection the host supplied stays the host's: closing the service is not closing it.
        store: options.database ? { ...local.store, close: () => {} } : local.store,
        ledger: local.ledger,
        scope: LOCAL_BOOK_SCOPE,
        actorId: LOCAL_ACTOR,
        snapshots: options.snapshots ?? true,
        ...(options.replay ? { replay: options.replay } : {}),
        ...(options.verifyBehind ? { replay: "trusted" as const, verifyBehind: true } : {}),
        ...(options.view ? { view: options.view } : {}),
        ...(options.verifying ? { verifying: options.verifying } : {}),
        credential: local.credential,
        ...(options.safety === false
          ? options.exports
            ? { host: { exports: createHostedExportHost(options.exports) } }
            : {}
          : { host: { safety: createLocalSafetyHost(path, options.safety ?? {}) } }),
      });
      if (options.prepareSlices) prepareSlices(service);
      // The Stripe key is read from the environment or a private file beside the database. Stripe
      // is reached at its own address unless a loopback stand-in is named for a browser test.
      const clock = options.now;
      const stripeUrl = localStripeApiUrl();
      const credentials = options.credentials ?? "local";
      configureStripeRuntime(service, {
        keySource:
          credentials === "none" ? { read: () => null } : localStripeKeySource(dirname(path)),
        // A service that keeps no credential beside the books gets Stripe from the sender (`stripe.receive`).
        senderFetches: credentials === "none",
        ...(stripeUrl ? { baseUrl: stripeUrl } : {}),
        ...(clock ? { now: () => clock().toISOString() } : {}),
      });
      // The SimpleFIN access URL is kept in a private file beside the book, never in the book (see
      // simplefin-credential.ts). Only a stand-in Bridge on this machine, named by a test through its
      // environment, may be spoken to over http, and only at that one address.
      const standIn = localSimplefinStandIn();
      configureBankfeedRuntime(service, {
        // Without a store the lane keeps its own default: no private place, so no connection can be made.
        ...(credentials === "none" ? {} : { credentials: localCredentialStore(dirname(path)) }),
        policy: standIn ? { allowLoopback: true, onlyOrigin: standIn } : { allowLoopback: false },
        ...(clock ? { now: () => clock().toISOString() } : {}),
      });
      return service;
    } catch (error) {
      if (!options.database) db.close();
      throw error;
    }
  }
}

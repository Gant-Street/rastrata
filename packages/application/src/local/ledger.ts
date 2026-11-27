import type { Database } from "bun:sqlite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  AuthorizedNativeLedger,
  BookAuthorizer,
  BOOK_ACCESS_TOKEN_TYPE,
  type BookApplicationService,
  type CompleteBookScope,
  type SqliteStorage,
} from "@rastrata/ledger";
import type { ApplicationStore } from "../storage.ts";

export const LOCAL_BOOK_SCOPE: CompleteBookScope = Object.freeze({
  tenantId: "local-development",
  bookId: "local-book",
  objectId: "local-book-object",
  namespaceId: "local-development",
  generation: "0",
});
const issuer = "https://local.rastrata.invalid";
const audience = "rastrata-local-ledger";
export const LOCAL_ACTOR = "local-operator";

/** The position of one page of outcomes the ledger returned: how far a replay has read. */
export interface OutcomePageObserved {
  readonly through: string;
  readonly tip: string;
}

/** Everything the local runtime builds around one open database: the application's store, the
 * authenticated ledger and the credential this process signs for itself. Shared by the local
 * service, by the verification of a backup on a scratch copy and by the import of an export. */
export interface LocalLedger {
  readonly store: ApplicationStore;
  readonly ledger: BookApplicationService;
  /** A bearer credential for this ledger, signed for `actor` (the local operator by default). */
  readonly credential: (actor?: string) => Promise<string>;
}

class ObservedLedger implements BookApplicationService {
  constructor(
    private readonly inner: BookApplicationService,
    private readonly observe: (page: OutcomePageObserved) => void,
  ) {}
  checkRequestAuthorization(
    ...args: Parameters<BookApplicationService["checkRequestAuthorization"]>
  ) {
    return this.inner.checkRequestAuthorization(...args);
  }
  provision(...args: Parameters<BookApplicationService["provision"]>) {
    return this.inner.provision(...args);
  }
  execute(...args: Parameters<BookApplicationService["execute"]>) {
    return this.inner.execute(...args);
  }
  async outcomes(...args: Parameters<BookApplicationService["outcomes"]>) {
    const page = await this.inner.outcomes(...args);
    this.observe({ through: page.through.sequence, tip: page.observedTip.sequence });
    return page;
  }
  advanceAuthorization(...args: Parameters<BookApplicationService["advanceAuthorization"]>) {
    return this.inner.advanceAuthorization(...args);
  }
}

/** Open the pragmas every local database uses: write-ahead log, full synchronous writes, foreign
 * keys on. */
export function configureLocalDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
}

export async function openLocalLedger(
  db: Database,
  observe?: (page: OutcomePageObserved) => void,
): Promise<LocalLedger> {
  const key = await generateKeyPair("ES256", { extractable: true });
  const publicKey = {
    ...(await exportJWK(key.publicKey)),
    kid: "local",
    alg: "ES256",
    use: "sig",
  };
  const authorizer = new BookAuthorizer({
    issuer,
    audience,
    publicKeys: { keys: [publicKey] },
  });
  const storage: SqliteStorage = {
    sql: {
      exec: (sql, ...bindings) =>
        db
          .query(sql)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[],
    },
    transactionSync: (work) => db.transaction(work).immediate(),
    async sync() {},
  };
  const store: ApplicationStore = {
    exec: (sql) => {
      db.exec(sql);
    },
    query: (sql) => ({
      get: (...bindings) => db.query(sql).get(...bindings),
      all: (...bindings) => db.query(sql).all(...bindings),
      run: (...bindings) => {
        const result = db.query(sql).run(...bindings);
        // The rows the statement itself changed. Bun counts the rows a trigger changed as well, and
        // callers compare this with 1 ("the draft was not changed by anyone else"), so a host that
        // puts triggers on the connection (the hosted book log's change capture) must not move it.
        if (result.changes === 0) return { changes: 0 };
        return { changes: (db.query("SELECT changes() AS n").get() as { n: number }).n };
      },
    }),
    close: () => db.close(),
    transaction: (work) => db.transaction(work).immediate(),
  };
  const native = new AuthorizedNativeLedger(
    storage,
    LOCAL_BOOK_SCOPE,
    LOCAL_BOOK_SCOPE.objectId,
    () => ({ fence: "0", pending: false }),
    authorizer,
  );
  return {
    store,
    ledger: observe ? new ObservedLedger(native, observe) : native,
    credential: async (actor: string = LOCAL_ACTOR) => {
      const seconds = Math.floor(Date.now() / 1000);
      return `Bearer ${await new SignJWT({
        scope: LOCAL_BOOK_SCOPE,
        authorizationRevision: "0",
        writerFence: "0",
        permissions: ["read", "execute", "provision", "maintain"],
        iss: issuer,
        aud: audience,
        sub: actor,
        iat: seconds,
        nbf: seconds,
        exp: seconds + 300,
      })
        .setProtectedHeader({ alg: "ES256", typ: BOOK_ACCESS_TOKEN_TYPE, kid: "local" })
        .sign(key.privateKey)}`;
    },
  };
}

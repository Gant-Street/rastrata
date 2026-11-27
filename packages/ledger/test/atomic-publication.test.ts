import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  executeBookCommand,
  decodeDurableBook,
  createBookState,
  createBookProtocolState,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  ProductionLedger,
  COMPACT_LEDGER_FORMAT,
  SqliteBookStorage,
  LedgerError,
  type SqliteStorage,
} from "../src/index.ts";
import type { BookStorageAdapter } from "../src/sqlite.ts";
import { SqliteIndexControl, type IndexAnchor } from "../src/index-control.ts";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import {
  atomicSqlite,
  requireSqliteTransaction,
  type SqliteTransaction,
} from "../src/sqlite-transaction.ts";
import { indexBookIdentityCommitment, ledgerIndexHeadCommitment } from "../src/index-view-audit.ts";
import {
  auditBalancedIndex,
  auditStoredIdentityIndex,
  createIndexRoot,
  identityIndexKey,
  prepareIndexInsert,
  INDEX_KEY_SCHEMA,
  lookupIndexEntry,
} from "../src/index-pages.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";
import { prepareOutcomeIdentityDelta } from "../src/outcome-identities.ts";
import type { StoredBook } from "../src/records.ts";

const owner = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "namespace",
  generation: "0",
};
async function fixture(initial: DurableBookAggregate = genesis()) {
  const identity = { ...owner, bookId: initial.state.identity.bookId };
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
  const faults = {
    now: 10n,
    afterSql: "",
    losePublicationSync: false,
    failNextSync: false,
    beforePublication: undefined as (() => Promise<void>) | undefined,
  };
  let depth = 0,
    maximumDepth = 0,
    commits = 0,
    initialized = false;
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (faults.afterSql && sql.startsWith(faults.afterSql))
          throw new Error("injected publication SQL failure");
        if (faults.losePublicationSync && sql.startsWith("UPDATE ledger_index_control")) {
          faults.losePublicationSync = false;
          faults.failNextSync = true;
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const name in row) {
            const value = row[name];
            if (value instanceof Uint8Array) {
              row[name] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync(fn) {
      if (depth !== 0) throw new Error("Unexpected nested SQLite transaction");
      depth++;
      maximumDepth = Math.max(maximumDepth, depth);
      try {
        return db.transaction(fn)();
      } finally {
        depth--;
      }
    },
    async sync() {
      if (faults.failNextSync) {
        faults.failNextSync = false;
        throw new Error("lost publication confirmation");
      }
    },
  };
  const canonical = new SqliteBookStorage(identity.objectId, port);
  const identityHash = indexBookIdentityCommitment(identity);
  const anchor = (): IndexAnchor => {
    const row = db.query("SELECT head FROM ledger_metadata").get() as { head: string };
    const head = JSON.parse(row.head);
    return {
      identityHash,
      headHash: ledgerIndexHeadCommitment(head, COMPACT_LEDGER_FORMAT),
      sequence: head.sequence,
      fence: "0",
      provisioning: !initialized,
      pending: false,
    };
  };
  const control = new SqliteIndexControl(port, anchor, () => faults.now);
  const pages = new SqliteIndexPageStore(port, identityHash);
  let loaded: StoredBook | undefined;
  // Test-only owner integration. ProductionLedger verifies this loaded history
  // before invoking commitTransition. Identity derivation now consumes actual
  // outcome bytes, not fixture-supplied IDs. This fixture has only a hot partition;
  // it is not an all-partition adapter or a claim of indexed kernel evaluation.
  const adapter: BookStorageAdapter = {
    objectId: identity.objectId,
    load: (scope) => (loaded = canonical.load(scope)),
    provision: (book) => canonical.provision(book),
    async sync() {
      await canonical.sync();
      if (initialized) {
        await control.recoverMetadata();
        await pages.recover();
      }
    },
    async commitTransition(expected, record) {
      commits++;
      const current = await control.readMetadata();
      if (current.view.headHash !== ledgerIndexHeadCommitment(expected, COMPACT_LEDGER_FORMAT))
        throw new LedgerError("ledger_head_conflict");
      const pin = await control.pinCurrent(current.view, "construction", String(faults.now + 90n));
      const root =
        current.view.hotCount === "0"
          ? createIndexRoot(0n, null)
          : await pages.readRootDescriptor(current.view.hotRoot);
      if (!root) throw new Error("Missing fixture root");
      let index = await auditBalancedIndex(root, root.contentHash, (id) => pages.read(id));
      const delta = await prepareOutcomeIdentityDelta(
        record.body,
        identity.bookId,
        BigInt(record.after.sequence),
        async (key) => {
          const found = await lookupIndexEntry(root, root.contentHash, key, (id) => pages.read(id));
          await control.readPinned(pin);
          if (found.sequence === null) return null;
          const original = loaded?.outcomes[Number(found.sequence - 1n)];
          if (!original || original.after.sequence !== String(found.sequence))
            throw new Error("Missing canonical identity source");
          return { sequence: found.sequence, encodedOutcome: original.body };
        },
      );
      for (const identity of delta) {
        const reserved = await pages.reserve(control, pin, 2 * index.height + 1);
        let used = 0;
        const plan = await prepareIndexInsert(
          index,
          { key: identityIndexKey(identity), sequence: identity.outcomeSequence },
          (id) => pages.read(id),
          () => {
            const id = reserved[used++];
            if (!id) throw new Error("Missing fixture reservation");
            return id;
          },
        );
        for (const page of plan.pages)
          await pages.putReserved(control, pin, page.descriptor.page, page.bytes);
        if (used < reserved.length) await pages.abandon(control, pin, reserved.slice(used));
        index = plan.index;
      }
      const prepared = await pages.retainPreparedRoot(
        control,
        pin,
        index.root,
        index.root.contentHash,
        {
          ...anchor(),
          headHash: ledgerIndexHeadCommitment(record.after, COMPACT_LEDGER_FORMAT),
          sequence: record.after.sequence,
        },
      );
      await faults.beforePublication?.();
      await control.publishPrepared(pin, prepared.digest, (transaction) => {
        canonical.commitTransitionInTransaction(transaction, expected, record);
        return undefined;
      });
    },
  };
  const ledger = new ProductionLedger(adapter, identity, COMPACT_LEDGER_FORMAT);
  await ledger.provision(initial);
  await control.initialize(INDEX_KEY_SCHEMA);
  await pages.initialize("allocated");
  initialized = true;
  async function audit() {
    const snapshot = await ledger.read();
    const current = await control.readMetadata();
    expect(current.view.sequence).toBe(snapshot.head.sequence);
    expect(current.view.headHash).toBe(
      ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT),
    );
    const root =
      current.view.hotCount === "0"
        ? createIndexRoot(0n, null)
        : await pages.readRootDescriptor(current.view.hotRoot);
    if (!root) throw new Error("Missing selected fixture root");
    const evidence = await auditStoredIdentityIndex(ledger, root, root.contentHash, (id) =>
      pages.read(id),
    );
    expect(evidence.identities).toBe(BigInt(current.view.hotCount));
    return { snapshot, current };
  }
  return {
    db,
    faults,
    port,
    canonical,
    ledger,
    control,
    pages,
    audit,
    maximumDepth: () => maximumDepth,
    commits: () => commits,
  };
}

test("real committed and rejected outcomes publish canonical records and exact derived roots in one transaction", async () => {
  const f = await fixture();
  try {
    await f.ledger.execute(activation());
    await f.audit();
    const sale = await f.ledger.execute(posting("sale"));
    expect(sale.result.disposition).toBe("committed");
    await f.audit();
    const rejected = await f.ledger.execute(posting("rejected", 2n, false));
    expect(rejected.result.disposition).toBe("rejected");
    const { snapshot, current } = await f.audit();
    expect(snapshot.head.sequence).toBe("3");
    expect(snapshot.head.bookRevision).toBe("2");
    expect(current.view.hotCount).toBe("7");
    expect(current.view.revision).toBe("3");
    const pageRows = f.db.query("SELECT * FROM ledger_index_pages ORDER BY location").all();
    const outcomeRows = f.db.query("SELECT * FROM ledger_outcomes ORDER BY sequence").all();
    let completed = 0;
    for (;;) {
      const batch = await f.pages.cleanupConstructions(f.control, 2);
      if (batch.pinId === null) break;
      if (batch.completed) completed++;
    }
    expect(completed).toBe(3);
    expect(
      f.db.query("SELECT count(*) AS count FROM ledger_index_construction_locations").get(),
    ).toEqual({ count: 0 });
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_reservations").get()).toEqual({
      count: 0,
    });
    expect(f.db.query("SELECT * FROM ledger_index_pages ORDER BY location").all()).toEqual(
      pageRows,
    );
    expect(f.db.query("SELECT * FROM ledger_outcomes ORDER BY sequence").all()).toEqual(
      outcomeRows,
    );
    expect(await f.audit()).toEqual({ snapshot, current });
    expect((await f.ledger.execute(posting("sale"))).originalResult).toEqual(sale.result);
    expect((await f.ledger.execute(posting("rejected", 2n, false))).originalResult).toEqual(
      rejected.result,
    );
    expect(f.commits()).toBe(3);
    expect(f.maximumDepth()).toBe(1);
  } finally {
    f.db.close();
  }
});

test("SQL faults after canonical or index writes roll back both authorities before retry", async () => {
  for (const sql of [
    "INSERT INTO ledger_outcomes",
    "INSERT INTO ledger_chunks",
    "UPDATE ledger_metadata SET head",
    "UPDATE ledger_index_control",
    "INSERT INTO ledger_index_construction_cleanup",
    "DELETE FROM ledger_index_pins",
    "DELETE FROM ledger_index_prepared_publications",
  ]) {
    const f = await fixture();
    try {
      await f.ledger.execute(activation());
      const before = await f.audit();
      f.faults.afterSql = sql;
      await expect(f.ledger.execute(posting("sale"))).rejects.toThrow(
        "injected publication SQL failure",
      );
      f.faults.afterSql = "";
      const recovered = await f.audit();
      expect(recovered.snapshot.head).toEqual(before.snapshot.head);
      expect(recovered.current.view).toEqual(before.current.view);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 1,
      });
      expect((await f.ledger.execute(posting("sale"))).result.disposition).toBe("committed");
      expect((await f.audit()).current.view.sequence).toBe("2");
      expect(f.maximumDepth()).toBe(1);
    } finally {
      f.db.close();
    }
  }
});

test("publication derives arbitrary committed and rejected identities from canonical payloads", async () => {
  const f = await fixture();
  try {
    await f.ledger.execute(activation());
    const accepted = await f.ledger.execute(posting("customer-β:receipt/2026"));
    expect(accepted.result.disposition).toBe("committed");
    const rejected = await f.ledger.execute(posting("supplier-γ:declined", 2n, false));
    expect(rejected.result.disposition).toBe("rejected");
    const { current } = await f.audit();
    expect(current.view.hotCount).toBe("7");
    expect(current.view.sequence).toBe("3");
    expect((await f.ledger.execute(posting("customer-β:receipt/2026"))).originalResult).toEqual(
      accepted.result,
    );
    expect(
      (await f.ledger.execute(posting("supplier-γ:declined", 2n, false))).originalResult,
    ).toEqual(rejected.result);
    expect(f.commits()).toBe(3);
  } finally {
    f.db.close();
  }
});

test("indexed publication of historical inventory resolves repeated lot identities to their original canonical outcome", async () => {
  const decoded = decodeDurableBook(
    (
      await Bun.file(
        new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
      ).text()
    ).trim(),
  );
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const original = decoded.aggregate;
  const config = original.state.configurationSnapshots[0];
  if (!config) throw new Error("Missing inventory configuration");
  const f = await fixture({
    state: createBookState(
      original.state.identity,
      config.periods,
      config.admissionSnapshot,
      config.policies,
      config.quantizationPolicies,
      config.accountingPolicySnapshot.policies,
      config.effectiveAt,
    ),
    protocol: createBookProtocolState(),
  });
  try {
    for (const retained of original.protocol.retainedResults) {
      expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
        retained.resultHash,
      );
      await f.audit();
    }
    const { current } = await f.audit();
    expect(current.view.hotCount).toBe("15");
    const root = await f.pages.readRootDescriptor(current.view.hotRoot);
    if (!root) throw new Error("Missing inventory root");
    for (const family of ["lot", "lotHolding"] as const) {
      const key = identityIndexKey({
        bookId: original.state.identity.bookId,
        family,
        id: "audit-lot-a",
      });
      expect(
        (await lookupIndexEntry(root, root.contentHash, key, (id) => f.pages.read(id))).sequence,
      ).toBe(2n);
    }
    for (const retained of original.protocol.retainedResults)
      expect((await f.ledger.execute(retained.command)).originalResult?.resultHash).toEqual(
        retained.resultHash,
      );
    expect((await f.audit()).current).toEqual(current);
  } finally {
    f.db.close();
  }
});

test("lost shared-publication confirmation returns no receipt and retry finds the exact original with no index reappend", async () => {
  const f = await fixture();
  try {
    await f.ledger.execute(activation());
    const before = await f.ledger.read();
    const original = executeBookCommand(
      before.aggregate.state,
      before.aggregate.protocol,
      posting("sale"),
    ).result;
    f.faults.losePublicationSync = true;
    await expect(f.ledger.execute(posting("sale"))).rejects.toThrow(
      "lost publication confirmation",
    );
    const after = await f.audit();
    expect(after.current.view.sequence).toBe("2");
    expect(after.current.view.revision).toBe("2");
    const retry = await f.ledger.execute(posting("sale"));
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.originalResult).toEqual(original);
    expect((await f.audit()).current.view).toEqual(after.current.view);
    expect(f.commits()).toBe(2);
  } finally {
    f.db.close();
  }
});

test("ProductionLedger awaits asynchronous preparation and publication before returning a receipt", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.ledger.execute(activation());
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.faults.beforePublication = async () => {
      entered();
      await gate;
    };
    let settled = false;
    const postingResult = f.ledger.execute(posting("sale")).then((receipt) => {
      settled = true;
      return receipt;
    });
    await waiting;
    expect(settled).toBe(false);
    expect((await f.control.readMetadata()).view.sequence).toBe("1");
    release();
    expect((await postingResult).outcomeSequence).toBe(2n);
    expect((await f.audit()).current.view.sequence).toBe("2");
  } finally {
    release?.();
    f.db.close();
  }
});

test("transaction tokens reject forged, copied, expired, foreign and nested use and roll back yielding callbacks", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    let saved!: SqliteTransaction;
    atomicSqlite(f.port, (token) => {
      saved = token;
      requireSqliteTransaction(token, f.port);
      expect(() => requireSqliteTransaction(token, other.port)).toThrow(
        "sqlite_transaction_not_active",
      );
      expect(() => requireSqliteTransaction({ ...token }, f.port)).toThrow(
        "sqlite_transaction_not_active",
      );
      expect(() => atomicSqlite(f.port, () => undefined)).toThrow(
        "sqlite_nested_transaction_forbidden",
      );
    });
    for (const token of [saved, {}, null])
      expect(() => requireSqliteTransaction(token as SqliteTransaction, f.port)).toThrow(
        "sqlite_transaction_not_active",
      );
    const before = f.db.query("SELECT head FROM ledger_metadata").get();
    expect(() =>
      atomicSqlite(f.port, () => {
        f.db.query("UPDATE ledger_metadata SET head = 'bad'").run();
        return Promise.resolve();
      }),
    ).toThrow("sqlite_async_transaction_forbidden");
    expect(f.db.query("SELECT head FROM ledger_metadata").get()).toEqual(before);
    expect(() =>
      atomicSqlite(f.port, () => {
        throw new Error("body failed");
      }),
    ).toThrow("body failed");
    expect(atomicSqlite(f.port, () => null)).toBeNull();
    expect(atomicSqlite(f.port, () => 7)).toBe(7);
    expect(atomicSqlite(f.port, () => ({ completed: true }))).toEqual({ completed: true });
  } finally {
    f.db.close();
    other.db.close();
  }
});

test("asynchronous canonical conflicts are awaited and retried without a duplicate publication", async () => {
  const f = await fixture();
  try {
    f.faults.beforePublication = async () => {
      f.faults.beforePublication = undefined;
      throw new LedgerError("ledger_head_conflict");
    };
    const receipt = await f.ledger.execute(activation());
    expect(receipt.result.disposition).toBe("committed");
    expect(receipt.outcomeSequence).toBe(1n);
    expect(f.commits()).toBe(2);
    expect((await f.audit()).current.view.revision).toBe("1");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({ count: 1 });
  } finally {
    f.db.close();
  }
});

test("a construction expiring after preparation cannot publish a real accounting outcome", async () => {
  const f = await fixture();
  try {
    f.faults.beforePublication = async () => {
      f.faults.now = 100n;
    };
    await expect(f.ledger.execute(activation())).rejects.toThrow("index_pin_expired");
    expect((await f.audit()).snapshot.head.sequence).toBe("0");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({ count: 0 });
    expect(
      f.db.query("SELECT count(*) AS count FROM ledger_index_prepared_publications").get(),
    ).toEqual({ count: 0 });
    f.faults.beforePublication = undefined;
    expect((await f.ledger.execute(activation())).result.disposition).toBe("committed");
    expect((await f.audit()).current.view.sequence).toBe("1");
  } finally {
    f.db.close();
  }
});

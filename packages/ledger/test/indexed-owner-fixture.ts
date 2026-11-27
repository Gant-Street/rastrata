import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { encodeDurableBook, type BookCommand, type DurableBookAggregate } from "@rastrata/kernel";
import {
  SqliteIndexedSourceCatalog,
  indexedSourceGenesisHash,
  type IndexedSourceAnchor,
} from "../src/indexed-source-catalog.ts";
import {
  INDEXED_BOOK_COLLECTIONS,
  prepareIndexedBookHead,
  projectLegacyIndexedBook,
} from "../src/indexed-book-state.ts";
import { prepareIndexedOutcomeRecord } from "../src/indexed-outcome-record.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { atomicSqlite } from "../src/sqlite-transaction.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import type { IndexedOutcomeSourceAuthority } from "../src/outcome-source.ts";
import { genesis } from "./fixtures.ts";
import {
  SqliteSemanticGroupCatalog,
  INDEXED_GROUP_CATALOG_FORMAT,
  type IndexedGroupCatalogFormat,
} from "../src/group-catalog.ts";
import { indexBookIdentityCommitment } from "../src/index-view-audit.ts";

function wireRows(encoded: string, collection: string): string[] {
  let node = JSON.parse(encoded).body;
  for (const name of collection.split(".")) {
    node = node[1].find(([key]: [string]) => key === name)?.[1];
    if (!node) return [];
  }
  return (collection === "state.openingBoundary" ? [node] : node[1]).map((value: unknown) =>
    JSON.stringify(value),
  );
}

/** Synthetic canonical owner harness with a real SQLite transaction. It is NOT
 * a production indexed adapter, admission reader, fence or crash-recovery proof. */
export async function createIndexedOwnerFixture(
  initial: DurableBookAggregate = genesis(),
  genesisFault = "",
  grouped = false,
  groupProfile: IndexedGroupCatalogFormat = INDEXED_GROUP_CATALOG_FORMAT,
) {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
  db.exec("CREATE TABLE test_canonical (singleton INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE test_outcome (sequence TEXT PRIMARY KEY, body TEXT NOT NULL, authority TEXT NOT NULL)",
  );
  const faults = {
    afterSql: genesisFault,
    syncs: 0,
    statements: [] as string[],
    confirms: 0,
    deny: false,
  };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        faults.statements.push(sql);
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const result = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (faults.afterSql && sql.startsWith(faults.afterSql))
          throw new Error("injected SQL failure");
        for (let i = 0; i < result.length; i++) {
          const row = result[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return result;
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    sync: async () => {
      faults.syncs++;
    },
  };
  const scope = {
    tenantId: "source-owner",
    bookId: initial.state.identity.bookId,
    objectId: "source-book-object",
    namespaceId: "source-book-namespace",
    generation: "0",
  };
  const readAnchor = (): IndexedSourceAnchor => {
    const row = db.query("SELECT body FROM test_canonical WHERE singleton = 1").get() as {
      body: string;
    } | null;
    if (!row) throw new Error("canonical genesis absent");
    return JSON.parse(row.body);
  };
  let catalog = new SqliteIndexedSourceCatalog(storage, scope, scope.objectId, readAnchor);
  const groupAnchor = () => ({
    identityHash: indexBookIdentityCommitment(scope),
    headHash: readAnchor().head.contentHash,
    sourceCatalogDigest: (
      db.query("SELECT digest FROM ledger_indexed_source_catalog").get() as { digest: string }
    ).digest,
  });
  let groups = grouped
    ? new SqliteSemanticGroupCatalog(
        storage,
        indexBookIdentityCommitment(scope),
        groupAnchor,
        groupProfile,
      )
    : undefined;
  let aggregate = initial;
  const genesisBytes = encodeDurableBook(initial),
    genesisHash = indexedSourceGenesisHash(genesisBytes);
  const first = await projectLegacyIndexedBook(genesisBytes);
  const firstAnchor = {
    state: first.state,
    head: prepareIndexedBookHead(scope, scope.objectId, first.state, null, null),
    genesisHash,
  };
  const preparedGenesis = await catalog.prepareGenesis(genesisBytes);
  const preparedGroupGenesis = await groups?.prepareIndexed(catalog, preparedGenesis, null, {
    confirm: async () => {
      if (faults.deny) throw new Error("owner pin revoked");
    },
    readPrevious: async () => {
      throw new Error("Genesis must not read old rows");
    },
  });
  const installGenesis = () =>
    atomicSqlite(storage, (transaction) => {
      storage.sql.exec("INSERT INTO test_canonical VALUES (1, ?)", JSON.stringify(firstAnchor));
      catalog.publishInTransaction(transaction, preparedGenesis);
      if (groups && preparedGroupGenesis)
        groups.publishInTransaction(transaction, preparedGroupGenesis);
    });
  let catalogDigest = preparedGenesis.digest;
  let groupDigest = preparedGroupGenesis?.digest;
  if (!genesisFault) installGenesis();
  async function prepare(command: BookCommand) {
    const before = readAnchor(),
      beforeBytes = JSON.stringify(before);
    const evaluated = evaluateOutcomePayload(aggregate, command);
    if (!evaluated.encoded) throw new Error("Expected retained command");
    const afterAggregate = {
      state: evaluated.transition.state,
      protocol: evaluated.transition.protocol,
    };
    const after = await projectLegacyIndexedBook(encodeDurableBook(afterAggregate));
    const record = prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      before.state,
      before.head,
      after.state,
      evaluated.encoded,
    );
    const encoded = JSON.stringify(record);
    const previous = evaluated.transition.intent
      ? (aggregate.state.revisions.at(-1) ?? null)
      : null;
    const prepared = await catalog.prepareOutcome(encoded, catalogDigest, previous);
    let preparedGroup:
      | Awaited<ReturnType<SqliteSemanticGroupCatalog["prepareIndexed"]>>
      | undefined;
    if (groups) {
      const capture = catalog.capture(catalogDigest);
      try {
        if (!groupDigest) throw new Error("Missing group anchor");
        preparedGroup = await groups.prepareIndexed(catalog, prepared, groupDigest, {
          confirm: ports.confirm,
          readPrevious: (collection, ordinal) => catalog.read(capture, collection, ordinal, ports),
        });
      } finally {
        catalog.release(capture);
      }
    }
    const authority: IndexedOutcomeSourceAuthority = {
      recordHash: record.contentHash,
      scope,
      actualObjectId: scope.objectId,
      beforeState: before.state,
      beforeHead: before.head,
    };
    return { record, encoded, prepared, preparedGroup, beforeBytes, afterAggregate, authority };
  }
  type Plan = Awaited<ReturnType<typeof prepare>>;
  function select(plan: Plan, afterCatalog?: () => void) {
    atomicSqlite(storage, (transaction) => {
      if (JSON.stringify(readAnchor()) !== plan.beforeBytes)
        throw new Error("canonical CAS conflict");
      storage.sql.exec(
        "INSERT INTO test_outcome VALUES (?, ?, ?)",
        plan.record.after.sequence,
        plan.encoded,
        JSON.stringify(plan.authority),
      );
      storage.sql.exec(
        "UPDATE test_canonical SET body = ? WHERE singleton = 1",
        JSON.stringify({
          genesisHash,
          state: JSON.parse(plan.record.state),
          head: plan.record.after,
        }),
      );
      catalog.publishInTransaction(transaction, plan.prepared);
      if (groups) {
        if (!plan.preparedGroup) throw new Error("Missing prepared group catalog");
        groups.publishInTransaction(transaction, plan.preparedGroup);
      }
      afterCatalog?.();
    });
    catalogDigest = plan.prepared.digest;
    groupDigest = plan.preparedGroup?.digest;
    aggregate = plan.afterAggregate;
  }
  async function publish(command: BookCommand) {
    const plan = await prepare(command);
    select(plan);
    return plan;
  }
  const reads: string[] = [];
  const ports = {
    async confirm() {
      faults.confirms++;
      if (faults.deny) throw new Error("owner pin revoked");
    },
    async genesis(hash: string) {
      reads.push("genesis");
      if (hash !== genesisHash) throw new Error("Wrong genesis");
      return genesisBytes;
    },
    async outcome(sequence: bigint, hash: string) {
      reads.push(sequence.toString());
      const row = db
        .query("SELECT body, authority FROM test_outcome WHERE sequence = ?")
        .get(sequence.toString()) as { body: string; authority: string } | null;
      if (!row) throw new Error("canonical source missing");
      const authority = JSON.parse(row.authority) as IndexedOutcomeSourceAuthority;
      if (authority.recordHash !== hash) throw new Error("canonical source mismatch");
      return { encoded: row.body, authority };
    },
  };
  async function verifyRows() {
    const capture = catalog.capture(catalogDigest),
      encoded = encodeDurableBook(aggregate);
    try {
      for (const collection of INDEXED_BOOK_COLLECTIONS) {
        const expected = wireRows(encoded, collection);
        for (const [index, row] of expected.entries()) {
          const found = await catalog.read(capture, collection, BigInt(index) + 1n, ports);
          expect(found.disposition).toBe("present");
          expect(found.encoded).toBe(row);
        }
        expect(
          (await catalog.read(capture, collection, BigInt(expected.length) + 1n, ports))
            .disposition,
        ).toBe("absent");
      }
    } finally {
      catalog.release(capture);
    }
  }
  function dump() {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name} ORDER BY 1`).all()]);
  }
  return {
    db,
    storage,
    faults,
    scope,
    reads,
    ports,
    prepare,
    select,
    publish,
    verifyRows,
    dump,
    installGenesis,
    readAnchor,
    groupAnchor,
    get groups() {
      if (!groups) throw new Error("Group mode not enabled");
      return groups;
    },
    get groupDigest() {
      if (!groupDigest) throw new Error("Group mode not enabled");
      return groupDigest;
    },
    get catalog() {
      return catalog;
    },
    get digest() {
      return catalogDigest;
    },
    get aggregate() {
      return aggregate;
    },
    restart() {
      catalog = new SqliteIndexedSourceCatalog(storage, scope, scope.objectId, readAnchor);
      if (grouped)
        groups = new SqliteSemanticGroupCatalog(
          storage,
          indexBookIdentityCommitment(scope),
          groupAnchor,
          groupProfile,
        );
    },
    close() {
      db.close();
    },
  };
}

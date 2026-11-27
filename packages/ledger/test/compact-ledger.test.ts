import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  decodeBookOutcome,
  encodeDurableBook,
  executeBookCommand,
  hashCanonical,
} from "@rastrata/kernel";
import {
  COMPACT_LEDGER_FORMAT,
  ProductionLedger,
  SqliteBookStorage,
  type CompleteBookScope,
  type SqliteStorage,
} from "../src/index.ts";
import { compactOutcomeRecord, completeScope } from "../src/compact-records.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

const scope: CompleteBookScope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "local-test",
  generation: "0",
};
function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
  const faults = { afterSql: "", syncCalls: 0, failSyncAt: -1 };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        let stmt = stmtCache.get(query);
        if (!stmt) {
          stmt = db.query(query);
          stmtCache.set(query, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (faults.afterSql && query.startsWith(faults.afterSql))
          throw new Error("Injected rollback");
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    async sync() {
      if (++faults.syncCalls === faults.failSyncAt) throw new Error("Uncertain durability");
    },
  };
  const storage = new SqliteBookStorage("object", port);
  const open = () => new ProductionLedger(storage, scope, COMPACT_LEDGER_FORMAT);
  return { db, faults, storage, open, ledger: open() };
}

test("compact SQL records recover exact original outcomes, protocol heads and historical cutoffs", async () => {
  const f = fixture();
  try {
    const start = await f.ledger.provision(genesis());
    expect(start.protocolHash).toMatch(/^[a-f0-9]{64}$/);
    expect(start.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    let expected = genesis();
    const receipts = [];
    for (const command of [activation(), posting("rejection", 1n, false), posting()]) {
      const next = executeBookCommand(expected.state, expected.protocol, command);
      expected = { state: next.state, protocol: next.protocol };
      const receipt = await f.ledger.execute(command);
      expect(receipt.result).toEqual(next.result);
      receipts.push(receipt);
    }
    const first = receipts[0],
      rejected = receipts[1];
    if (!first || !rejected) throw new Error("Missing receipts");
    expect(rejected.head.stateHash).toBe(first.head.stateHash);
    expect(rejected.head.revisionHash).toBe(first.head.revisionHash);
    expect(rejected.head.protocolHash).not.toBe(first.head.protocolHash);
    expect(rejected.head.chainHash).not.toBe(first.head.chainHash);
    const restored = await f.open().read();
    expect(restored.scope).toEqual(scope);
    expect(encodeDurableBook(restored.aggregate)).toBe(encodeDurableBook(expected));
    expect((await f.open().readAt(2n)).head).toEqual(rejected.head);
    const retry = await f.open().execute(posting("rejection", 1n, false));
    expect(retry.originalResult).toEqual(rejected.result);
    expect(retry.outcomeSequence).toBe(2n);
    expect(retry.result.disposition).toBe("replayed");
    const stored = f.storage.load(scope);
    if (!stored) throw new Error("Missing book");
    expect(stored.format).toBe(COMPACT_LEDGER_FORMAT);
    for (const record of stored.outcomes) {
      expect(decodeBookOutcome(record.body).disposition).toBe("decoded");
      expect(record.frame?.identity).toEqual(scope);
      expect(record.frame?.payloadBytes).toBe(
        new TextEncoder().encode(record.body).length.toString(),
      );
      expect(record.frame?.chunks[0]?.parentId).toBe(record.after.sequence);
    }
    await expect(
      new ProductionLedger(f.storage, {
        tenantId: "tenant",
        bookId: BOOK,
        objectId: "object",
      }).read(),
    ).rejects.toThrow();
    await expect(
      new ProductionLedger(f.storage, { ...scope, generation: "1" }, COMPACT_LEDGER_FORMAT).read(),
    ).rejects.toThrow("ledger_identity_mismatch");
    await expect(
      new ProductionLedger(
        f.storage,
        { ...scope, namespaceId: "other" },
        COMPACT_LEDGER_FORMAT,
      ).read(),
    ).rejects.toThrow("ledger_identity_mismatch");
  } finally {
    f.db.close();
  }
});

test("compact provisioning requires complete immutable own-data identity and never upgrades legacy storage", async () => {
  const f = fixture();
  try {
    for (const malformed of [
      { ...scope, generation: "00" },
      { ...scope, generation: "-1" },
      { ...scope, extra: true },
      { tenantId: "tenant", bookId: BOOK, objectId: "object" },
    ])
      expect(() => new ProductionLedger(f.storage, malformed, COMPACT_LEDGER_FORMAT)).toThrow(
        "ledger_identity_mismatch",
      );
    let invoked = false;
    expect(() =>
      completeScope(
        {
          ...scope,
          get generation() {
            invoked = true;
            return "0";
          },
        },
        "object",
      ),
    ).toThrow("ledger_identity_mismatch");
    expect(invoked).toBe(false);
    const legacy = new ProductionLedger(f.storage, {
      tenantId: "tenant",
      bookId: BOOK,
      objectId: "object",
    });
    await legacy.provision(genesis());
    const before = f.db.query("SELECT * FROM ledger_metadata").get();
    await expect(f.ledger.provision(genesis())).rejects.toThrow();
    expect(f.db.query("SELECT * FROM ledger_metadata").get()).toEqual(before);
    expect((await legacy.read()).head.sequence).toBe("0");
  } finally {
    f.db.close();
  }
});

test("compact recovery rejects altered complete heads, identity, format and ordered chunk manifests", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const row = f.db.query("SELECT header FROM ledger_outcomes WHERE sequence = '1'").get() as {
      header: string;
    };
    type MutableHeader = {
      after: Record<string, string>;
      frame: {
        identity: Record<string, string>;
        format: Record<string, string>;
        commandHash: string;
        chunkCount: string;
        payloadBytes: string;
        chunks: [Record<string, string>];
      };
    };
    const changes: ((header: MutableHeader) => void)[] = [
      (h) => {
        h.after.protocolHash = hashCanonical("forged").digest;
      },
      (h) => {
        h.after.revisionHash = hashCanonical("forged").digest;
      },
      (h) => {
        h.frame.identity.generation = "1";
      },
      (h) => {
        h.frame.identity.namespaceId = "other";
      },
      (h) => {
        h.frame.format.kernelSemanticVersion = "1.0.0";
      },
      (h) => {
        h.frame.commandHash = hashCanonical("forged").digest;
      },
      (h) => {
        h.frame.chunkCount = "2";
      },
      (h) => {
        h.frame.payloadBytes = "1";
      },
      (h) => {
        h.frame.chunks[0].ordinal = "1";
      },
      (h) => {
        h.frame.chunks[0].parentId = "2";
      },
      (h) => {
        h.frame.chunks[0].byteCount = "1";
      },
      (h) => {
        h.frame.chunks[0].digest = hashCanonical("forged").digest;
      },
      (h) => {
        Reflect.deleteProperty(h, "frame");
      },
    ];
    for (const change of changes) {
      const header = JSON.parse(row.header);
      change(header);
      f.db
        .query("UPDATE ledger_outcomes SET header = ? WHERE sequence = '1'")
        .run(JSON.stringify(header));
      await expect(f.open().read()).rejects.toThrow("recovery_record_corrupt");
    }
    f.db
      .query("UPDATE ledger_outcomes SET header = ? WHERE sequence = '1'")
      .run(row.header.replace("{", '{"commandId":"ignored",'));
    await expect(f.open().read()).rejects.toThrow("recovery_record_corrupt");
    f.db.query("UPDATE ledger_outcomes SET header = ? WHERE sequence = '1'").run(row.header);
    expect((await f.open().read()).head.sequence).toBe("1");
  } finally {
    f.db.close();
  }
});

for (const sql of [
  "INSERT INTO ledger_outcomes",
  "INSERT INTO ledger_chunks",
  "UPDATE ledger_metadata",
])
  test(`compact atomic rollback after ${sql}`, async () => {
    const f = fixture();
    try {
      await f.ledger.provision(genesis());
      const before = await f.ledger.read();
      f.faults.afterSql = sql;
      await expect(f.ledger.execute(activation())).rejects.toThrow("Injected rollback");
      f.faults.afterSql = "";
      expect((await f.open().read()).head).toEqual(before.head);
      expect((await f.open().execute(activation())).result.disposition).toBe("committed");
    } finally {
      f.db.close();
    }
  });

test("compact uncertain acknowledgement retries exactly and detects a removed rejection suffix", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    f.faults.failSyncAt = f.faults.syncCalls + 2;
    await expect(f.ledger.execute(activation())).rejects.toThrow("Uncertain durability");
    const retried = await f.open().execute(activation());
    expect(retried.outcomeSequence).toBe(1n);
    expect(retried.result.disposition).toBe("replayed");
    expect(retried.originalResult?.disposition).toBe("committed");
    await f.ledger.execute(posting("rejected", 1n, false));
    f.db.query("DELETE FROM ledger_chunks WHERE record_id = '2'").run();
    f.db.query("DELETE FROM ledger_outcomes WHERE sequence = '2'").run();
    await expect(f.open().readAt(1n)).rejects.toThrow("recovery_head_mismatch");
  } finally {
    f.db.close();
  }
});

test("compact full-head CAS retries after a competing retained rejection", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const before = await f.ledger.read();
    const other = evaluateOutcomePayload(before.aggregate, posting("other", 0n));
    if (!other.encoded) throw new Error("Missing competing rejection");
    const record = compactOutcomeRecord(scope, before.head, other.transition, other.encoded);
    let attempts = 0;
    const interleaved = new ProductionLedger(
      {
        objectId: f.storage.objectId,
        load: f.storage.load.bind(f.storage),
        provision: f.storage.provision.bind(f.storage),
        sync: f.storage.sync.bind(f.storage),
        commitTransition(expected, outcome) {
          if (attempts++ === 0) f.storage.commitTransition(before.head, record);
          f.storage.commitTransition(expected, outcome);
        },
      },
      scope,
      COMPACT_LEDGER_FORMAT,
    );
    const receipt = await interleaved.execute(posting("mine", 0n));
    expect(attempts).toBe(2);
    expect(receipt.outcomeSequence).toBe(3n);
    expect(receipt.result.disposition).toBe("rejected");
    expect(receipt.head.bookRevision).toBe("1");
    expect((await f.open().read()).head).toEqual(receipt.head);
  } finally {
    f.db.close();
  }
});

test("compact UTF-8 payloads span authenticated chunks and detect a missing chunk", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const command = posting("large-narration", 1n, true, "€".repeat(50_000));
    expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
    const record = f.storage.load(scope)?.outcomes[1];
    expect(BigInt(record?.frame?.chunkCount ?? "0")).toBeGreaterThan(1n);
    expect((await f.open().execute(command)).result.disposition).toBe("replayed");
    f.db.query("DELETE FROM ledger_chunks WHERE record_id = '2' AND ordinal = 1").run();
    await expect(f.open().read()).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

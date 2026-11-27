import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  closePackageId,
  commandId,
  createBookProtocolState,
  createBookState,
  decodeDurableBook,
  effectKey,
  hashCanonical,
  instant,
  inventoryValueAdjustmentId,
  localDate,
  fiscalPeriodId,
  sealCommand,
  semanticVersion,
  INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
} from "@rastrata/kernel";
import { ProductionLedger, SqliteBookStorage, type SqliteStorage } from "../src/index.ts";
import {
  auditIdentityEntries,
  readCanonicalIdentityPopulation,
  type CanonicalIdentity,
  type IdentityFamily,
} from "../src/identity-audit.ts";
import { activation, BOOK, genesis, posting } from "./fixtures.ts";
import {
  auditStoredIdentityIndex,
  createIndexRoot,
  encodeIndexPage,
  identityIndexKey,
  type IndexEntry,
} from "../src/index-pages.ts";

function fixture(bookId: string = BOOK) {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
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
    transactionSync: (fn) => db.transaction(fn)(),
    async sync() {},
  };
  const storage = new SqliteBookStorage("identity-audit-object", port);
  const ledger = new ProductionLedger(storage, {
    tenantId: "identity-audit-tenant",
    bookId,
    objectId: storage.objectId,
  });
  return { db, ledger };
}
const row = (
  family: IdentityFamily,
  id: string,
  outcomeSequence: bigint,
  bookId: string = BOOK,
): CanonicalIdentity => ({ bookId, family, id, outcomeSequence });
const sort = (rows: readonly CanonicalIdentity[]) =>
  [...rows].sort((a, b) => {
    const left = JSON.stringify([a.family, a.id]),
      right = JSON.stringify([b.family, b.id]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
const basic = [
  row("command", "activate", 1n),
  row("openingBoundary", "opening", 1n),
  row("command", "same:id/α", 2n),
  row("journal", "same:id/α", 2n),
  row("posting", "same:id/α-0", 2n),
  row("posting", "same:id/α-1", 2n),
  row("command", "rejected", 3n),
];
function storedIndex(
  entries: readonly CanonicalIdentity[],
  changed?: (rows: IndexEntry[]) => void,
) {
  const rows = entries.map((entry) => ({
    key: identityIndexKey(entry),
    sequence: entry.outcomeSequence,
  }));
  changed?.(rows);
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const left = encodeIndexPage(`derived/${"1".repeat(64)}`, rows.slice(0, 3));
  const right = encodeIndexPage(`derived/${"2".repeat(64)}`, rows.slice(3));
  const parent = encodeIndexPage(
    `derived/${"3".repeat(64)}`,
    [],
    [left.descriptor, right.descriptor],
  );
  const pages = new Map(
    [left, right, parent].map((page) => [page.descriptor.page.location, page.bytes]),
  );
  const root = createIndexRoot(BigInt(rows.length), parent.descriptor.page);
  return { root, pages };
}

test("stored index audit binds authenticated page entries to real canonical IDs and creation Oseq", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    const good = storedIndex(basic);
    const report = await auditStoredIdentityIndex(
      f.ledger,
      good.root,
      good.root.contentHash,
      async (id) => good.pages.get(id),
    );
    expect(report).toMatchObject({
      identities: 7n,
      exactEntriesVerified: true,
      pageIntegrityVerified: true,
      rootHash: good.root.contentHash,
    });
    expect(report.head.sequence).toBe("3");
    expect(report.populationHash).toEqual(
      (await readCanonicalIdentityPopulation(f.ledger)).populationHash,
    );
    for (const mutate of [
      (rows: IndexEntry[]) => {
        rows[0] = { key: "0".repeat(64), sequence: 1n };
      },
      (rows: IndexEntry[]) => {
        rows[0] = { key: identityIndexKey(basic[0] as CanonicalIdentity), sequence: 2n };
      },
    ]) {
      const wrong = storedIndex(basic, mutate);
      await expect(
        auditStoredIdentityIndex(f.ledger, wrong.root, wrong.root.contentHash, async (id) =>
          wrong.pages.get(id),
        ),
      ).rejects.toThrow("index_identity_mismatch");
    }
    const omitted = storedIndex(basic.slice(0, -1));
    let reads = 0;
    await expect(
      auditStoredIdentityIndex(f.ledger, omitted.root, omitted.root.contentHash, async (id) => {
        reads++;
        return omitted.pages.get(id);
      }),
    ).rejects.toThrow("index_identity_population_incomplete");
    expect(reads).toBe(0);
    good.pages.delete(`derived/${"2".repeat(64)}`);
    await expect(
      auditStoredIdentityIndex(f.ledger, good.root, good.root.contentHash, async (id) =>
        good.pages.get(id),
      ),
    ).rejects.toThrow("index_page_missing_or_short");
    expect((await f.ledger.read()).head.sequence).toBe("3");
  } finally {
    f.db.close();
  }
});

test("stored index audit keeps its real canonical cutoff during page I/O and rejects the old population at the new head", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    const index = storedIndex(basic);
    let advanced = false;
    const report = await auditStoredIdentityIndex(
      f.ledger,
      index.root,
      index.root.contentHash,
      async (id) => {
        if (!advanced) {
          advanced = true;
          expect((await f.ledger.execute(posting("during-page-io", 2n))).result.disposition).toBe(
            "committed",
          );
        }
        return index.pages.get(id);
      },
    );
    expect(report.head.sequence).toBe("3");
    expect((await f.ledger.read()).head.sequence).toBe("4");
    await expect(
      auditStoredIdentityIndex(f.ledger, index.root, index.root.contentHash, async (id) =>
        index.pages.get(id),
      ),
    ).rejects.toThrow("index_identity_population_incomplete");
  } finally {
    f.db.close();
  }
});
async function populate(ledger: ProductionLedger) {
  await ledger.provision(genesis());
  expect((await ledger.execute(activation())).result.disposition).toBe("committed");
  expect((await ledger.execute(posting("same:id/α"))).result.disposition).toBe("committed");
  expect((await ledger.execute(posting("rejected", 2n, false))).result.disposition).toBe(
    "rejected",
  );
}

test("canonical identity population preserves raw IDs, namespaces, rejected IDs and retry Oseq", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    const before = await readCanonicalIdentityPopulation(f.ledger);
    expect(before.entries).toEqual(sort(basic));
    expect(before.populationHash).toEqual(
      hashCanonical({
        domain: "rastrata-canonical-identity-audit-v1",
        bookId: BOOK,
        head: { ...before.head },
        entries: sort(basic).map((entry) => ({ ...entry })),
      }),
    );
    expect((await f.ledger.execute(posting("same:id/α"))).result.disposition).toBe("replayed");
    expect(await readCanonicalIdentityPopulation(f.ledger)).toEqual(before);
    const report = await auditIdentityEntries(f.ledger, () => [...basic].reverse());
    expect(report).toMatchObject({
      bookId: BOOK,
      identities: 7n,
      exactEntriesVerified: true,
      pageIntegrityVerified: false,
    });
    expect(report.head).toEqual(before.head);
    expect(report.populationHash).toEqual(before.populationHash);
    expect(Object.isFrozen(before.entries)).toBe(true);
    expect(before.entries.every(Object.isFrozen)).toBe(true);
  } finally {
    f.db.close();
  }
});

test("equal counts do not excuse substituted identity, wrong family, book or first-seen locator", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    for (const changed of [
      row("command", "invented", 3n),
      row("journal", "rejected", 3n),
      row("command", "rejected", 2n),
      row("command", "rejected", 3n, "other-book"),
    ]) {
      await expect(
        auditIdentityEntries(f.ledger, () => [...basic.slice(0, -1), changed]),
      ).rejects.toThrow("index_identity_mismatch");
    }
    await expect(auditIdentityEntries(f.ledger, () => basic.slice(0, -1))).rejects.toThrow(
      "index_identity_population_incomplete",
    );
    await expect(
      auditIdentityEntries(f.ledger, () => [...basic, basic[0] as CanonicalIdentity]),
    ).rejects.toThrow("index_identity_duplicate");
    await expect(
      auditIdentityEntries(f.ledger, () => [...basic, row("command", "extra", 4n)]),
    ).rejects.toThrow("index_identity_mismatch");
  } finally {
    f.db.close();
  }
});

test("malformed index entries and accessors fail closed without evaluating getters", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    let getterCalls = 0;
    const accessor = {
      ...basic[0],
      get id() {
        getterCalls++;
        throw new Error("getter must not run");
      },
    };
    const malformed: unknown[] = [
      null,
      "activate",
      {},
      { ...basic[0], extra: true },
      { ...basic[0], [Symbol("extra")]: true },
      { ...basic[0], family: 1 },
      { ...basic[0], id: 1 },
      { ...basic[0], outcomeSequence: "1" },
      accessor,
    ];
    for (const input of malformed) {
      // Intentionally cross the typed boundary to test corrupt decoder output.
      await expect(
        auditIdentityEntries(f.ledger, () => [input as CanonicalIdentity, ...basic.slice(1)]),
      ).rejects.toThrow("index_identity_entry_invalid");
    }
    expect(getterCalls).toBe(0);
    expect((await f.ledger.read()).head.sequence).toBe("3");
  } finally {
    f.db.close();
  }
});

test("audit stays pinned when a newer real accounting command commits during enumeration", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    const report = await auditIdentityEntries(f.ledger, async function* (cutoff) {
      expect(cutoff.head.sequence).toBe("3");
      yield basic[0] as CanonicalIdentity;
      expect((await f.ledger.execute(posting("later", 2n))).result.disposition).toBe("committed");
      yield* basic.slice(1);
    });
    expect(report.head.sequence).toBe("3");
    expect(report.identities).toBe(7n);
    expect((await f.ledger.read()).head.sequence).toBe("4");
    await expect(auditIdentityEntries(f.ledger, () => basic)).rejects.toThrow(
      "index_identity_population_incomplete",
    );
  } finally {
    f.db.close();
  }
});

test("enumeration failure cannot become a successful or retained accounting result", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    const before = (await f.ledger.read()).head;
    await expect(
      auditIdentityEntries(f.ledger, async function* () {
        yield basic[0] as CanonicalIdentity;
        throw new Error("index page unavailable");
      }),
    ).rejects.toThrow("index page unavailable");
    expect((await f.ledger.read()).head).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("corrupt canonical history is rejected before index enumeration begins", async () => {
  const f = fixture();
  try {
    await populate(f.ledger);
    // Removed retained rejection with metadata/chunks still present: a real source gap.
    f.db.query("DELETE FROM ledger_outcomes WHERE sequence = ?").run("3");
    let enumerated = false;
    await expect(
      auditIdentityEntries(f.ledger, () => {
        enumerated = true;
        return basic;
      }),
    ).rejects.toThrow();
    expect(enumerated).toBe(false);
  } finally {
    f.db.close();
  }
});

test("empty genesis and close/reopen retain exact close-package identity after supersession", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    expect((await auditIdentityEntries(f.ledger, () => [])).identities).toBe(0n);
    await populate(f.ledger);
    const at = instant("2026-02-01T00:00:00Z");
    const close = sealCommand({
      id: commandId("close"),
      type: "closePeriod",
      protocolVersion: semanticVersion("1.0.0"),
      bookId: BOOK,
      actorId: activation().actorId,
      expectedBookRevision: 2n,
      issuedAt: at,
      completedAt: at,
      committedAt: at,
      periodId: fiscalPeriodId("january"),
      closePackageId: closePackageId("closed-january"),
      reason: "Reviewed January",
      reportPopulationHash: hashCanonical("report"),
      reportingPolicySnapshotHash: hashCanonical("report-policy"),
    });
    expect((await f.ledger.execute(close)).result.disposition).toBe("committed");
    const reopenAt = instant("2026-02-02T00:00:00Z");
    expect(
      (
        await f.ledger.execute(
          sealCommand({
            id: commandId("reopen"),
            type: "reopenPeriod",
            protocolVersion: semanticVersion("1.0.0"),
            bookId: BOOK,
            actorId: activation().actorId,
            expectedBookRevision: 3n,
            issuedAt: reopenAt,
            completedAt: reopenAt,
            committedAt: reopenAt,
            periodId: fiscalPeriodId("january"),
            reason: "Correction required",
          }),
        )
      ).result.disposition,
    ).toBe("committed");
    const expected = [
      ...basic,
      row("command", "close", 4n),
      row("closePackage", "closed-january", 4n),
      row("command", "reopen", 5n),
    ];
    expect((await readCanonicalIdentityPopulation(f.ledger)).entries).toEqual(sort(expected));
    expect((await auditIdentityEntries(f.ledger, () => expected)).identities).toBe(10n);
  } finally {
    f.db.close();
  }
});

test("legacy lot snapshots retain creation locators through versioned policy replacement and adjustment", async () => {
  const decoded = decodeDurableBook(
    (
      await Bun.file(
        new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
      ).text()
    ).trim(),
  );
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const legacy = decoded.aggregate;
  const config = legacy.state.configurationSnapshots[0];
  const original = legacy.protocol.retainedResults[3];
  if (!config || original?.command.type !== "adjustInventoryValue")
    throw new Error("invalid fixture");
  const policy = config.accountingPolicySnapshot.policies.find(
    (p) => p.kind === "inventoryValueAdjustment",
  );
  if (policy?.kind !== "inventoryValueAdjustment") throw new Error("missing fixture policy");
  const f = fixture(legacy.state.identity.bookId);
  try {
    await f.ledger.provision({
      state: createBookState(
        legacy.state.identity,
        config.periods,
        config.admissionSnapshot,
        config.policies,
        config.quantizationPolicies,
        config.accountingPolicySnapshot.policies,
        config.effectiveAt,
      ),
      protocol: createBookProtocolState(),
    });
    for (const retained of legacy.protocol.retainedResults)
      expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
        retained.resultHash,
      );
    const expected = [
      row("command", "audit-activate", 1n, "book-main"),
      row("openingBoundary", "opening-main", 1n, "book-main"),
      row("command", "audit-value", 4n, "book-main"),
    ];
    for (const [id, sequence] of [
      ["audit-lot-a", 2n],
      ["audit-lot-b", 3n],
    ] as const) {
      for (const family of ["command", "journal", "lot", "lotHolding"] as const)
        expected.push(row(family, id, sequence, "book-main"));
      expected.push(
        row("posting", `${id}-debit`, sequence, "book-main"),
        row("posting", `${id}-credit`, sequence, "book-main"),
      );
    }
    expect((await readCanonicalIdentityPopulation(f.ledger)).entries).toEqual(sort(expected));
    const at = instant("2026-01-16T14:00:00Z"),
      version = semanticVersion("1.0.1");
    const updated = {
      ...policy,
      version,
      validFrom: instant("2026-01-16T00:00:00Z"),
      algorithmVersion: INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
      capability: {
        ...policy.capability,
        implementationVersion: INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
      },
    };
    expect(
      (
        await f.ledger.execute(
          sealCommand({
            id: commandId("identity-policy-upgrade"),
            type: "replaceConfiguration",
            protocolVersion: semanticVersion("1.0.0"),
            bookId: legacy.state.identity.bookId,
            actorId: original.command.actorId,
            expectedBookRevision: 3n,
            expectedConfigurationRevision: 0n,
            issuedAt: at,
            completedAt: at,
            committedAt: at,
            effectiveOn: localDate("2026-01-16"),
            periods: config.periods,
            admissionSnapshot: config.admissionSnapshot,
            policies: config.policies,
            quantizationPolicies: config.quantizationPolicies,
            accountingPolicies: config.accountingPolicySnapshot.policies.map((p) =>
              p === policy ? updated : p,
            ),
          }),
        )
      ).result.disposition,
    ).toBe("committed");
    expect(
      (
        await f.ledger.execute(
          sealCommand({
            ...original.command,
            id: commandId("identity-value-fixed"),
            expectedBookRevision: 4n,
            issuedAt: at,
            completedAt: at,
            committedAt: at,
            request: {
              ...original.command.request,
              id: inventoryValueAdjustmentId("identity-value-fixed"),
              generatedEffectKey: effectKey("identity-value-fixed:journal:0"),
              policyVersion: version,
              policyEffectiveAt: instant("2026-01-16T00:00:00Z"),
              effectiveOn: localDate("2026-01-16"),
              derivation: { ...original.command.request.derivation, policyVersion: version },
            },
          }),
        )
      ).result.disposition,
    ).toBe("committed");
    const actual = await readCanonicalIdentityPopulation(f.ledger);
    expect(actual.entries).toHaveLength(21);
    for (const entry of expected) expect(actual.entries).toContainEqual(entry);
    expect(actual.entries).toContainEqual(
      row("inventoryValueAdjustment", "identity-value-fixed", 6n, "book-main"),
    );
    expect(actual.entries).toContainEqual(
      row("command", "identity-policy-upgrade", 5n, "book-main"),
    );
    const moved = actual.entries.map((entry) =>
      entry.family === "lotHolding" && entry.id === "audit-lot-a"
        ? { ...entry, outcomeSequence: 6n }
        : entry,
    );
    await expect(auditIdentityEntries(f.ledger, () => moved)).rejects.toThrow(
      "index_identity_mismatch",
    );
    expect((await f.ledger.execute(original.command)).result.resultHash).toEqual(
      original.resultHash,
    );
    expect(await readCanonicalIdentityPopulation(f.ledger)).toEqual(actual);
  } finally {
    f.db.close();
  }
});

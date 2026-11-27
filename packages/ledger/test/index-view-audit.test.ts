import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hashCanonical } from "@rastrata/kernel";
import {
  COMPACT_LEDGER_FORMAT,
  LEDGER_FORMAT,
  ProductionLedger,
  SqliteBookStorage,
  type SqliteStorage,
} from "../src/index.ts";
import { SqliteIndexControl, type IndexAnchor } from "../src/index-control.ts";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import {
  createIndexRoot,
  encodeIndexPage,
  identityIndexKey,
  INDEX_KEY_SCHEMA,
} from "../src/index-pages.ts";
import {
  auditPinnedIdentityView,
  openAuditedIndexReader,
  indexBookIdentityCommitment,
  snapshotIndexHeadCommitment,
  ledgerIndexHeadCommitment,
  type IndexBookIdentity,
} from "../src/index-view-audit.ts";
import type { CanonicalIdentity } from "../src/identity-audit.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

const owner: IndexBookIdentity = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "namespace",
  generation: "0",
};
const all: CanonicalIdentity[] = [
  { bookId: BOOK, family: "command", id: "activate", outcomeSequence: 1n },
  { bookId: BOOK, family: "openingBoundary", id: "opening", outcomeSequence: 1n },
  ...(["command", "journal"] as const).map((family) => ({
    bookId: BOOK,
    family,
    id: "sale",
    outcomeSequence: 2n,
  })),
  ...[0, 1].map((ordinal) => ({
    bookId: BOOK,
    family: "posting" as const,
    id: `sale-${ordinal}`,
    outcomeSequence: 2n,
  })),
  { bookId: BOOK, family: "command", id: "rejected", outcomeSequence: 3n },
];

test("derived identity/head commitments bind every field and the snapshot format domain", () => {
  const head = {
    sequence: "3",
    chainHash: "a".repeat(64),
    stateHash: "b".repeat(64),
    bookRevision: "2",
    postingSequence: "1",
    configurationRevision: "0",
    configurationHash: "c".repeat(64),
  };
  const digest = snapshotIndexHeadCommitment(head);
  expect(digest).toBe(
    hashCanonical({ domain: "rastrata-ledger-snapshot-v1/index-head-v1", ...head }).digest,
  );
  for (const field of Object.keys(head) as (keyof typeof head)[]) {
    const changed = field.endsWith("Hash") ? "d".repeat(64) : String(BigInt(head[field]) + 1n);
    expect(snapshotIndexHeadCommitment({ ...head, [field]: changed })).not.toBe(digest);
  }
  const identity = indexBookIdentityCommitment(owner);
  for (const field of Object.keys(owner) as (keyof IndexBookIdentity)[]) {
    expect(
      indexBookIdentityCommitment({ ...owner, [field]: field === "generation" ? "1" : "other" }),
    ).not.toBe(identity);
  }
});
async function fixture(
  options: {
    identity?: IndexBookIdentity;
    empty?: boolean;
    compact?: boolean;
    fakeHead?: boolean;
    partitions?: (
      cold: CanonicalIdentity[],
      hot: CanonicalIdentity[],
    ) => [CanonicalIdentity[], CanonicalIdentity[]];
  } = {},
) {
  const db = new Database(":memory:");
  const hooks = {
    now: 10n,
    onPageRead: undefined as (() => void) | undefined,
    onSync: undefined as (() => Promise<void>) | undefined,
  };
  const port: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
        if (query.includes("FROM ledger_index_pages WHERE")) hooks.onPageRead?.();
        return rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                : value,
            ]),
          ),
        );
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    async sync() {
      await hooks.onSync?.();
    },
  };
  const identity = options.identity ?? owner;
  const format = options.compact ? COMPACT_LEDGER_FORMAT : LEDGER_FORMAT;
  const storedScope = {
    tenantId: "tenant",
    bookId: BOOK,
    objectId: "object",
  };
  const ledger = new ProductionLedger(
    new SqliteBookStorage("object", port),
    options.compact
      ? { ...storedScope, namespaceId: owner.namespaceId, generation: owner.generation }
      : storedScope,
    format,
  );
  const genesisHead = await ledger.provision(genesis());
  db.exec("CREATE TABLE test_index_anchor (singleton INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const initial: IndexAnchor = {
    identityHash: indexBookIdentityCommitment(identity),
    headHash: ledgerIndexHeadCommitment(genesisHead, format),
    sequence: "0",
    fence: "0",
    provisioning: true,
    pending: false,
  };
  db.query("INSERT INTO test_index_anchor VALUES (1, ?)").run(JSON.stringify(initial));
  const anchor = () =>
    JSON.parse(
      (db.query("SELECT body FROM test_index_anchor").get() as { body: string }).body,
    ) as IndexAnchor;
  const writeAnchor = (next: IndexAnchor) => {
    db.query("UPDATE test_index_anchor SET body = ?").run(JSON.stringify(next));
  };
  const control = new SqliteIndexControl(port, anchor, () => hooks.now);
  let current = await control.initialize(INDEX_KEY_SCHEMA);
  writeAnchor({ ...anchor(), provisioning: false });
  const pages = new SqliteIndexPageStore(port, initial.identityHash);
  await pages.initialize();
  let location = 0;
  async function stage(entries: readonly CanonicalIdentity[]) {
    if (!entries.length) return createIndexRoot(0n, null);
    const rows = entries
      .map((entry) => ({ key: identityIndexKey(entry), sequence: entry.outcomeSequence }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const page = encodeIndexPage(`derived/${(++location).toString(16).padStart(64, "0")}`, rows);
    const root = createIndexRoot(BigInt(rows.length), page.descriptor.page);
    await pages.put(page.descriptor.page, page.bytes);
    await pages.retainRoot(root, root.contentHash);
    return root;
  }
  if (!options.empty) {
    // Index-maintenance fixture follows ALREADY committed real commands. Its
    // shadow anchor is not an atomic posting adapter; the audit must independently
    // verify each requested cutoff/head against the real ledger, not this table.
    for (const [i, command] of [
      activation(),
      posting("sale"),
      posting("rejected", 2n, false),
    ].entries()) {
      const receipt = await ledger.execute(command);
      expect(receipt.result.disposition).toBe(i === 2 ? "rejected" : "committed");
      const hot = await stage(all.filter((entry) => entry.outcomeSequence <= BigInt(i + 1)));
      const next = {
        ...anchor(),
        sequence: receipt.head.sequence,
        headHash:
          options.fakeHead && i === 2
            ? hashCanonical("forged-head").digest
            : ledgerIndexHeadCommitment(receipt.head, format),
      };
      current = await control.append(current.view, next, hot.contentHash, hot.population, () => {
        writeAnchor(next);
        return undefined;
      });
      if (i === 0) current = await control.freeze(current.view, "first-prefix");
    }
    const parts = options.partitions?.(all.slice(0, 2), all.slice(2)) ?? [
      all.slice(0, 2),
      all.slice(2),
    ];
    const cold = await stage(parts[0]),
      hot = await stage(parts[1]);
    if (!current.frozen) throw new Error("Missing fixture prefix");
    current = await control.install(
      current.view,
      current.frozen,
      cold.contentHash,
      hot.contentHash,
      "5",
    );
  }
  const pin = await control.pinCurrent(current.view, "reader", "100");
  return {
    db,
    ledger,
    control,
    pages,
    identity,
    pin,
    hooks,
    stage,
    audit: () =>
      auditPinnedIdentityView(ledger, control, identity, pin, { cold: pages, hot: pages }),
    openReader: () =>
      openAuditedIndexReader(ledger, control, identity, pin, { cold: pages, hot: pages }),
  };
}

test("an audited pinned reader finds original cold/hot locators without repeating the full source audit", async () => {
  for (const compact of [false, true]) {
    const f = await fixture({ compact });
    try {
      const reader = await f.openReader();
      let sourceReads = 0;
      const originalReadAt = f.ledger.readAt.bind(f.ledger);
      f.ledger.readAt = async (sequence) => {
        sourceReads++;
        return originalReadAt(sequence);
      };
      for (const entry of all) {
        const result = await reader.lookupKey(identityIndexKey(entry));
        expect(result.sequence).toBe(entry.outcomeSequence);
        expect(result.pin).toEqual(f.pin);
        expect(result.pagesRead).toBe(2);
      }
      const absent = identityIndexKey({ bookId: BOOK, family: "command", id: "never-issued" });
      expect((await reader.lookupKey(absent)).sequence).toBeNull();
      expect(sourceReads).toBe(0);
      await expect(reader.lookupKey("bad")).rejects.toThrow("index_page_digest_invalid");
      await f.control.releasePin(f.pin);
      await expect(reader.lookupKey(absent)).rejects.toThrow("index_pin_not_active");
    } finally {
      f.db.close();
    }
  }
  const empty = await fixture({ empty: true });
  try {
    const reader = await empty.openReader();
    const result = await reader.lookupKey("0".repeat(64));
    expect(result.sequence).toBeNull();
    expect(result.pagesRead).toBe(0);
    expect(result.bytesRead).toBe(0);
  } finally {
    empty.db.close();
  }
});

test("pinned range scans merge exact hot/cold populations and reject continuation after release or expiry", async () => {
  for (const compact of [false, true]) {
    const f = await fixture({ compact });
    try {
      const reader = await f.openReader();
      f.ledger.readAt = async () => {
        throw new Error("Range must not repeat full source audit");
      };
      const expected = all
        .map((entry) => ({ key: identityIndexKey(entry), sequence: entry.outcomeSequence }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const batches = await Array.fromAsync(reader.scanKeys(null, null, 2));
      expect(batches.flatMap((batch) => batch.entries)).toEqual(expected);
      expect(batches.map((batch) => batch.complete)).toEqual([false, false, false, true]);
      expect(batches.at(-1)?.matchedThrough).toBe(7n);
      expect(batches.every((batch) => batch.pin === reader.pin)).toBe(true);
      const lower = expected[1]?.key,
        upper = expected[5]?.key;
      if (!lower || !upper) throw new Error("Missing fixture bounds");
      expect(
        (await Array.fromAsync(reader.scanKeys(lower, upper, 3))).flatMap((batch) => batch.entries),
      ).toEqual(expected.slice(1, 5));
      const iterator = reader.scanKeys(null, null, 1);
      expect((await iterator.next()).value?.complete).toBe(false);
      if (compact) f.hooks.now = 100n;
      else await f.control.releasePin(f.pin);
      await expect(iterator.next()).rejects.toThrow(
        compact ? "index_pin_expired" : "index_pin_not_active",
      );
    } finally {
      f.db.close();
    }
  }
});

test("a pinned reader cannot open over a fabricated canonical head or same-count substituted population", async () => {
  const badHead = await fixture({ fakeHead: true });
  try {
    await expect(badHead.openReader()).rejects.toThrow("index_canonical_head_mismatch");
  } finally {
    badHead.db.close();
  }
  const badPopulation = await fixture({
    partitions(cold, hot) {
      const first = hot[0];
      if (!first) throw new Error("Missing fixture identity");
      return [cold, [{ ...first, id: "fabricated" }, ...hot.slice(1)]];
    },
  });
  try {
    await expect(badPopulation.openReader()).rejects.toThrow("index_identity_mismatch");
  } finally {
    badPopulation.db.close();
  }
});

test("pinned lookup refuses required missing pages and expiry during page I/O", async () => {
  const f = await fixture();
  try {
    const reader = await f.openReader();
    f.hooks.onPageRead = () => {
      f.hooks.now = 100n;
    };
    await expect(
      reader.lookupKey(identityIndexKey({ bookId: BOOK, family: "command", id: "activate" })),
    ).rejects.toThrow("index_pin_expired");
  } finally {
    f.db.close();
  }
  const missing = await fixture();
  try {
    const reader = await missing.openReader();
    const root = await missing.pages.readRootDescriptor(missing.pin.view.hotRoot);
    if (!root?.page) throw new Error("Missing fixture root");
    missing.db.query("DELETE FROM ledger_index_pages WHERE location = ?").run(root.page.location);
    // Even a cold hit must not hide a missing required hot lookup page.
    await expect(
      reader.lookupKey(identityIndexKey({ bookId: BOOK, family: "command", id: "activate" })),
    ).rejects.toThrow("index_page_missing_or_short");
  } finally {
    missing.db.close();
  }
});

test("pinned lookup keeps its original cutoff through real posting and index cutover", async () => {
  const f = await fixture({ compact: true });
  try {
    const reader = await f.openReader();
    await f.ledger.execute(posting("later", 2n));
    const replacement = await f.stage(all);
    let switched = false;
    f.hooks.onPageRead = () => {
      if (switched) return;
      switched = true;
      f.hooks.onSync = async () => {
        f.hooks.onSync = undefined;
        const current = await f.control.readMetadata();
        const frozen = await f.control.freeze(current.view, "lookup-cutover");
        if (!frozen.frozen) throw new Error("Missing frozen prefix");
        await f.control.install(
          frozen.view,
          frozen.frozen,
          replacement.contentHash,
          createIndexRoot(0n, null).contentHash,
          "0",
        );
      };
    };
    const result = await reader.lookupKey(
      identityIndexKey({ bookId: BOOK, family: "command", id: "later" }),
    );
    expect(result.sequence).toBeNull();
    expect(switched).toBe(true);
    expect(result.pin.view.sequence).toBe("3");
    expect((await f.ledger.read()).head.sequence).toBe("4");
    expect((await f.control.readMetadata()).view.revision).not.toBe(result.pin.view.revision);
  } finally {
    f.db.close();
  }
});

test("compact partition audit binds persisted namespace/generation and format-specific complete heads", async () => {
  const f = await fixture({ compact: true });
  try {
    expect((await f.audit()).scope).toEqual(owner);
    const snapshot = await f.ledger.read();
    expect(snapshot.format).toBe(COMPACT_LEDGER_FORMAT);
    expect(ledgerIndexHeadCommitment(snapshot.head, snapshot.format)).not.toBe(
      snapshotIndexHeadCommitment(snapshot.head),
    );
  } finally {
    f.db.close();
  }
  for (const field of ["namespaceId", "generation"] as const) {
    const wrong = await fixture({
      compact: true,
      identity: { ...owner, [field]: field === "generation" ? "1" : "other" },
    });
    try {
      await expect(wrong.audit()).rejects.toThrow("index_canonical_scope_mismatch");
    } finally {
      wrong.db.close();
    }
  }
});

test("partition audit verifies real canonical identities at an exact durable pin, including empty genesis", async () => {
  for (const empty of [false, true]) {
    const f = await fixture({ empty });
    try {
      const report = await f.audit();
      expect(report.coldPopulation).toBe(empty ? 0n : 2n);
      expect(report.hotPopulation).toBe(empty ? 0n : 5n);
      expect(report.pin).toEqual(f.pin);
      expect(report.scope).toEqual({ tenantId: "tenant", bookId: BOOK, objectId: "object" });
      expect(report.head).toEqual((await f.ledger.readAt(empty ? 0n : 3n)).head);
      expect(report.exactEntriesVerified && report.pageIntegrityVerified).toBe(true);
    } finally {
      f.db.close();
    }
  }
});

test("correct totals and valid page hashes cannot excuse wrong partition membership or original locators", async () => {
  const variants = [
    {
      error: "index_partition_sequence_mismatch",
      mutate: (
        cold: CanonicalIdentity[],
        hot: CanonicalIdentity[],
      ): [CanonicalIdentity[], CanonicalIdentity[]] => {
        const first = cold[0],
          later = hot[0];
        if (!first || !later) throw new Error("Missing fixture entries");
        return [
          [later, ...cold.slice(1)],
          [first, ...hot.slice(1)],
        ];
      },
    },
    {
      error: "index_identity_mismatch",
      mutate: (
        cold: CanonicalIdentity[],
        hot: CanonicalIdentity[],
      ): [CanonicalIdentity[], CanonicalIdentity[]] => {
        const entry = hot[0];
        if (!entry) throw new Error("Missing fixture entry");
        return [cold, [{ ...entry, outcomeSequence: 3n }, ...hot.slice(1)]];
      },
    },
    {
      error: "index_identity_mismatch",
      mutate: (
        cold: CanonicalIdentity[],
        hot: CanonicalIdentity[],
      ): [CanonicalIdentity[], CanonicalIdentity[]] => {
        const entry = hot[0];
        if (!entry) throw new Error("Missing fixture entry");
        return [cold, [{ ...entry, id: "invented" }, ...hot.slice(1)]];
      },
    },
    {
      error: "index_partition_population_mismatch",
      mutate: (
        cold: CanonicalIdentity[],
        hot: CanonicalIdentity[],
      ): [CanonicalIdentity[], CanonicalIdentity[]] => {
        const entry = hot[0];
        if (!entry) throw new Error("Missing fixture entry");
        return [[...cold, entry], hot.slice(1)];
      },
    },
  ];
  for (const variant of variants) {
    const f = await fixture({ partitions: variant.mutate });
    try {
      await expect(f.audit()).rejects.toThrow(variant.error);
    } finally {
      f.db.close();
    }
  }
});

test("head and persisted book scope are verified independently of index-owner metadata", async () => {
  const badHead = await fixture({ fakeHead: true });
  try {
    await expect(badHead.audit()).rejects.toThrow("index_canonical_head_mismatch");
  } finally {
    badHead.db.close();
  }
  for (const field of ["tenantId", "bookId", "objectId"] as const) {
    const f = await fixture({ identity: { ...owner, [field]: "other" } });
    try {
      await expect(f.audit()).rejects.toThrow("index_canonical_scope_mismatch");
    } finally {
      f.db.close();
    }
  }
});

test("owner context and both page-store commitments must match the pinned identity", async () => {
  const f = await fixture();
  try {
    for (const field of ["namespaceId", "generation"] as const) {
      await expect(
        auditPinnedIdentityView(
          f.ledger,
          f.control,
          { ...owner, [field]: field === "generation" ? "1" : "other" },
          f.pin,
          { cold: f.pages, hot: f.pages },
        ),
      ).rejects.toThrow("index_store_identity_mismatch");
    }
    let getterCalls = 0;
    const input = {
      ...owner,
      get bookId(): string {
        getterCalls++;
        throw new Error("must not run");
      },
    };
    expect(() => indexBookIdentityCommitment(input)).toThrow("index_book_identity_invalid");
    expect(getterCalls).toBe(0);
    expect(indexBookIdentityCommitment(owner)).toBe(
      hashCanonical({ domain: "rastrata-index-book-identity-v1", ...owner }).digest,
    );
  } finally {
    f.db.close();
  }
});

test("an older pinned audit remains exact after new accounting outcomes and index cutover", async () => {
  const f = await fixture();
  try {
    await f.ledger.execute(posting("later", 2n));
    expect((await f.ledger.read()).head.sequence).toBe("4");
    const replacement = await f.stage(all);
    let switched = false;
    f.hooks.onPageRead = () => {
      if (switched) return;
      switched = true;
      f.hooks.onSync = async () => {
        f.hooks.onSync = undefined;
        const current = await f.control.readMetadata();
        const frozen = await f.control.freeze(current.view, "audit-cutover");
        if (!frozen.frozen) throw new Error("Missing prefix");
        await f.control.install(
          frozen.view,
          frozen.frozen,
          replacement.contentHash,
          createIndexRoot(0n, null).contentHash,
          "0",
        );
      };
    };
    const report = await f.audit();
    expect(switched).toBe(true);
    expect(report.head.sequence).toBe("3");
    expect(report.pin).toEqual(f.pin);
    expect((await f.control.readMetadata()).view.revision).not.toBe(f.pin.view.revision);
    expect(report.coldPopulation + report.hotPopulation).toBe(7n);
    expect((await f.ledger.read()).head.sequence).toBe("4");
  } finally {
    f.db.close();
  }
});

test("expiry during page I/O and later canonical corruption prevent a successful report", async () => {
  const f = await fixture();
  try {
    f.hooks.onPageRead = () => {
      f.hooks.now = 100n;
    };
    await expect(f.audit()).rejects.toThrow("index_pin_expired");
  } finally {
    f.db.close();
  }
  const corrupt = await fixture();
  try {
    await corrupt.ledger.execute(posting("later", 2n));
    corrupt.db.query("DELETE FROM ledger_outcomes WHERE sequence = ?").run("4");
    let reads = 0;
    corrupt.hooks.onPageRead = () => {
      reads++;
    };
    await expect(corrupt.audit()).rejects.toThrow();
    expect(reads).toBe(0);
  } finally {
    corrupt.db.close();
  }
});

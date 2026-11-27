import { expect, test } from "bun:test";
import {
  BOOK_ROW_COLLECTIONS,
  canonicalAccountingValue,
  decodeBookStateHeader,
  decodeDurableBook,
  encodeDurableBook,
  executeBookCommand,
  hashCanonical,
  hashFinancialIdentity,
  type BookRowCollection,
  type BookStateHeader,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  INDEXED_BOOK_COLLECTIONS,
  INDEXED_BOOK_PROFILE,
  decodeIndexedBookHead,
  decodeIndexedBookState,
  encodeIndexedBookState,
  indexedCollectionDomain,
  indexedRowCommitment,
  prepareIndexedBookHead,
  prepareIndexedBookState,
  projectLegacyIndexedBook,
  type IndexedBookState,
} from "../src/indexed-book-state.ts";
import {
  auditLogicalMap,
  emptyLogicalMap,
  logicalMapHash,
  prepareLogicalChange,
} from "../src/logical-map.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";
import { activation, BOOK, genesis, posting } from "./fixtures.ts";
import { allocationAndTaxWorkflow } from "./accounting-workflows.ts";

const scope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "namespace",
  generation: "0",
};
function header(state: IndexedBookState): BookStateHeader {
  const decoded = decodeBookStateHeader(state.header);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  return decoded.header;
}
function roots(state: IndexedBookState) {
  return state.collections.map(({ collection, encodedRoot }) => ({ collection, encodedRoot }));
}
// Read exact subtrees from legacy wire without the production projector/row encoder.
function wireRows(encoded: string, collection: BookRowCollection): string[] {
  let node = JSON.parse(encoded).body;
  for (const part of collection.split(".")) {
    node = node[1].find(([name]: [string]) => name === part)?.[1];
    if (node === undefined) return [];
  }
  return (collection === "state.openingBoundary" ? [node] : node[1]).map((row: unknown) =>
    JSON.stringify(row),
  );
}
function commitment(
  state: IndexedBookState,
  collection: BookRowCollection,
  index: number,
  encoded: string,
) {
  const domain = hashCanonical(
    canonicalAccountingValue({
      profile: INDEXED_BOOK_PROFILE,
      financialIdentityHash: header(state).financialIdentityHash,
      collection,
      keySchema: "one-based-256-bit-ordinal",
    }),
  ).digest;
  return {
    domain,
    key: (BigInt(index) + 1n).toString(16).padStart(64, "0"),
    value: hashCanonical({ domain, ordinal: BigInt(index) + 1n, encoded }).digest,
  };
}
async function verifyProjection(encoded: string) {
  const projected = await projectLegacyIndexedBook(encoded);
  const { state } = projected;
  expect(state.collections.map((c) => c.collection)).toEqual([...BOOK_ROW_COLLECTIONS].sort());
  expect(state.collections.length).toBe(24);
  for (const collection of state.collections) {
    const domain = indexedCollectionDomain(
      header(state).financialIdentityHash,
      collection.collection,
    );
    const values = new Map(
      wireRows(encoded, collection.collection).map((row, index) => {
        const expected = commitment(state, collection.collection, index, row);
        expect(expected.domain).toBe(domain);
        expect(
          indexedRowCommitment(
            header(state).financialIdentityHash,
            collection.collection,
            BigInt(index) + 1n,
            row,
          ),
        ).toBe(expected.value);
        return [expected.key, expected.value];
      }),
    );
    const rebuilt = rebuildLogicalMap(domain, values);
    expect(collection.encodedRoot).toBe(rebuilt.encodedRoot);
    expect(collection.rootHash).toBe(rebuilt.rootHash);
    expect(collection.population).toBe(String(values.size));
    const observed = new Map<string, string>();
    const audit = await auditLogicalMap(
      collection.encodedRoot,
      collection.rootHash,
      domain,
      projected.readNode,
      (key, value) => {
        observed.set(key, value);
      },
    );
    expect(audit.population).toBe(BigInt(values.size));
    expect(observed).toEqual(values);
  }
  const scalar = header(state);
  const entries = (prefix: string) =>
    state.collections
      .filter((c) => c.collection.startsWith(prefix))
      .map((c) => ({
        collection: c.collection,
        population: BigInt(c.population),
        rootHash: c.rootHash,
      }));
  const common = {
    profile: INDEXED_BOOK_PROFILE,
    financialIdentityHash: scalar.financialIdentityHash,
  };
  expect(state.stateRoot).toBe(
    hashCanonical(
      canonicalAccountingValue({
        ...common,
        kind: "state",
        header: state.header,
        collections: entries("state."),
      }),
    ).digest,
  );
  expect(state.protocolRoot).toBe(
    hashCanonical(
      canonicalAccountingValue({ ...common, kind: "protocol", collections: entries("protocol.") }),
    ).digest,
  );
  const { contentHash, ...body } = state;
  expect(contentHash).toBe(
    hashCanonical({ domain: "rastrata-indexed-book-state-v1", encoded: JSON.stringify(body) })
      .digest,
  );
  expect(state.stateRoot).not.toBe(projected.legacyStateHash.digest);
  expect(decodeIndexedBookState(encodeIndexedBookState(state))).toEqual(state);
  const decoded = decodeDurableBook(encoded);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
  return projected;
}

test("new closed state profile matches independent complete roots from genesis and actual accounting history", async () => {
  await verifyProjection(encodeDurableBook(genesis()));
  const workflow = allocationAndTaxWorkflow("1.1.0");
  let source: DurableBookAggregate = workflow.initial;
  for (const command of workflow.commands) {
    const next = executeBookCommand(source.state, source.protocol, command);
    expect(next.result.disposition).toBe("committed");
    source = next;
  }
  await verifyProjection(encodeDurableBook({ state: source.state, protocol: source.protocol }));
  const legacy = (
    await Bun.file(
      new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
    ).text()
  ).trim();
  await verifyProjection(legacy);
});

test("incremental path-copy append equals independent full projection; rejection changes only protocol", async () => {
  const initial = genesis();
  const active = executeBookCommand(initial.state, initial.protocol, activation());
  let source: DurableBookAggregate = { state: active.state, protocol: active.protocol };
  for (const command of [
    posting("indexed-state-rejection", 0n),
    posting("indexed-state-post", 1n),
  ]) {
    const beforeWire = encodeDurableBook(source);
    const before = await projectLegacyIndexedBook(beforeWire);
    const result = executeBookCommand(source.state, source.protocol, command);
    expect(result.result.disposition).toBe(
      command.expectedBookRevision === 0n ? "rejected" : "committed",
    );
    const afterWire = encodeDurableBook({ state: result.state, protocol: result.protocol });
    const after = await verifyProjection(afterWire);
    const nodes = new Map<string, string>();
    let reads = 0;
    const read = async (digest: string) => {
      reads++;
      return nodes.get(digest) ?? before.readNode(digest);
    };
    const changedRoots = [];
    for (const collection of before.state.collections) {
      const domain = indexedCollectionDomain(
        header(before.state).financialIdentityHash,
        collection.collection,
      );
      let encodedRoot = collection.encodedRoot;
      const oldRows = wireRows(beforeWire, collection.collection);
      const newRows = wireRows(afterWire, collection.collection);
      expect(newRows.slice(0, oldRows.length)).toEqual(oldRows);
      for (let index = oldRows.length; index < newRows.length; index++) {
        const row = newRows[index];
        if (row === undefined) throw new Error("Missing append");
        const expected = commitment(after.state, collection.collection, index, row);
        const change = await prepareLogicalChange(
          encodedRoot,
          logicalMapHash(encodedRoot, domain),
          domain,
          expected.key,
          null,
          expected.value,
          read,
        );
        for (const node of change.nodes) nodes.set(node.digest, node.encoded);
        encodedRoot = change.encodedRoot;
      }
      changedRoots.push({ collection: collection.collection, encodedRoot });
    }
    const incremental = prepareIndexedBookState(header(after.state), changedRoots);
    expect(incremental).toEqual(after.state);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(20);
    if (result.result.disposition === "rejected") {
      expect(after.state.header).toBe(before.state.header);
      expect(after.state.stateRoot).toBe(before.state.stateRoot);
      expect(after.state.protocolRoot).not.toBe(before.state.protocolRoot);
      expect(after.state.contentHash).not.toBe(before.state.contentHash);
      expect(after.legacyStateHash).toEqual(before.legacyStateHash);
    }
    source = { state: result.state, protocol: result.protocol };
  }
});

test("catalog admission fails closed for omissions, duplicates, foreign roots and inconsistent counts", async () => {
  const { state } = await projectLegacyIndexedBook(encodeDurableBook(genesis()));
  const scalar = header(state);
  const supplied = roots(state);
  expect(INDEXED_BOOK_COLLECTIONS).toEqual([...BOOK_ROW_COLLECTIONS].sort());
  expect(() => prepareIndexedBookState(scalar, supplied.slice(1))).toThrow(
    "indexed_state_catalog_incomplete",
  );
  expect(() =>
    prepareIndexedBookState(
      scalar,
      supplied.map(() => supplied[0] as (typeof supplied)[number]),
    ),
  ).toThrow("indexed_state_collection_invalid");
  for (const collection of ["__proto__", "constructor", "state.unknown"])
    expect(() =>
      prepareIndexedBookState(
        scalar,
        supplied.map((root, index) =>
          index === 0 ? { ...root, collection: collection as BookRowCollection } : root,
        ),
      ),
    ).toThrow("indexed_state_collection_invalid");
  expect(() =>
    prepareIndexedBookState(
      scalar,
      supplied.map((root) => ({ ...root, extra: true })),
    ),
  ).toThrow("indexed_state_shape_invalid");
  const foreignIdentity = { ...scalar.identity, code: "foreign" };
  expect(() =>
    prepareIndexedBookState(
      {
        ...scalar,
        identity: foreignIdentity,
        financialIdentityHash: hashFinancialIdentity(foreignIdentity),
      },
      supplied,
    ),
  ).toThrow();
  expect(() =>
    prepareIndexedBookState(
      scalar,
      supplied.map((root) => ({ ...root, encodedRoot: supplied[0]?.encodedRoot ?? "" })),
    ),
  ).toThrow();
  for (const modified of [
    { ...scalar, bookRevision: 1n },
    { ...scalar, latestPostingSequence: 1n },
    { ...scalar, status: "open" as const },
  ])
    expect(() => prepareIndexedBookState(modified, supplied)).toThrow(
      "indexed_state_population_mismatch",
    );
  const missingConfig = supplied.map((root) =>
    root.collection === "state.configurationSnapshots"
      ? {
          ...root,
          encodedRoot: emptyLogicalMap(
            indexedCollectionDomain(scalar.financialIdentityHash, root.collection),
          ),
        }
      : root,
  );
  expect(() => prepareIndexedBookState(scalar, missingConfig)).toThrow(
    "indexed_state_population_mismatch",
  );
  const captured = encodeIndexedBookState(state);
  supplied.reverse();
  const copy = prepareIndexedBookState(scalar, supplied);
  supplied.length = 0;
  expect(encodeIndexedBookState(copy)).toBe(captured);
  expect(Object.isFrozen(copy.collections)).toBe(true);
  expect(Object.isFrozen(copy.collections[0])).toBe(true);
  expect(Object.isFrozen(copy.profile)).toBe(true);
  expect(() => (copy.collections as unknown[]).push("extra")).toThrow();
});

test("state wire refuses changed hashes, counts, profiles, ordering, oversized and legacy encodings", async () => {
  const legacy = encodeDurableBook(genesis());
  const { state } = await projectLegacyIndexedBook(legacy);
  const encoded = encodeIndexedBookState(state);
  const altered: unknown[] = [
    { ...state, stateRoot: "0".repeat(64) },
    { ...state, protocolRoot: "0".repeat(64) },
    { ...state, contentHash: "0".repeat(64) },
    { ...state, extra: true },
    { ...state, profile: { ...state.profile, rowCodec: "unknown" } },
    { ...state, collections: [...state.collections].reverse() },
    { ...state, collections: state.collections.slice(1) },
  ];
  for (const field of ["population", "rootHash", "encodedRoot"])
    altered.push({
      ...state,
      collections: state.collections.map((c, i) => (i === 0 ? { ...c, [field]: "invalid" } : c)),
    });
  for (const raw of altered) expect(() => decodeIndexedBookState(JSON.stringify(raw))).toThrow();
  for (const raw of [
    "null",
    "{broken",
    `${encoded} `,
    encoded.replace('{"version":', '{"version":"duplicate","version":'),
    legacy,
    "€".repeat(90_000),
    null as unknown as string,
  ])
    expect(() => decodeIndexedBookState(raw)).toThrow();
  await expect(projectLegacyIndexedBook(`${legacy} `)).rejects.toThrow(
    "indexed_state_legacy_source_invalid",
  );
  await expect(projectLegacyIndexedBook(encoded)).rejects.toThrow(
    "indexed_state_legacy_source_invalid",
  );
});

test("root framing enforces ordinal endpoints but cannot certify reachable rows or semantic admission", async () => {
  const { state } = await projectLegacyIndexedBook(encodeDurableBook(genesis()));
  const config = state.collections.find((c) => c.collection === "state.configurationSnapshots");
  if (!config) throw new Error("Missing configuration root");
  const domain = indexedCollectionDomain(header(state).financialIdentityHash, config.collection);
  expect(decodeIndexedBookState(encodeIndexedBookState(state))).toEqual(state);
  await expect(
    auditLogicalMap(config.encodedRoot, config.rootHash, domain, async () => undefined),
  ).rejects.toThrow();
  const misplaced = rebuildLogicalMap(domain, new Map([["f".repeat(64), "a".repeat(64)]]));
  expect(() =>
    prepareIndexedBookState(
      header(state),
      roots(state).map((c) =>
        c.collection === config.collection ? { ...c, encodedRoot: misplaced.encodedRoot } : c,
      ),
    ),
  ).toThrow("indexed_state_ordinal_range_invalid");
  // Correct declared endpoints/count do not prove the value authenticates any
  // available/admissible configuration payload.
  const fabricated = rebuildLogicalMap(domain, new Map([["1".padStart(64, "0"), "a".repeat(64)]]));
  const framed = prepareIndexedBookState(
    header(state),
    roots(state).map((c) =>
      c.collection === config.collection ? { ...c, encodedRoot: fabricated.encodedRoot } : c,
    ),
  );
  expect(decodeIndexedBookState(encodeIndexedBookState(framed))).toEqual(framed);
  expect(framed.stateRoot).not.toBe(state.stateRoot);
  for (const ordinal of [0n, -1n, 1n << 64n])
    expect(() =>
      indexedRowCommitment(header(state).financialIdentityHash, config.collection, ordinal, "null"),
    ).toThrow("indexed_state_ordinal_invalid");
  expect(() =>
    indexedRowCommitment(header(state).financialIdentityHash, config.collection, 1n, "null"),
  ).toThrow("indexed_state_row_invalid");
});

test("new head binds full physical scope and state counters without contaminating economic roots", async () => {
  const { state } = await projectLegacyIndexedBook(encodeDurableBook(genesis()));
  const head = prepareIndexedBookHead(scope, scope.objectId, state, null, null);
  expect(head.sequence).toBe("0");
  expect(head.revisionHash).toBeNull();
  expect(decodeIndexedBookHead(JSON.stringify(head), state, scope, scope.objectId)).toEqual(head);
  const { contentHash, ...body } = head;
  expect(contentHash).toBe(
    hashCanonical({ domain: "rastrata-indexed-book-head-v1", encoded: JSON.stringify(body) })
      .digest,
  );
  expect(Object.isFrozen(head.identity)).toBe(true);
  for (const changed of [
    { ...scope, tenantId: "other" },
    { ...scope, namespaceId: "other" },
    { ...scope, objectId: "other" },
    { ...scope, generation: "1" },
  ]) {
    const other = prepareIndexedBookHead(changed, changed.objectId, state, null, null);
    expect(other.stateRoot).toBe(head.stateRoot);
    expect(other.protocolRoot).toBe(head.protocolRoot);
    expect(other.contentHash).not.toBe(head.contentHash);
    expect(other.chainHash).not.toEqual(head.chainHash);
    expect(() =>
      decodeIndexedBookHead(JSON.stringify(head), state, changed, changed.objectId),
    ).toThrow();
  }
  expect(() =>
    prepareIndexedBookHead({ ...scope, bookId: "other" }, scope.objectId, state, null, null),
  ).toThrow("ledger_identity_mismatch");
  expect(() => prepareIndexedBookHead(scope, "wrong", state, null, null)).toThrow(
    "ledger_identity_mismatch",
  );
  expect(() =>
    prepareIndexedBookHead(scope, scope.objectId, state, hashCanonical("chain"), null),
  ).toThrow("indexed_head_chain_invalid");
  expect(() =>
    prepareIndexedBookHead(scope, scope.objectId, state, null, hashCanonical("revision")),
  ).toThrow("indexed_head_chain_invalid");
  for (const field of [
    "stateContentHash",
    "stateRoot",
    "protocolRoot",
    "sequence",
    "bookRevision",
    "postingSequence",
    "configurationRevision",
    "contentHash",
  ])
    expect(() =>
      decodeIndexedBookHead(
        JSON.stringify({ ...head, [field]: "1" }),
        state,
        scope,
        scope.objectId,
      ),
    ).toThrow();
  for (const value of [
    { ...head, extra: true },
    { ...head, profileId: "legacy" },
    { ...head, configurationHash: hashCanonical("other") },
    { ...head, chainHash: hashCanonical("other") },
  ])
    expect(() =>
      decodeIndexedBookHead(JSON.stringify(value), state, scope, scope.objectId),
    ).toThrow();
  for (const raw of [
    "null",
    "{broken",
    `${JSON.stringify(head)} `,
    "€".repeat(45_000),
    encodeDurableBook(genesis()),
  ])
    expect(() => decodeIndexedBookHead(raw, state, scope, scope.objectId)).toThrow();
});

test("nonzero Oseq and financial revision are independent; framing is not chain verification", async () => {
  const initial = genesis();
  const earlyRejection = executeBookCommand(
    initial.state,
    initial.protocol,
    posting("before-activation", 0n),
  );
  expect(earlyRejection.result.disposition).toBe("rejected");
  const early = await projectLegacyIndexedBook(
    encodeDurableBook({ state: earlyRejection.state, protocol: earlyRejection.protocol }),
  );
  const earlyHead = prepareIndexedBookHead(
    scope,
    scope.objectId,
    early.state,
    hashCanonical("early outcome chain"),
    null,
  );
  expect(earlyHead.sequence).toBe("1");
  expect(earlyHead.bookRevision).toBe("0");
  expect(earlyHead.revisionHash).toBeNull();
  expect(
    decodeIndexedBookHead(JSON.stringify(earlyHead), early.state, scope, scope.objectId),
  ).toEqual(earlyHead);
  const active = executeBookCommand(initial.state, initial.protocol, activation());
  const rejected = executeBookCommand(
    active.state,
    active.protocol,
    posting("indexed-head-rejected", 0n),
  );
  const { state } = await projectLegacyIndexedBook(
    encodeDurableBook({ state: rejected.state, protocol: rejected.protocol }),
  );
  const revision = rejected.state.revisions.at(-1)?.chainHash;
  if (!revision) throw new Error("Missing canonical financial predecessor");
  // Arbitrary well-formed chain is intentionally only framed, not authenticated.
  const chain = hashCanonical("not a verified outcome chain");
  const head = prepareIndexedBookHead(scope, scope.objectId, state, chain, revision);
  expect(head.sequence).toBe("2");
  expect(head.bookRevision).toBe("1");
  expect(head.postingSequence).toBe("0");
  expect(head.revisionHash).toEqual(revision);
  expect(decodeIndexedBookHead(JSON.stringify(head), state, scope, scope.objectId)).toEqual(head);
  expect(() => prepareIndexedBookHead(scope, scope.objectId, state, null, revision)).toThrow(
    "indexed_head_chain_invalid",
  );
  expect(() => prepareIndexedBookHead(scope, scope.objectId, state, chain, null)).toThrow(
    "indexed_head_chain_invalid",
  );
  expect(() =>
    prepareIndexedBookHead(scope, scope.objectId, state, { ...chain, digest: "bad" }, revision),
  ).toThrow("indexed_state_hash_invalid");
});

import {
  BOOK_ROW_CODEC_VERSION,
  BOOK_ROW_COLLECTIONS,
  BOOK_OUTCOME_CODEC_VERSION,
  BOOK_STATE_HEADER_CODEC_VERSION,
  BOOK_COMMAND_PROTOCOL_VERSION,
  CANONICALIZATION_VERSION,
  CONTENT_HASH_ALGORITHM,
  decodeBookStateHeader,
  encodeBookStateHeader,
  decodeBookRow,
  decodeDurableBook,
  encodeDurableBook,
  encodeBookRow,
  hashCanonical,
  canonicalAccountingValue,
  immutableAccountingValue,
  type BookStateHeader,
  type BookRowCollection,
  type BookRowTypes,
  type ContentHash,
} from "@rastrata/kernel";
import {
  LOGICAL_MAP_VERSION,
  emptyLogicalMap,
  logicalMapHash,
  prepareLogicalChange,
} from "./logical-map.ts";
import { completeScope } from "./compact-records.ts";
import { requireLedger, type CompleteBookScope } from "./records.ts";

/** Explicit new wire representation, NOT an enabled storage/evaluation profile.
 * Legacy heads, rows and outcomes keep their original codecs and hash preimages.
 * Framing validates commitments/counts, never source availability or readiness. */
export const INDEXED_BOOK_STATE_VERSION = "rastrata-indexed-book-state-v1";
export const INDEXED_BOOK_HEAD_VERSION = "rastrata-indexed-book-head-v1";
export const INDEXED_BOOK_PROFILE = Object.freeze({
  id: INDEXED_BOOK_STATE_VERSION,
  headerCodec: BOOK_STATE_HEADER_CODEC_VERSION,
  rowCodec: BOOK_ROW_CODEC_VERSION,
  outcomeCodec: BOOK_OUTCOME_CODEC_VERSION,
  logicalMapCodec: LOGICAL_MAP_VERSION,
  commandProtocol: BOOK_COMMAND_PROTOCOL_VERSION,
  hashAlgorithm: CONTENT_HASH_ALGORITHM,
  canonicalizationVersion: CANONICALIZATION_VERSION,
});
const COLLECTIONS = {
  "state.configurationSnapshots": true,
  "state.openingBoundary": true,
  "state.lots": true,
  "state.lotHoldings": true,
  "state.lotAllocations": true,
  "state.journals": true,
  "state.corrections": true,
  "state.periodTransitions": true,
  "state.closePackages": true,
  "state.revisions": true,
  "state.accountingState.provisionalInventoryLayers": true,
  "state.accountingState.inventoryRecostings": true,
  "state.accountingState.inventoryValueAdjustments": true,
  "state.accountingState.openItems": true,
  "state.accountingState.settlements": true,
  "state.accountingState.settlementAllocations": true,
  "state.accountingState.remeasurementResults": true,
  "state.accountingState.remeasurementReversals": true,
  "state.accountingState.allocationSchedules": true,
  "state.accountingState.allocationRecognitions": true,
  "state.accountingState.allocationScheduleRevisions": true,
  "state.accountingState.taxDeterminations": true,
  "state.accountingState.consolidationCompilations": true,
  "protocol.retainedResults": true,
} satisfies Record<BookRowCollection, true>;
export const INDEXED_BOOK_COLLECTIONS = Object.freeze(
  Object.keys(COLLECTIONS).sort() as BookRowCollection[],
);
const encoder = new TextEncoder();
const MAX_STATE_BYTES = 262_144;
const MAX_HEAD_BYTES = 131_072;
const HEX = /^[0-9a-f]{64}$/;

export interface IndexedCollectionRoot {
  readonly collection: BookRowCollection;
  readonly encodedRoot: string;
  readonly rootHash: string;
  readonly population: string;
}
export interface IndexedBookState {
  readonly version: typeof INDEXED_BOOK_STATE_VERSION;
  readonly profile: typeof INDEXED_BOOK_PROFILE;
  readonly header: string;
  readonly collections: readonly IndexedCollectionRoot[];
  readonly stateRoot: string;
  readonly protocolRoot: string;
  readonly contentHash: string;
}
export interface IndexedBookHead {
  readonly version: typeof INDEXED_BOOK_HEAD_VERSION;
  readonly profileId: typeof INDEXED_BOOK_STATE_VERSION;
  readonly identity: CompleteBookScope;
  readonly stateContentHash: string;
  readonly stateRoot: string;
  readonly protocolRoot: string;
  readonly sequence: string;
  readonly bookRevision: string;
  readonly postingSequence: string;
  readonly configurationRevision: string;
  readonly configurationHash: ContentHash;
  readonly revisionHash: ContentHash | null;
  readonly chainHash: ContentHash;
  readonly contentHash: string;
}

function closed(input: unknown, names: readonly string[]): Record<string, unknown> {
  requireLedger(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "indexed_state_shape_invalid",
  );
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === names.length, "indexed_state_shape_invalid");
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const field = descriptors[name];
    requireLedger(field && "value" in field && field.enumerable, "indexed_state_shape_invalid");
    result[name] = field.value;
  }
  return result;
}
function contentHash(input: unknown): ContentHash {
  const value = closed(input, ["algorithm", "canonicalizationVersion", "digest"]);
  requireLedger(
    value.algorithm === CONTENT_HASH_ALGORITHM &&
      value.canonicalizationVersion === CANONICALIZATION_VERSION &&
      typeof value.digest === "string" &&
      HEX.test(value.digest),
    "indexed_state_hash_invalid",
  );
  return Object.freeze({
    algorithm: CONTENT_HASH_ALGORITHM,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    digest: value.digest,
  });
}
function headerValue(encoded: string): BookStateHeader {
  const decoded = decodeBookStateHeader(encoded);
  requireLedger(decoded.disposition === "decoded", "indexed_state_header_invalid");
  return decoded.header;
}
export function indexedCollectionDomain(
  identityHash: ContentHash,
  collection: BookRowCollection,
): string {
  requireLedger(Object.hasOwn(COLLECTIONS, collection), "indexed_state_collection_invalid");
  return hashCanonical(
    canonicalAccountingValue({
      profile: INDEXED_BOOK_PROFILE,
      financialIdentityHash: contentHash(identityHash),
      collection,
      keySchema: "one-based-256-bit-ordinal",
    }),
  ).digest;
}
export function indexedRowCommitment(
  identityHash: ContentHash,
  collection: BookRowCollection,
  ordinal: bigint,
  encoded: string,
): string {
  requireLedger(
    typeof ordinal === "bigint" && ordinal > 0n && ordinal <= (1n << 64n) - 1n,
    "indexed_state_ordinal_invalid",
  );
  requireLedger(
    decodeBookRow(collection, encoded).disposition === "decoded",
    "indexed_state_row_invalid",
  );
  return hashCanonical({
    domain: indexedCollectionDomain(identityHash, collection),
    ordinal,
    encoded,
  }).digest;
}

/** Assemble a CLOSED complete catalog. This checks declared root framing and
 * necessary population relationships, NOT reachable rows, semantic closure or
 * canonical command execution. Unchanged collections must be retained explicitly. */
export function prepareIndexedBookState(
  header: BookStateHeader,
  roots: readonly Pick<IndexedCollectionRoot, "collection" | "encodedRoot">[],
): IndexedBookState {
  const encodedHeader = encodeBookStateHeader(header);
  const scalar = headerValue(encodedHeader);
  requireLedger(
    Array.isArray(roots) && roots.length === INDEXED_BOOK_COLLECTIONS.length,
    "indexed_state_catalog_incomplete",
  );
  const supplied = new Map<BookRowCollection, string>();
  for (const input of roots) {
    const root = closed(input, ["collection", "encodedRoot"]);
    requireLedger(
      typeof root.collection === "string" &&
        Object.hasOwn(COLLECTIONS, root.collection) &&
        typeof root.encodedRoot === "string" &&
        !supplied.has(root.collection as BookRowCollection),
      "indexed_state_collection_invalid",
    );
    supplied.set(root.collection as BookRowCollection, root.encodedRoot);
  }
  const collections = INDEXED_BOOK_COLLECTIONS.map((collection) => {
    const encodedRoot = supplied.get(collection);
    requireLedger(encodedRoot !== undefined, "indexed_state_catalog_incomplete");
    const rootHash = logicalMapHash(
      encodedRoot,
      indexedCollectionDomain(scalar.financialIdentityHash, collection),
    );
    // logicalMapHash has already validated this closed canonical root and its
    // bounded uint64 count. It has NOT read its child nodes or row payloads.
    const tree = JSON.parse(encodedRoot).tree;
    const population: string = tree?.count ?? "0";
    // One-based dense ordinal collections must also declare the corresponding
    // endpoint keys. Reachable child/row closure still needs a separate audit.
    requireLedger(
      tree === null ||
        (tree.min === "1".padStart(64, "0") &&
          tree.max === BigInt(population).toString(16).padStart(64, "0")),
      "indexed_state_ordinal_range_invalid",
    );
    return Object.freeze({ collection, encodedRoot, rootHash, population });
  });
  const count = (name: BookRowCollection) =>
    BigInt(collections.find((c) => c.collection === name)?.population ?? "-1");
  requireLedger(
    count("state.revisions") === scalar.bookRevision &&
      count("state.journals") === scalar.latestPostingSequence &&
      count("state.configurationSnapshots") === scalar.configurationRevision + 1n &&
      count("protocol.retainedResults") >= scalar.bookRevision,
    "indexed_state_population_mismatch",
  );
  requireLedger(
    count("state.openingBoundary") === (scalar.status === "configuring" ? 0n : 1n),
    "indexed_state_population_mismatch",
  );
  const entries = (prefix: string) =>
    collections
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
  const stateRoot = hashCanonical(
    canonicalAccountingValue({
      ...common,
      kind: "state",
      header: encodedHeader,
      collections: entries("state."),
    }),
  ).digest;
  const protocolRoot = hashCanonical(
    canonicalAccountingValue({ ...common, kind: "protocol", collections: entries("protocol.") }),
  ).digest;
  const body = {
    version: INDEXED_BOOK_STATE_VERSION,
    profile: INDEXED_BOOK_PROFILE,
    header: encodedHeader,
    collections: Object.freeze(collections),
    stateRoot,
    protocolRoot,
  } as const;
  const value = Object.freeze({
    ...body,
    contentHash: hashCanonical({
      domain: INDEXED_BOOK_STATE_VERSION,
      encoded: JSON.stringify(body),
    }).digest,
  });
  requireLedger(
    encoder.encode(JSON.stringify(value)).length <= MAX_STATE_BYTES,
    "indexed_state_bytes_exceeded",
  );
  return value;
}

export function decodeIndexedBookState(encoded: string): IndexedBookState {
  requireLedger(
    typeof encoded === "string" && encoder.encode(encoded).length <= MAX_STATE_BYTES,
    "indexed_state_bytes_exceeded",
  );
  const raw = closed(JSON.parse(encoded), [
    "version",
    "profile",
    "header",
    "collections",
    "stateRoot",
    "protocolRoot",
    "contentHash",
  ]);
  requireLedger(
    raw.version === INDEXED_BOOK_STATE_VERSION &&
      JSON.stringify(raw.profile) === JSON.stringify(INDEXED_BOOK_PROFILE) &&
      typeof raw.header === "string" &&
      Array.isArray(raw.collections),
    "indexed_state_profile_invalid",
  );
  requireLedger(
    raw.collections.length === INDEXED_BOOK_COLLECTIONS.length,
    "indexed_state_catalog_incomplete",
  );
  const roots = raw.collections.map((input) => {
    const value = closed(input, ["collection", "encodedRoot", "rootHash", "population"]);
    return {
      collection: value.collection as BookRowCollection,
      encodedRoot: value.encodedRoot as string,
    };
  });
  const value = prepareIndexedBookState(headerValue(raw.header), roots);
  requireLedger(JSON.stringify(value) === encoded, "indexed_state_encoding_mismatch");
  return value;
}
export function encodeIndexedBookState(value: IndexedBookState): string {
  const encoded = JSON.stringify(value);
  decodeIndexedBookState(encoded);
  return encoded;
}

/** Full-head wire binding. A nonzero chain/revision hash must still be verified
 * against canonical records by the owner. This constructor confers no authority
 * to adopt the profile, migrate history, publish a head or skip recovery. */
export function prepareIndexedBookHead(
  scope: CompleteBookScope,
  actualObjectId: string,
  input: IndexedBookState,
  chain: ContentHash | null,
  revision: ContentHash | null,
): IndexedBookHead {
  const identity = completeScope(scope, actualObjectId);
  const state = decodeIndexedBookState(encodeIndexedBookState(input));
  const header = headerValue(state.header);
  requireLedger(identity.bookId === header.identity.bookId, "ledger_identity_mismatch");
  const sequence = state.collections.find(
    (c) => c.collection === "protocol.retainedResults",
  )?.population;
  requireLedger(
    sequence !== undefined &&
      (sequence === "0" ? chain === null : chain !== null) &&
      (header.bookRevision === 0n ? revision === null : revision !== null),
    "indexed_head_chain_invalid",
  );
  const chainHash =
    chain === null
      ? hashCanonical(
          canonicalAccountingValue({
            domain: `${INDEXED_BOOK_HEAD_VERSION}/genesis`,
            identity,
            stateContentHash: state.contentHash,
          }),
        )
      : contentHash(chain);
  const body = {
    version: INDEXED_BOOK_HEAD_VERSION,
    profileId: INDEXED_BOOK_STATE_VERSION,
    identity,
    stateContentHash: state.contentHash,
    stateRoot: state.stateRoot,
    protocolRoot: state.protocolRoot,
    sequence,
    bookRevision: header.bookRevision.toString(),
    postingSequence: header.latestPostingSequence.toString(),
    configurationRevision: header.configurationRevision.toString(),
    configurationHash: header.configurationHash,
    revisionHash: revision === null ? null : contentHash(revision),
    chainHash,
  } as const;
  const value = immutableAccountingValue({
    ...body,
    contentHash: hashCanonical({ domain: INDEXED_BOOK_HEAD_VERSION, encoded: JSON.stringify(body) })
      .digest,
  });
  requireLedger(
    encoder.encode(JSON.stringify(value)).length <= MAX_HEAD_BYTES,
    "indexed_head_bytes_exceeded",
  );
  return value;
}
export function decodeIndexedBookHead(
  encoded: string,
  state: IndexedBookState,
  scope: CompleteBookScope,
  actualObjectId: string,
): IndexedBookHead {
  requireLedger(
    typeof encoded === "string" && encoder.encode(encoded).length <= MAX_HEAD_BYTES,
    "indexed_head_bytes_exceeded",
  );
  const raw = closed(JSON.parse(encoded), [
    "version",
    "profileId",
    "identity",
    "stateContentHash",
    "stateRoot",
    "protocolRoot",
    "sequence",
    "bookRevision",
    "postingSequence",
    "configurationRevision",
    "configurationHash",
    "revisionHash",
    "chainHash",
    "contentHash",
  ]);
  requireLedger(
    raw.version === INDEXED_BOOK_HEAD_VERSION && raw.profileId === INDEXED_BOOK_STATE_VERSION,
    "indexed_state_profile_invalid",
  );
  const value = prepareIndexedBookHead(
    scope,
    actualObjectId,
    state,
    raw.sequence === "0" ? null : contentHash(raw.chainHash),
    raw.revisionHash === null ? null : contentHash(raw.revisionHash),
  );
  requireLedger(JSON.stringify(value) === encoded, "indexed_head_encoding_mismatch");
  return value;
}

/** Bounded legacy oracle/bridge INPUT only. Revalidates every legacy byte, then
 * independently constructs the new roots from exact existing row encodings.
 * It does not install a new profile or claim legacy state hashes are equivalent.
 * It still materializes the legacy aggregate; production migration is unimplemented. */
export async function projectLegacyIndexedBook(encoded: string) {
  const decoded = decodeDurableBook(encoded);
  requireLedger(
    decoded.disposition === "decoded" && encodeDurableBook(decoded.aggregate) === encoded,
    "indexed_state_legacy_source_invalid",
  );
  const source = decoded.aggregate.state;
  requireLedger(
    !source.revisions.some((revision) =>
      revision.effects.some((effect) => effect.type === "lotChanges"),
    ),
    "indexed_state_lot_changes_unsupported",
  );
  // Ownership materialization was authenticated by decodeDurableBook. It is an
  // alias of the complete revision effects, already committed by state.revisions.
  const header: BookStateHeader = {
    identity: source.identity,
    financialIdentityHash: source.financialIdentityHash,
    status: source.status,
    bookRevision: source.bookRevision,
    latestPostingSequence: source.latestPostingSequence,
    configurationRevision: source.configurationRevision,
    configurationHash: source.configurationHash,
  };
  const nodes = new Map<string, string>();
  const readNode = async (hash: string) => nodes.get(hash);
  const roots: Pick<IndexedCollectionRoot, "collection" | "encodedRoot">[] = [];
  for (const collection of INDEXED_BOOK_COLLECTIONS) {
    requireLedger(BOOK_ROW_COLLECTIONS.includes(collection), "indexed_state_collection_invalid");
    let values: unknown = decoded.aggregate;
    for (const field of collection.split(".")) values = (values as Record<string, unknown>)[field];
    const rows =
      collection === "state.openingBoundary" ? (values === undefined ? [] : [values]) : values;
    requireLedger(Array.isArray(rows), "indexed_state_legacy_source_invalid");
    const domain = indexedCollectionDomain(header.financialIdentityHash, collection);
    let encodedRoot = emptyLogicalMap(domain);
    for (const [index, row] of rows.entries()) {
      const ordinal = BigInt(index) + 1n;
      const value = indexedRowCommitment(
        header.financialIdentityHash,
        collection,
        ordinal,
        encodeBookRow(collection, row as BookRowTypes[typeof collection]),
      );
      const changed = await prepareLogicalChange(
        encodedRoot,
        logicalMapHash(encodedRoot, domain),
        domain,
        ordinal.toString(16).padStart(64, "0"),
        null,
        value,
        readNode,
      );
      for (const node of changed.nodes) nodes.set(node.digest, node.encoded);
      encodedRoot = changed.encodedRoot;
    }
    roots.push({ collection, encodedRoot });
  }
  return Object.freeze({
    state: prepareIndexedBookState(header, roots),
    legacyStateHash: source.contentHash,
    readNode,
  });
}

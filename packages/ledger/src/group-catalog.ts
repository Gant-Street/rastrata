import {
  encodeDurableBook,
  hashCanonical,
  ExactRational,
  decodeBookStateHeader,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { projectLegacyLogicalBook, type LogicalProjectionCollection } from "./logical-book.ts";
import {
  auditLogicalMap,
  emptyLogicalMap,
  logicalMapHash,
  lookupLogicalValue,
  prepareLogicalChange,
  readLogicalRangePage,
  readLogicalLastEntry,
} from "./logical-map.ts";
import {
  SEMANTIC_GROUP_VERSION,
  SEMANTIC_GROUP_COLLECTIONS,
  semanticGroupDeltas,
  semanticGroupDigest,
  semanticGroupKey,
  projectSemanticGroupMemberships,
  encodedJournalMoneyScopeTotals,
  type SemanticGroupKey,
  type SemanticGroupDelta,
  type SemanticGroupCollection,
} from "./semantic-groups.ts";
import { requireLedger } from "./records.ts";
import { requireSqliteTransaction, type SqliteTransaction } from "./sqlite-transaction.ts";
import type { SqliteStorage } from "./sqlite.ts";
import { indexedCollectionDomain, indexedRowCommitment } from "./indexed-book-state.ts";
import type {
  SqliteIndexedSourceCatalog,
  PreparedIndexedSourceCatalog,
  IndexedSourceAnchor,
  IndexedSourceReadPorts,
} from "./indexed-source-catalog.ts";
import type { CapturedRow } from "./source-catalog.ts";
import { indexBookIdentityCommitment } from "./index-view-audit.ts";

export const GROUP_CATALOG_FORMAT = "rastrata-group-catalog-candidate-v2";
export const INDEXED_GROUP_CATALOG_FORMAT = "rastrata-indexed-group-catalog-v1";
export const INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT = "rastrata-indexed-ownership-group-catalog-v1";
export const INDEXED_MONEY_GROUP_CATALOG_FORMAT = "rastrata-indexed-money-group-catalog-v1";
export const INDEXED_REFERENCE_GROUP_CATALOG_FORMAT = "rastrata-indexed-reference-group-catalog-v1";
export type IndexedGroupCatalogFormat =
  | typeof INDEXED_GROUP_CATALOG_FORMAT
  | typeof INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT
  | typeof INDEXED_MONEY_GROUP_CATALOG_FORMAT
  | typeof INDEXED_REFERENCE_GROUP_CATALOG_FORMAT;
type GroupCatalogFormat = typeof GROUP_CATALOG_FORMAT | IndexedGroupCatalogFormat;
const COLLECTIONS = [
  "state.lotHoldings",
  "state.accountingState.allocationRecognitions",
  "state.periodTransitions",
  "state.accountingState.remeasurementResults",
  "state.accountingState.remeasurementReversals",
] as const;
const MAX_DESCRIPTOR = 1_048_576 + 2048;
const HEX = /^[0-9a-f]{64}$/;
type Projection = Awaited<ReturnType<typeof projectLegacyLogicalBook>>;
interface GroupDescriptor {
  readonly format: typeof SEMANTIC_GROUP_VERSION;
  readonly key: SemanticGroupKey;
  readonly collectionDomain: string;
  readonly memberDomain: string;
  readonly memberRoot: string;
  readonly memberHash: string;
  readonly population: string;
  readonly postedBalance?: string;
}
interface Metadata {
  readonly format: GroupCatalogFormat;
  readonly identityHash: string;
  readonly headHash: string;
  readonly domain: string;
  readonly root: string;
  readonly rootHash: string;
  readonly population: string;
  readonly sourceCatalogDigest?: string;
}
interface Staged {
  readonly priorDigest: string | null;
  readonly body: string;
  readonly digest: string;
  readonly nodes: ReadonlyMap<string, string>;
  readonly descriptors: ReadonlyMap<string, string>;
  readonly indexedSource?: {
    readonly catalog: SqliteIndexedSourceCatalog;
    readonly prepared: PreparedIndexedSourceCatalog;
  };
}
interface Prepared {
  readonly digest: string;
}
interface PendingGroup {
  key: SemanticGroupKey;
  collectionDomain: string;
  deltas: SemanticGroupDelta[];
  balanceChange?: ExactRational;
}
type PendingGroups = Map<string, PendingGroup>;
function supportsGroup(profile: GroupCatalogFormat, key: SemanticGroupKey): boolean {
  if (key.kind === "postingReferenceRevisionsById")
    return profile === INDEXED_REFERENCE_GROUP_CATALOG_FORMAT;
  if (
    key.kind === "journalsByMoneyScope" ||
    key.kind === "inventoryRevisionsByMoneyScope" ||
    key.kind === "inventoryRevisionsBySourceJournal"
  )
    return (
      profile === INDEXED_MONEY_GROUP_CATALOG_FORMAT ||
      profile === INDEXED_REFERENCE_GROUP_CATALOG_FORMAT
    );
  return (
    key.kind !== "inventoryRevisionsByHolding" ||
    profile === INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT ||
    profile === INDEXED_MONEY_GROUP_CATALOG_FORMAT ||
    profile === INDEXED_REFERENCE_GROUP_CATALOG_FORMAT
  );
}
function balanceValue(encoded: string): ExactRational {
  requireLedger(
    typeof encoded === "string" &&
      encoded.length <= 8192 &&
      /^-?(0|[1-9][0-9]*)\/[1-9][0-9]*$/.test(encoded),
    "group_balance_invalid",
  );
  const [numerator, denominator] = encoded.split("/");
  requireLedger(numerator !== undefined && denominator !== undefined, "group_balance_invalid");
  const value = ExactRational.of(BigInt(numerator), BigInt(denominator));
  requireLedger(value.toString() === encoded, "group_balance_invalid");
  return value;
}
export interface IndexedGroupReadPorts {
  readonly confirm: () => Promise<void>;
  readonly readPrevious: (
    collection: SemanticGroupCollection,
    ordinal: bigint,
  ) => Promise<CapturedRow>;
}
export interface CapturedGroupCatalog {
  readonly digest: string;
}
function hash(kind: string, body: string, profile: GroupCatalogFormat = GROUP_CATALOG_FORMAT) {
  return hashCanonical({ profile, kind, body }).digest;
}
function count(root: string, domain: string): string {
  logicalMapHash(root, domain);
  return JSON.parse(root).tree?.count ?? "0";
}
function descriptor(
  key: SemanticGroupKey,
  collectionDomain: string,
  memberRoot: string,
  postedBalance?: string,
): GroupDescriptor {
  const copied = semanticGroupKey(key.kind, key.values);
  const memberDomain = semanticGroupDigest(collectionDomain, copied);
  requireLedger(
    (copied.kind === "journalsByMoneyScope") === (postedBalance !== undefined),
    "group_balance_invalid",
  );
  return Object.freeze({
    format: SEMANTIC_GROUP_VERSION,
    key: copied,
    collectionDomain,
    memberDomain,
    memberRoot,
    memberHash: logicalMapHash(memberRoot, memberDomain),
    population: count(memberRoot, memberDomain),
    ...(postedBalance === undefined
      ? {}
      : { postedBalance: balanceValue(postedBalance).toString() }),
  });
}
function decodeDescriptor(
  body: string,
  digest: string,
  profile: GroupCatalogFormat = GROUP_CATALOG_FORMAT,
): GroupDescriptor {
  requireLedger(
    new TextEncoder().encode(body).length <= MAX_DESCRIPTOR &&
      hash("descriptor", body, profile) === digest,
    "group_descriptor_corrupt",
  );
  const raw = JSON.parse(body) as GroupDescriptor;
  requireLedger(
    raw &&
      Object.keys(raw).sort().join(",") ===
        (raw.postedBalance === undefined
          ? "collectionDomain,format,key,memberDomain,memberHash,memberRoot,population"
          : "collectionDomain,format,key,memberDomain,memberHash,memberRoot,population,postedBalance") &&
      raw.key &&
      Object.keys(raw.key).sort().join(",") === "kind,values",
    "group_descriptor_corrupt",
  );
  requireLedger(supportsGroup(profile, raw.key), "group_query_profile_unsupported");
  const value = descriptor(raw.key, raw.collectionDomain, raw.memberRoot, raw.postedBalance);
  requireLedger(
    value.population !== "0" && JSON.stringify(value) === body,
    "group_descriptor_corrupt",
  );
  return value;
}
function collection(projection: Projection, name: string): LogicalProjectionCollection {
  const result = projection.collections.find((c) => c.name === name);
  requireLedger(result, "group_collection_missing");
  return result;
}
function directoryDomain(projection: Projection): string {
  return hashCanonical({
    profile: GROUP_CATALOG_FORMAT,
    collections: COLLECTIONS.map((name) => ({ name, domain: collection(projection, name).domain })),
  }).digest;
}
function put(values: Map<string, string>, digest: string, body: string) {
  requireLedger(!values.has(digest) || values.get(digest) === body, "group_content_collision");
  values.set(digest, body);
}
async function rebuild(projection: Projection) {
  const domain = directoryDomain(projection);
  const nodes = new Map<string, string>();
  const descriptors = new Map<string, string>();
  const groups = new Map<
    string,
    { key: SemanticGroupKey; collectionDomain: string; root: string }
  >();
  const read = async (digest: string) => nodes.get(digest);
  for (const name of COLLECTIONS) {
    const source = collection(projection, name);
    for (const row of source.rows) {
      for (const member of projectSemanticGroupMemberships(name, row.encoded, row.ordinal)) {
        const id = semanticGroupDigest(source.domain, member.group);
        const group = groups.get(id) ?? {
          key: member.group,
          collectionDomain: source.domain,
          root: emptyLogicalMap(id),
        };
        requireLedger(
          JSON.stringify(group.key) === JSON.stringify(member.group) &&
            group.collectionDomain === source.domain,
          "group_identity_collision",
        );
        const changed = await prepareLogicalChange(
          group.root,
          logicalMapHash(group.root, id),
          id,
          row.key,
          null,
          row.contentHash,
          read,
        );
        for (const node of changed.nodes) put(nodes, node.digest, node.encoded);
        group.root = changed.encodedRoot;
        groups.set(id, group);
      }
    }
  }
  let root = emptyLogicalMap(domain);
  for (const [id, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const body = JSON.stringify(descriptor(group.key, group.collectionDomain, group.root));
    const digest = hash("descriptor", body);
    put(descriptors, digest, body);
    const changed = await prepareLogicalChange(
      root,
      logicalMapHash(root, domain),
      domain,
      id,
      null,
      digest,
      read,
    );
    for (const node of changed.nodes) put(nodes, node.digest, node.encoded);
    root = changed.encodedRoot;
  }
  return {
    domain,
    root,
    rootHash: logicalMapHash(root, domain),
    population: count(root, domain),
    nodes,
    descriptors,
  };
}

/** Internal companion catalog, published in the SAME transaction as canonical
 * outcomes, source catalog and identity roots. Full canonical rebuild verification
 * remains mandatory; this class does not authorize a caller or provide lazy startup.
 * Old nodes/descriptors are retained. No garbage collection or auto-adoption. */
export class SqliteSemanticGroupCatalog {
  private readonly prepared = new WeakMap<object, Staged>();
  private readonly captured = new WeakMap<object, Metadata>();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly identityHash: string,
    private readonly anchor: () => {
      readonly identityHash: string;
      readonly headHash: string;
      readonly sourceCatalogDigest?: string;
    },
    readonly format: GroupCatalogFormat = GROUP_CATALOG_FORMAT,
  ) {
    requireLedger(
      format === GROUP_CATALOG_FORMAT ||
        format === INDEXED_GROUP_CATALOG_FORMAT ||
        format === INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT ||
        format === INDEXED_MONEY_GROUP_CATALOG_FORMAT ||
        format === INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
      "group_catalog_profile_invalid",
    );
  }
  private get collections(): readonly SemanticGroupCollection[] {
    return this.format === INDEXED_MONEY_GROUP_CATALOG_FORMAT ||
      this.format === INDEXED_REFERENCE_GROUP_CATALOG_FORMAT
      ? [...COLLECTIONS, "state.revisions", "state.journals"]
      : this.format === INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT
        ? [...COLLECTIONS, "state.revisions"]
        : COLLECTIONS;
  }
  private requireGroupProfile(key: SemanticGroupKey) {
    requireLedger(supportsGroup(this.format, key), "group_query_profile_unsupported");
  }
  private get tables() {
    return this.format === GROUP_CATALOG_FORMAT
      ? {
          catalog: "ledger_group_catalog",
          nodes: "ledger_group_nodes",
          descriptors: "ledger_group_descriptors",
        }
      : {
          catalog: "ledger_indexed_group_catalog",
          nodes: "ledger_indexed_group_nodes",
          descriptors: "ledger_indexed_group_descriptors",
        };
  }
  private hash(kind: string, body: string) {
    return hash(kind, body, this.format);
  }
  private rows(sql: string, ...bindings: string[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private cachedDigest?: string;
  private cachedBody?: string;
  private cachedValue?: Metadata;
  private bounded(kind: "catalog" | "nodes" | "descriptors", digest?: string) {
    const limit = kind === "descriptors" ? MAX_DESCRIPTOR : kind === "catalog" ? 8192 : 2048;
    const table = this.tables[kind];
    const rows = this.rows(
      `SELECT CAST(substr(CAST(body AS BLOB), 1, ${limit + 1}) AS TEXT) AS body, length(CAST(body AS BLOB)) AS body_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ${table} ${digest === undefined ? "" : "WHERE digest = ?"} LIMIT 2`,
      ...(digest === undefined ? [] : [digest]),
    );
    const row = rows[0];
    if (!row) return undefined;
    const bodyBytes = typeof row.body === "string" ? Buffer.byteLength(row.body) : -1;
    requireLedger(
      rows.length === 1 &&
        row &&
        typeof row.body === "string" &&
        row.body.length <= limit &&
        bodyBytes <= limit &&
        bodyBytes === row.body_bytes &&
        typeof row.digest === "string" &&
        HEX.test(row.digest) &&
        row.digest_bytes === 64 &&
        (digest === undefined || digest === row.digest),
      "group_catalog_corrupt",
    );
    return { body: row.body, digest: row.digest };
  }
  private load() {
    const stored = this.bounded("catalog");
    requireLedger(
      stored && this.hash("catalog", stored.body) === stored.digest,
      "group_catalog_corrupt",
    );
    if (
      this.cachedDigest === stored.digest &&
      this.cachedBody === stored.body &&
      this.cachedValue !== undefined
    ) {
      return { body: stored.body, digest: stored.digest, value: this.cachedValue };
    }
    const value = JSON.parse(stored.body) as Metadata;
    requireLedger(
      value &&
        Object.keys(value).sort().join(",") ===
          "domain,format,headHash,identityHash,population,root,rootHash" +
            (this.format !== GROUP_CATALOG_FORMAT ? ",sourceCatalogDigest" : "") &&
        value.format === this.format &&
        (this.format === GROUP_CATALOG_FORMAT ||
          (typeof value.sourceCatalogDigest === "string" && HEX.test(value.sourceCatalogDigest))) &&
        value.identityHash === this.identityHash &&
        typeof value.headHash === "string" &&
        HEX.test(value.headHash) &&
        logicalMapHash(value.root, value.domain) === value.rootHash &&
        count(value.root, value.domain) === value.population,
      "group_catalog_corrupt",
    );
    requireLedger(
      JSON.stringify({
        format: value.format,
        identityHash: value.identityHash,
        headHash: value.headHash,
        domain: value.domain,
        root: value.root,
        rootHash: value.rootHash,
        population: value.population,
        ...(this.format !== GROUP_CATALOG_FORMAT
          ? { sourceCatalogDigest: value.sourceCatalogDigest }
          : {}),
      }) === stored.body,
      "group_catalog_corrupt",
    );
    this.cachedDigest = stored.digest;
    this.cachedBody = stored.body;
    this.cachedValue = value;
    return { body: stored.body, digest: stored.digest, value };
  }
  private async node(digest: string) {
    return this.bounded("nodes", digest)?.body;
  }
  private group(digest: string) {
    const stored = this.bounded("descriptors", digest);
    requireLedger(stored, "group_descriptor_missing");
    return { ...stored, value: decodeDescriptor(stored.body, digest, this.format) };
  }
  capture(headHash: string, digest: string): CapturedGroupCatalog {
    const stored = this.load();
    requireLedger(
      stored.digest === digest && stored.value.headHash === headHash,
      "group_catalog_conflict",
    );
    const token = Object.freeze({ digest });
    this.captured.set(token, stored.value);
    return token;
  }
  release(capture: CapturedGroupCatalog): void {
    this.captured.delete(capture);
  }
  assertCurrent(capture: CapturedGroupCatalog): void {
    const selected = this.captured.get(capture);
    const anchor = this.anchor();
    requireLedger(
      selected &&
        this.load().digest === capture.digest &&
        anchor.identityHash === this.identityHash &&
        anchor.headHash === selected.headHash &&
        (this.format === GROUP_CATALOG_FORMAT ||
          anchor.sourceCatalogDigest === selected.sourceCatalogDigest),
      "group_catalog_conflict",
    );
  }
  /** Internal hash/ordinal page, not a source-verified accounting result. Only the
   * owner supplies the verified source collection domain and live-pin confirmation. */
  async readMembers(
    capture: CapturedGroupCatalog,
    collectionDomain: string,
    key: SemanticGroupKey,
    fromInclusive: string | null,
    limit: number,
    confirmPin: () => Promise<void>,
  ) {
    const copied = semanticGroupKey(key.kind, key.values);
    this.requireGroupProfile(copied);
    requireLedger(
      Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 256 &&
        (fromInclusive === null || (typeof fromInclusive === "string" && HEX.test(fromInclusive))),
      "group_query_invalid",
    );
    const confirm = async () => {
      await confirmPin();
      this.assertCurrent(capture);
    };
    await confirm();
    const selected = this.captured.get(capture);
    requireLedger(selected, "group_capture_invalid");
    const id = semanticGroupDigest(collectionDomain, copied);
    const read = async (digest: string) => {
      await confirm();
      const node = await this.node(digest);
      await confirm();
      return node;
    };
    const directory = await lookupLogicalValue(
      selected.root,
      selected.rootHash,
      selected.domain,
      id,
      read,
    );
    if (directory.value === null) {
      await confirm();
      return Object.freeze({
        memberHash: null,
        population: 0n,
        entries: Object.freeze([]),
        complete: true,
        nextFromInclusive: null,
      });
    }
    const descriptor = this.group(directory.value).value;
    requireLedger(
      descriptor.collectionDomain === collectionDomain &&
        descriptor.memberDomain === id &&
        JSON.stringify(descriptor.key) === JSON.stringify(copied),
      "group_identity_collision",
    );
    const page = await readLogicalRangePage(
      descriptor.memberRoot,
      descriptor.memberHash,
      id,
      fromInclusive,
      null,
      limit,
      read,
    );
    await confirm();
    return Object.freeze({
      memberHash: descriptor.memberHash,
      population: BigInt(descriptor.population),
      entries: page.entries,
      complete: page.complete,
      nextFromInclusive: page.nextFromInclusive,
    });
  }
  /** Greatest canonical row ordinal, not complete group enumeration. Requires
   * explicit coverage by this catalog profile; old catalogs cannot prove absence. */
  async readLastMember(
    capture: CapturedGroupCatalog,
    collectionDomain: string,
    key: SemanticGroupKey,
    confirmPin: () => Promise<void>,
  ) {
    const copied = semanticGroupKey(key.kind, key.values);
    this.requireGroupProfile(copied);
    requireLedger(
      new TextEncoder().encode(JSON.stringify(copied)).length <= 1_048_576,
      "group_query_key_too_large",
    );
    const confirm = async () => {
      await confirmPin();
      this.assertCurrent(capture);
    };
    await confirm();
    const selected = this.captured.get(capture);
    requireLedger(selected, "group_catalog_conflict");
    const id = semanticGroupDigest(collectionDomain, copied);
    const read = async (digest: string) => {
      await confirm();
      return this.node(digest);
    };
    const directory = await lookupLogicalValue(
      selected.root,
      selected.rootHash,
      selected.domain,
      id,
      read,
    );
    if (directory.value === null) {
      await confirm();
      return Object.freeze({ memberHash: null, population: 0n, entry: null });
    }
    const descriptor = this.group(directory.value).value;
    requireLedger(
      descriptor.collectionDomain === collectionDomain &&
        descriptor.memberDomain === id &&
        JSON.stringify(descriptor.key) === JSON.stringify(copied),
      "group_identity_collision",
    );
    const last = await readLogicalLastEntry(descriptor.memberRoot, descriptor.memberHash, id, read);
    requireLedger(
      last.entry !== null && last.population === BigInt(descriptor.population),
      "group_query_population_mismatch",
    );
    await confirm();
    return Object.freeze({
      memberHash: descriptor.memberHash,
      population: last.population,
      entry: last.entry,
    });
  }
  /** Authenticated derived summary at an owner-verified catalog. The digest alone
   * is not source authority: verifyIndexed must have proved the complete source
   * membership and independently recomputed this exact sum for the selected head. */
  async readPostedBalance(
    capture: CapturedGroupCatalog,
    collectionDomain: string,
    key: SemanticGroupKey,
    confirmPin: () => Promise<void>,
  ) {
    const copied = semanticGroupKey(key.kind, key.values);
    this.requireGroupProfile(copied);
    requireLedger(copied.kind === "journalsByMoneyScope", "group_balance_query_invalid");
    requireLedger(
      new TextEncoder().encode(JSON.stringify(copied)).length <= 1_048_576,
      "group_query_key_too_large",
    );
    const confirm = async () => {
      await confirmPin();
      this.assertCurrent(capture);
    };
    await confirm();
    const selected = this.captured.get(capture);
    requireLedger(selected, "group_capture_invalid");
    const id = semanticGroupDigest(collectionDomain, copied);
    const directory = await lookupLogicalValue(
      selected.root,
      selected.rootHash,
      selected.domain,
      id,
      async (digest) => {
        await confirm();
        return this.node(digest);
      },
    );
    if (directory.value === null) {
      await confirm();
      return Object.freeze({
        descriptorHash: null,
        memberHash: null,
        population: 0n,
        postedBalance: ExactRational.zero(),
      });
    }
    const descriptor = this.group(directory.value).value;
    requireLedger(
      descriptor.collectionDomain === collectionDomain &&
        descriptor.memberDomain === id &&
        JSON.stringify(descriptor.key) === JSON.stringify(copied) &&
        descriptor.postedBalance !== undefined,
      "group_identity_collision",
    );
    const postedBalance = balanceValue(descriptor.postedBalance);
    await confirm();
    return Object.freeze({
      descriptorHash: directory.value,
      memberHash: descriptor.memberHash,
      population: BigInt(descriptor.population),
      postedBalance,
    });
  }
  async verify(aggregate: DurableBookAggregate, headHash: string): Promise<string> {
    requireLedger(this.format === GROUP_CATALOG_FORMAT, "group_catalog_profile_invalid");
    const stored = this.load();
    const anchor = this.anchor();
    requireLedger(
      anchor.identityHash === this.identityHash &&
        anchor.headHash === headHash &&
        stored.value.headHash === headHash,
      "group_catalog_head_mismatch",
    );
    const projection = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
    const expected = await rebuild(projection);
    requireLedger(
      stored.value.domain === expected.domain &&
        stored.value.rootHash === expected.rootHash &&
        stored.value.population === expected.population,
      "group_catalog_projection_mismatch",
    );
    const directory = await auditLogicalMap(
      stored.value.root,
      stored.value.rootHash,
      stored.value.domain,
      (d) => this.node(d),
      async (key, digest) => {
        const group = this.group(digest);
        requireLedger(
          group.value.memberDomain === key && expected.descriptors.get(digest) === group.body,
          "group_catalog_projection_mismatch",
        );
        const members = await auditLogicalMap(
          group.value.memberRoot,
          group.value.memberHash,
          group.value.memberDomain,
          (d) => this.node(d),
        );
        requireLedger(
          String(members.population) === group.value.population,
          "group_catalog_population_mismatch",
        );
      },
    );
    requireLedger(
      String(directory.population) === stored.value.population,
      "group_catalog_population_mismatch",
    );
    requireLedger(
      this.load().digest === stored.digest && this.anchor().headHash === headHash,
      "group_catalog_conflict",
    );
    return stored.digest;
  }
  /** Bidirectional, complete reachable-population audit. The owner must supply
   * a separately replay-verified canonical anchor and source-prefix reader.
   * No whole-book arrays, rebuilt in-memory directory or persisted repair. */
  async verifyIndexed(
    source: SqliteIndexedSourceCatalog,
    expected: IndexedSourceAnchor,
    sourceDigest: string,
    groupDigest: string,
    ports: IndexedSourceReadPorts,
  ) {
    requireLedger(this.format !== GROUP_CATALOG_FORMAT, "group_catalog_profile_invalid");
    const selected = this.load();
    const expectedBytes = JSON.stringify(expected);
    const anchor = JSON.parse(expectedBytes) as IndexedSourceAnchor;
    const header = decodeBookStateHeader(anchor.state.header);
    requireLedger(
      header.disposition === "decoded" &&
        selected.digest === groupDigest &&
        selected.value.sourceCatalogDigest === sourceDigest &&
        selected.value.headHash === anchor.head.contentHash &&
        indexBookIdentityCommitment(anchor.head.identity) === this.identityHash,
      "group_catalog_context_invalid",
    );
    const identity = header.header.financialIdentityHash;
    const domain = hashCanonical({
      profile: this.format,
      collections: this.collections.map((name) => ({
        name,
        domain: indexedCollectionDomain(identity, name),
      })),
    }).digest;
    requireLedger(selected.value.domain === domain, "group_catalog_domain_mismatch");
    const capture = this.capture(anchor.head.contentHash, groupDigest);
    const sourceCapture = source.capture(sourceDigest);
    const copied = { confirm: ports.confirm, genesis: ports.genesis, outcome: ports.outcome };
    try {
      const confirm = async () => {
        await copied.confirm();
        this.assertCurrent(capture);
      };
      const read = async (digest: string) => {
        await confirm();
        const bytes = await this.node(digest);
        await confirm();
        return bytes;
      };
      await confirm();
      let expectedMembers = 0n;
      const audited = await source.audit(
        anchor,
        sourceDigest,
        { ...copied, confirm },
        async (row) => {
          if (!(this.collections as readonly string[]).includes(row.collection)) return;
          const collection = row.collection as SemanticGroupCollection;
          requireLedger(
            row.encoded !== null && row.rowHash !== null,
            "group_catalog_source_mismatch",
          );
          const collectionDomain = indexedCollectionDomain(identity, collection);
          for (const member of projectSemanticGroupMemberships(
            collection,
            row.encoded,
            row.ordinal,
          )) {
            if (!supportsGroup(this.format, member.group)) continue;
            const id = semanticGroupDigest(collectionDomain, member.group);
            const directory = await lookupLogicalValue(
              selected.value.root,
              selected.value.rootHash,
              domain,
              id,
              read,
            );
            requireLedger(directory.value !== null, "group_catalog_member_missing");
            const descriptor = this.group(directory.value).value;
            requireLedger(
              descriptor.collectionDomain === collectionDomain &&
                descriptor.memberDomain === id &&
                JSON.stringify(descriptor.key) === JSON.stringify(member.group),
              "group_identity_collision",
            );
            const found = await lookupLogicalValue(
              descriptor.memberRoot,
              descriptor.memberHash,
              id,
              row.ordinal.toString(16).padStart(64, "0"),
              read,
            );
            requireLedger(found.value === row.rowHash, "group_catalog_member_missing");
            expectedMembers++;
          }
        },
      );
      let actualMembers = 0n;
      const directory = await auditLogicalMap(
        selected.value.root,
        selected.value.rootHash,
        domain,
        read,
        async (id, hash) => {
          const descriptor = this.group(hash).value;
          const collection = SEMANTIC_GROUP_COLLECTIONS[descriptor.key.kind];
          requireLedger(
            descriptor.collectionDomain === indexedCollectionDomain(identity, collection) &&
              descriptor.memberDomain === id,
            "group_identity_collision",
          );
          this.requireGroupProfile(descriptor.key);
          let postedBalance = ExactRational.zero();
          const members = await auditLogicalMap(
            descriptor.memberRoot,
            descriptor.memberHash,
            id,
            read,
            async (key, rowHash) => {
              const row = await source.read(sourceCapture, collection, BigInt(`0x${key}`), {
                ...copied,
                confirm,
              });
              requireLedger(
                row.encoded !== null &&
                  row.rowHash === rowHash &&
                  projectSemanticGroupMemberships(collection, row.encoded, row.ordinal).some(
                    (member) => JSON.stringify(member.group) === JSON.stringify(descriptor.key),
                  ),
                "group_catalog_member_extraneous",
              );
              actualMembers++;
              if (descriptor.key.kind === "journalsByMoneyScope") {
                const contribution = encodedJournalMoneyScopeTotals(row.encoded).get(
                  JSON.stringify(descriptor.key),
                );
                requireLedger(contribution, "group_balance_source_missing");
                postedBalance = postedBalance.add(contribution.amount);
              }
            },
          );
          requireLedger(
            members.population.toString() === descriptor.population,
            "group_catalog_population_mismatch",
          );
          if (descriptor.key.kind === "journalsByMoneyScope")
            requireLedger(
              descriptor.postedBalance === postedBalance.toString(),
              "group_balance_source_mismatch",
            );
        },
      );
      requireLedger(
        directory.population.toString() === selected.value.population &&
          actualMembers === expectedMembers,
        "group_catalog_population_mismatch",
      );
      await confirm();
      // Even an empty directory must finish against the same valid source
      // catalog, not only a caller's anchor digest after the source pass ended.
      const finalSourceCapture = source.capture(sourceDigest);
      source.release(finalSourceCapture);
      return Object.freeze({
        sourceCatalogDigest: audited.catalogDigest,
        groupCatalogDigest: groupDigest,
        headHash: anchor.head.contentHash,
        sourceRows: audited.rows,
        groups: directory.population,
        members: actualMembers,
      });
    } finally {
      source.release(sourceCapture);
      this.release(capture);
    }
  }
  async prepare(
    before: {
      readonly aggregate: DurableBookAggregate;
      readonly headHash: string;
      readonly digest: string;
    } | null,
    after: DurableBookAggregate,
    headHash: string,
  ): Promise<Prepared> {
    requireLedger(this.format === GROUP_CATALOG_FORMAT, "group_catalog_profile_invalid");
    const beforeBytes =
      before === null
        ? null
        : encodeDurableBook({ state: before.aggregate.state, protocol: before.aggregate.protocol });
    const afterBytes = encodeDurableBook({ state: after.state, protocol: after.protocol });
    const prior = before === null ? null : this.load();
    requireLedger(
      before === null ||
        (prior?.digest === before.digest && prior.value.headHash === before.headHash),
      "group_catalog_conflict",
    );
    const oldProjection = beforeBytes === null ? null : await projectLegacyLogicalBook(beforeBytes);
    const nextProjection = await projectLegacyLogicalBook(afterBytes);
    const domain = directoryDomain(nextProjection);
    requireLedger(prior === null || prior.value.domain === domain, "group_catalog_domain_mismatch");
    const pending = new Map<
      string,
      { key: SemanticGroupKey; collectionDomain: string; deltas: SemanticGroupDelta[] }
    >();
    for (const name of COLLECTIONS) {
      const old = oldProjection === null ? null : collection(oldProjection, name);
      const next = collection(nextProjection, name);
      requireLedger(old === null || old.domain === next.domain, "group_catalog_domain_mismatch");
      for (let i = 0; i < Math.max(old?.rows.length ?? 0, next.rows.length); i++) {
        const was = old?.rows[i],
          now = next.rows[i];
        for (const delta of semanticGroupDeltas(
          name,
          BigInt(i) + 1n,
          was ? { encoded: was.encoded, rowHash: was.contentHash } : null,
          now ? { encoded: now.encoded, rowHash: now.contentHash } : null,
        )) {
          const id = semanticGroupDigest(next.domain, delta.group);
          const entry = pending.get(id) ?? {
            key: delta.group,
            collectionDomain: next.domain,
            deltas: [],
          };
          requireLedger(
            JSON.stringify(entry.key) === JSON.stringify(delta.group) &&
              entry.collectionDomain === next.domain,
            "group_identity_collision",
          );
          entry.deltas.push(delta);
          pending.set(id, entry);
        }
      }
    }
    const { root, nodes, descriptors } = await this.prepareGroupRoots(
      domain,
      prior?.value.root ?? null,
      pending,
    );
    const expected = await rebuild(nextProjection);
    requireLedger(
      logicalMapHash(root, domain) === expected.rootHash,
      "group_catalog_projection_mismatch",
    );
    const metadata: Metadata = {
      format: GROUP_CATALOG_FORMAT,
      identityHash: this.identityHash,
      headHash,
      domain,
      root,
      rootHash: logicalMapHash(root, domain),
      population: count(root, domain),
    };
    const body = JSON.stringify(metadata);
    requireLedger(
      typeof headHash === "string" &&
        HEX.test(headHash) &&
        new TextEncoder().encode(body).length <= 8192,
      "group_catalog_capacity_exceeded",
    );
    const result = Object.freeze({ digest: hash("catalog", body) });
    this.prepared.set(result, {
      priorDigest: prior?.digest ?? null,
      body,
      digest: result.digest,
      nodes,
      descriptors,
    });
    return result;
  }
  /** New-format companion only. Uses the source component's instance-local
   * prepared row changes and authenticated old rows, never a sparse BookState or
   * old/new whole-book projection. Accounting admission remains an owner duty. */
  async prepareIndexed(
    source: SqliteIndexedSourceCatalog,
    sourcePrepared: PreparedIndexedSourceCatalog,
    expectedPriorDigest: string | null,
    ports: IndexedGroupReadPorts,
  ): Promise<Prepared> {
    requireLedger(this.format !== GROUP_CATALOG_FORMAT, "group_catalog_profile_invalid");
    const plan = source.describePrepared(sourcePrepared);
    const { confirm, readPrevious } = ports;
    const capturedPlan = JSON.stringify(plan);
    requireLedger(
      indexBookIdentityCommitment(plan.after.head.identity) === this.identityHash &&
        (plan.before === null) === (expectedPriorDigest === null),
      "group_catalog_context_invalid",
    );
    const header = decodeBookStateHeader(plan.after.state.header);
    requireLedger(header.disposition === "decoded", "group_catalog_context_invalid");
    const identity = header.header.financialIdentityHash;
    const domain = hashCanonical({
      profile: this.format,
      collections: this.collections.map((name) => ({
        name,
        domain: indexedCollectionDomain(identity, name),
      })),
    }).digest;
    const prior = expectedPriorDigest === null ? null : this.load();
    if (prior === null) {
      requireLedger(
        this.rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) LIMIT 1",
          this.tables.catalog,
          this.tables.nodes,
          this.tables.descriptors,
        ).length === 0,
        "group_catalog_conflict",
      );
    } else
      requireLedger(
        prior.digest === expectedPriorDigest &&
          prior.value.domain === domain &&
          prior.value.headHash === plan.before?.head.contentHash &&
          prior.value.sourceCatalogDigest === plan.priorCatalogDigest,
        "group_catalog_conflict",
      );
    await confirm();
    const pending: PendingGroups = new Map();
    const cache = new Map<string, { encoded: string; rowHash: string } | null>();
    for (const change of plan.rows) {
      if (!(this.collections as readonly string[]).includes(change.collection)) continue;
      const collection = change.collection as SemanticGroupCollection;
      const ordinal = BigInt(change.ordinal),
        key = JSON.stringify([collection, change.ordinal]);
      let before = cache.get(key);
      if (!cache.has(key)) {
        if (change.previous === null) before = null;
        else {
          const {
            disposition,
            encoded,
            rowHash,
            catalogDigest,
            headHash,
            collection: actualCollection,
            ordinal: actualOrdinal,
          } = await readPrevious(collection, ordinal);
          requireLedger(
            disposition === "present" &&
              encoded !== null &&
              rowHash === change.previous &&
              catalogDigest === plan.priorCatalogDigest &&
              headHash === plan.before?.head.contentHash &&
              actualCollection === collection &&
              actualOrdinal === ordinal &&
              indexedRowCommitment(identity, collection, ordinal, encoded) === change.previous,
            "group_catalog_previous_row_mismatch",
          );
          before = Object.freeze({ encoded, rowHash });
        }
      }
      requireLedger(
        before !== undefined && (before?.rowHash ?? null) === change.previous,
        "group_catalog_row_order_mismatch",
      );
      const after =
        change.encoded === null
          ? null
          : Object.freeze({
              encoded: change.encoded,
              rowHash: indexedRowCommitment(identity, collection, ordinal, change.encoded),
            });
      requireLedger((after?.rowHash ?? null) === change.next, "group_catalog_next_row_mismatch");
      const previousAmounts =
        collection === "state.journals" && before !== null
          ? encodedJournalMoneyScopeTotals(before.encoded)
          : undefined;
      const nextAmounts =
        collection === "state.journals" && after !== null
          ? encodedJournalMoneyScopeTotals(after.encoded)
          : undefined;
      for (const delta of semanticGroupDeltas(collection, ordinal, before, after)) {
        if (!supportsGroup(this.format, delta.group)) continue;
        const collectionDomain = indexedCollectionDomain(identity, collection);
        const id = semanticGroupDigest(collectionDomain, delta.group);
        const entry: PendingGroup = pending.get(id) ?? {
          key: delta.group,
          collectionDomain,
          deltas: [],
        };
        requireLedger(
          JSON.stringify(entry.key) === JSON.stringify(delta.group) &&
            entry.collectionDomain === collectionDomain,
          "group_identity_collision",
        );
        entry.deltas.push(delta);
        if (delta.group.kind === "journalsByMoneyScope") {
          const scope = JSON.stringify(delta.group);
          const oldAmount = previousAmounts?.get(scope)?.amount ?? ExactRational.zero();
          const newAmount = nextAmounts?.get(scope)?.amount ?? ExactRational.zero();
          entry.balanceChange = (entry.balanceChange ?? ExactRational.zero()).add(
            newAmount.subtract(oldAmount),
          );
        }
        pending.set(id, entry);
      }
      cache.set(key, after);
    }
    const { root, nodes, descriptors } = await this.prepareGroupRoots(
      domain,
      prior?.value.root ?? null,
      pending,
    );
    await confirm();
    requireLedger(
      JSON.stringify(source.describePrepared(sourcePrepared)) === capturedPlan &&
        (prior === null || this.load().digest === prior.digest),
      "group_catalog_conflict",
    );
    const metadata: Metadata = {
      format: this.format,
      identityHash: this.identityHash,
      headHash: plan.after.head.contentHash,
      domain,
      root,
      rootHash: logicalMapHash(root, domain),
      population: count(root, domain),
      sourceCatalogDigest: plan.resultingCatalogDigest,
    };
    const body = JSON.stringify(metadata);
    requireLedger(new TextEncoder().encode(body).length <= 8192, "group_catalog_capacity_exceeded");
    const prepared = Object.freeze({ digest: this.hash("catalog", body) });
    this.prepared.set(prepared, {
      priorDigest: prior?.digest ?? null,
      body,
      digest: prepared.digest,
      nodes,
      descriptors,
      indexedSource: { catalog: source, prepared: sourcePrepared },
    });
    return prepared;
  }
  private async prepareGroupRoots(
    domain: string,
    priorRoot: string | null,
    pending: PendingGroups,
  ) {
    const nodes = new Map<string, string>();
    const descriptors = new Map<string, string>();
    let bytes = 0;
    const add = (values: Map<string, string>, digest: string, body: string) => {
      if (!values.has(digest)) bytes += new TextEncoder().encode(body).length;
      requireLedger(
        this.format === GROUP_CATALOG_FORMAT || bytes <= 32 * 1024 * 1024,
        "group_catalog_preparation_limit",
      );
      put(values, digest, body);
    };
    const read = async (digest: string) =>
      nodes.get(digest) ?? (priorRoot === null ? undefined : await this.node(digest));
    let root = priorRoot ?? emptyLogicalMap(domain);
    for (const [id, entry] of [...pending].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const found = await lookupLogicalValue(root, logicalMapHash(root, domain), domain, id, read);
      const original = found.value === null ? null : this.group(found.value).value;
      requireLedger(
        original === null ||
          (original.memberDomain === id &&
            original.collectionDomain === entry.collectionDomain &&
            JSON.stringify(original.key) === JSON.stringify(entry.key)),
        "group_identity_collision",
      );
      let memberRoot = original?.memberRoot ?? emptyLogicalMap(id);
      for (const delta of entry.deltas) {
        const changed = await prepareLogicalChange(
          memberRoot,
          logicalMapHash(memberRoot, id),
          id,
          delta.ordinal.toString(16).padStart(64, "0"),
          delta.before,
          delta.after,
          read,
        );
        for (const node of changed.nodes) add(nodes, node.digest, node.encoded);
        memberRoot = changed.encodedRoot;
      }
      let nextDigest: string | null = null;
      const postedBalance =
        entry.key.kind === "journalsByMoneyScope"
          ? balanceValue(original?.postedBalance ?? "0/1")
              .add(entry.balanceChange ?? ExactRational.zero())
              .toString()
          : undefined;
      if (count(memberRoot, id) !== "0") {
        const body = JSON.stringify(
          descriptor(entry.key, entry.collectionDomain, memberRoot, postedBalance),
        );
        requireLedger(
          new TextEncoder().encode(body).length <= MAX_DESCRIPTOR,
          "group_catalog_capacity_exceeded",
        );
        nextDigest = this.hash("descriptor", body);
        add(descriptors, nextDigest, body);
      } else
        requireLedger(
          postedBalance === undefined || postedBalance === "0/1",
          "group_balance_population_mismatch",
        );
      const changed = await prepareLogicalChange(
        root,
        logicalMapHash(root, domain),
        domain,
        id,
        found.value,
        nextDigest,
        read,
      );
      for (const node of changed.nodes) add(nodes, node.digest, node.encoded);
      root = changed.encodedRoot;
    }
    if (this.format !== GROUP_CATALOG_FORMAT) {
      const keepNodes = new Map<string, string>(),
        keepDescriptors = new Map<string, string>();
      const pending: { digest: string; directory: boolean }[] = [];
      const tree = JSON.parse(root).tree;
      if (tree !== null) pending.push({ digest: tree.digest, directory: true });
      while (pending.length > 0) {
        const item = pending.pop();
        if (!item || keepNodes.has(item.digest)) continue;
        const body = nodes.get(item.digest);
        if (body === undefined) continue;
        keepNodes.set(item.digest, body);
        const node = JSON.parse(body);
        if (node.kind === "branch")
          pending.push(
            { digest: node.left.digest, directory: item.directory },
            { digest: node.right.digest, directory: item.directory },
          );
        else if (item.directory) {
          const descriptor = descriptors.get(node.value);
          if (descriptor !== undefined) {
            keepDescriptors.set(node.value, descriptor);
            const members = JSON.parse(JSON.parse(descriptor).memberRoot).tree;
            if (members !== null) pending.push({ digest: members.digest, directory: false });
          }
        }
      }
      return { root, nodes: keepNodes, descriptors: keepDescriptors };
    }
    return { root, nodes, descriptors };
  }
  publishInTransaction(transaction: SqliteTransaction, prepared: Prepared): void {
    requireSqliteTransaction(transaction, this.storage);
    const staged = this.prepared.get(prepared);
    requireLedger(staged, "group_catalog_unprepared");
    const metadata = JSON.parse(staged.body) as Metadata;
    const anchor = this.anchor();
    requireLedger(
      anchor.identityHash === this.identityHash && anchor.headHash === metadata.headHash,
      "group_catalog_head_mismatch",
    );
    if (this.format !== GROUP_CATALOG_FORMAT) {
      requireLedger(
        staged.indexedSource &&
          anchor.sourceCatalogDigest === metadata.sourceCatalogDigest &&
          staged.indexedSource.prepared.digest === metadata.sourceCatalogDigest,
        "group_catalog_source_mismatch",
      );
      staged.indexedSource.catalog.assertPublishedInTransaction(
        transaction,
        staged.indexedSource.prepared,
      );
    }
    if (staged.priorDigest === null) {
      this.rows(
        `CREATE TABLE ${this.tables.catalog} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), body TEXT NOT NULL, digest TEXT NOT NULL)`,
      );
      this.rows(
        `CREATE TABLE ${this.tables.nodes} (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID`,
      );
      this.rows(
        `CREATE TABLE ${this.tables.descriptors} (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID`,
      );
    } else requireLedger(this.load().digest === staged.priorDigest, "group_catalog_conflict");
    for (const [table, values] of [
      ["nodes", staged.nodes],
      ["descriptors", staged.descriptors],
    ] as const) {
      for (const [digest, body] of values) {
        this.rows(
          `INSERT INTO ${this.tables[table]} (digest, body) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING`,
          digest,
          body,
        );
        requireLedger(this.bounded(table, digest)?.body === body, "group_content_collision");
      }
    }
    if (staged.priorDigest === null)
      this.rows(`INSERT INTO ${this.tables.catalog} VALUES (1, ?, ?)`, staged.body, staged.digest);
    else {
      this.rows(
        `UPDATE ${this.tables.catalog} SET body = ?, digest = ? WHERE singleton = 1 AND digest = ?`,
        staged.body,
        staged.digest,
        staged.priorDigest,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "group_catalog_conflict",
      );
    }
    if (this.format === GROUP_CATALOG_FORMAT) this.prepared.delete(prepared);
    else {
      const stored = this.bounded("catalog"),
        finalAnchor = this.anchor();
      requireLedger(
        stored?.digest === prepared.digest &&
          stored.body === staged.body &&
          finalAnchor.identityHash === this.identityHash &&
          finalAnchor.headHash === metadata.headHash &&
          finalAnchor.sourceCatalogDigest === metadata.sourceCatalogDigest,
        "group_catalog_publication_mismatch",
      );
      staged.indexedSource?.catalog.assertPublishedInTransaction(
        transaction,
        staged.indexedSource.prepared,
      );
    }
  }
}

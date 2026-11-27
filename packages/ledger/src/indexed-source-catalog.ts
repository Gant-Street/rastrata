import {
  decodeBookStateHeader,
  decodeDurableBook,
  encodeDurableBook,
  encodeBookRow,
  hashCanonical,
  immutableAccountingValue,
  type BookRowCollection,
  type RevisionRecord,
} from "@rastrata/kernel";
import {
  INDEXED_BOOK_COLLECTIONS,
  decodeIndexedBookHead,
  decodeIndexedBookState,
  encodeIndexedBookState,
  indexedCollectionDomain,
  indexedRowCommitment,
  prepareIndexedBookHead,
  projectLegacyIndexedBook,
  type IndexedBookState,
  type IndexedBookHead,
} from "./indexed-book-state.ts";
import {
  prepareIndexedOutcomeRecord,
  replayIndexedOutcomeProjection,
} from "./indexed-outcome-record.ts";
import {
  prepareIndexedBookOutcome,
  type IndexedOutcomeInput,
  type IndexedRowWrite,
} from "./indexed-book-change.ts";
import {
  projectIndexedOutcomeSource,
  resolveIndexedOutcomeSourceRow,
  type OutcomeSourceSelector,
  type IndexedOutcomeSourceAuthority,
} from "./outcome-source.ts";
import {
  emptyLogicalMap,
  logicalMapHash,
  lookupLogicalValue,
  prepareLogicalChange,
  auditLogicalMap,
} from "./logical-map.ts";
import { completeScope } from "./compact-records.ts";
import { requireLedger, type CompleteBookScope } from "./records.ts";
import { requireSqliteTransaction, type SqliteTransaction } from "./sqlite-transaction.ts";
import type { SqliteStorage } from "./sqlite.ts";
import type { CapturedRow } from "./source-catalog.ts";

export const INDEXED_SOURCE_CATALOG_VERSION = "rastrata-indexed-source-catalog-v1";
const MAX_CATALOG = 524288,
  MAX_VALUE = 2048,
  MAX_STAGED = 32 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;
type Locator = {
  readonly collection: BookRowCollection;
  readonly encodedRoot: string;
  readonly rootHash: string;
};
interface Catalog {
  readonly version: typeof INDEXED_SOURCE_CATALOG_VERSION;
  readonly genesisHash: string;
  readonly state: IndexedBookState;
  readonly head: IndexedBookHead;
  readonly locators: readonly Locator[];
}
type Origin =
  | { readonly kind: "genesis"; readonly digest: string }
  | {
      readonly kind: "outcome";
      readonly sequence: string;
      readonly recordHash: string;
      readonly selector: OutcomeSourceSelector;
    };
export interface PreparedIndexedSourceCatalog {
  readonly digest: string;
}
type Prepared = PreparedIndexedSourceCatalog;
interface Captured {
  readonly digest: string;
}
interface Staged {
  readonly prior: string | null;
  readonly body: string;
  readonly value: Catalog;
  readonly nodes: ReadonlyMap<string, string>;
  readonly origins: ReadonlyMap<string, string>;
  readonly changes: readonly IndexedRowWrite[];
}
export interface IndexedSourceAnchor {
  readonly genesisHash: string;
  readonly state: IndexedBookState;
  readonly head: IndexedBookHead;
}
export interface PreparedIndexedSourceChanges {
  readonly priorCatalogDigest: string | null;
  readonly resultingCatalogDigest: string;
  readonly before: IndexedSourceAnchor | null;
  readonly after: IndexedSourceAnchor;
  readonly rows: readonly IndexedRowWrite[];
}
export interface IndexedSourceReadPorts {
  /** Verify canonical prefix membership under the owner's live pin before returning bytes. */
  readonly outcome: (
    sequence: bigint,
    recordHash: string,
  ) => Promise<{ readonly encoded: string; readonly authority: IndexedOutcomeSourceAuthority }>;
  readonly genesis: (digest: string) => Promise<string>;
  readonly confirm: () => Promise<void>;
}
type SourcePorts = IndexedSourceReadPorts;
const utf8 = new TextEncoder();
const digest = (kind: string, body: string) =>
  hashCanonical({ domain: `${INDEXED_SOURCE_CATALOG_VERSION}/${kind}`, body }).digest;
const key = (ordinal: bigint) => ordinal.toString(16).padStart(64, "0");
function bounded(body: string, max: number) {
  requireLedger(
    typeof body === "string" && body.length <= max && utf8.encode(body).length <= max,
    "indexed_source_bytes_exceeded",
  );
}
export function indexedSourceGenesisHash(encoded: string) {
  bounded(encoded, 16 * 1024 * 1024);
  return digest("genesis", encoded);
}
function header(state: IndexedBookState) {
  const decoded = decodeBookStateHeader(state.header);
  requireLedger(decoded.disposition === "decoded", "indexed_source_header_invalid");
  return decoded.header;
}

/** Internal derived-store component, not a BookStorageAdapter or admission gate.
 * The canonical owner supplies verified anchors and one same-port transaction.
 * No migration, lazy startup, reclamation, receipt or enabled profile is provided. */
export class SqliteIndexedSourceCatalog {
  private readonly prepared = new WeakMap<object, Staged>();
  private readonly captured = new WeakMap<object, Catalog>();
  // Weak transaction keys neither retain nor extend authority. Every assertion
  // also checks the active same-port token; committed/rolled-back tokens expire.
  private readonly publications = new WeakMap<SqliteTransaction, WeakSet<Prepared>>();
  private readonly scope: CompleteBookScope;
  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    private readonly objectId: string,
    private readonly anchor: () => IndexedSourceAnchor,
  ) {
    this.scope = completeScope(scope, objectId);
  }
  private rows(sql: string, ...bindings: (string | number)[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private value(
    table:
      | "ledger_indexed_source_catalog"
      | "ledger_indexed_source_nodes"
      | "ledger_indexed_source_origins",
    hash?: string,
  ) {
    const max = table === "ledger_indexed_source_catalog" ? MAX_CATALOG : MAX_VALUE;
    const values = this.rows(
      `SELECT substr(body, 1, ${max + 1}) AS body, length(CAST(body AS BLOB)) AS bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ${table} ${hash === undefined ? "" : "WHERE digest = ?"} LIMIT 2`,
      ...(hash === undefined ? [] : [hash]),
    );
    if (values.length === 0) return undefined;
    const value = values[0];
    requireLedger(
      values.length === 1 &&
        value &&
        typeof value.body === "string" &&
        typeof value.digest === "string" &&
        HEX.test(value.digest) &&
        value.digest_bytes === 64 &&
        Buffer.byteLength(value.body) === value.bytes &&
        (hash === undefined || value.digest === hash),
      "indexed_source_corrupt",
    );
    bounded(value.body, max);
    return { body: value.body, digest: value.digest };
  }
  private node = async (hash: string) => this.value("ledger_indexed_source_nodes", hash)?.body;
  private locatorDomain(state: IndexedBookState, collection: BookRowCollection) {
    return hashCanonical({
      domain: `${INDEXED_SOURCE_CATALOG_VERSION}/locator`,
      scope: { ...this.scope },
      collectionDomain: indexedCollectionDomain(header(state).financialIdentityHash, collection),
    }).digest;
  }
  private frame(input: Catalog): Catalog {
    const state = decodeIndexedBookState(encodeIndexedBookState(input.state));
    const head = decodeIndexedBookHead(
      JSON.stringify(input.head),
      state,
      this.scope,
      this.objectId,
    );
    requireLedger(
      input.version === INDEXED_SOURCE_CATALOG_VERSION &&
        HEX.test(input.genesisHash) &&
        Array.isArray(input.locators) &&
        input.locators.length === INDEXED_BOOK_COLLECTIONS.length,
      "indexed_source_corrupt",
    );
    const locators = input.locators.map((item, i) => {
      const collection = INDEXED_BOOK_COLLECTIONS[i];
      requireLedger(collection && item.collection === collection, "indexed_source_corrupt");
      const domain = this.locatorDomain(state, collection);
      requireLedger(
        logicalMapHash(item.encodedRoot, domain) === item.rootHash,
        "indexed_source_corrupt",
      );
      const tree = JSON.parse(item.encodedRoot).tree;
      const count = state.collections[i]?.population;
      requireLedger(
        count !== undefined &&
          (tree === null
            ? count === "0"
            : tree.count === count && tree.min === key(1n) && tree.max === key(BigInt(count))),
        "indexed_source_population_mismatch",
      );
      return Object.freeze({ collection, encodedRoot: item.encodedRoot, rootHash: item.rootHash });
    });
    const result = Object.freeze({
      version: INDEXED_SOURCE_CATALOG_VERSION,
      genesisHash: input.genesisHash,
      state,
      head,
      locators: Object.freeze(locators),
    });
    bounded(JSON.stringify(result), MAX_CATALOG);
    return result;
  }
  private cachedDigest?: string;
  private cachedBody?: string;
  private cachedValue?: Catalog;
  private load() {
    const row = this.value("ledger_indexed_source_catalog");
    requireLedger(row && digest("catalog", row.body) === row.digest, "indexed_source_corrupt");
    if (
      this.cachedDigest === row.digest &&
      this.cachedBody === row.body &&
      this.cachedValue !== undefined
    ) {
      return { body: row.body, digest: row.digest, value: this.cachedValue };
    }
    const value = this.frame(JSON.parse(row.body));
    requireLedger(JSON.stringify(value) === row.body, "indexed_source_encoding_mismatch");
    this.cachedDigest = row.digest;
    this.cachedBody = row.body;
    this.cachedValue = value;
    return { ...row, value };
  }
  private assertAnchor(value: Catalog) {
    const anchor = this.anchor();
    const state = decodeIndexedBookState(encodeIndexedBookState(anchor.state));
    const head = decodeIndexedBookHead(
      JSON.stringify(anchor.head),
      state,
      this.scope,
      this.objectId,
    );
    requireLedger(
      JSON.stringify(head) === JSON.stringify(value.head) &&
        state.contentHash === value.state.contentHash &&
        anchor.genesisHash === value.genesisHash,
      "indexed_source_head_mismatch",
    );
    return anchor;
  }
  private stage(
    value: Catalog,
    prior: string | null,
    nodes: Map<string, string>,
    origins: Map<string, string>,
    changes: readonly IndexedRowWrite[] = [],
  ): Prepared {
    const framed = this.frame(value);
    // Prune only newly created intermediate nodes; stop at unchanged old nodes.
    const pending = [...framed.state.collections, ...framed.locators].flatMap((c) => {
      const tree = JSON.parse(c.encodedRoot).tree;
      return tree === null ? [] : [tree.digest as string];
    });
    const reachable = new Map<string, string>();
    while (pending.length > 0) {
      const hash = pending.pop();
      if (hash === undefined || reachable.has(hash)) continue;
      const bytes = nodes.get(hash);
      if (bytes === undefined) continue;
      reachable.set(hash, bytes);
      const node = JSON.parse(bytes);
      if (node.kind === "branch") pending.push(node.left.digest, node.right.digest);
    }
    const body = JSON.stringify(framed),
      token = Object.freeze({ digest: digest("catalog", body) });
    this.prepared.set(token, {
      prior,
      body,
      value: framed,
      nodes: reachable,
      origins,
      changes: Object.freeze(changes.map((row) => Object.freeze({ ...row }))),
    });
    return token;
  }
  /** New-book genesis only. Caller must atomically install the matching canonical genesis. */
  async prepareGenesis(encoded: string): Promise<Prepared> {
    const genesisHash = indexedSourceGenesisHash(encoded);
    const projected = await projectLegacyIndexedBook(encoded);
    const state = projected.state;
    requireLedger(
      state.collections.every(
        (c) => c.population === (c.collection === "state.configurationSnapshots" ? "1" : "0"),
      ),
      "indexed_source_genesis_required",
    );
    const head = prepareIndexedBookHead(this.scope, this.objectId, state, null, null);
    const nodes = new Map<string, string>(),
      origins = new Map<string, string>();
    const locators: Locator[] = [];
    const origin = JSON.stringify({ kind: "genesis", digest: genesisHash });
    const originHash = digest("origin", origin);
    origins.set(originHash, origin);
    for (const c of state.collections) {
      const domain = this.locatorDomain(state, c.collection);
      let root = emptyLogicalMap(domain),
        hash = logicalMapHash(root, domain);
      await auditLogicalMap(
        c.encodedRoot,
        c.rootHash,
        indexedCollectionDomain(header(state).financialIdentityHash, c.collection),
        async (id) => {
          const bytes = await projected.readNode(id);
          requireLedger(bytes !== undefined, "indexed_source_node_missing");
          nodes.set(id, bytes);
          return bytes;
        },
      );
      if (c.population === "1") {
        const next = await prepareLogicalChange(
          root,
          hash,
          domain,
          key(1n),
          null,
          originHash,
          projected.readNode,
        );
        root = next.encodedRoot;
        hash = next.rootHash;
        for (const node of next.nodes) nodes.set(node.digest, node.encoded);
      }
      locators.push({ collection: c.collection, encodedRoot: root, rootHash: hash });
    }
    return this.stage(
      { version: INDEXED_SOURCE_CATALOG_VERSION, genesisHash, state, head, locators },
      null,
      nodes,
      origins,
    );
  }
  /** Compose a separately admitted kernel decision with the authenticated current
   * logical roots. No full resulting BookState projection is needed here. The
   * serialized record is decoded/reprojected by prepareOutcome (the same delta
   * compiler, not an independent accounting oracle);
   * the owner still performs complete accounting replay before acknowledgement.
   * Neither the decision nor this staged handle grants publication authority. */
  async prepareAdmittedOutcome(
    input: IndexedOutcomeInput,
    expectedPriorDigest: string,
    confirm: () => Promise<void>,
  ) {
    // Snapshot the intent AND predecessor before any asynchronous callback.
    const decision = immutableAccountingValue(input);
    const prior = this.load();
    requireLedger(prior.digest === expectedPriorDigest, "indexed_source_conflict");
    const anchorBytes = JSON.stringify(this.assertAnchor(prior.value));
    const check = async () => {
      await confirm();
      // The complete catalog/anchor were validated above. Exact byte equality
      // rechecks that same evidence without rehashing/redecoding it per tree node.
      // Digest-only equality would miss body substitution under a retained digest.
      const current = this.value("ledger_indexed_source_catalog");
      requireLedger(
        current?.digest === prior.digest && current.body === prior.body,
        "indexed_source_conflict",
      );
      requireLedger(JSON.stringify(this.anchor()) === anchorBytes, "indexed_source_head_mismatch");
    };
    const candidate = await prepareIndexedBookOutcome(prior.value.state, decision, async (hash) => {
      await check();
      const bytes = await this.node(hash);
      await check();
      return bytes;
    });
    await check();
    const record = prepareIndexedOutcomeRecord(
      this.scope,
      this.objectId,
      prior.value.state,
      prior.value.head,
      candidate.state,
      candidate.encodedOutcome,
    );
    const prepared = await this.prepareOutcome(
      JSON.stringify(record),
      prior.digest,
      decision.kind === "commit" ? decision.previousRevision : null,
    );
    await check();
    return Object.freeze({ record, prepared, metrics: candidate.metrics });
  }
  async prepareOutcome(
    encoded: string,
    expectedPriorDigest: string,
    previousRevision: RevisionRecord | null,
  ): Promise<Prepared> {
    const prior = this.load();
    requireLedger(prior.digest === expectedPriorDigest, "indexed_source_conflict");
    this.assertAnchor(prior.value);
    const { state, head } = prior.value;
    const replay = await replayIndexedOutcomeProjection(
      encoded,
      this.scope,
      this.objectId,
      state,
      head,
      previousRevision,
      this.node,
    );
    const source = projectIndexedOutcomeSource(
      encoded,
      replay.record.contentHash,
      this.scope,
      this.objectId,
      state,
      head,
    );
    const selectors = new Map<string, OutcomeSourceSelector>();
    const counts = new Map(
      state.collections.map((c) => [c.collection as string, BigInt(c.population)]),
    );
    for (const group of source.groups) {
      let ordinal = group.mode === "replace" ? 0n : counts.get(group.collection);
      requireLedger(ordinal !== undefined, "indexed_source_collection_invalid");
      for (const row of group.rows) {
        ordinal++;
        requireLedger(
          row.ordinal === null || row.ordinal === ordinal,
          "indexed_source_ordinal_mismatch",
        );
        selectors.set(
          JSON.stringify([group.collection, ordinal.toString(), row.encoded]),
          row.selector,
        );
      }
      counts.set(group.collection, ordinal);
    }
    const nodes = new Map(replay.candidate.nodes.map((n) => [n.digest, n.encoded]));
    const origins = new Map<string, string>();
    let stagedBytes = [...nodes.values()].reduce((n, bytes) => n + utf8.encode(bytes).length, 0);
    const read = async (hash: string) => nodes.get(hash) ?? this.node(hash);
    const locators = new Map(prior.value.locators.map((c) => [c.collection, { ...c }]));
    for (const row of replay.candidate.rows) {
      const locator = locators.get(row.collection);
      requireLedger(locator, "indexed_source_collection_invalid");
      const domain = this.locatorDomain(state, row.collection),
        ordinal = BigInt(row.ordinal);
      const old = await lookupLogicalValue(
        locator.encodedRoot,
        locator.rootHash,
        domain,
        key(ordinal),
        read,
      );
      requireLedger(
        (old.value === null) === (row.previous === null),
        "indexed_source_origin_missing",
      );
      if (old.value !== null) {
        const body =
          origins.get(old.value) ?? this.value("ledger_indexed_source_origins", old.value)?.body;
        requireLedger(
          body !== undefined && digest("origin", body) === old.value,
          "indexed_source_origin_missing",
        );
      }
      let nextOrigin: string | null = null;
      if (row.encoded !== null) {
        const selector = selectors.get(JSON.stringify([row.collection, row.ordinal, row.encoded]));
        requireLedger(selector, "indexed_source_projection_mismatch");
        const body = JSON.stringify({
          kind: "outcome",
          sequence: source.sequence.toString(),
          recordHash: source.recordHash,
          selector,
        });
        bounded(body, MAX_VALUE);
        nextOrigin = digest("origin", body);
        if (!origins.has(nextOrigin)) stagedBytes += utf8.encode(body).length;
        origins.set(nextOrigin, body);
      }
      const next = await prepareLogicalChange(
        locator.encodedRoot,
        locator.rootHash,
        domain,
        key(ordinal),
        old.value,
        nextOrigin,
        read,
      );
      for (const node of next.nodes) {
        if (!nodes.has(node.digest)) stagedBytes += utf8.encode(node.encoded).length;
        nodes.set(node.digest, node.encoded);
      }
      requireLedger(stagedBytes <= MAX_STAGED, "indexed_source_preparation_limit");
      locator.encodedRoot = next.encodedRoot;
      locator.rootHash = next.rootHash;
    }
    for (const c of replay.candidate.state.collections)
      requireLedger(
        counts.get(c.collection)?.toString() === c.population,
        "indexed_source_projection_mismatch",
      );
    requireLedger(this.load().digest === prior.digest, "indexed_source_conflict");
    this.assertAnchor(prior.value);
    return this.stage(
      {
        version: INDEXED_SOURCE_CATALOG_VERSION,
        genesisHash: prior.value.genesisHash,
        state: replay.candidate.state,
        head: replay.record.after,
        locators: [...locators.values()],
      },
      prior.digest,
      nodes,
      origins,
      replay.candidate.rows,
    );
  }
  /** Read-only companion-index input. A caller-created digest is not a plan.
   * Old row bytes must still come from an authenticated source capture; this
   * exposes exact ordered row commitments, not accounting admission authority. */
  describePrepared(prepared: Prepared): PreparedIndexedSourceChanges {
    const candidate = this.prepared.get(prepared);
    requireLedger(candidate, "indexed_source_unprepared");
    let before: IndexedSourceAnchor | null = null;
    if (candidate.prior === null) {
      requireLedger(
        this.rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_indexed_source_catalog', 'ledger_indexed_source_nodes', 'ledger_indexed_source_origins') LIMIT 1",
        ).length === 0,
        "indexed_source_genesis_required",
      );
    } else {
      const current = this.load();
      requireLedger(current.digest === candidate.prior, "indexed_source_conflict");
      this.assertAnchor(current.value);
      before = Object.freeze({
        genesisHash: current.value.genesisHash,
        state: current.value.state,
        head: current.value.head,
      });
    }
    return Object.freeze({
      priorCatalogDigest: candidate.prior,
      resultingCatalogDigest: prepared.digest,
      before,
      after: Object.freeze({
        genesisHash: candidate.value.genesisHash,
        state: candidate.value.state,
        head: candidate.value.head,
      }),
      rows: candidate.changes,
    });
  }
  /** Companion publishers must select this exact source candidate in the same
   * transaction/port before publishing their own roots. Does not confirm sync. */
  assertPublishedInTransaction(transaction: SqliteTransaction, prepared: Prepared): void {
    requireSqliteTransaction(transaction, this.storage);
    const candidate = this.prepared.get(prepared);
    requireLedger(candidate, "indexed_source_unprepared");
    requireLedger(
      this.publications.get(transaction)?.has(prepared),
      "indexed_source_publication_transaction_mismatch",
    );
    const current = this.load();
    requireLedger(
      current.digest === prepared.digest && current.body === candidate.body,
      "indexed_source_publication_mismatch",
    );
    this.assertAnchor(candidate.value);
  }
  /** No sync or receipt here. Opaque prepared handles are owner/instance-local.
   * Consumption is retry-safe after rollback: a rolled-back token may be retried;
   * a committed candidate fails the prior-catalog CAS on a second publication. */
  publishInTransaction(transaction: SqliteTransaction, prepared: Prepared): void {
    requireSqliteTransaction(transaction, this.storage);
    const candidate = this.prepared.get(prepared);
    requireLedger(candidate, "indexed_source_unprepared");
    this.assertAnchor(candidate.value);
    if (candidate.prior === null) {
      this.rows(
        "CREATE TABLE ledger_indexed_source_catalog (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), body TEXT NOT NULL, digest TEXT NOT NULL)",
      );
      this.rows(
        "CREATE TABLE ledger_indexed_source_nodes (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
      );
      this.rows(
        "CREATE TABLE ledger_indexed_source_origins (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
      );
    } else requireLedger(this.load().digest === candidate.prior, "indexed_source_conflict");
    for (const [table, values] of [
      ["ledger_indexed_source_nodes", candidate.nodes],
      ["ledger_indexed_source_origins", candidate.origins],
    ] as const) {
      for (const [hash, body] of values) {
        this.rows(
          `INSERT INTO ${table} (digest, body) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING`,
          hash,
          body,
        );
        requireLedger(this.value(table, hash)?.body === body, "indexed_source_content_collision");
      }
    }
    if (candidate.prior === null)
      this.rows(
        "INSERT INTO ledger_indexed_source_catalog VALUES (1, ?, ?)",
        candidate.body,
        prepared.digest,
      );
    else {
      this.rows(
        "UPDATE ledger_indexed_source_catalog SET body = ?, digest = ? WHERE singleton = 1 AND digest = ?",
        candidate.body,
        prepared.digest,
        candidate.prior,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "indexed_source_conflict",
      );
    }
    const persisted = this.value("ledger_indexed_source_catalog");
    requireLedger(
      persisted?.digest === prepared.digest && persisted.body === candidate.body,
      "indexed_source_publication_mismatch",
    );
    this.assertAnchor(candidate.value);
    const published = this.publications.get(transaction) ?? new WeakSet<Prepared>();
    published.add(prepared);
    this.publications.set(transaction, published);
  }
  capture(expectedDigest: string): Captured {
    const current = this.load();
    requireLedger(current.digest === expectedDigest, "indexed_source_conflict");
    this.assertAnchor(current.value);
    const token = Object.freeze({ digest: current.digest });
    this.captured.set(token, current.value);
    return token;
  }
  release(capture: Captured) {
    this.captured.delete(capture);
  }
  assertCurrent(capture: Captured): void {
    const value = this.captured.get(capture);
    requireLedger(value, "indexed_source_capture_invalid");
    requireLedger(this.load().digest === capture.digest, "indexed_source_conflict");
    this.assertAnchor(value);
  }
  collectionDomain(capture: Captured, collection: BookRowCollection): string {
    this.assertCurrent(capture);
    const value = this.captured.get(capture);
    requireLedger(value, "indexed_source_capture_invalid");
    return indexedCollectionDomain(header(value.state).financialIdentityHash, collection);
  }
  /** Complete reachable-index audit against an independently verified canonical
   * anchor. This is not accounting replay, source-prefix authentication or a
   * readiness token. Owner confirmation supplies cancellation/work budgeting.
   * Streams one row at a time; failures return no completed audit summary. */
  async audit(
    expected: IndexedSourceAnchor,
    expectedDigest: string,
    ports: IndexedSourceReadPorts,
    observe?: (row: CapturedRow) => void | Promise<void>,
  ) {
    const expectedBytes = JSON.stringify({
      genesisHash: expected.genesisHash,
      state: expected.state,
      head: expected.head,
    });
    const copied = { confirm: ports.confirm, genesis: ports.genesis, outcome: ports.outcome };
    const capture = this.capture(expectedDigest);
    try {
      const value = this.captured.get(capture);
      requireLedger(
        value &&
          JSON.stringify({
            genesisHash: value.genesisHash,
            state: value.state,
            head: value.head,
          }) === expectedBytes,
        "indexed_source_audit_anchor_mismatch",
      );
      const confirm = async () => {
        await copied.confirm();
        requireLedger(
          this.captured.get(capture) === value && this.load().digest === capture.digest,
          "indexed_source_conflict",
        );
        this.assertAnchor(value);
      };
      const read = async (hash: string) => {
        await confirm();
        const bytes = await this.node(hash);
        await confirm();
        return bytes;
      };
      await confirm();
      let rows = 0n;
      for (const root of value.state.collections) {
        let ordinal = 0n;
        const financial = await auditLogicalMap(
          root.encodedRoot,
          root.rootHash,
          indexedCollectionDomain(header(value.state).financialIdentityHash, root.collection),
          read,
          async (key, hash) => {
            ordinal++;
            requireLedger(BigInt(`0x${key}`) === ordinal, "indexed_source_audit_ordinal_gap");
            const row = await this.read(capture, root.collection, ordinal, copied);
            requireLedger(
              row.disposition === "present" && row.rowHash === hash,
              "indexed_source_audit_row_mismatch",
            );
            await observe?.(row);
            await confirm();
            rows++;
          },
        );
        const locator = value.locators.find((c) => c.collection === root.collection);
        requireLedger(locator, "indexed_source_collection_invalid");
        const origins = await auditLogicalMap(
          locator.encodedRoot,
          locator.rootHash,
          this.locatorDomain(value.state, root.collection),
          read,
        );
        requireLedger(
          financial.population === BigInt(root.population) &&
            origins.population === financial.population,
          "indexed_source_population_mismatch",
        );
      }
      await confirm();
      return Object.freeze({
        catalogDigest: capture.digest,
        headHash: value.head.contentHash,
        rows,
      });
    } finally {
      this.release(capture);
    }
  }
  async read(
    capture: Captured,
    collection: BookRowCollection,
    ordinal: bigint,
    ports: SourcePorts,
  ) {
    const value = this.captured.get(capture);
    requireLedger(
      value && typeof ordinal === "bigint" && ordinal > 0n && ordinal <= (1n << 64n) - 1n,
      "indexed_source_capture_invalid",
    );
    const confirm = async () => {
      await ports.confirm();
      requireLedger(
        this.captured.get(capture) === value && this.load().digest === capture.digest,
        "indexed_source_conflict",
      );
      this.assertAnchor(value);
    };
    try {
      await confirm();
      const root = value.state.collections.find((c) => c.collection === collection),
        locator = value.locators.find((c) => c.collection === collection);
      requireLedger(root && locator, "indexed_source_collection_invalid");
      const identityHash = header(value.state).financialIdentityHash;
      const row = await lookupLogicalValue(
        root.encodedRoot,
        root.rootHash,
        indexedCollectionDomain(identityHash, collection),
        key(ordinal),
        this.node,
      );
      const origin = await lookupLogicalValue(
        locator.encodedRoot,
        locator.rootHash,
        this.locatorDomain(value.state, collection),
        key(ordinal),
        this.node,
      );
      requireLedger(
        (row.value === null) === (origin.value === null) &&
          (row.value === null) === ordinal > BigInt(root.population),
        "indexed_source_row_missing",
      );
      let encoded: string | null = null;
      if (row.value !== null && origin.value !== null) {
        const stored = this.value("ledger_indexed_source_origins", origin.value);
        requireLedger(
          stored && digest("origin", stored.body) === origin.value,
          "indexed_source_origin_missing",
        );
        const source = JSON.parse(stored.body) as Origin;
        if (source.kind === "genesis") {
          requireLedger(
            JSON.stringify({ kind: "genesis", digest: source.digest }) === stored.body &&
              source.digest === value.genesisHash,
            "indexed_source_origin_invalid",
          );
          const bytes = await ports.genesis(source.digest);
          requireLedger(
            indexedSourceGenesisHash(bytes) === source.digest,
            "indexed_source_origin_invalid",
          );
          const decoded = decodeDurableBook(bytes);
          requireLedger(
            decoded.disposition === "decoded" &&
              encodeDurableBook(decoded.aggregate) === bytes &&
              collection === "state.configurationSnapshots" &&
              ordinal === 1n,
            "indexed_source_origin_invalid",
          );
          const configuration = decoded.aggregate.state.configurationSnapshots[0];
          requireLedger(configuration, "indexed_source_origin_invalid");
          encoded = encodeBookRow(collection, configuration);
        } else {
          requireLedger(
            source.kind === "outcome" &&
              typeof source.sequence === "string" &&
              /^[1-9][0-9]{0,19}$/.test(source.sequence) &&
              BigInt(source.sequence) <= BigInt(value.head.sequence) &&
              HEX.test(source.recordHash) &&
              JSON.stringify({
                kind: "outcome",
                sequence: source.sequence,
                recordHash: source.recordHash,
                selector: source.selector,
              }) === stored.body,
            "indexed_source_origin_invalid",
          );
          const record = await ports.outcome(BigInt(source.sequence), source.recordHash);
          requireLedger(
            record.authority.recordHash === source.recordHash &&
              BigInt(record.authority.beforeHead.sequence) + 1n === BigInt(source.sequence) &&
              JSON.stringify(completeScope(record.authority.scope, this.objectId)) ===
                JSON.stringify(this.scope),
            "indexed_source_origin_invalid",
          );
          encoded = resolveIndexedOutcomeSourceRow(
            record.encoded,
            record.authority,
            { collection, ordinal, selector: source.selector },
            row.value,
          );
        }
        requireLedger(
          indexedRowCommitment(identityHash, collection, ordinal, encoded) === row.value,
          "indexed_source_row_mismatch",
        );
      }
      await confirm();
      return Object.freeze({
        collection,
        ordinal,
        encoded,
        rowHash: row.value,
        catalogDigest: capture.digest,
        headHash: value.head.contentHash,
        disposition: encoded === null ? ("absent" as const) : ("present" as const),
      });
    } catch (error) {
      this.release(capture);
      throw error;
    }
  }
}

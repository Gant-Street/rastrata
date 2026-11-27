import { encodeDurableBook, hashCanonical, type DurableBookAggregate } from "@rastrata/kernel";
import { projectLegacyLogicalBook } from "./logical-book.ts";
import {
  emptyLogicalMap,
  logicalMapHash,
  lookupLogicalValue,
  prepareLogicalChange,
  auditLogicalMap,
} from "./logical-map.ts";
import {
  projectOutcomeSource,
  resolveOutcomeSourceRow,
  type OutcomeSourceSelector,
} from "./outcome-source.ts";
import {
  requireLedger,
  verifiedOutcomeRecordHash,
  COMPACT_LEDGER_FORMAT,
  type StoredBook,
  type OutcomeRecord,
} from "./records.ts";
import { ledgerIndexHeadCommitment } from "./index-view-audit.ts";
import { requireSqliteTransaction, type SqliteTransaction } from "./sqlite-transaction.ts";
import type { SqliteStorage } from "./sqlite.ts";

export const SOURCE_CATALOG_FORMAT = "rastrata-source-catalog-candidate-v1";
const MAX_CATALOG = 131_072;
const MAX_NODE = 2048;
interface Collection {
  readonly name: string;
  readonly domain: string;
  readonly population: string;
  readonly encodedRoot: string;
  readonly rootHash: string;
  readonly locatorDomain: string;
  readonly locatorRoot: string;
  readonly locatorHash: string;
}
interface Catalog {
  readonly format: typeof SOURCE_CATALOG_FORMAT;
  readonly identityHash: string;
  readonly headHash: string;
  readonly headerHash: string;
  readonly stateRoot: string;
  readonly protocolRoot: string;
  readonly collections: readonly Collection[];
}
type Origin =
  | { readonly kind: "genesis"; readonly digest: string }
  | {
      readonly kind: "outcome";
      readonly sequence: string;
      readonly recordHash: string;
      readonly selector: OutcomeSourceSelector;
    };
interface Staged {
  readonly priorDigest: string | null;
  readonly body: string;
  readonly digest: string;
  readonly nodes: ReadonlyMap<string, string>;
  readonly origins: ReadonlyMap<string, string>;
}
interface Prepared {
  readonly digest: string;
}
export interface CapturedSourceCatalog {
  readonly digest: string;
}
export interface CapturedRow {
  readonly disposition: "present" | "absent";
  readonly catalogDigest: string;
  readonly headHash: string;
  readonly collection: string;
  readonly ordinal: bigint;
  readonly rowHash: string | null;
  readonly encoded: string | null;
}
interface SourceReadPorts {
  readonly confirm: () => Promise<void>;
  readonly outcome: (sequence: bigint, recordHash: string) => OutcomeRecord;
  readonly genesis: (digest: string) => string;
}
type Projection = Awaited<ReturnType<typeof projectLegacyLogicalBook>>;
function catalogHash(body: string) {
  return hashCanonical({ domain: SOURCE_CATALOG_FORMAT, body }).digest;
}
function originHash(body: string) {
  return hashCanonical({ domain: `${SOURCE_CATALOG_FORMAT}/origin`, body }).digest;
}
function locatorDomain(domain: string) {
  return hashCanonical({ domain: `${SOURCE_CATALOG_FORMAT}/locator`, collectionDomain: domain })
    .digest;
}
function key(ordinal: bigint) {
  return ordinal.toString(16).padStart(64, "0");
}

/** Internal opt-in derived catalog. No page deletion or lazy startup. A complete
 * verified legacy projection is still the semantic authority/comparison oracle.
 * All staged bytes publish with the canonical outcome in the owner's transaction. */
export class SqliteSourceCatalog {
  private readonly prepared = new WeakMap<object, Staged>();
  private readonly captured = new WeakMap<object, Catalog>();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly identityHash: string,
    private readonly anchor: () => { readonly identityHash: string; readonly headHash: string },
  ) {}
  private rows(sql: string, ...bindings: (string | number)[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private bounded(
    table: "ledger_source_catalog" | "ledger_source_nodes" | "ledger_source_origins",
    digest?: string,
  ) {
    const limit = table === "ledger_source_catalog" ? MAX_CATALOG : MAX_NODE;
    const rows = this.rows(
      `SELECT substr(body, 1, ${limit + 1}) AS body, length(CAST(body AS BLOB)) AS body_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ${table} ${digest === undefined ? "" : "WHERE digest = ?"} LIMIT 2`,
      ...(digest === undefined ? [] : [digest]),
    );
    if (rows.length === 0) return undefined;
    const value = rows[0];
    requireLedger(
      rows.length === 1 &&
        value &&
        typeof value.body === "string" &&
        value.body.length <= limit &&
        new TextEncoder().encode(value.body).length === value.body_bytes &&
        typeof value.digest === "string" &&
        /^[0-9a-f]{64}$/.test(value.digest) &&
        value.digest_bytes === 64 &&
        (digest === undefined || value.digest === digest),
      "source_catalog_corrupt",
    );
    return { body: value.body, digest: value.digest };
  }
  private async node(digest: string) {
    return this.bounded("ledger_source_nodes", digest)?.body;
  }
  private load() {
    const row = this.bounded("ledger_source_catalog");
    requireLedger(row && row.digest === catalogHash(row.body), "source_catalog_corrupt");
    const value = JSON.parse(row.body) as Catalog;
    requireLedger(
      value &&
        value.format === SOURCE_CATALOG_FORMAT &&
        value.identityHash === this.identityHash &&
        Object.keys(value).sort().join(",") ===
          "collections,format,headHash,headerHash,identityHash,protocolRoot,stateRoot" &&
        Array.isArray(value.collections) &&
        value.collections.length === 24,
      "source_catalog_corrupt",
    );
    for (const c of value.collections) {
      requireLedger(
        c &&
          Object.keys(c).sort().join(",") ===
            "domain,encodedRoot,locatorDomain,locatorHash,locatorRoot,name,population,rootHash" &&
          typeof c.name === "string" &&
          typeof c.population === "string" &&
          /^(0|[1-9][0-9]{0,19})$/.test(c.population) &&
          c.locatorDomain === locatorDomain(c.domain) &&
          logicalMapHash(c.encodedRoot, c.domain) === c.rootHash &&
          logicalMapHash(c.locatorRoot, c.locatorDomain) === c.locatorHash,
        "source_catalog_corrupt",
      );
    }
    requireLedger(
      new Set(value.collections.map((c) => c.name)).size === 24,
      "source_catalog_corrupt",
    );
    return { ...row, value };
  }
  private assertProjection(value: Catalog, projection: Projection, headHash: string) {
    requireLedger(
      value.headHash === headHash &&
        value.headerHash === projection.headerHash &&
        value.stateRoot === projection.stateRoot &&
        value.protocolRoot === projection.protocolRoot,
      "source_catalog_head_mismatch",
    );
    for (const expected of projection.collections) {
      const actual = value.collections.find((c) => c.name === expected.name);
      requireLedger(
        actual &&
          actual.domain === expected.domain &&
          actual.encodedRoot === expected.encodedRoot &&
          actual.rootHash === expected.rootHash &&
          actual.population === String(expected.rows.length),
        "source_catalog_projection_mismatch",
      );
    }
  }
  capture(expectedHeadHash: string, expectedDigest: string): CapturedSourceCatalog {
    const stored = this.load();
    requireLedger(
      stored.digest === expectedDigest && stored.value.headHash === expectedHeadHash,
      "source_catalog_conflict",
    );
    const token = Object.freeze({ digest: stored.digest });
    this.captured.set(token, stored.value);
    return token;
  }
  release(capture: CapturedSourceCatalog): void {
    this.captured.delete(capture);
  }
  collectionDomain(capture: CapturedSourceCatalog, name: string): string {
    this.assertCurrent(capture);
    const selected = this.captured.get(capture)?.collections.find((c) => c.name === name);
    requireLedger(selected, "source_catalog_collection_unknown");
    return selected.domain;
  }
  assertCurrent(capture: CapturedSourceCatalog): void {
    const catalog = this.captured.get(capture);
    requireLedger(
      catalog &&
        this.load().digest === capture.digest &&
        this.anchor().headHash === catalog.headHash,
      "source_catalog_conflict",
    );
  }
  async readCaptured(
    capture: CapturedSourceCatalog,
    collection: string,
    ordinal: bigint,
    ports: SourceReadPorts,
  ): Promise<CapturedRow> {
    requireLedger(
      typeof collection === "string" &&
        collection.length <= 128 &&
        typeof ordinal === "bigint" &&
        ordinal > 0n &&
        ordinal < 1n << 256n,
      "source_catalog_query_invalid",
    );
    const catalog = this.captured.get(capture);
    requireLedger(catalog, "source_catalog_capture_invalid");
    const selected = catalog.collections.find((c) => c.name === collection);
    requireLedger(selected, "source_catalog_collection_unknown");
    const confirm = async () => {
      await ports.confirm();
      this.assertCurrent(capture);
    };
    await confirm();
    const rowKey = key(ordinal);
    const financial = await lookupLogicalValue(
      selected.encodedRoot,
      selected.rootHash,
      selected.domain,
      rowKey,
      (digest) => this.node(digest),
    );
    const pointer = await lookupLogicalValue(
      selected.locatorRoot,
      selected.locatorHash,
      selected.locatorDomain,
      rowKey,
      (digest) => this.node(digest),
    );
    let encoded: string | null = null;
    if (financial.value === null) {
      requireLedger(
        pointer.value === null && ordinal > BigInt(selected.population),
        "source_catalog_population_mismatch",
      );
    } else {
      requireLedger(
        pointer.value !== null && ordinal <= BigInt(selected.population),
        "source_catalog_origin_missing",
      );
      const source = this.bounded("ledger_source_origins", pointer.value);
      requireLedger(
        source && originHash(source.body) === pointer.value,
        "source_catalog_origin_corrupt",
      );
      const origin = JSON.parse(source.body) as Origin;
      if (origin.kind === "genesis") {
        requireLedger(
          Object.keys(origin).sort().join(",") === "digest,kind",
          "source_catalog_origin_mismatch",
        );
        const initial = await projectLegacyLogicalBook(ports.genesis(origin.digest));
        const sourceRow = initial.collections.find((c) => c.name === collection)?.rows[
          Number(ordinal - 1n)
        ];
        requireLedger(
          sourceRow && sourceRow.contentHash === financial.value,
          "source_catalog_origin_mismatch",
        );
        encoded = sourceRow.encoded;
      } else {
        requireLedger(
          origin.kind === "outcome" &&
            Object.keys(origin).sort().join(",") === "kind,recordHash,selector,sequence" &&
            typeof origin.sequence === "string" &&
            /^[1-9][0-9]{0,19}$/.test(origin.sequence),
          "source_catalog_origin_mismatch",
        );
        const record = ports.outcome(BigInt(origin.sequence), origin.recordHash);
        encoded = resolveOutcomeSourceRow(
          record,
          origin.recordHash,
          { collection, ordinal, selector: origin.selector },
          selected.domain,
          financial.value,
        );
      }
    }
    await confirm();
    return Object.freeze({
      disposition: encoded === null ? "absent" : "present",
      catalogDigest: capture.digest,
      headHash: catalog.headHash,
      collection,
      ordinal,
      rowHash: financial.value,
      encoded,
    });
  }
  async verify(book: StoredBook, aggregate: DurableBookAggregate) {
    const stored = this.load();
    const projection = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
    this.assertProjection(
      stored.value,
      projection,
      ledgerIndexHeadCommitment(book.head, COMPACT_LEDGER_FORMAT),
    );
    const genesis = await projectLegacyLogicalBook(book.genesis);
    for (const c of stored.value.collections) {
      const expected = projection.collections.find((x) => x.name === c.name);
      requireLedger(expected, "source_catalog_projection_mismatch");
      for (const [root, hash, domain] of [
        [c.encodedRoot, c.rootHash, c.domain],
        [c.locatorRoot, c.locatorHash, c.locatorDomain],
      ]) {
        requireLedger(root && hash && domain, "source_catalog_corrupt");
        const audit = await auditLogicalMap(root, hash, domain, (digest) => this.node(digest));
        requireLedger(
          audit.population === BigInt(c.population),
          "source_catalog_population_mismatch",
        );
      }
      for (const row of expected.rows) {
        const pointer = await lookupLogicalValue(
          c.locatorRoot,
          c.locatorHash,
          c.locatorDomain,
          row.key,
          (digest) => this.node(digest),
        );
        requireLedger(pointer.value !== null, "source_catalog_origin_missing");
        const origin = this.bounded("ledger_source_origins", pointer.value);
        requireLedger(
          origin && origin.digest === originHash(origin.body),
          "source_catalog_origin_corrupt",
        );
        const value = JSON.parse(origin.body) as Origin;
        if (value.kind === "genesis") {
          requireLedger(
            Object.keys(value).sort().join(",") === "digest,kind" &&
              value.digest === book.genesisDigest &&
              genesis.collections.find((x) => x.name === c.name)?.rows[Number(row.ordinal - 1n)]
                ?.encoded === row.encoded,
            "source_catalog_origin_mismatch",
          );
        } else {
          requireLedger(
            value.kind === "outcome" &&
              Object.keys(value).sort().join(",") === "kind,recordHash,selector,sequence" &&
              typeof value.sequence === "string" &&
              /^[1-9][0-9]{0,3}$/.test(value.sequence) &&
              BigInt(value.sequence) <= BigInt(book.head.sequence),
            "source_catalog_origin_mismatch",
          );
          const record = book.outcomes[Number(value.sequence) - 1];
          requireLedger(
            record &&
              record.after.sequence === value.sequence &&
              verifiedOutcomeRecordHash(record) === value.recordHash,
            "source_catalog_origin_mismatch",
          );
          requireLedger(
            resolveOutcomeSourceRow(
              record,
              value.recordHash,
              { collection: c.name, ordinal: row.ordinal, selector: value.selector },
              c.domain,
              row.contentHash,
            ) === row.encoded,
            "source_catalog_origin_mismatch",
          );
        }
      }
    }
    requireLedger(this.load().digest === stored.digest, "source_catalog_conflict");
    return stored.digest;
  }
  async prepare(
    book: StoredBook,
    after: DurableBookAggregate,
    record?: OutcomeRecord,
    expectedPriorDigest?: string,
  ): Promise<Prepared> {
    const prior = record === undefined ? undefined : this.load();
    requireLedger(
      record === undefined || prior?.digest === expectedPriorDigest,
      "source_catalog_conflict",
    );
    requireLedger(
      record === undefined
        ? book.head.sequence === "0"
        : prior?.value.headHash === ledgerIndexHeadCommitment(record.before, COMPACT_LEDGER_FORMAT),
      "source_catalog_head_mismatch",
    );
    const projection = await projectLegacyLogicalBook(
      encodeDurableBook({ state: after.state, protocol: after.protocol }),
    );
    const nodes = new Map<string, string>();
    const origins = new Map<string, string>();
    const read = async (digest: string) =>
      nodes.get(digest) ?? (prior ? await this.node(digest) : undefined);
    const source =
      record === undefined
        ? undefined
        : projectOutcomeSource(record, verifiedOutcomeRecordHash(record));
    const collections: Collection[] = [];
    for (const expected of projection.collections) {
      const previous = prior?.value.collections.find((c) => c.name === expected.name);
      let root = previous?.encodedRoot ?? emptyLogicalMap(expected.domain);
      let rootHash = previous?.rootHash ?? logicalMapHash(root, expected.domain);
      const domain = locatorDomain(expected.domain);
      let pointerRoot = previous?.locatorRoot ?? emptyLogicalMap(domain);
      let pointerHash = previous?.locatorHash ?? logicalMapHash(pointerRoot, domain);
      let count = BigInt(previous?.population ?? "0");
      const groups = source?.groups.filter((g) => g.collection === expected.name) ?? [
        { mode: "append" as const, rows: expected.rows },
      ];
      for (const group of groups) {
        const start = group.mode === "replace" ? 0n : count;
        const end =
          group.mode === "replace" ? BigInt(group.rows.length) : count + BigInt(group.rows.length);
        const through = group.mode === "replace" && count > end ? count : end;
        for (let ordinal = start + 1n; ordinal <= through; ordinal++) {
          const supplied = group.rows[Number(ordinal - start - 1n)];
          const nextRow = supplied === undefined ? undefined : expected.rows[Number(ordinal - 1n)];
          requireLedger(
            supplied === undefined || nextRow?.encoded === supplied.encoded,
            "source_catalog_projection_mismatch",
          );
          const rowKey = key(ordinal);
          const old = await lookupLogicalValue(root, rootHash, expected.domain, rowKey, read);
          if (old.value === (nextRow?.contentHash ?? null)) continue;
          const oldPointer = await lookupLogicalValue(
            pointerRoot,
            pointerHash,
            domain,
            rowKey,
            read,
          );
          requireLedger(
            (old.value === null) === (oldPointer.value === null),
            "source_catalog_origin_missing",
          );
          let nextPointer: string | null = null;
          if (nextRow) {
            const origin: Origin =
              source && supplied && "selector" in supplied
                ? {
                    kind: "outcome",
                    sequence: source.sequence.toString(),
                    recordHash: source.recordHash,
                    selector: supplied.selector,
                  }
                : { kind: "genesis", digest: book.genesisDigest };
            const body = JSON.stringify(origin);
            requireLedger(body.length <= MAX_NODE, "source_catalog_capacity_exceeded");
            nextPointer = originHash(body);
            origins.set(nextPointer, body);
          }
          const financial = await prepareLogicalChange(
            root,
            rootHash,
            expected.domain,
            rowKey,
            old.value,
            nextRow?.contentHash ?? null,
            read,
          );
          for (const node of financial.nodes) nodes.set(node.digest, node.encoded);
          root = financial.encodedRoot;
          rootHash = financial.rootHash;
          const pointer = await prepareLogicalChange(
            pointerRoot,
            pointerHash,
            domain,
            rowKey,
            oldPointer.value,
            nextPointer,
            read,
          );
          for (const node of pointer.nodes) nodes.set(node.digest, node.encoded);
          pointerRoot = pointer.encodedRoot;
          pointerHash = pointer.rootHash;
        }
        count = end;
      }
      requireLedger(
        count === BigInt(expected.rows.length) &&
          root === expected.encodedRoot &&
          rootHash === expected.rootHash,
        "source_catalog_projection_mismatch",
      );
      collections.push({
        name: expected.name,
        domain: expected.domain,
        population: count.toString(),
        encodedRoot: root,
        rootHash,
        locatorDomain: domain,
        locatorRoot: pointerRoot,
        locatorHash: pointerHash,
      });
    }
    const value: Catalog = {
      format: SOURCE_CATALOG_FORMAT,
      identityHash: this.identityHash,
      headHash: ledgerIndexHeadCommitment(record?.after ?? book.head, COMPACT_LEDGER_FORMAT),
      headerHash: projection.headerHash,
      stateRoot: projection.stateRoot,
      protocolRoot: projection.protocolRoot,
      collections,
    };
    const body = JSON.stringify(value);
    requireLedger(
      new TextEncoder().encode(body).length <= MAX_CATALOG,
      "source_catalog_capacity_exceeded",
    );
    const prepared = Object.freeze({ digest: catalogHash(body) });
    this.prepared.set(prepared, {
      priorDigest: prior?.digest ?? null,
      body,
      digest: prepared.digest,
      nodes,
      origins,
    });
    return prepared;
  }
  publishInTransaction(transaction: SqliteTransaction, prepared: Prepared) {
    requireSqliteTransaction(transaction, this.storage);
    const candidate = this.prepared.get(prepared);
    requireLedger(candidate, "source_catalog_unprepared");
    const value = JSON.parse(candidate.body) as Catalog;
    const anchor = this.anchor();
    requireLedger(
      value.identityHash === anchor.identityHash && value.headHash === anchor.headHash,
      "source_catalog_head_mismatch",
    );
    if (candidate.priorDigest === null) {
      this.rows(
        "CREATE TABLE ledger_source_catalog (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), body TEXT NOT NULL, digest TEXT NOT NULL)",
      );
      this.rows(
        "CREATE TABLE ledger_source_nodes (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
      );
      this.rows(
        "CREATE TABLE ledger_source_origins (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
      );
    } else requireLedger(this.load().digest === candidate.priorDigest, "source_catalog_conflict");
    for (const [table, values] of [
      ["ledger_source_nodes", candidate.nodes],
      ["ledger_source_origins", candidate.origins],
    ] as const) {
      for (const [digest, body] of values) {
        this.rows(
          `INSERT INTO ${table} (digest, body) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING`,
          digest,
          body,
        );
        const persisted = this.bounded(table, digest);
        requireLedger(persisted?.body === body, "source_catalog_content_collision");
      }
    }
    if (candidate.priorDigest === null)
      this.rows(
        "INSERT INTO ledger_source_catalog VALUES (1, ?, ?)",
        candidate.body,
        candidate.digest,
      );
    else {
      this.rows(
        "UPDATE ledger_source_catalog SET body = ?, digest = ? WHERE singleton = 1 AND digest = ?",
        candidate.body,
        candidate.digest,
        candidate.priorDigest,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "source_catalog_conflict",
      );
    }
    this.prepared.delete(prepared);
  }
}

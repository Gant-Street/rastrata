import { hashCanonical, identifier } from "@rastrata/kernel";
import type { ProductionLedger } from "./ledger.ts";
import { readCanonicalIdentityPopulation } from "./identity-audit.ts";
import type { SqliteIndexControl, IndexReaderPin } from "./index-control.ts";
import type { SqliteIndexPageStore } from "./index-page-store.ts";
import {
  createIndexRoot,
  enumerateIndexPages,
  lookupIndexEntry,
  identityIndexKey,
  verifyIndexRoot,
  INDEX_KEY_SCHEMA,
  scanIndexRange,
  type IndexEntry,
} from "./index-pages.ts";
import {
  LEDGER_FORMAT,
  COMPACT_LEDGER_FORMAT,
  requireLedger,
  type LedgerHead,
  type LedgerFormat,
} from "./records.ts";

/** Trusted owner context, not request JSON. Namespace/generation authority is not
 * established by the prototype's narrower persisted BookScope. */
export interface IndexBookIdentity {
  readonly tenantId: string;
  readonly bookId: string;
  readonly objectId: string;
  readonly namespaceId: string;
  readonly generation: string;
}

/** Opens only after the real ledger's full-history and canonical-population audit.
 * Construction is deliberately not claimed scalable. Subsequent lookups verify
 * bounded paths under the original live pin, without rebuilding the full map.
 * Results prove key locators, NOT original raw identities or accounting admission.
 * This does not replace ProductionLedger.read/recovery or select a writable view. */
export async function openAuditedIndexReader(
  ledger: ProductionLedger,
  control: SqliteIndexControl,
  identity: IndexBookIdentity,
  expectedPin: IndexReaderPin,
  stores: { readonly cold: SqliteIndexPageStore; readonly hot: SqliteIndexPageStore },
) {
  const owner = identityCopy(identity);
  const capturedStores = Object.freeze({ cold: stores.cold, hot: stores.hot });
  const audit = await auditPinnedIdentityView(ledger, control, owner, expectedPin, capturedStores);
  const pin = audit.pin;
  return Object.freeze({
    pin,
    identityHash: audit.identityHash,
    /** Complete hash-key range across BOTH pinned partitions, not an accounting
     * predicate query. Drain to complete; a partial/cancelled range is no proof. */
    scanKeys(lower: string | null, upper: string | null, batchSize = 128) {
      requireLedger(
        [lower, upper].every(
          (bound) => bound === null || (typeof bound === "string" && /^[0-9a-f]{64}$/.test(bound)),
        ),
        "index_page_digest_invalid",
      );
      requireLedger(lower === null || upper === null || lower <= upper, "index_range_invalid");
      requireLedger(
        Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 256,
        "index_range_batch_invalid",
      );
      async function* partition(cold: boolean): AsyncGenerator<IndexEntry> {
        await control.readPinned(pin);
        const hash = cold ? pin.view.coldRoot : pin.view.hotRoot;
        const count = cold ? pin.view.coldCount : pin.view.hotCount;
        const store = cold ? capturedStores.cold : capturedStores.hot;
        const candidate =
          count === "0" ? createIndexRoot(0n, null) : await store.readRootDescriptor(hash);
        requireLedger(candidate, "index_required_root_missing");
        const root = verifyIndexRoot(candidate, hash);
        requireLedger(root.population === count, "index_partition_population_mismatch");
        for await (const batch of scanIndexRange(
          root,
          hash,
          lower,
          upper,
          async (id) => {
            const bytes = await store.read(id);
            await control.readPinned(pin);
            return bytes;
          },
          batchSize,
        )) {
          for (const entry of batch.entries) {
            requireLedger(
              cold
                ? entry.sequence >= 1n && entry.sequence <= BigInt(pin.view.coldThrough)
                : entry.sequence > BigInt(pin.view.coldThrough) &&
                    entry.sequence <= BigInt(pin.view.sequence),
              "index_partition_sequence_mismatch",
            );
            yield entry;
          }
        }
      }
      return (async function* () {
        const cold = partition(true),
          hot = partition(false);
        let matchedThrough = 0n;
        let entries: IndexEntry[] = [];
        try {
          let left = await cold.next(),
            right = await hot.next();
          while (!left.done || !right.done) {
            await control.readPinned(pin);
            requireLedger(
              left.done || right.done || left.value.key !== right.value.key,
              "index_identity_digest_collision",
            );
            if (entries.length === batchSize) {
              yield Object.freeze({
                pin,
                lower,
                upper,
                entries: Object.freeze(entries),
                matchedThrough,
                complete: false,
              });
              entries = [];
              await control.readPinned(pin);
            }
            if (!left.done && (right.done || left.value.key < right.value.key)) {
              entries.push(left.value);
              left = await cold.next();
            } else if (!right.done) {
              entries.push(right.value);
              right = await hot.next();
            }
            matchedThrough++;
          }
          await control.readPinned(pin);
          yield Object.freeze({
            pin,
            lower,
            upper,
            entries: Object.freeze(entries),
            matchedThrough,
            complete: true,
          });
        } finally {
          await cold.return(undefined);
          await hot.return(undefined);
        }
      })();
    },
    async lookupKey(key: string) {
      requireLedger(
        typeof key === "string" && /^[0-9a-f]{64}$/.test(key),
        "index_page_digest_invalid",
      );
      await control.readPinned(pin);
      const view = pin.view;
      let sequence: bigint | null = null;
      let pagesRead = 0,
        bytesRead = 0;
      for (const part of [
        {
          hash: view.coldRoot,
          count: view.coldCount,
          from: 1n,
          through: BigInt(view.coldThrough),
          store: capturedStores.cold,
        },
        {
          hash: view.hotRoot,
          count: view.hotCount,
          from: BigInt(view.coldThrough) + 1n,
          through: BigInt(view.sequence),
          store: capturedStores.hot,
        },
      ]) {
        const candidate =
          part.count === "0"
            ? createIndexRoot(0n, null)
            : await part.store.readRootDescriptor(part.hash);
        await control.readPinned(pin);
        requireLedger(candidate, "index_required_root_missing");
        const root = verifyIndexRoot(candidate, part.hash);
        requireLedger(root.population === part.count, "index_partition_population_mismatch");
        const found = await lookupIndexEntry(root, part.hash, key, async (location) => {
          const bytes = await part.store.read(location);
          await control.readPinned(pin);
          return bytes;
        });
        pagesRead += found.pagesRead;
        bytesRead += found.bytesRead;
        if (found.sequence !== null) {
          requireLedger(
            found.sequence >= part.from && found.sequence <= part.through,
            "index_partition_sequence_mismatch",
          );
          requireLedger(sequence === null, "index_identity_digest_collision");
          sequence = found.sequence;
        }
      }
      await control.readPinned(pin);
      return Object.freeze({ key, sequence, pin, pagesRead, bytesRead });
    },
  });
}
function identityCopy(input: IndexBookIdentity): IndexBookIdentity {
  requireLedger(input !== null && typeof input === "object", "index_book_identity_invalid");
  const fields = ["tenantId", "bookId", "objectId", "namespaceId", "generation"] as const;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(
    Reflect.ownKeys(input).length === fields.length &&
      fields.every((field) => descriptors[field] && "value" in descriptors[field]),
    "index_book_identity_invalid",
  );
  const result = {} as Record<(typeof fields)[number], string>;
  for (const field of fields) {
    const value: unknown = descriptors[field]?.value;
    requireLedger(typeof value === "string", "index_book_identity_invalid");
    if (field === "generation")
      requireLedger(/^(0|[1-9][0-9]{0,63})$/.test(value), "index_book_identity_invalid");
    else identifier(value);
    result[field] = value;
  }
  return Object.freeze(result);
}
export function indexBookIdentityCommitment(identity: IndexBookIdentity): string {
  return hashCanonical({ domain: "rastrata-index-book-identity-v1", ...identityCopy(identity) })
    .digest;
}
/** Derived binding for the existing snapshot ledger's COMPLETE replay-verified
 * head. It does not change historical ledger hashes or define the target compact
 * ledger's new head codec. That representation needs its own reviewed binding. */
export function snapshotIndexHeadCommitment(head: LedgerHead): string {
  return ledgerIndexHeadCommitment(head, LEDGER_FORMAT);
}

export function ledgerIndexHeadCommitment(head: LedgerHead, format: LedgerFormat): string {
  requireLedger(
    format === LEDGER_FORMAT || format === COMPACT_LEDGER_FORMAT,
    "ledger_format_unsupported",
  );
  return hashCanonical({ domain: `${format}/index-head-v1`, ...head }).digest;
}

/** Full, small-book audit at a durable pin. Not posting admission, root activation,
 * scalable reconstruction or namespace/restore authorization. The prototype still
 * verifies the complete retained history before providing the older cutoff. */
export async function auditPinnedIdentityView(
  ledger: ProductionLedger,
  control: SqliteIndexControl,
  identity: IndexBookIdentity,
  expectedPin: IndexReaderPin,
  stores: { readonly cold: SqliteIndexPageStore; readonly hot: SqliteIndexPageStore },
) {
  const owner = identityCopy(identity);
  const identityHash = indexBookIdentityCommitment(owner);
  const coldStore = stores.cold,
    hotStore = stores.hot;
  requireLedger(
    coldStore.identityCommitment === identityHash && hotStore.identityCommitment === identityHash,
    "index_store_identity_mismatch",
  );
  const pin = await control.readPinned(expectedPin);
  const view = pin.view;
  requireLedger(view.identityHash === identityHash, "index_book_identity_mismatch");
  requireLedger(view.schema === INDEX_KEY_SCHEMA, "index_key_schema_unsupported");
  const source = await readCanonicalIdentityPopulation(ledger, BigInt(view.sequence));
  requireLedger(
    source.scope.tenantId === owner.tenantId &&
      source.scope.bookId === owner.bookId &&
      source.scope.objectId === owner.objectId,
    "index_canonical_scope_mismatch",
  );
  requireLedger(
    source.format !== COMPACT_LEDGER_FORMAT ||
      ("namespaceId" in source.scope &&
        source.scope.namespaceId === owner.namespaceId &&
        source.scope.generation === owner.generation),
    "index_canonical_scope_mismatch",
  );
  requireLedger(
    ledgerIndexHeadCommitment(source.head, source.format) === view.headHash,
    "index_canonical_head_mismatch",
  );
  const expected = new Map<string, bigint>();
  let coldPopulation = 0n;
  for (const entry of source.entries) {
    const key = identityIndexKey(entry);
    requireLedger(!expected.has(key), "index_identity_digest_collision");
    expected.set(key, entry.outcomeSequence);
    if (entry.outcomeSequence <= BigInt(view.coldThrough)) coldPopulation++;
  }
  const hotPopulation = BigInt(expected.size) - coldPopulation;
  requireLedger(
    coldPopulation === BigInt(view.coldCount) && hotPopulation === BigInt(view.hotCount),
    "index_partition_population_mismatch",
  );
  const roots = [
    {
      hash: view.coldRoot,
      population: coldPopulation,
      from: 1n,
      through: BigInt(view.coldThrough),
      store: coldStore,
    },
    {
      hash: view.hotRoot,
      population: hotPopulation,
      from: BigInt(view.coldThrough) + 1n,
      through: BigInt(view.sequence),
      store: hotStore,
    },
  ];
  for (const part of roots) {
    await control.readPinned(pin);
    const candidate =
      part.population === 0n
        ? createIndexRoot(0n, null)
        : await part.store.readRootDescriptor(part.hash);
    requireLedger(candidate, "index_required_root_missing");
    const root = verifyIndexRoot(candidate, part.hash);
    requireLedger(
      BigInt(root.population) === part.population,
      "index_partition_population_mismatch",
    );
    for await (const entry of enumerateIndexPages(root, part.hash, async (location) => {
      await control.readPinned(pin);
      const bytes = await part.store.read(location);
      await control.readPinned(pin);
      return bytes;
    })) {
      requireLedger(
        entry.sequence >= part.from && entry.sequence <= part.through,
        "index_partition_sequence_mismatch",
      );
      requireLedger(expected.get(entry.key) === entry.sequence, "index_identity_mismatch");
      expected.delete(entry.key);
    }
  }
  requireLedger(expected.size === 0, "index_identity_population_incomplete");
  await control.readPinned(pin); // No successful report after expiry/release during I/O.
  return Object.freeze({
    bookId: source.bookId,
    scope: source.scope,
    head: source.head,
    identityHash,
    pin,
    coldPopulation,
    hotPopulation,
    populationHash: source.populationHash,
    exactEntriesVerified: true as const,
    pageIntegrityVerified: true as const,
  });
}

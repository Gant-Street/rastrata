import { decodeBookRow, type BookRowTypes } from "@rastrata/kernel";
import type { SqliteSemanticGroupCatalog, CapturedGroupCatalog } from "./group-catalog.ts";
import {
  SEMANTIC_GROUP_COLLECTIONS,
  projectSemanticGroupMemberships,
  semanticGroupKey,
  type SemanticGroupKind,
  type SemanticGroupKey,
} from "./semantic-groups.ts";
import type { CapturedRow } from "./source-catalog.ts";
import { requireLedger } from "./records.ts";

export interface GroupMember<K extends SemanticGroupKind> {
  readonly ordinal: bigint;
  readonly rowHash: string;
  readonly encoded: string;
  readonly row: BookRowTypes[(typeof SEMANTIC_GROUP_COLLECTIONS)[K]];
}
export interface PinnedGroupPage<K extends SemanticGroupKind> {
  readonly key: SemanticGroupKey;
  readonly catalogDigest: string;
  readonly groupCatalogDigest: string;
  readonly headHash: string;
  readonly memberHash: string | null;
  readonly population: bigint;
  /** Members delivered by this cursor since its start, not proof that an external
   * consumer processed them. A final page is not a standalone complete row set. */
  readonly consumed: bigint;
  readonly complete: boolean;
  /** UTF-8 bytes of canonical row strings in this page (not HTTP wire size). */
  readonly encodedRowBytes: number;
  readonly rows: readonly GroupMember<K>[];
}
export interface PinnedGroupCursor<K extends SemanticGroupKind> {
  next(): Promise<PinnedGroupPage<K>>;
  close(): Promise<void>;
}
interface Ports {
  readonly catalog: SqliteSemanticGroupCatalog;
  readonly capture: CapturedGroupCatalog;
  readonly collectionDomain: string;
  readonly sourceCatalogDigest: string;
  readonly headHash: string;
  readonly confirm: () => Promise<void>;
  readonly rawRow: (collection: string, ordinal: bigint) => Promise<CapturedRow>;
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Owner-local forward-only cursor: no caller-authored offsets or transferable
 * continuation tokens. Shared owner serialization prevents double consumption.
 * Every delivered member is separately authenticated against current canonical
 * source rows and rechecked against the raw predicate. */
export function createPinnedGroupCursor<K extends SemanticGroupKind>(
  kind: K,
  values: readonly string[],
  limit: number,
  maxRowBytes: number,
  ports: Ports,
): PinnedGroupCursor<K> {
  const key = semanticGroupKey(kind, values);
  requireLedger(
    new TextEncoder().encode(JSON.stringify(key)).length <= 1_048_576,
    "group_query_key_too_large",
  );
  requireLedger(
    Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 256 &&
      Number.isInteger(maxRowBytes) &&
      maxRowBytes >= 1 &&
      maxRowBytes <= 1_048_576,
    "group_query_limit_invalid",
  );
  const collection = SEMANTIC_GROUP_COLLECTIONS[kind];
  let from: string | null = null;
  let consumed = 0n;
  let closed = false;
  return Object.freeze({
    next: () =>
      ports.run(async () => {
        requireLedger(!closed, "group_cursor_closed");
        await ports.confirm();
        const members = await ports.catalog.readMembers(
          ports.capture,
          ports.collectionDomain,
          key,
          from,
          limit,
          ports.confirm,
        );
        const rows: GroupMember<K>[] = [];
        let encodedRowBytes = 0;
        let next = members.nextFromInclusive;
        let complete = members.complete;
        for (const member of members.entries) {
          const ordinal = BigInt(`0x${member.key}`);
          const raw = await ports.rawRow(collection, ordinal);
          requireLedger(
            raw.disposition === "present" &&
              raw.encoded !== null &&
              raw.rowHash === member.value &&
              raw.collection === collection &&
              raw.ordinal === ordinal &&
              raw.catalogDigest === ports.sourceCatalogDigest &&
              raw.headHash === ports.headHash,
            "group_member_source_mismatch",
          );
          const decoded = decodeBookRow(collection, raw.encoded);
          requireLedger(decoded.disposition === "decoded", "group_member_source_mismatch");
          requireLedger(
            projectSemanticGroupMemberships(collection, raw.encoded, ordinal).some(
              (m) => JSON.stringify(m.group) === JSON.stringify(key),
            ),
            "group_member_predicate_mismatch",
          );
          const bytes = new TextEncoder().encode(raw.encoded).length;
          if (encodedRowBytes + bytes > maxRowBytes) {
            requireLedger(rows.length > 0, "group_row_too_large");
            next = member.key;
            complete = false;
            break;
          }
          encodedRowBytes += bytes;
          rows.push(
            Object.freeze({
              ordinal,
              rowHash: member.value,
              encoded: raw.encoded,
              row: decoded.row,
            }),
          );
        }
        const total = consumed + BigInt(rows.length);
        requireLedger(
          complete
            ? total === members.population && next === null
            : rows.length > 0 && total < members.population && next !== null,
          "group_query_population_mismatch",
        );
        await ports.confirm();
        // Advance only after the entire page, its completeness and live view pass.
        consumed = total;
        from = next;
        closed = complete;
        return Object.freeze({
          key,
          catalogDigest: ports.sourceCatalogDigest,
          groupCatalogDigest: ports.capture.digest,
          headHash: ports.headHash,
          memberHash: members.memberHash,
          population: members.population,
          consumed,
          complete,
          encodedRowBytes,
          rows: Object.freeze(rows),
        });
      }),
    close: () =>
      ports.run(async () => {
        closed = true;
      }),
  });
}

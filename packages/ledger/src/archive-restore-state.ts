import { hashCanonical, immutableAccountingValue } from "@rastrata/kernel";
import { normalizeArchiveCatalogSnapshot, type ArchiveCatalogSnapshot } from "./archive-catalog.ts";
import {
  decodeArchiveManifest,
  encodeArchiveManifest,
  type ArchiveManifest,
} from "./archive-records.ts";
import { referenceArchivePayload } from "./r2-archive-store.ts";
import { requireLedger, same, type CompleteBookScope } from "./records.ts";
import type { SqliteStorage } from "./sqlite.ts";

export const ARCHIVE_RESTORE_STATE = "rastrata-sqlite-archive-restore-v1";
const encoder = new TextEncoder();
export interface ArchiveRestoreState {
  readonly version: typeof ARCHIVE_RESTORE_STATE;
  readonly phase: "selected" | "installed";
  readonly catalog: ArchiveCatalogSnapshot;
  readonly manifest: string | null;
  readonly predecessorManifest: string | null;
  readonly contentHash: string;
}
const digest = (record: string) => hashCanonical({ domain: ARCHIVE_RESTORE_STATE, record }).digest;
export function encodeRestoreState(state: ArchiveRestoreState): string {
  return JSON.stringify({
    version: state.version,
    phase: state.phase,
    catalog: state.catalog,
    manifest: state.manifest,
    predecessorManifest: state.predecessorManifest,
  });
}
export function prepareRestoreState(
  scope: CompleteBookScope,
  phase: ArchiveRestoreState["phase"],
  catalog: ArchiveCatalogSnapshot,
  manifest: ArchiveManifest | null,
  predecessor: ArchiveManifest | null,
): ArchiveRestoreState {
  const text = JSON.stringify({
    version: ARCHIVE_RESTORE_STATE,
    phase,
    catalog,
    manifest: manifest === null ? null : encodeArchiveManifest(manifest),
    predecessorManifest: predecessor === null ? null : encodeArchiveManifest(predecessor),
  });
  return decodeRestoreState(scope, text, digest(text));
}
function decodeRestoreState(
  scope: CompleteBookScope,
  text: string,
  hash: string,
): ArchiveRestoreState {
  requireLedger(
    encoder.encode(text).length <= 65_536 && hash === digest(text),
    "archive_restore_state_corrupt",
  );
  const value = JSON.parse(text);
  requireLedger(
    value !== null &&
      typeof value === "object" &&
      Object.keys(value).sort().join(",") ===
        "catalog,manifest,phase,predecessorManifest,version" &&
      value.version === ARCHIVE_RESTORE_STATE &&
      ["selected", "installed"].includes(value.phase),
    "archive_restore_state_corrupt",
  );
  const catalog = normalizeArchiveCatalogSnapshot(
    value.catalog,
    scope,
    value.catalog?.catalogObjectId,
  );
  const permit = catalog.restorePermit;
  requireLedger(
    catalog.entry.status === "maintenance" &&
      catalog.sealed !== null &&
      permit !== null &&
      permit.entry.fenceGeneration === catalog.entry.fenceGeneration,
    "archive_restore_state_corrupt",
  );
  let manifest: string | null = null,
    predecessorManifest: string | null = null;
  if (value.phase === "selected")
    requireLedger(
      value.manifest === null && value.predecessorManifest === null,
      "archive_restore_state_corrupt",
    );
  else {
    requireLedger(typeof value.manifest === "string", "archive_restore_state_corrupt");
    const decoded = decodeArchiveManifest(value.manifest);
    manifest = encodeArchiveManifest(decoded);
    const reference = (encoded: string) =>
      referenceArchivePayload(scope, scope.objectId, encoder.encode(encoded));
    requireLedger(
      same(decoded.identity, scope) &&
        same(decoded.durabilityPolicy, catalog.entry.durabilityPolicy) &&
        decoded.contentHash === permit.anchor.manifestHash &&
        same(reference(manifest), permit.anchor.manifest) &&
        same(
          decoded.kind === "genesis" ? decoded.initialHead : decoded.resulting,
          permit.anchor.head,
        ),
      "archive_restore_state_corrupt",
    );
    if (decoded.kind === "genesis")
      requireLedger(value.predecessorManifest === null, "archive_restore_state_corrupt");
    else {
      requireLedger(typeof value.predecessorManifest === "string", "archive_restore_state_corrupt");
      const predecessor = decodeArchiveManifest(value.predecessorManifest);
      predecessorManifest = encodeArchiveManifest(predecessor);
      requireLedger(
        predecessor.contentHash === decoded.priorManifestHash &&
          same(reference(predecessorManifest), decoded.priorManifest) &&
          BigInt(decoded.fenceGeneration) <= BigInt(permit.entry.fenceGeneration),
        "archive_restore_state_corrupt",
      );
    }
  }
  const state = {
    version: ARCHIVE_RESTORE_STATE,
    phase: value.phase,
    catalog,
    manifest,
    predecessorManifest,
    contentHash: hash,
  } as ArchiveRestoreState;
  requireLedger(encodeRestoreState(state) === text, "archive_restore_state_corrupt");
  return immutableAccountingValue(state) as ArchiveRestoreState;
}

/** Internal synchronous reader; caller owns the book's active SQL transaction.
 * This row is preserved when replacing canonical tables. It is not external
 * catalog authority and cannot authorize an out-of-band provider rollback. */
export function readRestoreState(
  storage: SqliteStorage,
  scope: CompleteBookScope,
): ArchiveRestoreState | undefined {
  const present = Array.from(
    storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_archive_restore'",
    ),
  );
  if (present.length === 0) return undefined;
  const rows = Array.from(
    storage.sql.exec(
      "SELECT singleton, phase, substr(record, 1, 65537) AS record, length(CAST(record AS BLOB)) AS size, substr(record_hash, 1, 65) AS hash, length(CAST(record_hash AS BLOB)) AS hash_size FROM ledger_archive_restore LIMIT 2",
    ),
  );
  const row = rows[0];
  requireLedger(
    rows.length === 1 &&
      row?.singleton === 1 &&
      typeof row.record === "string" &&
      typeof row.size === "number" &&
      row.size <= 65_536 &&
      encoder.encode(row.record).length === row.size &&
      typeof row.hash === "string" &&
      row.hash_size === 64,
    "archive_restore_state_corrupt",
  );
  const state = decodeRestoreState(scope, row.record, row.hash);
  requireLedger(state.phase === row.phase, "archive_restore_state_corrupt");
  return state;
}

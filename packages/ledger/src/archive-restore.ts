import { immutableAccountingValue } from "@rastrata/kernel";
import { normalizeArchiveCatalogSnapshot, type ArchiveCatalogReader } from "./archive-catalog.ts";
import {
  recoverArchiveBook,
  type ArchiveManifest,
  type ArchiveGenesisManifest,
} from "./archive-records.ts";
import type { ArchiveRestorePermit } from "./archive-restore-permit.ts";
import { completeScope } from "./compact-records.ts";
import { requireLedger, type CompleteBookScope, type StoredBook } from "./records.ts";
import type { ArchivePayloadReference, R2ArchiveObjectStore } from "./r2-archive-store.ts";

export interface ArchiveRestoreImage {
  readonly catalogHash: string;
  readonly permit: ArchiveRestorePermit;
  readonly book: StoredBook;
  readonly genesisManifest: ArchiveGenesisManifest;
  readonly lastManifest: ArchiveManifest;
  readonly lastPredecessorManifest: ArchiveManifest | null;
  readonly lastManifestReference: ArchivePayloadReference;
}

/** Read-only preparation at an actual externally authorized cutoff, not a book
 * replacement or public-ready result. The installer must recheck authority and
 * atomically bind local materialization to the exact permit before acknowledging
 * restoration. Do not accept caller-built images as authorization to overwrite.
 * This preserves every original committed/rejected payload and all full heads;
 * canonical manifests cannot supply historical publisher ETags or nonces. */
export async function prepareArchiveRestoreImage(
  store: R2ArchiveObjectStore,
  authority: ArchiveCatalogReader,
  scopeInput: CompleteBookScope,
  actualObjectId: string,
  expectedCatalogHash: string,
  expectedPermitHash: string,
): Promise<ArchiveRestoreImage> {
  const scope = completeScope(scopeInput, actualObjectId);
  const catalogObjectId = authority.catalogObjectId;
  requireLedger(
    typeof expectedCatalogHash === "string" &&
      /^[0-9a-f]{64}$/.test(expectedCatalogHash) &&
      typeof expectedPermitHash === "string" &&
      /^[0-9a-f]{64}$/.test(expectedPermitHash),
    "archive_restore_permit_invalid",
  );
  const readAuthority = async () => {
    const catalog = normalizeArchiveCatalogSnapshot(await authority.read(), scope, catalogObjectId);
    requireLedger(catalog.contentHash === expectedCatalogHash, "archive_catalog_head_conflict");
    const permit = catalog.restorePermit;
    requireLedger(
      catalog.entry.status === "maintenance" &&
        catalog.sealed !== null &&
        permit !== null &&
        permit.contentHash === expectedPermitHash &&
        permit.entry.fenceGeneration === catalog.entry.fenceGeneration,
      "archive_restore_not_authorized",
    );
    return { catalog, permit };
  };
  const { catalog, permit } = await readAuthority();
  const recovered = await recoverArchiveBook(store, permit.anchor, catalog.entry.durabilityPolicy);
  requireLedger(
    recovered.book.genesisDigest === catalog.entry.genesisHash,
    "archive_catalog_genesis_mismatch",
  );
  const sameControl = (control: typeof recovered.control | null) =>
    control !== null &&
    control.body === permit.control.body &&
    control.storageRevision === permit.control.storageRevision &&
    control.nonce === permit.control.nonce;
  requireLedger(
    sameControl(recovered.control) && sameControl(await store.readControl()),
    "archive_catalog_archive_changed",
  );
  await readAuthority();
  return immutableAccountingValue({
    catalogHash: catalog.contentHash,
    permit,
    book: recovered.book,
    genesisManifest: recovered.genesisManifest,
    lastManifest: recovered.manifest,
    lastPredecessorManifest: recovered.lastPredecessorManifest,
    lastManifestReference: recovered.manifestReference,
  }) as ArchiveRestoreImage;
}

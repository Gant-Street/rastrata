import { hashCanonical, identifier, immutableAccountingValue } from "@rastrata/kernel";
import { normalizeArchiveCatalogEntry, type ArchiveCatalogEntry } from "./archive-authority.ts";
import { decodeArchiveAnchor, encodeArchiveAnchor, type ArchiveAnchor } from "./archive-records.ts";
import type { ArchiveControlVersion } from "./r2-archive-store.ts";
import { requireLedger, same, type CompleteBookScope } from "./records.ts";

const VERSION = "rastrata-archive-restore-permit-v1";
const HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
export interface ArchiveRestorePermit {
  readonly version: typeof VERSION;
  readonly permitId: string;
  /** Provenance only. The privileged caller must actually authorize this actor. */
  readonly approvedBy: string;
  /** Content-addressed canonical backup cutoff, not an arbitrary user label. */
  readonly sourceBackupId: string;
  readonly catalogObjectId: string;
  readonly catalogRevision: string;
  readonly catalogHash: string;
  readonly entry: ArchiveCatalogEntry;
  readonly anchor: ArchiveAnchor;
  readonly control: ArchiveControlVersion;
  readonly contentHash: string;
}
type Body = Omit<ArchiveRestorePermit, "contentHash">;
const digest = (body: Body) =>
  hashCanonical({ domain: VERSION, body: JSON.stringify(body) }).digest;
function fields(input: unknown, names: readonly string[]) {
  requireLedger(input !== null && typeof input === "object", "archive_restore_permit_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === names.length, "archive_restore_permit_invalid");
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const field = descriptors[name];
    requireLedger(field && "value" in field && field.enumerable, "archive_restore_permit_invalid");
    result[name] = field.value;
  }
  return result;
}
export function restoreActor(input: unknown): string {
  requireLedger(
    typeof input === "string" && encoder.encode(input).length <= 1024,
    "archive_restore_permit_invalid",
  );
  return identifier(input);
}

/** Integrity/shape validation only. A decoded permit is NOT current authority;
 * restore must read the actual catalog and match its exact retained permit. */
export function normalizeArchiveRestorePermit(
  input: unknown,
  scope: CompleteBookScope,
  catalogObjectId: string,
): ArchiveRestorePermit {
  const value = fields(input, [
    "version",
    "permitId",
    "approvedBy",
    "sourceBackupId",
    "catalogObjectId",
    "catalogRevision",
    "catalogHash",
    "entry",
    "anchor",
    "control",
    "contentHash",
  ]);
  requireLedger(
    value.version === VERSION &&
      value.catalogObjectId === catalogObjectId &&
      catalogObjectId !== scope.objectId &&
      typeof value.catalogRevision === "string" &&
      /^(0|[1-9][0-9]{0,63})$/.test(value.catalogRevision) &&
      typeof value.catalogHash === "string" &&
      HEX.test(value.catalogHash),
    "archive_restore_permit_invalid",
  );
  const entryValue = fields(value.entry, [
    "version",
    "identity",
    "format",
    "durabilityPolicy",
    "genesisHash",
    "status",
    "fenceGeneration",
  ]);
  requireLedger(typeof entryValue.genesisHash === "string", "archive_restore_permit_invalid");
  const entry = normalizeArchiveCatalogEntry(value.entry, scope, entryValue.genesisHash);
  const anchor = decodeArchiveAnchor(encodeArchiveAnchor(value.anchor as ArchiveAnchor));
  const control = fields(value.control, ["body", "storageRevision", "nonce"]);
  requireLedger(
    entry.status === "maintenance" &&
      entry.fenceGeneration !== "0" &&
      same(anchor.identity, scope) &&
      anchor.fenceGeneration === entry.fenceGeneration &&
      value.sourceBackupId === anchor.manifestHash &&
      control.body === encodeArchiveAnchor(anchor) &&
      typeof control.storageRevision === "string" &&
      control.storageRevision.length > 0 &&
      encoder.encode(control.storageRevision).length <= 1024 &&
      typeof control.nonce === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(control.nonce),
    "archive_restore_permit_invalid",
  );
  const body: Body = {
    version: VERSION,
    permitId: restoreActor(value.permitId),
    approvedBy: restoreActor(value.approvedBy),
    sourceBackupId: anchor.manifestHash,
    catalogObjectId,
    catalogRevision: value.catalogRevision,
    catalogHash: value.catalogHash,
    entry,
    anchor,
    control: {
      body: control.body as string,
      storageRevision: control.storageRevision,
      nonce: control.nonce,
    },
  };
  requireLedger(value.contentHash === digest(body), "archive_restore_permit_invalid");
  return immutableAccountingValue({
    ...body,
    contentHash: value.contentHash,
  }) as ArchiveRestorePermit;
}

/** Prepare after reading/verifying the sealed catalog; only durable catalog CAS
 * grants this permit. No locally constructed copy may authorize a book write. */
export function prepareArchiveRestorePermit(
  scope: CompleteBookScope,
  catalogObjectId: string,
  catalogRevision: string,
  catalogHash: string,
  entry: ArchiveCatalogEntry,
  anchor: ArchiveAnchor,
  control: ArchiveControlVersion,
  permitId: string,
  approvedBy: string,
): ArchiveRestorePermit {
  const body: Body = {
    version: VERSION,
    permitId: restoreActor(permitId),
    approvedBy: restoreActor(approvedBy),
    sourceBackupId: anchor.manifestHash,
    catalogObjectId,
    catalogRevision,
    catalogHash,
    entry,
    anchor,
    control: { body: control.body, storageRevision: control.storageRevision, nonce: control.nonce },
  };
  return normalizeArchiveRestorePermit(
    { ...body, contentHash: digest(body) },
    scope,
    catalogObjectId,
  );
}

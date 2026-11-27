import { immutableAccountingValue } from "@rastrata/kernel";
import { COMPACT_FORMAT_IDENTITY, completeScope } from "./compact-records.ts";
import {
  createArchiveDurabilityPolicy,
  type ArchiveDurabilityPolicy,
  type ArchiveAnchor,
} from "./archive-records.ts";
import { requireLedger, same, type CompleteBookScope, type LedgerHead } from "./records.ts";
import type { ArchiveControlVersion } from "./r2-archive-store.ts";

export interface ArchiveCatalogEntry {
  readonly version: "rastrata-archive-catalog-v1";
  readonly identity: CompleteBookScope;
  readonly format: typeof COMPACT_FORMAT_IDENTITY;
  readonly durabilityPolicy: ArchiveDurabilityPolicy;
  readonly genesisHash: string;
  readonly status: "reserved" | "active" | "maintenance" | "retired";
  readonly fenceGeneration: string;
}

/** Trusted control-plane dependency, configured by the owner, never decoded from
 * a posting request. Implementations read authority outside the book restore set.
 * This port is not a catalog implementation or proof of account independence. */
export interface ArchiveCatalogAuthority {
  readEntry(scope: CompleteBookScope): Promise<unknown>;
}

export interface ArchiveBookHeadEvidence {
  readonly identity: CompleteBookScope;
  readonly genesisHash: string;
  readonly head: LedgerHead;
  readonly manifestHash: string;
  readonly control: ArchiveControlVersion;
  /** Present only after verifying durable local materialization under this exact
   * restore permit. Never copy the requested permit into verification evidence. */
  readonly restoredUnderPermitHash?: string;
}
/** Trusted book-object read port. It must perform complete SQL/archive recovery,
 * reject pending selections, and confirm durability. Never echo request fields. */
export interface ArchiveBookVerifier {
  verifyHead(anchor: ArchiveAnchor): Promise<ArchiveBookHeadEvidence>;
}

function fields(input: unknown, names: readonly string[]) {
  requireLedger(input !== null && typeof input === "object", "archive_catalog_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === names.length, "archive_catalog_invalid");
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const field = descriptors[name];
    requireLedger(field && "value" in field && field.enumerable, "archive_catalog_invalid");
    result[name] = field.value;
  }
  return result;
}

/** Validate the complete control-plane identity/profile, not a caller's boolean
 * assertion that a fence is valid. Status/fence admission is operation-specific. */
export async function readArchiveCatalogEntry(
  authority: ArchiveCatalogAuthority,
  scope: CompleteBookScope,
  genesisHash: string,
): Promise<ArchiveCatalogEntry> {
  return normalizeArchiveCatalogEntry(await authority.readEntry(scope), scope, genesisHash);
}

export function normalizeArchiveCatalogEntry(
  input: unknown,
  scope: CompleteBookScope,
  genesisHash: string,
): ArchiveCatalogEntry {
  const entry = fields(input, [
    "version",
    "identity",
    "format",
    "durabilityPolicy",
    "genesisHash",
    "status",
    "fenceGeneration",
  ]);
  requireLedger(
    entry.version === "rastrata-archive-catalog-v1",
    "archive_catalog_version_unsupported",
  );
  const identity = completeScope(entry.identity as CompleteBookScope, scope.objectId);
  requireLedger(same(identity, scope), "archive_catalog_identity_mismatch");
  const format = fields(entry.format, Object.keys(COMPACT_FORMAT_IDENTITY));
  requireLedger(
    Object.entries(COMPACT_FORMAT_IDENTITY).every(([key, value]) => format[key] === value),
    "archive_catalog_format_mismatch",
  );
  const policy = fields(entry.durabilityPolicy, ["version", "archiveRequired", "contentHash"]);
  const expectedPolicy = createArchiveDurabilityPolicy(true);
  requireLedger(
    Object.entries(expectedPolicy).every(([key, value]) => policy[key] === value),
    "archive_catalog_policy_mismatch",
  );
  requireLedger(
    typeof entry.genesisHash === "string" &&
      /^[0-9a-f]{64}$/.test(entry.genesisHash) &&
      entry.genesisHash === genesisHash,
    "archive_catalog_genesis_mismatch",
  );
  requireLedger(
    typeof entry.status === "string" &&
      ["reserved", "active", "maintenance", "retired"].includes(entry.status) &&
      typeof entry.fenceGeneration === "string" &&
      /^(0|[1-9][0-9]{0,63})$/.test(entry.fenceGeneration),
    "archive_catalog_invalid",
  );
  return immutableAccountingValue({
    version: "rastrata-archive-catalog-v1",
    identity,
    format: COMPACT_FORMAT_IDENTITY,
    durabilityPolicy: expectedPolicy,
    genesisHash,
    status: entry.status,
    fenceGeneration: entry.fenceGeneration,
  }) as ArchiveCatalogEntry;
}

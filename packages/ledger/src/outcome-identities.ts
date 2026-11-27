import {
  decodeBookOutcome,
  decodeBookRow,
  contentHashEquals,
  hashCanonical,
  canonicalAccountingValue,
  identifier,
  type BookEffect,
  type BookedJournal,
  type Posting,
  type AccountingEffect,
  type BookRowTypes,
  isInventoryPostedReductionMovement,
} from "@rastrata/kernel";
import type { CanonicalIdentity, IdentityFamily } from "./identity-audit.ts";
import { identityIndexKey } from "./index-pages.ts";
import { requireLedger } from "./records.ts";
import { ACCOUNTING_SOURCE_COLLECTIONS } from "./outcome-source.ts";
import type { IndexedOutcomeSourceAuthority } from "./outcome-source.ts";
import type {
  SqliteIndexedSourceCatalog,
  PreparedIndexedSourceCatalog,
} from "./indexed-source-catalog.ts";
import { decodeIndexedOutcomeRecord } from "./indexed-outcome-record.ts";
import { completeScope } from "./compact-records.ts";

interface Candidate {
  readonly bookId: string;
  readonly family: IdentityFamily;
  readonly id: string;
  readonly snapshotRepeat: boolean;
}
export interface PriorIdentityEvidence {
  readonly sequence: bigint;
  readonly encodedOutcome: string;
}

/** Bind an already authenticated retained row to the requested raw identity.
 * A digest hit alone is insufficient. This helper supplies no source authority
 * and does not compare a retry's input hash or execute/replay a command. */
export function decodeRetainedCommandIdentity(encoded: string, bookId: string, commandId: string) {
  const decoded = decodeBookRow("protocol.retainedResults", encoded);
  requireLedger(decoded.disposition === "decoded", "source_catalog_row_invalid");
  const row = decoded.row;
  requireLedger(
    row.commandId === commandId && row.command.id === commandId && row.command.bookId === bookId,
    "index_identity_source_mismatch",
  );
  return row;
}

/** Cross-bind already authenticated source rows. Oseq is NOT a journal ordinal:
 * rejected commands and multi-journal effects make those sequences diverge.
 * This is source selection, not accounting admission or source authentication. */
function committedIdentityRevision(retainedBytes: string, revisionBytes: string, bookId: string) {
  const retained = decodeBookRow("protocol.retainedResults", retainedBytes);
  const revision = decodeBookRow("state.revisions", revisionBytes);
  requireLedger(
    retained.disposition === "decoded" && revision.disposition === "decoded",
    "source_catalog_row_invalid",
  );
  const result = retained.row;
  const rev = revision.row;
  requireLedger(
    result.outcome === "committed" &&
      result.commandId === result.command.id &&
      result.command.bookId === bookId &&
      rev.bookId === bookId &&
      rev.command.bookId === bookId &&
      rev.command.id === result.commandId &&
      rev.bookRevision === result.observedBookRevision &&
      contentHashEquals(rev.command.inputHash, result.inputHash),
    "index_identity_source_mismatch",
  );
  return rev;
}

type OwnershipEffect = Extract<BookEffect, { type: "inventoryOwnership" }>["value"];
type OwnershipMovement =
  | OwnershipEffect["journalLinkedMovements"][number]
  | OwnershipEffect["quantityOnlyMovements"][number];
export interface InventoryIdentityRows {
  operation: Extract<
    BookRowTypes["state.revisions"]["command"],
    { type: "postOwnedInventoryTransaction" }
  >["request"]["operations"][number];
  anchor: OwnershipEffect["newAnchors"][number];
  movement: OwnershipMovement;
  quantityAllocation: Extract<
    OwnershipMovement,
    { kind: "disposal" | "transferOut" }
  >["quantityAllocation"];
  postingReference: OwnershipEffect["newAnchors"][number]["sourcePostings"][number];
}
export const INVENTORY_IDENTITY_FAMILIES = Object.freeze({
  operation: "inventoryOperation",
  anchor: "inventoryAnchor",
  movement: "inventoryMovement",
  quantityAllocation: "lotAllocation",
  postingReference: "inventoryPostingReference",
} satisfies Record<keyof InventoryIdentityRows, IdentityFamily>);
export type InventoryIdentityKind = keyof InventoryIdentityRows;
export function isInventoryIdentityKind(value: unknown): value is InventoryIdentityKind {
  return typeof value === "string" && Object.hasOwn(INVENTORY_IDENTITY_FAMILIES, value);
}

/** Select immutable artifacts from their authenticated creating revision. This
 * does not establish current positions, complete policy pools or source authority.
 * Quantity allocations share the permanent legacy allocation namespace but never
 * masquerade as legacy posting-linked rows. */
export function resolveInventoryIdentity<K extends InventoryIdentityKind>(
  retainedBytes: string,
  revisionBytes: string,
  bookId: string,
  kind: K,
  id: string,
): InventoryIdentityRows[K] {
  requireLedger(isInventoryIdentityKind(kind), "index_identity_family_invalid");
  const revision = committedIdentityRevision(retainedBytes, revisionBytes, bookId);
  requireLedger(
    revision.command.type === "postOwnedInventoryTransaction",
    "index_ownership_identity_kind_mismatch",
  );
  const effects = revision.effects.filter((effect) => effect.type === "inventoryOwnership");
  requireLedger(effects.length === 1, "index_identity_source_mismatch");
  const ownership = effects[0];
  requireLedger(ownership?.type === "inventoryOwnership", "index_identity_source_mismatch");
  const effect = ownership.value;
  const movements = [...effect.journalLinkedMovements, ...effect.quantityOnlyMovements];
  let rows: readonly InventoryIdentityRows[InventoryIdentityKind][];
  switch (kind) {
    case "operation":
      rows = revision.command.request.operations;
      break;
    case "anchor":
      rows = effect.newAnchors;
      break;
    case "movement":
      rows = movements;
      break;
    case "quantityAllocation":
      rows = movements
        .filter(isInventoryPostedReductionMovement)
        .map((movement) => movement.quantityAllocation);
      break;
    case "postingReference":
      rows = [
        ...effect.newAnchors.flatMap((anchor) => anchor.sourcePostings),
        ...effect.journalLinkedMovements.map((movement) => movement.posting),
      ];
      break;
    default:
      throw new Error("index_identity_family_invalid");
  }
  let matches = rows.filter((row) => row.id === id);
  if (kind === "postingReference") {
    // One real source can fund several lot attributions. Only byte-equivalent
    // references may collapse; same-ID references to different sources fail.
    matches = [
      ...new Map(
        matches.map((row) => [hashCanonical(canonicalAccountingValue(row)).digest, row]),
      ).values(),
    ];
  }
  requireLedger(matches.length === 1 && matches[0] !== undefined, "index_identity_source_mismatch");
  return matches[0] as InventoryIdentityRows[K];
}

export function resolveJournalIdentity(
  retainedBytes: string,
  revisionBytes: string,
  bookId: string,
  family: "journal" | "posting",
  id: string,
) {
  requireLedger(family === "journal" || family === "posting", "index_identity_family_invalid");
  const rev = committedIdentityRevision(retainedBytes, revisionBytes, bookId);
  const matches = rev.effects.flatMap<{ booked: BookedJournal; posting: Posting | null }>(
    (effect) => {
      if (effect.type !== "journal") return [];
      const booked = effect.booked;
      if (family === "journal") return booked.journal.id === id ? [{ booked, posting: null }] : [];
      return booked.journal.postings
        .filter((posting) => posting.id === id)
        .map((posting) => ({ booked, posting }));
    },
  );
  const selected = matches[0];
  requireLedger(matches.length === 1 && selected, "index_identity_source_mismatch");
  requireLedger(
    selected.booked.journal.bookId === bookId &&
      selected.booked.commandId === rev.command.id &&
      selected.booked.bookRevision === rev.bookRevision,
    "index_identity_source_mismatch",
  );
  return Object.freeze(selected);
}

export function isAccountingIdentityFamily(value: unknown): value is AccountingEffect["type"] {
  return typeof value === "string" && Object.hasOwn(ACCOUNTING_SOURCE_COLLECTIONS, value);
}

/** Select the actual activation effect, not a rehash of today's identity.
 * Inputs must already be authenticated canonical source rows at one live head. */
export function resolveActivationIdentity(
  retainedBytes: string,
  revisionBytes: string,
  bookId: string,
  boundaryId: string,
): Extract<BookEffect, { type: "activation" }> {
  const revision = committedIdentityRevision(retainedBytes, revisionBytes, bookId);
  const matches = revision.effects.filter(
    (effect): effect is Extract<BookEffect, { type: "activation" }> => effect.type === "activation",
  );
  const effect = matches[0];
  requireLedger(
    matches.length === 1 &&
      effect &&
      effect.boundary.id === boundaryId &&
      revision.command.type === "activateBook" &&
      revision.command.boundaryId === boundaryId,
    "index_identity_source_mismatch",
  );
  return effect;
}

export const LOT_IDENTITY_COLLECTIONS = Object.freeze({
  lot: "state.lots",
  lotHolding: "state.lotHoldings",
  lotAllocation: "state.lotAllocations",
} as const);
export type LotIdentityFamily = keyof typeof LOT_IDENTITY_COLLECTIONS;
export function isLotIdentityFamily(value: unknown): value is LotIdentityFamily {
  return typeof value === "string" && Object.hasOwn(LOT_IDENTITY_COLLECTIONS, value);
}
type LotIdentityRow = BookRowTypes[(typeof LOT_IDENTITY_COLLECTIONS)[LotIdentityFamily]];
function lotIdentity(row: LotIdentityRow) {
  return "allocation" in row ? row.allocation.id : row.id;
}

/** Legacy-profile position only, NEVER the current holding value. Verified
 * kernel transitions preserve identity positions when replacing lot snapshots.
 * The owner must resolve this ordinal in the CURRENT catalog and recheck raw ID. */
export function resolveLotIdentityOrdinal(
  retainedBytes: string,
  revisionBytes: string,
  bookId: string,
  family: LotIdentityFamily,
  id: string,
): bigint {
  requireLedger(isLotIdentityFamily(family), "index_identity_family_invalid");
  const revision = committedIdentityRevision(retainedBytes, revisionBytes, bookId);
  const matches: bigint[] = [];
  for (const effect of revision.effects) {
    if (effect.type !== "lotState") continue;
    const rows =
      family === "lot"
        ? effect.lotState.lots
        : family === "lotHolding"
          ? effect.lotState.holdings
          : effect.lotState.allocations;
    for (const [i, row] of rows.entries()) {
      if (lotIdentity(row) !== id) continue;
      requireLedger(!("bookId" in row) || row.bookId === bookId, "index_identity_source_mismatch");
      matches.push(BigInt(i) + 1n);
    }
  }
  const ordinal = matches[0];
  requireLedger(matches.length === 1 && ordinal !== undefined, "index_identity_source_mismatch");
  return ordinal;
}

export function decodeLotIdentityRow<F extends LotIdentityFamily>(
  encoded: string,
  bookId: string,
  family: F,
  id: string,
): BookRowTypes[(typeof LOT_IDENTITY_COLLECTIONS)[F]] {
  requireLedger(isLotIdentityFamily(family), "index_identity_family_invalid");
  const decoded = decodeBookRow(LOT_IDENTITY_COLLECTIONS[family], encoded);
  requireLedger(decoded.disposition === "decoded", "source_catalog_row_invalid");
  requireLedger(
    lotIdentity(decoded.row) === id &&
      (!("bookId" in decoded.row) || decoded.row.bookId === bookId),
    "index_identity_source_mismatch",
  );
  return decoded.row;
}

/** Select an immutable accounting effect from an authenticated creating revision.
 * No collection ordinal, current balance, lifecycle status or range completeness
 * is inferred. The owner must first authenticate both rows and the ID locator. */
export function resolveAccountingIdentity<F extends AccountingEffect["type"]>(
  retainedBytes: string,
  revisionBytes: string,
  bookId: string,
  family: F,
  id: string,
): Extract<AccountingEffect, { readonly type: F }> {
  requireLedger(isAccountingIdentityFamily(family), "index_identity_family_invalid");
  const revision = committedIdentityRevision(retainedBytes, revisionBytes, bookId);
  const matches = revision.effects.filter(
    (effect): effect is Extract<AccountingEffect, { readonly type: F }> =>
      effect.type === family && "value" in effect && effect.value.id === id,
  );
  const effect = matches[0];
  requireLedger(matches.length === 1 && effect, "index_identity_source_mismatch");
  requireLedger(
    !("bookId" in effect.value) || effect.value.bookId === bookId,
    "index_identity_source_mismatch",
  );
  return effect;
}

/** Structural projection only. The owner must authenticate/replay the source
 * outcome and bind it to the exact canonical head. Decoding alone is not proof of
 * accounting truth. Keep this separate from the full-history audit oracle. */
function candidates(encoded: string, bookId: string): readonly Candidate[] {
  identifier(bookId);
  const decoded = decodeBookOutcome(encoded);
  requireLedger(decoded.disposition === "decoded", "index_outcome_invalid");
  const { command, revision } = decoded.payload;
  requireLedger(command.bookId === bookId, "index_canonical_scope_mismatch");
  const seen = new Map<string, Candidate>();
  const add = (family: IdentityFamily, id: string, snapshotRepeat = false) => {
    identifier(id);
    const key = JSON.stringify([family, id]);
    const previous = seen.get(key);
    requireLedger(
      !previous || (previous.snapshotRepeat && snapshotRepeat),
      "index_canonical_identity_conflict",
    );
    if (!previous) seen.set(key, Object.freeze({ bookId, family, id, snapshotRepeat }));
  };
  add("command", command.id);
  const effect = (item: BookEffect) => {
    switch (item.type) {
      case "inventoryOwnership":
        for (const anchor of item.value.newAnchors) add("inventoryAnchor", anchor.id);
        for (const movement of [
          ...item.value.journalLinkedMovements,
          ...item.value.quantityOnlyMovements,
        ]) {
          add("inventoryMovement", movement.id);
          if (isInventoryPostedReductionMovement(movement))
            add("lotAllocation", movement.quantityAllocation.id);
        }
        for (const id of new Set([
          ...item.value.newAnchors.flatMap((anchor) =>
            anchor.sourcePostings.map((source) => source.id),
          ),
          ...item.value.journalLinkedMovements.map((movement) => movement.posting.id),
        ]))
          add("inventoryPostingReference", id);
        break;
      case "activation":
        add("openingBoundary", item.boundary.id);
        break;
      case "journal":
        add("journal", item.booked.journal.id);
        for (const posting of item.booked.journal.postings) add("posting", posting.id);
        break;
      case "lotState":
        for (const lot of item.lotState.lots) add("lot", lot.id, true);
        for (const holding of item.lotState.holdings) add("lotHolding", holding.id, true);
        for (const allocation of item.lotState.allocations)
          add("lotAllocation", allocation.allocation.id, true);
        break;
      case "lotChanges":
        for (const lot of item.changes.lots) add("lot", lot.id);
        for (const holding of item.changes.holdings) add("lotHolding", holding.id, true);
        break;
      case "closePackage":
        add("closePackage", item.closePackage.id);
        break;
      case "configuration":
      case "correction":
      case "periodTransition":
        break;
      case "provisionalInventoryLayer":
      case "inventoryRecosting":
      case "inventoryValueAdjustment":
      case "openItem":
      case "settlement":
      case "settlementAllocation":
      case "remeasurementResult":
      case "remeasurementReversal":
      case "allocationSchedule":
      case "allocationRecognition":
      case "allocationScheduleRevision":
      case "taxDetermination":
      case "consolidationCompilation":
        add(item.type, item.value.id);
        break;
      default: {
        const unknownEffect: never = item;
        throw new Error(`Unsupported canonical effect: ${String(unknownEffect)}`);
      }
    }
  };
  for (const item of revision?.effects ?? []) effect(item);
  if (revision !== null && command.type === "postOwnedInventoryTransaction") {
    for (const operation of command.request.operations) add("inventoryOperation", operation.id);
  }
  return Object.freeze([...seen.values()]);
}

/** Resolve every touched identity against the exact authenticated prior index.
 * The owner supplies both-partition lookup and original outcome bytes at that
 * locator, verified in the pin's canonical prefix. Null must mean authenticated
 * absence, never missing storage or a swallowed read failure. This function does
 * not establish that owner context, authorize publication, or replay accounting.
 *
 * Only a lot-snapshot identity may already exist; its raw book/family/id must
 * appear in the original outcome. Its FIRST locator is retained, not overwritten
 * by the new snapshot. Ordinary identities (including retained rejections' command
 * IDs) must be new. Whole lot snapshots still impose their existing payload cost. */
export async function prepareOutcomeIdentityDelta(
  encoded: string,
  bookId: string,
  sequence: bigint,
  lookup: (key: string) => Promise<PriorIdentityEvidence | null>,
): Promise<readonly CanonicalIdentity[]> {
  requireLedger(
    typeof sequence === "bigint" && sequence > 0n && sequence <= (1n << 64n) - 1n,
    "index_outcome_sequence_invalid",
  );
  // Decode/copy before the first await; no mutable caller-owned payload survives.
  const source = candidates(encoded, bookId);
  const added: CanonicalIdentity[] = [];
  const keys = new Set<string>();
  for (const candidate of source) {
    const key = identityIndexKey(candidate);
    requireLedger(!keys.has(key), "index_identity_digest_collision");
    keys.add(key);
    const prior = await lookup(key);
    if (prior !== null) {
      requireLedger(
        prior !== undefined && typeof prior === "object",
        "index_identity_evidence_invalid",
      );
      const fields = Object.getOwnPropertyDescriptors(prior);
      requireLedger(
        Reflect.ownKeys(prior).length === 2 &&
          ["sequence", "encodedOutcome"].every((name) => fields[name] && "value" in fields[name]),
        "index_identity_evidence_invalid",
      );
      const ordinal: unknown = fields.sequence?.value;
      const originalBytes: unknown = fields.encodedOutcome?.value;
      requireLedger(
        typeof ordinal === "bigint" &&
          ordinal > 0n &&
          ordinal < sequence &&
          typeof originalBytes === "string",
        "index_identity_evidence_invalid",
      );
      const original = candidates(originalBytes, bookId).find(
        (entry) => identityIndexKey(entry) === key,
      );
      requireLedger(
        original && original.family === candidate.family && original.id === candidate.id,
        "index_identity_source_mismatch",
      );
      requireLedger(
        candidate.snapshotRepeat && original.snapshotRepeat,
        "index_canonical_identity_conflict",
      );
      continue;
    }
    added.push(
      Object.freeze({
        bookId,
        family: candidate.family,
        id: candidate.id,
        outcomeSequence: sequence,
      }),
    );
  }
  return Object.freeze(added);
}

export interface IndexedPriorIdentityEvidence {
  readonly sequence: bigint;
  readonly encoded: string;
  readonly authority: IndexedOutcomeSourceAuthority;
}

/** Bind the existing permanent-ID rules to the exact indexed source candidate.
 * The owner must authenticate BOTH identity-index partitions (including absence)
 * and each returned original source in the prior canonical prefix. This checks
 * exact source framing/scope/sequence/raw identity, not first-creation index
 * completeness, accounting admission, physical index publication or durability.
 * Returned entries are candidates; the owner must publish their roots with this
 * exact source/group outcome under the same full-head/fence transaction. */
export async function prepareIndexedOutcomeIdentityDelta(
  source: SqliteIndexedSourceCatalog,
  prepared: PreparedIndexedSourceCatalog,
  encoded: string,
  ports: {
    readonly confirm: () => Promise<void>;
    readonly lookup: (key: string) => Promise<IndexedPriorIdentityEvidence | null>;
  },
): Promise<readonly CanonicalIdentity[]> {
  const plan = source.describePrepared(prepared);
  requireLedger(plan.before !== null, "index_identity_outcome_required");
  const scope = plan.before.head.identity;
  const record = decodeIndexedOutcomeRecord(
    encoded,
    scope,
    scope.objectId,
    plan.before.state,
    plan.before.head,
  );
  requireLedger(
    JSON.stringify(record.after) === JSON.stringify(plan.after.head) &&
      record.state === JSON.stringify(plan.after.state),
    "index_identity_candidate_mismatch",
  );
  const { confirm, lookup } = ports;
  const check = async () => {
    await confirm();
    // The source instance validates the prior catalog/full anchor and exposes
    // privately frozen rows. Do not serialize every row again for every ID.
    const current = source.describePrepared(prepared);
    requireLedger(
      current.priorCatalogDigest === plan.priorCatalogDigest &&
        current.resultingCatalogDigest === plan.resultingCatalogDigest &&
        current.rows === plan.rows,
      "index_identity_candidate_stale",
    );
  };
  await check();
  const entries = await prepareOutcomeIdentityDelta(
    record.payload,
    scope.bookId,
    BigInt(record.after.sequence),
    async (key) => {
      await check();
      const supplied = await lookup(key);
      if (supplied === null) {
        await check();
        return null;
      }
      requireLedger(
        supplied !== undefined && typeof supplied === "object",
        "index_identity_evidence_invalid",
      );
      const fields = Object.getOwnPropertyDescriptors(supplied);
      requireLedger(
        Reflect.ownKeys(supplied).length === 3 &&
          ["sequence", "encoded", "authority"].every(
            (name) => fields[name] && "value" in fields[name],
          ),
        "index_identity_evidence_invalid",
      );
      const sequence: unknown = fields.sequence?.value,
        bytes: unknown = fields.encoded?.value;
      const authority: IndexedOutcomeSourceAuthority | undefined = fields.authority?.value;
      requireLedger(
        typeof sequence === "bigint" &&
          sequence > 0n &&
          sequence < BigInt(record.after.sequence) &&
          typeof bytes === "string" &&
          authority !== null &&
          typeof authority === "object",
        "index_identity_evidence_invalid",
      );
      requireLedger(
        authority.actualObjectId === scope.objectId &&
          JSON.stringify(completeScope(authority.scope, scope.objectId)) === JSON.stringify(scope),
        "index_identity_source_scope_mismatch",
      );
      const original = decodeIndexedOutcomeRecord(
        bytes,
        scope,
        scope.objectId,
        authority.beforeState,
        authority.beforeHead,
      );
      requireLedger(
        original.contentHash === authority.recordHash &&
          BigInt(original.after.sequence) === sequence,
        "index_identity_source_mismatch",
      );
      await check();
      return Object.freeze({ sequence, encodedOutcome: original.payload });
    },
  );
  await check();
  return entries;
}

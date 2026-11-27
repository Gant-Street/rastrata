import {
  decodeBookRow,
  hashCanonical,
  identifier,
  compareCanonicalText,
  ExactRational,
  ACCOUNTING_LIMITS,
  type BookRowTypes,
  type InventoryPostedCoordinate,
  type AccountingEffect,
} from "@rastrata/kernel";
import { requireLedger } from "./records.ts";

/** Closed first set of canonical grouping predicates. This is projection, not
 * authenticated membership: the catalog owner must commit complete groups and
 * maintain removals as well as additions under the canonical publication CAS. */
export const SEMANTIC_GROUP_VERSION = "rastrata-semantic-groups-candidate-v1";
export const SEMANTIC_GROUP_COLLECTIONS = Object.freeze({
  holdingsByLot: "state.lotHoldings",
  holdingsByAccount: "state.lotHoldings",
  nonzeroHoldingsByAccountCommodity: "state.lotHoldings",
  recognitionsBySchedule: "state.accountingState.allocationRecognitions",
  transitionsByPeriod: "state.periodTransitions",
  unrealizedByPolicy: "state.accountingState.remeasurementResults",
  reversalsByOriginalResult: "state.accountingState.remeasurementReversals",
  inventoryRevisionsByHolding: "state.revisions",
  inventoryRevisionsByMoneyScope: "state.revisions",
  inventoryRevisionsBySourceJournal: "state.revisions",
  journalsByMoneyScope: "state.journals",
  postingReferenceRevisionsById: "state.revisions",
} as const);
// These effects append their value to accountingState; none replaces or removes
// prior references. Keep this closed list exhaustive as accounting evolves.
const ACCOUNTING_REFERENCE_EFFECTS = {
  provisionalInventoryLayer: true,
  inventoryRecosting: true,
  inventoryValueAdjustment: true,
  openItem: true,
  settlement: true,
  settlementAllocation: true,
  remeasurementResult: true,
  remeasurementReversal: true,
  allocationSchedule: true,
  allocationRecognition: true,
  allocationScheduleRevision: true,
  taxDetermination: true,
  consolidationCompilation: true,
} satisfies Record<AccountingEffect["type"], true>;
/** Match the kernel's canonical accounting reference occupancy rule. Input is
 * only schema-decoded effect values, never proposals or command metadata. */
function collectPostingReferences(root: unknown, ids: Set<string>): void {
  const pending: unknown[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (
      "postingContentHash" in value &&
      "postingId" in value &&
      "journalId" in value &&
      "id" in value &&
      typeof value.id === "string"
    )
      ids.add(value.id);
    pending.push(...Object.values(value));
  }
}
export type SemanticGroupKind = keyof typeof SEMANTIC_GROUP_COLLECTIONS;
export type SemanticGroupCollection = (typeof SEMANTIC_GROUP_COLLECTIONS)[SemanticGroupKind];
export interface SemanticGroupKey {
  readonly kind: SemanticGroupKind;
  /** Raw ordered tuple; never concatenate IDs with a delimiter. */
  readonly values: readonly string[];
}
export type InventoryMoneyScope = Pick<
  InventoryPostedCoordinate,
  "bookId" | "accountId" | "functionalCommodityId" | "dimensionMemberIds"
>;
/** Public read input snapshot: reject accessors/extra fields before yielding. */
export function snapshotMoneyScope(input: InventoryMoneyScope): InventoryMoneyScope {
  requireLedger(
    input !== null &&
      typeof input === "object" &&
      (Object.getPrototypeOf(input) === Object.prototype ||
        Object.getPrototypeOf(input) === null) &&
      Object.getOwnPropertySymbols(input).length === 0,
    "money_scope_input_invalid",
  );
  const fields: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(input);
  requireLedger(
    Object.keys(fields).sort().join(",") ===
      "accountId,bookId,dimensionMemberIds,functionalCommodityId" &&
      Object.values(fields).every((field) => "value" in field && field.enumerable),
    "money_scope_input_invalid",
  );
  const dimensions = fields.dimensionMemberIds?.value;
  requireLedger(
    Array.isArray(dimensions) && Object.getOwnPropertySymbols(dimensions).length === 0,
    "money_scope_input_invalid",
  );
  const items = Object.getOwnPropertyDescriptors(dimensions) as Record<string, PropertyDescriptor>;
  const length = items.length?.value;
  requireLedger(
    Number.isInteger(length) &&
      length >= 0 &&
      length <= ACCOUNTING_LIMITS.maxInventoryLayers &&
      Object.keys(items).length === length + 1,
    "money_scope_input_invalid",
  );
  const values: string[] = [];
  let sourceBytes = 0;
  const append = (value: string) => {
    requireLedger(value.length <= 1_048_576, "semantic_group_key_too_large");
    sourceBytes += new TextEncoder().encode(value).length;
    requireLedger(sourceBytes <= 1_048_576, "semantic_group_key_too_large");
    values.push(value);
  };
  for (const field of ["bookId", "accountId", "functionalCommodityId"]) {
    const value = fields[field]?.value;
    requireLedger(typeof value === "string", "money_scope_input_invalid");
    append(value);
  }
  for (let i = 0; i < length; i++) {
    const item = items[String(i)];
    requireLedger(
      item && "value" in item && item.enumerable && typeof item.value === "string",
      "money_scope_input_invalid",
    );
    append(item.value);
  }
  const key = semanticGroupKey("journalsByMoneyScope", [
    ...values.slice(0, 3),
    ...values.slice(3).sort(compareCanonicalText),
  ]);
  return Object.freeze({
    bookId: key.values[0] as InventoryMoneyScope["bookId"],
    accountId: key.values[1] as InventoryMoneyScope["accountId"],
    functionalCommodityId: key.values[2] as InventoryMoneyScope["functionalCommodityId"],
    dimensionMemberIds: Object.freeze(
      key.values.slice(3),
    ) as InventoryMoneyScope["dimensionMemberIds"],
  });
}
export function moneyScopeValues(scope: InventoryMoneyScope): readonly string[] {
  return Object.freeze([
    scope.bookId,
    scope.accountId,
    scope.functionalCommodityId,
    ...[...scope.dimensionMemberIds].sort(compareCanonicalText),
  ]);
}
export function isMoneyScopeGroup(kind: SemanticGroupKind): boolean {
  return kind === "journalsByMoneyScope" || kind === "inventoryRevisionsByMoneyScope";
}
export function semanticGroupKey(
  kind: SemanticGroupKind,
  values: readonly string[],
): SemanticGroupKey {
  requireLedger(
    typeof kind === "string" && Object.hasOwn(SEMANTIC_GROUP_COLLECTIONS, kind),
    "semantic_group_kind_invalid",
  );
  requireLedger(
    Array.isArray(values) &&
      (isMoneyScopeGroup(kind)
        ? values.length >= 3 && values.length <= ACCOUNTING_LIMITS.maxInventoryLayers + 3
        : values.length === (kind === "nonzeroHoldingsByAccountCommodity" ? 2 : 1)),
    "semantic_group_key_invalid",
  );
  const copied: string[] = [];
  let keyBytes = 0;
  for (const value of values) {
    requireLedger(
      typeof value === "string" && value.length <= 1_048_576,
      "semantic_group_key_invalid",
    );
    identifier(value);
    if (isMoneyScopeGroup(kind)) {
      keyBytes += new TextEncoder().encode(value).length;
      requireLedger(keyBytes <= 1_048_576, "semantic_group_key_too_large");
    }
    copied.push(value);
  }
  if (isMoneyScopeGroup(kind)) {
    requireLedger(
      new TextEncoder().encode(JSON.stringify({ kind, values: copied })).length <= 1_048_576,
      "semantic_group_key_too_large",
    );
    const dimensions = copied.slice(3);
    requireLedger(
      dimensions.every((id, i) => {
        const previous = dimensions[i - 1];
        return i === 0 || (previous !== undefined && compareCanonicalText(previous, id) < 0);
      }),
      "semantic_group_key_invalid",
    );
  }
  return Object.freeze({ kind, values: Object.freeze(copied) });
}
export function semanticGroupDigest(collectionDomain: string, key: SemanticGroupKey): string {
  requireLedger(
    typeof collectionDomain === "string" && /^[0-9a-f]{64}$/.test(collectionDomain),
    "semantic_group_domain_invalid",
  );
  const copied = semanticGroupKey(key.kind, key.values);
  return hashCanonical({
    profile: SEMANTIC_GROUP_VERSION,
    collectionDomain,
    kind: copied.kind,
    values: [...copied.values],
  }).digest;
}
export interface SemanticGroupMembership {
  readonly group: SemanticGroupKey;
  readonly ordinal: bigint;
}
function validateCollectionOrdinal(collection: SemanticGroupCollection, ordinal: bigint) {
  requireLedger(
    typeof ordinal === "bigint" && ordinal > 0n && ordinal < 1n << 256n,
    "semantic_group_ordinal_invalid",
  );
  requireLedger(
    collection === "state.lotHoldings" ||
      collection === "state.accountingState.allocationRecognitions" ||
      collection === "state.periodTransitions" ||
      collection === "state.accountingState.remeasurementResults" ||
      collection === "state.accountingState.remeasurementReversals" ||
      collection === "state.revisions" ||
      collection === "state.journals",
    "semantic_group_collection_invalid",
  );
}
/** Derive ALL memberships from a schema-checked row. Include depleted holdings
 * in the lot/account groups; the inventory costing group explicitly excludes
 * zero quantity. Preserve canonical insertion ordinal for deterministic ordering. */
export function projectSemanticGroupMemberships(
  collection: SemanticGroupCollection,
  encoded: string,
  ordinal: bigint,
): readonly SemanticGroupMembership[] {
  validateCollectionOrdinal(collection, ordinal);
  const decoded = decodeBookRow(collection, encoded);
  requireLedger(decoded.disposition === "decoded", "semantic_group_row_invalid");
  const groups: SemanticGroupKey[] = [];
  if (collection === "state.lotHoldings") {
    // The collection/schema pair above supplies this exact type.
    const holding = decoded.row as BookRowTypes["state.lotHoldings"];
    groups.push(
      semanticGroupKey("holdingsByLot", [holding.lotId]),
      semanticGroupKey("holdingsByAccount", [holding.accountId]),
    );
    if (!holding.remainingQuantity.isZero())
      groups.push(
        semanticGroupKey("nonzeroHoldingsByAccountCommodity", [
          holding.accountId,
          holding.commodityId,
        ]),
      );
  } else if (collection === "state.accountingState.allocationRecognitions") {
    const recognition = decoded.row as BookRowTypes["state.accountingState.allocationRecognitions"];
    groups.push(semanticGroupKey("recognitionsBySchedule", [recognition.scheduleId]));
  } else if (collection === "state.periodTransitions") {
    const transition = decoded.row as BookRowTypes["state.periodTransitions"];
    groups.push(semanticGroupKey("transitionsByPeriod", [transition.periodId]));
  } else if (collection === "state.accountingState.remeasurementResults") {
    const result = decoded.row as BookRowTypes["state.accountingState.remeasurementResults"];
    if (result.kind === "unrealized")
      groups.push(semanticGroupKey("unrealizedByPolicy", [result.policyId]));
  } else if (collection === "state.revisions") {
    const revision = decoded.row as BookRowTypes["state.revisions"];
    const holdingIds = new Set<string>();
    const moneyScopes = new Map<string, readonly string[]>();
    const sourceJournals = new Set<string>();
    const postingReferences = new Set<string>();
    for (const effect of revision.effects) {
      if (Object.hasOwn(ACCOUNTING_REFERENCE_EFFECTS, effect.type) && "value" in effect)
        collectPostingReferences(effect.value, postingReferences);
      if (effect.type !== "inventoryOwnership") continue;
      for (const movement of [
        ...effect.value.journalLinkedMovements,
        ...effect.value.quantityOnlyMovements,
      ]) {
        holdingIds.add(movement.coordinate.holdingId);
        const values = moneyScopeValues(movement.coordinate);
        moneyScopes.set(JSON.stringify(values), values);
        if (movement.monetaryKind === "journalLinked") {
          sourceJournals.add(movement.posting.journalId);
          postingReferences.add(movement.posting.id);
        }
      }
      for (const anchor of effect.value.newAnchors)
        for (const source of anchor.sourcePostings) {
          sourceJournals.add(source.journalId);
          postingReferences.add(source.id);
        }
    }
    // A revision is one member even when several ordered operations touch a holding.
    for (const id of holdingIds) groups.push(semanticGroupKey("inventoryRevisionsByHolding", [id]));
    for (const values of moneyScopes.values())
      groups.push(semanticGroupKey("inventoryRevisionsByMoneyScope", values));
    for (const id of sourceJournals)
      groups.push(semanticGroupKey("inventoryRevisionsBySourceJournal", [id]));
    for (const id of postingReferences)
      groups.push(semanticGroupKey("postingReferenceRevisionsById", [id]));
  } else if (collection === "state.journals") {
    for (const entry of journalMoneyScopeTotals(
      decoded.row as BookRowTypes["state.journals"],
    ).values())
      groups.push(entry.key);
  } else {
    const reversal = decoded.row as BookRowTypes["state.accountingState.remeasurementReversals"];
    groups.push(semanticGroupKey("reversalsByOriginalResult", [reversal.originalResultId]));
  }
  return Object.freeze(groups.map((group) => Object.freeze({ group, ordinal })));
}

/** Exact posted money only, once per posting. Units/cost basis do not split the
 * monetary scope. Keep zero-sum journals as members: zero is not absent history. */
export function journalMoneyScopeTotals(
  booked: BookRowTypes["state.journals"],
): ReadonlyMap<string, { readonly key: SemanticGroupKey; readonly amount: ExactRational }> {
  const totals = new Map<string, { key: SemanticGroupKey; amount: ExactRational }>();
  for (const posting of booked.journal.postings) {
    const key = semanticGroupKey(
      "journalsByMoneyScope",
      moneyScopeValues({
        bookId: booked.journal.bookId,
        accountId: posting.accountId,
        functionalCommodityId: posting.bookValue.functionalCommodityId,
        dimensionMemberIds: posting.dimensionMemberIds,
      }),
    );
    const id = JSON.stringify(key);
    totals.set(
      id,
      Object.freeze({
        key,
        amount: (totals.get(id)?.amount ?? ExactRational.zero()).add(
          posting.bookValue.amount.toRational(),
        ),
      }),
    );
  }
  return totals;
}
export function encodedJournalMoneyScopeTotals(
  encoded: string,
): ReturnType<typeof journalMoneyScopeTotals> {
  const decoded = decodeBookRow("state.journals", encoded);
  requireLedger(decoded.disposition === "decoded", "semantic_group_row_invalid");
  return journalMoneyScopeTotals(decoded.row);
}

export interface SemanticGroupDelta {
  readonly group: SemanticGroupKey;
  readonly ordinal: bigint;
  readonly before: string | null;
  readonly after: string | null;
}
/** Conditional changes for every old/new group. Even unchanged membership must
 * replace the member's row commitment when its quantity/basis/other fields change.
 * Caller supplies independently authenticated row hashes and canonical old/new
 * bytes; hashes passed here are not self-authenticating accounting evidence. */
export function semanticGroupDeltas(
  collection: SemanticGroupCollection,
  ordinal: bigint,
  before: { readonly encoded: string; readonly rowHash: string } | null,
  after: { readonly encoded: string; readonly rowHash: string } | null,
): readonly SemanticGroupDelta[] {
  validateCollectionOrdinal(collection, ordinal);
  if (before !== null && after !== null)
    requireLedger(
      (before.encoded === after.encoded) === (before.rowHash === after.rowHash),
      "semantic_group_hash_incoherent",
    );
  const groups = new Map<
    string,
    { group: SemanticGroupKey; before: string | null; after: string | null }
  >();
  for (const [side, value] of [
    ["before", before],
    ["after", after],
  ] as const) {
    if (value === null) continue;
    requireLedger(
      typeof value.rowHash === "string" && /^[0-9a-f]{64}$/.test(value.rowHash),
      "semantic_group_hash_invalid",
    );
    for (const member of projectSemanticGroupMemberships(collection, value.encoded, ordinal)) {
      const identity = JSON.stringify(member.group);
      const entry = groups.get(identity) ?? { group: member.group, before: null, after: null };
      entry[side] = value.rowHash;
      groups.set(identity, entry);
    }
  }
  return Object.freeze(
    [...groups.values()]
      .filter((entry) => entry.before !== entry.after)
      .map((entry) => Object.freeze({ ...entry, ordinal })),
  );
}

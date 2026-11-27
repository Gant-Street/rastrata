import {
  hashCanonical,
  identifier,
  type AccountingCanonicalState,
  type AccountingEffect,
  type BookEffect,
  type ContentHash,
  type DurableBookAggregate,
  isInventoryPostedReductionMovement,
} from "@rastrata/kernel";
import type { ProductionLedger } from "./ledger.ts";
import {
  requireLedger,
  type LedgerHead,
  type BookScope,
  type CompleteBookScope,
  type LedgerFormat,
} from "./records.ts";

export type IdentityFamily =
  | AccountingEffect["type"]
  | "command"
  | "openingBoundary"
  | "journal"
  | "posting"
  | "lot"
  | "lotHolding"
  | "lotAllocation"
  | "inventoryOperation"
  | "inventoryAnchor"
  | "inventoryMovement"
  | "inventoryPostingReference"
  | "closePackage";
export interface CanonicalIdentity {
  readonly bookId: string;
  readonly family: IdentityFamily;
  readonly id: string;
  readonly outcomeSequence: bigint;
}
export interface IdentityPopulation {
  readonly scope: Readonly<BookScope | CompleteBookScope>;
  readonly format: LedgerFormat;
  readonly bookId: string;
  readonly head: LedgerHead;
  readonly entries: readonly CanonicalIdentity[];
  readonly populationHash: ContentHash;
}

// Separate from the effect switch: reconcile the effect-derived identity set with
// the independently materialized final canonical collections. Configuration IDs
// are version-scoped, not globally single-use object IDs. Secondary predicates
// (corrected source, schedule ordinal, closed periods, etc.) need separate indexes.
const accountingCollections = {
  provisionalInventoryLayer: "provisionalInventoryLayers",
  inventoryRecosting: "inventoryRecostings",
  inventoryValueAdjustment: "inventoryValueAdjustments",
  openItem: "openItems",
  settlement: "settlements",
  settlementAllocation: "settlementAllocations",
  remeasurementResult: "remeasurementResults",
  remeasurementReversal: "remeasurementReversals",
  allocationSchedule: "allocationSchedules",
  allocationRecognition: "allocationRecognitions",
  allocationScheduleRevision: "allocationScheduleRevisions",
  taxDetermination: "taxDeterminations",
  consolidationCompilation: "consolidationCompilations",
} satisfies Record<AccountingEffect["type"], keyof AccountingCanonicalState>;

function key(family: IdentityFamily, id: string): string {
  // Tuple encoding preserves raw identifiers and cannot collide through separators.
  return JSON.stringify([family, id]);
}
/** Internal projection of a snapshot already verified by ProductionLedger replay.
 * This performs no accounting authentication itself. */
export function projectVerifiedIdentityEntries(
  aggregate: DurableBookAggregate,
  outcomeSequence: bigint,
): readonly CanonicalIdentity[] {
  const { state, protocol } = aggregate;
  const bookId = state.identity.bookId;
  const identities = new Map<string, CanonicalIdentity>();
  const add = (family: IdentityFamily, id: string, sequence: bigint, snapshotRepeat = false) => {
    identifier(id);
    const identity = key(family, id);
    if (identities.has(identity)) {
      requireLedger(snapshotRepeat, "index_canonical_identity_conflict");
      return;
    }
    identities.set(identity, Object.freeze({ bookId, family, id, outcomeSequence: sequence }));
  };
  function effectIds(effect: BookEffect, sequence: bigint) {
    switch (effect.type) {
      case "inventoryOwnership":
        for (const anchor of effect.value.newAnchors) add("inventoryAnchor", anchor.id, sequence);
        for (const movement of [
          ...effect.value.journalLinkedMovements,
          ...effect.value.quantityOnlyMovements,
        ]) {
          add("inventoryMovement", movement.id, sequence);
          if (isInventoryPostedReductionMovement(movement))
            add("lotAllocation", movement.quantityAllocation.id, sequence);
        }
        // An actual posting may fund several anchors/movements in one group.
        // Its reference identity is created once, never once per attributed lot.
        for (const id of new Set([
          ...effect.value.newAnchors.flatMap((anchor) =>
            anchor.sourcePostings.map((reference) => reference.id),
          ),
          ...effect.value.journalLinkedMovements.map((movement) => movement.posting.id),
        ]))
          add("inventoryPostingReference", id, sequence);
        break;
      case "activation":
        add("openingBoundary", effect.boundary.id, sequence);
        break;
      case "journal":
        add("journal", effect.booked.journal.id, sequence);
        for (const posting of effect.booked.journal.postings) add("posting", posting.id, sequence);
        break;
      case "lotState":
        // Legacy lot effects carry whole snapshots. A repeated/drained holding
        // keeps its FIRST creation locator, not the most recent snapshot's Oseq.
        for (const lot of effect.lotState.lots) add("lot", lot.id, sequence, true);
        for (const holding of effect.lotState.holdings)
          add("lotHolding", holding.id, sequence, true);
        for (const allocation of effect.lotState.allocations)
          add("lotAllocation", allocation.allocation.id, sequence, true);
        break;
      case "lotChanges":
        for (const lot of effect.changes.lots) add("lot", lot.id, sequence);
        for (const holding of effect.changes.holdings)
          add("lotHolding", holding.id, sequence, true);
        break;
      case "closePackage":
        add("closePackage", effect.closePackage.id, sequence);
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
        add(effect.type, effect.value.id, sequence);
        break;
      default: {
        const unknownEffect: never = effect;
        throw new Error(`Unsupported canonical effect: ${String(unknownEffect)}`);
      }
    }
  }
  requireLedger(
    BigInt(protocol.retainedResults.length) === outcomeSequence,
    "index_canonical_cutoff_mismatch",
  );
  let revisionIndex = 0;
  protocol.retainedResults.forEach((retained, index) => {
    const sequence = BigInt(index) + 1n;
    add("command", retained.commandId, sequence);
    if (retained.outcome === "rejected") return;
    const revision = state.revisions[revisionIndex++];
    requireLedger(
      revision?.command.id === retained.commandId && revision.bookId === bookId,
      "index_canonical_revision_mismatch",
    );
    for (const effect of revision.effects) effectIds(effect, sequence);
    if (revision.command.type === "postOwnedInventoryTransaction") {
      for (const operation of revision.command.request.operations)
        add("inventoryOperation", operation.id, sequence);
    }
  });
  requireLedger(revisionIndex === state.revisions.length, "index_canonical_revision_mismatch");

  const materialized = new Set<string>();
  const final = (family: IdentityFamily, id: string) => {
    const identity = key(family, id);
    requireLedger(
      !materialized.has(identity) && identities.has(identity),
      "index_canonical_population_mismatch",
    );
    materialized.add(identity);
  };
  for (const retained of protocol.retainedResults) final("command", retained.commandId);
  if (state.openingBoundary) final("openingBoundary", state.openingBoundary.id);
  for (const journal of state.journals) {
    final("journal", journal.journal.id);
    for (const posting of journal.journal.postings) final("posting", posting.id);
  }
  for (const lot of state.lots) final("lot", lot.id);
  for (const holding of state.lotHoldings) final("lotHolding", holding.id);
  for (const allocation of state.lotAllocations) final("lotAllocation", allocation.allocation.id);
  const references = new Set<string>();
  for (const ownership of state.inventoryOwnershipEffects ?? []) {
    for (const anchor of ownership.newAnchors) {
      final("inventoryAnchor", anchor.id);
      for (const source of anchor.sourcePostings) references.add(source.id);
    }
    for (const movement of [
      ...ownership.journalLinkedMovements,
      ...ownership.quantityOnlyMovements,
    ]) {
      final("inventoryMovement", movement.id);
      if (isInventoryPostedReductionMovement(movement))
        final("lotAllocation", movement.quantityAllocation.id);
      if (movement.monetaryKind === "journalLinked") references.add(movement.posting.id);
    }
  }
  for (const id of references) final("inventoryPostingReference", id);
  for (const retained of protocol.retainedResults)
    if (
      retained.outcome === "committed" &&
      retained.command.type === "postOwnedInventoryTransaction"
    ) {
      for (const operation of retained.command.request.operations)
        final("inventoryOperation", operation.id);
    }
  for (const close of state.closePackages) final("closePackage", close.id);
  for (const family of Object.keys(accountingCollections) as AccountingEffect["type"][]) {
    for (const value of state.accountingState[accountingCollections[family]])
      final(family, value.id);
  }
  requireLedger(materialized.size === identities.size, "index_canonical_population_mismatch");
  return Object.freeze(
    [...identities.values()].sort((a, b) => {
      const left = key(a.family, a.id),
        right = key(b.family, b.id);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  );
}

/** Legacy audit framing remains unchanged. New-format owners use the shared
 * exact identity entries without manufacturing a legacy head over new hashes. */
export function projectVerifiedIdentityPopulation(
  aggregate: DurableBookAggregate,
  head: LedgerHead,
  scope: Readonly<BookScope | CompleteBookScope>,
  format: LedgerFormat,
): IdentityPopulation {
  const entries = projectVerifiedIdentityEntries(aggregate, BigInt(head.sequence));
  const bookId = aggregate.state.identity.bookId;
  const cutoff = Object.freeze({ ...head });
  const populationHash = hashCanonical({
    domain: "rastrata-canonical-identity-audit-v1",
    bookId,
    head: { ...cutoff },
    entries: entries.map((entry) => ({ ...entry })),
  });
  return Object.freeze({ bookId, head: cutoff, entries, populationHash, scope, format });
}

/** Slow audit/rebuild oracle: obtains an independently replay-verified snapshot
 * through the real ledger API. Inherits the prototype's full-aggregate limits;
 * never use this whole-population scan for ordinary indexed command admission. */
export async function readCanonicalIdentityPopulation(
  ledger: ProductionLedger,
  cutoff?: bigint,
): Promise<IdentityPopulation> {
  const snapshot = cutoff === undefined ? await ledger.read() : await ledger.readAt(cutoff);
  return projectVerifiedIdentityPopulation(
    snapshot.aggregate,
    snapshot.head,
    snapshot.scope,
    snapshot.format,
  );
}

/** Compares enumerated identities with canonical evidence, not a supplied success
 * flag/count/hash. The enumeration MUST separately be bound to authenticated index
 * pages and this captured cutoff. This report is not page integrity or readiness. */
export async function auditIdentityEntries(
  ledger: ProductionLedger,
  enumerate: (cutoff: {
    readonly bookId: string;
    readonly head: LedgerHead;
  }) => Iterable<CanonicalIdentity> | AsyncIterable<CanonicalIdentity>,
) {
  const source = await readCanonicalIdentityPopulation(ledger);
  const expected = new Map(source.entries.map((entry) => [key(entry.family, entry.id), entry]));
  const seen = new Set<string>();
  for await (const input of enumerate(
    Object.freeze({ bookId: source.bookId, head: source.head }),
  )) {
    requireLedger(input !== null && typeof input === "object", "index_identity_entry_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    requireLedger(
      Reflect.ownKeys(input).length === 4 &&
        ["bookId", "family", "id", "outcomeSequence"].every(
          (name) => descriptors[name] && "value" in descriptors[name],
        ),
      "index_identity_entry_invalid",
    );
    requireLedger(
      typeof input.family === "string" &&
        typeof input.id === "string" &&
        typeof input.outcomeSequence === "bigint",
      "index_identity_entry_invalid",
    );
    const identity = key(input.family, input.id);
    requireLedger(!seen.has(identity), "index_identity_duplicate");
    const original = expected.get(identity);
    requireLedger(
      original &&
        input.bookId === source.bookId &&
        original.outcomeSequence === input.outcomeSequence,
      "index_identity_mismatch",
    );
    seen.add(identity);
  }
  requireLedger(seen.size === expected.size, "index_identity_population_incomplete");
  return Object.freeze({
    bookId: source.bookId,
    head: source.head,
    identities: BigInt(expected.size),
    populationHash: source.populationHash,
    exactEntriesVerified: true as const,
    pageIntegrityVerified: false as const,
  });
}

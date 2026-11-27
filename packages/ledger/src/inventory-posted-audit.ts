import {
  ExactRational,
  canonicalPostingValue,
  compareCanonicalText,
  hashCanonical,
  hashQuantizationPolicy,
  contentHashEquals,
  type BookState,
  type BookedJournal,
  type ContentHash,
  type LotHolding,
  type LotHoldingId,
  type PostingId,
} from "@rastrata/kernel";
import type { BookScope, LedgerHead } from "./records.ts";
import {
  resolveInventoryPostedShares,
  type InventoryPostedWitness,
  type PostedShareTarget,
} from "./inventory-posted-witness.ts";

export interface InventoryPostedAuditFinding {
  readonly code:
    | "ambiguous_posted_allocation"
    | "posted_witness_mismatch"
    | "posted_witness_source_mismatch"
    | "unused_posted_witness"
    | "missing_posted_source"
    | "coordinate_conflict"
    | "transfer_value_mismatch"
    | "unsupported_correction"
    | "unsupported_owned_effect"
    | "unattributed_posting"
    | "negative_posted_balance"
    | "movement_sign_conflict"
    | "movement_precedes_lot_acquisition"
    | "negative_economic_quantity"
    | "zero_carrying_posted_residual"
    | "depleted_posted_residual";
  readonly reference: string;
  readonly observedAmount?: string;
  readonly bookRevision?: bigint;
}
export interface InventoryPostedMovement {
  readonly holdingId: LotHoldingId;
  readonly postingId: PostingId;
  readonly journalId: string;
  readonly effectKey: string;
  readonly bookRevision: bigint;
  readonly postingHash: ContentHash;
  readonly quantizationPolicyHash: ContentHash;
  readonly postedAmount: ExactRational;
  readonly attribution: "canonical" | "proposed";
}
export interface InventoryPostedBalance {
  readonly holdingId: LotHoldingId;
  readonly accountId: string;
  readonly commodityId: string;
  readonly functionalCommodityId: string;
  readonly dimensionMemberIds: readonly string[];
  readonly postedCarryingAmount: ExactRational;
}
interface AuditSource {
  readonly scope: Readonly<BookScope>;
  readonly head: Readonly<LedgerHead>;
}
interface EconomicInstant {
  readonly wholeSecondMillis: number;
  readonly fraction: string;
}
function economicInstant(value: string): EconomicInstant {
  // Recovered instants already passed the kernel codec. Preserve every supplied
  // fractional digit: Date.parse alone truncates to milliseconds. Parse only the
  // integral second/UTC offset, and compare normalized decimal fractions as text.
  const match = /^(.{19})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) throw new Error("Invalid recovered inventory instant");
  const wholeSecondMillis = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSecondMillis)) throw new Error("Invalid recovered inventory instant");
  return { wholeSecondMillis, fraction: (match[2] ?? "").replace(/0+$/, "") };
}
function compareEconomicInstants(left: EconomicInstant, right: EconomicInstant): number {
  return (
    left.wholeSecondMillis - right.wholeSecondMillis ||
    compareCanonicalText(left.fraction, right.fraction)
  );
}
export type InventoryPostedAudit = AuditSource & {
  readonly sourceHash: ContentHash;
  readonly witnessHash?: ContentHash;
} & (
    | {
        readonly disposition: "attributed" | "proposedAttribution";
        readonly balances: readonly InventoryPostedBalance[];
        readonly movements: readonly InventoryPostedMovement[];
      }
    | {
        readonly disposition: "requiresReview";
        readonly findings: readonly InventoryPostedAuditFinding[];
      }
  );

/** Internal read-only audit of a fully recovered snapshot. Canonical attribution
 * remains distinct from an explicitly supplied, versioned allocation proposal.
 * Neither is a policy opt-in, anchor, migration, authorization, or promise that
 * the snapshot is still current. */
export function auditRecoveredInventoryPostings(
  state: BookState,
  source: AuditSource,
  witness?: InventoryPostedWitness,
): InventoryPostedAudit {
  const base = {
    scope: Object.freeze({ ...source.scope }),
    head: Object.freeze({ ...source.head }),
    sourceHash: hashCanonical({
      domain: "rastrata-inventory-posted-audit-source-v1",
      scope: { ...source.scope },
      head: { ...source.head },
    }),
    ...(witness === undefined ? {} : { witnessHash: witness.contentHash }),
  };
  if (witness !== undefined && !contentHashEquals(witness.sourceHash, base.sourceHash))
    return Object.freeze({
      ...base,
      disposition: "requiresReview",
      findings: Object.freeze([
        Object.freeze({
          code: "posted_witness_source_mismatch" as const,
          reference: witness.sourceHash.digest,
        }),
      ]),
    });
  const witnessRows = new Map(witness?.postings.map((row) => [row.postingId, row]));
  const consumedWitnesses = new Set<PostingId>();
  const quantizationPolicies = state.configurationSnapshots
    .flatMap((snapshot) => snapshot.quantizationPolicies)
    .map((policy) => ({ policy, hash: hashQuantizationPolicy(policy) }));
  let proposed = false;
  const findings: InventoryPostedAuditFinding[] = [];
  const movements: InventoryPostedMovement[] = [];
  const balances = new Map<LotHoldingId, ExactRational>();
  const dimensions = new Map<LotHoldingId, readonly string[]>();
  const seenPostings = new Set<PostingId>();
  const touched = new Set<LotHoldingId>();
  const lots = new Map(state.lots.map((lot) => [lot.id, lot]));
  const quantityChanges: {
    holdingId: LotHoldingId;
    economicTime: EconomicInstant;
    bookRevision: bigint;
    quantity: ExactRational;
  }[] = [];
  const trackedAccounts = new Set(state.lotHoldings.map((holding) => holding.accountId));
  let known = new Map<LotHoldingId, LotHolding>();
  const find = (
    code: InventoryPostedAuditFinding["code"],
    reference: string,
    amount?: ExactRational,
    bookRevision?: bigint,
  ) => {
    findings.push(
      Object.freeze({
        code,
        reference,
        ...(amount === undefined ? {} : { observedAmount: amount.toString() }),
        ...(bookRevision === undefined ? {} : { bookRevision }),
      }),
    );
  };
  const movementGroup = (
    targets: readonly PostedShareTarget[],
    booked: BookedJournal | undefined,
    postingId: PostingId,
    direction: "increase" | "decrease",
    reference: string,
    inheritedProposal = false,
  ) => {
    const posting = booked?.journal.postings.find((posting) => posting.id === postingId);
    if (
      booked === undefined ||
      posting === undefined ||
      targets.some((target) => !known.has(target.holdingId))
    ) {
      find("missing_posted_source", reference);
      return;
    }
    if (seenPostings.has(posting.id)) {
      find("ambiguous_posted_allocation", posting.id);
      return;
    }
    const row = witnessRows.get(postingId);
    if (row !== undefined) consumedWitnesses.add(postingId);
    const policy = quantizationPolicies.find((entry) =>
      contentHashEquals(entry.hash, booked.quantizationPolicySnapshotHash),
    )?.policy;
    if (policy === undefined) {
      find("missing_posted_source", reference);
      return;
    }
    const result = resolveInventoryPostedShares(
      targets,
      posting.bookValue.amount,
      hashCanonical(canonicalPostingValue(posting)),
      policy,
      row,
    );
    if (result.disposition !== "resolved") {
      find(
        result.disposition === "missing"
          ? "ambiguous_posted_allocation"
          : "posted_witness_mismatch",
        reference,
      );
      return;
    }
    const attribution = row !== undefined || inheritedProposal ? "proposed" : "canonical";
    proposed ||= attribution === "proposed";
    seenPostings.add(posting.id);
    for (const [holdingId, postedAmount] of result.shares) {
      const holding = known.get(holdingId);
      if (holding === undefined) throw new Error("Missing checked holding");
      const coordinate = [...posting.dimensionMemberIds].sort(compareCanonicalText);
      const prior = dimensions.get(holdingId);
      if (
        posting.accountId !== holding.accountId ||
        posting.bookValue.functionalCommodityId !== holding.basisCommodityId ||
        (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(coordinate))
      ) {
        find("coordinate_conflict", `${holdingId}:${postingId}`);
      }
      dimensions.set(holdingId, Object.freeze(coordinate));
      if (
        direction === "increase"
          ? postedAmount.isNegative()
          : postedAmount.compare(ExactRational.zero()) > 0
      )
        find("movement_sign_conflict", posting.id, postedAmount);
      balances.set(holdingId, (balances.get(holdingId) ?? ExactRational.zero()).add(postedAmount));
      touched.add(holdingId);
      movements.push(
        Object.freeze({
          holdingId,
          postingId,
          journalId: booked.journal.id,
          effectKey: booked.effectKey,
          bookRevision: booked.bookRevision,
          postingHash: hashCanonical(canonicalPostingValue(posting)),
          quantizationPolicyHash: Object.freeze({ ...booked.quantizationPolicySnapshotHash }),
          postedAmount,
          attribution,
        }),
      );
    }
    return { shares: result.shares, proposed: attribution === "proposed" };
  };
  const quantityMovement = (
    holdingId: LotHoldingId,
    quantity: ExactRational,
    booked: BookedJournal | undefined,
  ) => {
    const holding = known.get(holdingId);
    const lot = holding === undefined ? undefined : lots.get(holding.lotId);
    if (booked === undefined || lot === undefined) {
      find("missing_posted_source", holdingId);
      return;
    }
    const economicTime = economicInstant(booked.journal.economicAt);
    if (compareEconomicInstants(economicTime, economicInstant(lot.acquiredAt)) < 0)
      find("movement_precedes_lot_acquisition", holdingId, undefined, booked.bookRevision);
    quantityChanges.push({ holdingId, economicTime, bookRevision: booked.bookRevision, quantity });
  };
  for (const revision of state.revisions) {
    touched.clear();
    const command = revision.command;
    if (revision.effects.some((effect) => effect.type === "lotChanges")) {
      find("unsupported_owned_effect", command.id, undefined, revision.bookRevision);
      continue;
    }
    const journal = revision.effects.find((effect) => effect.type === "journal");
    const booked = journal?.type === "journal" ? journal.booked : undefined;
    const lotState = revision.effects.find((effect) => effect.type === "lotState");
    const after = lotState?.type === "lotState" ? lotState.lotState : undefined;
    if (
      command.type === "correctJournal" ||
      command.type === "reopenPeriod" ||
      command.type === "closePeriod"
    ) {
      if (
        revision.effects.some(
          (effect) =>
            effect.type === "journal" &&
            effect.booked.journal.postings.some((posting) =>
              trackedAccounts.has(posting.accountId),
            ),
        )
      ) {
        find("unsupported_correction", command.id);
      }
    }
    if ("lotOperations" in command && command.lotOperations !== undefined) {
      for (const operation of command.lotOperations) {
        if (operation.type === "acquire") {
          known.set(operation.holding.id, operation.holding);
          quantityMovement(operation.holding.id, operation.holding.remainingQuantity, booked);
          movementGroup(
            [
              {
                holdingId: operation.holding.id,
                exactWeight: operation.holding.remainingCarryingAmount,
              },
            ],
            booked,
            operation.journalPostingId,
            "increase",
            command.id,
          );
          continue;
        }
        const allocationIds =
          operation.type === "dispose" ? operation.identities : operation.allocationIdentities;
        const allocations =
          after?.allocations.filter((entry) =>
            allocationIds.some((id) => id.allocationId === entry.allocation.id),
          ) ?? [];
        if (allocations.length === 0) {
          find("missing_posted_source", command.id);
          continue;
        }
        const targets = allocations.map(({ allocation }) => ({
          holdingId: allocation.holdingId,
          exactWeight: allocation.allocatedCarryingAmount,
        }));
        for (const { allocation } of allocations)
          quantityMovement(allocation.holdingId, allocation.allocatedQuantity.negate(), booked);
        if (operation.type === "dispose") {
          movementGroup(targets, booked, operation.journalPostingId, "decrease", command.id);
          continue;
        }
        const acceptedSource = movementGroup(
          targets,
          booked,
          operation.sourcePostingId,
          "decrease",
          command.id,
        );
        if (acceptedSource === undefined) continue;
        const destinationTargets = new Map<LotHoldingId, PostedShareTarget>();
        for (const [sourceId, amount] of acceptedSource.shares) {
          const sourceHolding = known.get(sourceId);
          const priorDestination = [...known.values()].find(
            (holding) =>
              holding.lotId === sourceHolding?.lotId &&
              holding.accountId === operation.destinationAccountId,
          );
          const destinationId =
            priorDestination?.id ??
            operation.destinationIdentities.find(
              (identity) => identity.sourceHoldingId === sourceId,
            )?.destinationHoldingId;
          const destination = after?.holdings.find((holding) => holding.id === destinationId);
          if (destination === undefined) {
            find("missing_posted_source", command.id);
            continue;
          }
          known.set(destination.id, destination);
          for (const { allocation } of allocations)
            if (allocation.holdingId === sourceId)
              quantityMovement(destination.id, allocation.allocatedQuantity, booked);
          const priorTarget = destinationTargets.get(destination.id);
          destinationTargets.set(destination.id, {
            holdingId: destination.id,
            exactWeight: ExactRational.zero(),
            prescribedAmount: (priorTarget?.prescribedAmount ?? ExactRational.zero()).subtract(
              amount,
            ),
          });
        }
        const sourcePosting = booked?.journal.postings.find(
          (posting) => posting.id === operation.sourcePostingId,
        );
        const destinationPosting = booked?.journal.postings.find(
          (posting) => posting.id === operation.destinationPostingId,
        );
        if (
          sourcePosting === undefined ||
          destinationPosting === undefined ||
          !sourcePosting.bookValue.amount
            .toRational()
            .add(destinationPosting.bookValue.amount.toRational())
            .isZero()
        ) {
          find("transfer_value_mismatch", command.id);
        }
        movementGroup(
          [...destinationTargets.values()],
          booked,
          operation.destinationPostingId,
          "increase",
          command.id,
          acceptedSource.proposed,
        );
      }
    }
    if (command.type === "adjustInventoryValue") {
      const inventoryId = `${command.request.id}-inventory` as PostingId;
      const posting = booked?.journal.postings.find((posting) => posting.id === inventoryId);
      const targets = command.request.allocations.filter(
        (allocation) =>
          !allocation.remainingBasisChange
            .add(allocation.remainingValuationAllowanceChange)
            .isZero(),
      );
      if (targets.length > 0) {
        if (targets.some((target) => target.holdingId === undefined) || posting === undefined)
          find("missing_posted_source", command.id);
        else {
          const changes = targets.map((target) =>
            target.remainingBasisChange.add(target.remainingValuationAllowanceChange),
          );
          const negative = changes[0]?.isNegative() ?? false;
          // Opposite-signed changes cannot be inferred from one net posting.
          if (changes.some((amount) => amount.isNegative() !== negative))
            find("ambiguous_posted_allocation", command.id);
          else
            movementGroup(
              targets.map((target, index) => ({
                holdingId: target.holdingId as LotHoldingId,
                exactWeight: negative
                  ? (changes[index] as ExactRational).negate()
                  : (changes[index] as ExactRational),
              })),
              booked,
              inventoryId,
              negative ? "decrease" : "increase",
              command.id,
            );
        }
      }
    }
    if (after !== undefined)
      known = new Map(after.holdings.map((holding) => [holding.id, holding]));
    // A later inflow must not hide an earlier completed negative/depleted state.
    // Inspect only this revision's touched IDs, not every historical holding.
    for (const id of touched) {
      const holding = known.get(id);
      const balance = balances.get(id);
      if (holding === undefined || balance === undefined)
        find("missing_posted_source", id, undefined, revision.bookRevision);
      else {
        if (balance.isNegative())
          find("negative_posted_balance", id, balance, revision.bookRevision);
        if (holding.remainingQuantity.isZero() && !balance.isZero())
          find("depleted_posted_residual", id, balance, revision.bookRevision);
        if (holding.remainingCarryingAmount.isZero() && !balance.isZero())
          find("zero_carrying_posted_residual", id, balance, revision.bookRevision);
      }
    }
  }
  // Inspect economic quantity prefixes without reordering canonical outcomes or
  // recomputing costing. All changes to one holding in the same journal are
  // atomic; equal economic instants in different revisions retain commit order.
  quantityChanges.sort(
    (left, right) =>
      compareEconomicInstants(left.economicTime, right.economicTime) ||
      (left.bookRevision < right.bookRevision
        ? -1
        : left.bookRevision > right.bookRevision
          ? 1
          : 0) ||
      compareCanonicalText(left.holdingId, right.holdingId),
  );
  const economicQuantities = new Map<LotHoldingId, ExactRational>();
  for (let index = 0; index < quantityChanges.length; ) {
    const first = quantityChanges[index];
    if (first === undefined) throw new Error("Missing quantity audit event");
    let delta = first.quantity;
    index++;
    while (index < quantityChanges.length) {
      const next = quantityChanges[index];
      if (
        next === undefined ||
        next.bookRevision !== first.bookRevision ||
        next.holdingId !== first.holdingId
      )
        break;
      delta = delta.add(next.quantity);
      index++;
    }
    const quantity = (economicQuantities.get(first.holdingId) ?? ExactRational.zero()).add(delta);
    economicQuantities.set(first.holdingId, quantity);
    if (quantity.isNegative())
      find("negative_economic_quantity", first.holdingId, quantity, first.bookRevision);
  }
  // Account-level unclassified postings could be an adjustment or correction to
  // owned inventory. Do not silently discard them or declare a migration safe.
  for (const booked of state.journals)
    for (const posting of booked.journal.postings) {
      if (trackedAccounts.has(posting.accountId) && !seenPostings.has(posting.id))
        find("unattributed_posting", posting.id, posting.bookValue.amount.toRational());
    }
  for (const holding of state.lotHoldings) {
    const balance = balances.get(holding.id);
    if (balance === undefined) find("missing_posted_source", holding.id);
    else {
      if (balance.isNegative()) find("negative_posted_balance", holding.id, balance);
      if (holding.remainingQuantity.isZero() && !balance.isZero())
        find("depleted_posted_residual", holding.id, balance);
      if (holding.remainingCarryingAmount.isZero() && !balance.isZero())
        find("zero_carrying_posted_residual", holding.id, balance);
    }
  }
  for (const id of witnessRows.keys())
    if (!consumedWitnesses.has(id)) find("unused_posted_witness", id);
  if (findings.length > 0)
    return Object.freeze({
      ...base,
      disposition: "requiresReview",
      findings: Object.freeze(findings),
    });
  return Object.freeze({
    ...base,
    disposition: proposed ? "proposedAttribution" : "attributed",
    movements: Object.freeze(movements),
    balances: Object.freeze(
      state.lotHoldings.map((holding) =>
        Object.freeze({
          holdingId: holding.id,
          accountId: holding.accountId,
          commodityId: holding.commodityId,
          functionalCommodityId: holding.basisCommodityId,
          dimensionMemberIds: dimensions.get(holding.id) ?? Object.freeze([]),
          postedCarryingAmount: balances.get(holding.id) ?? ExactRational.zero(),
        }),
      ),
    ),
  });
}

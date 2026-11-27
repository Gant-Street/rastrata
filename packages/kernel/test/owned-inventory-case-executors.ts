import assert from "node:assert/strict";
import {
  ExactDecimal, ExactRational, STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  canonicalPolicyValue, canonicalPostingReferenceId, commandId, createBookState,
  decodeDurableBook, encodeDurableBook, executeBookCommand, hashAccountingPolicy,
  hashCanonical, hashInventoryPostedAnchor, identifier, instant, localDate,
  lotHoldingId, lotId, postingId, resolveInventoryOwnershipSources, sealCommand,
  semanticVersion, type InventoryCostPolicy, type OwnedInventoryTransactionRequest,
} from "../src/index.ts";
import { IDS, freshState, policy, quantizationPolicy } from "./fixtures.ts";
import { accountingDerivation, capability, pool } from "./accounting-fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import type { ObservedDesignCase } from "./design-case-executors.ts";

export interface OwnedInventoryCaseInput {
  readonly quantity: string;
  readonly algorithm_version: string;
  readonly fake_posting_id?: string;
  readonly proposed_posted_budget?: string;
}

/** Real canonical acquisition, not a calculator draft or hand-assembled anchor. */
function acquisition(input: OwnedInventoryCaseInput) {
  const base = freshState(), configuration = base.state.activeConfigurationSnapshot;
  const inventory: InventoryCostPolicy = {
    kind: "inventoryCost", id: accountingDerivation.policyId, version: accountingDerivation.policyVersion,
    bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"),
    quantizationPolicy, capability: capability("inventoryCost", "fifo"), method: "fifo",
    pools: [pool("inventory", "cash")], shortageTreatment: "reject",
  };
  const state = createBookState(base.state.identity, configuration.periods, configuration.admissionSnapshot,
    configuration.policies, configuration.quantizationPolicies, [inventory], configuration.effectiveAt, STRUCTURAL_SOURCE_IDENTITY_PROFILE);
  const initial = executeBookCommand(state, base.protocol, activationCommand());
  assert.equal(initial.result.disposition, "committed");
  const [n, d = "1"] = input.quantity.split("/");
  const quantity = ExactRational.of(BigInt(n!), BigInt(d)), zero = ExactRational.zero();
  const lot = { id: lotId("design-owned-lot"), bookId: IDS.book, commodityId: IDS.usd, basisCommodityId: IDS.usd,
    acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: quantity, acquisitionTotalBasis: zero,
    evidenceIds: accountingDerivation.evidence.map(e => e.id) };
  const request: OwnedInventoryTransactionRequest = {
    algorithm: "cumulativePostedInventoryV1", algorithmVersion: semanticVersion(input.algorithm_version),
    accountingDate: localDate("2026-01-15"), governedAt: lot.acquiredAt, fiscalPeriodId: IDS.period1,
    operations: [{ kind: "acquisition", ordinal: 0n, id: identifier<"InventoryOperation">("design-owned-acquire"),
      coordinate: { accountId: IDS.cash, unitsCommodityId: IDS.usd, dimensionMemberIds: [],
        bookingPolicy: { policyId: policy.id, policyVersion: policy.version, policyContentHash: hashCanonical(canonicalPolicyValue(policy)) } },
      inventoryPolicy: { policyId: inventory.id, policyVersion: inventory.version, policyContentHash: hashAccountingPolicy(inventory) },
      derivation: accountingDerivation,
      ...(input.fake_posting_id === undefined ? {} : { postingLink: { journalOrdinal: 0n,
        postingId: postingId(input.fake_posting_id), referenceId: canonicalPostingReferenceId("design-fake-reference") } }),
      entries: [{ lot, holding: { id: lotHoldingId("design-owned-holding"), lotId: lot.id, bookId: IDS.book,
        accountId: IDS.cash, commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: quantity,
        remainingTotalBasis: zero, remainingValuationAllowance: zero, remainingCarryingAmount: zero },
        anchorId: identifier<"InventoryPostedAnchor">("design-owned-anchor"),
        movementId: identifier<"InventoryPostedMovement">("design-owned-movement"), evidence: accountingDerivation.evidence }],
    }], resolvedJournals: [],
  };
  const command = sealCommand({ type: "postOwnedInventoryTransaction", request, id: commandId("design-owned-command"),
    bookId: IDS.book, expectedBookRevision: initial.state.bookRevision, actorId: IDS.actor, protocolVersion: semanticVersion("1.0.0"),
    issuedAt: instant("2026-01-15T13:00:00Z"), completedAt: instant("2026-01-15T13:00:01Z"), committedAt: instant("2026-01-15T13:00:02Z") });
  return { initial, command, result: executeBookCommand(initial.state, initial.protocol, command) };
}

export function ownedCommandCase(input: OwnedInventoryCaseInput): ObservedDesignCase {
  const { initial, command, result } = acquisition(input);
  const restored = decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol }));
  assert.equal(restored.disposition, "decoded");
  const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
  assert.equal(retry.result.disposition, "replayed");
  assert.deepEqual(retry.result, { ...result.result, disposition: "replayed" });
  assert.equal(encodeDurableBook({ state: retry.state, protocol: retry.protocol }), encodeDurableBook(restored.aggregate));
  const effect = result.state.inventoryOwnershipEffects?.[0];
  return { outcome: result.result.disposition === "committed" ? "admit" : "reject", facts: {
    ...(result.result.disposition === "rejected" ? { diagnostic: result.result.diagnostics[0]!.code,
      diagnostic_path: result.result.diagnostics[0]!.path } : {}),
    revision_delta: Number(result.state.bookRevision - initial.state.bookRevision),
    posting_sequence_delta: Number(result.state.latestPostingSequence - initial.state.latestPostingSequence),
    journal_count: result.state.journals.length - initial.state.journals.length,
    quantity_only_movements: effect?.quantityOnlyMovements.length ?? 0,
    remaining_quantity: result.state.lotHoldings[0]?.remainingQuantity.toString() ?? null,
    durable_retry_identical: true,
  } };
}

export function ownedAnchorCase(input: OwnedInventoryCaseInput): ObservedDesignCase {
  const { result } = acquisition(input);
  assert.equal(result.result.disposition, "committed");
  const effect = result.state.inventoryOwnershipEffects![0]!, original = effect.newAnchors[0]!;
  const position = effect.quantityOnlyMovements[0]!.afterPosition, holding = result.state.lotHoldings[0]!;
  // Rehash the hostile proposal: this tests historical authority, not merely a bad checksum.
  const body = { ...original, postedBudget: ExactDecimal.parse(input.proposed_posted_budget!) };
  const anchor = { ...body, contentHash: hashInventoryPostedAnchor(body) };
  const resolved = resolveInventoryOwnershipSources({ bookId: IDS.book, bookRevision: result.state.bookRevision,
    assertCurrent() {}, readCurrentHolding: () => holding, readCurrentPosition: () => position,
    readAnchor: () => anchor, readPositionAfterImage: () => position }, [holding.id]);
  return { outcome: resolved.disposition === "resolved" ? "admit" : "reject", facts: {
    ...(resolved.disposition === "rejected" ? { diagnostic: resolved.diagnostics[0]!.code,
      diagnostic_path: resolved.diagnostics[0]!.path } : {}),
    revision_delta: 0, posting_sequence_delta: 0,
    original_posted_budget: original.postedBudget.toString(),
    proposed_posted_budget: anchor.postedBudget.toString(),
  } };
}

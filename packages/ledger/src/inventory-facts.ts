import {
  ACCOUNTING_LIMITS,
  commandInputHash,
  compareCanonicalText,
  type BookCommand,
  type InventoryCostPolicy,
  type InventoryLayerInput,
  type BookRowTypes,
} from "@rastrata/kernel";
import type { PinnedBookBasis } from "./book-basis.ts";
import type { PinnedGroupCursor } from "./group-reader.ts";
import type { CapturedRow } from "./source-catalog.ts";
import { requireLedger } from "./records.ts";

export interface PinnedInventoryCostFacts {
  readonly commandId: BookCommand["id"];
  readonly commandInputHash: BookCommand["inputHash"];
  readonly basis: PinnedBookBasis;
  /** First exact ID/version match, not proof of temporal/capability admission. */
  readonly policy: InventoryCostPolicy | null;
  readonly layers: readonly InventoryLayerInput[];
  readonly sources: readonly {
    readonly holdingId: string;
    readonly holdingOrdinal: bigint;
    readonly holdingRowHash: string;
    readonly lotId: string;
    readonly lotOrdinal: bigint;
    readonly lotRowHash: string;
  }[];
}
export type InventoryLotSource = {
  readonly id: string;
  readonly headHash: string;
  readonly catalogDigest: string;
} & (
  | {
      readonly disposition: "present";
      readonly current: CapturedRow & { readonly row: BookRowTypes["state.lots"] };
    }
  | { readonly disposition: "absent"; readonly current: null }
);
interface Ports {
  readonly basis: () => Promise<PinnedBookBasis>;
  readonly openGroup: (
    values: readonly string[],
  ) => Promise<PinnedGroupCursor<"nonzeroHoldingsByAccountCommodity">>;
  readonly lot: (id: string) => Promise<InventoryLotSource>;
  readonly confirm: () => Promise<void>;
}

/** Complete current pool reads only, not costing or command admission. The owner
 * serializes this whole operation; ports must not enqueue behind their caller.
 * All matching groups are exhausted, even if the request supplies fewer layers.
 * Count is bounded by the kernel's executable layer limit; source rows also retain
 * the current legacy profile's row/aggregate bounds. No historical arrays escape. */
export async function readPinnedInventoryCostFacts(
  command: Extract<BookCommand, { type: "postInventoryTransaction" }>,
  ports: Ports,
): Promise<PinnedInventoryCostFacts> {
  const basis = await ports.basis();
  requireLedger(command.bookId === basis.header.identity.bookId, "ledger_identity_mismatch");
  const policy =
    basis.configuration.row.accountingPolicySnapshot.policies.find(
      (p): p is InventoryCostPolicy =>
        p.kind === "inventoryCost" &&
        p.id === command.request.policyId &&
        p.version === command.request.policyVersion,
    ) ?? null;
  const layers: InventoryLayerInput[] = [];
  const sources: PinnedInventoryCostFacts["sources"][number][] = [];
  const seenHoldings = new Set<string>();
  const seenAccounts = new Set<string>();
  // Cache only the compact fields needed for costing/lineage, not entire lot rows.
  const lots = new Map<
    string,
    {
      acquiredAt: InventoryLayerInput["acquiredAt"];
      ordinal: bigint;
      rowHash: string;
      commodityId: string;
      basisCommodityId: string;
    }
  >();
  for (const pool of policy?.pools ?? []) {
    if (seenAccounts.has(pool.accountId)) continue;
    seenAccounts.add(pool.accountId);
    const cursor = await ports.openGroup([pool.accountId, command.inventoryCommodityId]);
    const priorCount = layers.length;
    try {
      while (true) {
        const page = await cursor.next();
        requireLedger(
          page.headHash === basis.headHash &&
            page.catalogDigest === basis.catalogDigest &&
            page.key.kind === "nonzeroHoldingsByAccountCommodity" &&
            page.key.values.length === 2 &&
            page.key.values[0] === pool.accountId &&
            page.key.values[1] === command.inventoryCommodityId,
          "inventory_facts_view_mismatch",
        );
        requireLedger(
          BigInt(priorCount) + page.population <= BigInt(ACCOUNTING_LIMITS.maxInventoryLayers),
          "inventory_facts_population_limit",
        );
        for (const member of page.rows) {
          const holding = member.row;
          requireLedger(
            holding.bookId === command.bookId &&
              member.ordinal > 0n &&
              holding.accountId === pool.accountId &&
              holding.commodityId === command.inventoryCommodityId &&
              !holding.remainingQuantity.isZero() &&
              !seenHoldings.has(holding.id),
            "inventory_facts_holding_mismatch",
          );
          seenHoldings.add(holding.id);
          requireLedger(
            layers.length < ACCOUNTING_LIMITS.maxInventoryLayers,
            "inventory_facts_population_limit",
          );
          let lot = lots.get(holding.lotId);
          if (lot === undefined) {
            const found = await ports.lot(holding.lotId);
            requireLedger(
              found.headHash === basis.headHash &&
                found.catalogDigest === basis.catalogDigest &&
                found.id === holding.lotId &&
                found.disposition === "present",
              "inventory_facts_lot_missing",
            );
            requireLedger(
              found.current.headHash === basis.headHash &&
                found.current.catalogDigest === basis.catalogDigest &&
                found.current.disposition === "present" &&
                found.current.encoded !== null &&
                found.current.collection === "state.lots" &&
                found.current.ordinal > 0n &&
                found.current.rowHash !== null &&
                found.current.row.id === holding.lotId &&
                found.current.row.bookId === command.bookId,
              "inventory_facts_lot_mismatch",
            );
            lot = Object.freeze({
              acquiredAt: found.current.row.acquiredAt,
              ordinal: found.current.ordinal,
              rowHash: found.current.rowHash,
              commodityId: found.current.row.commodityId,
              basisCommodityId: found.current.row.basisCommodityId,
            });
            lots.set(holding.lotId, lot);
          }
          requireLedger(
            lot.commodityId === holding.commodityId &&
              lot.basisCommodityId === holding.basisCommodityId,
            "inventory_facts_lot_mismatch",
          );
          layers.push(
            Object.freeze({
              id: holding.id,
              accountId: holding.accountId,
              acquiredAt: lot.acquiredAt,
              quantity: holding.remainingQuantity,
              totalBasis: holding.remainingTotalBasis,
            }),
          );
          sources.push(
            Object.freeze({
              holdingId: holding.id,
              holdingOrdinal: member.ordinal,
              holdingRowHash: member.rowHash,
              lotId: holding.lotId,
              lotOrdinal: lot.ordinal,
              lotRowHash: lot.rowHash,
            }),
          );
        }
        if (page.complete) {
          requireLedger(
            BigInt(layers.length - priorCount) === page.consumed &&
              page.consumed === page.population,
            "inventory_facts_population_mismatch",
          );
          break;
        }
        requireLedger(page.rows.length > 0, "inventory_facts_population_mismatch");
      }
    } finally {
      await cursor.close();
    }
  }
  layers.sort((a, b) => compareCanonicalText(a.id, b.id));
  sources.sort((a, b) => compareCanonicalText(a.holdingId, b.holdingId));
  await ports.confirm();
  return Object.freeze({
    commandId: command.id,
    commandInputHash: commandInputHash(command),
    basis,
    policy,
    layers: Object.freeze(layers),
    sources: Object.freeze(sources),
  });
}

import {
  ACCOUNTING_LIMITS,
  commandInputHash,
  contentHashEquals,
  hashAccountingPolicy,
  type BookCommand,
  type BookRowTypes,
  type InventoryCostPolicy,
  type CommodityId,
  type AccountId,
} from "@rastrata/kernel";
import type { PinnedBookBasis } from "./book-basis.ts";
import type { PinnedGroupCursor, GroupMember } from "./group-reader.ts";
import type { InventoryLotSource } from "./inventory-facts.ts";
import { requireLedger, snapshotCommand } from "./records.ts";

type OwnedCommand = Extract<BookCommand, { type: "postOwnedInventoryTransaction" }>;
type PolicyReference = OwnedCommand["request"]["operations"][number]["inventoryPolicy"];
type Holding = BookRowTypes["state.lotHoldings"];
interface PoolEntry {
  readonly holding: Holding;
  readonly lot: BookRowTypes["state.lots"];
  readonly holdingOrdinal: bigint;
  readonly holdingRowHash: string;
  readonly lotOrdinal: bigint;
  readonly lotRowHash: string;
}
interface AccountEvidence {
  readonly accountId: AccountId;
  readonly memberHash: string | null;
  readonly population: bigint;
  readonly matchingPopulation: bigint;
}
export type PinnedOwnedInventoryPool = {
  /** Array positions, not acceptance of caller-supplied operation ordinals. */
  readonly operationIndices: readonly number[];
  readonly policyReference: PolicyReference;
  readonly inventoryCommodityId: CommodityId;
} & (
  | {
      readonly disposition: "unresolvedPolicy";
      readonly reason: "missing" | "ambiguous" | "hashMismatch";
      readonly policy: null;
      readonly entries: null;
      readonly accounts: null;
    }
  | {
      readonly disposition: "resolved";
      readonly policy: InventoryCostPolicy;
      readonly entries: readonly PoolEntry[];
      readonly accounts: readonly AccountEvidence[];
    }
);
export interface PinnedOwnedInventoryPools {
  readonly commandId: OwnedCommand["id"];
  readonly commandInputHash: OwnedCommand["inputHash"];
  readonly basis: PinnedBookBasis;
  readonly pools: readonly PinnedOwnedInventoryPool[];
  readonly scannedHoldings: number;
  readonly sourceRowBytes: number;
}
interface Ports {
  readonly basis: () => Promise<PinnedBookBasis>;
  readonly openAccount: (accountId: string) => Promise<PinnedGroupCursor<"holdingsByAccount">>;
  readonly lot: (id: string) => Promise<InventoryLotSource>;
  readonly confirm: () => Promise<void>;
}
// Internal candidate read budget, not a business-capacity or retention limit.
const MAX_SOURCE_ROW_BYTES = 32 * 1024 * 1024;

/** Current source pools only. Preserve the existing owned algorithm's inclusion
 * of depleted holdings; it validates all rows before selecting nonzero layers.
 * No policy-time/capability admission, working overlay, selection, ownership
 * adoption or command intent is supplied by this read. All ports share one owner
 * operation and must not enqueue behind it. No callback object survives awaits. */
export async function readPinnedOwnedInventoryPools(
  input: BookCommand,
  ports: Ports,
): Promise<PinnedOwnedInventoryPools> {
  const command = snapshotCommand(input);
  requireLedger(command.type === "postOwnedInventoryTransaction", "owned_pool_command_invalid");
  const { basis: readBasis, openAccount, lot: readLot, confirm } = ports;
  const basis = await readBasis();
  requireLedger(command.bookId === basis.header.identity.bookId, "ledger_identity_mismatch");
  const requests = new Map<
    string,
    { reference: PolicyReference; commodity: CommodityId; indices: number[] }
  >();
  command.request.operations.forEach((operation, index) => {
    if (operation.kind !== "issue" && operation.kind !== "transfer") return;
    const ref = operation.inventoryPolicy,
      commodity = operation.coordinate.unitsCommodityId;
    const key = JSON.stringify([
      ref.policyId,
      ref.policyVersion,
      ref.policyContentHash.algorithm,
      ref.policyContentHash.canonicalizationVersion,
      ref.policyContentHash.digest,
      commodity,
    ]);
    const request = requests.get(key) ?? { reference: ref, commodity, indices: [] };
    request.indices.push(index);
    requests.set(key, request);
  });
  const accounts = new Map<
    string,
    {
      rows: readonly GroupMember<"holdingsByAccount">[];
      memberHash: string | null;
      population: bigint;
    }
  >();
  const lots = new Map<
    string,
    { row: BookRowTypes["state.lots"]; ordinal: bigint; rowHash: string }
  >();
  const seenHoldings = new Set<string>();
  let scannedHoldings = 0,
    sourceRowBytes = 0,
    emittedEntries = 0;
  const chargeBytes = (encoded: string) => {
    sourceRowBytes += new TextEncoder().encode(encoded).length;
    requireLedger(sourceRowBytes <= MAX_SOURCE_ROW_BYTES, "owned_pool_source_bytes_limit");
  };
  const pools: PinnedOwnedInventoryPool[] = [];
  for (const request of requests.values()) {
    const common = {
      operationIndices: Object.freeze(request.indices),
      policyReference: request.reference,
      inventoryCommodityId: request.commodity,
    };
    const matches = basis.configuration.row.accountingPolicySnapshot.policies.filter(
      (p): p is InventoryCostPolicy =>
        p.kind === "inventoryCost" &&
        p.id === request.reference.policyId &&
        p.version === request.reference.policyVersion,
    );
    const policy = matches[0];
    if (
      matches.length !== 1 ||
      policy === undefined ||
      !contentHashEquals(hashAccountingPolicy(policy), request.reference.policyContentHash)
    ) {
      pools.push(
        Object.freeze({
          ...common,
          disposition: "unresolvedPolicy",
          reason:
            matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : "hashMismatch",
          policy: null,
          entries: null,
          accounts: null,
        }),
      );
      continue;
    }
    requireLedger(policy.bookId === command.bookId, "owned_pool_policy_scope_mismatch");
    const entries: PoolEntry[] = [],
      evidence: AccountEvidence[] = [];
    const policyAccounts = new Set(policy.pools.map((pool) => pool.accountId));
    for (const accountId of policyAccounts) {
      let account = accounts.get(accountId);
      if (account === undefined) {
        const cursor = await openAccount(accountId);
        const rows: GroupMember<"holdingsByAccount">[] = [];
        let population: bigint | undefined, memberHash: string | null | undefined;
        let lastOrdinal = 0n;
        try {
          while (true) {
            const page = await cursor.next();
            requireLedger(
              page.headHash === basis.headHash &&
                page.catalogDigest === basis.catalogDigest &&
                page.key.kind === "holdingsByAccount" &&
                page.key.values.length === 1 &&
                page.key.values[0] === accountId,
              "owned_pool_view_mismatch",
            );
            requireLedger(
              (population === undefined || population === page.population) &&
                (memberHash === undefined || memberHash === page.memberHash) &&
                page.population >= 0n &&
                BigInt(scannedHoldings - rows.length) + page.population <=
                  BigInt(ACCOUNTING_LIMITS.maxInventoryLayers),
              "owned_pool_population_limit",
            );
            population = page.population;
            memberHash = page.memberHash;
            for (const member of page.rows) {
              const holding = member.row;
              requireLedger(
                member.ordinal > lastOrdinal &&
                  holding.bookId === command.bookId &&
                  holding.accountId === accountId &&
                  !seenHoldings.has(holding.id),
                "owned_pool_holding_mismatch",
              );
              requireLedger(
                scannedHoldings < ACCOUNTING_LIMITS.maxInventoryLayers,
                "owned_pool_population_limit",
              );
              chargeBytes(member.encoded);
              lastOrdinal = member.ordinal;
              seenHoldings.add(holding.id);
              scannedHoldings++;
              rows.push(member);
            }
            requireLedger(
              page.consumed === BigInt(rows.length) && page.consumed <= page.population,
              "owned_pool_population_mismatch",
            );
            if (page.complete) {
              requireLedger(page.consumed === page.population, "owned_pool_population_mismatch");
              break;
            }
            requireLedger(
              page.rows.length > 0 && page.consumed < page.population,
              "owned_pool_population_mismatch",
            );
          }
        } finally {
          await cursor.close();
        }
        requireLedger(
          population !== undefined &&
            memberHash !== undefined &&
            (population === 0n) === (memberHash === null),
          "owned_pool_population_mismatch",
        );
        account = Object.freeze({ rows: Object.freeze(rows), population, memberHash });
        accounts.set(accountId, account);
      }
      let matchingPopulation = 0n;
      for (const member of account.rows) {
        const holding = member.row;
        if (holding.commodityId !== request.commodity) continue;
        requireLedger(
          emittedEntries < ACCOUNTING_LIMITS.maxInventoryLayers,
          "owned_pool_population_limit",
        );
        emittedEntries++;
        matchingPopulation++;
        let lot = lots.get(holding.lotId);
        if (lot === undefined) {
          const found = await readLot(holding.lotId);
          requireLedger(
            found.id === holding.lotId &&
              found.headHash === basis.headHash &&
              found.catalogDigest === basis.catalogDigest &&
              found.disposition === "present",
            "owned_pool_lot_missing",
          );
          const current = found.current;
          requireLedger(
            current.disposition === "present" &&
              current.collection === "state.lots" &&
              current.ordinal > 0n &&
              current.encoded !== null &&
              current.rowHash !== null &&
              current.headHash === basis.headHash &&
              current.catalogDigest === basis.catalogDigest &&
              current.row.id === holding.lotId &&
              current.row.bookId === command.bookId,
            "owned_pool_lot_mismatch",
          );
          chargeBytes(current.encoded);
          lot = Object.freeze({
            row: current.row,
            ordinal: current.ordinal,
            rowHash: current.rowHash,
          });
          lots.set(holding.lotId, lot);
        }
        requireLedger(
          lot.row.commodityId === holding.commodityId &&
            lot.row.basisCommodityId === holding.basisCommodityId,
          "owned_pool_lot_mismatch",
        );
        entries.push(
          Object.freeze({
            holding,
            lot: lot.row,
            holdingOrdinal: member.ordinal,
            holdingRowHash: member.rowHash,
            lotOrdinal: lot.ordinal,
            lotRowHash: lot.rowHash,
          }),
        );
      }
      evidence.push(
        Object.freeze({
          accountId,
          memberHash: account.memberHash,
          population: account.population,
          matchingPopulation,
        }),
      );
    }
    // Match the original full-state pool order even when policies list accounts
    // in another order. Cost selection itself owns its policy-specific ordering.
    entries.sort((a, b) =>
      a.holdingOrdinal < b.holdingOrdinal ? -1 : a.holdingOrdinal > b.holdingOrdinal ? 1 : 0,
    );
    pools.push(
      Object.freeze({
        ...common,
        disposition: "resolved",
        policy,
        entries: Object.freeze(entries),
        accounts: Object.freeze(evidence),
      }),
    );
  }
  await confirm();
  return Object.freeze({
    commandId: command.id,
    commandInputHash: commandInputHash(command),
    basis,
    pools: Object.freeze(pools),
    scannedHoldings,
    sourceRowBytes,
  });
}

import {
  canonicalAccountingValue,
  contentHashEquals,
  decodeBookRow,
  encodeBookRow,
  decodeInventoryOwnershipArtifact,
  encodeInventoryOwnershipArtifact,
  hashCanonical,
  isInventoryPostedReductionMovement,
  type BookCommand,
  type BookEffect,
  type CurrentBookContext,
  type BookStateHeader,
  type InventoryOwnershipArtifactKind,
  type InventoryPostedMovement,
  type InventoryPostedPosition,
  type LotHolding,
  type OwnedInventoryIdentityKind,
} from "@rastrata/kernel";
import { requireLedger } from "./records.ts";
import type { NativeLedgerFact, NativeLedgerTransaction } from "./native-ledger-repository.ts";
import type { nativeMoney } from "./native-money.ts";

const collections: Record<OwnedInventoryIdentityKind, string> = {
  operation: "inventoryOperations",
  lot: "lots",
  holding: "inventoryHoldingIds",
  anchor: "inventoryAnchors",
  movement: "inventoryMovements",
  allocation: "inventoryAllocationIds",
  postingReference: "postingReferenceIds",
};
const keyOf = (collection: string, key: string) => JSON.stringify([collection, key]);
const poolKey = (book: string, account: string, commodity: string) =>
  hashCanonical({ inventoryPool: [book, account, commodity] }).digest;
function required<T>(value: T | undefined | null): T {
  requireLedger(value !== undefined && value !== null, "native_ledger_inventory_incomplete");
  return value;
}
function artifact<K extends InventoryOwnershipArtifactKind>(kind: K, encoded: string) {
  const decoded = decodeInventoryOwnershipArtifact(kind, encoded);
  requireLedger(decoded.disposition === "decoded", "native_ledger_inventory_corrupt");
  return decoded.artifact;
}
function same(left: unknown, right: unknown) {
  return contentHashEquals(
    hashCanonical(canonicalAccountingValue(left)),
    hashCanonical(canonicalAccountingValue(right)),
  );
}
function positionFact(holding: LotHolding, position: InventoryPostedPosition): NativeLedgerFact {
  return {
    collection: "inventoryPositions",
    key: holding.id,
    mutable: true,
    encoded: JSON.stringify({
      accountId: holding.accountId,
      commodityId: holding.commodityId,
      active: !holding.remainingQuantity.isZero(),
      holding: encodeBookRow("state.lotHoldings", holding),
      position: encodeInventoryOwnershipArtifact("position", position),
    }),
  };
}

/** Permanent membership, shared with the full kernel's accounting-source walk.
 * The index does not confer authority on the reference or its claimed posting. */
export function postingReferenceIdentityKeys(value: unknown) {
  const ids = new Set<string>(),
    pending = [value],
    seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (
      "postingContentHash" in item &&
      "postingId" in item &&
      "journalId" in item &&
      "id" in item &&
      typeof item.id === "string"
    )
      ids.add(item.id);
    pending.push(...Object.values(item));
  }
  return [...ids].map((key) => ({ collection: "postingReferenceIds", key }));
}
export function projectPostingReferenceIdentities(
  view: NativeLedgerTransaction,
  effects: readonly BookEffect[],
  observed: ReadonlyMap<string, NativeLedgerFact | null>,
): readonly NativeLedgerFact[] {
  const keys = postingReferenceIdentityKeys(effects),
    found = new Map(observed);
  const missing = keys.filter((key) => !found.has(keyOf(key.collection, key.key)));
  for (let offset = 0; offset < missing.length; offset += 750) {
    const batch = missing.slice(offset, offset + 750),
      rows = view.facts(batch);
    for (const [index, key] of batch.entries()) {
      const row = rows[index];
      requireLedger(row !== undefined, "native_ledger_inventory_incomplete");
      found.set(keyOf(key.collection, key.key), row);
    }
  }
  return keys.flatMap((key) => {
    const row = found.get(keyOf(key.collection, key.key));
    requireLedger(row !== undefined, "native_ledger_inventory_incomplete");
    requireLedger(
      row === null || (row.mutable !== true && row.encoded === "present"),
      "native_ledger_inventory_corrupt",
    );
    return row === null ? [{ ...key, encoded: "present" }] : [];
  });
}

/** Native new-zero books have only owned inventory writes: legacy lot commands
 * and adoption remain unsupported. Immutable origins and permanent identities
 * are retained; selection scans only active positions and reconciles pool counts.
 * The owner keeps this context inside its synchronous publication transaction. */
export function readNativeInventory(
  view: NativeLedgerTransaction,
  command: Extract<BookCommand, { type: "postOwnedInventoryTransaction" }>,
  header: BookStateHeader,
  money: ReturnType<typeof nativeMoney>,
  initial: Map<string, NativeLedgerFact | null>,
) {
  const cache = initial,
    sourceHead = JSON.stringify(view.head);
  const load = (keys: readonly { collection: string; key: string }[]) => {
    const missing = [
      ...new Map(
        keys
          .filter((key) => !cache.has(keyOf(key.collection, key.key)))
          .map((key) => [keyOf(key.collection, key.key), key]),
      ).values(),
    ];
    for (let offset = 0; offset < missing.length; offset += 750) {
      const batch = missing.slice(offset, offset + 750),
        rows = view.facts(batch);
      for (const [index, key] of batch.entries()) {
        const row = rows[index];
        requireLedger(row !== undefined, "native_ledger_inventory_incomplete");
        cache.set(keyOf(key.collection, key.key), row);
      }
    }
  };
  const fact = (collection: string, key: string) => {
    load([{ collection, key }]);
    const value = cache.get(keyOf(collection, key));
    requireLedger(value !== undefined, "native_ledger_inventory_incomplete");
    return value;
  };
  const claims: { collection: string; key: string }[] = [];
  const claim = (kind: OwnedInventoryIdentityKind, key: string) =>
    claims.push({ collection: collections[kind], key });
  for (const op of command.request.operations) {
    claim("operation", op.id);
    if (op.postingLink) claim("postingReference", op.postingLink.referenceId);
    if (op.kind === "acquisition")
      for (const entry of op.entries) {
        claim("lot", entry.lot.id);
        claim("holding", entry.holding.id);
        claim("anchor", entry.anchorId);
        claim("movement", entry.movementId);
      }
    if (op.kind === "issue")
      for (const entry of op.identities) {
        claim("allocation", entry.allocationId);
        claim("movement", entry.movementId);
      }
    if (op.kind === "transfer") {
      if (op.destinationPostingLink)
        claim("postingReference", op.destinationPostingLink.referenceId);
      for (const entry of op.entries) {
        claim("lot", entry.destinationLotId);
        claim("holding", entry.destinationHoldingId);
        claim("anchor", entry.destinationAnchorId);
        claim("movement", entry.destinationMovementId);
        claim("movement", entry.transferOutMovementId);
        claim("allocation", entry.allocationId);
      }
    }
  }
  claims.push(
    ...claims
      .filter((key) => key.collection === "inventoryHoldingIds")
      .map((key) => ({ collection: "inventoryPositions", key: key.key })),
  );
  load(claims);
  money.read(
    command.request.operations
      .flatMap((operation) =>
        operation.kind === "acquisition"
          ? [operation.coordinate]
          : operation.kind === "transfer"
            ? [operation.destinationCoordinate]
            : [],
      )
      .map((coordinate) => ({
        bookId: header.identity.bookId,
        accountId: coordinate.accountId,
        functionalCommodityId: header.identity.functionalCommodityId,
        dimensionMemberIds: coordinate.dimensionMemberIds,
      })),
  );
  type Position = { holding: LotHolding; position: InventoryPostedPosition };
  const positions = new Map<string, Position | null>();
  const decodePosition = (stored: NativeLedgerFact): Position => {
    const body = JSON.parse(stored.encoded);
    requireLedger(
      body && typeof body.holding === "string" && typeof body.position === "string",
      "native_ledger_inventory_corrupt",
    );
    const holding = decodeBookRow("state.lotHoldings", body.holding);
    requireLedger(holding.disposition === "decoded", "native_ledger_inventory_corrupt");
    const position = artifact("position", body.position);
    requireLedger(
      stored.collection === "inventoryPositions" &&
        holding.row.id === stored.key &&
        holding.row.bookId === header.identity.bookId &&
        position.holdingId === stored.key &&
        position.originBookRevision <= header.bookRevision &&
        stored.mutable === true &&
        stored.encoded === positionFact(holding.row, position).encoded,
      "native_ledger_inventory_corrupt",
    );
    return { holding: holding.row, position };
  };
  const currentPosition = (id: string): Position | null => {
    if (!positions.has(id)) {
      load([
        { collection: "inventoryPositions", key: id },
        { collection: "inventoryHoldingIds", key: id },
      ]);
      const stored = fact("inventoryPositions", id),
        identity = fact("inventoryHoldingIds", id);
      requireLedger(
        stored === null
          ? identity === null
          : identity !== null && identity.mutable !== true && identity.encoded === "present",
        "native_ledger_inventory_incomplete",
      );
      positions.set(id, stored === null ? null : decodePosition(stored));
    }
    const value = positions.get(id);
    requireLedger(value !== undefined, "native_ledger_inventory_incomplete");
    return value;
  };
  const movement = (id: string): InventoryPostedMovement => {
    const stored = required(fact("inventoryMovements", id));
    const body = JSON.parse(stored.encoded);
    requireLedger(
      stored.mutable !== true &&
        body &&
        (body.kind === "reductionMovement" || body.kind === "acquisitionMovement") &&
        typeof body.value === "string" &&
        JSON.stringify({ kind: body.kind, value: body.value }) === stored.encoded,
      "native_ledger_inventory_corrupt",
    );
    const value = artifact(body.kind as "reductionMovement" | "acquisitionMovement", body.value);
    requireLedger(
      value.id === id &&
        value.coordinate.bookId === header.identity.bookId &&
        value.bookRevision <= header.bookRevision,
      "native_ledger_inventory_corrupt",
    );
    return value;
  };
  const pools = new Map<
    string,
    { account: string; commodity: string; exists: boolean; count: number }
  >();
  const readPoolCounts = (accounts: readonly string[], commodity: string) => {
    load(
      accounts.flatMap((account) => {
        const key = poolKey(header.identity.bookId, account, commodity);
        return ["inventoryPoolIds", "inventoryPoolCounts"].map((collection) => ({
          collection,
          key,
        }));
      }),
    );
    for (const account of accounts) {
      const key = poolKey(header.identity.bookId, account, commodity);
      if (pools.has(key)) continue;
      const id = fact("inventoryPoolIds", key),
        counter = fact("inventoryPoolCounts", key);
      const raw = JSON.stringify([header.identity.bookId, account, commodity]);
      requireLedger(
        id === null
          ? counter === null
          : id.mutable !== true && id.encoded === raw && counter?.mutable === true,
        "native_ledger_inventory_incomplete",
      );
      const count: unknown = counter === null ? 0 : JSON.parse(counter.encoded);
      requireLedger(
        typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0 &&
          (counter === null || JSON.stringify(count) === counter.encoded),
        "native_ledger_inventory_corrupt",
      );
      pools.set(key, { account, commodity, count, exists: id !== null });
    }
  };
  const context: NonNullable<CurrentBookContext["ownedInventoryFacts"]> = {
    ownership: {
      bookId: header.identity.bookId,
      bookRevision: header.bookRevision,
      assertCurrent: () => {
        view.facts([]); // Also checks the repository transaction's lifetime.
        requireLedger(
          JSON.stringify(view.head) === sourceHead,
          "native_ledger_inventory_scope_changed",
        );
      },
      readCurrentHolding: (id) => currentPosition(id)?.holding,
      readCurrentPosition: (id) => currentPosition(id)?.position,
      readAnchor: (reference) => {
        const stored = required(fact("inventoryAnchors", reference.id));
        requireLedger(stored.mutable !== true, "native_ledger_inventory_corrupt");
        const anchor = artifact("anchor", stored.encoded);
        requireLedger(
          anchor.id === reference.id &&
            anchor.coordinate.bookId === header.identity.bookId &&
            anchor.bookRevision <= header.bookRevision &&
            anchor.bookRevision === reference.bookRevision &&
            anchor.effectKey === reference.effectKey &&
            anchor.artifactOrdinal === reference.artifactOrdinal &&
            contentHashEquals(anchor.contentHash, reference.contentHash),
          "native_ledger_inventory_corrupt",
        );
        return anchor;
      },
      readPositionAfterImage: (origin) => {
        const value = movement(origin.movementId);
        requireLedger(
          value.effectKey === origin.effectKey &&
            value.artifactOrdinal === origin.artifactOrdinal &&
            value.bookRevision === origin.bookRevision,
          "native_ledger_inventory_corrupt",
        );
        return value.afterPosition;
      },
    },
    identityPresence: (kind, id) => (fact(collections[kind], id) === null ? "absent" : "present"),
    latestMovementDate: (id) => {
      const position = required(currentPosition(id)).position;
      const value = movement(position.originMovementId);
      requireLedger(same(position, value.afterPosition), "native_ledger_inventory_corrupt");
      return value.accountingDate;
    },
    // Proven by new-zero provisioning plus the closed native command set: no
    // legacy holding can enter this profile. Never reuse this for imported books.
    hasLiveUnownedStock: () => false,
    postedMoneyBalance: (scope) => money.balance(scope),
    readPool: (policy, commodity) => {
      const accounts = [...new Set(policy.pools.map((pool) => pool.accountId))];
      readPoolCounts(accounts, commodity);
      const rows = view.activeInventoryPositions(accounts, commodity);
      const counts = new Map<string, number>(),
        entries: Position[] = [];
      for (const row of rows) {
        const value = decodePosition(row);
        requireLedger(
          accounts.includes(value.holding.accountId) &&
            value.holding.commodityId === commodity &&
            !value.holding.remainingQuantity.isZero(),
          "native_ledger_inventory_corrupt",
        );
        cache.set(keyOf("inventoryPositions", row.key), row);
        counts.set(value.holding.accountId, (counts.get(value.holding.accountId) ?? 0) + 1);
        entries.push(value);
      }
      for (const account of accounts)
        requireLedger(
          (counts.get(account) ?? 0) ===
            required(pools.get(poolKey(header.identity.bookId, account, commodity))).count,
          "native_ledger_inventory_pool_incomplete",
        );
      load(
        entries.flatMap((value) => [
          { collection: "lots", key: value.holding.lotId },
          { collection: "inventoryHoldingIds", key: value.holding.id },
          { collection: "inventoryAnchors", key: value.position.anchor.id },
          { collection: "inventoryMovements", key: value.position.originMovementId },
        ]),
      );
      return entries.map((value) => {
        const stored = required(fact("lots", value.holding.lotId));
        const lot = decodeBookRow("state.lots", stored.encoded);
        requireLedger(
          stored.mutable !== true &&
            lot.disposition === "decoded" &&
            lot.row.id === value.holding.lotId &&
            lot.row.bookId === header.identity.bookId,
          "native_ledger_inventory_corrupt",
        );
        const current = required(currentPosition(value.holding.id));
        requireLedger(
          same(current.position, movement(current.position.originMovementId).afterPosition),
          "native_ledger_inventory_corrupt",
        );
        return { holding: current.holding, lot: lot.row };
      });
    },
  };
  return {
    context,
    project(effects: readonly BookEffect[]): readonly NativeLedgerFact[] {
      const ownership = effects.find((effect) => effect.type === "inventoryOwnership");
      const delta = effects.find((effect) => effect.type === "lotChanges");
      if (!ownership && !delta) return [];
      requireLedger(
        ownership?.type === "inventoryOwnership" && delta?.type === "lotChanges",
        "native_ledger_inventory_incomplete",
      );
      const facts: NativeLedgerFact[] = [];
      const latest = new Map<string, InventoryPostedMovement>();
      const movements = [
        ...ownership.value.journalLinkedMovements,
        ...ownership.value.quantityOnlyMovements,
      ].sort((a, b) => (a.artifactOrdinal < b.artifactOrdinal ? -1 : 1));
      for (const op of command.request.operations)
        facts.push({ collection: "inventoryOperations", key: op.id, encoded: "present" });
      for (const lot of delta.changes.lots)
        facts.push({ collection: "lots", key: lot.id, encoded: encodeBookRow("state.lots", lot) });
      for (const anchor of ownership.value.newAnchors)
        facts.push({
          collection: "inventoryAnchors",
          key: anchor.id,
          encoded: encodeInventoryOwnershipArtifact("anchor", anchor),
        });
      for (const value of movements) {
        latest.set(value.coordinate.holdingId, value);
        const kind = isInventoryPostedReductionMovement(value)
          ? "reductionMovement"
          : "acquisitionMovement";
        const encoded = isInventoryPostedReductionMovement(value)
          ? encodeInventoryOwnershipArtifact("reductionMovement", value)
          : encodeInventoryOwnershipArtifact("acquisitionMovement", value);
        facts.push({
          collection: "inventoryMovements",
          key: value.id,
          encoded: JSON.stringify({ kind, value: encoded }),
        });
        if (isInventoryPostedReductionMovement(value))
          facts.push({
            collection: "inventoryAllocationIds",
            key: value.quantityAllocation.id,
            encoded: "present",
          });
      }
      const changes = new Map<string, number>();
      const poolAccounts = new Map<string, Set<string>>();
      for (const holding of delta.changes.holdings) {
        const accounts = poolAccounts.get(holding.commodityId) ?? new Set<string>();
        accounts.add(holding.accountId);
        poolAccounts.set(holding.commodityId, accounts);
      }
      for (const [commodity, accounts] of poolAccounts) readPoolCounts([...accounts], commodity);
      for (const holding of delta.changes.holdings) {
        const before = currentPosition(holding.id),
          value = required(latest.get(holding.id));
        requireLedger(value.coordinate.holdingId === holding.id, "native_ledger_inventory_corrupt");
        if (before === null)
          facts.push({ collection: "inventoryHoldingIds", key: holding.id, encoded: "present" });
        facts.push(positionFact(holding, value.afterPosition));
        const key = poolKey(header.identity.bookId, holding.accountId, holding.commodityId);
        const count = changes.get(key) ?? required(pools.get(key)).count;
        changes.set(
          key,
          count +
            (holding.remainingQuantity.isZero() ? 0 : 1) -
            (before === null || before.holding.remainingQuantity.isZero() ? 0 : 1),
        );
      }
      for (const [key, count] of changes) {
        const pool = required(pools.get(key));
        requireLedger(
          Number.isSafeInteger(count) && count >= 0,
          "native_ledger_inventory_pool_limit",
        );
        if (!pool.exists)
          facts.push({
            collection: "inventoryPoolIds",
            key,
            encoded: JSON.stringify([header.identity.bookId, pool.account, pool.commodity]),
          });
        facts.push({
          collection: "inventoryPoolCounts",
          key,
          mutable: true,
          encoded: JSON.stringify(count),
        });
      }
      return facts;
    },
  };
}

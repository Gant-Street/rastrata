import {
  ExactRational,
  MAX_EXACT_INTEGER_BITS,
  canonicalPostingSourceIdentity,
  hashCanonical,
  decodeBookRow,
  encodeBookRow,
  type BookCommand,
  type ApplySettlementCommand,
  type BookConfigurationSnapshot,
  type BookEffect,
  type CanonicalPostingReference,
  type BookSettlementContext,
  type OpenItem,
  type Settlement,
} from "@rastrata/kernel";
import { requireLedger } from "./records.ts";
import { readNativeSourcePopulation } from "./native-allocation.ts";
import type { NativeLedgerFact, NativeLedgerTransaction } from "./native-ledger-repository.ts";

const TOTALS = "openItemAllocatedTotals";
const PAYMENT_TOTALS = "settlementAllocatedTotals";
const encoder = new TextEncoder();
type Totals = { bookValue: ExactRational; quantity: ExactRational; allocations: bigint };
const emptyTotals = (): Totals => ({
  bookValue: ExactRational.zero(),
  quantity: ExactRational.zero(),
  allocations: 0n,
});
function totalsFact(id: string, totals: Totals, collection = TOTALS): NativeLedgerFact {
  return {
    collection,
    key: id,
    mutable: true,
    encoded: JSON.stringify({
      bookValue: totals.bookValue.toString(),
      quantity: totals.quantity.toString(),
      allocations: totals.allocations.toString(),
    }),
  };
}
export const initialOpenItemTotals = (id: string): NativeLedgerFact =>
  totalsFact(id, emptyTotals());

/** Both source families share one permanent owner index. Its full tuple and
 * canonical owner must match; hashing only keeps the SQL key bounded. */
export function financialSourceFact(
  effect: Extract<BookEffect, { type: "openItem" | "settlement" }>,
): NativeLedgerFact {
  const source =
    effect.type === "openItem" ? effect.value.recognitionSource : effect.value.settlementSource;
  requireLedger(source !== undefined, "native_ledger_required_fact_missing");
  const tuple = canonicalPostingSourceIdentity(source);
  return {
    collection: "financialSourceOwners",
    key: hashCanonical({ financialSource: tuple }).digest,
    encoded: JSON.stringify([tuple, effect.type, effect.value.id]),
  };
}
function readFinancialSource(view: NativeLedgerTransaction, source: CanonicalPostingReference) {
  const tuple = canonicalPostingSourceIdentity(source);
  const fact = view.facts([
    { collection: "financialSourceOwners", key: hashCanonical({ financialSource: tuple }).digest },
  ])[0];
  requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
  if (fact === null) return null;
  const value: unknown = JSON.parse(fact.encoded);
  requireLedger(
    fact.mutable !== true &&
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === tuple &&
      (value[1] === "openItem" || value[1] === "settlement") &&
      typeof value[2] === "string" &&
      JSON.stringify(value) === fact.encoded,
    "native_ledger_current_state_corrupt",
  );
  const owner = view.facts([
    { collection: value[1] === "openItem" ? "openItems" : "settlements", key: value[2] },
  ])[0];
  requireLedger(
    owner !== null && owner !== undefined && owner.mutable !== true,
    "native_ledger_required_fact_missing",
  );
  const decoded =
    value[1] === "openItem"
      ? decodeBookRow("state.accountingState.openItems", owner.encoded)
      : decodeBookRow("state.accountingState.settlements", owner.encoded);
  requireLedger(decoded.disposition === "decoded", "native_ledger_current_state_corrupt");
  const reference =
    "recognizedOn" in decoded.row ? decoded.row.recognitionSource : decoded.row.settlementSource;
  requireLedger(
    decoded.row.id === value[2] &&
      decoded.row.bookId === source.bookId &&
      reference !== undefined &&
      canonicalPostingSourceIdentity(reference) === tuple,
    "native_ledger_current_state_corrupt",
  );
  return { kind: value[1] as "openItem" | "settlement", value: decoded.row };
}

export function readFinancialSourceOwner(
  view: NativeLedgerTransaction,
  source: CanonicalPostingReference,
  expected?: { readonly type: "settlement"; readonly id: string },
): "present" | "absent" {
  const owner = readFinancialSource(view, source);
  if (owner === null) return "absent";
  requireLedger(
    expected === undefined || (owner.kind === expected.type && owner.value.id === expected.id),
    "native_ledger_current_state_corrupt",
  );
  return "present";
}

/** FX consumes the same authenticated payment/open-item totals as settlement. */
export function readAllocatedMonetarySource(
  view: NativeLedgerTransaction,
  source: CanonicalPostingReference,
) {
  const owner = readFinancialSource(view, source);
  if (owner === null) return emptyTotals();
  const fact = view.facts([
    { collection: owner.kind === "openItem" ? TOTALS : PAYMENT_TOTALS, key: owner.value.id },
  ])[0];
  requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
  return decodeTotals(fact, owner.value);
}

function decodeTotals(
  fact: NativeLedgerFact | null,
  item: Pick<OpenItem, "bookValue" | "denomination"> & { readonly id: string },
): Totals {
  requireLedger(fact?.mutable === true, "native_ledger_settlement_totals_incomplete");
  const value = JSON.parse(fact.encoded);
  const rational = (text: unknown): ExactRational => {
    requireLedger(
      typeof text === "string" &&
        text.length <= 2 * MAX_EXACT_INTEGER_BITS + 1 &&
        /^[0-9]+\/[1-9][0-9]*$/.test(text),
      "native_ledger_settlement_totals_incomplete",
    );
    const parts = text.split("/");
    requireLedger(
      parts[0] !== undefined && parts[1] !== undefined,
      "native_ledger_settlement_totals_incomplete",
    );
    const result = ExactRational.of(BigInt(parts[0]), BigInt(parts[1]));
    requireLedger(result.toString() === text, "native_ledger_settlement_totals_incomplete");
    return result;
  };
  requireLedger(
    value &&
      typeof value.allocations === "string" &&
      /^(0|[1-9][0-9]{0,23})$/.test(value.allocations),
    "native_ledger_settlement_totals_incomplete",
  );
  const totals = {
    bookValue: rational(value.bookValue),
    quantity: rational(value.quantity),
    allocations: BigInt(value.allocations),
  };
  requireLedger(
    totalsFact(item.id, totals).encoded === fact.encoded &&
      totals.bookValue.compare(item.bookValue.abs()) <= 0 &&
      totals.quantity.compare(item.denomination.abs()) <= 0 &&
      (totals.allocations === 0n
        ? totals.bookValue.isZero() && totals.quantity.isZero()
        : !totals.bookValue.isZero() && !totals.quantity.isZero()),
    "native_ledger_settlement_totals_incomplete",
  );
  return totals;
}

/** All reads are command-scoped and batched. A missing counter for an existing
 * open item is never interpreted as zero; older candidates require verified restaging. */
export function readNativeSettlement(
  view: NativeLedgerTransaction,
  command: BookCommand & ApplySettlementCommand,
  configuration: BookConfigurationSnapshot,
  readRemeasurements: (
    sources: readonly CanonicalPostingReference[],
  ) => BookSettlementContext["sourceRemeasurement"],
) {
  const openIds = [...new Set(command.request.allocations.map((item) => item.openItemId))];
  const keys = [
    { collection: "settlements", key: command.request.settlement.id },
    { collection: PAYMENT_TOTALS, key: command.request.settlement.id },
    ...openIds.flatMap((key) => [
      { collection: "openItems", key },
      { collection: TOTALS, key },
    ]),
    ...[...new Set(command.request.allocations.map((item) => item.id))].map((key) => ({
      collection: "settlementAllocations",
      key,
    })),
  ];
  const facts = new Map<string, NativeLedgerFact | null>();
  let bytes = 0;
  for (let start = 0; start < keys.length; start += 32) {
    const batch = keys.slice(start, start + 32);
    const observed = view.facts(batch);
    for (const [index, key] of batch.entries()) {
      const fact = observed[index];
      requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
      bytes += fact === null ? 0 : encoder.encode(fact.encoded).byteLength;
      requireLedger(bytes <= 4_194_304, "native_ledger_read_limit");
      facts.set(JSON.stringify([key.collection, key.key]), fact);
    }
  }
  const read = (collection: string, key: string) => {
    const fact = facts.get(JSON.stringify([collection, key]));
    requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
    return fact;
  };
  const items = new Map<string, OpenItem | null>();
  let payment: Settlement | null = null;
  let paymentTotals = emptyTotals();
  const paymentFact = read("settlements", command.request.settlement.id);
  if (paymentFact !== null) {
    const decoded = decodeBookRow("state.accountingState.settlements", paymentFact.encoded);
    requireLedger(
      decoded.disposition === "decoded" &&
        paymentFact.mutable !== true &&
        decoded.row.id === command.request.settlement.id &&
        decoded.row.bookId === command.bookId,
      "native_ledger_current_state_corrupt",
    );
    payment = decoded.row;
    if (command.request.operation === "allocateExisting") {
      paymentTotals = decodeTotals(read(PAYMENT_TOTALS, payment.id), payment);
      requireLedger(
        payment.settlementSource !== undefined &&
          readFinancialSourceOwner(view, payment.settlementSource, {
            type: "settlement",
            id: payment.id,
          }) === "present",
        "native_ledger_required_fact_missing",
      );
    }
  } else
    requireLedger(
      read(PAYMENT_TOTALS, command.request.settlement.id) === null,
      "native_ledger_settlement_totals_incomplete",
    );
  const totals = new Map<string, Totals>();
  for (const id of openIds) {
    const fact = read("openItems", id);
    if (fact === null) {
      requireLedger(read(TOTALS, id) === null, "native_ledger_settlement_totals_incomplete");
      items.set(id, null);
      totals.set(id, emptyTotals());
      continue;
    }
    const decoded = decodeBookRow("state.accountingState.openItems", fact.encoded);
    requireLedger(
      decoded.disposition === "decoded" &&
        fact.mutable !== true &&
        decoded.row.id === id &&
        decoded.row.bookId === command.bookId,
      "native_ledger_current_state_corrupt",
    );
    items.set(id, decoded.row);
    totals.set(id, decodeTotals(read(TOTALS, id), decoded.row));
  }
  const sourceReferences = [
    command.request.settlement.settlementSource,
    ...[...items.values()].map((item) => item?.recognitionSource),
  ].filter((source): source is CanonicalPostingReference => source !== undefined);
  let sources: ReturnType<typeof readNativeSourcePopulation> | undefined;
  let remeasurements: BookSettlementContext["sourceRemeasurement"] | undefined;
  const context: Pick<
    BookSettlementContext,
    "settlement" | "financialSourceOwner" | "sourceJournals" | "sourceRemeasurement"
  > = {
    settlement: {
      openItem: (id) => {
        const item = items.get(id);
        requireLedger(item !== undefined, "native_ledger_required_fact_missing");
        return item;
      },
      settlementIdentity: (id) => (read("settlements", id) === null ? "absent" : "present"),
      existingSettlement: (id) => {
        requireLedger(id === command.request.settlement.id, "native_ledger_required_fact_missing");
        return payment;
      },
      allocatedFromSettlement: (id) => {
        requireLedger(
          id === command.request.settlement.id && payment !== null,
          "native_ledger_required_fact_missing",
        );
        return paymentTotals;
      },
      allocationIdentity: (id) =>
        read("settlementAllocations", id) === null ? "absent" : "present",
      allocatedToOpenItem: (id) => {
        const total = totals.get(id);
        requireLedger(total !== undefined, "native_ledger_required_fact_missing");
        return total;
      },
    },
    sourceJournals: (source) => {
      sources ??= readNativeSourcePopulation(
        view,
        command.bookId,
        configuration.executionProfile,
        sourceReferences,
      );
      return sources(source);
    },
    financialSourceOwner: (source) => readFinancialSourceOwner(view, source),
    sourceRemeasurement: (source) => {
      remeasurements ??= readRemeasurements(sourceReferences);
      return remeasurements(source);
    },
  };
  return {
    context,
    project(effects: readonly BookEffect[]): readonly NativeLedgerFact[] {
      const changed = new Map<string, Totals>();
      const projected: NativeLedgerFact[] = [];
      let paymentChanged = effects.some((effect) => effect.type === "settlement");
      let nextPaymentTotals = paymentTotals;
      for (const effect of effects)
        if (effect.type === "settlementAllocation") {
          const value = effect.value;
          paymentChanged = true;
          nextPaymentTotals = {
            bookValue: nextPaymentTotals.bookValue.add(
              value.allocatedSettlementBookValue ?? value.allocatedBookValue,
            ),
            quantity: nextPaymentTotals.quantity.add(value.allocatedSettlementQuantity),
            allocations: nextPaymentTotals.allocations + 1n,
          };
          const prior = changed.get(value.openItemId) ?? totals.get(value.openItemId);
          requireLedger(
            prior !== undefined && items.get(value.openItemId) !== null,
            "native_ledger_required_fact_missing",
          );
          changed.set(value.openItemId, {
            bookValue: prior.bookValue.add(
              value.allocatedOpenItemBookValue ?? value.allocatedBookValue,
            ),
            quantity: prior.quantity.add(value.allocatedOpenQuantity),
            allocations: prior.allocations + 1n,
          });
          projected.push({
            collection: "settlementAllocations",
            key: value.id,
            encoded: encodeBookRow("state.accountingState.settlementAllocations", value),
          });
        }
      for (const [id, total] of changed) projected.push(totalsFact(id, total));
      if (paymentChanged)
        projected.push(
          totalsFact(command.request.settlement.id, nextPaymentTotals, PAYMENT_TOTALS),
        );
      return projected;
    },
  };
}

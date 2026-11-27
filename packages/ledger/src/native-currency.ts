import {
  canonicalPostingSourceIdentity,
  decodeBookRow,
  encodeBookRow,
  hashCanonical,
  requiresRemeasurementReversal,
  type BookCommand,
  type BookConfigurationSnapshot,
  type BookEffect,
  type CanonicalPostingReference,
  type CurrentBookContext,
  type PostCurrencyRemeasurementCommand,
  type RemeasurementResult,
} from "@rastrata/kernel";
import { readNativeSourceJournals } from "./native-allocation.ts";
import { readAllocatedMonetarySource } from "./native-settlement.ts";
import { requireLedger } from "./records.ts";
import type { NativeLedgerFact, NativeLedgerTransaction } from "./native-ledger-repository.ts";

const sourceKey = (source: CanonicalPostingReference) =>
  hashCanonical({ currencySource: canonicalPostingSourceIdentity(source) }).digest;

function fact(view: NativeLedgerTransaction, collection: string, key: string) {
  const observed = view.facts([{ collection, key }])[0];
  requireLedger(observed !== undefined, "native_ledger_required_fact_missing");
  return observed;
}

function result(view: NativeLedgerTransaction, id: string, bookId: string) {
  const stored = fact(view, "remeasurementResults", id);
  if (stored === null) return null;
  const decoded = decodeBookRow("state.accountingState.remeasurementResults", stored.encoded);
  requireLedger(
    decoded.disposition === "decoded" &&
      stored.mutable !== true &&
      decoded.row.id === id &&
      decoded.row.source?.bookId === bookId,
    "native_ledger_current_state_corrupt",
  );
  return decoded.row;
}

function reversal(view: NativeLedgerTransaction, original: RemeasurementResult) {
  const index = fact(view, "currencyReversalsByResult", original.id);
  if (index === null) return null;
  const id: unknown = JSON.parse(index.encoded);
  requireLedger(
    index.mutable !== true && typeof id === "string" && JSON.stringify(id) === index.encoded,
    "native_ledger_current_state_corrupt",
  );
  const stored = fact(view, "remeasurementReversals", id);
  requireLedger(stored !== null && stored.mutable !== true, "native_ledger_required_fact_missing");
  const decoded = decodeBookRow("state.accountingState.remeasurementReversals", stored.encoded);
  requireLedger(
    decoded.disposition === "decoded" &&
      decoded.row.id === id &&
      decoded.row.originalResultId === original.id,
    "native_ledger_current_state_corrupt",
  );
  return decoded.row;
}

function position(value: RemeasurementResult, active: boolean): NativeLedgerFact {
  requireLedger(
    value.source !== undefined && value.kind === "unrealized",
    "native_ledger_current_state_corrupt",
  );
  return {
    collection: "currencyPositions",
    key: value.id,
    mutable: true,
    encoded: JSON.stringify({
      active,
      policyId: value.policyId,
      effectiveOn: value.effectiveOn,
      sourceKey: sourceKey(value.source),
    }),
  };
}

/** A derived position never supplies accounting authority without its actual result. */
function activeResult(view: NativeLedgerTransaction, observed: NativeLedgerFact, bookId: string) {
  const original = result(view, observed.key, bookId);
  requireLedger(
    original !== null &&
      observed.collection === "currencyPositions" &&
      observed.mutable === true &&
      observed.encoded === position(original, true).encoded &&
      reversal(view, original) === null,
    "native_ledger_current_state_corrupt",
  );
  return original;
}

export function readActiveSourceRemeasurement(
  view: NativeLedgerTransaction,
  source: CanonicalPostingReference,
): "active" | "none" {
  return readActiveSourceRemeasurements(view, [source])(source);
}

export function readActiveSourceRemeasurements(
  view: NativeLedgerTransaction,
  sources: readonly CanonicalPostingReference[],
) {
  const keys = [...new Set(sources.map(sourceKey))];
  const observed = view.activeCurrencyPositions(keys);
  return (source: CanonicalPostingReference): "active" | "none" => {
    const key = sourceKey(source);
    requireLedger(keys.includes(key), "native_ledger_required_fact_missing");
    const found = observed.get(key);
    if (found === undefined) return "none";
    const original = activeResult(view, found, source.bookId);
    requireLedger(
      original.source !== undefined &&
        canonicalPostingSourceIdentity(original.source) === canonicalPostingSourceIdentity(source),
      "native_ledger_current_state_corrupt",
    );
    return "active";
  };
}

export function readOverdueCurrency(
  view: NativeLedgerTransaction,
  command: BookCommand,
  configuration: BookConfigurationSnapshot,
) {
  if (command.type === "postCurrencyRemeasurement" && command.request.reversalOf !== undefined)
    return null;
  const selected = new Map<
    string,
    Extract<
      (typeof configuration.accountingPolicySnapshot.policies)[number],
      { kind: "currencyRemeasurement" }
    >
  >();
  for (const policy of configuration.accountingPolicySnapshot.policies)
    if (policy.kind === "currencyRemeasurement" && !selected.has(policy.id))
      selected.set(policy.id, policy);
  const duePolicies = [...selected.values()]
    .filter((policy) => policy.reversalRequired)
    .map((policy) => policy.id);
  const observed = view.firstDueCurrencyPosition(duePolicies, command.issuedAt.slice(0, 10));
  if (observed === null) return null;
  const original = activeResult(view, observed, command.bookId);
  requireLedger(
    requiresRemeasurementReversal(command, original, selected.get(original.policyId)),
    "native_ledger_current_state_corrupt",
  );
  return original;
}

export function readNativeCurrency(
  view: NativeLedgerTransaction,
  command: BookCommand & PostCurrencyRemeasurementCommand,
  configuration: BookConfigurationSnapshot,
) {
  const original =
    command.request.reversalOf === undefined
      ? null
      : result(view, command.request.reversalOf, command.bookId);
  const reversed = original === null ? null : reversal(view, original);
  if (original === null && command.request.reversalOf !== undefined) {
    requireLedger(
      fact(view, "currencyPositions", command.request.reversalOf) === null &&
        fact(view, "currencyReversalsByResult", command.request.reversalOf) === null,
      "native_ledger_required_fact_missing",
    );
  }
  if (original?.kind === "unrealized" && reversed === null) {
    const observed = fact(view, "currencyPositions", original.id);
    requireLedger(observed !== null, "native_ledger_required_fact_missing");
    activeResult(view, observed, command.bookId);
  }
  const context: NonNullable<CurrentBookContext["currencyFacts"]> = {
    currencyState: {
      remeasurementResults: original === null ? [] : [original],
      remeasurementReversals: reversed === null ? [] : [reversed],
    },
    accountingIdentity: (effect) => {
      requireLedger(
        effect.type === "remeasurementResult" || effect.type === "remeasurementReversal",
        "native_ledger_profile_unsupported",
      );
      return fact(
        view,
        effect.type === "remeasurementResult" ? "remeasurementResults" : "remeasurementReversals",
        effect.value.id,
      ) === null
        ? "absent"
        : "present";
    },
    sourceJournals: (source) =>
      readNativeSourceJournals(view, command.bookId, configuration.executionProfile, source),
    allocatedSource: (source) => readAllocatedMonetarySource(view, source),
    sourceRemeasurement: (source) => readActiveSourceRemeasurement(view, source),
    originalJournal: (id) => {
      const stored = fact(view, "journals", id);
      requireLedger(
        stored !== null && stored.mutable !== true,
        "native_ledger_required_fact_missing",
      );
      const decoded = decodeBookRow("state.journals", stored.encoded);
      requireLedger(
        decoded.disposition === "decoded" &&
          decoded.row.journal.id === id &&
          decoded.row.journal.bookId === command.bookId &&
          decoded.row.bookRevision <= BigInt(view.head.bookRevision),
        "native_ledger_current_state_corrupt",
      );
      return decoded.row;
    },
  };
  return {
    context,
    project(effects: readonly BookEffect[]): readonly NativeLedgerFact[] {
      return effects.flatMap((effect): NativeLedgerFact[] => {
        if (effect.type === "remeasurementResult")
          return [
            {
              collection: "remeasurementResults",
              key: effect.value.id,
              encoded: encodeBookRow("state.accountingState.remeasurementResults", effect.value),
            },
            ...(effect.value.kind === "unrealized" ? [position(effect.value, true)] : []),
          ];
        if (effect.type === "remeasurementReversal") {
          requireLedger(
            original !== null && original.id === effect.value.originalResultId,
            "native_ledger_required_fact_missing",
          );
          return [
            {
              collection: "remeasurementReversals",
              key: effect.value.id,
              encoded: encodeBookRow("state.accountingState.remeasurementReversals", effect.value),
            },
            {
              collection: "currencyReversalsByResult",
              key: original.id,
              encoded: JSON.stringify(effect.value.id),
            },
            position(original, false),
          ];
        }
        return [];
      });
    },
  };
}

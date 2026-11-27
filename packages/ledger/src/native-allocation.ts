import {
  ACCOUNTING_LIMITS,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  decodeBookRow,
  encodeBookRow,
  resolveCanonicalPostingCandidates,
  type AllocationAccountingState,
  type BookAllocationCommand,
  type BookAllocationContext,
  type BookConfigurationSnapshot,
  type BookEffect,
  type BookId,
  type BookedJournal,
  type CanonicalPostingReference,
} from "@rastrata/kernel";
import { requireLedger } from "./records.ts";
import type { NativeLedgerFact, NativeLedgerTransaction } from "./native-ledger-repository.ts";

const HISTORY = "allocationHistory";
const ORDINALS = "allocationOrdinals";
const encoder = new TextEncoder();
const collections = {
  allocationSchedule: "allocationSchedules",
  allocationRecognition: "allocationRecognitions",
  allocationScheduleRevision: "allocationScheduleRevisions",
} as const;
type Lifecycle = { recognitions: number; revisionId: string | null };
const ordinalKey = (schedule: string, ordinal: bigint) =>
  JSON.stringify([schedule, ordinal.toString()]);

/** Bounded point reads preserve both structural identity and the frozen legacy
 * delimiter-alias winner. Enumerating split positions is bounded by the source
 * identifier, not the number of retained journals. */
export function readNativePostingSource(
  view: NativeLedgerTransaction,
  bookId: BookId,
  executionProfile: BookConfigurationSnapshot["executionProfile"],
  reference: CanonicalPostingReference,
) {
  return resolveCanonicalPostingCandidates(
    bookId,
    executionProfile,
    readNativeSourceJournals(view, bookId, executionProfile, reference),
    reference,
  );
}

export function readNativeSourceJournals(
  view: NativeLedgerTransaction,
  bookId: BookId,
  executionProfile: BookConfigurationSnapshot["executionProfile"],
  reference: CanonicalPostingReference,
): readonly BookedJournal[] {
  return readNativeSourcePopulation(view, bookId, executionProfile, [reference])(reference);
}

/** Batch the complete selected source population once per command, retaining the
 * configured legacy alias winners without one SQL statement per allocation. */
export function readNativeSourcePopulation(
  view: NativeLedgerTransaction,
  bookId: BookId,
  executionProfile: BookConfigurationSnapshot["executionProfile"],
  references: readonly CanonicalPostingReference[],
): (reference: CanonicalPostingReference) => readonly BookedJournal[] {
  const candidates = new Map<string, readonly string[]>();
  const allIds = new Set<string>();
  const sourceKey = (reference: CanonicalPostingReference) =>
    JSON.stringify([reference.journalId, reference.effectKey]);
  for (const reference of references) {
    const key = sourceKey(reference);
    if (candidates.has(key)) continue;
    const joined = `${reference.journalId}:${reference.effectKey}`;
    requireLedger(joined.length <= 4096, "native_ledger_invalid_input");
    const ids =
      executionProfile === STRUCTURAL_SOURCE_IDENTITY_PROFILE
        ? [reference.journalId as string]
        : [...joined.matchAll(/:/g)]
            .map((match) => joined.slice(0, match.index))
            .filter((id) => id.length > 0 && encoder.encode(id).byteLength <= 1024);
    candidates.set(key, ids);
    for (const id of ids) allIds.add(id);
    requireLedger(allIds.size <= 10_000, "native_ledger_read_limit");
  }
  const ids = [...allIds];
  const journals = new Map<string, BookedJournal>();
  let sourceBytes = 0;
  for (let start = 0; start < ids.length; start += 32) {
    const keys = ids.slice(start, start + 32);
    const facts = view.facts(keys.map((key) => ({ collection: "journals", key })));
    for (const [index, id] of keys.entries()) {
      const fact = facts[index];
      requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
      if (fact === null) continue;
      sourceBytes += encoder.encode(fact.encoded).byteLength;
      requireLedger(sourceBytes <= 1_048_576, "native_ledger_read_limit");
      const decoded = decodeBookRow("state.journals", fact.encoded);
      requireLedger(
        decoded.disposition === "decoded" &&
          fact.mutable !== true &&
          decoded.row.journal.id === id &&
          decoded.row.journal.bookId === bookId &&
          decoded.row.bookRevision <= BigInt(view.head.bookRevision),
        "native_ledger_current_state_corrupt",
      );
      journals.set(id, decoded.row);
    }
  }
  const populations = new Map<string, readonly BookedJournal[]>();
  return (reference) => {
    const key = sourceKey(reference);
    const cached = populations.get(key);
    if (cached !== undefined) return cached;
    const selected = candidates.get(key);
    requireLedger(selected !== undefined, "native_ledger_required_fact_missing");
    const population = selected
      .flatMap((id) => {
        const journal = journals.get(id);
        return journal === undefined ? [] : [journal];
      })
      .sort((left, right) =>
        left.postingSequence < right.postingSequence
          ? -1
          : left.postingSequence > right.postingSequence
            ? 1
            : 0,
      );
    populations.set(key, population);
    return population;
  };
}

/** Allocation-specific indexes are ordinary atomic fact projections. Recognition
 * reads one ordinal; revision verifies the bounded complete installment set.
 * There is no full-book history scan and no fabricated AccountingCanonicalState. */
export function readNativeAllocation(
  view: NativeLedgerTransaction,
  command: BookAllocationCommand,
  configuration: BookConfigurationSnapshot,
) {
  const cache = new Map<string, NativeLedgerFact | null>();
  let readBytes = 0;
  const cacheFact = (identity: string, fact: NativeLedgerFact | null) => {
    if (cache.has(identity)) return;
    readBytes += fact === null ? 0 : encoder.encode(fact.encoded).byteLength;
    requireLedger(readBytes <= 4_194_304, "native_ledger_read_limit");
    cache.set(identity, fact);
  };
  const read = (collection: string, key: string) => {
    const identity = JSON.stringify([collection, key]);
    if (!cache.has(identity)) {
      const fact = view.facts([{ collection, key }])[0];
      requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
      cacheFact(identity, fact);
    }
    const fact = cache.get(identity);
    requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
    return fact;
  };
  const scheduleId =
    command.type === "createAllocationSchedule"
      ? null
      : command.type === "recognizeScheduledAllocation"
        ? command.request.scheduleId
        : command.request.originalScheduleId;
  const schedules: AllocationAccountingState["allocationSchedules"][number][] = [];
  const recognitions: AllocationAccountingState["allocationRecognitions"][number][] = [];
  const revisions: AllocationAccountingState["allocationScheduleRevisions"][number][] = [];
  let lifecycle: Lifecycle | undefined;
  if (scheduleId !== null) {
    const fact = read("allocationSchedules", scheduleId);
    if (fact !== null) {
      const decoded = decodeBookRow("state.accountingState.allocationSchedules", fact.encoded);
      requireLedger(
        decoded.disposition === "decoded" &&
          fact.mutable !== true &&
          decoded.row.id === scheduleId &&
          decoded.row.bookId === command.bookId,
        "native_ledger_current_state_corrupt",
      );
      schedules.push(decoded.row);
      const history = read(HISTORY, scheduleId);
      requireLedger(history?.mutable === true, "native_ledger_allocation_history_incomplete");
      const value = JSON.parse(history.encoded);
      requireLedger(
        value &&
          Number.isSafeInteger(value.recognitions) &&
          value.recognitions >= 0 &&
          value.recognitions <= decoded.row.installments.length &&
          (value.revisionId === null ||
            (typeof value.revisionId === "string" && value.revisionId.length > 0)) &&
          JSON.stringify({ recognitions: value.recognitions, revisionId: value.revisionId }) ===
            history.encoded,
        "native_ledger_current_state_corrupt",
      );
      lifecycle = value as Lifecycle;
    } else {
      requireLedger(
        read(HISTORY, scheduleId) === null,
        "native_ledger_allocation_history_incomplete",
      );
    }
  }
  const readRecognition = (id: string, expectedOrdinal?: bigint) => {
    const fact = read("allocationRecognitions", id);
    if (fact === null) {
      requireLedger(expectedOrdinal === undefined, "native_ledger_allocation_history_incomplete");
      return;
    }
    const decoded = decodeBookRow("state.accountingState.allocationRecognitions", fact.encoded);
    requireLedger(
      decoded.disposition === "decoded" &&
        fact.mutable !== true &&
        decoded.row.id === id &&
        (expectedOrdinal === undefined ||
          (decoded.row.scheduleId === scheduleId && decoded.row.ordinal === expectedOrdinal)),
      "native_ledger_current_state_corrupt",
    );
    if (!recognitions.some((item) => item.id === id)) recognitions.push(decoded.row);
  };
  const readRevision = (id: string, required: boolean) => {
    const fact = read("allocationScheduleRevisions", id);
    if (fact === null) {
      requireLedger(!required, "native_ledger_allocation_history_incomplete");
      return;
    }
    const decoded = decodeBookRow(
      "state.accountingState.allocationScheduleRevisions",
      fact.encoded,
    );
    requireLedger(
      decoded.disposition === "decoded" &&
        fact.mutable !== true &&
        decoded.row.id === id &&
        (!required || decoded.row.originalScheduleId === scheduleId),
      "native_ledger_current_state_corrupt",
    );
    if (!revisions.some((item) => item.id === id)) revisions.push(decoded.row);
  };
  if (lifecycle?.revisionId != null) readRevision(lifecycle.revisionId, true);
  if (command.type === "recognizeScheduledAllocation") readRecognition(command.request.id);
  if (command.type === "reviseAllocationSchedule") readRevision(command.request.id, false);
  if (scheduleId !== null && schedules.length > 0) {
    const schedule = schedules[0];
    requireLedger(
      schedule !== undefined && lifecycle !== undefined,
      "native_ledger_allocation_history_incomplete",
    );
    const ordinals =
      command.type === "recognizeScheduledAllocation"
        ? [command.request.ordinal]
        : schedule.installments.map((item) => item.ordinal);
    requireLedger(
      ordinals.length <= ACCOUNTING_LIMITS.maxScheduleInstallments,
      "native_ledger_invalid_input",
    );
    let found = 0;
    const indexed: { id: string; ordinal: bigint }[] = [];
    for (let start = 0; start < ordinals.length; start += 32) {
      const selected = ordinals.slice(start, start + 32);
      const facts = view.facts(
        selected.map((ordinal) => ({ collection: ORDINALS, key: ordinalKey(scheduleId, ordinal) })),
      );
      for (const [index, fact] of facts.entries()) {
        if (fact === null) continue;
        const id = JSON.parse(fact.encoded);
        requireLedger(
          fact.mutable !== true &&
            typeof id === "string" &&
            id.length > 0 &&
            JSON.stringify(id) === fact.encoded,
          "native_ledger_current_state_corrupt",
        );
        const ordinal = selected[index];
        requireLedger(ordinal !== undefined, "native_ledger_allocation_history_incomplete");
        indexed.push({ id, ordinal });
        found++;
      }
    }
    requireLedger(
      command.type !== "reviseAllocationSchedule" || found === lifecycle.recognitions,
      "native_ledger_allocation_history_incomplete",
    );
    // Batch canonical record fetches too: even a maximum-size revision must not
    // turn into one SQL statement per recognition.
    for (let start = 0; start < indexed.length; start += 32) {
      const selected = indexed.slice(start, start + 32);
      const facts = view.facts(
        selected.map(({ id }) => ({ collection: "allocationRecognitions", key: id })),
      );
      for (const [index, item] of selected.entries()) {
        const fact = facts[index];
        requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
        cacheFact(JSON.stringify(["allocationRecognitions", item.id]), fact);
        readRecognition(item.id, item.ordinal);
      }
    }
  }
  const context: Pick<
    BookAllocationContext,
    "accountingState" | "accountingIdentity" | "resolveSource"
  > = {
    accountingState: {
      allocationSchedules: schedules,
      allocationRecognitions: recognitions,
      allocationScheduleRevisions: revisions,
    },
    accountingIdentity: (effect) => {
      requireLedger(effect.type in collections, "native_ledger_profile_unsupported");
      const present =
        read(collections[effect.type as keyof typeof collections], effect.value.id) !== null;
      if (effect.type === "allocationSchedule" && !present)
        requireLedger(
          read(HISTORY, effect.value.id) === null,
          "native_ledger_allocation_history_incomplete",
        );
      return present ? "present" : "absent";
    },
    resolveSource: (reference) =>
      readNativePostingSource(view, command.bookId, configuration.executionProfile, reference),
  };
  return {
    context,
    project(effects: readonly BookEffect[]): readonly NativeLedgerFact[] {
      const facts: NativeLedgerFact[] = [];
      for (const effect of effects) {
        if (effect.type === "allocationSchedule") {
          facts.push(
            {
              collection: "allocationSchedules",
              key: effect.value.id,
              encoded: encodeBookRow("state.accountingState.allocationSchedules", effect.value),
            },
            {
              collection: HISTORY,
              key: effect.value.id,
              encoded: JSON.stringify({ recognitions: 0, revisionId: null }),
              mutable: true,
            },
          );
        } else if (effect.type === "allocationRecognition") {
          requireLedger(
            lifecycle !== undefined && effect.value.scheduleId === scheduleId,
            "native_ledger_allocation_history_incomplete",
          );
          facts.push(
            {
              collection: "allocationRecognitions",
              key: effect.value.id,
              encoded: encodeBookRow("state.accountingState.allocationRecognitions", effect.value),
            },
            {
              collection: ORDINALS,
              key: ordinalKey(effect.value.scheduleId, effect.value.ordinal),
              encoded: JSON.stringify(effect.value.id),
            },
            {
              collection: HISTORY,
              key: effect.value.scheduleId,
              encoded: JSON.stringify({ ...lifecycle, recognitions: lifecycle.recognitions + 1 }),
              mutable: true,
            },
          );
        } else if (effect.type === "allocationScheduleRevision") {
          requireLedger(
            lifecycle !== undefined &&
              effect.value.originalScheduleId === scheduleId &&
              lifecycle.revisionId === null,
            "native_ledger_allocation_history_incomplete",
          );
          facts.push(
            {
              collection: "allocationScheduleRevisions",
              key: effect.value.id,
              encoded: encodeBookRow(
                "state.accountingState.allocationScheduleRevisions",
                effect.value,
              ),
            },
            {
              collection: HISTORY,
              key: effect.value.originalScheduleId,
              encoded: JSON.stringify({ ...lifecycle, revisionId: effect.value.id }),
              mutable: true,
            },
          );
        }
      }
      return facts;
    },
  };
}

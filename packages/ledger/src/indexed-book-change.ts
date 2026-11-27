import {
  commandInputHash,
  contentHashEquals,
  decodeBookRow,
  decodeBookStateHeader,
  encodeBookOutcome,
  encodeBookRow,
  immutableAccountingValue,
  prepareBookCommitRecords,
  type BookCommitIntent,
  type BookEffect,
  type BookOutcomePayload,
  type BookRowCollection,
  type BookRowTypes,
  type BookStateHeader,
  type RetainedCommandResult,
  type RevisionRecord,
} from "@rastrata/kernel";
import {
  decodeIndexedBookState,
  encodeIndexedBookState,
  indexedCollectionDomain,
  indexedRowCommitment,
  prepareIndexedBookState,
  type IndexedBookState,
} from "./indexed-book-state.ts";
import { lookupLogicalValue, prepareLogicalChange, type LogicalNodeReader } from "./logical-map.ts";
import { requireLedger } from "./records.ts";

/** Internal candidate bounds, not production book-capacity guarantees. Legacy
 * lotState replaces complete populations; an explicit sparse effect is still needed. */
export const INDEXED_CHANGE_LIMITS = Object.freeze({
  replacementRows: 10_000,
  changedRows: 30_000,
  nodeBytes: 16 * 1024 * 1024,
});
export interface IndexedChangeBudget {
  readonly replacementRows: number;
  readonly changedRows: number;
  readonly nodeBytes: number;
}
function captureBudget(input: IndexedChangeBudget): IndexedChangeBudget {
  requireLedger(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "indexed_change_budget_invalid",
  );
  const fields = Object.keys(INDEXED_CHANGE_LIMITS) as (keyof IndexedChangeBudget)[];
  requireLedger(Reflect.ownKeys(input).length === fields.length, "indexed_change_budget_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const copy = {} as Record<keyof IndexedChangeBudget, number>;
  for (const key of fields) {
    const field = descriptors[key];
    requireLedger(
      field &&
        "value" in field &&
        field.enumerable &&
        typeof field.value === "number" &&
        Number.isSafeInteger(field.value) &&
        field.value >= 0 &&
        field.value <= INDEXED_CHANGE_LIMITS[key],
      "indexed_change_budget_invalid",
    );
    copy[key] = field.value;
  }
  return Object.freeze(copy);
}
type Rows = {
  [C in BookRowCollection]: {
    readonly collection: C;
    readonly operation: "append" | "replace";
    readonly rows: readonly BookRowTypes[C][];
  };
}[BookRowCollection];
export type IndexedOutcomeInput =
  | {
      readonly kind: "commit";
      readonly intent: BookCommitIntent;
      readonly previousRevision: RevisionRecord | null;
    }
  | { readonly kind: "rejection"; readonly retained: RetainedCommandResult };
export interface IndexedRowWrite {
  readonly collection: BookRowCollection;
  readonly ordinal: string;
  readonly previous: string | null;
  readonly next: string | null;
  readonly encoded: string | null;
}

/** Exhaustive mapping of immutable effects, independent of physical indexes.
 * This is projection, not economic admission. Legacy lot replacement is explicit. */
function project(effect: BookEffect): readonly Rows[] {
  switch (effect.type) {
    case "lotChanges":
      throw new TypeError("Legacy ordinal-index projection does not support lot changes");
    case "inventoryOwnership":
      // The complete ownership effect is committed once inside its revision row.
      // Current quantities still map through the companion exact lotState effect.
      return [];
    case "activation":
      return [
        { collection: "state.openingBoundary", operation: "replace", rows: [effect.boundary] },
      ];
    case "configuration":
      return [
        {
          collection: "state.configurationSnapshots",
          operation: "append",
          rows: [effect.resultingConfigurationSnapshot],
        },
      ];
    case "journal":
      return [{ collection: "state.journals", operation: "append", rows: [effect.booked] }];
    case "lotState":
      return [
        { collection: "state.lots", operation: "replace", rows: effect.lotState.lots },
        { collection: "state.lotHoldings", operation: "replace", rows: effect.lotState.holdings },
        {
          collection: "state.lotAllocations",
          operation: "replace",
          rows: effect.lotState.allocations,
        },
      ];
    case "correction":
      return [{ collection: "state.corrections", operation: "append", rows: [effect.link] }];
    case "periodTransition":
      return [
        { collection: "state.periodTransitions", operation: "append", rows: [effect.transition] },
      ];
    case "closePackage":
      return [
        { collection: "state.closePackages", operation: "append", rows: [effect.closePackage] },
      ];
    case "provisionalInventoryLayer":
      return [
        {
          collection: "state.accountingState.provisionalInventoryLayers",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "inventoryRecosting":
      return [
        {
          collection: "state.accountingState.inventoryRecostings",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "inventoryValueAdjustment":
      return [
        {
          collection: "state.accountingState.inventoryValueAdjustments",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "openItem":
      return [
        {
          collection: "state.accountingState.openItems",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "settlement":
      return [
        {
          collection: "state.accountingState.settlements",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "settlementAllocation":
      return [
        {
          collection: "state.accountingState.settlementAllocations",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "remeasurementResult":
      return [
        {
          collection: "state.accountingState.remeasurementResults",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "remeasurementReversal":
      return [
        {
          collection: "state.accountingState.remeasurementReversals",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "allocationSchedule":
      return [
        {
          collection: "state.accountingState.allocationSchedules",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "allocationRecognition":
      return [
        {
          collection: "state.accountingState.allocationRecognitions",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "allocationScheduleRevision":
      return [
        {
          collection: "state.accountingState.allocationScheduleRevisions",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "taxDetermination":
      return [
        {
          collection: "state.accountingState.taxDeterminations",
          operation: "append",
          rows: [effect.value],
        },
      ];
    case "consolidationCompilation":
      return [
        {
          collection: "state.accountingState.consolidationCompilations",
          operation: "append",
          rows: [effect.value],
        },
      ];
    default: {
      const unknown: never = effect;
      throw new TypeError(`Unknown indexed effect: ${String(unknown)}`);
    }
  }
}

/** Compile ONE separately admitted new retained outcome into immutable candidate
 * row/node writes and a complete new state catalog. NO writes or publication occur.
 * Caller must authenticate the prior full head, complete read set and decision,
 * check permanent identities, then atomically publish ALL projections/records with
 * full-head/fence CAS and durable acknowledgement. This is not indexed evaluation,
 * a public commit API, retry admission, semantic closure or recovery verification.
 * Unchanged roots are explicitly preserved; missing paths throw, never mean empty.
 * Rejection diagnostics/result hash are already evaluated inputs, not recomputed
 * economic decisions. The legacy evaluator remains the independent test oracle. */
export async function prepareIndexedBookOutcome(
  inputState: IndexedBookState,
  supplied: IndexedOutcomeInput,
  readNode: LogicalNodeReader,
  budget: IndexedChangeBudget = INDEXED_CHANGE_LIMITS,
) {
  // An owner may narrow preparation budgets, never raise the hard profile caps.
  // This is an operational work bound, not an accounting-admission option.
  const limits = captureBudget(budget);
  const before = decodeIndexedBookState(encodeIndexedBookState(inputState));
  const decoded = decodeBookStateHeader(before.header);
  requireLedger(decoded.disposition === "decoded", "indexed_change_header_invalid");
  const initial = decoded.header;
  let nextHeader: BookStateHeader = initial;
  let payload: BookOutcomePayload;
  let retained: RetainedCommandResult;
  const changes: Rows[] = [];
  let previousRow: string | null = null;
  // Capture all caller-owned values before the first asynchronous source read.
  if (supplied.kind === "commit") {
    const records = prepareBookCommitRecords(
      {
        bookId: initial.identity.bookId,
        bookRevision: initial.bookRevision,
        previousRevision: supplied.previousRevision,
      },
      supplied.intent,
    );
    requireLedger(
      supplied.intent.expectedConfigurationRevision === initial.configurationRevision &&
        supplied.intent.command.expectedBookRevision === initial.bookRevision,
      "indexed_change_context_mismatch",
    );
    previousRow =
      supplied.previousRevision === null
        ? null
        : encodeBookRow("state.revisions", supplied.previousRevision);
    nextHeader = {
      ...initial,
      bookRevision: supplied.intent.nextBookRevision,
      latestPostingSequence: supplied.intent.resultingPostingSequence,
    };
    for (const effect of records.revision.effects) {
      changes.push(...project(effect));
      if (effect.type === "activation") nextHeader = { ...nextHeader, status: "open" };
      if (effect.type === "configuration")
        nextHeader = {
          ...nextHeader,
          configurationRevision: effect.nextConfigurationRevision,
          configurationHash: effect.contentHash,
        };
    }
    requireLedger(
      supplied.intent.nextConfigurationRevision === nextHeader.configurationRevision &&
        contentHashEquals(supplied.intent.resultingConfigurationHash, nextHeader.configurationHash),
      "indexed_change_context_mismatch",
    );
    retained = records.retained;
    changes.push({ collection: "state.revisions", operation: "append", rows: [records.revision] });
    payload = {
      command: retained.command,
      originalResult: { ...records.result, disposition: "committed" },
      revision: records.revision,
    };
  } else {
    requireLedger(supplied.kind === "rejection", "indexed_change_kind_invalid");
    const row = decodeBookRow(
      "protocol.retainedResults",
      encodeBookRow("protocol.retainedResults", supplied.retained),
    );
    requireLedger(row.disposition === "decoded", "indexed_change_rejection_invalid");
    retained = row.row;
    requireLedger(
      retained.outcome === "rejected" &&
        !Object.hasOwn(retained, "commitIntentHash") &&
        retained.observedBookRevision === initial.bookRevision &&
        retained.command.bookId === initial.identity.bookId &&
        retained.commandId === retained.command.id &&
        retained.completedAt === retained.command.completedAt &&
        contentHashEquals(retained.inputHash, retained.command.inputHash) &&
        contentHashEquals(commandInputHash(retained.command), retained.inputHash),
      "indexed_change_rejection_invalid",
    );
    payload = {
      command: retained.command,
      originalResult: {
        disposition: "rejected",
        observedBookRevision: retained.observedBookRevision,
        resultHash: retained.resultHash,
        completedAt: retained.completedAt,
        diagnostics: retained.diagnostics,
      },
      revision: null,
    };
  }
  const encodedOutcome = encodeBookOutcome(payload);
  changes.push({ collection: "protocol.retainedResults", operation: "append", rows: [retained] });
  const encodedChanges = changes.map((change) => ({
    collection: change.collection,
    operation: change.operation,
    rows: change.rows.map((row) => encodeBookRow(change.collection, row)),
  }));
  nextHeader = immutableAccountingValue(nextHeader);
  const catalogs = new Map(before.collections.map((c) => [c.collection, { ...c }]));
  const nodes = new Map<string, string>();
  const cache = new Map<string, string | undefined>();
  const writes: IndexedRowWrite[] = [];
  let nodeBytes = 0;
  let sourceReads = 0;
  const read: LogicalNodeReader = async (digest) => {
    const created = nodes.get(digest);
    if (created !== undefined) return created;
    if (!cache.has(digest)) {
      sourceReads++;
      cache.set(digest, await readNode(digest));
    }
    return cache.get(digest);
  };
  if (previousRow !== null) {
    const revisions = catalogs.get("state.revisions");
    requireLedger(revisions !== undefined, "indexed_change_catalog_incomplete");
    const domain = indexedCollectionDomain(initial.financialIdentityHash, "state.revisions");
    const found = await lookupLogicalValue(
      revisions.encodedRoot,
      revisions.rootHash,
      domain,
      initial.bookRevision.toString(16).padStart(64, "0"),
      read,
    );
    requireLedger(
      found.value ===
        indexedRowCommitment(
          initial.financialIdentityHash,
          "state.revisions",
          initial.bookRevision,
          previousRow,
        ),
      "indexed_change_predecessor_mismatch",
    );
  }
  for (const change of encodedChanges) {
    const catalog = catalogs.get(change.collection);
    requireLedger(catalog !== undefined, "indexed_change_catalog_incomplete");
    const domain = indexedCollectionDomain(initial.financialIdentityHash, change.collection);
    const count = BigInt(catalog.population);
    if (change.operation === "replace")
      requireLedger(
        count <= BigInt(limits.replacementRows) && change.rows.length <= limits.replacementRows,
        "indexed_change_replacement_limit",
      );
    const total =
      change.operation === "replace"
        ? Math.max(Number(count), change.rows.length)
        : change.rows.length;
    for (let index = 0; index < total; index++) {
      const ordinal = (change.operation === "replace" ? 0n : count) + BigInt(index) + 1n;
      const key = ordinal.toString(16).padStart(64, "0");
      const encoded = change.rows[index] ?? null;
      const next =
        encoded === null
          ? null
          : indexedRowCommitment(
              initial.financialIdentityHash,
              change.collection,
              ordinal,
              encoded,
            );
      const previous =
        change.operation === "replace" && ordinal <= count
          ? (await lookupLogicalValue(catalog.encodedRoot, catalog.rootHash, domain, key, read))
              .value
          : null;
      requireLedger(
        change.operation !== "replace" || ordinal > count || previous !== null,
        "indexed_change_row_missing",
      );
      if (previous === next) continue;
      const prepared = await prepareLogicalChange(
        catalog.encodedRoot,
        catalog.rootHash,
        domain,
        key,
        previous,
        next,
        read,
      );
      for (const node of prepared.nodes) {
        if (!nodes.has(node.digest)) nodeBytes += node.encoded.length; // node wire is ASCII
        requireLedger(nodeBytes <= limits.nodeBytes, "indexed_change_node_limit");
        nodes.set(node.digest, node.encoded);
      }
      catalog.encodedRoot = prepared.encodedRoot;
      catalog.rootHash = prepared.rootHash;
      writes.push(
        Object.freeze({
          collection: change.collection,
          ordinal: ordinal.toString(),
          previous,
          next,
          encoded,
        }),
      );
      requireLedger(writes.length <= limits.changedRows, "indexed_change_row_limit");
    }
    catalog.population = (
      change.operation === "replace"
        ? BigInt(change.rows.length)
        : count + BigInt(change.rows.length)
    ).toString();
  }
  const after = prepareIndexedBookState(
    nextHeader,
    [...catalogs.values()].map(({ collection, encodedRoot }) => ({ collection, encodedRoot })),
  );
  // Keep only newly created nodes reachable from the final roots. Traversal stops
  // at unchanged old nodes; this does not scan historical trees or reclaim anything.
  const reachable = new Map<string, string>();
  const pending: string[] = after.collections.flatMap((c) => {
    const tree = JSON.parse(c.encodedRoot).tree;
    return tree === null ? [] : [tree.digest];
  });
  while (pending.length > 0) {
    const digest = pending.pop();
    if (digest === undefined || reachable.has(digest)) continue;
    const encoded = nodes.get(digest);
    if (encoded === undefined) continue;
    reachable.set(digest, encoded);
    const node = JSON.parse(encoded);
    if (node.kind === "branch") pending.push(node.left.digest, node.right.digest);
  }
  return Object.freeze({
    beforeStateContentHash: before.contentHash,
    state: after,
    encodedOutcome,
    rows: Object.freeze(writes),
    nodes: Object.freeze(
      [...reachable].map(([digest, encoded]) => Object.freeze({ digest, encoded })),
    ),
    metrics: Object.freeze({
      sourceReads,
      nodeBytes,
      retainedNodeBytes: [...reachable.values()].reduce((sum, encoded) => sum + encoded.length, 0),
      changedRows: writes.length,
    }),
  });
}

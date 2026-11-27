import {
  commandInputHash,
  contentHashEquals,
  decodeBookOutcome,
  encodeBookOutcome,
  hashCommitIntent,
  hashCanonical,
  type AccountingEffect,
  type AccountingCanonicalState,
  type BookEffect,
  type ContentHash,
  type BookOutcomePayload,
  decodeBookStateHeader,
  type BookRowCollection,
} from "@rastrata/kernel";
import { COMPACT_FORMAT_IDENTITY } from "./compact-records.ts";
import {
  LEDGER_LIMITS,
  requireLedger,
  verifiedOutcomeRecordHash,
  type OutcomeRecord,
  type LedgerHead,
  type CompleteBookScope,
} from "./records.ts";
import { decodeIndexedOutcomeRecord } from "./indexed-outcome-record.ts";
import {
  indexedRowCommitment,
  type IndexedBookState,
  type IndexedBookHead,
} from "./indexed-book-state.ts";

/** Bounded legacy row recovery from one already authenticated compact source.
 * The expected record commitment must come from verified book authority, never
 * from the source itself. This does not verify accounting/replay, current view,
 * source-index membership, or a row's global ordinal when the source omits it. */
export const OUTCOME_SOURCE_PROJECTION = "rastrata-outcome-source-candidate-v1";
export const INDEXED_OUTCOME_SOURCE_PROJECTION = "rastrata-indexed-outcome-source-v1";
export const ACCOUNTING_SOURCE_COLLECTIONS = Object.freeze({
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
} satisfies Record<AccountingEffect["type"], keyof AccountingCanonicalState>);
const EFFECT_FIELDS = Object.freeze({
  inventoryOwnership: "value",
  activation: "boundary",
  configuration: "resultingConfigurationSnapshot",
  journal: "booked",
  lotState: "lotState",
  lotChanges: "changes",
  correction: "link",
  periodTransition: "transition",
  closePackage: "closePackage",
  provisionalInventoryLayer: "value",
  inventoryRecosting: "value",
  inventoryValueAdjustment: "value",
  openItem: "value",
  settlement: "value",
  settlementAllocation: "value",
  remeasurementResult: "value",
  remeasurementReversal: "value",
  allocationSchedule: "value",
  allocationRecognition: "value",
  allocationScheduleRevision: "value",
  taxDetermination: "value",
  consolidationCompilation: "value",
} satisfies Record<BookEffect["type"], string>);

export type OutcomeSourceSelector =
  | { readonly kind: "retained" | "revision" }
  | { readonly kind: "effect"; readonly effectIndex: number }
  | {
      readonly kind: "lotState";
      readonly effectIndex: number;
      readonly member: "lots" | "holdings" | "allocations";
      readonly memberIndex: number;
    };
export interface OutcomeSourceRow {
  readonly selector: OutcomeSourceSelector;
  /** Null means prior authenticated collection population is required. */
  readonly ordinal: bigint | null;
  readonly encoded: string;
}
export interface OutcomeSourceGroup {
  readonly collection: string;
  readonly mode: "append" | "replace";
  /** Empty replacement groups are significant; do not omit them. */
  readonly rows: readonly OutcomeSourceRow[];
}

export interface OutcomeRowLocator {
  readonly collection: string;
  readonly selector: OutcomeSourceSelector;
  readonly ordinal: bigint;
}

function selectorKey(selector: OutcomeSourceSelector): string {
  const keys = Object.keys(selector).sort().join(",");
  if (selector.kind === "retained" || selector.kind === "revision") {
    requireLedger(keys === "kind", "outcome_source_selector_invalid");
    return selector.kind;
  }
  requireLedger(
    "effectIndex" in selector &&
      Number.isSafeInteger(selector.effectIndex) &&
      selector.effectIndex >= 0 &&
      selector.effectIndex < 10_000,
    "outcome_source_selector_invalid",
  );
  if (selector.kind === "effect") {
    requireLedger(keys === "effectIndex,kind", "outcome_source_selector_invalid");
    return `effect:${selector.effectIndex}`;
  }
  requireLedger(
    selector.kind === "lotState" &&
      keys === "effectIndex,kind,member,memberIndex" &&
      ["lots", "holdings", "allocations"].includes(selector.member) &&
      Number.isSafeInteger(selector.memberIndex) &&
      selector.memberIndex >= 0 &&
      selector.memberIndex < 10_000,
    "outcome_source_selector_invalid",
  );
  return `lotState:${selector.effectIndex}:${selector.member}:${selector.memberIndex}`;
}

/** Both commitments and the collection domain/ordinal must be obtained from an
 * authenticated pinned view. Matching caller-invented hashes confers no authority.
 * The row commitment is the exact legacy logical-book projection preimage. */
export function resolveOutcomeSourceRow(
  record: OutcomeRecord,
  expectedRecordHash: string,
  locator: OutcomeRowLocator,
  domain: string,
  expectedRowHash: string,
): string {
  requireLedger(
    typeof locator.ordinal === "bigint" &&
      locator.ordinal > 0n &&
      locator.ordinal < 1n << 256n &&
      /^[0-9a-f]{64}$/.test(domain) &&
      /^[0-9a-f]{64}$/.test(expectedRowHash),
    "outcome_source_locator_invalid",
  );
  const selected = selectorKey(locator.selector);
  const source = projectOutcomeSource(record, expectedRecordHash);
  const matches = source.groups
    .filter((g) => g.collection === locator.collection)
    .flatMap((g) => g.rows)
    .filter((r) => selectorKey(r.selector) === selected);
  const row = matches[0];
  requireLedger(matches.length === 1 && row !== undefined, "outcome_source_row_missing");
  requireLedger(
    (row.ordinal === null || row.ordinal === locator.ordinal) &&
      hashCanonical({ domain, ordinal: locator.ordinal, encoded: row.encoded }).digest ===
        expectedRowHash,
    "outcome_source_row_mismatch",
  );
  return row.encoded;
}

// These operate only on canonical, schema-checked codec nodes below. Money and
// domain objects are copied as original tagged subtrees, never re-encoded here.
function fields(node: unknown): Map<string, unknown> {
  requireLedger(Array.isArray(node) && node[0] === "o", "outcome_source_wire_invalid");
  return new Map(node[1]);
}
function elements(node: unknown): readonly unknown[] {
  requireLedger(Array.isArray(node) && node[0] === "a", "outcome_source_wire_invalid");
  return node[1];
}
function object(fields: Record<string, unknown>): unknown {
  return [
    "o",
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  ];
}
function hashNode(hash: ContentHash): unknown {
  return object(
    Object.fromEntries(Object.entries(hash).map(([key, value]) => [key, ["s", value]])),
  );
}
function counter(
  head: LedgerHead,
  field: "sequence" | "bookRevision" | "postingSequence" | "configurationRevision",
) {
  const value = head[field];
  requireLedger(
    typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value),
    "outcome_source_context_invalid",
  );
  return BigInt(value);
}

export function projectOutcomeSource(record: OutcomeRecord, expectedRecordHash: string) {
  requireLedger(
    typeof record.body === "string" &&
      new TextEncoder().encode(record.body).length <= LEDGER_LIMITS.recordBytes &&
      /^[0-9a-f]{64}$/.test(expectedRecordHash) &&
      verifiedOutcomeRecordHash(record) === expectedRecordHash,
    "outcome_source_commitment_mismatch",
  );
  requireLedger(
    record.frame !== undefined &&
      JSON.stringify(record.frame.format) === JSON.stringify(COMPACT_FORMAT_IDENTITY),
    "outcome_source_profile_invalid",
  );
  const decoded = decodeBookOutcome(record.body);
  requireLedger(decoded.disposition === "decoded", "outcome_source_payload_invalid");
  const payload = decoded.payload;
  requireLedger(
    encodeBookOutcome(payload) === record.body &&
      contentHashEquals(commandInputHash(payload.command), payload.command.inputHash),
    "outcome_source_payload_invalid",
  );
  const sequence = counter(record.after, "sequence");
  const beforeRevision = counter(record.before, "bookRevision");
  const afterRevision = counter(record.after, "bookRevision");
  requireLedger(
    sequence === counter(record.before, "sequence") + 1n &&
      record.commandId === payload.command.id &&
      record.frame.identity.bookId === payload.command.bookId &&
      payload.originalResult.observedBookRevision === afterRevision,
    "outcome_source_context_invalid",
  );
  let intentHash: ContentHash | undefined;
  if (payload.revision !== null) {
    requireLedger(
      afterRevision === beforeRevision + 1n &&
        payload.revision.bookRevision === afterRevision &&
        payload.command.expectedBookRevision === beforeRevision &&
        record.after.revisionHash === payload.revision.chainHash.digest &&
        record.revision === afterRevision.toString() &&
        typeof record.after.configurationHash === "string" &&
        /^[0-9a-f]{64}$/.test(record.after.configurationHash),
      "outcome_source_context_invalid",
    );
    intentHash = hashCommitIntent(
      payload.command,
      beforeRevision,
      afterRevision,
      counter(record.after, "postingSequence"),
      counter(record.before, "configurationRevision"),
      counter(record.after, "configurationRevision"),
      {
        algorithm: "sha256",
        canonicalizationVersion: COMPACT_FORMAT_IDENTITY.canonicalizationVersion,
        digest: record.after.configurationHash,
      },
      payload.revision.effects,
    );
  } else {
    requireLedger(
      afterRevision === beforeRevision &&
        record.revision === null &&
        [
          "stateHash",
          "postingSequence",
          "configurationRevision",
          "configurationHash",
          "revisionHash",
        ].every(
          (field) =>
            record.before[field as keyof LedgerHead] === record.after[field as keyof LedgerHead],
        ),
      "outcome_source_context_invalid",
    );
  }
  return Object.freeze({
    profile: OUTCOME_SOURCE_PROJECTION,
    recordHash: expectedRecordHash,
    sequence,
    groups: projectPayloadRows(record.body, payload, sequence, intentHash),
  });
}

/** Single-outcome row extraction shared by separately validated record formats.
 * Private: framing/context checks must precede this exact tagged-wire mapping. */
function projectPayloadRows(
  encoded: string,
  payload: BookOutcomePayload,
  sequence: bigint,
  intentHash: ContentHash | undefined,
): readonly OutcomeSourceGroup[] {
  const wire = fields(JSON.parse(encoded).body);
  const command = fields(wire.get("command"));
  const result = fields(wire.get("originalResult"));
  const retained: Record<string, unknown> = {
    command: wire.get("command"),
    commandId: command.get("id"),
    inputHash: command.get("inputHash"),
    outcome: result.get("disposition"),
    observedBookRevision: result.get("observedBookRevision"),
    resultHash: result.get("resultHash"),
    completedAt: result.get("completedAt"),
    diagnostics: result.get("diagnostics"),
  };
  const groups: OutcomeSourceGroup[] = [];
  function row(
    selector: OutcomeSourceSelector,
    ordinal: bigint | null,
    value: unknown,
  ): OutcomeSourceRow {
    return Object.freeze({
      selector: Object.freeze(selector),
      ordinal,
      encoded: JSON.stringify(value),
    });
  }
  function group(collection: string, mode: "append" | "replace", rows: OutcomeSourceRow[]) {
    groups.push(Object.freeze({ collection, mode, rows: Object.freeze(rows) }));
  }
  if (payload.revision !== null) {
    requireLedger(intentHash, "outcome_source_context_invalid");
    retained.commitIntentHash = hashNode(intentHash);
    group("state.revisions", "append", [
      row({ kind: "revision" }, payload.revision.bookRevision, wire.get("revision")),
    ]);
    const effects = elements(fields(wire.get("revision")).get("effects"));
    for (const [effectIndex, effect] of payload.revision.effects.entries()) {
      const value = fields(effects[effectIndex]).get(EFFECT_FIELDS[effect.type]);
      const selector = { kind: "effect", effectIndex } as const;
      switch (effect.type) {
        case "activation":
          group("state.openingBoundary", "replace", [row(selector, 1n, value)]);
          break;
        case "configuration":
          group("state.configurationSnapshots", "append", [
            row(selector, effect.nextConfigurationRevision + 1n, value),
          ]);
          break;
        case "journal":
          group("state.journals", "append", [row(selector, effect.booked.postingSequence, value)]);
          break;
        case "correction":
          group("state.corrections", "append", [row(selector, null, value)]);
          break;
        case "periodTransition":
          group("state.periodTransitions", "append", [row(selector, null, value)]);
          break;
        case "closePackage":
          group("state.closePackages", "append", [row(selector, null, value)]);
          break;
        case "lotChanges":
          throw new TypeError("Legacy ordinal-index sources do not support lot changes");
        case "lotState": {
          const lotState = fields(value);
          for (const [member, collection] of [
            ["lots", "lots"],
            ["holdings", "lotHoldings"],
            ["allocations", "lotAllocations"],
          ] as const) {
            group(
              `state.${collection}`,
              "replace",
              elements(lotState.get(member)).map((node, memberIndex) =>
                row(
                  { kind: "lotState", effectIndex, member, memberIndex },
                  BigInt(memberIndex) + 1n,
                  node,
                ),
              ),
            );
          }
          break;
        }
        case "inventoryOwnership":
          // Already present, with its exact original bytes, in the revision group.
          // No independent mutable ownership collection is manufactured here.
          break;
        default:
          group(`state.accountingState.${ACCOUNTING_SOURCE_COLLECTIONS[effect.type]}`, "append", [
            row(selector, null, value),
          ]);
      }
    }
  }
  group("protocol.retainedResults", "append", [
    row({ kind: "retained" }, sequence, object(retained)),
  ]);
  return Object.freeze(groups);
}

/** Extract exact source rows from one indexed outcome under independently verified
 * expected authority. No legacy aggregate/compact head is synthesized. Does not
 * establish canonical membership, complete effect projection or accounting truth;
 * the owner must verify those before using these rows as admission evidence. */
export function projectIndexedOutcomeSource(
  encoded: string,
  expectedRecordHash: string,
  scope: CompleteBookScope,
  actualObjectId: string,
  beforeState: IndexedBookState,
  beforeHead: IndexedBookHead,
) {
  const record = decodeIndexedOutcomeRecord(
    encoded,
    scope,
    actualObjectId,
    beforeState,
    beforeHead,
  );
  requireLedger(
    /^[0-9a-f]{64}$/.test(expectedRecordHash) && record.contentHash === expectedRecordHash,
    "outcome_source_commitment_mismatch",
  );
  const decoded = decodeBookOutcome(record.payload);
  requireLedger(decoded.disposition === "decoded", "outcome_source_payload_invalid");
  const { command, revision } = decoded.payload;
  const intentHash =
    revision === null
      ? undefined
      : hashCommitIntent(
          command,
          BigInt(record.before.bookRevision),
          BigInt(record.after.bookRevision),
          BigInt(record.after.postingSequence),
          BigInt(record.before.configurationRevision),
          BigInt(record.after.configurationRevision),
          record.after.configurationHash,
          revision.effects,
        );
  const sequence = BigInt(record.after.sequence);
  return Object.freeze({
    profile: INDEXED_OUTCOME_SOURCE_PROJECTION,
    recordHash: expectedRecordHash,
    sequence,
    groups: projectPayloadRows(record.payload, decoded.payload, sequence, intentHash),
  });
}

export interface IndexedOutcomeSourceAuthority {
  readonly recordHash: string;
  readonly scope: CompleteBookScope;
  readonly actualObjectId: string;
  readonly beforeState: IndexedBookState;
  readonly beforeHead: IndexedBookHead;
}

/** Resolve a row selector against exact canonical outcome bytes and the indexed
 * row commitment supplied by the owner's authenticated current view. This checks
 * source content, not the locator's membership in that view or historical replay.
 * The source's prior state/head must also come from verified canonical authority. */
export function resolveIndexedOutcomeSourceRow(
  encoded: string,
  authority: IndexedOutcomeSourceAuthority,
  locator: OutcomeRowLocator,
  expectedRowHash: string,
): string {
  requireLedger(
    typeof locator.ordinal === "bigint" &&
      locator.ordinal > 0n &&
      locator.ordinal <= (1n << 64n) - 1n &&
      /^[0-9a-f]{64}$/.test(expectedRowHash),
    "outcome_source_locator_invalid",
  );
  const selected = selectorKey(locator.selector);
  const source = projectIndexedOutcomeSource(
    encoded,
    authority.recordHash,
    authority.scope,
    authority.actualObjectId,
    authority.beforeState,
    authority.beforeHead,
  );
  const matches = source.groups
    .filter((group) => group.collection === locator.collection)
    .flatMap((group) => group.rows)
    .filter((row) => selectorKey(row.selector) === selected);
  const row = matches[0];
  requireLedger(matches.length === 1 && row, "outcome_source_row_missing");
  const header = decodeBookStateHeader(authority.beforeState.header);
  requireLedger(header.disposition === "decoded", "outcome_source_context_invalid");
  requireLedger(
    (row.ordinal === null || row.ordinal === locator.ordinal) &&
      indexedRowCommitment(
        header.header.financialIdentityHash,
        locator.collection as BookRowCollection,
        locator.ordinal,
        row.encoded,
      ) === expectedRowHash,
    "outcome_source_row_mismatch",
  );
  return row.encoded;
}

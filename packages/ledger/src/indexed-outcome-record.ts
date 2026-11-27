import {
  canonicalAccountingValue,
  commandInputHash,
  contentHashEquals,
  decodeBookOutcome,
  decodeBookStateHeader,
  encodeBookOutcome,
  hashBookCommandResult,
  hashCanonical,
  hashCommitIntent,
  prepareBookCommitRecords,
  type BookCommitIntent,
  type BookOutcomePayload,
  type BookStateHeader,
  type ContentHash,
  type RevisionRecord,
} from "@rastrata/kernel";
import {
  decodeIndexedBookHead,
  decodeIndexedBookState,
  encodeIndexedBookState,
  prepareIndexedBookHead,
  type IndexedBookHead,
  type IndexedBookState,
} from "./indexed-book-state.ts";
import { requireLedger, type CompleteBookScope } from "./records.ts";
import { prepareIndexedBookOutcome, type IndexedOutcomeInput } from "./indexed-book-change.ts";
import type { LogicalNodeReader } from "./logical-map.ts";

/** New framing only. Existing compact/archive record versions are unchanged;
 * no adapter, migration or indexed execution profile is enabled by this codec. */
export const INDEXED_OUTCOME_RECORD_VERSION = "rastrata-indexed-outcome-v1";
export const INDEXED_OUTCOME_RECORD_MAX_BYTES = 4 * 1024 * 1024;
export interface IndexedOutcomeRecord {
  readonly version: typeof INDEXED_OUTCOME_RECORD_VERSION;
  readonly before: IndexedBookHead;
  readonly after: IndexedBookHead;
  readonly state: string;
  readonly payload: string;
  readonly payloadHash: ContentHash;
  readonly contentHash: string;
}
const encoder = new TextEncoder();
function header(state: IndexedBookState): BookStateHeader {
  const decoded = decodeBookStateHeader(state.header);
  requireLedger(decoded.disposition === "decoded", "indexed_outcome_header_invalid");
  return decoded.header;
}
function payloadHash(encoded: string): ContentHash {
  return hashCanonical({ domain: `${INDEXED_OUTCOME_RECORD_VERSION}/payload`, encoded });
}
function bounded(encoded: string) {
  requireLedger(
    typeof encoded === "string" &&
      encoded.length <= INDEXED_OUTCOME_RECORD_MAX_BYTES &&
      encoder.encode(encoded).length <= INDEXED_OUTCOME_RECORD_MAX_BYTES,
    "indexed_outcome_bytes_exceeded",
  );
}
function commitIntent(
  old: BookStateHeader,
  next: BookStateHeader,
  payload: BookOutcomePayload,
): BookCommitIntent {
  requireLedger(payload.revision !== null, "indexed_outcome_revision_mismatch");
  const { command, revision } = payload;
  return {
    command,
    expectedBookRevision: old.bookRevision,
    nextBookRevision: next.bookRevision,
    resultingPostingSequence: next.latestPostingSequence,
    expectedConfigurationRevision: old.configurationRevision,
    nextConfigurationRevision: next.configurationRevision,
    resultingConfigurationHash: next.configurationHash,
    effects: revision.effects,
    canonicalHash: hashCommitIntent(
      command,
      old.bookRevision,
      next.bookRevision,
      next.latestPostingSequence,
      old.configurationRevision,
      next.configurationRevision,
      next.configurationHash,
      revision.effects,
    ),
  };
}

/** Bind a separately verified transition to the exact prior full head. Checks
 * framing, necessary scalar continuity and original result/revision mathematics;
 * does NOT prove row availability, complete effect projection, command admission,
 * retry identity, active ownership, publication CAS or durable acknowledgement.
 * In particular, a well-hashed state or rejection reason can still be false.
 * No whole historical array is decoded or hashed by this function. */
export function prepareIndexedOutcomeRecord(
  scope: CompleteBookScope,
  actualObjectId: string,
  inputBeforeState: IndexedBookState,
  inputBeforeHead: IndexedBookHead,
  inputAfterState: IndexedBookState,
  encodedPayload: string,
): IndexedOutcomeRecord {
  const beforeState = decodeIndexedBookState(encodeIndexedBookState(inputBeforeState));
  const afterState = decodeIndexedBookState(encodeIndexedBookState(inputAfterState));
  const before = decodeIndexedBookHead(
    JSON.stringify(inputBeforeHead),
    beforeState,
    scope,
    actualObjectId,
  );
  const old = header(beforeState),
    next = header(afterState);
  const decoded = decodeBookOutcome(encodedPayload);
  requireLedger(decoded.disposition === "decoded", "indexed_outcome_payload_invalid");
  const { command, originalResult: result, revision } = decoded.payload;
  requireLedger(
    command.bookId === scope.bookId &&
      contentHashEquals(old.financialIdentityHash, next.financialIdentityHash),
    "indexed_outcome_identity_mismatch",
  );
  requireLedger(
    contentHashEquals(commandInputHash(command), command.inputHash),
    "indexed_outcome_command_hash_mismatch",
  );
  requireLedger(
    contentHashEquals(
      hashBookCommandResult(
        command,
        result.disposition,
        result.observedBookRevision,
        result.diagnostics,
        result.completedAt,
        result.committedAt,
      ),
      result.resultHash,
    ),
    "indexed_outcome_result_hash_mismatch",
  );
  const count = afterState.collections.find(
    (c) => c.collection === "protocol.retainedResults",
  )?.population;
  requireLedger(
    count !== undefined && BigInt(count) === BigInt(before.sequence) + 1n,
    "indexed_outcome_sequence_mismatch",
  );
  let revisionHash = before.revisionHash;
  if (result.disposition === "rejected") {
    requireLedger(
      revision === null &&
        result.observedBookRevision === old.bookRevision &&
        afterState.stateRoot === beforeState.stateRoot,
      "indexed_outcome_rejection_changed_state",
    );
  } else {
    requireLedger(
      revision !== null &&
        command.expectedBookRevision === old.bookRevision &&
        next.bookRevision === old.bookRevision + 1n &&
        result.observedBookRevision === next.bookRevision,
      "indexed_outcome_revision_mismatch",
    );
    const configurations = revision.effects.filter((effect) => effect.type === "configuration");
    const activations = revision.effects.filter((effect) => effect.type === "activation");
    const journals = revision.effects.filter((effect) => effect.type === "journal");
    requireLedger(
      next.latestPostingSequence === old.latestPostingSequence + BigInt(journals.length) &&
        configurations.length <= 1 &&
        next.configurationRevision === old.configurationRevision + BigInt(configurations.length) &&
        activations.length <= 1 &&
        next.status === (activations.length === 1 ? "open" : old.status),
      "indexed_outcome_scalar_mismatch",
    );
    const configuration = configurations[0];
    requireLedger(
      contentHashEquals(
        next.configurationHash,
        configuration?.contentHash ?? old.configurationHash,
      ) &&
        (configuration === undefined ||
          (configuration.expectedConfigurationRevision === old.configurationRevision &&
            configuration.nextConfigurationRevision === next.configurationRevision &&
            contentHashEquals(configuration.previousConfigurationHash, old.configurationHash))),
      "indexed_outcome_configuration_mismatch",
    );
    const intent = commitIntent(old, next, decoded.payload);
    const expected = prepareBookCommitRecords(
      {
        bookId: old.identity.bookId,
        bookRevision: old.bookRevision,
        previousRevision:
          before.revisionHash === null
            ? null
            : {
                bookId: old.identity.bookId,
                bookRevision: old.bookRevision,
                chainHash: before.revisionHash,
              },
      },
      intent,
    );
    requireLedger(
      encodeBookOutcome({
        command: expected.retained.command,
        revision: expected.revision,
        originalResult: { ...expected.result, disposition: "committed" },
      }) === encodedPayload,
      "indexed_outcome_revision_content_mismatch",
    );
    revisionHash = expected.revision.chainHash;
  }
  const hash = payloadHash(encodedPayload);
  // Acyclic: the chain binds the prior head and new state, NOT the resulting
  // head that will itself contain this chain hash. Physical scope is in before.
  const chain = hashCanonical(
    canonicalAccountingValue({
      domain: `${INDEXED_OUTCOME_RECORD_VERSION}/chain`,
      beforeHead: JSON.stringify(before),
      stateContentHash: afterState.contentHash,
      payloadHash: hash,
    }),
  );
  const after = prepareIndexedBookHead(scope, actualObjectId, afterState, chain, revisionHash);
  const body = {
    version: INDEXED_OUTCOME_RECORD_VERSION,
    before,
    after,
    state: encodeIndexedBookState(afterState),
    payload: encodedPayload,
    payloadHash: hash,
  } as const;
  const record = Object.freeze({
    ...body,
    contentHash: hashCanonical({
      domain: INDEXED_OUTCOME_RECORD_VERSION,
      encoded: JSON.stringify(body),
    }).digest,
  });
  bounded(JSON.stringify(record));
  return record;
}

/** Exact framing against an independently supplied prior head/state. Returning
 * a record is not replay verification or authority to select it as canonical. */
export function decodeIndexedOutcomeRecord(
  encoded: string,
  scope: CompleteBookScope,
  actualObjectId: string,
  beforeState: IndexedBookState,
  expectedBeforeHead: IndexedBookHead,
): IndexedOutcomeRecord {
  bounded(encoded);
  const parsed: unknown = JSON.parse(encoded);
  requireLedger(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    "indexed_outcome_shape_invalid",
  );
  const value = parsed as Record<string, unknown>;
  requireLedger(
    Object.keys(value).sort().join(",") ===
      "after,before,contentHash,payload,payloadHash,state,version" &&
      value.version === INDEXED_OUTCOME_RECORD_VERSION &&
      typeof value.state === "string" &&
      typeof value.payload === "string",
    "indexed_outcome_shape_invalid",
  );
  const state = decodeIndexedBookState(value.state);
  const record = prepareIndexedOutcomeRecord(
    scope,
    actualObjectId,
    beforeState,
    expectedBeforeHead,
    state,
    value.payload,
  );
  requireLedger(JSON.stringify(record) === encoded, "indexed_outcome_encoding_mismatch");
  return record;
}

/** Replay exactly the canonical row projection using authenticated prior nodes
 * and (for a commit) its source-verified complete financial predecessor. Rejection
 * requires no predecessor read; pass null. Rebuilds every affected root and checks
 * the entire resulting state, not only head counters or a final-row membership.
 * This still does NOT reexecute accounting admission or establish active ownership,
 * permanent-ID absence, durability, full-history recovery or permission to publish. */
export async function replayIndexedOutcomeProjection(
  encoded: string,
  scope: CompleteBookScope,
  actualObjectId: string,
  inputBeforeState: IndexedBookState,
  expectedBeforeHead: IndexedBookHead,
  previousRevision: RevisionRecord | null,
  readNode: LogicalNodeReader,
) {
  const beforeState = decodeIndexedBookState(encodeIndexedBookState(inputBeforeState));
  const record = decodeIndexedOutcomeRecord(
    encoded,
    scope,
    actualObjectId,
    beforeState,
    expectedBeforeHead,
  );
  const afterState = decodeIndexedBookState(record.state);
  const decoded = decodeBookOutcome(record.payload);
  requireLedger(decoded.disposition === "decoded", "indexed_outcome_payload_invalid");
  const { command, originalResult: result } = decoded.payload;
  let decision: IndexedOutcomeInput;
  if (result.disposition === "committed")
    decision = {
      kind: "commit",
      intent: commitIntent(header(beforeState), header(afterState), decoded.payload),
      previousRevision,
    };
  else {
    requireLedger(previousRevision === null, "indexed_outcome_rejection_predecessor_unused");
    decision = {
      kind: "rejection",
      retained: {
        command,
        commandId: command.id,
        inputHash: command.inputHash,
        outcome: "rejected",
        observedBookRevision: result.observedBookRevision,
        resultHash: result.resultHash,
        completedAt: result.completedAt,
        diagnostics: result.diagnostics,
      },
    };
  }
  const candidate = await prepareIndexedBookOutcome(beforeState, decision, readNode);
  requireLedger(
    encodeIndexedBookState(candidate.state) === record.state &&
      candidate.encodedOutcome === record.payload,
    "indexed_outcome_projection_mismatch",
  );
  return Object.freeze({ record, candidate });
}

import {
  BOOK_OUTCOME_CODEC_VERSION,
  DURABLE_BOOK_CODEC_VERSION,
  decodeBookOutcome,
  hashCanonical,
  identifier,
  type CanonicalValue,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  COMPACT_LEDGER_FORMAT,
  LEDGER_LIMITS,
  chunkDigest,
  decodeAggregate,
  financialHead,
  payloadDigest,
  requireLedger,
  resultDigest,
  type CompleteBookScope,
  type LedgerHead,
  type OutcomeRecord,
} from "./records.ts";

/** Historical framing identity, preserved byte-for-byte. Its semantic-version
 * tag is not a runtime selector: exact execution also depends on recorded policy
 * algorithms and the optional hashed genesis execution profile. Not the npm
 * package version, ambient deployment version, or a release claim. */
export const COMPACT_FORMAT_IDENTITY = Object.freeze({
  ledgerVersion: COMPACT_LEDGER_FORMAT,
  commandCodecVersion: BOOK_OUTCOME_CODEC_VERSION,
  kernelSemanticVersion: "1.0.1",
  kernelCodecVersion: DURABLE_BOOK_CODEC_VERSION,
  hashAlgorithm: "sha256",
  canonicalizationVersion: "rastrata-canonical-v1",
});

export interface ChunkManifestEntry {
  readonly parentId: string;
  readonly ordinal: string;
  readonly byteCount: string;
  readonly digest: string;
}
export interface CompactFrame {
  readonly identity: CompleteBookScope;
  readonly format: typeof COMPACT_FORMAT_IDENTITY;
  readonly commandHash: string;
  readonly payloadBytes: string;
  readonly chunkCount: string;
  readonly chunks: readonly ChunkManifestEntry[];
}

export function completeScope(input: CompleteBookScope, actualObjectId: string): CompleteBookScope {
  requireLedger(input !== null && typeof input === "object", "ledger_identity_mismatch");
  const fields = ["tenantId", "bookId", "objectId", "namespaceId", "generation"] as const;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === fields.length, "ledger_identity_mismatch");
  const copied = {} as Record<(typeof fields)[number], string>;
  for (const field of fields) {
    const descriptor = descriptors[field];
    requireLedger(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "ledger_identity_mismatch",
    );
    const value: unknown = descriptor.value;
    requireLedger(typeof value === "string", "ledger_identity_mismatch");
    if (field === "generation")
      requireLedger(/^(0|[1-9][0-9]{0,63})$/.test(value), "ledger_identity_mismatch");
    else identifier(value);
    copied[field] = value;
  }
  requireLedger(copied.objectId === actualObjectId, "ledger_identity_mismatch");
  return Object.freeze(copied);
}

export function completeFinancialHead(aggregate: DurableBookAggregate) {
  return {
    ...financialHead(aggregate),
    revisionHash:
      aggregate.state.revisions.at(-1)?.chainHash.digest ??
      hashCanonical({
        domain: `${COMPACT_LEDGER_FORMAT}/empty-revision`,
        bookId: aggregate.state.identity.bookId,
        financialIdentityHash: { ...aggregate.state.financialIdentityHash },
      }).digest,
    protocolHash: hashCanonical({
      domain: `${COMPACT_LEDGER_FORMAT}/protocol`,
      // Commands are committed by their complete, kernel-validated canonical hash.
      // All retained result fields (including commit intent) remain in this preimage.
      retainedResults: aggregate.protocol.retainedResults.map(({ command, ...retained }) => ({
        ...retained,
        commandHash: { ...command.inputHash },
      })) as unknown as CanonicalValue,
    }).digest,
  };
}

export function compactGenesisHead(scope: CompleteBookScope, body: string): LedgerHead {
  const identity = completeScope(scope, scope.objectId);
  const aggregate = decodeAggregate(body);
  const heads = completeFinancialHead(aggregate);
  return Object.freeze({
    sequence: "0",
    chainHash: hashCanonical({
      domain: `${COMPACT_LEDGER_FORMAT}/genesis`,
      identity: { ...identity },
      format: COMPACT_FORMAT_IDENTITY,
      body,
      ...heads,
    }).digest,
    ...heads,
  });
}

/** Framing follows successful real-kernel evaluation/replay. This function alone
 * cannot prove that a caller-supplied aggregate is the command's actual result. */
export function compactOutcomeRecord(
  scope: CompleteBookScope,
  before: LedgerHead,
  aggregate: DurableBookAggregate,
  body: string,
): OutcomeRecord {
  const identity = completeScope(scope, scope.objectId);
  const decoded = decodeBookOutcome(body);
  requireLedger(decoded.disposition === "decoded", "recovery_outcome_invalid");
  const { command, originalResult } = decoded.payload;
  requireLedger(command.bookId === identity.bookId, "ledger_identity_mismatch");
  const sequence = (BigInt(before.sequence) + 1n).toString();
  const bytes = new TextEncoder().encode(body);
  const chunks: ChunkManifestEntry[] = [];
  for (let offset = 0; offset < bytes.length; offset += LEDGER_LIMITS.chunkBytes) {
    const chunk = bytes.subarray(offset, offset + LEDGER_LIMITS.chunkBytes);
    chunks.push(
      Object.freeze({
        parentId: sequence,
        ordinal: chunks.length.toString(),
        byteCount: chunk.length.toString(),
        digest: chunkDigest(chunk, COMPACT_LEDGER_FORMAT),
      }),
    );
  }
  const frame: CompactFrame = Object.freeze({
    identity,
    format: COMPACT_FORMAT_IDENTITY,
    commandHash: command.inputHash.digest,
    payloadBytes: bytes.length.toString(),
    chunkCount: chunks.length.toString(),
    chunks: Object.freeze(chunks),
  });
  const financial = completeFinancialHead(aggregate);
  const payload = payloadDigest(body, COMPACT_LEDGER_FORMAT);
  const resultHash = resultDigest(originalResult);
  const chainHash = hashCanonical({
    domain: `${COMPACT_LEDGER_FORMAT}/outcome`,
    frame: frame as unknown as CanonicalValue,
    before: { ...before },
    sequence,
    ...financial,
    commandId: command.id,
    payloadDigest: payload,
    resultDigest: resultHash,
  }).digest;
  return Object.freeze({
    before,
    after: Object.freeze({ sequence, chainHash, ...financial }),
    commandId: command.id,
    revision: decoded.payload.revision?.bookRevision.toString() ?? null,
    resultDigest: resultHash,
    payloadDigest: payload,
    frame,
    body,
  });
}

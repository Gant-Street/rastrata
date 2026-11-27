import {
  type BookCommandResult,
  type CanonicalValue,
  type DurableBookAggregate,
  ExactDecimal,
  ExactRational,
  type BookCommand,
  assertBookCommandShape,
  decodeDurableBook,
  encodeDurableBook,
  hashCanonical,
  identifier,
} from "@rastrata/kernel";

export const LEDGER_FORMAT = "rastrata-ledger-snapshot-v1";
export const COMPACT_LEDGER_FORMAT = "rastrata-ledger-outcome-v1";
export type LedgerFormat = typeof LEDGER_FORMAT | typeof COMPACT_LEDGER_FORMAT;
export const LEDGER_LIMITS = Object.freeze({
  outcomes: 1_000,
  recordBytes: 1_048_576,
  chunkBytes: 262_144,
});

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export function requireLedger(condition: unknown, code: string): asserts condition {
  if (!condition) throw new LedgerError(code);
}

export interface BookScope {
  readonly tenantId: string;
  readonly bookId: string;
  readonly objectId: string;
}

export interface CompleteBookScope extends BookScope {
  readonly namespaceId: string;
  readonly generation: string;
}

export interface LedgerHead {
  readonly sequence: string;
  readonly chainHash: string;
  readonly stateHash: string;
  readonly bookRevision: string;
  readonly postingSequence: string;
  readonly configurationRevision: string;
  readonly configurationHash: string;
  /** Required by the compact format; absent from unchanged legacy heads. */
  readonly revisionHash?: string;
  readonly protocolHash?: string;
}

export interface OutcomeRecord {
  readonly before: LedgerHead;
  readonly after: LedgerHead;
  readonly commandId: string;
  readonly revision: string | null;
  readonly resultDigest: string;
  readonly payloadDigest: string;
  readonly body: string;
  /** Compact-format frame; legacy records must not contain this field. */
  readonly frame?: import("./compact-records.ts").CompactFrame;
}

export interface StoredBook {
  readonly format: string;
  readonly scope: BookScope;
  readonly genesis: string;
  readonly genesisDigest: string;
  readonly head: LedgerHead;
  readonly outcomes: readonly OutcomeRecord[];
}

export function validateScope(scope: BookScope, actualObjectId: string): void {
  requireLedger(
    Object.keys(scope).sort().join(",") === "bookId,objectId,tenantId",
    "ledger_identity_mismatch",
  );
  for (const value of Object.values(scope)) identifier(value);
  requireLedger(scope.objectId === actualObjectId, "ledger_identity_mismatch");
}

export function bookObjectName(tenantId: string, bookId: string): string {
  identifier(tenantId);
  identifier(bookId);
  return `rastrata-book-v1/${hashCanonical({ tenantId, bookId }).digest}`;
}

export function payloadDigest(body: string, format: LedgerFormat = LEDGER_FORMAT): string {
  return hashCanonical({ domain: format, body }).digest;
}

export function chunkDigest(bytes: Uint8Array, format: LedgerFormat = LEDGER_FORMAT): string {
  return hashCanonical({ domain: `${format}/chunk`, bytes }).digest;
}

/** Copy the trusted typed command before yielding; do not invoke caller accessors. */
export function snapshotCommand(command: BookCommand): BookCommand {
  let nodes = 0;
  let bytes = 0;
  function copy(value: unknown, depth: number): unknown {
    requireLedger(++nodes <= 10_000 && depth <= 64, "ledger_capacity_exceeded");
    if (typeof value === "string" || typeof value === "bigint") {
      bytes += new TextEncoder().encode(value.toString()).length;
      requireLedger(bytes <= 262_144, "ledger_capacity_exceeded");
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (value instanceof ExactDecimal)
      return ExactDecimal.of(
        copy(value.coefficient, depth + 1) as bigint,
        copy(value.scale, depth + 1) as bigint,
      );
    if (value instanceof ExactRational)
      return ExactRational.of(
        copy(value.numerator, depth + 1) as bigint,
        copy(value.denominator, depth + 1) as bigint,
      );
    if (value instanceof Uint8Array) {
      bytes += value.length;
      requireLedger(bytes <= 262_144, "ledger_capacity_exceeded");
      return value.slice();
    }
    requireLedger(typeof value === "object" && value !== null, "ledger_command_invalid");
    const prototype = Object.getPrototypeOf(value);
    requireLedger(
      Array.isArray(value) || prototype === Object.prototype || prototype === null,
      "ledger_command_invalid",
    );
    requireLedger(Object.getOwnPropertySymbols(value).length === 0, "ledger_command_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === "length") continue;
      requireLedger("value" in descriptor && descriptor.enumerable, "ledger_command_invalid");
      copy(key, depth + 1);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (Array.isArray(value)) {
      requireLedger(Object.keys(result).length === value.length, "ledger_command_invalid");
      return Object.freeze(
        Array.from({ length: value.length }, (_, i) => {
          requireLedger(Object.hasOwn(result, String(i)), "ledger_command_invalid");
          return result[String(i)];
        }),
      );
    }
    return Object.freeze(result);
  }
  const snapshot = copy(command, 0) as BookCommand;
  try {
    assertBookCommandShape(snapshot);
  } catch {
    throw new LedgerError("ledger_command_invalid");
  }
  return snapshot;
}

export function decodeAggregate(body: string): DurableBookAggregate {
  requireLedger(
    new TextEncoder().encode(body).byteLength <= LEDGER_LIMITS.recordBytes,
    "ledger_capacity_exceeded",
  );
  const decoded = decodeDurableBook(body);
  requireLedger(decoded.disposition === "decoded", "recovery_record_corrupt");
  requireLedger(encodeDurableBook(decoded.aggregate) === body, "recovery_record_corrupt");
  return decoded.aggregate;
}

export function financialHead(aggregate: DurableBookAggregate) {
  const state = aggregate.state;
  return {
    stateHash: state.contentHash.digest,
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    configurationRevision: state.configurationRevision.toString(),
    configurationHash: state.configurationHash.digest,
  };
}

export function genesisHead(scope: BookScope, body: string): LedgerHead {
  return Object.freeze({
    sequence: "0",
    chainHash: hashCanonical({ domain: `${LEDGER_FORMAT}/genesis`, ...scope, body }).digest,
    ...financialHead(decodeAggregate(body)),
  });
}

export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Complete canonical replay evidence, not merely a payload's claimed digest.
 * This preserves the existing owner-local replay fingerprint preimage exactly. */
export function verifiedOutcomeRecordHash(record: OutcomeRecord): string {
  return hashCanonical({
    domain: "rastrata-verified-replay-record-v1",
    record: JSON.stringify(record),
  }).digest;
}

export function resultDigest(result: BookCommandResult): string {
  return hashCanonical(result as unknown as CanonicalValue).digest;
}

export function outcomeRecord(
  scope: BookScope,
  before: LedgerHead,
  aggregate: DurableBookAggregate,
  result: BookCommandResult,
  commandId: string,
): OutcomeRecord {
  const body = encodeDurableBook({ state: aggregate.state, protocol: aggregate.protocol });
  decodeAggregate(body);
  const sequence = (BigInt(before.sequence) + 1n).toString();
  const financial = financialHead(aggregate);
  const payload = payloadDigest(body);
  const resultHash = resultDigest(result);
  const chainHash = hashCanonical({
    domain: `${LEDGER_FORMAT}/outcome`,
    ...scope,
    before: { ...before },
    sequence,
    ...financial,
    commandId,
    payloadDigest: payload,
    resultDigest: resultHash,
  }).digest;
  return Object.freeze({
    before,
    after: Object.freeze({ sequence, chainHash, ...financial }),
    commandId,
    revision:
      aggregate.state.bookRevision.toString() === before.bookRevision
        ? null
        : aggregate.state.bookRevision.toString(),
    resultDigest: resultHash,
    payloadDigest: payload,
    body,
  });
}

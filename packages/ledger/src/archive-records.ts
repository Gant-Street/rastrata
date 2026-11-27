import {
  hashCanonical,
  immutableAccountingValue,
  identifier,
  type CanonicalValue,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  COMPACT_FORMAT_IDENTITY,
  compactGenesisHead,
  compactOutcomeRecord,
  completeFinancialHead,
  completeScope,
} from "./compact-records.ts";
import {
  COMPACT_LEDGER_FORMAT,
  LEDGER_LIMITS,
  LedgerError,
  decodeAggregate,
  payloadDigest,
  requireLedger,
  type CompleteBookScope,
  type LedgerHead,
  type OutcomeRecord,
  type StoredBook,
} from "./records.ts";
import { replayOutcomePayload } from "./outcome-payload.ts";
import {
  referenceArchivePayload,
  type ArchivePayloadReference,
  type R2ArchiveObjectStore,
} from "./r2-archive-store.ts";

export const ARCHIVE_RECORD_VERSION = "rastrata-archive-record-v1";
export interface ArchiveDurabilityPolicy {
  readonly version: "rastrata-archive-durability-v1";
  readonly archiveRequired: boolean;
  readonly contentHash: string;
}
interface ArchiveManifestCore {
  readonly version: typeof ARCHIVE_RECORD_VERSION;
  readonly identity: CompleteBookScope;
  readonly format: typeof COMPACT_FORMAT_IDENTITY;
  readonly durabilityPolicy: ArchiveDurabilityPolicy;
  readonly payload: ArchivePayloadReference;
  readonly contentHash: string;
}
export interface ArchiveGenesisManifest extends ArchiveManifestCore {
  readonly kind: "genesis";
  readonly initialHead: LedgerHead;
  readonly genesisHash: string;
}
export interface ArchiveCommitManifest extends ArchiveManifestCore {
  readonly kind: "commit";
  readonly before: LedgerHead;
  readonly resulting: LedgerHead;
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly priorManifest: ArchivePayloadReference;
  readonly priorManifestHash: string;
  readonly fenceGeneration: string;
}
export type ArchiveManifest = ArchiveGenesisManifest | ArchiveCommitManifest;
export interface ArchiveAnchor {
  readonly version: typeof ARCHIVE_RECORD_VERSION;
  readonly kind: "anchor";
  readonly identity: CompleteBookScope;
  readonly format: typeof COMPACT_FORMAT_IDENTITY;
  readonly head: LedgerHead;
  readonly manifest: ArchivePayloadReference;
  readonly manifestHash: string;
  readonly fenceGeneration: string;
}
const encoder = new TextEncoder();
function canonical(value: unknown): CanonicalValue {
  // Archive metadata uses bounded JSON byte counts. Commit them as exact
  // integers, without broadening the kernel's prohibition on JS-number money.
  if (typeof value === "number") {
    requireLedger(Number.isSafeInteger(value) && value >= 0, "archive_record_invalid");
    return BigInt(value);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonical);
  requireLedger(typeof value === "object", "archive_record_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, canonical(member)]));
}
const hash = (value: unknown) => hashCanonical(canonical(value)).digest;
const same = (left: unknown, right: unknown) => hash(left) === hash(right);
function object(input: unknown, names: readonly string[]): Record<string, unknown> {
  requireLedger(input !== null && typeof input === "object", "archive_record_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === names.length, "archive_record_invalid");
  const copy: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = descriptors[name];
    requireLedger(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "archive_record_invalid",
    );
    copy[name] = descriptor.value;
  }
  return copy;
}
function digest(value: unknown): string {
  requireLedger(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    "archive_record_invalid",
  );
  return value;
}
function natural(value: unknown): string {
  requireLedger(
    typeof value === "string" && /^(0|[1-9][0-9]{0,63})$/.test(value),
    "archive_record_invalid",
  );
  return value;
}
function identity(value: unknown): CompleteBookScope {
  const row = object(value, ["tenantId", "bookId", "objectId", "namespaceId", "generation"]);
  requireLedger(typeof row.objectId === "string", "archive_record_invalid");
  return completeScope(row as unknown as CompleteBookScope, row.objectId);
}
function format(value: unknown): typeof COMPACT_FORMAT_IDENTITY {
  const row = object(value, Object.keys(COMPACT_FORMAT_IDENTITY));
  requireLedger(
    Object.entries(COMPACT_FORMAT_IDENTITY).every(([key, expected]) => row[key] === expected),
    "archive_format_unsupported",
  );
  return COMPACT_FORMAT_IDENTITY;
}
function head(value: unknown): LedgerHead {
  const row = object(value, [
    "sequence",
    "chainHash",
    "stateHash",
    "bookRevision",
    "postingSequence",
    "configurationRevision",
    "configurationHash",
    "revisionHash",
    "protocolHash",
  ]);
  return Object.freeze({
    sequence: natural(row.sequence),
    chainHash: digest(row.chainHash),
    stateHash: digest(row.stateHash),
    bookRevision: natural(row.bookRevision),
    postingSequence: natural(row.postingSequence),
    configurationRevision: natural(row.configurationRevision),
    configurationHash: digest(row.configurationHash),
    revisionHash: digest(row.revisionHash),
    protocolHash: digest(row.protocolHash),
  });
}
export function createArchiveDurabilityPolicy(archiveRequired: boolean): ArchiveDurabilityPolicy {
  requireLedger(typeof archiveRequired === "boolean", "archive_record_invalid");
  const body = { version: "rastrata-archive-durability-v1" as const, archiveRequired };
  return Object.freeze({
    ...body,
    contentHash: hash({ domain: `${ARCHIVE_RECORD_VERSION}/durability`, ...body }),
  });
}
function policy(value: unknown): ArchiveDurabilityPolicy {
  const row = object(value, ["version", "archiveRequired", "contentHash"]);
  requireLedger(typeof row.archiveRequired === "boolean", "archive_record_invalid");
  const expected = createArchiveDurabilityPolicy(row.archiveRequired);
  requireLedger(
    row.version === expected.version && row.contentHash === expected.contentHash,
    "archive_policy_mismatch",
  );
  return expected;
}
function reference(value: unknown, scope: CompleteBookScope): ArchivePayloadReference {
  const row = object(value, ["objectKey", "payloadHash", "payloadBytes"]);
  const payloadHash = digest(row.payloadHash);
  const empty = referenceArchivePayload(scope, scope.objectId, new Uint8Array());
  const key = `${empty.objectKey.slice(0, -64)}${payloadHash}`;
  requireLedger(
    row.objectKey === key &&
      typeof row.payloadBytes === "number" &&
      Number.isSafeInteger(row.payloadBytes) &&
      row.payloadBytes >= 0 &&
      row.payloadBytes <= LEDGER_LIMITS.recordBytes,
    "archive_record_invalid",
  );
  return Object.freeze({ objectKey: key, payloadHash, payloadBytes: row.payloadBytes });
}
function manifestHash(body: Omit<ArchiveManifest, "contentHash">): string {
  return hash({ domain: `${ARCHIVE_RECORD_VERSION}/manifest`, body });
}
function normalizedManifest(input: unknown): ArchiveManifest {
  requireLedger(input !== null && typeof input === "object", "archive_record_invalid");
  const kindDescriptor = Object.getOwnPropertyDescriptor(input, "kind");
  requireLedger(kindDescriptor && "value" in kindDescriptor, "archive_record_invalid");
  const kind = kindDescriptor.value;
  requireLedger(kind === "genesis" || kind === "commit", "archive_record_invalid");
  const row = object(input, [
    "version",
    "kind",
    "identity",
    "format",
    "durabilityPolicy",
    "payload",
    "contentHash",
    ...(kind === "genesis"
      ? ["initialHead", "genesisHash"]
      : [
          "before",
          "resulting",
          "candidateId",
          "candidateHash",
          "priorManifest",
          "priorManifestHash",
          "fenceGeneration",
        ]),
  ]);
  requireLedger(row.version === ARCHIVE_RECORD_VERSION, "archive_format_unsupported");
  const scope = identity(row.identity);
  const common = {
    version: ARCHIVE_RECORD_VERSION as typeof ARCHIVE_RECORD_VERSION,
    identity: scope,
    format: format(row.format),
    durabilityPolicy: policy(row.durabilityPolicy),
    payload: reference(row.payload, scope),
  };
  let body:
    | Omit<ArchiveGenesisManifest, "contentHash">
    | Omit<ArchiveCommitManifest, "contentHash">;
  if (kind === "genesis") {
    const initialHead = head(row.initialHead);
    requireLedger(
      initialHead.sequence === "0" && initialHead.bookRevision === "0",
      "archive_record_invalid",
    );
    body = { ...common, kind, initialHead, genesisHash: digest(row.genesisHash) };
  } else {
    const before = head(row.before),
      resulting = head(row.resulting);
    requireLedger(
      BigInt(resulting.sequence) === BigInt(before.sequence) + 1n &&
        typeof row.candidateId === "string",
      "archive_record_invalid",
    );
    body = {
      ...common,
      kind,
      before,
      resulting,
      candidateId: identifier(row.candidateId),
      candidateHash: digest(row.candidateHash),
      priorManifest: reference(row.priorManifest, scope),
      priorManifestHash: digest(row.priorManifestHash),
      fenceGeneration: natural(row.fenceGeneration),
    };
  }
  const contentHash = digest(row.contentHash);
  requireLedger(contentHash === manifestHash(body), "archive_manifest_hash_mismatch");
  return immutableAccountingValue({ ...body, contentHash });
}
function normalizedAnchor(input: unknown): ArchiveAnchor {
  const row = object(input, [
    "version",
    "kind",
    "identity",
    "format",
    "head",
    "manifest",
    "manifestHash",
    "fenceGeneration",
  ]);
  requireLedger(
    row.version === ARCHIVE_RECORD_VERSION && row.kind === "anchor",
    "archive_format_unsupported",
  );
  const scope = identity(row.identity);
  return immutableAccountingValue({
    version: ARCHIVE_RECORD_VERSION,
    kind: "anchor",
    identity: scope,
    format: format(row.format),
    head: head(row.head),
    manifest: reference(row.manifest, scope),
    manifestHash: digest(row.manifestHash),
    fenceGeneration: natural(row.fenceGeneration),
  });
}
function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  requireLedger(
    encoder.encode(encoded).length <= LEDGER_LIMITS.recordBytes,
    "archive_record_capacity_exceeded",
  );
  return encoded;
}
function parse(encoded: string): unknown {
  requireLedger(
    typeof encoded === "string" &&
      encoded.length <= LEDGER_LIMITS.recordBytes &&
      encoder.encode(encoded).length <= LEDGER_LIMITS.recordBytes,
    "archive_record_capacity_exceeded",
  );
  try {
    return JSON.parse(encoded);
  } catch {
    throw new LedgerError("archive_record_invalid");
  }
}
export function encodeArchiveManifest(value: ArchiveManifest): string {
  return encode(normalizedManifest(value));
}
export function decodeArchiveManifest(encoded: string): ArchiveManifest {
  const value = normalizedManifest(parse(encoded));
  requireLedger(encode(value) === encoded, "archive_record_noncanonical");
  return value;
}
export function encodeArchiveAnchor(value: ArchiveAnchor): string {
  return encode(normalizedAnchor(value));
}
export function decodeArchiveAnchor(encoded: string): ArchiveAnchor {
  const value = normalizedAnchor(parse(encoded));
  requireLedger(encode(value) === encoded, "archive_record_noncanonical");
  return value;
}
const manifestHead = (manifest: ArchiveManifest) =>
  manifest.kind === "genesis" ? manifest.initialHead : manifest.resulting;
function payloadMatches(
  scope: CompleteBookScope,
  encoded: string,
  input: ArchivePayloadReference,
): ArchivePayloadReference {
  const actual = referenceArchivePayload(scope, scope.objectId, encoder.encode(encoded));
  requireLedger(same(reference(input, scope), actual), "archive_payload_reference_mismatch");
  return actual;
}
/** Pure preparation only: this does not reserve, upload, publish or acknowledge. */
export function prepareArchiveGenesis(
  scopeInput: CompleteBookScope,
  policyInput: ArchiveDurabilityPolicy,
  encoded: string,
  payload: ArchivePayloadReference,
): ArchiveGenesisManifest {
  const scope = identity(scopeInput),
    durabilityPolicy = policy(policyInput),
    aggregate = decodeAggregate(encoded);
  requireLedger(
    aggregate.state.identity.bookId === scope.bookId &&
      aggregate.state.bookRevision === 0n &&
      aggregate.protocol.retainedResults.length === 0,
    "archive_genesis_invalid",
  );
  const body: Omit<ArchiveGenesisManifest, "contentHash"> = {
    version: ARCHIVE_RECORD_VERSION,
    kind: "genesis" as const,
    identity: scope,
    format: COMPACT_FORMAT_IDENTITY,
    durabilityPolicy,
    payload: payloadMatches(scope, encoded, payload),
    initialHead: compactGenesisHead(scope, encoded),
    genesisHash: payloadDigest(encoded, COMPACT_LEDGER_FORMAT),
  };
  return normalizedManifest({ ...body, contentHash: manifestHash(body) }) as ArchiveGenesisManifest;
}
/** Before-state is the previously verified replay state, not caller accounting
 * authority. Reexecuting exact original receipts is required, including rejection.
 * The resulting candidate hash is not proof that SQL durably selected it. */
export function prepareArchiveCommit(
  priorInput: ArchiveManifest,
  priorReference: ArchivePayloadReference,
  before: DurableBookAggregate,
  encoded: string,
  payload: ArchivePayloadReference,
  candidateId: string,
  fenceGeneration: string,
) {
  const prior = normalizedManifest(priorInput),
    beforeHead = manifestHead(prior);
  const { sequence: _sequence, chainHash: _chainHash, ...financial } = beforeHead;
  requireLedger(same(financial, completeFinancialHead(before)), "archive_prior_head_mismatch");
  natural(fenceGeneration);
  requireLedger(
    prior.kind === "genesis" || BigInt(fenceGeneration) >= BigInt(prior.fenceGeneration),
    "archive_fence_regression",
  );
  const source = payloadMatches(prior.identity, encodeArchiveManifest(prior), priorReference);
  const payloadReference = payloadMatches(prior.identity, encoded, payload);
  const transition = replayOutcomePayload(before, encoded);
  const aggregate = { state: transition.state, protocol: transition.protocol };
  const outcome = compactOutcomeRecord(prior.identity, beforeHead, aggregate, encoded);
  const selectedId = identifier(candidateId);
  const candidateHash = hash({
    domain: `${ARCHIVE_RECORD_VERSION}/candidate`,
    identity: prior.identity,
    format: prior.format,
    durabilityPolicy: prior.durabilityPolicy,
    priorManifest: source,
    priorManifestHash: prior.contentHash,
    candidateId: selectedId,
    fenceGeneration,
    outcome,
  });
  const body: Omit<ArchiveCommitManifest, "contentHash"> = {
    version: ARCHIVE_RECORD_VERSION,
    kind: "commit" as const,
    identity: prior.identity,
    format: prior.format,
    durabilityPolicy: prior.durabilityPolicy,
    before: outcome.before,
    resulting: outcome.after,
    payload: payloadReference,
    candidateId: selectedId,
    candidateHash,
    priorManifest: source,
    priorManifestHash: prior.contentHash,
    fenceGeneration,
  };
  const manifest = normalizedManifest({
    ...body,
    contentHash: manifestHash(body),
  }) as ArchiveCommitManifest;
  return Object.freeze({ manifest, aggregate, outcome });
}
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LedgerError("archive_record_invalid");
  }
}

/** Recover one externally expected, pinned archive head. Every referenced
 * manifest/payload is fetched and every original result is reexecuted. No LIST,
 * missing-prefix fallback, inferred membership from an orphan, or new outcome.
 * Expected anchor/policy must come from trusted owner/restore authority, not a
 * public request. This historical result is not current service-readiness proof.
 */
async function replayArchiveChain(
  store: R2ArchiveObjectStore,
  expectedInput: ArchiveAnchor,
  policyInput: ArchiveDurabilityPolicy,
  retainHistory: boolean,
) {
  const expected = normalizedAnchor(expectedInput),
    expectedPolicy = policy(policyInput);
  requireLedger(
    BigInt(expected.head.sequence) <= BigInt(LEDGER_LIMITS.outcomes),
    "archive_record_capacity_exceeded",
  );
  const control = await store.readControl();
  requireLedger(
    control !== null && control.body === encodeArchiveAnchor(expected),
    "archive_anchor_mismatch",
  );
  const chain: { manifest: ArchiveManifest; reference: ArchivePayloadReference }[] = [];
  let nextReference = expected.manifest,
    expectedHash = expected.manifestHash,
    expectedHead = expected.head,
    maximumFence = BigInt(expected.fenceGeneration);
  for (;;) {
    requireLedger(chain.length <= LEDGER_LIMITS.outcomes, "archive_record_capacity_exceeded");
    const manifest = decodeArchiveManifest(utf8(await store.readImmutable(nextReference)));
    requireLedger(
      same(manifest.identity, expected.identity) && same(manifest.durabilityPolicy, expectedPolicy),
      "archive_identity_policy_mismatch",
    );
    requireLedger(
      manifest.contentHash === expectedHash && same(manifestHead(manifest), expectedHead),
      "archive_chain_mismatch",
    );
    chain.push({ manifest, reference: nextReference });
    if (manifest.kind === "genesis") break;
    requireLedger(BigInt(manifest.fenceGeneration) <= maximumFence, "archive_fence_regression");
    maximumFence = BigInt(manifest.fenceGeneration);
    nextReference = manifest.priorManifest;
    expectedHash = manifest.priorManifestHash;
    expectedHead = manifest.before;
  }
  chain.reverse();
  const first = chain[0];
  requireLedger(first?.manifest.kind === "genesis", "archive_genesis_invalid");
  const genesisBytes = utf8(await store.readImmutable(first.manifest.payload));
  requireLedger(
    same(
      prepareArchiveGenesis(
        expected.identity,
        expectedPolicy,
        genesisBytes,
        first.manifest.payload,
      ),
      first.manifest,
    ),
    "archive_genesis_mismatch",
  );
  let aggregate = decodeAggregate(genesisBytes),
    previous = first;
  const outcomes: OutcomeRecord[] = [];
  let lastPredecessorManifest: ArchiveManifest | null = null;
  for (const current of chain.slice(1)) {
    requireLedger(current.manifest.kind === "commit", "archive_chain_mismatch");
    const encoded = utf8(await store.readImmutable(current.manifest.payload));
    const replayed = prepareArchiveCommit(
      previous.manifest,
      previous.reference,
      aggregate,
      encoded,
      current.manifest.payload,
      current.manifest.candidateId,
      current.manifest.fenceGeneration,
    );
    requireLedger(same(replayed.manifest, current.manifest), "archive_outcome_mismatch");
    if (retainHistory) outcomes.push(replayed.outcome);
    lastPredecessorManifest = previous.manifest;
    aggregate = replayed.aggregate;
    previous = current;
  }
  return Object.freeze({
    genesisManifest: first.manifest,
    aggregate,
    head: expected.head,
    manifest: previous.manifest,
    manifestReference: previous.reference,
    control,
    lastPredecessorManifest,
    book: retainHistory
      ? (immutableAccountingValue({
          format: COMPACT_LEDGER_FORMAT,
          scope: expected.identity,
          genesis: genesisBytes,
          genesisDigest: first.manifest.genesisHash,
          head: expected.head,
          outcomes,
        }) as StoredBook)
      : null,
  });
}

export async function recoverArchiveChain(
  store: R2ArchiveObjectStore,
  expected: ArchiveAnchor,
  policy: ArchiveDurabilityPolicy,
) {
  const recovered = await replayArchiveChain(store, expected, policy, false);
  return Object.freeze({
    genesisManifest: recovered.genesisManifest,
    aggregate: recovered.aggregate,
    head: recovered.head,
    manifest: recovered.manifest,
    manifestReference: recovered.manifestReference,
    control: recovered.control,
  });
}

/** Exact original SQL materialization input. No reconstructed historical
 * transport ETags/nonces. Used only by permit-governed restore preparation;
 * ordinary archive reads do not retain another full copy of outcome bodies. */
export async function recoverArchiveBook(
  store: R2ArchiveObjectStore,
  expected: ArchiveAnchor,
  policy: ArchiveDurabilityPolicy,
) {
  const recovered = await replayArchiveChain(store, expected, policy, true);
  requireLedger(recovered.book !== null, "archive_restore_history_missing");
  return Object.freeze({ ...recovered, book: recovered.book });
}

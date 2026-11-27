import { LEDGER_LIMITS, requireLedger } from "./records.ts";
import type { IndexedLedgerOwner } from "./indexed-ledger-owner.ts";
import type {
  R2ArchiveObjectStore,
  ArchivePayloadReference,
  ArchiveControlVersion,
} from "./r2-archive-store.ts";
import { indexedSourceGenesisHash } from "./indexed-source-catalog.ts";
import {
  projectLegacyIndexedBook,
  prepareIndexedBookHead,
  decodeIndexedBookState,
} from "./indexed-book-state.ts";
import { decodeIndexedOutcomeRecord } from "./indexed-outcome-record.ts";

const FORMAT = "rastrata-indexed-outcome-outbox-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hex = /^[0-9a-f]{64}$/;
interface Manifest {
  readonly format: typeof FORMAT;
  readonly genesisHash: string;
  readonly sequence: string;
  readonly recordHash: string | null;
  readonly payload: ArchivePayloadReference;
  readonly previous: ArchivePayloadReference | null;
}
function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireLedger(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    "outbox_manifest_invalid",
  );
}
function reference(value: unknown): ArchivePayloadReference {
  fields(value, ["objectKey", "payloadHash", "payloadBytes"]);
  requireLedger(
    typeof value.objectKey === "string" &&
      value.objectKey.length <= 1024 &&
      typeof value.payloadHash === "string" &&
      hex.test(value.payloadHash) &&
      typeof value.payloadBytes === "number" &&
      Number.isSafeInteger(value.payloadBytes) &&
      value.payloadBytes >= 0 &&
      value.payloadBytes <= LEDGER_LIMITS.recordBytes,
    "outbox_manifest_invalid",
  );
  return Object.freeze({
    objectKey: value.objectKey,
    payloadHash: value.payloadHash,
    payloadBytes: value.payloadBytes,
  });
}
function manifest(bytes: Uint8Array): Manifest {
  const raw: unknown = JSON.parse(decoder.decode(bytes));
  fields(raw, ["format", "genesisHash", "sequence", "recordHash", "payload", "previous"]);
  requireLedger(
    raw.format === FORMAT &&
      typeof raw.genesisHash === "string" &&
      hex.test(raw.genesisHash) &&
      typeof raw.sequence === "string" &&
      /^(0|[1-9][0-9]{0,19})$/.test(raw.sequence) &&
      BigInt(raw.sequence) <= BigInt(LEDGER_LIMITS.outcomes) &&
      (raw.sequence === "0"
        ? raw.recordHash === null && raw.previous === null
        : typeof raw.recordHash === "string" && hex.test(raw.recordHash) && raw.previous !== null),
    "outbox_manifest_invalid",
  );
  return Object.freeze({
    format: FORMAT,
    genesisHash: raw.genesisHash,
    sequence: raw.sequence,
    recordHash: raw.recordHash as string | null,
    payload: reference(raw.payload),
    previous: raw.previous === null ? null : reference(raw.previous),
  });
}
function controlReference(version: ArchiveControlVersion): ArchivePayloadReference {
  const raw: unknown = JSON.parse(version.body);
  fields(raw, ["format", "manifest"]);
  requireLedger(raw.format === FORMAT, "outbox_manifest_invalid");
  return reference(raw.manifest);
}

/** Internal asynchronous archive relay, not a public service or restore installer.
 * The book's atomically retained outcomes are the outbox; the R2 control pointer is
 * the durable contiguous delivery cursor. No duplicate SQL payload queue is needed.
 * A durable scheduler must keep invoking drain, including after idle/restart/failure.
 * This relay never participates in the command acknowledgement path. */
export class OutcomeOutbox {
  constructor(
    private readonly source: Pick<IndexedLedgerOwner, "readArchivePage" | "archiveScope">,
    private readonly store: R2ArchiveObjectStore,
  ) {
    store.assertScope(source.archiveScope, source.archiveScope.objectId);
  }

  async drain(limit = 8): Promise<{
    readonly disposition: "advanced" | "idle" | "conflict";
    readonly through: bigint;
    readonly pending: bigint;
  }> {
    requireLedger(Number.isInteger(limit) && limit >= 1 && limit <= 16, "archive_cursor_invalid");
    let version = await this.store.readControl();
    let previous = version === null ? null : controlReference(version);
    let latest = previous === null ? null : manifest(await this.store.readImmutable(previous));
    const after = latest === null ? 0n : BigInt(latest.sequence);
    const page = await this.source.readArchivePage(after, latest?.recordHash ?? null, limit);
    requireLedger(
      latest === null || latest.genesisHash === page.genesisHash,
      "archive_cursor_conflict",
    );
    let through = after;
    let changed = false;
    const publish = async (entry: Manifest): Promise<boolean> => {
      const uploaded = await this.store.putImmutable(encoder.encode(JSON.stringify(entry)));
      const result = await this.store.compareAndSwapControl(
        version,
        JSON.stringify({ format: FORMAT, manifest: uploaded }),
      );
      if (result.disposition === "conflict") return false;
      version = result.version;
      previous = uploaded;
      latest = entry;
      through = BigInt(entry.sequence);
      changed = true;
      return true;
    };
    const result = (disposition: "advanced" | "idle" | "conflict") =>
      Object.freeze({
        disposition,
        through,
        pending: BigInt(page.head.sequence) - through,
      });
    if (latest === null) {
      requireLedger(page.genesis !== null, "outbox_genesis_missing");
      const payload = await this.store.putImmutable(encoder.encode(page.genesis));
      if (
        !(await publish({
          format: FORMAT,
          genesisHash: page.genesisHash,
          sequence: "0",
          recordHash: null,
          payload,
          previous: null,
        }))
      )
        return result("conflict");
    }
    for (const outcome of page.outcomes) {
      requireLedger(
        outcome.sequence === through + 1n && previous !== null,
        "archive_cursor_conflict",
      );
      const payload = await this.store.putImmutable(encoder.encode(outcome.encoded));
      if (
        !(await publish({
          format: FORMAT,
          genesisHash: page.genesisHash,
          sequence: outcome.sequence.toString(),
          recordHash: outcome.recordHash,
          payload,
          previous,
        }))
      )
        return result("conflict");
    }
    return result(changed ? "advanced" : "idle");
  }

  /** Bounded archive inspection, NOT accounting recovery or writable admission.
   * Verifies every archived payload and manifest edge; callers must still replay
   * accounting and establish an independently authorized restore head. */
  async inspect(): Promise<{
    readonly genesis: string;
    readonly genesisHash: string;
    readonly outcomes: readonly string[];
    readonly through: bigint;
    readonly recordHash: string | null;
  }> {
    const version = await this.store.readControl();
    requireLedger(version !== null, "outbox_genesis_missing");
    let entry = manifest(await this.store.readImmutable(controlReference(version)));
    const head = entry;
    const outcomes: string[] = [];
    const recordHashes: string[] = [];
    let totalBytes = 0;
    for (;;) {
      const bytes = await this.store.readImmutable(entry.payload);
      totalBytes += bytes.byteLength;
      requireLedger(totalBytes <= 32 * 1024 * 1024, "outbox_inspection_capacity_exceeded");
      if (entry.sequence === "0") {
        requireLedger(BigInt(outcomes.length) === BigInt(head.sequence), "archive_cursor_conflict");
        const genesis = decoder.decode(bytes);
        requireLedger(
          indexedSourceGenesisHash(genesis) === head.genesisHash,
          "archive_cursor_conflict",
        );
        const ordered = outcomes.reverse(),
          hashes = recordHashes.reverse();
        const scope = this.source.archiveScope;
        let { state } = await projectLegacyIndexedBook(genesis);
        let expectedHead = prepareIndexedBookHead(scope, scope.objectId, state, null, null);
        for (const [index, encoded] of ordered.entries()) {
          const record = decodeIndexedOutcomeRecord(
            encoded,
            scope,
            scope.objectId,
            state,
            expectedHead,
          );
          requireLedger(record.contentHash === hashes[index], "archive_cursor_conflict");
          state = decodeIndexedBookState(record.state);
          expectedHead = record.after;
        }
        return Object.freeze({
          genesis,
          genesisHash: head.genesisHash,
          outcomes: Object.freeze(ordered),
          through: BigInt(head.sequence),
          recordHash: head.recordHash,
        });
      }
      outcomes.push(decoder.decode(bytes));
      requireLedger(entry.recordHash !== null, "outbox_manifest_invalid");
      recordHashes.push(entry.recordHash);
      requireLedger(entry.previous !== null, "outbox_manifest_invalid");
      const prior = manifest(await this.store.readImmutable(entry.previous));
      requireLedger(
        BigInt(prior.sequence) + 1n === BigInt(entry.sequence) &&
          prior.genesisHash === head.genesisHash,
        "archive_cursor_conflict",
      );
      entry = prior;
    }
  }
}

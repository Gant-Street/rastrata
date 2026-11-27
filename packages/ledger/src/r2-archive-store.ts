import { createHash, randomUUID } from "node:crypto";
import { hashCanonical } from "@rastrata/kernel";
import { completeScope, COMPACT_FORMAT_IDENTITY } from "./compact-records.ts";
import { LEDGER_LIMITS, LedgerError, requireLedger, type CompleteBookScope } from "./records.ts";

interface R2Metadata {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
}
/** The actual Workers binding API, kept independent of Worker ambient globals. */
export interface ArchiveR2Bucket {
  get(key: string): Promise<(R2Metadata & { readonly body: ReadableStream<Uint8Array> }) | null>;
  put(
    key: string,
    value: Uint8Array,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: string } | { readonly etagMatches: string };
      readonly sha256: string;
    },
  ): Promise<R2Metadata | null>;
}
export interface ArchivePayloadReference {
  readonly objectKey: string;
  readonly payloadHash: string;
  readonly payloadBytes: number;
}
export interface ArchiveControlVersion {
  /** Exact opaque manifest/anchor bytes as UTF-8 text; not semantic verification. */
  readonly body: string;
  readonly storageRevision: string;
  readonly nonce: string;
}
const VERSION = "rastrata-r2-archive-transport-v1";
const HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Pure locator construction, not evidence of upload, membership or authority. */
export function referenceArchivePayload(
  scope: CompleteBookScope,
  actualObjectId: string,
  input: Uint8Array,
): ArchivePayloadReference {
  const identity = completeScope(scope, actualObjectId);
  requireLedger(
    input instanceof Uint8Array && input.byteLength <= LEDGER_LIMITS.recordBytes,
    "archive_invalid_input",
  );
  const scopeHash = hashCanonical({
    domain: VERSION,
    identity: { ...identity },
    format: COMPACT_FORMAT_IDENTITY,
  }).digest;
  const payloadHash = sha256(input);
  return Object.freeze({
    objectKey: `${VERSION}/${scopeHash}/immutable/${payloadHash}`,
    payloadHash,
    payloadBytes: input.byteLength,
  });
}

function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  requireLedger(input !== null && typeof input === "object", "archive_invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === names.length, "archive_invalid_input");
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = descriptors[name];
    requireLedger(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "archive_invalid_input",
    );
    result[name] = descriptor.value;
  }
  return result;
}
function controlVersion(input: ArchiveControlVersion): ArchiveControlVersion {
  const value = fields(input, ["body", "storageRevision", "nonce"]);
  requireLedger(
    typeof value.body === "string" &&
      typeof value.storageRevision === "string" &&
      value.storageRevision.length > 0 &&
      value.storageRevision.length <= 1024 &&
      typeof value.nonce === "string" &&
      NONCE.test(value.nonce),
    "archive_invalid_input",
  );
  return Object.freeze({
    body: value.body,
    storageRevision: value.storageRevision,
    nonce: value.nonce,
  });
}
function metadata(value: R2Metadata, key: string, size?: number): void {
  requireLedger(
    value.key === key &&
      typeof value.etag === "string" &&
      value.etag.length > 0 &&
      Number.isSafeInteger(value.size) &&
      value.size >= 0 &&
      value.size <= LEDGER_LIMITS.recordBytes &&
      (size === undefined || value.size === size),
    "archive_object_metadata_mismatch",
  );
}
async function boundedBody(
  object: R2Metadata & { body: ReadableStream<Uint8Array> },
  key: string,
  size?: number,
): Promise<Uint8Array> {
  // Never call arrayBuffer()/text() before checking the declared size; also bound
  // streamed bytes independently so dishonest metadata cannot exceed the cap.
  try {
    metadata(object, key, size);
  } catch (error) {
    try {
      await object.body.cancel();
    } catch {
      /* Preserve the metadata failure. */
    }
    throw error;
  }
  const output = new Uint8Array(object.size);
  const reader = object.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      requireLedger(
        chunk.value instanceof Uint8Array && chunk.value.length <= output.length - offset,
        "archive_object_size_mismatch",
      );
      output.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    requireLedger(offset === output.length, "archive_object_size_mismatch");
    return output;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      /* Preserve the original read/integrity failure. */
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Transport implementation only. The archive owner must separately authenticate
 * manifests, full heads, selected candidates and fences and reconcile SQLite.
 * No payload PUT, control read or CAS alone acknowledges a ledger command.
 * No deletion, listing, cache, retention policy or deployment binding is exposed.
 */
export class R2ArchiveObjectStore {
  readonly #bucket: ArchiveR2Bucket;
  readonly #scopeHash: string;
  readonly #prefix: string;
  readonly #controlKey: string;
  constructor(bucket: ArchiveR2Bucket, scope: CompleteBookScope, actualObjectId: string) {
    const identity = completeScope(scope, actualObjectId);
    this.#scopeHash = hashCanonical({
      domain: VERSION,
      identity: { ...identity },
      format: COMPACT_FORMAT_IDENTITY,
    }).digest;
    this.#prefix = `${VERSION}/${this.#scopeHash}`;
    this.#controlKey = `${this.#prefix}/control/anchor`;
    this.#bucket = bucket;
  }
  #reference(input: ArchivePayloadReference): ArchivePayloadReference {
    const value = fields(input, ["objectKey", "payloadHash", "payloadBytes"]);
    requireLedger(
      typeof value.payloadHash === "string" &&
        HEX.test(value.payloadHash) &&
        value.objectKey === `${this.#prefix}/immutable/${value.payloadHash}` &&
        typeof value.payloadBytes === "number" &&
        Number.isSafeInteger(value.payloadBytes) &&
        value.payloadBytes >= 0 &&
        value.payloadBytes <= LEDGER_LIMITS.recordBytes,
      "archive_invalid_reference",
    );
    return Object.freeze({
      objectKey: value.objectKey,
      payloadHash: value.payloadHash,
      payloadBytes: value.payloadBytes,
    });
  }
  async readImmutable(input: ArchivePayloadReference): Promise<Uint8Array> {
    const reference = this.#reference(input);
    const object = await this.#bucket.get(reference.objectKey);
    requireLedger(object !== null, "archive_payload_missing");
    const bytes = await boundedBody(object, reference.objectKey, reference.payloadBytes);
    requireLedger(sha256(bytes) === reference.payloadHash, "archive_payload_hash_mismatch");
    return bytes;
  }
  /** Validate an owner's complete identity before any archive I/O. */
  assertScope(scope: CompleteBookScope, actualObjectId: string): void {
    const expected = referenceArchivePayload(scope, actualObjectId, new Uint8Array());
    requireLedger(
      expected.objectKey === `${this.#prefix}/immutable/${expected.payloadHash}`,
      "archive_identity_mismatch",
    );
  }
  async putImmutable(input: Uint8Array): Promise<ArchivePayloadReference> {
    requireLedger(
      input instanceof Uint8Array && input.byteLength <= LEDGER_LIMITS.recordBytes,
      "archive_invalid_input",
    );
    const bytes = new Uint8Array(input); // Snapshot before the first await.
    const payloadHash = sha256(bytes);
    const reference = Object.freeze({
      objectKey: `${this.#prefix}/immutable/${payloadHash}`,
      payloadHash,
      payloadBytes: bytes.byteLength,
    });
    let result: R2Metadata | null;
    try {
      result = await this.#bucket.put(reference.objectKey, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: payloadHash,
      });
    } catch {
      // The PUT may have succeeded. Retry identical bytes; never overwrite or
      // interpret this as an accounting rejection or proof that an object is absent.
      throw new LedgerError("archive_write_uncertain");
    }
    if (result !== null) metadata(result, reference.objectKey, reference.payloadBytes);
    await this.readImmutable(reference); // Includes create-only conflict reconciliation.
    return reference;
  }
  #controlBytes(body: string, nonce: string): Uint8Array {
    requireLedger(
      typeof body === "string" && body.length <= LEDGER_LIMITS.recordBytes,
      "archive_invalid_input",
    );
    const bytes = encoder.encode(
      JSON.stringify({ version: VERSION, scopeHash: this.#scopeHash, nonce, body }),
    );
    requireLedger(bytes.length <= LEDGER_LIMITS.recordBytes, "archive_invalid_input");
    return bytes;
  }
  async readControl(): Promise<ArchiveControlVersion | null> {
    const object = await this.#bucket.get(this.#controlKey);
    if (object === null) return null; // Observation only, never abandonment authority.
    const bytes = await boundedBody(object, this.#controlKey);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new LedgerError("archive_control_corrupt");
    }
    const value = fields(parsed, ["version", "scopeHash", "nonce", "body"]);
    requireLedger(
      value.version === VERSION &&
        value.scopeHash === this.#scopeHash &&
        typeof value.body === "string" &&
        typeof value.nonce === "string" &&
        NONCE.test(value.nonce),
      "archive_control_corrupt",
    );
    requireLedger(
      sha256(bytes) === sha256(this.#controlBytes(value.body, value.nonce)),
      "archive_control_corrupt",
    );
    return Object.freeze({ body: value.body, nonce: value.nonce, storageRevision: object.etag });
  }
  async compareAndSwapControl(
    expectedInput: ArchiveControlVersion | null,
    body: string,
  ): Promise<
    | { readonly disposition: "written"; readonly version: ArchiveControlVersion }
    | { readonly disposition: "conflict" }
  > {
    const expected = expectedInput === null ? null : controlVersion(expectedInput);
    // The nonce is storage-only, outside canonical accounting hashes. Even A→B→A
    // or a same-body write gets a new ETag, preventing adapter-mediated ABA.
    const nonce = randomUUID();
    const bytes = this.#controlBytes(body, nonce);
    if (expected !== null) {
      this.#controlBytes(expected.body, expected.nonce);
      const current = await this.readControl();
      if (
        current === null ||
        current.storageRevision !== expected.storageRevision ||
        current.nonce !== expected.nonce ||
        current.body !== expected.body
      )
        return Object.freeze({ disposition: "conflict" });
    }
    let result: R2Metadata | null;
    try {
      result = await this.#bucket.put(this.#controlKey, bytes, {
        onlyIf:
          expected === null ? { etagDoesNotMatch: "*" } : { etagMatches: expected.storageRevision },
        sha256: sha256(bytes),
      });
    } catch {
      throw new LedgerError("archive_write_uncertain");
    }
    if (result === null) return Object.freeze({ disposition: "conflict" });
    metadata(result, this.#controlKey, bytes.length);
    return Object.freeze({
      disposition: "written",
      version: Object.freeze({ body, nonce, storageRevision: result.etag }),
    });
  }
}

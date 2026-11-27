import { createHash } from "node:crypto";
import { hashCanonical } from "@rastrata/kernel";
import { GENESIS_HASH } from "./tier.ts";

/** One entry of a book's log: a header that says whose it is, where it sits in the chain and what
 * it carries, and a gzip-compressed payload (row changes, or for a `snapshot-published` entry the
 * snapshot's manifest). The entry hash covers every header field, including the digest of the
 * payload, so the chain commits to all of it. Compression is not part of the identity: the same
 * header and payload hash the same however they were compressed. */

export const ENTRY_MAGIC = "RLG1";
export const ENTRY_VERSION = 1;
export const MAX_HEADER_BYTES = 4096;

export type EntryKind = "genesis" | "commit" | "snapshot-published";

export interface EntryHeader {
  readonly v: typeof ENTRY_VERSION;
  readonly bookId: string;
  readonly seq: number;
  /** Hash of entry seq-1, or the genesis marker for the first entry. */
  readonly prev: string;
  /** Hash of this entry. */
  readonly hash: string;
  readonly writer: string;
  readonly fence: number;
  /** The schema version of the code that wrote it: a pod running an older one refuses the entry. */
  readonly schema: number;
  readonly kind: EntryKind;
  /** The application's operation identity, when the entry came from one request. */
  readonly opId: string | null;
  readonly at: string;
  /** SHA-256 of the uncompressed payload. */
  readonly payloadHash: string;
  readonly payloadBytes: number;
  /** How many changes (or, for other kinds, items) the payload holds. */
  readonly changes: number;
}

export interface EntryFields {
  readonly bookId: string;
  readonly seq: number;
  readonly prev: string;
  readonly writer: string;
  readonly fence: number;
  readonly schema: number;
  readonly kind: EntryKind;
  readonly opId: string | null;
  readonly at: string;
  readonly payloadHash: string;
  readonly payloadBytes: number;
  readonly changes: number;
}

export type EntryErrorCode =
  | "framing"
  | "header"
  | "hash"
  | "payload"
  | "chain"
  | "book"
  | "sequence"
  | "schema";

export class EntryError extends Error {
  readonly code: EntryErrorCode;
  constructor(code: EntryErrorCode, message: string) {
    super(message);
    this.name = "EntryError";
    this.code = code;
  }
}

export const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export function entryHash(fields: EntryFields): string {
  return hashCanonical({
    domain: "rastrata-booklog-entry-v1",
    bookId: fields.bookId,
    seq: BigInt(fields.seq),
    prev: fields.prev,
    writer: fields.writer,
    fence: BigInt(fields.fence),
    schema: BigInt(fields.schema),
    kind: fields.kind,
    opId: fields.opId,
    at: fields.at,
    payloadHash: fields.payloadHash,
    payloadBytes: BigInt(fields.payloadBytes),
    changes: BigInt(fields.changes),
  }).digest;
}

export interface BuiltEntry {
  readonly header: EntryHeader;
  readonly bytes: Uint8Array;
}

export function buildEntry(input: {
  readonly bookId: string;
  readonly seq: number;
  readonly prev: string;
  readonly writer: string;
  readonly fence: number;
  readonly schema: number;
  readonly kind: EntryKind;
  readonly opId?: string | null;
  readonly at: string;
  readonly payload: Uint8Array;
  readonly changes: number;
}): BuiltEntry {
  const fields: EntryFields = {
    bookId: input.bookId,
    seq: input.seq,
    prev: input.prev,
    writer: input.writer,
    fence: input.fence,
    schema: input.schema,
    kind: input.kind,
    opId: input.opId ?? null,
    at: input.at,
    payloadHash: sha256(input.payload),
    payloadBytes: input.payload.byteLength,
    changes: input.changes,
  };
  const header: EntryHeader = { v: ENTRY_VERSION, ...fields, hash: entryHash(fields) };
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.byteLength > MAX_HEADER_BYTES)
    throw new EntryError("header", "The entry header is too large");
  const body = Bun.gzipSync(input.payload as Uint8Array<ArrayBuffer>);
  const bytes = new Uint8Array(4 + 4 + json.byteLength + body.byteLength);
  bytes.set(new TextEncoder().encode(ENTRY_MAGIC), 0);
  new DataView(bytes.buffer).setUint32(4, json.byteLength);
  bytes.set(json, 8);
  bytes.set(body, 8 + json.byteLength);
  return { header, bytes };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse the framing and the header and check that the header's own hash is the hash of its
 * fields. Does not decompress and does not look at neighbors. */
export function parseEntry(bytes: Uint8Array): { header: EntryHeader; compressed: Uint8Array } {
  if (bytes.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== ENTRY_MAGIC)
    throw new EntryError("framing", "Not a log entry");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (length === 0 || length > MAX_HEADER_BYTES || 8 + length > bytes.byteLength)
    throw new EntryError("framing", "The entry header length is wrong");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  } catch {
    throw new EntryError("header", "The entry header is not valid JSON");
  }
  const header = raw as Partial<EntryHeader> | null;
  if (
    !header ||
    header.v !== ENTRY_VERSION ||
    typeof header.bookId !== "string" ||
    !Number.isSafeInteger(header.seq) ||
    (header.seq as number) < 1 ||
    typeof header.prev !== "string" ||
    !HEX64.test(header.prev) ||
    typeof header.hash !== "string" ||
    !HEX64.test(header.hash) ||
    typeof header.writer !== "string" ||
    !Number.isSafeInteger(header.fence) ||
    !Number.isSafeInteger(header.schema) ||
    (header.kind !== "genesis" &&
      header.kind !== "commit" &&
      header.kind !== "snapshot-published") ||
    (header.opId !== null && typeof header.opId !== "string") ||
    typeof header.at !== "string" ||
    typeof header.payloadHash !== "string" ||
    !HEX64.test(header.payloadHash) ||
    !Number.isSafeInteger(header.payloadBytes) ||
    !Number.isSafeInteger(header.changes)
  )
    throw new EntryError("header", "The entry header is malformed");
  const full = header as EntryHeader;
  if (entryHash(full) !== full.hash)
    throw new EntryError("hash", `Entry ${full.seq} does not match its hash`);
  return { header: full, compressed: bytes.subarray(8 + length) };
}

/** The uncompressed payload, checked against the digest in the header. */
export function payloadOf(bytes: Uint8Array): Uint8Array {
  const { header, compressed } = parseEntry(bytes);
  let payload: Uint8Array;
  try {
    payload = Bun.gunzipSync(compressed as Uint8Array<ArrayBuffer>);
  } catch {
    throw new EntryError("payload", `Entry ${header.seq}'s payload cannot be decompressed`);
  }
  if (payload.byteLength !== header.payloadBytes || sha256(payload) !== header.payloadHash)
    throw new EntryError("payload", `Entry ${header.seq}'s payload does not match its digest`);
  return payload;
}

/** Check that `header` is the entry that follows `previous` (or the first entry) in book `bookId`. */
export function checkLink(
  previous: { readonly seq: number; readonly hash: string } | null,
  header: EntryHeader,
  bookId: string,
): void {
  if (header.bookId !== bookId)
    throw new EntryError("book", `Entry ${header.seq} belongs to ${header.bookId}, not ${bookId}`);
  const expectedSeq = previous ? previous.seq + 1 : 1;
  if (header.seq !== expectedSeq)
    throw new EntryError("sequence", `Expected entry ${expectedSeq}, found ${header.seq}`);
  const expectedPrev = previous ? previous.hash : GENESIS_HASH;
  if (header.prev !== expectedPrev)
    throw new EntryError("chain", `Entry ${header.seq} is not chained to entry ${header.seq - 1}`);
}

/** Refuse an entry written by code newer than this process. */
export function checkSchema(header: EntryHeader, supported: number): void {
  if (header.schema > supported)
    throw new EntryError(
      "schema",
      `Entry ${header.seq} was written at schema ${header.schema}; this process supports ${supported}`,
    );
}

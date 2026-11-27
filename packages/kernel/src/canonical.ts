import { createHash } from "node:crypto";
export const CANONICALIZATION_VERSION = "rastrata-canonical-v1" as const;
export const CONTENT_HASH_ALGORITHM = "sha256" as const;
declare const identifierBrand: unique symbol;

export type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]: Kind;
};

export class IdentityError extends Error {
  readonly code = "canonical_identity_conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export function identifier<Kind extends string>(value: string): Identifier<Kind> {
  if (value.length === 0 || value.trim() !== value) {
    throw new IdentityError("Identifier must be nonempty and have no boundary whitespace");
  }
  if (!value.isWellFormed()) {
    throw new IdentityError("Identifier must be well-formed Unicode");
  }
  if (value !== value.normalize("NFC")) {
    throw new IdentityError("Identifier must use Unicode NFC normalization");
  }
  if (/\p{Cc}/u.test(value)) {
    throw new IdentityError("Identifier must not contain control characters");
  }
  return value as Identifier<Kind>;
}

export type CanonicalValue =
  | null
  | boolean
  | string
  | bigint
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export interface ContentHash {
  readonly algorithm: typeof CONTENT_HASH_ALGORITHM;
  readonly canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  readonly digest: string;
}

export function contentHashEquals(left: ContentHash, right: ContentHash): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.canonicalizationVersion === right.canonicalizationVersion &&
    left.digest === right.digest
  );
}

const textEncoder = new TextEncoder();

interface CanonicalWriter {
  writeAscii(value: string): void;
  writeBytes(value: Uint8Array): void;
}

class ByteWriter {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  constructor() {
    // Explicit for stable coverage and to make initialization part of the audited surface.
  }

  writeAscii(value: string): void {
    this.writeBytes(textEncoder.encode(value));
  }

  writeBytes(value: Uint8Array): void {
    this.#chunks.push(value);
    this.#length += value.byteLength;
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

/** Same byte language as ByteWriter, but hashing need not retain a complete
 * encoded copy or one allocation per structural token. Only structural tokens,
 * decimal integer text and lengths reach writeAscii; user text uses UTF-8 bytes.
 * This bounds the sink buffer, not input size or recursive traversal resources. */
class HashWriter implements CanonicalWriter {
  readonly #buffer = new Uint8Array(4_096);
  readonly #hasher = createHash(CONTENT_HASH_ALGORITHM);
  #used = 0;

  constructor() {
    // Keep initialization explicit in the measured production function surface.
  }

  writeAscii(value: string): void {
    for (let index = 0; index < value.length; index++) {
      if (this.#used === this.#buffer.length) this.flush();
      this.#buffer[this.#used++] = value.charCodeAt(index);
    }
  }

  writeBytes(value: Uint8Array): void {
    this.flush();
    this.#hasher.update(value);
  }

  private flush(): void {
    this.#hasher.update(this.#buffer.subarray(0, this.#used));
    this.#used = 0;
  }

  finish(): string {
    this.flush();
    return this.#hasher.digest("hex");
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) {
      throw new TypeError("Canonical key comparison exceeded a byte sequence");
    }
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return left.byteLength - right.byteLength;
}

function compareCanonicalEntries(
  left: { readonly keyBytes: Uint8Array },
  right: { readonly keyBytes: Uint8Array },
): number {
  return compareBytes(left.keyBytes, right.keyBytes);
}

function writeLength(writer: CanonicalWriter, length: number): void {
  writer.writeAscii(`${length}:`);
}

function writeValue(writer: CanonicalWriter, value: CanonicalValue): void {
  if (value === null) {
    writer.writeAscii("n");
    return;
  }

  if (typeof value === "boolean") {
    writer.writeAscii(value ? "t" : "f");
    return;
  }

  if (typeof value === "bigint") {
    writer.writeAscii(`i${value};`);
    return;
  }

  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw new TypeError("Canonical strings must be well-formed Unicode");
    }
    const bytes = textEncoder.encode(value);
    writer.writeAscii("s");
    writeLength(writer, bytes.byteLength);
    writer.writeBytes(bytes);
    return;
  }

  if (value instanceof Uint8Array) {
    writer.writeAscii("x");
    writeLength(writer, value.byteLength);
    writer.writeBytes(value);
    return;
  }

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const expectedKeyCount = value.length + 1;
    let hasOnlyDenseIndexes = keys.length === expectedKeyCount;
    for (const key of keys) {
      if (
        key !== "length" &&
        (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= value.length || String(Number(key)) !== key)
      ) hasOnlyDenseIndexes = false;
    }
    if (!hasOnlyDenseIndexes) {
      throw new TypeError("Canonical arrays must be dense and have no extra properties");
    }

    // Do not invoke indexed accessors or a caller-defined inherited iterator.
    const members: CanonicalValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Canonical arrays require enumerable data properties");
      }
      members.push(descriptor.value as CanonicalValue);
    }

    writer.writeAscii("a");
    writeLength(writer, value.length);
    for (const member of members) {
      writeValue(writer, member);
    }
    return;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical objects must be plain records");
    }

    const ownKeys = Reflect.ownKeys(value);
    const entries: { readonly key: string; readonly keyBytes: Uint8Array; readonly member: CanonicalValue }[] = [];
    for (const propertyKey of ownKeys) {
      if (typeof propertyKey !== "string") {
        throw new TypeError("Canonical records must not contain symbol properties");
      }
      const key = propertyKey;
      if (!key.isWellFormed()) {
        throw new TypeError("Canonical record keys must be well-formed Unicode");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Canonical records require enumerable data properties");
      }
      entries.push({
        key,
        keyBytes: textEncoder.encode(key),
        member: descriptor.value as CanonicalValue,
      });
    }
    entries.sort(compareCanonicalEntries);

    writer.writeAscii("o");
    writeLength(writer, entries.length);
    for (const entry of entries) {
      // The UTF-8 key bytes already determined sorting; emit those exact bytes.
      writer.writeAscii("s");
      writeLength(writer, entry.keyBytes.length);
      writer.writeBytes(entry.keyBytes);
      writeValue(writer, entry.member);
    }
    return;
  }

  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

export function canonicalEncode(value: CanonicalValue): Uint8Array {
  const writer = new ByteWriter();
  writeValue(writer, value);
  return writer.finish();
}

export function hashCanonical(value: CanonicalValue): ContentHash {
  const writer = new HashWriter();
  writeValue(writer, value);
  return Object.freeze({
    algorithm: CONTENT_HASH_ALGORITHM,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    digest: writer.finish(),
  });
}

/** Hash one array field incrementally in the existing canonical byte language.
 * The record is validated before consuming the trusted iterator. Exactly the
 * declared population must arrive; truncation/extra elements never yield a hash.
 * This is for internal snapshot readers, not a new input encoding or permission
 * for external commands to supply arbitrary streaming values. */
export function hashCanonicalSequenceField(
  fields: { readonly [key: string]: CanonicalValue },
  field: string,
  length: bigint,
  values: Iterable<CanonicalValue>,
): ContentHash {
  if (typeof length !== "bigint" || typeof field !== "string" || !field.isWellFormed() || Array.isArray(fields) ||
    length < 0n || length > BigInt(Number.MAX_SAFE_INTEGER) || Object.hasOwn(fields, field))
    throw new TypeError("Invalid canonical sequence field");
  // Reuse ordinary record validation, including rejection of getters/symbols.
  canonicalEncode(fields);
  const keys = [...Object.keys(fields), field]
    .map((key) => ({ key, keyBytes: textEncoder.encode(key) }))
    .sort(compareCanonicalEntries);
  const writer = new HashWriter();
  writer.writeAscii(`o${keys.length}:`);
  for (const entry of keys) {
    writeValue(writer, entry.key);
    if (entry.key !== field) {
      writeValue(writer, fields[entry.key]!);
      continue;
    }
    writer.writeAscii(`a${length}:`);
    let seen = 0n;
    for (const value of values) {
      if (seen >= length) throw new TypeError("Canonical sequence exceeds its declared population");
      writeValue(writer, value);
      seen++;
    }
    if (seen !== length) throw new TypeError("Canonical sequence is incomplete");
  }
  return Object.freeze({ algorithm: CONTENT_HASH_ALGORITHM,
    canonicalizationVersion: CANONICALIZATION_VERSION, digest: writer.finish() });
}

/** Deterministic UTF-16 code-unit ordering; never consults locale or ICU data. */
export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

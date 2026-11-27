/** Hashing for the ingestion pipeline. SHA-256 comes from `node:crypto`, the same primitive the
 * kernel's canonical hashing uses, so it is available wherever the kernel runs. */
import { createHash } from "node:crypto";

/** SHA-256 of bytes or of a string's UTF-8 encoding, as lower-case hex. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** JSON with object keys sorted, so equal values always give equal text. Handles null, booleans,
 * finite numbers, strings, arrays and plain objects; `undefined` members are left out. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`).join(",")}}`;
  }
  throw new TypeError(`Cannot hash a ${typeof value}`);
}

/** A short, stable identifier derived from parts: lower-case hex of SHA-256 over a length-prefixed
 * encoding, so ("ab", "c") and ("a", "bc") never collide. */
export function deriveId(prefix: string, parts: readonly string[], length = 20): string {
  const text = parts.map((part) => `${part.length}:${part}`).join("|");
  return `${prefix}${sha256Hex(text).slice(0, length)}`;
}

/** A UUID (version 4 layout) derived from parts. Deterministic, so a retried posting reuses the
 * identity it first had and never creates a second operation. */
export function deriveUuid(parts: readonly string[]): string {
  const hex = sha256Hex(parts.map((part) => `${part.length}:${part}`).join("|"));
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

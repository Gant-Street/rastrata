import { Buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { requireLedger } from "./records.ts";

/** Physical SQLite encoding only. Hashes, exports and receipts use the original
 * canonical UTF-8 bytes. Existing plain JSON rows remain readable in place. */
const PREFIX = "rastrata-deflate-v1:";
export const MAX_NATIVE_OUTCOME_BYTES = 1_048_576;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeStoredNativeOutcome(canonical: string): string {
  const bytes = utf8.encode(canonical);
  requireLedger(bytes.length <= MAX_NATIVE_OUTCOME_BYTES, "native_ledger_outcome_corrupt");
  if (bytes.length < 1024) return canonical;
  // Level 6 keeps the existing format and reduces SQLite page amplification:
  // typical receipts fit two per page instead of one. Canonical bytes are unchanged.
  const compressed = PREFIX + Buffer.from(deflateRawSync(bytes, { level: 6 })).toString("base64");
  // Avoid paying the read/decode overhead for negligible space savings.
  return compressed.length <= bytes.length * 0.875 ? compressed : canonical;
}

export function decodeStoredNativeOutcome(stored: unknown): string {
  requireLedger(
    typeof stored === "string" &&
      stored.length <= MAX_NATIVE_OUTCOME_BYTES &&
      utf8.encode(stored).length <= MAX_NATIVE_OUTCOME_BYTES,
    "native_ledger_outcome_corrupt",
  );
  if (stored.startsWith("{")) return stored;
  requireLedger(stored.startsWith(PREFIX), "native_ledger_outcome_corrupt");
  const base64 = stored.slice(PREFIX.length);
  const bytes = Buffer.from(base64, "base64");
  requireLedger(
    bytes.length > 0 && bytes.toString("base64") === base64,
    "native_ledger_outcome_corrupt",
  );
  try {
    return decoder.decode(inflateRawSync(bytes, { maxOutputLength: MAX_NATIVE_OUTCOME_BYTES }));
  } catch {
    throw new Error("native_ledger_outcome_corrupt");
  }
}

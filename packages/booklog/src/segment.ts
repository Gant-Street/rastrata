import { EntryError, checkLink, parseEntry, type EntryHeader } from "./entry.ts";

/** A sealed segment: consecutive entries of one book, concatenated in one immutable object,
 * `sealed/<from>-<to>`. The bytes are the entries' own bytes, each framed by its length, so a
 * segment adds nothing the entries do not already vouch for: the hash chain is the integrity check. */
export const SEGMENT_MAGIC = "RSG1";

export function encodeSegment(entries: readonly Uint8Array[]): Uint8Array {
  let size = 8;
  for (const entry of entries) size += 4 + entry.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(SEGMENT_MAGIC), 0);
  view.setUint32(4, entries.length);
  let at = 8;
  for (const entry of entries) {
    view.setUint32(at, entry.byteLength);
    out.set(entry, at + 4);
    at += 4 + entry.byteLength;
  }
  return out;
}

/** The entries of a segment, as views into `bytes`. */
export function decodeSegment(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== SEGMENT_MAGIC)
    throw new EntryError("framing", "Not a sealed segment");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4);
  const entries: Uint8Array[] = [];
  let at = 8;
  for (let index = 0; index < count; index += 1) {
    if (at + 4 > bytes.byteLength) throw new EntryError("framing", "The segment is cut short");
    const length = view.getUint32(at);
    if (at + 4 + length > bytes.byteLength)
      throw new EntryError("framing", "The segment is cut short");
    entries.push(bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  if (at !== bytes.byteLength) throw new EntryError("framing", "The segment has trailing bytes");
  return entries;
}

export interface VerifiedSegment {
  readonly headers: readonly EntryHeader[];
  readonly entries: readonly Uint8Array[];
  readonly first: number;
  readonly last: number;
  readonly lastHash: string;
}

/** Parse every entry, check each header's hash, and check that they chain from `previous` (the
 * entry before the segment, or null if the segment starts the book). Throws on the first problem. */
export function verifySegment(
  bytes: Uint8Array,
  bookId: string,
  previous: { readonly seq: number; readonly hash: string } | null,
): VerifiedSegment {
  const entries = decodeSegment(bytes);
  if (entries.length === 0) throw new EntryError("framing", "The segment holds no entries");
  const headers: EntryHeader[] = [];
  let before = previous;
  for (const entry of entries) {
    const { header } = parseEntry(entry);
    checkLink(before, header, bookId);
    headers.push(header);
    before = { seq: header.seq, hash: header.hash };
  }
  const last = headers[headers.length - 1] as EntryHeader;
  return {
    headers,
    entries,
    first: (headers[0] as EntryHeader).seq,
    last: last.seq,
    lastHash: last.hash,
  };
}

/** The same entries, whatever their packaging: the list of hashes. */
export function segmentIdentity(bytes: Uint8Array): string[] {
  return decodeSegment(bytes).map((entry) => parseEntry(entry).header.hash);
}

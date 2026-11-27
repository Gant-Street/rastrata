/** The content-addressed raw store behind `IngestPort.archive`. Every payload a source hands over
 * (a statement file, a page of provider JSON) is kept verbatim under its SHA-256, so entries can be
 * regenerated with better rules later and every figure traces to the bytes the provider sent.
 *
 * A blob is stored in chunks of 512 KiB so the largest payload (16 MiB) never needs a row larger
 * than a hosted database allows. Blobs are immutable: the same bytes always give the same row, the
 * first name and media type seen win, and nothing is ever updated or deleted. A read verifies the
 * hash again, so a damaged row is reported instead of served. */
import { ApplicationError } from "../../errors.ts";
import { sha256Hex } from "../../ingest/hash.ts";
import { hasControlCharacters, sanitizeText } from "../../ingest/text.ts";
import { LIMITS, MAX_RAW_BYTES } from "../../ingest/validate.ts";
import type { RawRef } from "../../ingest-types.ts";
import type { ApplicationStore } from "../../storage.ts";

const CHUNK_BYTES = 512 * 1024;

export function putBlob(
  store: ApplicationStore,
  now: string,
  bytes: Uint8Array,
  mediaType: string,
  name?: string,
): RawRef {
  if (!(bytes instanceof Uint8Array))
    throw new ApplicationError("invalid_input", "Archive expects bytes");
  if (bytes.byteLength > MAX_RAW_BYTES)
    throw new ApplicationError(
      "blob_too_large",
      "A raw payload can be at most 16 MiB; split the file and import the parts.",
      413,
    );
  if (
    typeof mediaType !== "string" ||
    mediaType.length === 0 ||
    mediaType.length > LIMITS.mediaType ||
    hasControlCharacters(mediaType)
  )
    throw new ApplicationError("invalid_input", "Archive needs a media type");
  const label = name === undefined ? undefined : sanitizeText(name, LIMITS.name) || undefined;
  const sha256 = sha256Hex(bytes);
  const existing = store
    .query("SELECT size, media_type, name FROM app_blobs WHERE sha256=?")
    .get(sha256) as { size: number; media_type: string; name: string | null } | null;
  if (existing)
    return {
      sha256,
      size: existing.size,
      mediaType: existing.media_type,
      ...(existing.name ? { name: existing.name } : {}),
    };
  const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  store.transaction(() => {
    // A concurrent writer may have stored the same bytes since the check; the first one wins.
    const inserted = store
      .query(
        "INSERT OR IGNORE INTO app_blobs (sha256, size, media_type, name, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sha256, bytes.byteLength, mediaType, label ?? null, chunks, now);
    if (inserted.changes === 0) return;
    for (let seq = 0; seq < chunks; seq++)
      store
        .query("INSERT INTO app_blob_chunks (sha256, seq, body) VALUES (?, ?, ?)")
        .run(sha256, seq, bytes.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES));
  });
  const stored = store
    .query("SELECT size, media_type, name FROM app_blobs WHERE sha256=?")
    .get(sha256) as { size: number; media_type: string; name: string | null };
  return {
    sha256,
    size: stored.size,
    mediaType: stored.media_type,
    ...(stored.name ? { name: stored.name } : {}),
  };
}

export function blobInfo(store: ApplicationStore, sha256: string): RawRef | null {
  const row = store
    .query("SELECT size, media_type, name FROM app_blobs WHERE sha256=?")
    .get(sha256) as { size: number; media_type: string; name: string | null } | null;
  return row
    ? {
        sha256,
        size: row.size,
        mediaType: row.media_type,
        ...(row.name ? { name: row.name } : {}),
      }
    : null;
}

export function getBlob(
  store: ApplicationStore,
  sha256: string,
): { readonly bytes: Uint8Array; readonly mediaType: string; readonly name?: string } | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const head = store
    .query("SELECT size, media_type, name, chunks FROM app_blobs WHERE sha256=?")
    .get(sha256) as {
    size: number;
    media_type: string;
    name: string | null;
    chunks: number;
  } | null;
  if (!head) return null;
  const rows = store
    .query("SELECT body FROM app_blob_chunks WHERE sha256=? ORDER BY seq")
    .all(sha256) as { body: Uint8Array | ArrayBuffer }[];
  const bytes = new Uint8Array(head.size);
  let offset = 0;
  for (const row of rows) {
    const part = row.body instanceof Uint8Array ? row.body : new Uint8Array(row.body);
    if (offset + part.byteLength > head.size) offset = head.size + 1;
    else bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (rows.length !== head.chunks || offset !== head.size || sha256Hex(bytes) !== sha256)
    throw new ApplicationError(
      "blob_corrupt",
      "A stored raw payload failed its integrity check. Restore the book from a backup.",
      503,
    );
  return { bytes, mediaType: head.media_type, ...(head.name ? { name: head.name } : {}) };
}

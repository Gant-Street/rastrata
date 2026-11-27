import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { sha256 } from "./entry.ts";
import type { BookKeys, ObjectStore } from "./objectstore.ts";
import { ObjectStoreUncertain, MAX_LIST } from "./objectstore.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** A snapshot is the book's SQLite file, compressed, as it stood after entry `seq`: a pod that
 * starts cold downloads the newest one and applies only the entries after it. It is announced by an
 * entry of kind `snapshot-published` whose payload is this manifest, so the hash chain covers its
 * digest: an object in the bucket that no entry names is not a snapshot anyone should trust. */
export interface SnapshotManifest {
  readonly v: 1;
  readonly bookId: string;
  /** The state is the book as of this entry. */
  readonly seq: number;
  /** Hash of entry `seq`. */
  readonly entryHash: string;
  /** SHA-256 of the compressed object. */
  readonly sha256: string;
  readonly bytes: number;
  readonly rawBytes: number;
  readonly schema: number;
  /** A hash of the replicated content, for an independent check; null when it was not computed. */
  readonly stateHash: string | null;
  /** The number of journals in the book, a size hint for metrics and for the memory limiter. */
  readonly journals: number | null;
  readonly writer: string;
  readonly at: string;
}

export class SnapshotRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotRejected";
  }
}

export function parseManifest(bytes: Uint8Array | string): SnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  } catch {
    throw new SnapshotRejected("The snapshot manifest is not JSON");
  }
  const m = raw as Partial<SnapshotManifest> | null;
  if (
    m?.v !== 1 ||
    typeof m.bookId !== "string" ||
    !Number.isSafeInteger(m.seq) ||
    (m.seq as number) < 1 ||
    typeof m.entryHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(m.entryHash) ||
    typeof m.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.bytes) ||
    !Number.isSafeInteger(m.rawBytes) ||
    !Number.isSafeInteger(m.schema)
  )
    throw new SnapshotRejected("The snapshot manifest is malformed");
  return m as SnapshotManifest;
}

/** Databases up to this size are compressed on the calling thread: it takes milliseconds, and it
 * keeps a simulation (which must not wait on anything outside its own clock) deterministic. */
const INLINE_LIMIT = 2 * 2 ** 20;

/** Compress a serialized database; a large one off the event loop. */
export async function compressSnapshot(raw: Uint8Array): Promise<Uint8Array> {
  if (raw.byteLength <= INLINE_LIMIT)
    return Bun.gzipSync(raw as Uint8Array<ArrayBuffer>, { level: 6 });
  const gz = await gzipAsync(raw, { level: 6 });
  return new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength);
}

/** The database as compressed bytes. `serialize` is a consistent copy of the committed state; call
 * it with no transaction open. */
export async function packSnapshot(db: Database): Promise<{ gz: Uint8Array; rawBytes: number }> {
  const raw = db.serialize();
  return { gz: await compressSnapshot(raw), rawBytes: raw.byteLength };
}

/** Decompress a snapshot into a file, atomically (written beside it, then renamed). */
export async function unpackSnapshot(gz: Uint8Array, path: string): Promise<number> {
  const raw =
    gz.byteLength <= INLINE_LIMIT
      ? Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>)
      : await gunzipAsync(gz);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.partial`;
  writeFileSync(temporary, raw);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  renameSync(temporary, path);
  return raw.byteLength;
}

/** The snapshots in the bucket, newest first. */
export async function listSnapshotSeqs(bulk: ObjectStore, keys: BookKeys): Promise<number[]> {
  const found = new Set<number>();
  let after: string | undefined;
  for (;;) {
    const page = await bulk.list(keys.snapPrefix, after, MAX_LIST);
    for (const item of page.objects) {
      const seq = keys.seqOfManifest(item.key);
      if (seq !== null) found.add(seq);
    }
    if (!page.truncated) break;
    after = page.objects[page.objects.length - 1]?.key;
  }
  return [...found].sort((a, b) => b - a);
}

/** Put the snapshot and its manifest in the bucket, create-only. If the compressed object is
 * already there (an earlier attempt, or another process that took the same snapshot), the one there
 * is the one that counts: the manifest returned names its digest, not ours. */
export async function uploadSnapshot(
  bulk: ObjectStore,
  keys: BookKeys,
  manifest: SnapshotManifest,
  gz: Uint8Array,
  options: { readonly attempts?: number } = {},
): Promise<SnapshotManifest> {
  const attempts = options.attempts ?? 4;
  let current = manifest;
  const key = keys.snapshot(manifest.seq);
  let stored = false;
  for (let attempt = 1; attempt <= attempts && !stored; attempt += 1) {
    try {
      const result = await bulk.putIfAbsent(key, gz, {
        metadata: { sha256: manifest.sha256, seq: String(manifest.seq) },
      });
      if (result.created) stored = true;
      else {
        const existing = await bulk.get(key);
        if (existing) {
          const digest = sha256(existing.body);
          if (digest !== manifest.sha256)
            current = { ...manifest, sha256: digest, bytes: existing.body.byteLength };
          stored = true;
        }
      }
    } catch (error) {
      if (!(error instanceof ObjectStoreUncertain)) throw error;
      try {
        const existing = await bulk.get(key);
        if (existing) {
          const digest = sha256(existing.body);
          if (digest !== manifest.sha256)
            current = { ...manifest, sha256: digest, bytes: existing.body.byteLength };
          stored = true;
        }
      } catch {
        // ask again
      }
    }
  }
  if (!stored) throw new ObjectStoreUncertain(`The snapshot ${key} could not be stored`);
  // The manifest object is a convenience (a listing shows what exists); the entry is the authority.
  try {
    await bulk.putIfAbsent(
      keys.manifest(manifest.seq),
      new TextEncoder().encode(JSON.stringify(current)),
    );
  } catch (error) {
    if (!(error instanceof ObjectStoreUncertain)) throw error;
  }
  return current;
}

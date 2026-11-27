import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Blocking file helpers. They are used where blocking is the point: inside worker threads, in the
 * offline tools, and for a few small files. Nothing on the service's request path calls the large
 * ones. */

const CHUNK = 1 << 20;

/** A directory only its owner can read: backups and exports hold the whole business. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Make the rename of a file durable. Not every platform can fsync a directory; where it cannot,
 * the file itself has still been synced. */
export function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    // Best effort.
  }
}

const unique = () => randomBytes(6).toString("hex");

/** Write a small file so that a reader sees all of it or none of it: a temporary file in the same
 * directory, synced, then renamed over the target. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  const temporary = `${path}.partial-${unique()}`;
  const handle = openSync(temporary, "wx", mode);
  try {
    writeSync(handle, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(handle);
  } catch (error) {
    closeSync(handle);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(handle);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDirectory(dirname(path));
}

export type FileProgress = (done: number, total: number) => void;

/** SHA-256 and size of a file, read in chunks. */
export function hashFile(path: string, progress?: FileProgress): { bytes: number; sha256: string } {
  const total = statSync(path).size;
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let done = 0;
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      done += read;
      progress?.(done, total);
    }
  } finally {
    closeSync(handle);
  }
  return { bytes: done, sha256: hash.digest("hex") };
}

/**
 * Copy a file while hashing what is written, sync it, and only then give it its final name, so a
 * copy that is cut short or damaged is never left under the name of a good one. Returns the hash of
 * the bytes written; the caller compares it with what it expected.
 */
export function copyFileDurably(
  from: string,
  to: string,
  progress?: FileProgress,
  mode = 0o600,
): { bytes: number; sha256: string } {
  const total = statSync(from).size;
  const temporary = `${to}.partial-${unique()}`;
  const input = openSync(from, "r");
  const output = openSync(temporary, "wx", mode);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let done = 0;
  try {
    for (;;) {
      const read = readSync(input, buffer, 0, CHUNK, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      let written = 0;
      while (written < read) written += writeSync(output, chunk, written, read - written);
      done += read;
      progress?.(done, total);
    }
    fsyncSync(output);
  } catch (error) {
    closeSync(input);
    closeSync(output);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(input);
  closeSync(output);
  try {
    renameSync(temporary, to);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDirectory(dirname(to));
  return { bytes: done, sha256: hash.digest("hex") };
}

/** Free bytes where `path` is (or would be created), or null when the system cannot say. */
export function freeBytes(path: string): number | null {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const stats = statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** The device a path (or its nearest existing parent) is on. */
export function deviceOf(path: string): number | null {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    return statSync(probe).dev;
  } catch {
    return null;
  }
}

export const sizeLabel = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 * 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;

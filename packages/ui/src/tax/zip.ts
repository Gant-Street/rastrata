/** A zip file made in the browser, so a pack built by the service can be saved as one file. Pure and
 * portable: bytes in, bytes out, no clock and no randomness, so the same files are always the same zip.
 *
 * It writes the simplest kind of archive every program reads: each file stored as it is (no compression),
 * names as UTF-8, a fixed timestamp (1 January 2000, the one the command-line tool uses), one local header
 * and one central directory entry per file, and a CRC-32 for each. A pack is a few hundred kilobytes of text,
 * and a stored archive is the one a person can open on any machine and a test can read back exactly. */

const encoder = new TextEncoder();

/** The CRC-32 table (the polynomial zip and PNG use), built once. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 of some bytes, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** 2000-01-01 00:00:00 in the DOS date and time fields a zip header holds. */
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** General purpose flag bit 11: the names are UTF-8. */
const UTF8 = 0x0800;
const VERSION = 20;

export interface ZipFile {
  /** A relative path with forward slashes, from fixed words: never a name taken from outside. */
  readonly path: string;
  /** The file's text, written as UTF-8. */
  readonly content: string;
}

const hasControlCharacter = (text: string): boolean => {
  for (const character of text) if ((character.codePointAt(0) ?? 0) < 0x20) return true;
  return false;
};

/** A name a zip may carry safely: relative, with no empty, `.` or `..` part, no backslash, no colon and
 * no control character. The service builds every path from fixed words, so this is a second check. */
export function safeName(name: string): boolean {
  if (name === "" || name.startsWith("/") || /[\\:]/.test(name) || hasControlCharacter(name))
    return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The files as one zip archive, each under `folder/`. Throws on a name that is not safe, rather than
 * writing a file somewhere it should not go. */
export function zipFiles(folder: string, files: readonly ZipFile[]): Uint8Array {
  if (!safeName(folder)) throw new Error(`Unsafe folder name ${folder}`);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  for (const file of files) {
    if (!safeName(file.path)) throw new Error(`Unsafe file name ${file.path}`);
    const name = encoder.encode(`${folder}/${file.path}`);
    const data = encoder.encode(file.content);
    const checksum = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, UTF8, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, (3 << 8) | VERSION, true); // made by Unix, version 2.0
    entry.setUint16(6, VERSION, true);
    entry.setUint16(8, UTF8, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, DOS_TIME, true);
    entry.setUint16(14, DOS_DATE, true);
    entry.setUint32(16, checksum, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true);
    entry.setUint16(32, 0, true);
    entry.setUint16(34, 0, true);
    entry.setUint16(36, 0, true);
    entry.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    push(new Uint8Array(local.buffer));
    push(name);
    push(data);
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const piece of central) {
    parts.push(piece);
    centralSize += piece.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  parts.push(new Uint8Array(end.buffer));
  const total = parts.reduce((sum, piece) => sum + piece.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const piece of parts) {
    result.set(piece, at);
    at += piece.length;
  }
  return result;
}

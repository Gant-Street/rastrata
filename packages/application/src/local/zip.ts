import { createReadStream } from "node:fs";
import { crc32, createDeflateRaw } from "node:zlib";

/** A file to put in a zip: the name it has in the archive (a `/`-separated path of plain words) and where its bytes are. */
export interface ZipFile {
  readonly name: string;
  readonly path: string;
  /** Stored as the file's time; now when left out. */
  readonly modified?: Date;
}

// The format is PKWARE's APPNOTE 6.3 without ZIP64: every file and the whole archive are under 4 GiB, which an export of a book is by a wide margin, and a
// larger one is refused and not written wrong. Each file is deflated as it is read and followed by a data descriptor that says its checksum and sizes, so the
// archive is made in one pass over the files and nothing is held: the memory is a chunk, whatever the size of the book.
const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_ARCHIVE = 0x06054b50;
/** Bit 3: the sizes follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0808;
const DEFLATE = 8;
const VERSION_NEEDED = 20;
/** Made on a Unix: so that the permissions below are read as such. */
const VERSION_MADE_BY = (3 << 8) | 20;
/** A regular file, rw-r--r--, in the high half of the external attributes, where a Unix unzip looks. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const LARGEST = 0xffffffff;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** A time as the format keeps it: two 16-bit words, in UTC (the format has no zone), never before 1980. */
function dosTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function record(length: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

async function* archive(files: readonly ZipFile[], level: number): AsyncGenerator<Uint8Array> {
  if (files.length > 0xfffe) throw new Error("A zip without ZIP64 holds at most 65,534 files");
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    if (!NAME.test(file.name)) throw new Error(`Not a name a zip may hold: ${file.name}`);
    const name = encoder.encode(file.name);
    const { time, day } = dosTime(file.modified ?? new Date());
    const start = offset;
    if (start > LARGEST) throw new Error("The archive is larger than a zip without ZIP64 holds");

    const header = record(30 + name.length, (view) => {
      view.setUint32(0, LOCAL_HEADER, true);
      view.setUint16(4, VERSION_NEEDED, true);
      view.setUint16(6, FLAGS, true);
      view.setUint16(8, DEFLATE, true);
      view.setUint16(10, time, true);
      view.setUint16(12, day, true);
      // The checksum and the sizes (offsets 14 to 25) are not known yet: the descriptor after the data says them.
      view.setUint16(26, name.length, true);
    });
    header.set(name, 30);
    yield header;
    offset += header.length;

    let checksum = 0;
    let size = 0;
    let packed = 0;
    const input = createReadStream(file.path);
    const deflate = createDeflateRaw({ level });
    input.on("data", (chunk) => {
      const bytes = chunk as Buffer;
      checksum = crc32(bytes, checksum);
      size += bytes.length;
    });
    // A file that cannot be read stops the archive, with the reason, and is never a short file with a good checksum.
    input.on("error", (error) => deflate.destroy(error));
    input.pipe(deflate);
    for await (const chunk of deflate) {
      const bytes = chunk as Uint8Array;
      packed += bytes.length;
      offset += bytes.length;
      yield bytes;
    }
    if (size > LARGEST || packed > LARGEST)
      throw new Error("A file is larger than a zip without ZIP64 holds");

    const descriptor = record(16, (view) => {
      view.setUint32(0, DATA_DESCRIPTOR, true);
      view.setUint32(4, checksum >>> 0, true);
      view.setUint32(8, packed, true);
      view.setUint32(12, size, true);
    });
    yield descriptor;
    offset += descriptor.length;

    const entry = record(46 + name.length, (view) => {
      view.setUint32(0, CENTRAL_ENTRY, true);
      view.setUint16(4, VERSION_MADE_BY, true);
      view.setUint16(6, VERSION_NEEDED, true);
      view.setUint16(8, FLAGS, true);
      view.setUint16(10, DEFLATE, true);
      view.setUint16(12, time, true);
      view.setUint16(14, day, true);
      view.setUint32(16, checksum >>> 0, true);
      view.setUint32(20, packed, true);
      view.setUint32(24, size, true);
      view.setUint16(28, name.length, true);
      view.setUint32(38, EXTERNAL_ATTRIBUTES, true);
      view.setUint32(42, start, true);
    });
    entry.set(name, 46);
    central.push(entry);
  }

  const directoryStart = offset;
  for (const entry of central) {
    yield entry;
    offset += entry.length;
  }
  if (offset > LARGEST) throw new Error("The archive is larger than a zip without ZIP64 holds");
  yield record(22, (view) => {
    view.setUint32(0, END_OF_ARCHIVE, true);
    view.setUint16(8, central.length, true);
    view.setUint16(10, central.length, true);
    view.setUint32(12, offset - directoryStart, true);
    view.setUint32(16, directoryStart, true);
  });
}

/** The files as one zip, streamed: each is read and deflated as the consumer asks for more, so a slow download does not read ahead and a large book is
 * never in memory. A file that cannot be read fails the stream, which the HTTP layer turns into a broken download and not a quietly short one. */
export function zipStream(
  files: readonly ZipFile[],
  options: { readonly level?: number } = {},
): ReadableStream<Uint8Array> {
  const chunks = archive(files, options.level ?? 6);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

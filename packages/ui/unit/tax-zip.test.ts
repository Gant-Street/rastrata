import { describe, expect, test } from "bun:test";
import { crc32, safeName, zipFiles } from "../src/tax/zip";

// A zip is read back here by a second, independent reader written from the format's own description: the
// end-of-central-directory record, then the central directory, then each local header, checking every
// size, offset, name and checksum. A writer that only agrees with itself would pass its own round trip.
interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly date: number;
  readonly time: number;
  readonly checksum: number;
}

function read(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  expect(start + size).toBe(end);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: Entry[] = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const checksum = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const length = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    // The local header repeats what the central entry says, and the data follows its name.
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint16(offset + 6, true)).toBe(flags);
    expect(view.getUint16(offset + 8, true)).toBe(method);
    expect(view.getUint32(offset + 14, true)).toBe(checksum);
    expect(view.getUint32(offset + 18, true)).toBe(compressed);
    expect(view.getUint32(offset + 22, true)).toBe(length);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    expect(decoder.decode(bytes.subarray(offset + 30, offset + 30 + localName))).toBe(name);
    const dataStart = offset + 30 + localName + localExtra;
    const data = bytes.subarray(dataStart, dataStart + length);
    expect(compressed).toBe(length);
    entries.push({ name, data, flags, method, date, time, checksum });
  }
  expect(at).toBe(end);
  return entries;
}

describe("the checksum", () => {
  test("is the CRC-32 zip and PNG use: the standard check value, the empty string, and agreement with the runtime's own", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    for (const sample of [
      "a",
      "Rastrata books and reports.",
      "naïve café ☕ \u0000 end",
      "x".repeat(10_000),
    ])
      expect(crc32(text(sample))).toBe(Bun.hash.crc32(text(sample)));
    const random = new Uint8Array(4096);
    for (let index = 0; index < random.length; index++) random[index] = (index * 37 + 11) & 0xff;
    expect(crc32(random)).toBe(Bun.hash.crc32(random));
  });
});

describe("a zip of a pack", () => {
  const files = [
    { path: "README.md", content: "# Pack\nCafé, naïve, 日本語, ☕\n" },
    { path: "statements/profit-and-loss.csv", content: "Report,Profit and loss\r\n" },
    { path: "tax/empty.csv", content: "" },
    { path: "tax/ünïcode-name.csv", content: "a,b\r\n" },
  ];

  test("holds every file under the folder, stored as it is, with true sizes, offsets and checksums", () => {
    const entries = read(zipFiles("rastrata-year-end-2026", files));
    expect(entries.map((entry) => entry.name)).toEqual(
      files.map((file) => `rastrata-year-end-2026/${file.path}`),
    );
    entries.forEach((entry, index) => {
      expect(new TextDecoder().decode(entry.data)).toBe(files[index]?.content as string);
      expect(entry.method).toBe(0);
      expect(entry.flags & 0x0800).toBe(0x0800);
      expect(entry.checksum).toBe(Bun.hash.crc32(entry.data));
      // A fixed timestamp: 1 January 2000, 00:00:00.
      expect(entry.date).toBe(((2000 - 1980) << 9) | (1 << 5) | 1);
      expect(entry.time).toBe(0);
    });
  });

  test("is the same bytes every time for the same files, and different bytes for different ones", () => {
    const first = zipFiles("pack", files);
    expect(Buffer.from(zipFiles("pack", files)).equals(Buffer.from(first))).toBe(true);
    expect(Buffer.from(zipFiles("pack", [...files].reverse())).equals(Buffer.from(first))).toBe(
      false,
    );
    expect(Buffer.from(zipFiles("other", files)).equals(Buffer.from(first))).toBe(false);
  });

  test("is a valid empty archive for no files", () => {
    expect(read(zipFiles("pack", []))).toEqual([]);
  });

  test("refuses a name that could write outside the folder rather than writing it", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../x",
      "a/../b",
      "a//b",
      "./a",
      "a\\b",
      "C:/x",
      "a\u0000b",
      "a\nb",
    ])
      expect(() => zipFiles("pack", [{ path, content: "x" }]), path).toThrow();
    for (const folder of ["", "..", "/abs", "a/../b", "a\\b"])
      expect(() => zipFiles(folder, [])).toThrow();
    expect(safeName("tax/schedule-c-worksheet.csv")).toBe(true);
    expect(safeName("statements/trial-balance.csv")).toBe(true);
  });

  test("holds a large pack: many files and a few megabytes of text", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      path: `tax/file-${index}.csv`,
      content: `Row,${index}\r\n`.repeat(2000),
    }));
    const entries = read(zipFiles("big", many));
    expect(entries).toHaveLength(300);
    expect(entries[299]?.data.length).toBe(many[299]?.content.length as number);
  });
});

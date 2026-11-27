import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { zipStream, type ZipFile } from "../src/local/zip.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-zip-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The archive read back by hand, from the end record, so that what the writer says about itself is checked and not trusted. */
function read(zip: Uint8Array): { name: string; data: Uint8Array; crc: number; flags: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  let at = view.getUint32(end + 16, true);
  expect(view.getUint32(end + 12, true)).toBe(end - at);
  const found: { name: string; data: Uint8Array; crc: number; flags: number }[] = [];
  for (let n = 0; n < count; n += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(method).toBe(8);
    // The local header says the same name, and the data follows it, then the descriptor that repeats the sums.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const localName = view.getUint16(local + 26, true);
    const dataStart = local + 30 + localName;
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + packed));
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);
    expect(view.getUint32(dataStart + packed, true)).toBe(0x08074b50);
    expect(view.getUint32(dataStart + packed + 4, true)).toBe(crc);
    expect(view.getUint32(dataStart + packed + 8, true)).toBe(packed);
    expect(view.getUint32(dataStart + packed + 12, true)).toBe(size);
    found.push({ name, data: new Uint8Array(data), crc, flags });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return found;
}

function files(): { directory: string; list: ZipFile[]; expected: Map<string, Uint8Array> } {
  const directory = folder();
  const expected = new Map<string, Uint8Array>();
  const put = (name: string, bytes: Uint8Array) => {
    writeFileSync(join(directory, name), bytes);
    expected.set(`export/${name}`, bytes);
  };
  put("README.md", new TextEncoder().encode("# An export\n\nplain words, and é, 日本語, 🙂\n"));
  put("empty.jsonl", new Uint8Array(0));
  // Compressible, and larger than the stream's chunks.
  put(
    "journals.jsonl",
    new TextEncoder().encode(
      Array.from({ length: 40_000 }, (_, n) => JSON.stringify({ n, memo: "software" })).join("\n"),
    ),
  );
  // Not compressible at all.
  put("random.bin", crypto.getRandomValues(new Uint8Array(300_000)));
  return {
    directory,
    expected,
    list: [...expected.keys()].map((name) => ({
      name,
      path: join(directory, name.slice("export/".length)),
    })),
  };
}

test("a zip is the files, byte for byte, with the checksums and sizes of the format", async () => {
  const { list, expected } = files();
  const zip = await bytesOf(zipStream(list));
  const found = read(zip);
  expect(found.map((entry) => entry.name)).toEqual(list.map((entry) => entry.name));
  for (const entry of found) {
    expect(
      Buffer.from(entry.data).equals(Buffer.from(expected.get(entry.name) as Uint8Array)),
    ).toBe(true);
    // Names are UTF-8 and the sizes follow the data (the two flags the writer sets).
    expect(entry.flags).toBe(0x0808);
  }
  // The compressible one is much smaller than it was; the random one is not smaller at all (it is stored deflated, which a decoder does not mind).
  expect(zip.length).toBeLessThan(
    [...expected.values()].reduce((total, bytes) => total + bytes.length, 0),
  );
});

test("the system's own unzip reads it: the archive tests clean and every file extracts to the same bytes", async () => {
  const unzip = Bun.which("unzip");
  if (!unzip) return;
  const { list, expected } = files();
  const where = folder();
  const archive = join(where, "export.zip");
  writeFileSync(archive, await bytesOf(zipStream(list)));
  const tested = Bun.spawnSync([unzip, "-tq", archive]);
  expect(tested.exitCode, new TextDecoder().decode(tested.stdout)).toBe(0);
  for (const [name, bytes] of expected) {
    const extracted = Bun.spawnSync([unzip, "-p", archive, name]);
    expect(extracted.exitCode).toBe(0);
    expect(Buffer.from(extracted.stdout).equals(Buffer.from(bytes))).toBe(true);
  }
  const listing = new TextDecoder().decode(Bun.spawnSync([unzip, "-Z", "-l", archive]).stdout);
  // Plain files with the permissions of a file one made, in a folder of the export's name.
  expect(listing).toContain("-rw-r--r--");
  expect(listing).toContain("export/journals.jsonl");
});

test("an archive with nothing in it is a valid archive, and a name that is not plain is refused before anything is written", async () => {
  const empty = await bytesOf(zipStream([]));
  expect(empty.length).toBe(22);
  expect(read(empty)).toEqual([]);
  const directory = folder();
  writeFileSync(join(directory, "a.txt"), "a");
  for (const name of ["../a.txt", "/etc/passwd", "a//b", "a/../b", "", "a\\b", ".hidden"])
    await expect(bytesOf(zipStream([{ name, path: join(directory, "a.txt") }]))).rejects.toThrow(
      /Not a name a zip may hold/,
    );
});

test("a file that cannot be read stops the stream with the reason, and is never a short file with a good checksum", async () => {
  const directory = folder();
  writeFileSync(join(directory, "a.txt"), "a");
  await expect(
    bytesOf(
      zipStream([
        { name: "export/a.txt", path: join(directory, "a.txt") },
        { name: "export/b.txt", path: join(directory, "missing.txt") },
      ]),
    ),
  ).rejects.toThrow(/ENOENT/);
});

test("the stream is read as it is asked for: a consumer that stops early stops the work", async () => {
  const { list } = files();
  const reader = zipStream(list).getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect((first.value as Uint8Array).length).toBeGreaterThan(0);
  await reader.cancel();
});

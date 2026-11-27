/**
 * A two-colour PNG of a tile, written by hand: no browser, no compression library, so the same bytes
 * come out on every machine and a test can compare them. The tile is only rectangles, so a one-bit
 * palette image (stored, not compressed) is a few kilobytes.
 */
import { MASTER, type TileTone, TILE, tileRects, wordmarkRects } from "./logo-geometry";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (n: number) =>
  Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat(Uint8Array.from([...type].map((ch) => ch.charCodeAt(0))), data);
  return concat(u32(data.length), body, u32(crc32(body)));
}

/** Stored (uncompressed) deflate blocks inside a zlib wrapper. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let at = 0; at === 0 || at < raw.length; at += 65535) {
    const block = raw.subarray(at, at + 65535);
    const last = at + 65535 >= raw.length ? 1 : 0;
    const length = block.length;
    parts.push(
      Uint8Array.of(last, length & 255, length >>> 8, ~length & 255, (~length >>> 8) & 255),
      block,
    );
  }
  parts.push(u32(adler32(raw)));
  return concat(...parts);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** Boxes (in cells) on a field as a two-colour PNG, `scale` pixels to a cell. Edges are snapped to whole pixels, so they
 * are hard, not blurred. With `clear` the field is transparent (a tRNS chunk), for a mark that sits on any background. */
function boxesPng(
  cells: {
    width: number;
    height: number;
    boxes: readonly (readonly [number, number, number, number])[];
  },
  colors: { field: string; mark: string; clear?: boolean },
  scale: number,
): Uint8Array {
  const width = Math.round(cells.width * scale);
  const height = Math.round(cells.height * scale);
  const spans = cells.boxes.map(([x, y, w, h]) => ({
    x0: Math.round(x * scale),
    y0: Math.round(y * scale),
    x1: Math.round((x + w) * scale),
    y1: Math.round((y + h) * scale),
  }));
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array((rowBytes + 1) * height); // each row: a filter byte (0), then one bit a pixel
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (spans.some((s) => x >= s.x0 && x < s.x1 && y >= s.y0 && y < s.y1)) {
        const at = y * (rowBytes + 1) + 1 + (x >> 3);
        raw[at] = (raw[at] as number) | (0x80 >> (x & 7));
      }
    }
  }
  const header = concat(u32(width), u32(height), Uint8Array.of(1, 3, 0, 0, 0)); // 1 bit, palette, no interlace
  const palette = Uint8Array.from([...rgb(colors.field), ...rgb(colors.mark)]);
  return concat(
    SIGNATURE,
    chunk("IHDR", header),
    chunk("PLTE", palette),
    ...(colors.clear ? [chunk("tRNS", Uint8Array.of(0, 255))] : []),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array()),
  );
}

/** The tile as a square PNG `size` pixels across. */
export function tilePng(tone: TileTone, size: number): Uint8Array {
  const { field, mark, boxes } = tileRects(tone);
  return boxesPng(
    { width: TILE.size, height: TILE.size, boxes },
    { field, mark },
    size / TILE.size,
  );
}

/** The wordmark in black on a transparent field, `scale` pixels to a cell: for mail, where an SVG is not shown. */
export function wordmarkPng(scale: number): Uint8Array {
  const { width, height, boxes } = wordmarkRects();
  return boxesPng(
    { width, height, boxes },
    { field: MASTER.white, mark: MASTER.black, clear: true },
    scale,
  );
}

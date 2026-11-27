import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { brandFiles } from "../src/brand/brand-files";
import {
  CELL,
  layout,
  LOGO,
  type LogoVariant,
  logoSvg,
  MASTER,
  outline,
  TILE,
  TILE_TONES,
  tileSvg,
} from "../src/brand/logo-geometry";
import { tilePng } from "../src/brand/png";

const root = resolve(import.meta.dir, "../../..");

/** The cells a path covers, counted the way an even-odd fill would (outer edges add, holes subtract). */
function areaOf(d: string): number {
  let total = 0;
  for (const sub of d.split("Z").filter(Boolean)) {
    const points: [number, number][] = [];
    for (const [, cmd, n] of sub.matchAll(/([MHV])(-?\d+)/g)) {
      const last = points.at(-1) ?? [0, 0];
      const value = Number(n);
      points.push(
        cmd === "M"
          ? [value, Number(/M-?\d+ (-?\d+)/.exec(sub)?.[1])]
          : cmd === "H"
            ? [value, last[1]]
            : [last[0], value],
      );
    }
    let twice = 0;
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length] as [number, number];
      twice += p[0] * q[1] - q[0] * p[1];
    });
    total += twice / 2;
  }
  return total;
}

describe("the outline of a set of cells", () => {
  test("a rectangle is one rectangle", () => {
    expect(outline([[0, 0, 2, 1]])).toBe("M0 0H2V1H0Z");
  });

  test("boxes that overlap or touch are one outline, with no seam between them", () => {
    expect(
      outline([
        [0, 0, 1, 3],
        [0, 0, 3, 1],
      ]),
    ).toBe("M0 0H3V1H1V3H0Z");
    expect(
      outline([
        [0, 0, 1, 1],
        [1, 0, 1, 1],
      ]),
    ).toBe("M0 0H2V1H0Z");
  });

  test("a hole is its own subpath and runs the other way, so it stays open", () => {
    const ring = outline([
      [0, 0, 3, 1],
      [0, 2, 3, 1],
      [0, 0, 1, 3],
      [2, 0, 1, 3],
    ]);
    expect(ring).toBe("M0 0H3V3H0ZM1 1V2H2V1Z");
    expect(areaOf(ring)).toBe(8);
  });

  test("two cells that meet only at a corner are refused", () => {
    expect(() =>
      outline([
        [0, 0, 1, 1],
        [1, 1, 1, 1],
      ]),
    ).toThrow("only at a corner");
  });
});

describe("the logo is drawn in whole cells", () => {
  test("the word is 80 cells wide and 17 tall, and the stacked name is a block 39 wide", () => {
    expect(LOGO.wordmark).toMatchObject({ width: 80, height: 17, viewBox: "0 -4 80 17" });
    expect(layout("rast").width).toBe(39);
    expect(layout("rata").width).toBe(39);
    expect(LOGO.stacked).toMatchObject({ width: 39, height: 37 });
  });

  test("the plate adds a heavy rule above and a double rule below, three cells from the letters", () => {
    expect(LOGO.plate).toMatchObject({ width: 80, height: 29, viewBox: "0 -10 80 29" });
    expect(areaOf(LOGO.plate.d) - areaOf(LOGO.wordmark.d)).toBe(80 * 3 + 80 + 80);
  });

  test("the corner is the stem and arm of the r, squared up", () => {
    expect(LOGO.mark.d).toBe("M0 0H12V3H3V12H0Z");
    expect(CELL.stroke).toBe(3);
  });

  test("every number in every path is a whole cell", () => {
    for (const shape of Object.values(LOGO)) {
      for (const [n] of shape.d.matchAll(/-?\d+(\.\d+)?/g))
        expect(Number.isInteger(Number(n))).toBe(true);
    }
  });

  test("each letter is one outline, and the a has one hole", () => {
    const paths = (word: string) => (outline(layout(word).boxes).match(/M/g) ?? []).length;
    expect(paths("r")).toBe(1);
    expect(paths("a")).toBe(2);
    expect(paths("s")).toBe(1);
    expect(paths("t")).toBe(1);
    expect(paths("rastrata")).toBe(11);
  });

  test("the outline covers exactly the cells the letters are drawn from", () => {
    const cells = new Set<string>();
    for (const [x, y, w, h] of layout("rastrata").boxes) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.add(`${i},${j}`);
    }
    expect(areaOf(LOGO.wordmark.d)).toBe(cells.size);
  });

  test("a letter the logo does not have is an error, not a gap", () => {
    expect(() => layout("rastratb")).toThrow('no letter "b"');
  });
});

describe("the logo files follow the system's rules", () => {
  test("the three masters are the colors of the design tokens", () => {
    const base = readFileSync(resolve(import.meta.dir, "../src/base.css"), "utf8");
    const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(base)?.[1];
    expect(token("--rt-black")).toBe(MASTER.black);
    expect(token("--rt-white")).toBe(MASTER.white);
    expect(token("--rt-penguin-orange")).toBe(MASTER.orange);
  });

  test("flat: no radius, gradient, filter, blur or opacity, and no color outside the masters", () => {
    const variants: LogoVariant[] = ["wordmark", "plate", "stacked", "mark"];
    const files = [
      ...variants.flatMap((v) => [
        logoSvg(v, MASTER.black),
        logoSvg(v, MASTER.white),
        logoSvg(v, "currentColor", "inline"),
      ]),
      ...(Object.keys(TILE_TONES) as (keyof typeof TILE_TONES)[]).map(tileSvg),
    ];
    for (const svg of files) {
      expect(svg).not.toMatch(/\brx=|\bry=|gradient|filter|blur|opacity|stroke/i);
      for (const [, color] of svg.matchAll(/fill="([^"]+)"/g)) {
        expect([MASTER.black, MASTER.white, MASTER.orange, "currentColor"]).toContain(
          color as string,
        );
      }
    }
  });

  test("a standalone file names itself, and an inline copy leaves the naming to its link", () => {
    expect(logoSvg("wordmark", MASTER.black)).toContain('role="img" aria-label="Rastrata"');
    expect(logoSvg("wordmark", "currentColor", "inline")).toContain('aria-hidden="true"');
    expect(logoSvg("wordmark", "currentColor", "inline")).not.toContain("<title>");
  });

  test("the tile is sixteen cells, so a cell is a whole pixel at 16, 32, 48 and 64", () => {
    expect(TILE.size).toBe(16);
    expect(tileSvg("orange")).toContain('viewBox="0 0 16 16"');
    expect(tileSvg("orange")).toContain('d="M2 2H14V5H5V14H2Z"');
  });
});

/** The pixels of a PNG that tilePng wrote: palette index (0 or 1) for each. */
function decode(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let size = 0;
  const idat: Uint8Array[] = [];
  let palette: number[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") size = view.getUint32(at + 8);
    if (type === "PLTE") palette = [...data];
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil(size / 8);
  const pixel = (x: number, y: number) =>
    ((raw[y * (rowBytes + 1) + 1 + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
  return { size, palette, pixel, rows: raw.length / (rowBytes + 1) };
}

describe("the icon iOS puts on a home screen", () => {
  test("it is a valid 180 px two-color PNG: an orange field with the corner in black", () => {
    const image = decode(tilePng("orange", 180));
    expect(image.size).toBe(180);
    expect(image.rows).toBe(180);
    expect(image.palette).toEqual([0xff, 0x66, 0x00, 0x00, 0x00, 0x00]);
    expect(image.pixel(0, 0)).toBe(0); // the field
    expect(image.pixel(90, 90)).toBe(0); // inside the corner's elbow: the field
    expect(image.pixel(23, 23)).toBe(1); // the top left of the corner: 2 cells in, a cell is 11.25 px
    expect(image.pixel(100, 30)).toBe(1); // along the arm
    expect(image.pixel(30, 150)).toBe(1); // down the stem
    expect(image.pixel(100, 150)).toBe(0); // below the arm, beside the stem: the field
  });

  test("it is the same bytes every time", () => {
    expect(Buffer.from(tilePng("orange", 180)).equals(Buffer.from(tilePng("orange", 180)))).toBe(
      true,
    );
  });
});

describe("the generated files", () => {
  test("every one is up to date; run `bun scripts/generate-brand-assets.ts` after changing the geometry", () => {
    const stale: string[] = [];
    let checked = 0;
    for (const file of brandFiles()) {
      const workspace = file.path.split("/").slice(0, 2).join("/");
      if (!existsSync(resolve(root, workspace))) continue;
      checked += 1;
      const path = resolve(root, file.path);
      if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(file.content)))
        stale.push(file.path);
    }
    expect(checked).toBeGreaterThan(0);
    expect(stale).toEqual([]);
  });
});

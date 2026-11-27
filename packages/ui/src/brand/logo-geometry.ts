/**
 * The Rastrata logo, as geometry. Pure data and string builders with no DOM and no Solid, so the
 * component, the asset generator and the tests all read one source.
 *
 * Everything is drawn on a grid of cells, the way the books are kept in whole cents: every edge
 * lies on a cell boundary and nothing is ever drawn between two cells. A stroke is three cells,
 * the gap inside a letter and the space between letters is two, and the word is 80 cells wide
 * and 17 tall. See docs/explanation/design-language.md, "The logo".
 */

export const CELL = {
  /** Every stroke is this many cells thick. */
  stroke: 3,
  /** The gap inside a letter, and the standard space between letters. */
  counter: 2,
  /** The r is open on its lower right, so the letter after it sits one cell closer. */
  spaceAfterR: 1,
  /** From the x-height line down to the baseline. */
  xHeight: 13,
  /** How far the t's stem rises above the x-height line. */
  ascender: 4,
} as const;

/** The three masters the logo may use. They are the values of --rt-black, --rt-white and --rt-penguin-orange. */
export const MASTER = { black: "#000000", white: "#ffffff", orange: "#ff6600" } as const;

/** x, y, width, height in cells. y is 0 at the x-height line; the baseline is CELL.xHeight and ascenders are negative. */
export type Box = readonly [x: number, y: number, width: number, height: number];

const LETTERS: Record<string, { width: number; boxes: readonly Box[] }> = {
  // A stem and an arm: the corner of a table.
  r: {
    width: 7,
    boxes: [
      [0, 0, 3, 13],
      [0, 0, 7, 3],
    ],
  },
  // A top bar, the full right stem, a middle bar, the lower left stem and a bottom bar.
  a: {
    width: 9,
    boxes: [
      [0, 0, 9, 3],
      [6, 0, 3, 13],
      [0, 5, 9, 3],
      [0, 5, 3, 8],
      [0, 10, 9, 3],
    ],
  },
  // The same three bars, joined the other way round: upper left and lower right.
  s: {
    width: 9,
    boxes: [
      [0, 0, 9, 3],
      [0, 0, 3, 8],
      [0, 5, 9, 3],
      [6, 5, 3, 8],
      [0, 10, 9, 3],
    ],
  },
  // A crossbar on the x-height line and a stem that rises above it.
  t: {
    width: 9,
    boxes: [
      [0, 0, 9, 3],
      [3, -4, 3, 17],
    ],
  },
};

/** Lay a word out left to right. The result is in cells, with the first letter's left edge at x = 0. */
export function layout(text: string): { boxes: Box[]; width: number } {
  const boxes: Box[] = [];
  let x = 0;
  let width = 0;
  for (const [i, ch] of [...text].entries()) {
    const letter = LETTERS[ch];
    if (!letter) throw new Error(`The logo has no letter "${ch}"`);
    for (const [bx, by, bw, bh] of letter.boxes) boxes.push([x + bx, by, bw, bh]);
    width = x + letter.width;
    x = width + (i === text.length - 1 ? 0 : ch === "r" ? CELL.spaceAfterR : CELL.counter);
  }
  return { boxes, width };
}

/**
 * The outline of the cells a set of boxes covers, as SVG path data: one subpath for each outer edge
 * and each hole, with no overlaps and no seams. Outer edges run clockwise and holes the other way,
 * so the default fill rule leaves the holes open.
 */
export function outline(boxes: readonly Box[]): string {
  const filled = new Set<string>();
  for (const [x, y, w, h] of boxes) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) filled.add(`${i},${j}`);
  }
  const has = (i: number, j: number) => filled.has(`${i},${j}`);

  // Every edge between a filled cell and an empty one, directed so the filled cell is on its right.
  const edges = new Map<string, [number, number]>();
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const from = `${x1},${y1}`;
    if (edges.has(from)) throw new Error(`Two cells touch only at a corner, at ${from}`);
    edges.set(from, [x2, y2]);
  };
  for (const key of filled) {
    const [i, j] = key.split(",").map(Number) as [number, number];
    if (!has(i, j - 1)) add(i, j, i + 1, j);
    if (!has(i + 1, j)) add(i + 1, j, i + 1, j + 1);
    if (!has(i, j + 1)) add(i + 1, j + 1, i, j + 1);
    if (!has(i - 1, j)) add(i, j + 1, i, j);
  }

  const order = (a: [number, number], b: [number, number]) => a[1] - b[1] || a[0] - b[0];
  const starts = [...edges.keys()]
    .map((k) => k.split(",").map(Number) as [number, number])
    .sort(order);
  const seen = new Set<string>();
  const loops: [number, number][][] = [];
  for (const start of starts) {
    if (seen.has(`${start[0]},${start[1]}`)) continue;
    const points: [number, number][] = [];
    let at: [number, number] = start;
    while (!seen.has(`${at[0]},${at[1]}`)) {
      seen.add(`${at[0]},${at[1]}`);
      points.push(at);
      at = edges.get(`${at[0]},${at[1]}`) as [number, number];
    }
    // Keep only the corners.
    const corners = points.filter((p, n) => {
      const before = points[(n + points.length - 1) % points.length] as [number, number];
      const after = points[(n + 1) % points.length] as [number, number];
      return (p[0] - before[0]) * (after[1] - p[1]) !== (p[1] - before[1]) * (after[0] - p[0]);
    });
    const first = corners.reduce((best, p) => (order(p, best) < 0 ? p : best));
    const from = corners.indexOf(first);
    loops.push([...corners.slice(from), ...corners.slice(0, from)]);
  }
  loops.sort((a, b) => order(a[0] as [number, number], b[0] as [number, number]));

  return loops
    .map((corners) => {
      const [x0, y0] = corners[0] as [number, number];
      let d = `M${x0} ${y0}`;
      let last = corners[0] as [number, number];
      for (const p of corners.slice(1)) {
        d += p[1] === last[1] ? `H${p[0]}` : `V${p[1]}`;
        last = p;
      }
      return `${d}Z`;
    })
    .join("");
}

const rule = (x: number, y: number, w: number, h: number) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const shifted = (boxes: readonly Box[], dx: number, dy: number): Box[] =>
  boxes.map(([x, y, w, h]) => [x + dx, y + dy, w, h]);

export type LogoVariant = "wordmark" | "plate" | "stacked" | "mark";
export type LogoShape = {
  /** The view box, in cells. */
  readonly viewBox: string;
  readonly width: number;
  readonly height: number;
  /** One path, in cells. */
  readonly d: string;
};

const WORD = layout("rastrata");
const ROW_1 = layout("rast");
const ROW_2 = layout("rata");
/** From one baseline to the next in the stacked name: three cells of air between the rows. */
const LEADING = CELL.xHeight + 3 + CELL.ascender;

const wordmark: LogoShape = {
  viewBox: `0 ${-CELL.ascender} ${WORD.width} ${CELL.xHeight + CELL.ascender}`,
  width: WORD.width,
  height: CELL.xHeight + CELL.ascender,
  d: outline(WORD.boxes),
};

/** The ledger plate: a heavy rule above (one stroke thick) and a double rule below (a cell each), three cells of air. */
const plateTop = -CELL.ascender - 3 - CELL.stroke;
const plateBottom = CELL.xHeight + 3 + 3;
const plate: LogoShape = {
  viewBox: `0 ${plateTop} ${WORD.width} ${plateBottom - plateTop}`,
  width: WORD.width,
  height: plateBottom - plateTop,
  d:
    rule(0, plateTop, WORD.width, CELL.stroke) +
    wordmark.d +
    rule(0, CELL.xHeight + 3, WORD.width, 1) +
    rule(0, CELL.xHeight + 5, WORD.width, 1),
};

/** "rast" over "rata". Both rows are the same width, so the name is a block. */
const stackedWidth = Math.max(ROW_1.width, ROW_2.width);
const stackedHeight = LEADING + CELL.xHeight + CELL.ascender;
const stacked: LogoShape = {
  viewBox: `0 ${-CELL.ascender} ${stackedWidth} ${stackedHeight}`,
  width: stackedWidth,
  height: stackedHeight,
  d: outline([...ROW_1.boxes, ...shifted(ROW_2.boxes, 0, LEADING)]),
};

/** The corner: the r's stem and arm, squared up. It stands for the logo where a word will not fit. */
const MARK_SIZE = 12;
const MARK_BOXES: readonly Box[] = [
  [0, 0, CELL.stroke, MARK_SIZE],
  [0, 0, MARK_SIZE, CELL.stroke],
];
const mark: LogoShape = {
  viewBox: `0 0 ${MARK_SIZE} ${MARK_SIZE}`,
  width: MARK_SIZE,
  height: MARK_SIZE,
  d: outline(MARK_BOXES),
};

export const LOGO: Record<LogoVariant, LogoShape> = { wordmark, plate, stacked, mark };

/**
 * The tile: the corner on a square field, for places that need one (a favicon, an app icon). Sixteen
 * cells square, so at 16, 32, 48 and 64 px a cell is a whole number of pixels and nothing blurs.
 */
export const TILE = { size: 16, margin: 2 } as const;
export type TileTone = "orange" | "ink" | "paper";
export const TILE_TONES: Record<TileTone, { field: string; mark: string }> = {
  orange: { field: MASTER.orange, mark: MASTER.black },
  ink: { field: MASTER.black, mark: MASTER.white },
  paper: { field: MASTER.white, mark: MASTER.black },
};

const NAME = "Rastrata";
const FILE_CELL = 4; // pixels per cell in a standalone file's own size; the file scales freely

/**
 * A standalone SVG file of a variant in one fill: the logo files, and the inline copy a page that
 * cannot import the component carries. `fill` is "currentColor" to follow the text colour, or a hex.
 * `inline` leaves out the file's own size and name: the page sizes it and names its link. It is
 * written into a source file the formatter checks, so it is laid out the way the formatter keeps it.
 */
export function logoSvg(
  variant: LogoVariant,
  fill: string,
  mode: "file" | "inline" = "file",
): string {
  const shape = LOGO[variant];
  if (mode === "inline") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${shape.viewBox}" aria-hidden="true" focusable="false">\n  <path\n    fill="${fill}"\n    d="${shape.d}"\n  />\n</svg>\n`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${shape.viewBox}" width="${shape.width * FILE_CELL}" height="${shape.height * FILE_CELL}" role="img" aria-label="${NAME}"><title>${NAME}</title><path fill="${fill}" d="${shape.d}"/></svg>\n`;
}

/** The tile as a standalone SVG file. */
export function tileSvg(tone: TileTone): string {
  const { size, margin } = TILE;
  const colors = TILE_TONES[tone];
  const corner = outline(shifted(MARK_BOXES, margin, margin));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * FILE_CELL}" height="${size * FILE_CELL}" role="img" aria-label="${NAME}"><title>${NAME}</title><rect width="${size}" height="${size}" fill="${colors.field}"/><path fill="${colors.mark}" d="${corner}"/></svg>\n`;
}

/** The tile's rectangles in cells, for rasterising it without a browser. */
export function tileRects(tone: TileTone): { field: string; mark: string; boxes: readonly Box[] } {
  const colors = TILE_TONES[tone];
  return {
    field: colors.field,
    mark: colors.mark,
    boxes: shifted(MARK_BOXES, TILE.margin, TILE.margin),
  };
}

/** The wordmark's rectangles in cells, from its top-left corner (the top of the t), for rasterising it without a browser. */
export function wordmarkRects(): { width: number; height: number; boxes: readonly Box[] } {
  return {
    width: wordmark.width,
    height: wordmark.height,
    boxes: shifted(WORD.boxes, 0, CELL.ascender),
  };
}

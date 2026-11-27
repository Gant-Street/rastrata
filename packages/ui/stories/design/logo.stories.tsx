import { For, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AppHeader, Logo } from "../../src";
import { CELL, LOGO, layout, type TileTone, tileSvg } from "../../src/brand/logo-geometry";
import { Catalog, Specimen } from "../catalog";

/** A master field with the logo in the one color that field takes. Fields are fixed: they do not swap with the theme. */
function Field(props: { name: string; field: string; ink: string; children: JSX.Element }) {
  return (
    <figure class="logo-field" style={{ "--field": props.field, "--on-field": props.ink }}>
      <figcaption>{props.name}</figcaption>
      {props.children}
    </figure>
  );
}

const BLUE = "#0b3d91";

/** The wordmark on its grid, with the numbers that draw it. Every edge is on a cell boundary. */
function Construction() {
  const x0 = -6;
  const y0 = -12;
  const w = LOGO.wordmark.width + 12;
  const h = LOGO.wordmark.height + 15;
  const lines = [
    ...Array.from({ length: w + 1 }, (_, i) => ({ v: true, at: x0 + i })),
    ...Array.from({ length: h + 1 }, (_, i) => ({ v: false, at: y0 + i })),
  ];
  const a = layout("r").width + CELL.spaceAfterR; // where the first a starts
  const aEnd = a + layout("a").width;
  const bracket = (x1: number, y1: number, x2: number, y2: number) => (
    <path d={`M${x1} ${y1}L${x2} ${y2}`} stroke={BLUE} stroke-width="0.14" />
  );
  const tick = (x: number, y: number, vertical: boolean) => (
    <path
      d={vertical ? `M${x - 0.5} ${y}h1` : `M${x} ${y - 0.5}v1`}
      stroke={BLUE}
      stroke-width="0.14"
    />
  );
  const label = (
    x: number,
    y: number,
    text: string,
    anchor: "start" | "middle" | "end" = "middle",
  ) => (
    <text
      x={x}
      y={y}
      font-family="ui-monospace, Menlo, monospace"
      font-size="1.55"
      font-weight="700"
      fill={BLUE}
      text-anchor={anchor}
    >
      {text}
    </text>
  );
  return (
    <div class="logo-sheet">
      <svg
        viewBox={`${x0} ${y0} ${w} ${h}`}
        role="img"
        aria-label="The wordmark on a grid of cells: 80 cells wide, 13 tall from the x-height line to the baseline, with a stem that rises 4 more. A stroke is 3 cells, a counter and the usual space 2, and the space after an r 1."
      >
        <For each={lines}>
          {(line) =>
            line.v ? (
              <path
                d={`M${line.at} ${y0}V${y0 + h}`}
                stroke={line.at % 5 === 0 ? "#b9b9b9" : "#dcdcdc"}
                stroke-width={line.at % 5 === 0 ? 0.09 : 0.06}
              />
            ) : (
              <path
                d={`M${x0} ${line.at}H${x0 + w}`}
                stroke={line.at % 5 === 0 ? "#b9b9b9" : "#dcdcdc"}
                stroke-width={line.at % 5 === 0 ? 0.09 : 0.06}
              />
            )
          }
        </For>
        <path fill="#000" d={LOGO.wordmark.d} />
        {bracket(0, -6.2, LOGO.wordmark.width, -6.2)}
        {tick(0, -6.2, false)}
        {tick(LOGO.wordmark.width, -6.2, false)}
        {label(LOGO.wordmark.width / 2, -7.2, "80 cells")}
        {bracket(-3, 0, -3, CELL.xHeight)}
        {tick(-3, 0, true)}
        {tick(-3, CELL.xHeight, true)}
        {label(-3.8, 7.5, String(CELL.xHeight), "end")}
        {bracket(LOGO.wordmark.width + 3, -CELL.ascender, LOGO.wordmark.width + 3, 0)}
        {tick(LOGO.wordmark.width + 3, -CELL.ascender, true)}
        {tick(LOGO.wordmark.width + 3, 0, true)}
        {label(LOGO.wordmark.width + 4, -1.6, String(CELL.ascender), "start")}
        {bracket(0, CELL.xHeight + 2.2, CELL.stroke, CELL.xHeight + 2.2)}
        {tick(0, CELL.xHeight + 2.2, false)}
        {tick(CELL.stroke, CELL.xHeight + 2.2, false)}
        {label(CELL.stroke / 2, CELL.xHeight + 4.6, String(CELL.stroke))}
        {bracket(a + 2, 3, a + 2, 5)}
        {tick(a + 2, 3, true)}
        {tick(a + 2, 5, true)}
        {label(a + 1.2, 4.65, String(CELL.counter), "end")}
        {bracket(aEnd, -1.4, aEnd + CELL.counter, -1.4)}
        {tick(aEnd, -1.4, false)}
        {tick(aEnd + CELL.counter, -1.4, false)}
        {label(aEnd + CELL.counter / 2, -2.4, String(CELL.counter))}
        {bracket(layout("r").width, -1.4, a, -1.4)}
        {tick(layout("r").width, -1.4, false)}
        {tick(a, -1.4, false)}
        {label(layout("r").width + 0.5, -2.4, String(CELL.spaceAfterR))}
      </svg>
    </div>
  );
}

/** Six cells, two strokes, clear on every side. */
function ClearSpace() {
  const m = 6;
  const w = LOGO.wordmark.width + 2 * m;
  const h = LOGO.wordmark.height + 2 * m;
  const corner = (x: number, y: number) => (
    <>
      <rect x={x} y={y} width={m} height={m} fill="none" stroke={BLUE} stroke-width="0.2" />
      <text
        x={x + m / 2}
        y={y + m / 2 + 0.9}
        font-family="ui-monospace, Menlo, monospace"
        font-size="2.4"
        font-weight="700"
        fill={BLUE}
        text-anchor="middle"
      >
        6
      </text>
    </>
  );
  const top = -CELL.ascender - m;
  return (
    <div class="logo-sheet">
      <svg
        viewBox={`${-m} ${top} ${w} ${h}`}
        role="img"
        aria-label="The wordmark with a clear zone of 6 cells on every side."
      >
        <rect
          x={-m}
          y={top}
          width={w}
          height={h}
          fill="none"
          stroke={BLUE}
          stroke-width="0.25"
          stroke-dasharray="1 0.8"
        />
        <rect
          x="0"
          y={-CELL.ascender}
          width={LOGO.wordmark.width}
          height={LOGO.wordmark.height}
          fill="none"
          stroke="#bbb"
          stroke-width="0.2"
        />
        <path fill="#000" d={LOGO.wordmark.d} />
        {corner(-m, top)}
        {corner(LOGO.wordmark.width, top)}
        {corner(-m, LOGO.wordmark.height - CELL.ascender)}
        {corner(LOGO.wordmark.width, LOGO.wordmark.height - CELL.ascender)}
      </svg>
    </div>
  );
}

/** A tile is the real file: the markup is what the generator writes to packages/ui/brand. */
function Tile(props: { tone: TileTone; size: number }) {
  return (
    <div
      class="logo-tile"
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      innerHTML={tileSvg(props.tone)}
    />
  );
}

const donts: { note: string; style?: JSX.CSSProperties; height?: number; field?: string }[] = [
  {
    note: "Don't stretch or squash it.",
    style: { transform: "scaleX(1.45)", "transform-origin": "left center" },
  },
  {
    note: "Don't recolor it. It is ink, paper, or black on orange.",
    style: { color: "var(--rt-penguin-orange)" },
  },
  {
    note: "Don't add effects, not even a hard shadow.",
    style: { filter: "drop-shadow(0.25rem 0.25rem 0 var(--rt-penguin-orange))" },
  },
  { note: "Don't tilt it.", style: { transform: "rotate(-7deg)" } },
  {
    note: "Don't put it on a color it cannot be read on: white on orange.",
    style: { color: "var(--rt-white)" },
    field: "var(--rt-penguin-orange)",
  },
  { note: "Don't set it smaller than 17 px tall.", height: 9 },
];

function LogoPage() {
  return (
    <Catalog
      section="02 / Foundations"
      title="Drawn in whole cells."
      description="The logo is one shape in one color, built on a grid of cells the way the books are kept in whole cents. It is ink on paper, paper on ink, or black on orange, and never anything else."
    >
      <Specimen
        title="Wordmark"
        note="Lowercase, always. The word is 80 cells wide and 17 tall, five times as wide as it is tall. In the product it is ink, and orange stays reserved for a person who is needed."
      >
        <div class="logo-fields">
          <Field name="Paper" field="var(--rt-white)" ink="var(--rt-black)">
            <Logo height={51} />
          </Field>
          <Field name="Ink" field="var(--rt-black)" ink="var(--rt-white)">
            <Logo height={51} />
          </Field>
          <Field name="Orange" field="var(--rt-penguin-orange)" ink="var(--rt-black)">
            <Logo height={51} />
          </Field>
        </div>
      </Specimen>
      <Specimen
        title="Lockups"
        note="The plate signs a page: a heavy rule above, a double rule below, three cells of air; below 20 px tall it drops the rules. The stacked name is a block, because “rast” and “rata” are the same width. The corner stands for the logo where the word will not fit."
      >
        <div class="logo-fields">
          <Field name="Plate" field="var(--rt-white)" ink="var(--rt-black)">
            <Logo variant="plate" height={72} />
          </Field>
          <Field name="Stacked" field="var(--rt-white)" ink="var(--rt-black)">
            <Logo variant="stacked" height={96} />
          </Field>
          <Field name="Corner" field="var(--rt-white)" ink="var(--rt-black)">
            <Logo variant="mark" height={72} />
          </Field>
        </div>
      </Specimen>
      <Specimen
        title="Tile"
        note="The corner on a square field, sixteen cells across, for a favicon or an app icon. At 16, 32, 48 and 64 px a cell is a whole number of pixels, so nothing blurs. Orange is the default: the brand owns the tab and the home screen."
      >
        <div class="logo-tiles">
          <For each={["orange", "ink", "paper"] as const}>
            {(tone) => <Tile tone={tone} size={128} />}
          </For>
          <div class="logo-true">
            <For each={[64, 48, 32, 16]}>{(size) => <Tile tone="orange" size={size} />}</For>
          </div>
        </div>
      </Specimen>
      <Specimen
        title="Construction"
        note="A stroke is 3 cells, a counter and the usual space between letters 2, the space after an r 1 (it is open below its arm). The word is drawn only from whole cells; there is no optical guess to disagree about."
      >
        <Construction />
      </Specimen>
      <Specimen
        title="Clear space and size"
        note="Keep six cells, two strokes, clear on every side. The smallest wordmark is 17 px tall, where one cell is one pixel; whole multiples of 17 keep every edge on a pixel."
      >
        <div class="logo-clear">
          <ClearSpace />
          <div class="logo-ladder">
            <For each={[17, 34, 51]}>
              {(height) => (
                <figure>
                  <Logo height={height} label="" />
                  <figcaption>
                    {height} px · cell {height / 17} px
                  </figcaption>
                </figure>
              )}
            </For>
          </div>
        </div>
      </Specimen>
      <Specimen
        title="In the product"
        note="Beside the name of the book, on one baseline, in ink. The header's link is what is named; the picture inside it only says it again."
      >
        <AppHeader
          name="Fernwood Bakehouse"
          wordmark={
            <a class="wordmark" href="#/">
              <Logo />
            </a>
          }
        />
      </Specimen>
      <Specimen
        title="Don't"
        note="The logo is not a texture to play with. If it does not fit, use the corner or the plate, and leave it alone."
      >
        <div class="logo-donts">
          <For each={donts}>
            {(item) => (
              <figure class="logo-dont" style={item.field ? { "--field": item.field } : undefined}>
                <div class="logo-dont-stage">
                  <div style={item.style}>
                    <Logo label="" height={item.height ?? 28} />
                  </div>
                </div>
                <figcaption>{item.note}</figcaption>
              </figure>
            )}
          </For>
        </div>
      </Specimen>
      <Specimen
        title="Brand files"
        note="Masters for people who cannot import the component. Black for a light page, white for a dark one. Generated from the same geometry; run bun scripts/generate-brand-assets.ts after changing it. A test fails when any copy has drifted."
      >
        <ul class="logo-files">
          <For each={["wordmark", "plate", "stacked", "mark"]}>
            {(name) => (
              <li>
                <code>rastrata-{name}.svg</code> <code>rastrata-{name}-white.svg</code>
              </li>
            )}
          </For>
          <li>
            <code>rastrata-tile-orange.svg</code> <code>rastrata-tile-ink.svg</code>{" "}
            <code>rastrata-tile-paper.svg</code>
          </li>
        </ul>
      </Specimen>
    </Catalog>
  );
}

export default {
  title: "Foundations/Logo",
  component: LogoPage,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof LogoPage>;
export const Review: StoryObj<typeof LogoPage> = {};

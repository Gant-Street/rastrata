import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, For, type JSX } from "solid-js";
import { Button, Logo, TextField } from "../src";
import { ThemeToggle } from "./catalog";

type FoundationArgs = {
  density: "comfortable" | "compact";
  fontSize: number;
};

// Fictional, balanced postings. Display strings only; no accounting implementation.
const postings = [
  ["22 Sep", "JRN-0043", "Office supplies", "6100 · Office expenses", "128.40", "—"],
  ["22 Sep", "JRN-0043", "Office supplies", "1000 · Cash", "—", "128.40"],
  ["21 Sep", "JRN-0042", "Customer payment", "1000 · Cash", "2,450.00", "—"],
  ["21 Sep", "JRN-0042", "Customer payment", "1100 · Accounts receivable", "—", "2,450.00"],
  ["20 Sep", "JRN-0041", "September accrual", "6200 · Professional services", "320.00", "—"],
  ["20 Sep", "JRN-0041", "September accrual", "2100 · Accrued expenses", "—", "320.00"],
];

const colorRoles = [
  {
    label: "White",
    ink: "dark",
    token: "--rt-white",
    hex: "#FFFFFF",
    reference: "SBB / White",
    reason:
      "The open field of a railway sign. Nothing disguised as parchment. Room to read, think, and begin.",
    url: "https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/",
  },
  {
    label: "Black",
    ink: "light",
    token: "--rt-black",
    hex: "#000000",
    reference: "SBB / Black",
    reason:
      "The printed fact. A public timetable has to mean what it says. Our figures should carry that same conviction.",
    url: "https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/",
  },
  {
    label: "Penguin orange",
    ink: "dark",
    token: "--rt-penguin-orange",
    hex: "#FF6600",
    reference: "Penguin Books / Published digital orange",
    reason:
      "Good books within ordinary people's reach. That is the ambition for this tool, too: serious quality without exclusivity.",
    url: "https://www.linkedin.com/posts/penguin-random-house-uk_ff6600-brand-brandheritage-activity-7386706318688043008-i5sa",
  },
  {
    label: "NASA blue",
    ink: "light",
    token: "--rt-nasa-blue",
    hex: "#0B3D91",
    reference: "NASA Web Design System / Primary darker",
    reason:
      "Ambition supported by careful engineering. For looking deeper: references, evidence, and the next question.",
    url: "https://nasa.github.io/nasawds-site/components/colors/",
  },
  {
    label: "Railway red",
    ink: "light",
    token: "--rt-railway-red",
    hex: "#EB0000",
    reference: "SBB / Red",
    reason:
      "A clear interruption in black and white. Something consequential needs your attention. Bright, direct, never apologetic.",
    url: "https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/",
  },
];

function Foundations(props: FoundationArgs) {
  const [reference, setReference] = createSignal("September adjustments");
  const [feedback, setFeedback] = createSignal("");
  const style = (): JSX.CSSProperties => ({
    "--rt-font-size": `${props.fontSize}px`,
    "--rt-row-padding": props.density === "compact" ? "0.5rem" : "0.875rem",
    "--rt-control-padding": props.density === "compact" ? "0.375rem 0.75rem" : "0.625rem 0.875rem",
  });
  return (
    <main class="workshop" style={style()}>
      <header class="workshop-masthead">
        <Logo />
        <div class="catalog-masthead-end">
          <span class="edition">Design study 02 / Color code</span>
          <ThemeToggle />
        </div>
      </header>
      <div class="workshop-intro">
        <p class="eyebrow">A working instrument for your books</p>
        <h1>Make the numbers clear.</h1>
        <p class="intro-copy">
          Five exact colors. Books for everyone. Engineering with ambition. Public information you
          can trust.
        </p>
        <p class="preview-note">Design preview · Fictional data · No connection to your books</p>
      </div>

      <div class="palette-strip">
        <For each={colorRoles}>
          {(color) => (
            <div
              class="palette-chip"
              data-ink={color.ink}
              style={{
                "--bg": `var(${color.token})`,
                "--ink": color.ink === "dark" ? "var(--rt-black)" : "var(--rt-white)",
              }}
            >
              <span>{color.label}</span>
              <code>{color.hex}</code>
            </div>
          )}
        </For>
      </div>

      <section class="journal-sheet" aria-labelledby="journal-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">01 / In practice</p>
            <h2 id="journal-title">General journal</h2>
          </div>
          <span class="journal-period">September 2026 / USD</span>
        </div>
        <div class="journal-summary">
          <span>
            3 posted entries <span aria-hidden="true">·</span> 6 postings
          </span>
          <span>All amounts in USD</span>
        </div>
        <p class="table-scroll-hint">Scroll the table to see debit and credit →</p>
        <section class="table-scroll" aria-label="General journal postings" tabindex="0">
          <table>
            <caption class="sr-only">Sample general journal · September 2026 · USD</caption>
            <thead>
              <tr>
                <th scope="col">Date / Entry</th>
                <th scope="col">Description / Account</th>
                <th scope="col" class="amount">
                  Debit
                </th>
                <th scope="col" class="amount">
                  Credit
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={postings}>
                {(posting, index) => (
                  <tr classList={{ "entry-start": index() % 2 === 0 }}>
                    <td>
                      {posting[0]}
                      <span class="cell-detail identifier">{posting[1]}</span>
                    </td>
                    <td>
                      {posting[2]}
                      <span class="cell-detail">{posting[3]}</span>
                    </td>
                    <td class="amount">{posting[4]}</td>
                    <td class="amount">{posting[5]}</td>
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colspan="2">
                  Total posted
                </th>
                <td class="amount">2,898.40</td>
                <td class="amount">2,898.40</td>
              </tr>
            </tfoot>
          </table>
        </section>
        <p class="journal-footnote">
          Debits equal credits. Posted entries stay quiet; exceptions get attention.
        </p>
      </section>

      <section class="review-grid" aria-label="Typography and entry controls">
        <div class="type-specimen">
          <p class="eyebrow">02 / Typography</p>
          <h2>One typeface. Clear priorities.</h2>
          <p class="muted">
            Inter throughout. Regular for reading, medium for controls, semibold for emphasis.
          </p>
          <p class="figure-specimen amount">12,345.67</p>
          <div class="number-details">
            <span class="amount">(98.10)</span>
            <span class="amount">0.00</span>
            <span class="amount">1,234,567.89</span>
          </div>
          <p class="muted">Aligned digits. Explicit signs. A negative amount is not an error.</p>
          <p class="identifier">JRN-2026-0043 / INV-0018</p>
          <a class="workshop-link" href="/licenses/inter.txt" target="_blank" rel="noreferrer">
            Inter font license
          </a>
        </div>
        <form
          class="entry-preview"
          onSubmit={(event) => {
            event.preventDefault();
            setFeedback("Draft saved in this preview only. Reloading clears it.");
          }}
        >
          <p class="eyebrow">03 / Entry controls</p>
          <h2>A place for every detail.</h2>
          <TextField
            label="Reference"
            hint="A name to help you find this entry."
            required
            value={reference()}
            onInput={(event) => {
              setReference(event.currentTarget.value);
              setFeedback("");
            }}
          />
          <div class="actions">
            <Button label="Save draft" type="submit" />
            <Button
              label="Reset"
              variant="secondary"
              onClick={() => {
                setReference("September adjustments");
                setFeedback("Preview reset.");
              }}
            />
          </div>
          <p class="preview-feedback" role="status">
            {feedback() || "Preview only. Nothing is sent or stored."}
          </p>
        </form>
      </section>

      <section aria-labelledby="color-title">
        <p class="eyebrow">04 / The specification</p>
        <h2 id="color-title">The source chooses the shade.</h2>
        <p class="muted">
          These are published digital values, not colors sampled from photographs or matched by eye.
          The references supply the numbers. Their place in Rastrata is our design judgment.
        </p>
        <div class="swatches">
          <For each={colorRoles}>
            {(color) => (
              <div class="color-role">
                <div class="swatch" style={{ background: `var(${color.token})` }} />
                <h3>
                  {color.label} <code>{color.hex}</code>
                </h3>
                <p>{color.reason}</p>
                <a class="workshop-link" href={color.url} target="_blank" rel="noreferrer">
                  {color.reference} ↗
                </a>
              </div>
            )}
          </For>
        </div>
        <div class="status-specimens">
          <span class="muted">Status examples</span>
          <span>Posted</span>
          <span class="status-confirmed">✓ Reconciled</span>
          <span class="status-attention">! Needs review</span>
          <span class="status-error">× Couldn’t save</span>
        </div>
        <p class="muted">
          No automatic green for money. No amber added to complete a traffic light. Reconciled is a
          word and a checkmark. Review is black on orange. Error is red on white.
        </p>
        <p class="muted">
          Grays and interaction tints are declared sRGB mixtures of these five masters, not
          additional historical colors. NASA's source is its archived web palette, not a claim about
          spacecraft paint; Penguin's digital orange is not a color measurement of a 1935 cover.
        </p>
      </section>
      <footer class="workshop-footer">
        <span>Rastrata / Foundation study</span>
        <span>Color code 02 · Open for review</span>
      </footer>
    </main>
  );
}

const meta = {
  title: "Foundations/Typography, color & density",
  component: Foundations,
  args: {
    density: "comfortable",
    fontSize: 15,
  },
  argTypes: {
    density: { control: "inline-radio", options: ["comfortable", "compact"] },
    fontSize: { control: { type: "range", min: 14, max: 20, step: 1 } },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Foundations>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = {};
export const Compact: Story = { args: { density: "compact" } };

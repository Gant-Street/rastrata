import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, For } from "solid-js";
import { Button, Logo, Status, TextField } from "../src";
import { ThemeToggle } from "./catalog";

// The five masters, each given one job. The product uses these roles; the workshop
// uses the colors themselves as page identity.
const colors = [
  {
    label: "Black",
    hex: "#000000",
    token: "--rt-black",
    ink: "light",
    role: "Figures · Actions",
    reason:
      "The printed fact. A public timetable has to mean what it says, so every amount and every primary action is set in black.",
    source: "SBB / Black",
    url: "https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/",
  },
  {
    label: "Penguin orange",
    hex: "#FF6600",
    token: "--rt-penguin-orange",
    ink: "dark",
    role: "Needs a human",
    reason:
      "Good books within ordinary people's reach. Orange appears only where a person must look: something to review, a pending change, a decision to make.",
    source: "Penguin Books / Digital orange",
    url: "https://www.linkedin.com/posts/penguin-random-house-uk_ff6600-brand-brandheritage-activity-7386706318688043008-i5sa",
  },
  {
    label: "NASA blue",
    hex: "#0B3D91",
    token: "--rt-nasa-blue",
    ink: "light",
    role: "Where you are",
    reason:
      "Ambition supported by careful engineering. Blue marks what you have chosen and where focus is, and leads you deeper into the evidence.",
    source: "NASA Web Design System / Primary darker",
    url: "https://nasa.github.io/nasawds-site/components/colors/",
  },
  {
    label: "Railway red",
    hex: "#EB0000",
    token: "--rt-railway-red",
    ink: "light",
    role: "Consequence",
    reason:
      "A clear interruption in black and white. Red is rationed to errors and things that cannot be undone, so it is never decoration.",
    source: "SBB / Red",
    url: "https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/",
  },
  {
    label: "White",
    hex: "#FFFFFF",
    token: "--rt-white",
    ink: "dark",
    role: "The page",
    reason:
      "The open field of a railway sign. Nothing disguised as parchment, with room to read, think and begin.",
    source: "SBB / White",
    url: "https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/",
  },
];

const sections = [
  {
    id: "01",
    tone: "orange",
    title: "Typography, color & density",
    desc: "One typeface set tight, five exact colors, and the figures that carry the books.",
    href: "?id=foundations-typography-color-density--review&viewMode=story",
    tags: "Inter · Color code · Tabular",
  },
  {
    id: "02",
    tone: "blue",
    title: "Forms & fields",
    desc: "String-preserving amounts, account selectors, dates, and recovery from mistakes.",
    href: "?id=components-forms--review&viewMode=story",
    tags: "Field · Combobox · Date",
  },
  {
    id: "03",
    tone: "black",
    title: "Status & notices",
    desc: "Labels, persistent notices and progress. What happened, said plainly.",
    href: "?id=components-feedback--review&viewMode=story",
    tags: "Draft · Posted · Unknown",
  },
  {
    id: "04",
    tone: "orange",
    title: "Navigation",
    desc: "Breadcrumbs, tabs and pagination for books with long names.",
    href: "?id=patterns-navigation--review&viewMode=story",
    tags: "Tabs · Crumbs · Pager",
  },
  {
    id: "05",
    tone: "orange",
    title: "The register",
    desc: "Find, filter, inspect and change pages without losing your place.",
    href: "?id=patterns-register--review&viewMode=story",
    tags: "Sort · Filter · Inspect",
  },
  {
    id: "06",
    tone: "black",
    title: "Journals & reports",
    desc: "Balanced entries, trial balances and double-ruled totals.",
    href: "?id=patterns-journal--review&viewMode=story",
    tags: "Ledger · Balance · Report",
  },
] as const;

function Overview() {
  const [reference, setReference] = createSignal("September adjustments");
  const [saved, setSaved] = createSignal(false);

  return (
    <main class="rt-theme catalog ov">
      <div class="ov-flag" aria-hidden="true">
        <For each={colors}>
          {(c) => (
            <span
              style={{ "--c": c.token === "--rt-black" ? "var(--rt-ink)" : `var(${c.token})` }}
            />
          )}
        </For>
      </div>

      <header class="catalog-masthead">
        <Logo />
        <div class="catalog-masthead-end">
          <span class="catalog-meta">Color code 02 · Workshop</span>
          <ThemeToggle />
        </div>
      </header>

      <section class="ov-hero" aria-labelledby="ov-title">
        <p class="tape">Design workshop · Fictional data</p>
        <h1 id="ov-title">
          Books for <em>everyone.</em>
        </h1>
        <div class="ov-hero-copy">
          <p class="ov-lede">
            Engineering with ambition, public information you can trust.{" "}
            <span>
              Five exact colors, one typeface, and rules a bookkeeper would recognize: a working
              instrument, not a dashboard.
            </span>
          </p>
          <div class="ov-hero-meta">
            <span>49 stories under test</span>
            <span>WCAG 2.1 AA scanned</span>
            <span>Exact decimal strings</span>
          </div>
        </div>
      </section>

      <section class="ov-section" aria-labelledby="palette-heading">
        <div class="ov-section-head">
          <h2 id="palette-heading">Color code 02</h2>
          <p>Five colors, each chosen from a published source and given one job. Hover or tab.</p>
        </div>
        <div class="ov-chips">
          <For each={colors}>
            {(c, i) => (
              <article
                class="ov-chip"
                data-ink={c.ink}
                style={{ "--bg": `var(${c.token})`, "--i": i() }}
              >
                <div class="ov-chip-top">
                  <span class="ov-chip-role">{c.role}</span>
                  <h3>{c.label}</h3>
                  <code class="ov-chip-hex">{c.hex}</code>
                </div>
                <div class="ov-chip-body">
                  <p>{c.reason}</p>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.source} ↗
                  </a>
                </div>
              </article>
            )}
          </For>
        </div>
      </section>

      <section class="ov-section" aria-labelledby="live-demo-heading">
        <div class="ov-section-head">
          <h2 id="live-demo-heading">A voucher, live</h2>
          <p>Edit the reference. The state label tells the truth about what has been saved.</p>
        </div>
        <div class="ov-voucher">
          <div class="ov-voucher-head">
            <TextField
              label="Reference"
              value={reference()}
              onInput={(e) => {
                setReference(e.currentTarget.value);
                setSaved(false);
              }}
              hint="Enter an identifier to test live reactivity."
            />
            <div class="ov-voucher-total">
              <dl style={{ margin: 0 }}>
                <dt>Total · USD</dt>
                <dd>4,800.00</dd>
              </dl>
              <div class="ov-voucher-status">
                <span>State</span>
                <Status tone={saved() ? "neutral" : "review"}>
                  {saved() ? "Saved Draft" : "Pending Changes"}
                </Status>
              </div>
            </div>
          </div>

          <section
            class="rt-table-scroll"
            tabindex={0}
            aria-label="Example journal, scroll horizontally on narrow screens"
          >
            <table class="rt-table">
              <caption class="rt-sr-only">Example journal</caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col" class="rt-number">
                    Debit · USD
                  </th>
                  <th scope="col" class="rt-number">
                    Credit · USD
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">1000 · Cash & Operating Account</th>
                  <td class="rt-number">4,800.00</td>
                  <td class="rt-number">—</td>
                </tr>
                <tr>
                  <th scope="row">4000 · Professional Services Revenue</th>
                  <td class="rt-number">—</td>
                  <td class="rt-number">4,800.00</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total (Balanced)</th>
                  <td class="rt-number">4,800.00</td>
                  <td class="rt-number">4,800.00</td>
                </tr>
              </tfoot>
            </table>
          </section>

          <div class="ov-voucher-actions">
            <Button
              label={saved() ? "✓ Draft Saved" : "Save Draft"}
              variant="primary"
              onClick={() => setSaved(true)}
            />
            <Button
              label="Reset Demo"
              variant="secondary"
              onClick={() => {
                setReference("September adjustments");
                setSaved(false);
              }}
            />
          </div>
        </div>
      </section>

      <section class="ov-section" aria-labelledby="catalog-index-heading">
        <div class="ov-section-head">
          <h2 id="catalog-index-heading">The workshop</h2>
          <p>Six rooms, from the type on the page to the posted entry.</p>
        </div>
        <nav aria-label="Design system sections">
          <ul class="ov-index">
            <For each={sections}>
              {(item) => (
                <li style={{ display: "contents" }}>
                  <a href={item.href} class="ov-row" data-tone={item.tone}>
                    <span class="ov-row-num">{item.id}</span>
                    <span>
                      <span class="ov-row-title">{item.title}</span>
                      <span class="ov-row-desc">{item.desc}</span>
                    </span>
                    <span class="ov-row-tags">{item.tags}</span>
                    <span class="ov-row-arrow" aria-hidden="true">
                      →
                    </span>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </nav>
      </section>

      <p class="ov-colophon">
        Every example runs on deterministic local state, with no network connection and no
        credentials. Set in Inter, loaded from this page.
      </p>

      <footer class="catalog-footer">
        <span>Rastrata UI · Working edition</span>
        <span>Deterministic review · Not connected to live books</span>
      </footer>
    </main>
  );
}

export default {
  title: "Start here/Workshop",
  component: Overview,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Overview>;

export const Review: StoryObj<typeof Overview> = {};

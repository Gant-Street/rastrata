import { createSignal, Show } from "solid-js";
import { ChevronDown, ChevronRight } from "../src/icons";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Catalog } from "./catalog";
import { CalendarField } from "./controls";
import { Notice } from "../src";

function Report() {
  const [expanded, setExpanded] = createSignal(true);
  return (
    <Catalog
      section="05 / Financial report"
      title="The whole, and its parts."
      description="North Workshop · Trial balance · As at September 30, 2026 · Accrual basis · USD. Supplied report data, not calculations in the browser."
    >
      <div class="catalog-toolbar">
        <CalendarField range defaultDateValues={["2026-09-01", "2026-09-30"]} />
        <span class="catalog-description">Changing dates does not regenerate this fixture.</span>
      </div>
      <section
        class="rt-table-scroll"
        tabindex={0}
        aria-label="Trial balance, scroll horizontally on narrow screens"
      >
        <table class="rt-table">
          <caption>Trial balance · September 30, 2026</caption>
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
              <th scope="row">
                <button
                  type="button"
                  class="rt-button"
                  data-variant="quiet"
                  aria-expanded={expanded()}
                  onClick={() => setExpanded(!expanded())}
                >
                  {expanded() ? (
                    <ChevronDown aria-hidden="true" />
                  ) : (
                    <ChevronRight aria-hidden="true" />
                  )}{" "}
                  Assets
                </button>
              </th>
              <td class="rt-number">2,578.40</td>
              <td class="rt-number">—</td>
            </tr>
            <Show when={expanded()}>
              <tr>
                <th scope="row" style={{ "padding-inline-start": "2rem" }}>
                  1000 · Cash
                </th>
                <td class="rt-number">2,450.00</td>
                <td class="rt-number">—</td>
              </tr>
              <tr>
                <th scope="row" style={{ "padding-inline-start": "2rem" }}>
                  1100 · Accounts receivable
                </th>
                <td class="rt-number">128.40</td>
                <td class="rt-number">—</td>
              </tr>
            </Show>
            <tr>
              <th scope="row">2000 · Accounts payable</th>
              <td class="rt-number">—</td>
              <td class="rt-number">128.40</td>
            </tr>
            <tr>
              <th scope="row">3000 · Owner's equity</th>
              <td class="rt-number">—</td>
              <td class="rt-number">2,450.00</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td class="rt-number">2,578.40</td>
              <td class="rt-number">2,578.40</td>
            </tr>
          </tfoot>
        </table>
      </section>
      <div style={{ "margin-top": "2rem" }}>
        <Notice title="Report context is part of the report">
          Company, period, basis and currency remain visible. Parent rows summarize their children;
          they are not counted twice.
        </Notice>
      </div>
    </Catalog>
  );
}
export default {
  title: "Patterns/Report",
  component: Report,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Report>;
export const Review: StoryObj<typeof Report> = {};

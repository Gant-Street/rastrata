import { createSignal, For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Button,
  DATE_FORMATS,
  DateValue,
  dateFormat,
  formatDate,
  setDateFormat,
  UiProvider,
} from "../../src";

const rows = [
  ["A date", "2026-03-20"],
  ["The first of a month", "2026-10-01"],
  ["A leap day", "2024-02-29"],
  ["The last day of the year", "2026-12-31"],
] as const;

function Specimen(props: { dir?: "ltr" | "rtl"; narrow?: boolean }) {
  return (
    <UiProvider locale="en-US">
      <div
        class="rt-theme"
        dir={props.dir}
        style={{ "max-width": props.narrow ? "14rem" : "34rem" }}
      >
        <section class="rt-table-scroll" tabindex="0" aria-label="Dates in a column">
          <table class="rt-table">
            <caption>Dates in a column</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows}>
                {([label, value]) => (
                  <tr>
                    <th scope="row">{label}</th>
                    <td>
                      <DateValue value={value} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
        <p>
          In a sentence: the books are closed through <DateValue value="2026-02-28" />, and the
          statement ends <DateValue value="2026-03-31" />.
        </p>
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXLanguage/DateValue",
  component: Specimen,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Specimen>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A date as a person writes it, "Mar 20, 2026". The stored form, "2026-03-20", is in the tooltip. */
export const Default: Story = { args: {} };
/** In a narrow column a date never wraps inside itself: "Mar 20," is never left apart from "2026". */
export const Narrow: Story = { args: { narrow: true } };
/** Digits keep their order inside right-to-left text. */
export const RightToLeft: Story = { args: { dir: "rtl" } };

const instants = [
  ["An instant at noon", "2026-03-20T12:00:00.000Z"],
  ["Half past nine at night in Denver, past midnight in UTC", "2026-10-05T03:30:00Z"],
  ["Just after midnight", "2026-03-20T00:05:00Z"],
] as const;

function Instants() {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": "40rem" }}>
        <table class="rt-table">
          <caption>Instants on the viewer's own clock</caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Time</th>
              <th scope="col">Day only</th>
            </tr>
          </thead>
          <tbody>
            <For each={instants}>
              {([label, value]) => (
                <tr>
                  <th scope="row">{label}</th>
                  <td>
                    <DateValue value={value} />
                  </td>
                  <td>
                    <DateValue value={value} dateOnly />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </UiProvider>
  );
}

/** An instant is shown on the clock of whoever looks, with the exact moment in the tooltip. */
export const Instant: StoryObj = { render: () => <Instants /> };

function NotADate() {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": "28rem" }}>
        <p>
          Nothing yet: <DateValue value="—" />. Half typed: <DateValue value="2026-3-2" />. Already
          written for a person: <DateValue value="Mar 20, 2026" />.
        </p>
      </div>
    </UiProvider>
  );
}

/** What is not a date is shown as it came, and is not marked up as one. */
export const NotADateAtAll: StoryObj = { render: () => <NotADate /> };

function Choose() {
  const [format, setFormat] = createSignal(dateFormat());
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": "40rem" }}>
        <p>
          Date format, as the Business setting chooses it:{" "}
          <For each={DATE_FORMATS}>
            {(choice) => (
              <>
                <Button
                  label={formatDate("2026-03-20", { format: choice })}
                  variant={format() === choice ? "primary" : "secondary"}
                  aria-pressed={format() === choice}
                  data-format={choice}
                  onClick={() => {
                    setDateFormat(choice);
                    setFormat(choice);
                  }}
                />{" "}
              </>
            )}
          </For>
        </p>
        <p>
          The books are closed through <DateValue value="2026-02-28" />. The last entry was made{" "}
          <DateValue value="2026-03-20T12:00:00Z" />.
        </p>
      </div>
    </UiProvider>
  );
}

/** One call, `setDateFormat`, changes every date on the page, and an example of each choice is written
 * by the same function from a fixed date. The tooltip stays ISO whichever is chosen. */
export const ChosenFormat: StoryObj = { render: () => <Choose /> };

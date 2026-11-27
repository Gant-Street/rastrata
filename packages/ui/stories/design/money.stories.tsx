import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  formatAge,
  formatBytes,
  formatCount,
  formatDate,
  formatDuration,
  formatInstant,
  formatMonth,
  Money,
  UiProvider,
} from "../../src";

const amounts = [
  ["Opening balance", "12000.00"],
  ["Client payment", "3200.00"],
  ["Rent", "-850.00"],
  ["Refund of a deposit", "-0.01"],
  ["Nothing yet", "0.00"],
  ["Sixteen digits", "1234567890123456.78"],
  ["Closing balance", "36314.18"],
] as const;

function Specimen(props: { locale?: string; dir?: "ltr" | "rtl" }) {
  return (
    <UiProvider locale={props.locale ?? "en-US"}>
      <div class="rt-theme" dir={props.dir} style={{ "max-width": "34rem" }}>
        <div class="rt-table-scroll">
          <table class="rt-table">
            <caption>September</caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col" class="rt-number">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={amounts}>
                {([label, value]) => (
                  <tr>
                    <th scope="row">{label}</th>
                    <td class="rt-number">
                      <Money value={value} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <p>
          Text that is not an amount is shown as it came: <Money value="—" />,{" "}
          <Money value="12.3" />.
        </p>
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/Design/Money",
  component: Specimen,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Specimen>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Grouped digits, two decimals, a real minus sign, tabular figures that line up on the right. */
export const Column: Story = { args: {} };
/** The same figures in the German locale: the separators follow the locale; the minus stays a minus. */
export const German: Story = { args: { locale: "de-DE" } };
/** Digits keep their order inside right-to-left text. */
export const RightToLeft: Story = { args: { locale: "ar", dir: "rtl" } };

function Dates() {
  const now = new Date("2026-10-04T15:00:00Z");
  const rows: [string, string][] = [
    ["A date", formatDate("2026-10-04")],
    ["An instant", formatInstant("2026-10-04T13:01:00Z")],
    ["How long ago", formatAge("2026-10-04T12:00:00Z", now)],
    ["A whole month", formatMonth("2026-09")],
    ["A count", formatCount(12345)],
    ["A file size", formatBytes(14540)],
    ["How long it took", formatDuration(125000)],
  ];
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": "28rem" }}>
        <table class="rt-table">
          <caption>One format for everything else</caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Shown as</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows}>
              {([what, shown]) => (
                <tr>
                  <th scope="row">{what}</th>
                  <td>{shown}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </UiProvider>
  );
}

/** A date is written for a person ("Oct 4, 2026"); an instant is on the viewer's own clock; a month on its own is a name. */
export const DatesAndCounts: StoryObj = { render: () => <Dates /> };

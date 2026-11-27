import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ComboField } from "../../src";
import { darkUnlessAsked, Frame } from "./frame";

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

function Demo(props: { value?: string; error?: string; disabled?: boolean }) {
  const [value, setValue] = createSignal(props.value ?? "");
  return (
    <Frame label="A box to type in, with the usual answers listed under it." width="28rem">
      <div class="rt-stack" style={{ gap: "1rem" }}>
        <ComboField
          label="Time zone"
          hint="Decides which day a payout was made and sent, for example America/Denver."
          showLabel="List of zones"
          items={ZONES}
          value={value()}
          onChange={setValue}
          error={props.error}
          disabled={props.disabled}
        />
        <output class="rt-hint" aria-label="Value">
          {value() === "" ? "Nothing typed." : `The box holds ${value()}.`}
        </output>
      </div>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXKit/ComboField",
  component: Demo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One of the usual answers is in the box. */
export const Default: Story = { args: { value: "America/Denver" } };

export const Empty: Story = {};

/** An answer the list does not hold is still an answer; the screen says when it cannot use it. */
export const WithError: Story = {
  args: { value: "Mars/Olympus", error: "Enter a time zone such as America/Denver." },
};

export const Disabled: Story = { args: { value: "America/Denver", disabled: true } };

export const Dark: Story = {
  args: { value: "America/Denver" },
  decorators: [darkUnlessAsked],
};

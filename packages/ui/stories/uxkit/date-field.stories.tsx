import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, DateField, SelectField, TextField } from "../../src";
import { darkUnlessAsked, Frame } from "./frame";

function Demo(props: {
  value?: string;
  min?: string;
  max?: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  form?: boolean;
}) {
  const [value, setValue] = createSignal(props.value ?? "");
  const [saved, setSaved] = createSignal<string | null>(null);
  return (
    <Frame label="A date: typed, or picked from the calendar." width="28rem">
      <form
        class="rt-stack"
        style={{ gap: "1rem" }}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(value());
        }}
      >
        <DateField
          label="Date"
          value={value()}
          onChange={setValue}
          min={props.min}
          max={props.max}
          error={props.error}
          hint={props.hint}
          disabled={props.disabled}
        />
        {props.form ? (
          <>
            <TextField label="Description" value="Team lunch" />
            <TextField label="Amount" value="64.20" inputmode="decimal" />
            <SelectField
              label="Repeats"
              defaultValue="never"
              items={[
                { value: "never", label: "Never" },
                { value: "monthly", label: "Every month" },
              ]}
            />
            <div>
              <Button type="submit" label="Save" />
            </div>
            <output class="rt-hint" aria-label="Saved">
              {saved() === null ? "Not saved." : `Saved with ${saved() || "no date"}.`}
            </output>
          </>
        ) : null}
        <output class="rt-hint" aria-label="Value">
          {value() === "" ? "No date." : `Stored as ${value()}.`}
        </output>
      </form>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXKit/DateField",
  component: Demo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A date that is set: the box shows it the way every screen writes a date. */
export const Default: Story = { args: { value: "2026-10-04" } };

/** Nothing chosen yet: an empty box; the calendar opens on this month. */
export const Empty: Story = {};

/** Beside the other fields of a form, it is one of them: the same box, the same height. */
export const InAForm: Story = { args: { value: "2026-10-04", form: true } };

/** The days a book's calendar does not cover cannot be picked. */
export const Bounded: Story = {
  args: { value: "2026-10-04", min: "2026-10-01", max: "2026-10-20" },
};

/** What is wrong is said under the box, as for any field. */
export const WithError: Story = {
  args: { value: "2025-12-31", error: "This date is before the books start, Jan 1, 2026." },
};

export const Disabled: Story = { args: { value: "2026-10-04", disabled: true } };

export const Dark: Story = {
  args: { value: "2026-10-04", form: true },
  decorators: [darkUnlessAsked],
};

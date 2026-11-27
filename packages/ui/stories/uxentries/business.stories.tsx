import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BusinessSettingsForm, type BusinessValues, formatDate, UiProvider } from "../../src";

/** What each choice of date format looks like, written by the formatter every screen uses. */
const examples = {
  medium: formatDate("2026-03-20", { format: "medium" }),
  numeric: formatDate("2026-03-20", { format: "numeric" }),
} as const;

const saved: BusinessValues = {
  name: "Willow Lane Studio",
  dateFormat: "medium",
  showAccountNumbers: false,
  acceptMode: "post",
};

/** The form as Settings shows it. Saving is the parent's: it sends only what changed and passes back what the
 * book now holds. */
function Harness(props: {
  saved?: BusinessValues;
  pending?: boolean;
  message?: string;
  error?: string;
  uncertain?: boolean;
  dir?: "rtl";
}) {
  const [now, setNow] = createSignal(props.saved ?? saved);
  const [message, setMessage] = createSignal(props.message);
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" dir={props.dir}>
        <BusinessSettingsForm
          saved={now()}
          pending={props.pending}
          message={message()}
          error={props.error}
          uncertain={props.uncertain}
          dateExamples={examples}
          onSave={(values) => {
            setNow(values);
            setMessage("Saved.");
          }}
        />
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXEntries/BusinessSettings",
  component: Harness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing to save until something changes: the button waits. */
export const Default: Story = { args: {} };

export const Saving: Story = { args: { pending: true } };

export const Saved: Story = { args: { message: "Saved." } };

export const Refused: Story = {
  args: { error: "A business name needs at least two characters. Nothing was changed." },
};

export const ReplyLost: Story = { args: { uncertain: true } };

export const AccountNumbersOnAndDraftsOn: Story = {
  args: {
    saved: { ...saved, showAccountNumbers: true, acceptMode: "draft", dateFormat: "numeric" },
  },
};

export const LongName: Story = {
  args: {
    saved: {
      ...saved,
      name: "Willow Lane Studio, a sole proprietorship doing business as Willow Lane Photography and Design",
    },
  },
};

export const RightToLeft: Story = { args: { dir: "rtl" } };

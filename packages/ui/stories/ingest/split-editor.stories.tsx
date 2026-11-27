import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SplitEditor, type SplitPart, UiProvider } from "../../src";
import { accounts } from "./fixtures";

function SplitHarness(props: { total: string; parts: SplitPart[] }) {
  const [parts, setParts] = createSignal<readonly SplitPart[]>(props.parts);
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-inbox-story" style={{ "max-width": "28rem" }}>
        <SplitEditor total={props.total} accounts={accounts} parts={parts()} onChange={setParts} />
      </div>
    </UiProvider>
  );
}

const splits = {
  title: "Lanes/Ingest/Split editor",
  component: SplitHarness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof SplitHarness>;
export default splits;
type SplitStory = StoryObj<typeof splits>;

const empty: SplitPart[] = [
  { accountId: "", amount: "" },
  { accountId: "", amount: "" },
];

/** Nothing assigned yet: the whole line is still to assign. */
export const Empty: SplitStory = { args: { total: "100.00", parts: empty } };

/** Add up exactly: 0.00 left, and the draft can be made. */
export const Balanced: SplitStory = {
  args: {
    total: "100.00",
    parts: [
      { accountId: "5400", amount: "60.01" },
      { accountId: "5100", amount: "39.99" },
    ],
  },
};

/** One cent short is said in words and in figures. */
export const OneCentShort: SplitStory = {
  args: {
    total: "100.00",
    parts: [
      { accountId: "5400", amount: "60.01" },
      { accountId: "5100", amount: "39.98" },
    ],
  },
};

export const OverAssigned: SplitStory = {
  args: {
    total: "100.00",
    parts: [
      { accountId: "5400", amount: "70.00" },
      { accountId: "5100", amount: "39.99" },
    ],
  },
};

/** A third decimal is refused, never rounded. */
export const TooManyDecimals: SplitStory = {
  args: {
    total: "100.00",
    parts: [
      { accountId: "5400", amount: "60.005" },
      { accountId: "5100", amount: "39.99" },
    ],
  },
};

export const ThreeParts: SplitStory = {
  args: {
    total: "1234567.89",
    parts: [
      { accountId: "5400", amount: "1000000.00" },
      { accountId: "5100", amount: "234567.00" },
      { accountId: "5300", amount: "0.89" },
    ],
  },
};

import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type StepItem, Steps } from "../../src";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/UXKit/Steps",
  component: Steps,
  args: {
    label: "Files from Xero",
    steps: [],
    open: null,
    onOpen: () => {},
    changeLabel: "Change",
    children: () => null,
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Steps>;
export default meta;
type Story = StoryObj<typeof meta>;

function Demo(props: { steps: readonly StepItem[]; open: string | null }) {
  const [open, setOpen] = createSignal<string | null>(props.open);
  return (
    <Frame label="A task done a step at a time.">
      <Steps
        label="Files from Xero"
        steps={props.steps}
        open={open()}
        onOpen={setOpen}
        changeLabel="Change"
      >
        {(id) => <p>What the step called “{id}” asks for.</p>}
      </Steps>
    </Frame>
  );
}

const titles = [
  ["chart", "Chart of accounts"],
  ["trialBalance", "Trial balance"],
  ["transactions", "Account transactions"],
  ["reconciled", "Where Xero was reconciled"],
] as const;

/** Nothing done yet: the first step is open and asks for one thing; the others are only named. */
export const Start: Story = {
  render: () => <Demo open="chart" steps={titles.map(([id, title]) => ({ id, title }))} />,
};

/** A finished step is one line that says what came of it, with Change; the next one is open. */
export const Next: Story = {
  render: () => (
    <Demo
      open="trialBalance"
      steps={titles.map(([id, title], index) =>
        index === 0 ? { id, title, done: true, said: "42 accounts, all matched" } : { id, title },
      )}
    />
  ),
};

/** Every step done, and none open. */
export const Done: Story = {
  render: () => (
    <Demo
      open={null}
      steps={titles.map(([id, title], index) => ({
        id,
        title,
        done: true,
        said: [
          "42 accounts, all matched",
          "Dec 31, 2025",
          "Jan 1 to Jan 31, 2026, 318 transactions",
          "3 accounts, through Jan 31, 2026",
        ][index],
      }))}
    />
  ),
};

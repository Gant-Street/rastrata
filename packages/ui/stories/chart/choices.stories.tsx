import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ChoiceCards, ChoiceCheck, StepIndicator } from "../../src";
import { addOns, templates } from "./fixtures";
import { Frame } from "./frame";

function Cards(props: {
  legend: string;
  help?: string;
  disabled?: boolean;
  error?: string;
  rtl?: boolean;
  choices: { value: string; title: string; description?: string }[];
}) {
  const [value, setValue] = createSignal(props.choices[0]?.value ?? "");
  return (
    <Frame locale={props.rtl ? "ar" : "en-US"}>
      <div style={{ "max-width": "46rem" }}>
        <ChoiceCards
          legend={props.legend}
          name="story"
          value={value()}
          choices={props.choices}
          onChange={setValue}
          disabled={props.disabled ?? false}
          {...(props.help ? { help: props.help } : {})}
          {...(props.error ? { error: props.error } : {})}
        />
      </div>
    </Frame>
  );
}

const meta = {
  title: "Lanes/Chart/Choice cards",
  component: Cards,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "One choice from a short list, each explained where it is made. Native radio buttons in a fieldset, so the arrow keys and grouping are the browser's. The checked choice has a heavier ring and a tint, never color alone.",
      },
    },
  },
} satisfies Meta<typeof Cards>;

export default meta;
type Story = StoryObj<typeof meta>;

const kinds = templates.map((item) => ({ value: item.id, title: item.name }));

export const TypeOfBusiness: Story = {
  args: {
    legend: "What kind of business is this?",
    help: "This chooses your starting chart of accounts.",
    choices: kinds,
  },
};

export const AccountingBasis: Story = {
  args: {
    legend: "How do you keep your books?",
    choices: [
      {
        value: "cash",
        title: "Cash",
        description: "Income counts when money arrives and expenses when money leaves.",
      },
      {
        value: "accrual",
        title: "Accrual",
        description:
          "Income counts when you earn it and expenses when you owe them. You record invoices and bills yourself, as journal entries.",
      },
    ],
  },
};

export const WithError: Story = {
  args: {
    legend: "What kind of business is this?",
    error: "Choose the type of business.",
    choices: kinds.slice(0, 2),
  },
};

export const Disabled: Story = {
  args: { legend: "How do you keep your books?", disabled: true, choices: kinds.slice(0, 2) },
};

export const LongContent: Story = {
  args: {
    legend:
      "A legend that is long enough to wrap onto a second line on a narrow screen without losing meaning",
    choices: [
      {
        value: "one",
        title:
          "A choice whose title is long enough that it has to wrap across two lines of the card",
        description:
          "An explanation that goes on for some time, to show how a long paragraph of guidance sits beside the radio button, wraps within a readable measure and never pushes the control out of its column. ".repeat(
            2,
          ),
      },
      { value: "two", title: "Short", description: "Short." },
    ],
  },
};

export const RightToLeft: Story = {
  args: { legend: "What kind of business is this?", rtl: true, choices: kinds.slice(0, 3) },
};

/** The checkbox form of the same card, for a single yes or no. */
export const AddOnCheck: StoryObj = {
  render: () => {
    const [on, setOn] = createSignal(false);
    return (
      <Frame>
        <div style={{ "max-width": "46rem" }}>
          <ChoiceCheck
            label="I take payments through Stripe"
            hint={addOns[0]?.description ?? ""}
            checked={on()}
            onChange={setOn}
          />
        </div>
      </Frame>
    );
  },
};

const steps = ["Your business", "Type of business", "Accounting method", "Review and create"];

/** Where a person is in the sequence: the current step is marked in text and for assistive technology. */
export const Steps: StoryObj = {
  render: () => (
    <Frame>
      <div class="rt-stack" style={{ "max-width": "52rem" }}>
        <StepIndicator steps={steps} current={0} label="Setup steps" doneLabel="done" />
        <StepIndicator steps={steps} current={2} label="Setup steps, step 3" doneLabel="done" />
        <StepIndicator steps={steps} current={3} label="Setup steps, last step" doneLabel="done" />
      </div>
    </Frame>
  ),
};

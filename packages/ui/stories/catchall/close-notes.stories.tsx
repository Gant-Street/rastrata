import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  CloseCard,
  type CloseLine,
  type CloseNote,
  closeWords,
  PageHeader,
  UiProvider,
} from "../../src";
import { holds, income, longText, notChecked } from "./fixtures";

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-acct-page" style={{ padding: "1.5rem", "max-width": "64rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

const LEFT: CloseLine[] = [
  {
    id: "reconcile-checking",
    text: "Business checking is not reconciled through Mar 31, 2026.",
    action: {
      label: "Reconcile",
      name: "Reconcile Business checking",
      href: "/reconcile?account=checking",
    },
  },
];

function Page(props: { notes: CloseNote[]; left?: CloseLine[] }) {
  return (
    <Frame>
      <PageHeader title={closeWords.title} />
      <CloseCard
        label="March 2026"
        state="ready"
        left={props.left ?? []}
        notes={props.notes}
        onClose={() => {}}
        onRetry={() => {}}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Catchall/Notes on a month",
  component: Page,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "What Close the books says about a month besides what stands in its way: money collecting in the account the book keeps for what fits nowhere else, with how much, from how many transactions and which payees took the most, and a link to those transactions. A note never keeps a month from closing. An account that could not be checked says so; it is never left out as if it passed.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ready to close, and a note about Other expenses. The month still closes. */
export const MoneyCollecting: Story = { args: { notes: [holds] } };

export const ExpenseAndIncome: Story = { args: { notes: [holds, income] } };

/** The account's figures could not be read: the note says so, and what that means. */
export const CouldNotBeChecked: Story = { args: { notes: [notChecked] } };

/** A note beside things that are left: those still decide whether the month closes. */
export const BesideSteps: Story = { args: { notes: [holds], left: LEFT } };

/** An account name and a payee that go on and on, bank text aimed at a reader, and large figures. */
export const LongText: Story = { args: { notes: [longText] } };

export const NoNotes: Story = { args: { notes: [] } };

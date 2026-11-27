import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { NeedsYou, type NeedRowView, UiProvider } from "../../src";
import { rows } from "./fixtures";

function Frame(props: { children: JSX.Element; width?: string | undefined }) {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": props.width ?? "40rem", padding: "1rem" }}>
        <div class="rt-today">{props.children}</div>
      </div>
    </UiProvider>
  );
}

function Needs(props: {
  rows: readonly NeedRowView[];
  total?: number;
  hidden?: number;
  state?: "loading" | "ready";
  unread?: string | null;
  isNew?: boolean;
  width?: string;
}) {
  return (
    <Frame width={props.width}>
      <NeedsYou
        rows={props.rows}
        total={props.total ?? props.rows.length}
        hidden={props.hidden ?? 0}
        state={props.state ?? "ready"}
        unread={props.unread ?? null}
        isNew={props.isNew ?? false}
        onRetry={() => undefined}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXHome/Needs you",
  component: Needs,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    docs: {
      description: {
        component:
          "What a person has to do: at most five rows, each one sentence and one verb. What stands in the way of closing the month comes first, then what is wrong, then what is coming due. The first row is the next step, and its verb is the page's one main button; the others are links. Orange is a person who must decide; a red triangle is something that failed.",
      },
    },
  },
} satisfies Meta<typeof Needs>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The working day: transactions to review, the month to close, and a backup. */
export const ThreeThings: Story = { args: { rows: [rows.review, rows.close, rows.backup] } };

/** Five rows is the most, and the heading counts them. */
export const FiveThings: Story = {
  args: { rows: [rows.review, rows.close, rows.stripe, rows.bankfeed, rows.backup] },
};

/** More need a person than fit: the rest are counted and said, so nothing is hidden silently. */
export const MoreThanFit: Story = {
  args: {
    rows: [rows.review, rows.close, rows.stripe, rows.bankfeed, rows.backup],
    total: 7,
    hidden: 2,
  },
};

/** A failure leads what is coming due, and its marker is a triangle so it reads without colour. */
export const AProblem: Story = { args: { rows: [rows.stripe, rows.calendar, rows.tokens] } };

/** Every check was read and none found anything. */
export const NothingNeedsYou: Story = { args: { rows: [] } };

/** A new book has nothing to check, and is not a list of warnings. */
export const NewBook: Story = { args: { rows: [], isNew: true } };

/** While the facts are read the section says it is checking, and holds still. */
export const Checking: Story = { args: { rows: [], state: "loading" } };

/** A check that could not be read says so, and the rest are still shown: never "all clear". */
export const SomethingCouldNotBeChecked: Story = {
  args: {
    rows: [rows.review],
    unread: "Backups and Stripe could not be checked.",
  },
};

/** Every check failed: only the sentence and the way to try again. */
export const NothingCouldBeChecked: Story = {
  args: { rows: [], unread: "What needs you could not be checked." },
};

/** A long sentence wraps beside its verb on a narrow row, and the verb stays on one line. */
export const LongSentenceAtPhoneWidth: Story = {
  args: {
    rows: [
      {
        id: "close",
        tone: "attention",
        text: "12 things stand in the way of closing the fiscal quarter that ended on the last day of September 2026.",
        verb: "See what's left",
        href: "#close",
      },
      rows.backup,
    ],
    width: "22rem",
  },
};

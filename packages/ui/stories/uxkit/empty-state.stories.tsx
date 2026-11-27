import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, EmptyState, Notice, TextField } from "../../src";
import { Frame, darkUnlessAsked } from "./frame";

const meta = {
  title: "Lanes/UXKit/EmptyState",
  component: EmptyState,
  // Every story renders its own page; these are the props the component needs to be typed without them.
  args: { children: "Nothing here yet." },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One sentence and one action. It says what is true ("Nothing imported yet") and what to do about it;
 * it never claims a success that has not happened ("Caught up"). */
export const Default: Story = {
  render: () => (
    <Frame label="For review, on a new book.">
      <EmptyState title="Nothing imported yet" action={<Button label="Import a statement" />}>
        Import a statement and the transactions in it will wait here for you to review.
      </EmptyState>
    </Frame>
  ),
};

/** The sentence alone, where there is nothing to offer: a list that is empty for a reason no click fixes. */
export const SentenceOnly: Story = {
  render: () => (
    <Frame label="Reconcile, with no bank or card accounts.">
      <EmptyState>No accounts to reconcile yet.</EmptyState>
    </Frame>
  ),
};

/** Two actions, only where the plan says so: a new book's For review offers both ways in. */
export const TwoActions: Story = {
  render: () => (
    <Frame>
      <EmptyState
        title="Nothing here yet"
        action={
          <>
            <Button label="Import a statement" />
            <Button label="Connect a bank" variant="secondary" />
          </>
        }
      >
        Import a statement or connect a bank to bring transactions in.
      </EmptyState>
    </Frame>
  ),
};

/** A list that is still being read is not empty. It says it is reading; only a list that was read and
 * had nothing in it says "empty". */
export const Loading: Story = {
  render: () => (
    <Frame label="While reading: a status line, not an empty state.">
      <p class="rt-hint" role="status" style={{ padding: "2rem 0" }}>
        Reading your transactions…
      </p>
    </Frame>
  ),
};

/** A read that failed is a problem with a way to try again. It is not empty either. */
export const ErrorState: Story = {
  render: () => (
    <Frame label="A failed read: a problem with Try again, not an empty state.">
      <Notice tone="problem" title="Your transactions could not be read" role="alert">
        Nothing was changed.
        <div style={{ "margin-top": "0.5rem" }}>
          <Button label="Try again" variant="secondary" size="sm" />
        </div>
      </Notice>
    </Frame>
  ),
};

/** Long words and a narrow column wrap; the action stays under the sentence. */
export const LongContent: Story = {
  render: () => (
    <Frame width="20rem">
      <EmptyState
        title="No transactions match 'Pneumonoultramicroscopicsilicovolcanoconiosis Consulting Services Incorporated'"
        action={<Button label="Clear the search and the filters" variant="secondary" />}
      >
        Try a shorter search, or another account, or a wider range of dates; transactions that were
        reviewed or excluded are in their own tabs.
      </EmptyState>
    </Frame>
  ),
};

function Filtered() {
  const [query, setQuery] = createSignal("");
  const rows = ["COWORKING MONTHLY", "LINEAR ORBIT", "NOTION LABS", "STRIPE TRANSFER ST-7E69"];
  const shown = () => rows.filter((row) => row.toLowerCase().includes(query().toLowerCase()));
  return (
    <>
      <TextField
        label="Search transactions"
        hint="Try a name that is not there."
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      {shown().length > 0 ? (
        <ul style={{ padding: "1rem 0 1rem 1.25rem", margin: 0 }}>
          {shown().map((row) => (
            <li>{row}</li>
          ))}
        </ul>
      ) : (
        <EmptyState
          live
          title="No transactions match"
          action={
            <Button label="Clear the search" variant="secondary" onClick={() => setQuery("")} />
          }
        >
          Nothing here matches "{query()}".
        </EmptyState>
      )}
    </>
  );
}

/** Where the empty state replaces rows that were there a moment ago, `live` makes a screen reader say so. */
export const FilterFoundNothing: Story = {
  render: () => (
    <Frame>
      <Filtered />
    </Frame>
  ),
};

/** The dark theme. */
export const Dark: Story = {
  render: () => (
    <Frame>
      <EmptyState title="Nothing imported yet" action={<Button label="Import a statement" />}>
        Import a statement and the transactions in it will wait here for you to review.
      </EmptyState>
    </Frame>
  ),
  decorators: [darkUnlessAsked],
};

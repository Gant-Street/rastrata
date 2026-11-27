import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CashFlowView } from "../../src";
import { cashFlow, hrefs } from "./fixtures";
import { Frame } from "./frame";

function Flow(props: {
  compare?: boolean;
  untagged?: boolean;
  unavailable?: boolean;
  noTagScreen?: boolean;
}) {
  return (
    <Frame>
      <CashFlowView
        data={cashFlow({
          compare: props.compare ?? false,
          untagged: props.untagged ?? false,
          unavailable: props.unavailable ?? false,
        })}
        hrefs={props.noTagScreen ? { account: hrefs.account } : hrefs}
        bookName="Harbor Studio"
      />
    </Frame>
  );
}

export default {
  title: "Lanes/Reports/Cash flow",
  component: Flow,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Flow>;

type Story = StoryObj<typeof Flow>;

/** Net income, adjusted by each balance-sheet account's change, tied exactly to the cash accounts. */
export const Default: Story = { render: () => <Flow /> };

export const WithComparison: Story = { render: () => <Flow compare /> };

/** An account with activity and no tag is shown under Not classified, flagged, with a link to tag it:
 * the statement never guesses where it belongs. */
export const AccountNeedsATag: Story = { render: () => <Flow untagged /> };

/** With no account tagged cash there is nothing to tie to, so nothing is shown and the page says why. */
export const Unavailable: Story = { render: () => <Flow unavailable /> };

/** The same, in an application that has no screen to tag accounts: the reason stands alone. */
export const UnavailableWithoutATagScreen: Story = {
  render: () => <Flow unavailable noTagScreen />,
};
